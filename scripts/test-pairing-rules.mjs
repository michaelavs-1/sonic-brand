// Offline tests for the isolation rules code enforces on daily-playlist
// recipes (node --test scripts/test-pairing-rules.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRecipe, enforceIsolation } from '../v7/generation/pairing-rules.js';
import { normalizeEnergyDirections } from '../v7/generation/energy-directions.js';
import { normalizeLevelDirections } from '../v7/generation/level-directions.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const rec = (title_en, genres) => ({ title_en, genres });

test('LoFi with something else: the larger side stays', () => {
  assert.deepEqual(splitRecipe(['LoFi Bossa', 'Bossa Nova', 'LoFi Beats']),
    { keep: ['LoFi Bossa', 'LoFi Beats'], out: [{ genres: ['Bossa Nova'], why: 'LoFi only with LoFi' }] });
  assert.deepEqual(splitRecipe(['Jazz (Standards)', 'Late Night jazz', 'LoFi Bossa']).keep, ['Jazz (Standards)', 'Late Night jazz']);
});

test('a tie: the DownTempo / LoFi family leaves', () => {
  assert.deepEqual(splitRecipe(['DownTempo', 'Deep House']).keep, ['Deep House']);
});

test('DownTempo and LoFi never share a recipe', () => {
  const { keep, out } = splitRecipe(['DownTempo', 'French DownTempo', 'LoFi Beats']);
  assert.deepEqual(keep, ['DownTempo', 'French DownTempo']);
  assert.deepEqual(out[0].genres, ['LoFi Beats']);
});

test('Electronic R&B: fine with its partners, taken out with anything else', () => {
  assert.deepEqual(splitRecipe(['Electronic R&B', 'Nu Disco', 'Indie Dance', 'Deep House']).out, []);
  const { keep, out } = splitRecipe(['French Touch', 'Nu Disco', 'Indie Dance', 'Electronic R&B', 'IndieTronica']);
  assert.deepEqual(keep, ['French Touch', 'Nu Disco', 'Indie Dance', 'IndieTronica']);
  assert.deepEqual(out[0].genres, ['Electronic R&B']);
});

test('exempt (requested) genres never count', () => {
  assert.deepEqual(splitRecipe(['בלדות ישראליות', 'LoFi Beats', 'LoFi Bossa'], ['בלדות ישראליות']).out, []);
  assert.deepEqual(splitRecipe(['LoFi Beats', 'Jazz (Standards)'], ['LoFi Beats']).out, []);
});

test('pop is not enforced in code', () => {
  assert.deepEqual(splitRecipe(['Soft Pop Hits', 'Folk', 'Indie Folk']).out, []);
});

test('a genre taken out gets its own recipe only when no other recipe plays it', () => {
  const res = enforceIsolation([
    rec('Lo-Fi Brazil', ['LoFi Bossa', 'Bossa Nova', 'LoFi Beats']),
    rec('Bossa Café', ['Bossa Nova', 'Samba-Choro']),
    rec('Jazz & LoFi', ['Jazz (Standards)', 'Late Night jazz', 'Desi LoFi']),
  ]);
  assert.deepEqual(res.recipes.map((r) => r.genres), [
    ['LoFi Bossa', 'LoFi Beats'], ['Bossa Nova', 'Samba-Choro'], ['Jazz (Standards)', 'Late Night jazz'],
  ]);
  assert.deepEqual(res.added.map((r) => r.genres), [['Desi LoFi']]);   // Bossa Nova still has "Bossa Café"
});

test('a taken-out group that breaks a rule itself is split again', () => {
  const res = enforceIsolation([rec('Mixed', ['DownTempo', 'Electronic R&B', 'Rnb'])]);
  assert.deepEqual(res.recipes[0].genres, ['Rnb']);
  assert.deepEqual(res.added.map((r) => r.genres).sort(), [['DownTempo'], ['Electronic R&B']].sort());
});

test('Option 1 normalizer: fixes per tier; a requested genre no recipe plays gets its own', () => {
  const approved = [
    { genre: 'בלדות ישראליות', energy_level: 1 }, { genre: 'LoFi Bossa', energy_level: 1 }, { genre: 'Bossa Nova', energy_level: 1 },
    { genre: 'LoFi Beats', energy_level: 2 }, { genre: 'Jazz (Standards)', energy_level: 2 }, { genre: 'Late Night jazz', energy_level: 2 },
    { genre: 'Electronic R&B', energy_level: 4 }, { genre: 'French Touch', energy_level: 4 }, { genre: 'Nu Disco', energy_level: 3 },
  ];
  const parsed = { directions: [
    { energy_tier: 'low', title_en: 'A', genres: ['LoFi Bossa', 'Bossa Nova', 'LoFi Beats'] },
    { energy_tier: 'low', title_en: 'B', genres: ['Jazz (Standards)', 'Late Night jazz', 'LoFi Bossa'] },
    { energy_tier: 'high', title_en: 'C', genres: ['French Touch', 'Nu Disco', 'Electronic R&B'] },
  ] };
  const out = quiet(() => normalizeEnergyDirections(parsed, approved, 4, ['בלדות ישראליות'])).directions;
  const sets = out.map((d) => `${d.energy_tier}: ${[...d.genres].sort().join(', ')}`).sort();
  assert.deepEqual(sets, [
    'high: Electronic R&B',
    'high: French Touch, Nu Disco',
    'low: Bossa Nova',
    'low: Jazz (Standards), Late Night jazz',
    'low: LoFi Beats, LoFi Bossa',
    'low: בלדות ישראליות',           // requested, and no recipe played it
  ]);
});

test('Option 2 normalizer: fixes per level', () => {
  const approved = [
    { genre: 'DownTempo', energy_level: 1 }, { genre: 'Organic House', energy_level: 1 }, { genre: 'Bossa Nova', energy_level: 1 },
  ];
  const parsed = { directions: [{ energy_level: 1, title_en: 'A', genres: ['DownTempo', 'Organic House', 'Bossa Nova'] }] };
  const out = quiet(() => normalizeLevelDirections(parsed, approved, 2)).directions;
  assert.deepEqual(out.map((d) => d.genres), [['Organic House', 'Bossa Nova'], ['DownTempo']]);
});

// ---- taste chat / admin console edits (taste-ops.js) ----
import { stateFromRows, applyOps } from '../v7/generation/taste-ops.js';

const option1State = (requested = []) => stateFromRows({
  mode: 'option1',
  profile: {
    energy_levels_total: 4,
    approved_genres: [
      { genre: 'LoFi Beats', energy_level: 1 }, { genre: 'LoFi Bossa', energy_level: 1 }, { genre: 'Bossa Nova', energy_level: 1 },
      { genre: 'Jazz (Standards)', energy_level: 2 }, { genre: 'בלדות ישראליות', energy_level: 2 },
      { genre: 'Electronic R&B', energy_level: 4 }, { genre: 'Deep House', energy_level: 4 }, { genre: 'Rnb', energy_level: 3 },
    ],
    requested_genres: requested,
  },
  option1Rows: [
    { energy_tier: 'low', rank: 1, title_en: 'Lo-Fi', genres: ['LoFi Beats', 'LoFi Bossa'] },
    { energy_tier: 'low', rank: 2, title_en: 'Bossa & Jazz', genres: ['Bossa Nova', 'Jazz (Standards)'] },
    { energy_tier: 'high', rank: 1, title_en: 'Club', genres: ['Electronic R&B', 'Deep House'] },
    { energy_tier: 'high', rank: 2, title_en: 'R&B', genres: ['Rnb'] },
  ],
});

test('taste ops: dir_add that breaks a rule is refused with the rule as the reason', () => {
  const r = applyOps(option1State(), [{ op: 'dir_add', dir: 'C1', genre: 'Bossa Nova' }, { op: 'dir_add', dir: 'H1', genre: 'Rnb' }]);
  assert.equal(r.applied.length, 0);
  assert.deepEqual(r.dropped.map((d) => d.reason), [
    'would break a pairing rule (LoFi only with LoFi)',
    'would break a pairing rule (Electronic R&B only with house / Nu Disco / Indie Dance)',
  ]);
  assert.equal(r.changed, false);
});

test('taste ops: dir_add that keeps the rules still works', () => {
  const r = applyOps(option1State(), [{ op: 'dir_add', dir: 'C2', genre: 'בלדות ישראליות' }]);
  assert.equal(r.applied.length, 1);
  assert.deepEqual(r.state.option1Dirs.find((d) => d.key === 'C2').genres, ['Bossa Nova', 'Jazz (Standards)', 'בלדות ישראליות']);
});

test('taste ops: a requested genre is not exempt from the rules (2026-10-26)', () => {
  const r = applyOps(option1State(['Bossa Nova']), [{ op: 'dir_add', dir: 'C1', genre: 'Bossa Nova' }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.dropped[0].reason, /LoFi only with LoFi/);
});

test('taste ops: dir_new that breaks a rule is refused', () => {
  const r = applyOps(option1State(), [{ op: 'dir_new', tier: 'low', genres: ['LoFi Beats', 'Jazz (Standards)'], title_en: 'x' }]);
  assert.match(r.dropped[0].reason, /LoFi only with LoFi/);
});

test('taste ops: the automatic "all genres" recipe is split by the rules', () => {
  // Deleting both calm recipes makes finalize build one from every calm genre.
  const r = applyOps(option1State(), [{ op: 'dir_delete', dir: 'C1' }, { op: 'dir_delete', dir: 'C2' }]);
  const low = r.state.option1Dirs.filter((d) => d.energy_tier === 'low').map((d) => [...d.genres].sort().join(', ')).sort();
  assert.deepEqual(low, ['Bossa Nova, Jazz (Standards), בלדות ישראליות', 'LoFi Beats, LoFi Bossa']);
});
