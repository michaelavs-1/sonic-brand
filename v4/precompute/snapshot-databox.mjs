// v4/precompute/snapshot-databox.mjs
//
// Captures a point-in-time snapshot of both Data Box tabs and writes it to
// databox-snapshots/snapshot-YYYY-MM-DDTHHMMSSZ.json (next to this script).
//
// The output format is stable (rows sorted by row number, keys sorted within
// objects) so future diff tooling can compare two snapshots cleanly.
//
// Snapshots are intended to be committed to git — they're the baseline for
// any change-detection mechanism.
//
// Run (from anywhere):
//   node v4/precompute/snapshot-databox.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = process.env.DEV_BASE || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, 'databox-snapshots');

async function getJSON(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GET ${url} ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
}

// Stable stringify — sorts object keys at every depth so the diff is on
// content, not on Node's key insertion order.
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log(`Base: ${BASE}`);
    console.log('Fetching Tab 1 (databox)...');
    const tab1 = await getJSON(`${BASE}/api/v4/databox?fresh=1`);
    const tab1Rows = (tab1.rows || []).slice().sort((a, b) => (a.row ?? 0) - (b.row ?? 0));

    console.log('Fetching Tab 2 (databox-genres)...');
    const tab2 = await getJSON(`${BASE}/api/v4/databox-genres?fresh=1`);
    const tab2Rows = (tab2.rows || []).slice().sort((a, b) => (a.row ?? 0) - (b.row ?? 0));

    const snapshotAt = new Date().toISOString();
    const snapshot = {
        snapshot_at: snapshotAt,
        source: {
            base_url:    BASE,
            tab1_path:   '/api/v4/databox',
            tab2_path:   '/api/v4/databox-genres',
        },
        counts: {
            tab1_rows: tab1Rows.length,
            tab2_rows: tab2Rows.length,
        },
        tab1_business_types: tab1Rows,
        tab2_genres:         tab2Rows,
    };

    // Filename-safe ISO timestamp (no colons on Windows).
    const safeStamp = snapshotAt.replace(/[:.]/g, '-');
    const outPath = path.join(OUT_DIR, `snapshot-${safeStamp}.json`);
    fs.writeFileSync(outPath, stableStringify(snapshot));

    const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log('\n=== SNAPSHOT WRITTEN ===');
    console.log(`  Path:           ${path.relative(process.cwd(), outPath)}`);
    console.log(`  Size:           ${sizeKb} KB`);
    console.log(`  Tab 1 rows:     ${tab1Rows.length}`);
    console.log(`  Tab 2 rows:     ${tab2Rows.length}`);
    console.log(`  Snapshot time:  ${snapshotAt}`);
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
