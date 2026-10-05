// Offline tests for Option 1's daily draw + requested genres
// (node --test scripts/test-option1-draw.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTierPair, requestedByTier, withRequested } from '../v7/generation/option1-draw.js';
import { normalizeEnergyDirections } from '../v7/generation/energy-directions.js';

const dir = (title, genres) => ({ title_en: title, genres });
// rng that returns the given values in turn.
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('the second direction is the one with the fewest genres in common with the first', () => {
  const pool = [
    dir('A', ['Funk', 'Disco', 'Afro Funk']),
    dir('B', ['Funk', 'Disco', 'Latin Funk']),   // shares 2 with A
    dir('C', ['Samba', 'Cha Cha Cha']),          // shares 0 with A
  ];
  for (let i = 0; i < 20; i++) {
    const [a, b] = pickTierPair(pool, seq(0, Math.random()));   // first = A
    assert.equal(a.title_en, 'A');
    assert.equal(b.title_en, 'C');
  }
});

test('genres every direction shares (requested ones) do not count as similarity', () => {
  const pool = [
    dir('A', ['Rnb', 'Funk', 'Disco']),
    dir('B', ['Rnb', 'Funk', 'Afro Funk']),      // shares Funk with A
    dir('C', ['Rnb', 'Samba', 'Cha Cha Cha']),   // shares nothing but Rnb
  ];
  const [, b] = pickTierPair(pool, seq(0, 0));
  assert.equal(b.title_en, 'C');
});

test('ties are broken at random, and the first pick varies', () => {
  const pool = [dir('A', ['Funk']), dir('B', ['Disco']), dir('C', ['Samba'])];
  assert.equal(pickTierPair(pool, seq(0, 0))[1].title_en, 'B');
  assert.equal(pickTierPair(pool, seq(0, 0.99))[1].title_en, 'C');
  assert.equal(pickTierPair(pool, seq(0.99, 0))[0].title_en, 'C');
});

test('a pool of 1 fills both playlists; an empty pool gives none', () => {
  const only = dir('A', ['Funk']);
  assert.deepEqual(pickTierPair([only]), [only, only]);
  assert.deepEqual(pickTierPair([]), []);
});

test('requested genres split by the tier of their approved level; unapproved ones skipped', () => {
  const approved = [
    { genre: 'Rnb', energy_level: 3 }, { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Funk', energy_level: 4 },
  ];
  assert.deepEqual(requestedByTier(['rnb', 'Bossa Nova', 'Samba'], approved, 4), { high: ['Rnb'], low: ['Bossa Nova'] });
  assert.deepEqual(requestedByTier(undefined, approved, 4), { high: [], low: [] });
});

test('withRequested adds only the missing requested genres', () => {
  assert.deepEqual(withRequested(['Funk', 'Rnb'], ['rnb', 'Neo Soul']), ['Funk', 'Rnb', 'Neo Soul']);
  assert.deepEqual(withRequested(['Funk'], []), ['Funk']);
});

test('the directions normalizer puts every requested genre in every direction of its tier', () => {
  const approved = [
    { genre: 'Rnb', energy_level: 4 }, { genre: 'Funk', energy_level: 4 }, { genre: 'Disco', energy_level: 3 },
    { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Fado', energy_level: 2 },
  ];
  const out = normalizeEnergyDirections({
    directions: [
      { energy_tier: 'high', title_en: 'h1', genres: ['Funk', 'Disco'] },
      { energy_tier: 'high', title_en: 'h2', genres: ['Rnb', 'Funk'] },
      { energy_tier: 'low', title_en: 'l1', genres: ['Bossa Nova', 'Fado'] },
    ],
  }, approved, 4, ['Rnb']);
  const byTitle = Object.fromEntries(out.directions.map((d) => [d.title_en, d.genres]));
  assert.deepEqual(byTitle.h1, ['Funk', 'Disco', 'Rnb']);
  assert.deepEqual(byTitle.h2, ['Rnb', 'Funk']);
  assert.deepEqual(byTitle.l1, ['Bossa Nova', 'Fado']);   // Rnb is high — the low tier is untouched
});
