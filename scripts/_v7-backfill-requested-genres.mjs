#!/usr/bin/env node
/**
 * Fill business_taste_profiles.requested_genres for v7 businesses that signed
 * up before 2026-10-05, when signup started recording it. Requested genres =
 * the genres the owner super-liked + the genres they named in their musical
 * emphases; Option 1 puts each one in every playlist of its energy tier.
 *
 * Neither input was stored before, so both are reconstructed:
 *   - Super-liked genres: each saved super-liked track (super_liked_tracks)
 *     → the genres of the catalog playlists it sits in, kept only where
 *     exactly one of them is approved in the profile. A track whose genres
 *     match several approved genres is ambiguous (we don't know which one the
 *     swipe card was showing) — listed, and only used with --include-ambiguous.
 *   - Emphases genres: one Gemini call reads businesses.musical_emphases with
 *     the taste-profile prompt's own rule (REQUESTED_GENRES_RULE).
 * Each requested genre is then forced into approved, as at signup
 * (forceRequestedIntoApproved). super_liked_genres gets the reconstructed list.
 *
 * The Gemini call runs through `vercel dev`'s /api/v6/gemini (callModel does a
 * relative fetch) — keep `vercel dev` running on port 3000 for --generate /
 * --confirm. Needs migration 2026-10-05-v7-requested-genres.sql.
 *
 * Afterwards, rebuild the Option-1 libraries so every direction carries its
 * tier's requested genres: node scripts/_v7-regenerate-energy-directions.mjs --confirm
 * (the daily builder adds missing requested genres anyway, but the library
 * should be built around them).
 *
 * Usage (from the repo root; reads .env.local if the vars aren't set):
 *   node scripts/_v7-backfill-requested-genres.mjs                    list + super-liked genres only (no Gemini, no writes)
 *   node scripts/_v7-backfill-requested-genres.mjs --generate         + the emphases call, print the result (no writes)
 *   node scripts/_v7-backfill-requested-genres.mjs --confirm          + write
 *   add --include-ambiguous to use ambiguous super-likes; --all to redo
 *   businesses that already have requested_genres; <businessId> ... for only these
 */

import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    for (const line of fs.readFileSync(join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* fall through to the check below */ }
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (set them or keep them in .env.local).');
  process.exit(1);
}

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const generate = confirm || args.includes('--generate');
const includeAmbiguous = args.includes('--include-ambiguous');
const redoAll = args.includes('--all');
const onlyIds = args.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
const DEV = process.env.DEV_BASE || 'http://127.0.0.1:3000';

// callModel fetches '/api/v6/gemini' — route relative URLs to vercel dev, with
// a localhost Origin so the origin guard passes.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Origin')) headers.set('Origin', DEV);
    return realFetch(DEV + input, { ...init, headers });
  }
  return realFetch(input, init);
};

const imp = (p) => import(pathToFileURL(join(repoRoot, p)).href);
const { callModel, parseJSONFromText } = await imp('v7/generation/ai-provider.js');
const { REQUESTED_GENRES_RULE, GENRE_UNIVERSE_SECTION, canonicalGenreList, forceRequestedIntoApproved } =
  await imp('v7/generation/taste-profile.js');
const { GENRES } = await imp('shared/genre-universe.js');
const { pgrSelect, pgrPatch } = await imp('api/v5/supabase-client.js');

const sel = (table, filters, select) => pgrSelect(table, filters, { select, useService: true });
const CANON = new Map(GENRES.map((g) => [g.toLowerCase(), g]));

// super_liked_tracks → catalog genres per track → the approved one.
async function superLikedGenres(businessId, approvedSet) {
  const liked = await sel('super_liked_tracks', { business_id: `eq.${businessId}`, deleted_at: 'is.null' }, 'spotify_id');
  const ids = [...new Set(liked.map((r) => r.spotify_id).filter(Boolean))];
  const result = { genres: [], ambiguous: [], unmatched: [], tracks: ids.length };
  if (!ids.length) return result;

  const pt = await sel('playlist_tracks', { spotify_id: `in.(${ids.join(',')})` }, 'playlist_id,spotify_id');
  const playlistIds = [...new Set(pt.map((r) => r.playlist_id))];
  const pg = playlistIds.length
    ? await sel('playlist_genres', { playlist_id: `in.(${playlistIds.map((p) => `"${p}"`).join(',')})` }, 'playlist_id,genre')
    : [];
  const genresOfPlaylist = new Map();
  for (const r of pg) {
    const g = CANON.get(String(r.genre || '').toLowerCase());
    if (g) (genresOfPlaylist.get(r.playlist_id) || genresOfPlaylist.set(r.playlist_id, new Set()).get(r.playlist_id)).add(g);
  }
  for (const id of ids) {
    const all = new Set(pt.filter((r) => r.spotify_id === id).flatMap((r) => [...(genresOfPlaylist.get(r.playlist_id) || [])]));
    const approved = [...all].filter((g) => approvedSet.has(g));
    if (approved.length === 1) result.genres.push(approved[0]);
    else if (approved.length > 1) result.ambiguous.push({ id, genres: approved });
    else result.unmatched.push({ id, genres: [...all] });
  }
  if (includeAmbiguous) result.genres.push(...result.ambiguous.flatMap((a) => a.genres));
  result.genres = canonicalGenreList(result.genres);
  return result;
}

// The emphases text → requested genres, with the taste-profile prompt's rule.
async function emphasesGenres(b, approved) {
  const text = String(b.musical_emphases || '').trim();
  if (!text) return { genres: [], skipped: 'no emphases text' };
  const system = [
    'You read a business owner\'s free-text music preferences and list the genres they explicitly asked for.',
    GENRE_UNIVERSE_SECTION,
    '## Rule',
    REQUESTED_GENRES_RULE,
    'You are only extracting `requested_genres` here — ignore anything above about other fields. The owner\'s approved genres are listed for context; a requested genre does not have to be among them.',
    '## Output\nReturn only JSON: {"requested_genres": ["<genre verbatim from the Genre Universe>", ...]} — [] when they asked for none.',
  ].join('\n\n');
  const userMessage = `Musical emphases: ${text}\n\nApproved genres: ${approved.map((e) => e.genre).join(', ') || '(none)'}`;
  const { text: out } = await callModel({
    system, userMessage, maxTokens: 8192, label: 'v7-backfill-requested-genres', businessId: b.id,
  });
  const parsed = parseJSONFromText(out);
  return { genres: canonicalGenreList(parsed?.requested_genres) };
}

let profiles = await sel('business_taste_profiles', {}, '*');
if (onlyIds.length) profiles = profiles.filter((p) => onlyIds.includes(p.business_id));
if (profiles.length && !('requested_genres' in profiles[0])) {
  console.error('business_taste_profiles has no requested_genres column — run migration v5/precompute/migrations/2026-10-05-v7-requested-genres.sql first.');
  process.exit(1);
}
if (!redoAll && !onlyIds.length) profiles = profiles.filter((p) => p.requested_genres == null);
const businesses = profiles.length
  ? await sel('businesses', { id: `in.(${profiles.map((p) => p.business_id).join(',')})`, version: 'eq.v7' }, 'id,name,musical_emphases')
  : [];
console.log(`${businesses.length} v7 business(es) to backfill${confirm ? '' : generate ? ' — no writes (add --confirm)' : ' — super-likes only (--generate adds the emphases call, --confirm writes)'}\n`);

let written = 0;
for (const b of businesses) {
  const tp = profiles.find((p) => p.business_id === b.id);
  const approved = Array.isArray(tp.approved_genres) ? tp.approved_genres : [];
  const conditional = Array.isArray(tp.conditional_genres) ? tp.conditional_genres : [];
  const N = Number(tp.energy_levels_total) || 4;
  const sl = await superLikedGenres(b.id, new Set(approved.map((e) => e.genre)));

  console.log(`— ${b.id.slice(0, 8)} "${b.name}" (N=${N}, ${approved.length} approved)`);
  console.log(`  emphases: ${String(b.musical_emphases || '').trim() || '(none)'}`);
  console.log(`  super-liked tracks: ${sl.tracks} → genres: ${sl.genres.join(', ') || '(none)'}`);
  for (const a of sl.ambiguous) console.log(`    ambiguous ${a.id}: ${a.genres.join(' / ')}${includeAmbiguous ? ' (used)' : ' (not used)'}`);
  for (const u of sl.unmatched) console.log(`    no approved genre ${u.id}: ${u.genres.join(', ') || '(not in the catalog)'}`);
  if (!generate) continue;

  let em;
  try {
    em = await emphasesGenres(b, approved);
  } catch (e) {
    console.log(`  SKIPPED — emphases call failed: ${e.message}`);
    continue;
  }
  console.log(`  from the emphases: ${em.genres.join(', ') || (em.skipped ? `(${em.skipped})` : '(none)')}`);

  const requested = canonicalGenreList([...em.genres, ...sl.genres]);
  const nextApproved = approved.map((e) => ({ ...e }));
  const nextConditional = conditional.map((e) => ({ ...e }));
  const forced = forceRequestedIntoApproved(nextApproved, nextConditional, requested, N);
  const levelOf = new Map(nextApproved.map((e) => [e.genre, e.energy_level]));
  console.log(`  requested: ${requested.map((g) => `${g} (L${levelOf.get(g)})`).join(', ') || '(none)'}`);
  if (forced.length) console.log(`  newly approved: ${forced.join(', ')}`);
  if (!confirm) continue;

  const listed = new Set([...nextApproved, ...nextConditional].map((e) => e.genre));
  const patch = { requested_genres: requested, super_liked_genres: sl.genres, updated_at: new Date().toISOString() };
  if (forced.length) {
    patch.approved_genres = nextApproved;
    patch.conditional_genres = nextConditional;
    patch.excluded_genres = GENRES.filter((g) => !listed.has(g));
  }
  await pgrPatch('business_taste_profiles', { business_id: `eq.${b.id}` }, patch);
  written++;
  console.log('  written');
}

if (confirm) {
  console.log(`\nDone — ${written} written. Now rebuild the Option-1 libraries: node scripts/_v7-regenerate-energy-directions.mjs --confirm`);
}
