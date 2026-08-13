#!/usr/bin/env node
// Unit-style test of the anchor-removal refactor.
//
// Verifies:
//   1. `directionKey` produces stable sorted-genres keys for new-shape input
//   2. `directionKey` returns the SAME key for equivalent new + legacy inputs
//      (backward-compat guarantee for reading pre-refactor persisted data)
//   3. `normalizeDirections`-equivalent logic:
//      - new-shape input keeps `d.genres`, strips anchor/secondary
//      - legacy-shape input folds to `d.genres`, strips anchor/secondary
//   4. `pickPreviewGenre` returns a genre from the direction's list; falls
//      back to legacy anchor+secondaries when `genres` is missing
//   5. `directionGenres` (preview.js helper) returns correct list for both shapes
//
// Note: musical-directions.js normalizeDirections + preview.js helpers can't
// be imported directly here (they use browser-absolute import paths), so
// the logic is duplicated here from source and tested. Keep in sync when
// the originals change.

import { directionKey } from '../v6/generation/playlist-length.js';

let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`);
    failed++;
  }
}
function eq(a, b, name) {
  ok(a === b, name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ---------- Test 1: directionKey with new-shape input ----------
console.log('\n=== directionKey — new shape ===');
{
  const d = {
    genres: ['Neo Soul', 'Acid Jazz', 'Downtempo'],
    bpm_range: { min: 85, max: 105 },
  };
  eq(directionKey(d), 'acid jazz|downtempo|neo soul|85-105',
    'new-shape genres sorted, lowercased, joined');
}

// ---------- Test 2: directionKey backward-compat ----------
console.log('\n=== directionKey — legacy vs new produce same key ===');
{
  const legacy = {
    anchor_genre: 'Neo Soul',
    secondary_genres: ['Acid Jazz', 'Downtempo'],
    bpm_range: { min: 85, max: 105 },
  };
  const modern = {
    genres: ['Neo Soul', 'Acid Jazz', 'Downtempo'],
    bpm_range: { min: 85, max: 105 },
  };
  eq(directionKey(legacy), directionKey(modern),
    'legacy [anchor, ...secondaries] → same key as flat genres');
  eq(directionKey(legacy), 'acid jazz|downtempo|neo soul|85-105',
    'legacy key matches expected sorted form');
}

// ---------- Test 3: directionKey ordering invariance ----------
console.log('\n=== directionKey — order-invariant ===');
{
  const a = { genres: ['Nu Disco', 'Deep House'],       bpm_range: { min: 115, max: 122 } };
  const b = { genres: ['Deep House', 'Nu Disco'],       bpm_range: { min: 115, max: 122 } };
  eq(directionKey(a), directionKey(b),
    'two directions with same genres in different order → same key');
}

// ---------- Test 4: directionKey missing BPM ----------
console.log('\n=== directionKey — defensive on missing fields ===');
{
  eq(directionKey({ genres: ['Rock'] }), 'rock|?-?', 'missing bpm → ?-?');
  eq(directionKey({}), '|?-?', 'empty direction → sensible key');
  eq(directionKey(null), '|?-?', 'null direction → sensible key');
}

// ---------- normalizeDirections logic (duplicated from musical-directions.js) ----------
function normalizeDirectionsLogic(parsed, rankStart) {
  if (!Array.isArray(parsed?.directions)) return [];
  const valid = parsed.directions.filter(validateDirectionLogic);
  valid.sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999));
  valid.forEach((d, idx) => {
    d.rank = rankStart + idx;
    if (!Array.isArray(d.genres) || !d.genres.length) {
      d.genres = [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])]
        .filter((g) => typeof g === 'string' && g.length);
    }
    delete d.anchor_genre;
    delete d.secondary_genres;
  });
  return valid;
}
function validateDirectionLogic(d) {
  if (!d) return false;
  if (typeof d.title_en !== 'string' || !d.title_en.length) return false;
  if (typeof d.description_he !== 'string' || !d.description_he.length) return false;
  if (!validateBpm(d.bpm_range)) return false;
  const hasNew = Array.isArray(d.genres) && d.genres.length
    && d.genres.every((g) => typeof g === 'string' && g.length);
  const hasLegacy = typeof d.anchor_genre === 'string' && d.anchor_genre.length;
  return hasNew || hasLegacy;
}
function validateBpm(bpm) {
  return bpm && typeof bpm === 'object'
    && Number.isFinite(bpm.min) && Number.isFinite(bpm.max)
    && bpm.min <= bpm.max;
}

// ---------- Test 5: normalizeDirections — new-shape input ----------
console.log('\n=== normalizeDirections — new shape ===');
{
  const raw = { directions: [
    { rank: 1, title_en: 'A', description_he: 'תיאור', genres: ['Rock', 'Blues'], bpm_range: { min: 90, max: 110 } },
  ] };
  const out = normalizeDirectionsLogic(raw, 1);
  eq(out.length, 1, 'one valid direction returned');
  eq(Array.isArray(out[0].genres), true, 'genres array present');
  eq(out[0].genres.join(','), 'Rock,Blues', 'genres preserved in order');
  eq(out[0].anchor_genre, undefined, 'anchor_genre stripped');
  eq(out[0].secondary_genres, undefined, 'secondary_genres stripped');
}

// ---------- Test 6: normalizeDirections — legacy-shape input (model regression) ----------
console.log('\n=== normalizeDirections — legacy shape (model regression) ===');
{
  const raw = { directions: [
    {
      rank: 1, title_en: 'B', description_he: 'תיאור',
      anchor_genre: 'French Jazz',
      secondary_genres: ['Bossa Nova', 'LoFi Bossa'],
      bpm_range: { min: 70, max: 95 },
    },
  ] };
  const out = normalizeDirectionsLogic(raw, 1);
  eq(out.length, 1, 'one valid direction returned');
  eq(out[0].genres.join(','), 'French Jazz,Bossa Nova,LoFi Bossa',
    'legacy folded into genres (anchor first, then secondaries)');
  eq(out[0].anchor_genre, undefined, 'anchor_genre stripped');
  eq(out[0].secondary_genres, undefined, 'secondary_genres stripped');
}

// ---------- Test 7: validateDirection ----------
console.log('\n=== validateDirection — both shapes ===');
{
  ok(validateDirectionLogic({
    title_en: 'X', description_he: 'y', genres: ['Rock'], bpm_range: { min: 90, max: 100 },
  }), 'new shape accepted');
  ok(validateDirectionLogic({
    title_en: 'X', description_he: 'y',
    anchor_genre: 'Rock', secondary_genres: [], bpm_range: { min: 90, max: 100 },
  }), 'legacy shape accepted');
  ok(!validateDirectionLogic({
    title_en: 'X', description_he: 'y', bpm_range: { min: 90, max: 100 },
  }), 'no genres and no anchor → rejected');
  ok(!validateDirectionLogic({
    title_en: '', description_he: 'y', genres: ['Rock'], bpm_range: { min: 90, max: 100 },
  }), 'empty title → rejected');
  ok(!validateDirectionLogic({
    title_en: 'X', description_he: 'y', genres: ['Rock'], bpm_range: { min: 100, max: 90 },
  }), 'invalid bpm (min>max) → rejected');
}

// ---------- preview.js helpers (duplicated) ----------
function directionGenresLogic(d) {
  if (Array.isArray(d.genres) && d.genres.length) return d.genres;
  return [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])]
    .filter((g) => typeof g === 'string' && g.length);
}
function pickPreviewGenreLogic(d) {
  const list = directionGenresLogic(d);
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

// ---------- Test 8: directionGenres ----------
console.log('\n=== directionGenres (preview.js helper) ===');
{
  const modern = { genres: ['Rock', 'Blues'] };
  const legacy = { anchor_genre: 'Rock', secondary_genres: ['Blues'] };
  const empty  = {};
  eq(directionGenresLogic(modern).join(','), 'Rock,Blues', 'new shape');
  eq(directionGenresLogic(legacy).join(','), 'Rock,Blues', 'legacy shape folded');
  eq(directionGenresLogic(empty).length, 0, 'empty direction → empty list');
}

// ---------- Test 9: pickPreviewGenre randomness ----------
console.log('\n=== pickPreviewGenre — random picks over N iterations ===');
{
  const d = { genres: ['Rock', 'Blues', 'Jazz (Standards)', 'Folk', 'Country'] };
  const N = 500;
  const counts = {};
  for (let i = 0; i < N; i++) {
    const g = pickPreviewGenreLogic(d);
    counts[g] = (counts[g] || 0) + 1;
  }
  const keys = Object.keys(counts).sort();
  ok(keys.length === d.genres.length,
    `all ${d.genres.length} genres eventually picked in ${N} draws`,
    `only saw ${keys.length}: ${keys.join(', ')}`);
  const min = Math.min(...Object.values(counts));
  const max = Math.max(...Object.values(counts));
  const expected = N / d.genres.length;
  ok(min >= expected * 0.5 && max <= expected * 1.5,
    `each genre picked within ~50% of uniform expectation (~${Math.round(expected)}), got min=${min}, max=${max}`);
  eq(pickPreviewGenreLogic({}), null, 'empty direction → null');
}

// ---------- summary ----------
console.log(`\n=== summary ===`);
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
