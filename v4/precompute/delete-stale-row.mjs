// One-off: delete the stale (מסעדת שף / ביסטרו / יוקרה, indie rock) row from biztype_genres.

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
const KEY          = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const BIZ   = 'מסעדת שף / ביסטרו / יוקרה';
const GENRE = 'indie rock';

// Verify before deleting
const beforeUrl = `${SUPABASE_URL}/rest/v1/biztype_genres?${new URLSearchParams({
    select: 'business_type,genre,column_letter,position_in_column',
    business_type: `eq.${BIZ}`,
    genre: `eq.${GENRE}`,
})}`;
const beforeR = await fetch(beforeUrl, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
const beforeRows = await beforeR.json();
console.log(`Rows matching (${BIZ}, ${GENRE}) BEFORE delete: ${beforeRows.length}`);
for (const r of beforeRows) console.log(`  ${JSON.stringify(r)}`);

if (beforeRows.length === 0) {
    console.log('Nothing to delete. Exiting.');
    process.exit(0);
}
if (beforeRows.length > 1) {
    console.error('Refusing to delete: found more than one matching row. Investigate manually.');
    process.exit(1);
}

// Delete
const delUrl = `${SUPABASE_URL}/rest/v1/biztype_genres?${new URLSearchParams({
    business_type: `eq.${BIZ}`,
    genre: `eq.${GENRE}`,
})}`;
const delR = await fetch(delUrl, {
    method: 'DELETE',
    headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: 'return=representation',
    },
});
if (!delR.ok) {
    console.error(`DELETE failed: ${delR.status} ${await delR.text()}`);
    process.exit(1);
}
const deleted = await delR.json();
console.log(`\nDeleted ${deleted.length} row(s):`);
for (const r of deleted) console.log(`  ${JSON.stringify(r)}`);

// Verify after
const afterR = await fetch(beforeUrl, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
const afterRows = await afterR.json();
console.log(`\nRows matching AFTER delete: ${afterRows.length} (expected: 0)`);

// Also print the full H column so we can confirm the biz type is back to 4
const hUrl = `${SUPABASE_URL}/rest/v1/biztype_genres?${new URLSearchParams({
    select: 'genre,position_in_column',
    business_type: `eq.${BIZ}`,
    column_letter: `eq.H`,
    order: 'position_in_column.asc',
})}`;
const hRows = await (await fetch(hUrl, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();
console.log(`\nColumn H for this biz type now has ${hRows.length} genres:`);
for (const r of hRows) console.log(`  [${r.position_in_column}] ${r.genre}`);
