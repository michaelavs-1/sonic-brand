// v4/precompute/populate-biztype-genres.mjs
//
// Walks Tab 1 of the current Data Box and upserts biztype_genres rows for
// every business type that has column H populated. Each cell from genres1
// and genres2 is normalized (lowercase + trim) and split on / or , so that
// multi-genre cells expand correctly. Combined names like "Heavy Rock+Metal"
// stay as one genre (the splitter only splits on / and ,).
//
// Idempotent. PK is (business_type, genre), so upserting an existing row just
// overwrites column_letter and position_in_column if they've changed.
//
// No RapidAPI calls. No track-analysis work. Just rebuilds the runtime
// biz_type → genre lookup table from the live sheet.
//
// Use case: any time the Data Box Tab 1 has had biz types added, removed,
// renamed, or had genre cells reordered. Especially needed when adding a
// new biz type whose biztype_genres rows weren't previously populated by
// the precompute scripts.
//
// Prereqs: vercel dev running on :3000 (for the databox proxy).
//
// Run:
//   node v4/precompute/populate-biztype-genres.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const { pgrUpsert } = await import('../../api/v4/supabase-client.js');

const BASE = process.env.DEV_BASE || 'http://localhost:3000';
const norm = (s) => String(s || '').trim().toLowerCase();

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

async function main() {
    console.log(`Base: ${BASE}`);
    console.log('Fetching Tab 1...');
    const tab1 = await getJSON(`${BASE}/api/v4/databox?fresh=1`);
    const rows = tab1.rows || [];
    console.log(`  Tab 1 total rows: ${rows.length}`);

    // For each biz type, pick the row that has column H populated. (In the
    // current sheet, the user removed any biz type that didn't have H, so
    // every row qualifies, but the H-populated rule is the canonical one.)
    const seenBizType = new Set();
    const chosenRows = [];
    for (const r of rows) {
        if (!r.bizType) continue;
        if (seenBizType.has(r.bizType)) continue;
        const withH = rows.find((x) => x.bizType === r.bizType && Array.isArray(x.genres2) && x.genres2.length > 0);
        if (!withH) continue;
        seenBizType.add(r.bizType);
        chosenRows.push(withH);
    }
    console.log(`  biz types with column H populated: ${chosenRows.length}\n`);

    // Build the biztype_genres rows. position_in_column = cell index in the
    // sheet (1-indexed), preserved for the UI's batch ordering.
    const biztypeGenresRows = [];
    let totalCellTokens = 0;
    for (const r of chosenRows) {
        const gTokens = splitToTokens(r.genres1);
        const hTokens = splitToTokens(r.genres2);
        totalCellTokens += gTokens.length + hTokens.length;
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

    // Group by biz type for the log so the user can sanity-check
    console.log('biz_type → genre rows being upserted:');
    const byBiz = new Map();
    for (const x of biztypeGenresRows) {
        if (!byBiz.has(x.business_type)) byBiz.set(x.business_type, []);
        byBiz.get(x.business_type).push(x);
    }
    for (const [bt, xs] of byBiz) {
        const g = xs.filter((x) => x.column_letter === 'G').map((x) => x.genre).join(', ');
        const h = xs.filter((x) => x.column_letter === 'H').map((x) => x.genre).join(', ');
        console.log(`  ${bt}:`);
        console.log(`    G: ${g}`);
        console.log(`    H: ${h}`);
    }
    console.log(`\nTotal rows to upsert: ${biztypeGenresRows.length}`);

    // Chunked upsert (small dataset, but be safe)
    const CHUNK = 500;
    for (let i = 0; i < biztypeGenresRows.length; i += CHUNK) {
        await pgrUpsert('biztype_genres', biztypeGenresRows.slice(i, i + CHUNK));
    }
    console.log('\nDone.');
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
