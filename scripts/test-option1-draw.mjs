// Offline tests for Option 1's daily draw + requested genres
// (node --test scripts/test-option1-draw.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTierPair, requestedByTier } from '../v7/generation/option1-draw.js';
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

test('a genre every direction of the pool shares does not count as similarity', () => {
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

// ---- requested genres: heard at least once a day (2026-10-26) ----

const plays = (pair, genre) => pair.some((d) => d.genres.includes(genre));

test('the day\'s pair always includes a direction that plays the requested genre', () => {
  const pool = [
    dir('A', ['Funk', 'Disco']),
    dir('B', ['Samba', 'Cha Cha Cha']),
    dir('C', ['Rnb', 'Neo Soul']),        // the only one with Rnb
    dir('D', ['Afro Funk', 'Highlife']),
  ];
  for (let i = 0; i < 40; i++) {
    const pair = pickTierPair(pool, Math.random, { requested: ['Rnb'], day: i });
    assert.ok(plays(pair, 'Rnb'), `draw ${i} left Rnb out: ${pair.map((d) => d.title_en)}`);
    assert.notEqual(pair[0], pair[1]);
  }
});

test('two requested genres in different directions are both played', () => {
  const pool = [
    dir('A', ['Funk', 'Disco']),
    dir('B', ['Deep House', 'Soulful House']),   // Deep House
    dir('C', ['Italo Disco', 'Nu Disco']),       // Italo Disco
    dir('D', ['Samba']),
  ];
  for (let i = 0; i < 30; i++) {
    const pair = pickTierPair(pool, Math.random, { requested: ['Deep House', 'Italo Disco'], day: i });
    assert.ok(plays(pair, 'Deep House') && plays(pair, 'Italo Disco'), pair.map((d) => d.title_en).join('+'));
  }
});

test('more requested genres than two directions can carry: the most are played, and they rotate', () => {
  const pool = [dir('A', ['Funk']), dir('B', ['Disco']), dir('C', ['Samba']), dir('D', ['Bolero'])];
  const requested = ['Funk', 'Disco', 'Samba'];
  const seen = new Set();
  for (let day = 0; day < 9; day++) {
    const pair = pickTierPair(pool, Math.random, { requested, day });
    const played = requested.filter((g) => plays(pair, g));
    assert.equal(played.length, 2, `day ${day} played ${played.length}`);   // two directions, one genre each
    played.forEach((g) => seen.add(g));
  }
  assert.deepEqual([...seen].sort(), [...requested].sort());   // each one gets its turn
});

test('a requested genre no direction plays is simply ignored', () => {
  const pool = [dir('A', ['Funk', 'Disco']), dir('B', ['Samba'])];
  const pair = pickTierPair(pool, seq(0, 0), { requested: ['Rnb'], day: 0 });
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0], pair[1]);
});

test('the directions normalizer leaves requested genres where the model put them', () => {
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
  assert.deepEqual(byTitle.h1, ['Funk', 'Disco']);      // not stapled on any more
  assert.deepEqual(byTitle.h2, ['Rnb', 'Funk']);
  assert.deepEqual(byTitle.l1, ['Bossa Nova', 'Fado']);
});

test('a requested genre no direction plays gets one of its own', () => {
  const approved = [
    { genre: 'Rnb', energy_level: 4 }, { genre: 'Funk', energy_level: 4 }, { genre: 'Bossa Nova', energy_level: 1 },
  ];
  const out = normalizeEnergyDirections({
    directions: [
      { energy_tier: 'high', title_en: 'h1', genres: ['Funk'] },
      { energy_tier: 'low', title_en: 'l1', genres: ['Bossa Nova'] },
    ],
  }, approved, 4, ['Rnb']);
  const own = out.directions.find((d) => d.genres.includes('Rnb'));
  assert.ok(own, 'Rnb got no direction');
  assert.equal(own.energy_tier, 'high');
  assert.deepEqual(own.genres, ['Rnb']);
  assert.equal(out.directions.find((d) => d.title_en === 'h1').genres.length, 1);
});
