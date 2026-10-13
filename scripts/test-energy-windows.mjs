// Offline tests for the v7 daily-playlist energy windows
// (v7/generation/energy-windows.js). No network, no env.
// Run: node --test scripts/test-energy-windows.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTION1_ENERGY_WINDOWS, LEVEL_ENERGY_WINDOWS, ENERGY_WIDEN_STEP, option1EnergyWindow, levelEnergyWindow,
} from '../v7/generation/energy-windows.js';

test('Option 1: high 50–80, low 20–50', () => {
  assert.deepEqual(option1EnergyWindow('high'), { min: 50, max: 80 });
  assert.deepEqual(option1EnergyWindow('low'), { min: 20, max: 50 });
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
