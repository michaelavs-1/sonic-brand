// v4/precompute/dry-run.mjs
//
// Pre-flight cost helper for the v4 Supabase precompute batch.
// Walks EVERY biz type in Tab 1 that has column H populated (G ∪ H tokens
// after /-and-, splitting, first PLAYLISTS_PER_GENRE playlists per Tab-2 row),
// counts unique playable tracks, checks Supabase for which IDs are already
// cached, and writes an execution plan to state/dry-run.json.
//
// NO RapidAPI calls. NO database writes. Only:
//   - Spotify GET via /api/v4/spotify proxy (free under Michael's app)
//   - Data Box reads via /api/v4/databox + /api/v4/databox-genres
//   - Supabase SELECT against track_analyses (via REST, anon key, read-only)
//
// Prereqs:
//   1) vercel dev running on :3000 (serves /api/v4/* proxies)
//   2) .env.local at repo root with SUPABASE_URL + SUPABASE_ANON_KEY
//      (run `vercel env pull .env.local --environment=production` once)
//
// Run (from anywhere):
//   node v4/precompute/dry-run.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------- env loader: read .env.local without overriding existing process.env ----------
(function loadDotEnv() {
    const p = path.join(REPO_ROOT, '.env.local');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
})();

const { pgrSelectIn } = await import('../../api/v4/supabase-client.js');

const BASE     = process.env.DEV_BASE || 'http://localhost:3000';
const OUT_PATH = path.join(STATE_DIR, 'dry-run.json');

const PLAYLISTS_PER_GENRE = 2;

const norm = (s) => String(s || '').trim().toLowerCase();

// Genre cells (Tab 1 and Tab 2) may contain multiple genres separated by / or ,
// with any whitespace pattern. See memory: databox-genre-delimiters.
function splitToTokens(raw) {
    const out = [];
    const cells = Array.isArray(raw) ? raw : [raw];
    for (const cell of cells) {
        if (cell == null) continue;
        for (const p of String(cell).split(/\s*[\/,]\s*/)) {
            const n = norm(p);
            if (n && !out.includes(n)) out.push(n);
        }
    }
    return out;
}

async function getJSON(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GET ${url} ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
}

async function fetchPlaylistTrackIds(playlistId) {
    const ids = [];
    let offset = 0;
    while (true) {
        const r = await fetch(`${BASE}/api/v4/spotify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                action:      'get_playlist_tracks',
                playlist_id: playlistId,
                offset, limit: 100,
                fields:      'items(track(id,is_playable))',
                market:      'IL',
            }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            console.warn(`  ! playlist ${playlistId} offset=${offset} -> HTTP ${r.status}`);
            return ids;
        }
        const items = Array.isArray(data.items) ? data.items : [];
        for (const it of items) {
            const t = it?.track;
            if (t?.id && t.is_playable !== false) ids.push(t.id);
        }
        if (items.length < 100) break;
        offset += 100;
    }
    return ids;
}

async function pool(items, concurrency, worker) {
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            await worker(items[i], i);
        }
    }));
}

async function main() {
    console.log(`Base: ${BASE}`);
    console.log(`Playlists per matched Tab-2 row: ${PLAYLISTS_PER_GENRE}\n`);

    // ----- Step 1: pick the H-populated row for every biz type in Tab 1 -----
    const tab1 = await getJSON(`${BASE}/api/v4/databox?fresh=1`);
    const rows = tab1.rows || [];

    const chosenRows = [];
    const seenBizType = new Set();
    for (const r of rows) {
        if (!r.bizType || seenBizType.has(r.bizType)) continue;
        const withH = rows.find((x) => x.bizType === r.bizType && Array.isArray(x.genres2) && x.genres2.length > 0);
        if (!withH) continue;
        seenBizType.add(r.bizType);
        chosenRows.push(withH);
    }
    if (!chosenRows.length) throw new Error('No biz types with column H populated found in Tab 1');
    console.log(`Chosen rows (H-populated only): ${chosenRows.length} biz types`);
    for (const r of chosenRows) {
        console.log(`  row=${r.row}  "${r.bizType}"  raw G=${(r.genres1||[]).length}cells  raw H=${(r.genres2||[]).length}cells`);
    }

    // ----- Step 2: split G and H cells into tokens (preserving order) -----
    const biztypeGenresRows = [];   // for biztype_genres table
    for (const r of chosenRows) {
        const gTokens = splitToTokens(r.genres1);
        const hTokens = splitToTokens(r.genres2);
        gTokens.forEach((g, i) => biztypeGenresRows.push({
            business_type:      r.bizType,
            genre:              g,
            column_letter:      'G',
            position_in_column: i + 1,
        }));
        hTokens.forEach((g, i) => biztypeGenresRows.push({
            business_type:      r.bizType,
            genre:              g,
            column_letter:      'H',
            position_in_column: i + 1,
        }));
    }
    console.log('\nbiztype_genres rows to be written:');
    for (const r of chosenRows) {
        const own = biztypeGenresRows.filter((x) => x.business_type === r.bizType);
        console.log(`  ${r.bizType}:`);
        for (const x of own) console.log(`    column ${x.column_letter} pos ${x.position_in_column}: ${x.genre}`);
    }

    // ----- Step 3: find matching Tab-2 rows (split their `genre` field too) -----
    const wantedTokens = new Set(biztypeGenresRows.map((x) => x.genre));
    console.log(`\nUnique wanted genre tokens: ${wantedTokens.size}`);

    const tab2 = await getJSON(`${BASE}/api/v4/databox-genres?fresh=1`);
    const tab2Rows = tab2.rows || [];

    const matchedTab2Rows = [];
    for (const r of tab2Rows) {
        const rowTokens = splitToTokens(r.genre);
        const intersects = rowTokens.some((t) => wantedTokens.has(t));
        if (intersects) matchedTab2Rows.push({ row: r, tokens: rowTokens });
    }
    console.log(`Matching Tab-2 rows: ${matchedTab2Rows.length} / ${tab2Rows.length}`);

    const coveredTokens = new Set();
    for (const m of matchedTab2Rows) for (const t of m.tokens) coveredTokens.add(t);
    const uncoveredTokens = [...wantedTokens].filter((t) => !coveredTokens.has(t));
    if (uncoveredTokens.length) {
        console.warn(`  ! Wanted tokens with NO Tab-2 coverage: ${uncoveredTokens.join(', ')}`);
    }

    // ----- Step 4: take first N playlists per matched Tab-2 row -----
    const playlistGenresRows = [];   // for playlist_genres table
    const playlistIds = new Set();
    for (const m of matchedTab2Rows) {
        const first = (m.row.playlists || []).slice(0, PLAYLISTS_PER_GENRE).filter((p) => p?.id);
        first.forEach((p, i) => {
            playlistIds.add(p.id);
            playlistGenresRows.push({
                playlist_id:       p.id,
                genre:             norm(m.row.genre),  // keep Tab-2's row name as the canonical genre
                position_in_genre: i + 1,
            });
        });
    }
    const playlists = [...playlistIds];
    console.log(`Unique playlists to scan: ${playlists.length}`);

    // ----- Step 5: fetch tracks via Spotify -----
    console.log('\nFetching playlist tracks (concurrency=4)...');
    const t0 = Date.now();
    const playlistTracks = {};       // playlist_id -> [spotify_id, ...]
    const uniqueTracks = new Set();
    let totalSlots = 0;
    let done = 0;

    await pool(playlists, 4, async (pid) => {
        const ids = await fetchPlaylistTrackIds(pid);
        playlistTracks[pid] = ids;
        totalSlots += ids.length;
        for (const id of ids) uniqueTracks.add(id);
        done++;
        if (done % 5 === 0 || done === playlists.length) {
            const e = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`  ${done}/${playlists.length} | raw=${totalSlots} | unique=${uniqueTracks.size} | ${e}s`);
        }
    });

    const allUniqueIds = [...uniqueTracks];
    console.log(`\nTotal raw track slots:    ${totalSlots}`);
    console.log(`Unique playable IDs:      ${allUniqueIds.length}`);

    // ----- Step 6: ask Supabase how many of these IDs are already cached -----
    console.log('\nChecking Supabase track_analyses for already-cached IDs...');
    let alreadyCachedCount = 0;
    try {
        const existing = await pgrSelectIn('track_analyses', 'spotify_id', allUniqueIds, { select: 'spotify_id' });
        alreadyCachedCount = existing.length;
        console.log(`  Already cached: ${alreadyCachedCount}`);
    } catch (err) {
        console.warn(`  WARNING: Supabase check failed: ${err.message}`);
        console.warn('  Treating as 0 cached. The batch script will recompute this.');
    }
    const expectedNewCalls = allUniqueIds.length - alreadyCachedCount;

    // ----- Step 7: build the execution-plan JSON and write -----
    const targetBizTypes = chosenRows.map((r) => r.bizType);
    const plan = {
        generated_at:          new Date().toISOString(),
        target_biz_types:      targetBizTypes,
        playlists_per_genre:   PLAYLISTS_PER_GENRE,
        biztype_genres:        biztypeGenresRows,
        playlist_genres:       playlistGenresRows,
        playlist_tracks:       playlistTracks,
        unique_track_ids:      allUniqueIds,
        unique_track_count:    allUniqueIds.length,
        already_cached_count:  alreadyCachedCount,
        expected_new_calls:    expectedNewCalls,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(plan, null, 0));
    const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);

    console.log('\n=== EXECUTION PLAN ===');
    console.log(`  Target biz types (${targetBizTypes.length}): ${targetBizTypes.join(', ')}`);
    console.log(`  biztype_genres rows:      ${biztypeGenresRows.length}`);
    console.log(`  Unique wanted tokens:     ${wantedTokens.size}`);
    console.log(`  Matching Tab-2 rows:      ${matchedTab2Rows.length}`);
    console.log(`  Unique playlists:         ${playlists.length}`);
    console.log(`  Total raw track slots:    ${totalSlots}`);
    console.log(`  Unique playable IDs:      ${allUniqueIds.length}`);
    console.log(`  Already cached:           ${alreadyCachedCount}`);
    console.log(`  Expected new RapidAPI:    ${expectedNewCalls}`);
    if (uncoveredTokens.length) console.log(`  Uncovered tokens (${uncoveredTokens.length}):     ${uncoveredTokens.join(', ')}`);
    console.log(`\n  Plan written to: ${OUT_PATH} (${sizeKb} KB)`);
    console.log('  The batch script will refuse to start unless this file');
    console.log('  exists and was generated within the last 24 hours.');
}

main().catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
});
