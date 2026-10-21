// Offline tests for the v7 daily-playlist energy windows
// (v7/generation/energy-windows.js). No network, no env.
// Run: node --test scripts/test-energy-windows.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTION1_ENERGY_WINDOWS, LEVEL_ENERGY_WINDOWS, ENERGY_WIDEN_STEP, option1EnergyWindow, levelEnergyWindow,
  nudgeOptions, mergeAtRandom,
} from '../v7/generation/energy-windows.js';

test('Option 1: high 50–80, low 30–60', () => {
  assert.deepEqual(option1EnergyWindow('high'), { min: 50, max: 80 });
  assert.deepEqual(option1EnergyWindow('low'), { min: 30, max: 60 });
  assert.equal(option1EnergyWindow('middle'), null);
  const w = option1EnergyWindow('high');
  w.min = 0;
  assert.equal(OPTION1_ENERGY_WINDOWS.high.min, 50, 'callers get a copy');
});

test('Option 2: 20–80 in N ranges, neighbours overlapping by 20, near-equal widths', () => {
  for (const N of [2, 3, 4, 5, 6]) {
    const rows = LEVEL_ENERGY_WINDOWS[N];
    assert.equal(rows.length, N);
    assert.equal(rows[0][0], 20);
    assert.equal(rows[N - 1][1], 80);
    for (let i = 1; i < N; i++) {
      assert.equal(rows[i - 1][1] - rows[i][0], 20, `N=${N}: levels ${i} and ${i + 1} overlap by 20`);
      assert.ok(rows[i][0] > rows[i - 1][0], `N=${N}: ranges go up`);
    }
    const widths = rows.map(([lo, hi]) => hi - lo);
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `N=${N}: widths ${widths}`);
  }
  assert.deepEqual(LEVEL_ENERGY_WINDOWS[4], [[20, 50], [30, 60], [40, 70], [50, 80]], "Ami's 4 levels");
});

test('levelEnergyWindow reads levels the way the builder does', () => {
  assert.deepEqual(levelEnergyWindow(1, 4), { min: 20, max: 50 });
  assert.deepEqual(levelEnergyWindow(4, 4), { min: 50, max: 80 });
  assert.deepEqual(levelEnergyWindow(3, 3), { min: 47, max: 80 });
  assert.deepEqual(levelEnergyWindow(9, 2), { min: 40, max: 80 }, 'level clamped to N');
  assert.deepEqual(levelEnergyWindow(0, 5), { min: 20, max: 48 }, 'level clamped to 1');
  assert.deepEqual(levelEnergyWindow(2, 'x'), levelEnergyWindow(2, 4), 'bad N → the default scale');
  assert.equal(ENERGY_WIDEN_STEP, 5);
});

// "Today only" energy for one Option 1 playlist (2026-10-21).
test('nudge: the usual window in the middle, one step either way', () => {
  assert.deepEqual(nudgeOptions({ min: 50, max: 80 }), { windows: [[40, 70], [50, 80], [60, 90]], usualIndex: 1 });
  assert.deepEqual(nudgeOptions([30, 60]), { windows: [[20, 50], [30, 60], [40, 70]], usualIndex: 1 });
  assert.deepEqual(nudgeOptions([10, 40]), { windows: [[0, 30], [10, 40], [20, 50]], usualIndex: 1 });
});

test('nudge: a usual window at an end of the scale sits at that end, two steps the other way', () => {
  assert.deepEqual(nudgeOptions([70, 100]), { windows: [[50, 80], [60, 90], [70, 100]], usualIndex: 2 });
  assert.deepEqual(nudgeOptions([65, 95]), { windows: [[45, 75], [55, 85], [65, 95]], usualIndex: 2 });
  assert.deepEqual(nudgeOptions([0, 30]), { windows: [[0, 30], [10, 40], [20, 50]], usualIndex: 0 });
  assert.deepEqual(nudgeOptions([5, 35]), { windows: [[5, 35], [15, 45], [25, 55]], usualIndex: 0 });
  for (const lo of [0, 5, 10, 35, 60, 65, 70]) {
    for (const [a, b] of nudgeOptions([lo, lo + 30]).windows) assert.ok(a >= 0 && b <= 100, `${lo}: ${a}–${b}`);
  }
});

test('nudge: kept songs stay in order, new ones are all added', () => {
  let i = 0;
  const seq = [0, 0.99, 0.5];
  const out = mergeAtRandom(['a', 'b', 'c'], ['x', 'y', 'z'], () => seq[i++ % 3]);
  assert.equal(out.length, 6);
  assert.deepEqual(out.filter((s) => 'abc'.includes(s)), ['a', 'b', 'c']);
  assert.deepEqual([...out].sort(), ['a', 'b', 'c', 'x', 'y', 'z']);
  assert.deepEqual(mergeAtRandom([], ['x']), ['x']);
  assert.deepEqual(mergeAtRandom(['a'], []), ['a']);
});
