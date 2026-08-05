#!/usr/bin/env node
/**
 * One-shot migration: copy per-business data out of auth.users.
 * raw_user_meta_data.sonic.b[bizId] into dedicated Postgres tables, then
 * compact the user's metadata so the JWT stays small.
 *
 * Reads:  every user via /auth/v1/admin/users (paginated).
 * Writes: business_playlists, business_events, business_hours,
 *         business_place, businesses.onboarding_expanded, then
 *         PUT /auth/v1/admin/users/{id} with the compacted metadata.
 *
 * Idempotent — safe to re-run. Playlists insert with ON CONFLICT DO
 * NOTHING (via Prefer: resolution=ignore-duplicates), hours+place upsert
 * on business_id PK. Events insert always (no natural conflict target) —
 * re-running WILL create duplicate events, so run this exactly once per
 * account UNLESS you're OK with duplicates.
 *
 * Prereq: run v5/precompute/migrations/2026-08-05-per-business-tables.sql
 * first — otherwise the target tables don't exist.
 *
 * DEFAULT IS DRY-RUN. Prints what it would touch and stops. Pass --confirm
 * to actually run.
 *
 * Usage (PowerShell, from repo root):
 *   # 1. Load env vars from .env.local
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
 *       Set-Item "env:$($matches[1])" $matches[2]
 *     }
 *   }
 *
 *   # 2. Dry-run — logs per-user summary of what would move
 *   node scripts/migrate-user-metadata-to-tables.mjs
 *
 *   # 3. Real run
 *   node scripts/migrate-user-metadata-to-tables.mjs --confirm
 *
 * Flags:
 *   --confirm    Actually write. Default is dry-run.
 *   --user=UUID  Restrict to a single user id (for testing on one account
 *                first before running against everyone).
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args      = process.argv.slice(2);
const CONFIRM   = args.includes('--confirm');
const ONLY_USER = (args.find((a) => a.startsWith('--user=')) || '').slice('--user='.length) || null;

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

async function pgrPost(table, rows, { onConflict = null, ignoreDuplicates = false } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (onConflict) url += `?on_conflict=${encodeURIComponent(onConflict)}`;
  const prefer = [
    ignoreDuplicates ? 'resolution=ignore-duplicates'
                     : (onConflict ? 'resolution=merge-duplicates' : ''),
    'return=minimal',
  ].filter(Boolean).join(',');
  const r = await fetch(url, {
    method:  'POST',
    headers: { ...adminHeaders, Prefer: prefer },
    body:    JSON.stringify(rows),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`POST ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
}

async function pgrPatch(table, filters, body) {
  const qs = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join('&');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method:  'PATCH',
    headers: { ...adminHeaders, Prefer: 'return=minimal' },
    body:    JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`PATCH ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
}

async function pgrSelect(table, filters, { select = '*' } = {}) {
  const parts = [`select=${encodeURIComponent(select)}`];
  for (const [k, v] of Object.entries(filters)) parts.push(`${k}=${v}`);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${parts.join('&')}`, {
    headers: adminHeaders,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`SELECT ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// ---------- Auth admin helpers ----------

async function fetchUsersPage(page, perPage = 200) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
    headers: adminHeaders,
  });
  if (!r.ok) throw new Error(`admin/users page ${page} → ${r.status}`);
  const j = await r.json();
  return j?.users || [];
}

async function writeUserMetadata(userId, sonic) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method:  'PUT',
    headers: adminHeaders,
    body:    JSON.stringify({ user_metadata: { sonic } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`user_metadata write for ${userId} → ${r.status}: ${t.slice(0, 150)}`);
  }
}

// ---------- ledger expiries (for playlists that never carried expiresAt) ----------

async function fetchLedgerExpiries(spotifyIds) {
  if (!spotifyIds.length) return {};
  const list = spotifyIds.map(encodeURIComponent).join(',');
  const rows = await pgrSelect('created_playlists', { spotify_id: `in.(${list})` }, {
    select: 'spotify_id,expires_at',
  });
  return Object.fromEntries((rows || []).map((r) => [r.spotify_id, r.expires_at]));
}

// ---------- row builders (camelCase user_metadata → snake_case table row) ----------

function playlistEntryToRow(p, businessId, fallbackExpiryIso, ledgerExpiries) {
  const spotifyId = p?.id;
  if (!spotifyId) return null;
  const expiresIso = ledgerExpiries[spotifyId]
    || (Number.isFinite(p.expiresAt) ? new Date(p.expiresAt).toISOString() : fallbackExpiryIso);
  const createdIso = p.createdAt ? `${p.createdAt}T00:00:00Z` : new Date().toISOString();
  const expandedIso = Number.isFinite(p.expandedAt) ? new Date(p.expandedAt).toISOString() : null;
  return {
    spotify_id:  spotifyId,
    business_id: businessId,
    url:         p.url || '',
    label:       p.label || null,
    ico:         p.ico   || '🎵',
    track_count: Number.isFinite(p.trackCount) ? p.trackCount : null,
    genres:      Array.isArray(p.genres) ? p.genres : null,
    bpm_range:   p.bpmRange || null,
    expansion:   p.expansion || null,
    event_id:    p.eventId || null,
    expanded_at: expandedIso,
    expires_at:  expiresIso,
    created_at:  createdIso,
  };
}

function eventEntryToRow(e, businessId) {
  if (!e || typeof e !== 'object') return null;
  return {
    // Preserve the client-generated uuid so any playlist.eventId back-refs
    // (in the same b[bizId].playlists we're about to migrate) still resolve.
    id:          e.id || undefined,
    business_id: businessId,
    name:        e.name || null,
    description: e.description || null,
  };
}

// ---------- per-user migration ----------

async function migrateUser(u) {
  const sonic = u?.user_metadata?.sonic;
  const bMap  = sonic?.b;
  if (!sonic || !bMap || typeof bMap !== 'object' || !Object.keys(bMap).length) {
    return { userId: u.id, email: u.email, skipped: 'no-b-map' };
  }

  const summary = { userId: u.id, email: u.email, biz: [] };
  const fallbackExpiryIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  for (const [businessId, bRow] of Object.entries(bMap)) {
    if (!bRow || typeof bRow !== 'object') continue;
    const bizSummary = {
      businessId,
      playlists: 0,
      events:    0,
      hoursSet:  false,
      placeSet:  false,
      onboardingExpanded: !!bRow.onboardingExpanded,
    };

    // 1) business_playlists — ON CONFLICT (spotify_id) DO NOTHING.
    const inPlaylists = Array.isArray(bRow.playlists) ? bRow.playlists : [];
    if (inPlaylists.length) {
      const spotifyIds = inPlaylists.map((p) => p?.id).filter(Boolean);
      const ledgerExpiries = spotifyIds.length ? await fetchLedgerExpiries(spotifyIds) : {};
      const rows = inPlaylists
        .map((p) => playlistEntryToRow(p, businessId, fallbackExpiryIso, ledgerExpiries))
        .filter(Boolean);
      if (rows.length) {
        if (CONFIRM) {
          await pgrPost('business_playlists', rows, {
            onConflict: 'spotify_id', ignoreDuplicates: true,
          });
        }
        bizSummary.playlists = rows.length;
      }
    }

    // 2) business_events — plain INSERT preserving UUIDs. Re-running would
    //    duplicate; the script is designed for a single confirmed run.
    const inEvents = Array.isArray(bRow.events) ? bRow.events : [];
    if (inEvents.length) {
      const rows = inEvents.map((e) => eventEntryToRow(e, businessId)).filter(Boolean);
      if (rows.length) {
        if (CONFIRM) await pgrPost('business_events', rows);
        bizSummary.events = rows.length;
      }
    }

    // 3) business_hours — UPSERT on business_id.
    if (bRow.hours && typeof bRow.hours === 'object') {
      const row = {
        business_id:     businessId,
        hours:           bRow.hours,
        longest_minutes: Number.isFinite(bRow.longestMinutes) ? bRow.longestMinutes : null,
        updated_at:      new Date().toISOString(),
      };
      if (CONFIRM) await pgrPost('business_hours', [row], { onConflict: 'business_id' });
      bizSummary.hoursSet = true;
    }

    // 4) business_place — UPSERT on business_id.
    if (bRow.place && typeof bRow.place === 'object') {
      const p = bRow.place;
      const row = {
        business_id:       businessId,
        place_id:          p.place_id      || null,
        name:              p.name          || null,
        address:           p.address       || null,
        primary_type:      p.primary_type  || null,
        types:             Array.isArray(p.types) ? p.types : null,
        editorial_summary: p.editorial_summary || null,
        price_level:       p.price_level   || null,
        website_uri:       p.website_uri   || null,
        vibe:              p.vibe          || null,
        updated_at:        new Date().toISOString(),
      };
      if (CONFIRM) await pgrPost('business_place', [row], { onConflict: 'business_id' });
      bizSummary.placeSet = true;
    }

    // 5) businesses.onboarding_expanded — PATCH true if the flag was set.
    if (bRow.onboardingExpanded) {
      if (CONFIRM) {
        await pgrPatch('businesses', { id: `eq.${businessId}` }, { onboarding_expanded: true });
      }
    }

    summary.biz.push(bizSummary);
  }

  // 6) Compact user_metadata: keep only currentBizId + onboarding.{bizType,
  //    atmospheres}. Drop the whole b map — its contents are now in tables.
  const compacted = {};
  if (sonic.currentBizId) compacted.currentBizId = sonic.currentBizId;
  if (sonic.onboarding) {
    const o = sonic.onboarding;
    compacted.onboarding = {
      bizType:     o.bizType     || null,
      atmospheres: Array.isArray(o.atmospheres) ? o.atmospheres : [],
    };
  }
  if (CONFIRM) await writeUserMetadata(u.id, compacted);
  summary.metadataCompacted = true;

  return summary;
}

// ---------- main ----------

console.log(`Mode: ${CONFIRM ? 'CONFIRM (writes)' : 'DRY-RUN (no writes)'}${ONLY_USER ? `  user=${ONLY_USER}` : ''}`);
console.log('---');

const allUsers = [];
let page = 1;
while (true) {
  const chunk = await fetchUsersPage(page).catch((e) => {
    console.error(`page ${page} fetch failed:`, e.message);
    return [];
  });
  if (!chunk.length) break;
  allUsers.push(...chunk);
  page += 1;
  // Safety cap in case of a broken pager — 20 pages × 200 = 4000 users.
  if (page > 20) { console.warn('breaking out at page 20 to avoid runaway'); break; }
}
console.log(`fetched ${allUsers.length} users total`);

const targets = ONLY_USER ? allUsers.filter((u) => u.id === ONLY_USER) : allUsers;
console.log(`processing ${targets.length} users`);
console.log('---');

let ok = 0, failed = 0, skipped = 0;
for (const u of targets) {
  try {
    const s = await migrateUser(u);
    if (s.skipped) { skipped += 1; console.log(`skip  ${u.email || u.id} (${s.skipped})`); }
    else {
      ok += 1;
      const bizLine = s.biz.map((b) =>
        `${b.businessId.slice(0, 8)} playlists=${b.playlists} events=${b.events} hours=${b.hoursSet ? 1 : 0} place=${b.placeSet ? 1 : 0} onb=${b.onboardingExpanded ? 1 : 0}`
      ).join('  |  ');
      console.log(`ok    ${u.email || u.id}  ${bizLine}`);
    }
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ${u.email || u.id}: ${e.message}`);
  }
}

console.log('---');
console.log(`done: ok=${ok} skipped=${skipped} failed=${failed}`);
if (!CONFIRM) console.log('This was a DRY-RUN. Nothing was written. Re-run with --confirm.');
