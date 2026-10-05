// Offline tests for normalizeTasteProfile (node --test scripts/test-taste-profile-normalize.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTasteProfile } from '../v7/generation/taste-profile.js';
import { GENRES } from '../shared/genre-universe.js';

const levels = (list) => Object.fromEntries(list.map((e) => [e.genre, e.energy_level]));
// Option 1's tier split (v7/generation/energy-directions.js tierOfLevel).
const lowTier = (p) => p.approved_genres.filter((e) => !(e.energy_level > p.energy_levels_total / 2));

test('no approved genre at level 1 → levels shift down so the calm tier is not empty', () => {
  const p = normalizeTasteProfile({
    energy_levels_total: 4,
    approved_genres: [{ genre: 'Neo Soul', energy_level: 3 }, { genre: 'Funk', energy_level: 4 }],
    conditional_genres: [{ genre: 'Bossa Nova', energy_level: 1, note_en: 'x' }],
  });
  assert.equal(p.energy_levels_total, 2);
  assert.deepEqual(levels(p.approved_genres), { 'Neo Soul': 1, Funk: 2 });
  assert.deepEqual(levels(p.conditional_genres), { 'Bossa Nova': 1 });
  assert.deepEqual(lowTier(p).map((e) => e.genre), ['Neo Soul']);
});

test('N never drops below 2', () => {
  const p = normalizeTasteProfile({
    energy_levels_total: 5,
    approved_genres: [{ genre: 'Rnb', energy_level: 4 }, { genre: 'Funk', energy_level: 5 }],
  });
  assert.equal(p.energy_levels_total, 2);
  assert.deepEqual(levels(p.approved_genres), { Rnb: 1, Funk: 2 });
});

test('approved genres all on one level are left as they are', () => {
  const p = normalizeTasteProfile({ energy_levels_total: 2, approved_genres: [{ genre: 'Rnb', energy_level: 2 }] });
  assert.equal(p.energy_levels_total, 2);
  assert.deepEqual(levels(p.approved_genres), { Rnb: 2 });
});

test('a profile that already starts at level 1 is unchanged', () => {
  const input = {
    energy_levels_total: 4,
    approved_genres: [{ genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Neo Soul', energy_level: 3 }, { genre: 'Hip Hop', energy_level: 4 }],
  };
  const p = normalizeTasteProfile(input);
  assert.equal(p.energy_levels_total, 4);
  assert.deepEqual(levels(p.approved_genres), { 'Bossa Nova': 1, 'Neo Soul': 3, 'Hip Hop': 4 });
});

test('requested genres: emphases + super-liked, all forced into approved', () => {
  const p = normalizeTasteProfile({
    energy_levels_total: 4,
    approved_genres: [{ genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Funk', energy_level: 4 }],
    conditional_genres: [{ genre: 'Rnb', energy_level: 3, note_en: 'x' }],
    requested_genres: ['rnb', 'Samba', 'Not A Genre'],
  }, { superLikedGenres: ['Funk', 'Neo Soul'] });
  assert.deepEqual(p.requested_genres, ['Rnb', 'Samba', 'Funk', 'Neo Soul']);
  // Rnb moved out of conditional with its level; Samba / Neo Soul (in neither
  // list) added at the middle of the scale; Funk was already approved.
  assert.deepEqual(levels(p.approved_genres), { 'Bossa Nova': 1, Funk: 4, Rnb: 3, Samba: 2, 'Neo Soul': 2 });
  assert.deepEqual(p.conditional_genres, []);
  assert.ok(!p.excluded_genres.includes('Samba'));
  assert.equal(p.excluded_genres.length, GENRES.length - 5);
});

test('no requested genres → an empty list', () => {
  const p = normalizeTasteProfile({ energy_levels_total: 2, approved_genres: [{ genre: 'Funk', energy_level: 1 }] });
  assert.deepEqual(p.requested_genres, []);
});

test('non-canonical names are dropped ("Motown"), canonical ones kept ("Mo Town")', () => {
  const p = normalizeTasteProfile({
    energy_levels_total: 2,
    approved_genres: [{ genre: 'Motown', energy_level: 1 }, { genre: 'mo town', energy_level: 1 }, { genre: 'Funk', energy_level: 2 }],
  });
  assert.deepEqual(p.approved_genres.map((e) => e.genre), ['Mo Town', 'Funk']);
  assert.equal(p.excluded_genres.length, GENRES.length - 2);
});
