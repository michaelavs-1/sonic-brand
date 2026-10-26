// v4/precompute/sheet-status.mjs
//
// "What's waiting to be scanned?" — compares the Data Box sheet (Tab 2,
// genre → playlist links) with the DB and with shared/genre-universe.js, and
// lists Ami's manual tracks (Track cleanup's "Add to DB") still waiting for
// an analysis. Read-only: no writes, no RapidAPI, no Spotify calls, and no
// vercel dev (it calls the sheet reader's handler directly).
//
// Reports:
//   - sheet genres not in the genre list, and list genres not in the sheet;
//   - sheet playlists not in the DB (Spotify's own 37i9dQZF1D… ones are
//     skipped: they can't be read), and DB playlist/genre pairs the sheet
//     no longer lists;
//   - Ami's manual tracks: never analysed / analysis failed.
//
// Run: node v4/precompute/sheet-status.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

const imp = (p) => import(pathToFileURL(path.join(REPO_ROOT, p)).href);
const { GENRES } = await imp('shared/genre-universe.js');
const { default: databoxGenres } = await imp('api/v4/databox-genres.js');
const { pgrSelectAll, pgrSelectIn } = await imp('api/v4/supabase-client.js');

const isEditorial = (id) => String(id).startsWith('37i9dQZF1D');
const isManual = (id) => String(id).startsWith('manual:');

// Call the API handler in-process with a minimal req/res.
function readSheet() {
    return new Promise((resolve, reject) => {
        const res = {
            setHeader() {},
            status(code) { this.code = code; return this; },
            json(body) { this.code >= 400 ? reject(new Error(body?.error || `sheet ${this.code}`)) : resolve(body); },
            end() { resolve({}); },
        };
        databoxGenres({ method: 'GET', query: { fresh: '1' } }, res).catch(reject);
    });
}

function list(title, items, fmt = (x) => x) {
    console.log(`\n${title}: ${items.length}`);
    for (const x of items) console.log(`  ${fmt(x)}`);
}

async function main() {
    const sheet = await readSheet();
    const sheetGenres = new Map(); // lowercase → { name, ids }
    for (const row of sheet.rows || []) {
        const key = row.genre.trim().toLowerCase();
        if (!sheetGenres.has(key)) sheetGenres.set(key, { name: row.genre.trim(), ids: new Set() });
        for (const p of row.playlists || []) sheetGenres.get(key).ids.add(p.id);
    }
    const universe = new Map(GENRES.map((g) => [g.toLowerCase(), g]));

    const pg = await pgrSelectAll('playlist_genres', {}, { select: 'playlist_id,genre', order: 'playlist_id.asc,genre.asc', useService: true });
    const dbPairs = new Set(pg.map((r) => `${r.playlist_id}|${r.genre}`));
    const dbPlaylists = new Set(pg.map((r) => r.playlist_id));

    console.log(`Sheet genres: ${sheetGenres.size} · genre list: ${universe.size}`);

    list('Sheet genres not in the genre list', [...sheetGenres.values()].filter((g) => !universe.has(g.name.toLowerCase())),
        (g) => `${g.name} (${g.ids.size} playlists)`);
    list('Genre-list genres not in the sheet', GENRES.filter((g) => !sheetGenres.has(g.toLowerCase())));

    const missing = new Map(); // genre → count
    let editorial = 0;
    for (const g of sheetGenres.values()) {
        for (const id of g.ids) {
            if (isEditorial(id)) { editorial++; continue; }
            if (!dbPlaylists.has(id)) missing.set(g.name, (missing.get(g.name) || 0) + 1);
        }
    }
    const missingTotal = [...missing.values()].reduce((a, b) => a + b, 0);
    console.log(`\nSheet playlists not in the DB: ${missingTotal}${editorial ? ` (plus ${editorial} Spotify-made, always skipped)` : ''}`);
    for (const [name, n] of missing) console.log(`  ${name}: ${n}`);

    const sheetPairs = new Set();
    for (const [key, g] of sheetGenres) for (const id of g.ids) sheetPairs.add(`${id}|${key}`);
    list('DB playlists the sheet no longer lists', pg.filter((r) => !isManual(r.playlist_id) && !sheetPairs.has(`${r.playlist_id}|${r.genre}`)),
        (r) => `${r.genre}: ${r.playlist_id}`);

    // Ami's manual tracks waiting for an analysis.
    const manualRows = await pgrSelectAll('playlist_tracks', { playlist_id: 'like.manual:*' }, { select: 'playlist_id,spotify_id', order: 'playlist_id.asc,spotify_id.asc', useService: true });
    const genreOf = new Map(manualRows.map((r) => [r.spotify_id, r.playlist_id.slice('manual:'.length)]));
    const ids = [...genreOf.keys()];
    const analyses = await pgrSelectIn('track_analyses', 'spotify_id', ids, { select: 'spotify_id,status', useService: true });
    const status = new Map(analyses.map((r) => [r.spotify_id, r.status]));
    const waiting = ids.filter((id) => !status.has(id));
    const failed = ids.filter((id) => status.get(id) === 'error');
    list("Ami's manual tracks never analysed", waiting, (id) => `${genreOf.get(id)}: ${id}`);
    list("Ami's manual tracks whose analysis failed", failed, (id) => `${genreOf.get(id)}: ${id}`);
}

main().catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
});
