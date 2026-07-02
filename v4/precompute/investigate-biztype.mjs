// One-off diagnostic. When called with a biz-type arg, deep-dives that one.
// When called with --all, scans every biz type and reports stale genre rows.

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY          = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

async function q(table, query) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${new URLSearchParams(query)}`;
    const r = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if (!r.ok) throw new Error(`${table} ${r.status}: ${await r.text()}`);
    return r.json();
}

async function fetchAllPaginated(table, query = {}) {
    const out = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
        const url = `${SUPABASE_URL}/rest/v1/${table}?${new URLSearchParams(query)}`;
        const r = await fetch(url, {
            headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + PAGE - 1}` },
        });
        if (!r.ok && r.status !== 206) throw new Error(`${table} ${r.status}: ${await r.text()}`);
        const chunk = await r.json();
        out.push(...chunk);
        if (chunk.length < PAGE) break;
        from += PAGE;
    }
    return out;
}

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

const BASE = process.env.DEV_BASE || 'http://localhost:3000';
const scanAll = process.argv.includes('--all');

if (!scanAll) {
    const BIZ = process.argv[2] || 'מסעדת שף / ביסטרו / יוקרה';
    console.log(`Investigating biz type: "${BIZ}"\n`);

    const rows = await q('biztype_genres', {
        select: 'business_type,genre,column_letter,position_in_column',
        business_type: `eq.${BIZ}`,
    });
    console.log(`biztype_genres rows for this biz type: ${rows.length}`);
    const byCol = { G: [], H: [] };
    for (const r of rows) (byCol[r.column_letter] || []).push(r);
    byCol.G.sort((a, b) => a.position_in_column - b.position_in_column);
    byCol.H.sort((a, b) => a.position_in_column - b.position_in_column);
    console.log('\n  G:');
    for (const r of byCol.G) console.log(`    [${r.position_in_column}] ${r.genre}`);
    console.log('\n  H:');
    for (const r of byCol.H) console.log(`    [${r.position_in_column}] ${r.genre}`);

    const sheet = await (await fetch(`${BASE}/api/v4/databox?fresh=1`)).json();
    const sheetRows = (sheet.rows || []).filter(r => r.bizType === BIZ);
    const withH = sheetRows.find(r => Array.isArray(r.genres2) && r.genres2.length > 0) || sheetRows[0];
    if (withH) {
        const sheetG = splitToTokens(withH.genres1);
        const sheetH = splitToTokens(withH.genres2);
        const dbG = byCol.G.map(r => norm(r.genre));
        const dbH = byCol.H.map(r => norm(r.genre));
        console.log('\n---\nDiff (DB has but sheet does not):');
        console.log(`  G stale: ${dbG.filter(g => !sheetG.includes(g)).join(', ') || '(none)'}`);
        console.log(`  H stale: ${dbH.filter(g => !dbH.includes(g)).join(', ') || (dbH.filter(g => !sheetH.includes(g)).join(', ') || '(none)')}`);
        // (correct: use sheetH for H stale)
    }
} else {
    console.log('Scanning ALL biz types for stale genre rows...\n');
    const sheet = await (await fetch(`${BASE}/api/v4/databox?fresh=1`)).json();
    const sheetByBiz = new Map();
    for (const r of (sheet.rows || [])) {
        if (!r.bizType) continue;
        // populate-biztype-genres picks the row where genres2 is populated
        const withH = (sheet.rows || []).find((x) => x.bizType === r.bizType && Array.isArray(x.genres2) && x.genres2.length > 0);
        if (!withH) continue;
        sheetByBiz.set(r.bizType, { G: splitToTokens(withH.genres1), H: splitToTokens(withH.genres2) });
    }

    const allRows = await fetchAllPaginated('biztype_genres', { select: 'business_type,genre,column_letter,position_in_column' });
    const dbByBiz = new Map();
    for (const r of allRows) {
        if (!dbByBiz.has(r.business_type)) dbByBiz.set(r.business_type, { G: [], H: [] });
        dbByBiz.get(r.business_type)[r.column_letter].push(norm(r.genre));
    }

    const stale = [];
    for (const [biz, { G, H }] of dbByBiz) {
        const sheet = sheetByBiz.get(biz);
        if (!sheet) {
            stale.push({ biz, kind: 'orphan biz type (not in sheet)', G, H });
            continue;
        }
        const gStale = G.filter(g => !sheet.G.includes(g));
        const hStale = H.filter(g => !sheet.H.includes(g));
        if (gStale.length || hStale.length) stale.push({ biz, kind: 'stale genres', gStale, hStale });
    }

    console.log(`Biz types checked: ${dbByBiz.size}`);
    console.log(`Biz types with stale rows: ${stale.length}\n`);
    for (const s of stale) {
        console.log(`  ${s.biz}`);
        console.log(`    ${s.kind}`);
        if (s.gStale?.length) console.log(`    G stale: ${s.gStale.join(', ')}`);
        if (s.hStale?.length) console.log(`    H stale: ${s.hStale.join(', ')}`);
        if (s.G && !s.gStale) console.log(`    G (all): ${s.G.join(', ')}`);
        if (s.H && !s.hStale) console.log(`    H (all): ${s.H.join(', ')}`);
    }
}
