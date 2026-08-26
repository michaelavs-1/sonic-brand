// v4/precompute/dry-run-genres.mjs
//
// Pre-flight for expanding the cache to cover the first 2 playlists of EVERY
// Tab-2 genre row, regardless of which biz type they're tied to. Unlike
// dry-run.mjs (which scopes by biz_type and writes biztype_genres), this
// script walks all Tab-2 rows directly and only touches playlist_genres,
// playlist_tracks, and track_analyses.
//
// Use case: progressively grow the cache. Run this whenever you want more
// genres covered; it skips anything already cached and only plans the missing
// work. Idempotent — safe to re-run.
//
// Output: overwrites state/dry-run.json so batch.mjs picks it up.
//
// NO RapidAPI calls. NO writes (planning only).
//
// Prereqs:
//   1) vercel dev running on :3000
//   2) .env.local at repo root with SUPABASE_URL + SUPABASE_ANON_KEY
//
// Run (from anywhere):
//   node v4/precompute/dry-run-genres.mjs

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

const PLAYLISTS_PER_GENRE = 2;

const norm = (s) => String(s || '').trim().toLowerCase();

// Spotify's editorial/algorithmic playlists (IDs starting with "37i9dQZF1D")
// are region-locked and Client Credentials tokens can't fetch their track
// lists — they return empty. Skip at plan-build time.
function isEditorialPlaylist(id) {
    return typeof id === 'string' && id.startsWith('37i9dQZF1D');
}

async function getJSON(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GET ${url} ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
}

// /api/v4/spotify is behind the requireSiteOrInternal guard (added in the
// 2026-08-22 security audit). Node fetch has no Origin header, so we must
// present the shared INTERNAL_API_KEY via `x-sonic-internal`, otherwise the
// proxy returns 403 {"error":"forbidden"}.
const INTERNAL_HEADERS = {
    'Content-Type': 'application/json',
    ...(process.env.INTERNAL_API_KEY ? { 'x-sonic-internal': process.env.INTERNAL_API_KEY } : {}),
};

async function fetchPlaylistTrackIds(playlistId) {
    const ids = [];
    let offset = 0;
    while (true) {
        const r = await fetch(`${BASE}/api/v4/spotify`, {
            method:  'POST',
            headers: INTERNAL_HEADERS,
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
    console.log(`Mode: expand all Tab-2 genres (first ${PLAYLISTS_PER_GENRE} playlists per row)\n`);

    // 1. Fetch Tab 2
    const tab2 = await getJSON(`${BASE}/api/v4/databox-genres?fresh=1`);
    const tab2Rows = tab2.rows || [];
    console.log(`Tab 2 rows: ${tab2Rows.length}`);

    // 2. Build wanted (playlist_id, genre, position) triples — skipping
    //    Spotify editorial playlists which can't be fetched.
    const wantedPlaylistGenres = [];
    let editorialSkipped = 0;
    for (const row of tab2Rows) {
        const candidates = (row.playlists || []).filter((p) => p?.id);
        let taken = 0;
        const takenThisGenre = new Set();
        for (let i = 0; i < candidates.length && taken < PLAYLISTS_PER_GENRE; i++) {
            const p = candidates[i];
            if (isEditorialPlaylist(p.id)) { editorialSkipped++; continue; }
            // Sheet occasionally contains the same playlist twice in one row —
            // dedupe so Phase 1's upsert doesn't hit ON CONFLICT twice.
            if (takenThisGenre.has(p.id)) continue;
            wantedPlaylistGenres.push({
                playlist_id:       p.id,
                genre:             norm(row.genre),
                position_in_genre: i + 1,
            });
            takenThisGenre.add(p.id);
            taken++;
        }
    }
    console.log(`Wanted playlist_genres entries: ${wantedPlaylistGenres.length}`);
    if (editorialSkipped) console.log(`  editorial playlists skipped: ${editorialSkipped}`);

    // 3. Diff against existing playlist_genres (paginate to handle >1000 rows)
    console.log('Fetching existing playlist_genres from Supabase...');
    const existing = await pgrSelect('playlist_genres', {}, { select: 'playlist_id,genre,position_in_genre', limit: 10000 });
    const existingSet = new Set(existing.map((r) => `${r.playlist_id}|${r.genre}`));
    const newPlaylistGenres = wantedPlaylistGenres.filter(
        (x) => !existingSet.has(`${x.playlist_id}|${x.genre}`)
    );
    console.log(`  existing: ${existing.length}`);
    console.log(`  to add:   ${newPlaylistGenres.length}`);

    // 4. Identify playlists that are genuinely new (not already in playlist_tracks)
    const candidatePlaylistIds = [...new Set(newPlaylistGenres.map((x) => x.playlist_id))];
    console.log(`  candidate playlist_ids (deduped): ${candidatePlaylistIds.length}`);

    const ptExisting = await pgrSelectIn('playlist_tracks', 'playlist_id', candidatePlaylistIds, { select: 'playlist_id' });
    const ptCachedSet = new Set(ptExisting.map((r) => r.playlist_id));
    const playlistsToFetch = candidatePlaylistIds.filter((id) => !ptCachedSet.has(id));
    console.log(`  brand-new playlists to fetch from Spotify: ${playlistsToFetch.length}`);
    console.log(`  newly-linked but already-cached playlists: ${candidatePlaylistIds.length - playlistsToFetch.length}`);

    if (newPlaylistGenres.length === 0) {
        console.log('\nNothing to add — cache already covers first-2-playlists for every Tab-2 row.');
        return;
    }

    // 5. Fetch tracks for the brand-new playlists
    console.log(`\nFetching tracks for ${playlistsToFetch.length} playlists (concurrency=4)...`);
    const t0 = Date.now();
    const playlistTracks = {};
    let totalSlots = 0;
    const allNewIds = new Set();
    let done = 0;

    await pool(playlistsToFetch, 4, async (pid) => {
        const ids = await fetchPlaylistTrackIds(pid);
        playlistTracks[pid] = ids;
        totalSlots += ids.length;
        for (const id of ids) allNewIds.add(id);
        done++;
        if (done % 5 === 0 || done === playlistsToFetch.length) {
            const e = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`  ${done}/${playlistsToFetch.length} | raw=${totalSlots} | unique=${allNewIds.size} | ${e}s`);
        }
    });

    const uniqueIds = [...allNewIds];
    console.log(`\nTotal raw track slots:    ${totalSlots}`);
    console.log(`Unique playable IDs:      ${uniqueIds.length}`);

    // 6. How many of these unique IDs are already in track_analyses (any status)?
    console.log('\nChecking Supabase track_analyses for already-cached IDs...');
    let alreadyCachedCount = 0;
    try {
        const existingTa = await pgrSelectIn('track_analyses', 'spotify_id', uniqueIds, { select: 'spotify_id' });
        alreadyCachedCount = existingTa.length;
        console.log(`  already cached: ${alreadyCachedCount}`);
    } catch (err) {
        console.warn(`  WARNING: Supabase check failed: ${err.message}; treating as 0`);
    }
    const expectedNewCalls = uniqueIds.length - alreadyCachedCount;

    // 7. Build and write the plan. Same shape as dry-run.mjs so batch.mjs can
    //    consume it. biztype_genres is empty — this script doesn't touch that
    //    table (no biz-type linkage in this scope).
    const plan = {
        generated_at:          new Date().toISOString(),
        source:                'dry-run-genres.mjs (all-Tab-2 expand mode)',
        target_biz_types:      [],   // not applicable in this mode
        playlists_per_genre:   PLAYLISTS_PER_GENRE,
        biztype_genres:        [],   // no-op upsert in batch.mjs
        playlist_genres:       newPlaylistGenres,
        playlist_tracks:       playlistTracks,
        unique_track_ids:      uniqueIds,
        unique_track_count:    uniqueIds.length,
        already_cached_count:  alreadyCachedCount,
        expected_new_calls:    expectedNewCalls,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(plan, null, 0));
    const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);

    console.log('\n=== EXECUTION PLAN ===');
    console.log(`  Mode:                      expand-all-genres`);
    console.log(`  New playlist_genres rows:  ${newPlaylistGenres.length}`);
    console.log(`  Brand-new playlists:       ${playlistsToFetch.length}`);
    console.log(`  Total raw track slots:     ${totalSlots}`);
    console.log(`  Unique playable IDs:       ${uniqueIds.length}`);
    console.log(`  Already cached:            ${alreadyCachedCount}`);
    console.log(`  Expected new RapidAPI:     ${expectedNewCalls}`);
    console.log(`\n  Plan written to: ${path.relative(process.cwd(), OUT_PATH)} (${sizeKb} KB)`);
    console.log('  The batch script will refuse to start unless this file');
    console.log('  exists and was generated within the last 24 hours.');
}

main().catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
});
