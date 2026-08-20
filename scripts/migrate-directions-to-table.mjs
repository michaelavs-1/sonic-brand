#!/usr/bin/env node
/**
 * One-shot migration: extract unique musical directions from historical
 * business_playlists.expansion blobs and INSERT them as first-class rows
 * in the business_directions table, then back-fill business_playlists.
 * direction_id so every playlist row points at its source direction.
 *
 * Reads:  business_playlists rows (WHERE direction_id IS NULL AND expansion IS NOT NULL).
 * Writes: business_directions (INSERT-only, dedup within a business by
 *         title + normalized-sorted genres) and business_playlists.direction_id.
 *
 * Idempotent per business — re-running the script won't create duplicate
 * directions (dedup checks existing business_directions rows first) or
 * re-tag already-tagged playlists (filter on `direction_id IS NULL`).
 *
 * Historical rows' track_ids column stays NULL. There's no reliable source
 * to reconstruct which tracks were in which specific playlist from
 * v6_daily_track_history (direction_key + timestamps can't uniquely
 * attribute a track to a single playlist row when multiple daily builds
 * for the same direction happened in the same window). Forward-only —
 * new playlist writes carry track_ids; historical composition is a gap.
 *
 * Prereq: run v5/precompute/migrations/2026-08-20-business-directions.sql
 * first — otherwise business_directions and business_playlists.direction_id
 * don't exist and the script errors out.
 *
 * DEFAULT IS DRY-RUN. Pass --confirm to actually write.
 *
 * Usage (PowerShell, from repo root):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *   node scripts/migrate-directions-to-table.mjs              # dry-run
 *   node scripts/migrate-directions-to-table.mjs --confirm    # real
 *   node scripts/migrate-directions-to-table.mjs --biz=UUID --confirm  # single biz
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args      = process.argv.slice(2);
const CONFIRM   = args.includes('--confirm');
const ONLY_BIZ  = (args.find((a) => a.startsWith('--biz=')) || '').slice('--biz='.length) || null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (source them from .env.local).');
  process.exit(1);
}

const adminHeaders = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// ---------- PostgREST helpers ----------

async function pgrGet(table, filters, { select = '*', order = null, limit = null } = {}) {
  const parts = [`select=${encodeURIComponent(select)}`];
  for (const [k, v] of Object.entries(filters)) parts.push(`${k}=${v}`);
  if (order) parts.push(`order=${encodeURIComponent(order)}`);
  if (limit != null) parts.push(`limit=${limit}`);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${parts.join('&')}`, { headers: adminHeaders });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`GET ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function pgrPost(table, rows, { returnRows = false, onConflict = null, ignoreDuplicates = false } = {}) {
  const body = Array.isArray(rows) ? rows : [rows];
  if (!body.length) return [];
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (onConflict) url += `?on_conflict=${encodeURIComponent(onConflict)}`;
  const preferParts = [];
  if (ignoreDuplicates) preferParts.push('resolution=ignore-duplicates');
  preferParts.push(returnRows ? 'return=representation' : 'return=minimal');
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...adminHeaders, Prefer: preferParts.join(',') },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`POST ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
  return returnRows ? r.json() : null;
}

async function pgrPatch(table, filters, body) {
  const qs = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join('&');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: { ...adminHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`PATCH ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
}

// ---------- fingerprint (must match signup.js + _daily-builder.js) ----------

function directionFingerprint(d) {
  if (!d) return '';
  const genres = Array.isArray(d.genres) && d.genres.length
    ? d.genres
    : [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])].filter(Boolean);
  const gk = genres.map((g) => String(g).toLowerCase()).sort().join('|');
  return (d.title_en || '').toLowerCase() + '|' + gk;
}

// ---------- main ----------

console.log(`Mode: ${CONFIRM ? 'CONFIRM (writes)' : 'DRY-RUN (no writes)'}${ONLY_BIZ ? `  biz=${ONLY_BIZ}` : ''}`);
console.log('---');

// Fetch every un-tagged playlist row that has expansion metadata to mine.
// Event playlists (event_id NOT NULL) may not have expansion — those get
// filtered out client-side; we just leave their direction_id as NULL
// (events aren't directions).
const bizFilter = ONLY_BIZ ? { business_id: `eq.${ONLY_BIZ}` } : {};
let untagged = [];
try {
  untagged = await pgrGet('business_playlists',
    { direction_id: 'is.null', ...bizFilter },
    { select: 'spotify_id,business_id,event_id,expansion,created_at', order: 'created_at.desc', limit: 5000 });
} catch (e) {
  console.error('failed to fetch untagged playlists:', e.message);
  process.exit(1);
}
console.log(`fetched ${untagged.length} un-tagged playlist rows`);

// Group by business.
const byBiz = new Map();
for (const p of untagged) {
  if (!p.business_id) continue;
  if (!byBiz.has(p.business_id)) byBiz.set(p.business_id, []);
  byBiz.get(p.business_id).push(p);
}
console.log(`spread across ${byBiz.size} businesses`);
console.log('---');

let ok = 0, failed = 0;
for (const [bizId, rows] of byBiz.entries()) {
  try {
    // 1) Existing directions for this business (dedup pool + fingerprint map).
    //    Only the fields fingerprinting needs — business_directions doesn't
    //    have anchor_genre / secondary_genres columns (it's the new-shape
    //    flat genres list only), so directionFingerprint handles them via
    //    the genres branch of its ternary.
    const existing = await pgrGet('business_directions',
      { business_id: `eq.${bizId}` }, { select: 'id,title_en,genres' });
    const idByFp = {};
    for (const d of (existing || [])) {
      idByFp[directionFingerprint(d)] = d.id;
    }

    // 2) Extract unique directions from this business's playlist rows that
    //    aren't already in business_directions.
    const newRows = [];
    const seenNewFps = new Set();
    for (const p of rows) {
      const d = p?.expansion?.direction;
      if (!d) continue;
      const fp = directionFingerprint(d);
      if (!fp || idByFp[fp] || seenNewFps.has(fp)) continue;
      const genres = Array.isArray(d.genres) && d.genres.length
        ? d.genres
        : [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])].filter(Boolean);
      if (!genres.length || !d.bpm_range) continue; // skip broken rows
      seenNewFps.add(fp);
      newRows.push({
        business_id:       bizId,
        rank:              Number.isFinite(d.rank) ? d.rank : null,
        title_en:          d.title_en || null,
        description_he:    d.description_he || null,
        genres,
        bpm_range:         d.bpm_range,
        popularity_window: Array.isArray(p.expansion?.popularityWindow) ? p.expansion.popularityWindow : null,
        active:            true,
      });
    }

    // 3) Insert the new directions; capture returned ids to extend the map.
    if (newRows.length && CONFIRM) {
      const inserted = await pgrPost('business_directions', newRows, { returnRows: true });
      const fps = newRows.map((r) => {
        // fingerprint using the same shape we submitted
        return directionFingerprint({ title_en: r.title_en, genres: r.genres });
      });
      (inserted || []).forEach((row, i) => {
        if (row?.id && fps[i]) idByFp[fps[i]] = row.id;
      });
    } else if (newRows.length) {
      // Dry-run — pretend the inserts happened so the tagging step's map is
      // complete for logging purposes. Use placeholder ids that make it
      // obvious this was a dry-run (no PATCH will actually run).
      newRows.forEach((r, i) => {
        const fp = directionFingerprint({ title_en: r.title_en, genres: r.genres });
        if (fp) idByFp[fp] = `<dry-run:${i}>`;
      });
    }

    // 4) For each playlist row, look up direction_id by fingerprint and PATCH.
    let tagged = 0, unmapped = 0;
    for (const p of rows) {
      const d = p?.expansion?.direction;
      if (!d) { unmapped += 1; continue; }
      const fp = directionFingerprint(d);
      const dirId = idByFp[fp];
      if (!dirId) { unmapped += 1; continue; }
      if (CONFIRM) {
        try {
          await pgrPatch('business_playlists',
            { spotify_id: `eq.${p.spotify_id}` }, { direction_id: dirId });
        } catch (e) {
          console.warn(`  patch failed for ${p.spotify_id}: ${e.message}`);
          unmapped += 1;
          continue;
        }
      }
      tagged += 1;
    }

    console.log(`ok  biz=${bizId.slice(0, 8)}  existing_directions=${Object.keys(idByFp).length - newRows.length}  new_directions=${newRows.length}  playlists_tagged=${tagged}${unmapped ? '  unmapped=' + unmapped : ''}`);
    ok += 1;
  } catch (e) {
    console.error(`FAIL biz=${bizId.slice(0, 8)}: ${e.message}`);
    failed += 1;
  }
}

console.log('---');
console.log(`done: businesses_ok=${ok} businesses_failed=${failed}`);
if (!CONFIRM) console.log('This was a DRY-RUN. Nothing was written. Re-run with --confirm.');
