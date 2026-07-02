// v4/precompute/dry-run-orphans.mjs
//
// Plans a batch that processes spotify_ids present in playlist_tracks but
// MISSING from track_analyses — "orphans". These are tracks that got their
// playlist_tracks rows upserted (Phase 1 of an earlier batch) but never made
// it through the RapidAPI phase. Common causes: monthly cap reached mid-run,
// auth/gateway abort, sub-section of queue manually stripped (e.g. Modern Pop).
//
// Complements `--retry-errors` in batch.mjs:
//   --retry-errors  → re-attempts tracks with status='error' (transient
//                     failures we want to give another chance)
//   dry-run-orphans → re-attempts tracks that were never touched at all
//
// Prereqs:
//   1) .env.local with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   (Does NOT require vercel dev — pure Supabase scan, no Spotify proxy calls.)
//
// NO RapidAPI calls. NO writes.
//
// Output: state/dry-run.json (consumed by batch.mjs)
//
// Run (from anywhere):
//   node v4/precompute/dry-run-orphans.mjs

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY          = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_*_KEY in .env.local');
    process.exit(1);
}
const OUT_PATH = path.join(STATE_DIR, 'dry-run.json');

// PostgREST paginated select via Range header — works for tables much larger
// than the 1000-row default page.
async function fetchAllPaginated(table, query = {}) {
    const out = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
        const url = `${SUPABASE_URL}/rest/v1/${table}?${new URLSearchParams(query)}`;
        const r = await fetch(url, {
            headers: {
                apikey:        KEY,
                Authorization: `Bearer ${KEY}`,
                Range:         `${from}-${from + PAGE - 1}`,
            },
        });
        if (!r.ok && r.status !== 206) {
            throw new Error(`${table} ${r.status}: ${await r.text()}`);
        }
        const chunk = await r.json();
        out.push(...chunk);
        if (chunk.length < PAGE) break;
        from += PAGE;
    }
    return out;
}

async function main() {
    console.log('Scanning Supabase for orphan spotify_ids...');
    console.log('  orphan = present in playlist_tracks, MISSING from track_analyses\n');

    // 1. All (playlist_id, spotify_id, position) from playlist_tracks
    console.log('Fetching playlist_tracks...');
    const ptRows = await fetchAllPaginated('playlist_tracks', { select: 'playlist_id,spotify_id,position' });
    console.log(`  playlist_tracks rows: ${ptRows.length}`);

    // 2. All spotify_ids in track_analyses (any status counts as "touched")
    console.log('Fetching track_analyses...');
    const taRows = await fetchAllPaginated('track_analyses', { select: 'spotify_id' });
    const taSet = new Set(taRows.map((r) => r.spotify_id));
    console.log(`  track_analyses rows: ${taRows.length}`);

    // 3. Orphans grouped by playlist for round-robin ordering + reporting
    const orphansByPlaylist = new Map();   // playlist_id -> [{ spotify_id, position }]
    const orphanIdSet = new Set();
    for (const r of ptRows) {
        if (taSet.has(r.spotify_id)) continue;
        if (orphanIdSet.has(r.spotify_id)) continue;  // de-dupe across playlists
        orphanIdSet.add(r.spotify_id);
        if (!orphansByPlaylist.has(r.playlist_id)) orphansByPlaylist.set(r.playlist_id, []);
        orphansByPlaylist.get(r.playlist_id).push({ spotify_id: r.spotify_id, position: r.position ?? 0 });
    }
    console.log(`\nDistinct orphan spotify_ids: ${orphanIdSet.size}`);
    console.log(`Playlists with at least one orphan: ${orphansByPlaylist.size}`);

    if (orphanIdSet.size === 0) {
        console.log('\nNo orphans. Nothing to do.');
        return;
    }

    // 4. Genre rollup (informational — helps the user see which genres benefit)
    console.log('\nFetching playlist_genres for genre rollup...');
    const pgRows = await fetchAllPaginated('playlist_genres', { select: 'playlist_id,genre' });
    const playlistGenres = new Map();
    for (const r of pgRows) {
        if (!playlistGenres.has(r.playlist_id)) playlistGenres.set(r.playlist_id, []);
        playlistGenres.get(r.playlist_id).push(r.genre);
    }
    const perGenre = new Map();
    let unlinkedOrphans = 0;
    for (const [pid, orphans] of orphansByPlaylist) {
        const genres = playlistGenres.get(pid);
        if (!genres || genres.length === 0) {
            unlinkedOrphans += orphans.length;
            continue;
        }
        for (const g of genres) {
            perGenre.set(g, (perGenre.get(g) || 0) + orphans.length);
        }
    }
    console.log('\n=== Orphans per genre (track count) ===');
    const ranked = [...perGenre.entries()].sort((a, b) => b[1] - a[1]);
    for (const [g, n] of ranked) console.log(`  ${g.padEnd(30)} ${String(n).padStart(5)}`);
    if (unlinkedOrphans) console.log(`  <unlinked playlists>           ${String(unlinkedOrphans).padStart(5)}`);

    // 5. Round-robin order: sort each playlist's orphans by position, then
    //    pick one from each playlist per round. Early abort yields even
    //    coverage across playlists/genres instead of finishing some fully.
    for (const list of orphansByPlaylist.values()) {
        list.sort((a, b) => a.position - b.position);
    }
    const playlists = [...orphansByPlaylist.keys()];
    const maxRound  = Math.max(...[...orphansByPlaylist.values()].map((v) => v.length));
    const orderedIds = [];
    const seen = new Set();
    for (let r = 0; r < maxRound; r++) {
        for (const pid of playlists) {
            const entry = orphansByPlaylist.get(pid)[r];
            if (!entry || seen.has(entry.spotify_id)) continue;
            seen.add(entry.spotify_id);
            orderedIds.push(entry.spotify_id);
        }
    }

    // 6. Write plan. Phase-1 sections are empty: every playlist_tracks /
    //    playlist_genres row that points at these orphans is already in DB.
    const plan = {
        generated_at:          new Date().toISOString(),
        source:                'dry-run-orphans.mjs (playlist_tracks minus track_analyses)',
        target_biz_types:      [],
        playlists_per_genre:   0,
        biztype_genres:        [],
        playlist_genres:       [],
        playlist_tracks:       {},
        unique_track_ids:      orderedIds,
        unique_track_count:    orderedIds.length,
        already_cached_count:  0,
        expected_new_calls:    orderedIds.length,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(plan));
    const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);

    console.log('\n=== EXECUTION PLAN ===');
    console.log(`  Mode:                      orphan recovery`);
    console.log(`  Orphan spotify_ids:        ${orderedIds.length}`);
    console.log(`  Playlists involved:        ${orphansByPlaylist.size}`);
    console.log(`  Expected new RapidAPI:     ${orderedIds.length}`);
    console.log(`\n  Plan written to: ${path.relative(process.cwd(), OUT_PATH)} (${sizeKb} KB)`);
    console.log('  Run:');
    console.log('    node v4/precompute/batch.mjs --max-rapidapi-calls=<N>');
    console.log('  Auto-abort safeties active. Cap-induced partial runs are graceful (per-call check).');
}

main().catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
});
