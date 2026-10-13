// Offline tests for the admin console's daily picks
// (node --test scripts/test-daily-picks.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlot, applyOption1Picks, applyOption2Picks, keepAllowed } from '../v7/generation/daily-picks.js';
import { pickTierPair, leastAlike } from '../v7/generation/option1-draw.js';

const dir = (title, genres) => ({ id: title, title_en: title, genres });
const allowedOf = (...gs) => new Map(gs.map((g) => [g.toLowerCase(), g]));
const pick = (slot, genres, title = 'Picked') => ({ slot, genres, title_en: title, source_direction_id: 'src-1', energy_range: null });

test('slots parse, junk does not', () => {
  assert.deepEqual(parseSlot('high-1'), { mode: 'option1', tier: 'high', n: 1, slot: 'high-1' });
  assert.deepEqual(parseSlot('LOW-2'), { mode: 'option1', tier: 'low', n: 2, slot: 'low-2' });
  assert.deepEqual(parseSlot('mix-2:L3'), { mode: 'option2', mix: 2, level: 3, slot: 'mix-2:L3' });
  assert.deepEqual(parseSlot('mix-1:l6'), { mode: 'option2', mix: 1, level: 6, slot: 'mix-1:L6' });
  for (const bad of ['high-3', 'mid-1', 'mix-3:L1', 'mix-1:L7', 'mix-1', '', null]) assert.equal(parseSlot(bad), null);
});

test('keepAllowed keeps canonical names of allowed genres only, once each', () => {
  assert.deepEqual(keepAllowed(['funk', 'Samba', 'FUNK', 'Klezmer'], allowedOf('Funk', 'Samba')), ['Funk', 'Samba']);
});

test('no picks → the usual draw stands', () => {
  const pool = [dir('A', ['Funk']), dir('B', ['Disco'])];
  const pair = pickTierPair(pool);
  assert.equal(applyOption1Picks('high', pair, pool, [], allowedOf('Funk', 'Disco')), pair);
});

test('both slots picked → both picks, marked admin_pick', () => {
  const pool = [dir('A', ['Funk']), dir('B', ['Disco']), dir('C', ['Samba'])];
  const out = applyOption1Picks('high', pickTierPair(pool), pool,
    [pick('high-1', ['Samba'], 'P1'), pick('high-2', ['Funk'], 'P2')], allowedOf('Funk', 'Disco', 'Samba'));
  assert.deepEqual(out.map((d) => d.title_en), ['P1', 'P2']);
  assert.ok(out.every((d) => d.admin_pick));
  assert.equal(out[0].id, 'src-1');
});

test('one slot picked → the other is the pool direction least like it', () => {
  const pool = [dir('A', ['Funk', 'Disco']), dir('B', ['Funk', 'Afro Funk']), dir('C', ['Samba'])];
  const allowed = allowedOf('Funk', 'Disco', 'Afro Funk', 'Samba');
  const one = applyOption1Picks('high', pickTierPair(pool), pool, [pick('high-1', ['Funk', 'Disco'])], allowed);
  assert.equal(one[0].title_en, 'Picked');
  assert.equal(one[1].title_en, 'C');
  const two = applyOption1Picks('high', pickTierPair(pool), pool, [pick('high-2', ['Samba'])], allowed);
  assert.equal(two[1].title_en, 'Picked');
  assert.notEqual(two[0].title_en, 'C');   // C has the same genres as the pick
});

test('picks of the other tier are ignored', () => {
  const pool = [dir('A', ['Funk']), dir('B', ['Disco'])];
  const pair = pickTierPair(pool);
  assert.equal(applyOption1Picks('high', pair, pool, [pick('low-1', ['Funk'])], allowedOf('Funk', 'Disco')), pair);
});

test('genres no longer allowed are dropped; a pick left empty is ignored', () => {
  const pool = [dir('A', ['Funk']), dir('B', ['Disco'])];
  const allowed = allowedOf('Funk', 'Disco');
  const out = applyOption1Picks('low', pickTierPair(pool), pool, [pick('low-1', ['Funk', 'Klezmer'])], allowed);
  assert.deepEqual(out[0].genres, ['Funk']);
  const pair = pickTierPair(pool);
  assert.equal(applyOption1Picks('low', pair, pool, [pick('low-1', ['Klezmer'])], allowed), pair);
});

test('a tier with no library still plays its pick in both slots', () => {
  const out = applyOption1Picks('high', [], [], [pick('high-2', ['Funk'])], allowedOf('Funk'));
  assert.equal(out.length, 2);
  assert.ok(out.every((d) => d.title_en === 'Picked'));
});

test('leastAlike never returns the same genre set, falls back to the direction itself', () => {
  const p = dir('P', ['Funk']);
  assert.equal(leastAlike([dir('A', ['Funk'])], p), p);
  assert.equal(leastAlike([], p), p);
});

test('Option 2: a pick replaces that mix + level only, filtered to the level', () => {
  const day = [
    new Map([[1, dir('L1-a', ['Bossa Nova'])], [3, dir('L3-a', ['Funk'])]]),
    new Map([[1, dir('L1-b', ['Jazz (Standards)'])], [3, dir('L3-b', ['Disco'])]]),
  ];
  const byLevel = new Map([[1, ['Bossa Nova', 'Jazz (Standards)']], [3, ['Funk', 'Disco', 'Samba']]]);
  const out = applyOption2Picks(day, [pick('mix-2:L3', ['Samba', 'Bossa Nova'])], byLevel);
  assert.equal(out[0].get(3).title_en, 'L3-a');
  assert.equal(out[1].get(1).title_en, 'L1-b');
  assert.deepEqual(out[1].get(3).genres, ['Samba']);
  assert.ok(out[1].get(3).admin_pick);
  assert.equal(day[1].get(3).title_en, 'L3-b');   // input untouched
});

test('Option 2: picks of Option 1 slots, unknown mixes and empty picks are ignored', () => {
  const day = [new Map([[2, dir('x', ['Funk'])]]), new Map([[2, dir('y', ['Disco'])]])];
  const byLevel = new Map([[2, ['Funk', 'Disco']]]);
  const out = applyOption2Picks(day, [pick('high-1', ['Funk']), pick('mix-1:L2', ['Klezmer'])], byLevel);
  assert.equal(out[0].get(2).title_en, 'x');
  assert.equal(out[1].get(2).title_en, 'y');
  assert.equal(applyOption2Picks(null, [pick('mix-1:L2', ['Funk'])], byLevel), null);
});

test('Option 2: an unpicked mix that lands on the picked genres moves to the next different direction', () => {
  const a = dir('L3-a', ['Funk']);
  const b = dir('L3-b', ['Acid Jazz']);
  const c = dir('L3-c', ['Disco']);
  const lib = new Map([[3, [a, b, c]]]);
  const byLevel = new Map([[3, ['Funk', 'Acid Jazz', 'Disco']]]);
  // rotation: mix 1 = a, mix 2 = b; the admin picks b's genres for mix 1
  const day = [new Map([[3, a]]), new Map([[3, b]])];
  const out = applyOption2Picks(day, [pick('mix-1:L3', ['Acid Jazz'])], byLevel, lib);
  assert.deepEqual(out[0].get(3).genres, ['Acid Jazz']);
  assert.equal(out[1].get(3).title_en, 'L3-c');
  // both mixes picked → both kept, even if equal
  const both = applyOption2Picks(day, [pick('mix-1:L3', ['Funk']), pick('mix-2:L3', ['Funk'])], byLevel, lib);
  assert.deepEqual([both[0].get(3).genres, both[1].get(3).genres], [['Funk'], ['Funk']]);
  // a level with a single direction: nothing to move to
  const one = applyOption2Picks([new Map([[3, a]]), new Map([[3, a]])], [pick('mix-1:L3', ['Funk'])], byLevel, new Map([[3, [a]]]));
  assert.equal(one[1].get(3).title_en, 'L3-a');
});
