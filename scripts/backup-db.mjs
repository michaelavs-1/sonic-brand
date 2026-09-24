/*
  backup-db.mjs — dependency-free snapshot of the v6 production data.

  Reads every v6 business/production table through the PostgREST API using the
  SERVICE_ROLE key (bypasses RLS) and your auth users through the GoTrue admin
  API, then writes them to a timestamped folder under backups/. Skips the heavy
  track-analysis catalog. No Docker, no pg_dump, no DB password.

  What it captures (schema + RLS + functions are already preserved in git under
  v5/precompute/migrations/*.sql — this covers the DATA, which isn't):
    - backups/db-<ts>/json/<table>.json   one file per table (full rows)
    - backups/db-<ts>/auth-users.json     auth.users (incl. user_metadata.sonic)
    - backups/db-<ts>/restore.sql         INSERT statements, parent-first order
    - backups/db-<ts>/manifest.json       table -> row count + timestamp

  Run:  node scripts/backup-db.mjs
  Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
*/

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// --- load .env.local ---
function loadEnv() {
  try {
    const txt = readFileSync(join(repoRoot, '.env.local'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) process.env[m[1]] = process.env[m[1]] ?? m[2];
    }
  } catch { /* fine if absent — rely on real env */ }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local).');
  process.exit(1);
}

// Tables to export, PARENT-FIRST so restore.sql satisfies FKs top-to-bottom.
// The track-analysis catalog + track/playlist archives are intentionally omitted.
const TABLES = [
  'businesses',               // parent of everything below
  'business_directions',
  'business_playlists',
  'business_hours',
  'business_place',
  'business_events',
  'business_event_chats',
  'business_direction_chats',
  'business_direction_changes',
  'business_settings_changes',
  'business_playlist_opens',
  'super_liked_tracks',
  'created_playlists',
  'v6_daily_track_history',
  'gemini_call_log',
  'deleted_events',
  // reference / config (small, worth keeping)
  'atmospheres',
  'biztype_genres',
  // v7 tables — may not exist yet (pre-migration); handled gracefully
  'business_taste_profiles',
  'business_v7_settings',
  'business_v7_directions',
];

const PAGE = 1000;

async function fetchAllRows(table) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      if (r.status === 404 || /does not exist|42P01/.test(body)) {
        return { skipped: true, reason: 'table not found' };
      }
      throw new Error(`${table}: HTTP ${r.status} ${body.slice(0, 200)}`);
    }
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return { rows };
}

async function fetchAuthUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const url = `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${PAGE}`;
    const r = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`auth users: HTTP ${r.status} ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    const batch = Array.isArray(data) ? data : (data.users || []);
    users.push(...batch);
    if (batch.length < PAGE) break;
    page += 1;
  }
  return users;
}

// --- SQL literal formatting for restore.sql ---
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

function tableInserts(table, rows) {
  if (!rows.length) return `-- ${table}: 0 rows\n`;
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const lines = [`-- ${table}: ${rows.length} rows`];
  for (const row of rows) {
    const vals = cols.map((c) => sqlVal(row[c])).join(', ');
    lines.push(`INSERT INTO "${table}" (${colList}) VALUES (${vals}) ON CONFLICT DO NOTHING;`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(repoRoot, 'backups', `db-${stamp}`);
  const jsonDir = join(outDir, 'json');
  mkdirSync(jsonDir, { recursive: true });

  console.log(`Backup dir: ${outDir}`);
  console.log(`Source: ${SUPABASE_URL}\n`);

  const manifest = { created_at: new Date().toISOString(), source: SUPABASE_URL, tables: {}, skipped: [], auth_users: 0 };
  const sqlParts = [
    '-- v6 data restore. Parent-first order; ON CONFLICT DO NOTHING for idempotency.',
    '-- Run against a database that already has the schema (migrations applied).',
    '',
  ];

  for (const table of TABLES) {
    process.stdout.write(`  ${table} ... `);
    try {
      const res = await fetchAllRows(table);
      if (res.skipped) {
        console.log(`skipped (${res.reason})`);
        manifest.skipped.push(table);
        continue;
      }
      writeFileSync(join(jsonDir, `${table}.json`), JSON.stringify(res.rows, null, 2));
      sqlParts.push(tableInserts(table, res.rows));
      manifest.tables[table] = res.rows.length;
      console.log(`${res.rows.length} rows`);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      manifest.tables[table] = `ERROR: ${e.message}`;
    }
  }

  process.stdout.write('  auth.users ... ');
  try {
    const users = await fetchAuthUsers();
    writeFileSync(join(outDir, 'auth-users.json'), JSON.stringify(users, null, 2));
    manifest.auth_users = users.length;
    console.log(`${users.length} users`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    manifest.auth_users = `ERROR: ${e.message}`;
  }

  writeFileSync(join(outDir, 'restore.sql'), sqlParts.join('\n'));
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nDone. Snapshot saved to: ${outDir}`);
  console.log('Files: json/<table>.json, auth-users.json, restore.sql, manifest.json');
}

main().catch((e) => { console.error('\nBackup failed:', e.message); process.exit(1); });
