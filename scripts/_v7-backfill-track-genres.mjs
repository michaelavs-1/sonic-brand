#!/usr/bin/env node
/**
 * _v7-backfill-track-genres.mjs — fill business_playlists.track_genres for v7
 * playlists built before the per-track genre record existed (2026-09-24).
 *
 * Uses the SAME attachTrackGenres() the live v7 builds use
 * (api/v7/account/_daily-builder.js → v7_track_genres RPC), so backfilled rows
 * are identical in shape to new ones. Only touches rows of version='v7'
 * businesses whose track_genres is NULL and that have track_ids. Idempotent.
 *
 * Requires migration v5/precompute/migrations/2026-09-24-v7-track-genres.sql.
 *
 *   node scripts/_v7-backfill-track-genres.mjs           # dry run (reads only)
 *   node scripts/_v7-backfill-track-genres.mjs --apply   # write track_genres
 *
 * Reads SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY from the
 * environment, falling back to .env.local. Never prints secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const envPath = path.join(ROOT, '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}
const APPLY = process.argv.includes('--apply');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { pgrSelect, pgrPatch } = await load('api/v5/supabase-client.js');
const { attachTrackGenres } = await load('api/v7/account/_daily-builder.js');

const bizRows = await pgrSelect('businesses', { version: 'eq.v7' }, { select: 'id,name', useService: true });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${bizRows.length} v7 business(es)`);
let todo = 0, written = 0, failed = 0;
for (const b of bizRows) {
  let rows;
  try {
    rows = await pgrSelect('business_playlists',
      { business_id: `eq.${b.id}`, track_genres: 'is.null' },
      { select: 'spotify_id,label,genres,track_ids,created_at', order: 'created_at.asc', useService: true });
  } catch (e) {
    if (/track_genres/.test(e.message)) {
      console.error('business_playlists.track_genres does not exist yet — run migration 2026-09-24-v7-track-genres.sql first.');
      process.exit(1);
    }
    throw e;
  }
  for (const row of rows) {
    if (!Array.isArray(row.track_ids) || !row.track_ids.length) continue;
    todo++;
    await attachTrackGenres(row);
    if (!row.track_genres) { failed++; continue; }
    const counts = {};
    let unmatched = 0;
    for (const gs of Object.values(row.track_genres)) {
      if (!gs.length) unmatched++;
      for (const g of gs) counts[g] = (counts[g] || 0) + 1;
    }
    console.log(`  "${b.name}" · ${row.label} (${row.created_at.slice(0, 10)}) — ${row.track_ids.length} tracks → `
      + Object.entries(counts).map(([g, n]) => `${g}: ${n}`).join(', ')
      + (unmatched ? `, unmatched: ${unmatched}` : ''));
    if (APPLY) {
      await pgrPatch('business_playlists', { spotify_id: `eq.${row.spotify_id}` }, { track_genres: row.track_genres });
      written++;
    }
  }
}
console.log(`\n${todo} playlist(s) needing backfill, ${written} written, ${failed} lookup failure(s).`
  + (APPLY ? '' : ' Re-run with --apply to write.'));
