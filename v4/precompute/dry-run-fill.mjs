// v4/precompute/dry-run-fill.mjs
//
// Plans a batch that fills each Tab-2 genre up to TARGET_PLAYLISTS playlists
// in the cache. Genres already at >= target are skipped entirely. For each
// under-target genre, walks the sheet's playlists in order and queues the
// first ones that aren't yet in playlist_genres.
//
// ROUND-ROBIN ORDERING: new entries are emitted one-per-genre-per-round, so
// the resulting batch processes "all genres' 3rd playlist" → "all genres'
// 4th playlist" → "all genres' 5th". If an auto-abort fires partway, every
// genre got some new coverage rather than a few being fully expanded.
//
// CLI:
//   --target-playlists=N    default 5. Use "max" to fill each targeted genre
//                           up to the number of playlists it has in the sheet.
//   --genres="a,b,c"        optional comma-separated allowlist (normalized
//                           case-insensitive). When absent, ALL Tab-2 genres
//                           are considered.
//
// Prereqs:
//   1) vercel dev running on :3000 (calls /api/v4/databox-genres + /api/v4/spotify)
//   2) .env.local with SUPABASE_URL + SUPABASE_ANON_KEY
//
// NO RapidAPI calls. NO writes. Planning only.
//
// Output: state/dry-run.json (consumed by batch.mjs)
//
// Run (from anywhere):
//   node v4/precompute/dry-run-fill.mjs
//   node v4/precompute/dry-run-fill.mjs --target-playlists=7
//   node v4/precompute/dry-run-fill.mjs --target-playlists=max --genres="downtempo,cha cha cha,easy listening"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

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

const { pgrSelect, pgrSelectIn } = await import('../../api/v4/supabase-client.js');

const BASE     = process.env.DEV_BASE || 'http://localhost:3000';
const OUT_PATH = path.join(STATE_DIR, 'dry-run.json');

function parseArgs() {
    const args = {};
    for (const a of process.argv.slice(2)) {
        const m = a.match(/^--([a-z0-9-]+)(?:=(.+))?$/);
        if (m) args[m[1]] = m[2] ?? true;
    }
    return args;
}
const args = parseArgs();
// --target-playlists=N (default 5) OR --target-playlists=max to fill each
// targeted genre up to whatever number of playlists the sheet has for it.
const TARGET_RAW = args['target-playlists'] ?? '5';
const TARGET_IS_MAX = TARGET_RAW === 'max';
const TARGET_PLAYLISTS = TARGET_IS_MAX ? Infinity : parseInt(TARGET_RAW, 10);
if (!TARGET_IS_MAX && (!Number.isFinite(TARGET_PLAYLISTS) || TARGET_PLAYLISTS < 1)) {
    console.error('--target-playlists must be a positive integer or "max"');
    process.exit(1);
}

// --genres="downtempo, cha cha cha, easy listening" — optional allowlist.
// Case-insensitive, trimmed. When absent, all Tab-2 genres are considered.
const norm = (s) => String(s || '').trim().toLowerCase();
const GENRE_FILTER = args['genres']
    ? new Set(String(args['genres']).split(',').map(norm).filter(Boolean))
    : null;

// Spotify's own curated/algorithmic playlists (Discover Weekly, mood stations,
// editorial covers, etc.) all use IDs beginning with "37i9dQZF1D". Their track
// lists are region-locked and effectively invisible to Client Credentials
// tokens, so any attempt to ingest them returns 0 tracks. Skip them at
// plan-build time so they never eat a slot.
function isEditorialPlaylist(id) {
    return typeof id === 'string' && id.startsWith('37i9dQZF1D');
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
    const targetLabel = TARGET_IS_MAX ? 'sheet-max' : String(TARGET_PLAYLISTS);
    console.log(`Mode: fill each targeted Tab-2 genre to ${targetLabel} playlists (round-robin order)`);
    if (GENRE_FILTER) console.log(`Genre filter: ${[...GENRE_FILTER].join(', ')}`);
    console.log('');

    // 1. Tab 2 from sheet
    const tab2 = await getJSON(`${BASE}/api/v4/databox-genres?fresh=1`);
    const tab2Rows = tab2.rows || [];
    console.log(`Tab 2 rows: ${tab2Rows.length}`);

    // Validate filter: warn if any name is missing from sheet
    if (GENRE_FILTER) {
        const sheetSet = new Set(tab2Rows.map((r) => norm(r.genre)));
        for (const g of GENRE_FILTER) {
            if (!sheetSet.has(g)) console.warn(`  ! genre "${g}" not in Tab 2; will be skipped`);
        }
    }

    // 2. Existing playlist_genres → set per genre
    console.log('Fetching existing playlist_genres from Supabase...');
    const existing = await pgrSelect('playlist_genres', {}, { select: 'playlist_id,genre,position_in_genre', limit: 10000 });
    const existingByGenre = new Map();
    for (const r of existing) {
        if (!existingByGenre.has(r.genre)) existingByGenre.set(r.genre, new Set());
        existingByGenre.get(r.genre).add(r.playlist_id);
    }
    console.log(`  existing playlist_genres rows: ${existing.length}`);

    // 3. For each genre, compute which sheet playlists to add (in sheet order,
    //    skipping any already in DB, and skipping Spotify editorial playlists
    //    that can't be fetched via Client Credentials) until reaching
    //    TARGET_PLAYLISTS (or sheet-max).
    const perGenreNew = []; // [{ genre, newPlaylists: [{pid, position}] }]
    let skippedAlreadyAtTarget = 0;
    let skippedSheetShortage   = 0;
    const skippedEditorial     = []; // [{ genre, position, id }]
    for (const row of tab2Rows) {
        const genreNorm = norm(row.genre);
        if (GENRE_FILTER && !GENRE_FILTER.has(genreNorm)) continue;
        const existingPids = existingByGenre.get(genreNorm) || new Set();
        // Effective target: TARGET_PLAYLISTS or, for --target-playlists=max,
        // however many playlists this genre has in the sheet.
        const effectiveTarget = TARGET_IS_MAX ? (row.playlists || []).length : TARGET_PLAYLISTS;
        const needCount = Math.max(0, effectiveTarget - existingPids.size);
        if (needCount === 0) { skippedAlreadyAtTarget++; continue; }
        const newOnes = [];
        const takenThisGenre = new Set();
        for (let i = 0; i < (row.playlists || []).length && newOnes.length < needCount; i++) {
            const p = row.playlists[i];
            if (!p?.id) continue;
            if (existingPids.has(p.id)) continue;
            // Guard against the sheet containing the same playlist twice under
            // one genre row — otherwise Phase 1's upsert into playlist_genres
            // dies with "ON CONFLICT cannot affect row a second time".
            if (takenThisGenre.has(p.id)) continue;
            if (isEditorialPlaylist(p.id)) {
                skippedEditorial.push({ genre: genreNorm, position: i + 1, id: p.id });
                continue;
            }
            newOnes.push({ pid: p.id, position: i + 1 });
            takenThisGenre.add(p.id);
        }
        if (newOnes.length > 0) {
            perGenreNew.push({ genre: genreNorm, newPlaylists: newOnes });
        }
        if (newOnes.length < needCount) {
            skippedSheetShortage++;
            console.warn(`  ! ${genreNorm}: wanted +${needCount} but sheet only has ${newOnes.length} usable — best effort.`);
        }
    }
    console.log(`\nGenres needing more playlists: ${perGenreNew.length}`);
    console.log(`Genres skipped (already at >=${TARGET_IS_MAX ? 'sheet-max' : TARGET_PLAYLISTS}): ${skippedAlreadyAtTarget}`);
    if (skippedSheetShortage) console.log(`Genres short of target (sheet doesn't have enough usable playlists): ${skippedSheetShortage}`);
    if (skippedEditorial.length) {
        console.log(`Spotify editorial playlists skipped (region-locked, unfetchable): ${skippedEditorial.length}`);
        for (const s of skippedEditorial) console.log(`  - ${s.genre.padEnd(30)} pos${s.position}  ${s.id}`);
    }
    for (const g of perGenreNew) {
        console.log(`  ${g.genre.padEnd(30)} +${g.newPlaylists.length} (sheet positions ${g.newPlaylists.map(p => p.position).join(',')})`);
    }

    // 4. Round-robin: round r picks newPlaylists[r] of each genre that has one.
    const maxRounds = perGenreNew.reduce((m, g) => Math.max(m, g.newPlaylists.length), 0);
    const orderedPlaylists = []; // [{ pid, genre, position }] in the order we'll process
    for (let r = 0; r < maxRounds; r++) {
        for (const g of perGenreNew) {
            const np = g.newPlaylists[r];
            if (np) orderedPlaylists.push({ pid: np.pid, genre: g.genre, position: np.position });
        }
    }
    console.log(`\nTotal new playlists to ingest: ${orderedPlaylists.length}`);
    console.log(`Rounds: ${maxRounds}`);

    if (orderedPlaylists.length === 0) {
        console.log('\nNothing to do — every genre is already at or above the target.');
        return;
    }

    // 5. Fetch tracks for each new playlist (concurrency for throughput; we
    //    preserve round-robin in unique_track_ids by re-walking orderedPlaylists.)
    console.log(`\nFetching tracks for ${orderedPlaylists.length} playlists (concurrency=4)...`);
    const t0 = Date.now();
    const playlistTracks = {}; // raw map: pid -> [spotify_id]
    let totalSlots = 0;
    const allNewIds = new Set();
    let done = 0;
    await pool(orderedPlaylists, 4, async (rp) => {
        const ids = await fetchPlaylistTrackIds(rp.pid);
        playlistTracks[rp.pid] = ids;
        totalSlots += ids.length;
        for (const id of ids) allNewIds.add(id);
        done++;
        if (done % 5 === 0 || done === orderedPlaylists.length) {
            const e = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`  ${done}/${orderedPlaylists.length} | raw=${totalSlots} | unique=${allNewIds.size} | ${e}s`);
        }
    });

    // 6. Build unique_track_ids in round-robin order (first-occurrence wins).
    const uniqueIdsOrdered = [];
    const seen = new Set();
    for (const rp of orderedPlaylists) {
        const ids = playlistTracks[rp.pid] || [];
        for (const id of ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            uniqueIdsOrdered.push(id);
        }
    }

    // 7. How many of these IDs are already in track_analyses (any status)?
    console.log('\nChecking Supabase track_analyses for already-cached IDs...');
    let alreadyCachedCount = 0;
    try {
        const existingTa = await pgrSelectIn('track_analyses', 'spotify_id', uniqueIdsOrdered, { select: 'spotify_id' });
        alreadyCachedCount = existingTa.length;
        console.log(`  already cached: ${alreadyCachedCount}`);
    } catch (err) {
        console.warn(`  WARNING: Supabase check failed: ${err.message}; treating as 0`);
    }
    const expectedNewCalls = uniqueIdsOrdered.length - alreadyCachedCount;

    // 8. playlist_genres rows for the plan (positions match sheet position).
    const newPlaylistGenresRows = orderedPlaylists.map((rp) => ({
        playlist_id:       rp.pid,
        genre:             rp.genre,
        position_in_genre: rp.position,
    }));

    // 9. Write plan in the same shape batch.mjs consumes.
    const plan = {
        generated_at:          new Date().toISOString(),
        source:                `dry-run-fill.mjs (target=${TARGET_PLAYLISTS}, round-robin)`,
        target_biz_types:      [],
        playlists_per_genre:   TARGET_PLAYLISTS,
        biztype_genres:        [],
        playlist_genres:       newPlaylistGenresRows,
        playlist_tracks:       playlistTracks,
        unique_track_ids:      uniqueIdsOrdered,
        unique_track_count:    uniqueIdsOrdered.length,
        already_cached_count:  alreadyCachedCount,
        expected_new_calls:    expectedNewCalls,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(plan));
    const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);

    console.log('\n=== EXECUTION PLAN ===');
    console.log(`  Mode:                      fill-to-${TARGET_IS_MAX ? 'max' : TARGET_PLAYLISTS} (round-robin)`);
    console.log(`  Genres updated:            ${perGenreNew.length}`);
    console.log(`  New playlist_genres rows:  ${newPlaylistGenresRows.length}`);
    console.log(`  Brand-new playlists:       ${orderedPlaylists.length}`);
    console.log(`  Total raw track slots:     ${totalSlots}`);
    console.log(`  Unique playable IDs:       ${uniqueIdsOrdered.length}`);
    console.log(`  Already cached:            ${alreadyCachedCount}`);
    console.log(`  Expected new RapidAPI:     ${expectedNewCalls}`);
    console.log(`\n  Plan written to: ${path.relative(process.cwd(), OUT_PATH)} (${sizeKb} KB)`);
    console.log('  Now run:');
    console.log(`    node v4/precompute/batch.mjs --max-rapidapi-calls=<N>`);
    console.log('  The auto-abort safeties (401/403, HTML gateway, 8/10 terminal storm) are active.');
}

main().catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
});
