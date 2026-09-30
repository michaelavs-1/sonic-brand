// Offline tests for shared/opening-hours.js (node --test scripts/test-opening-hours.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayHoursProblem, hoursProblems, hoursProblem } from '../shared/opening-hours.js';

test('same-day hours are valid', () => {
  assert.equal(dayHoursProblem('10:00', '22:00'), null);
  assert.equal(dayHoursProblem('14:00', '15:00'), null);
  assert.equal(dayHoursProblem('06:00', '23:59'), null);
});

test('closing after midnight is valid up to 06:00', () => {
  assert.equal(dayHoursProblem('20:00', '02:00'), null);
  assert.equal(dayHoursProblem('18:00', '00:00'), null);
  assert.equal(dayHoursProblem('22:00', '06:00'), null);
});

test('closing before opening (not an early-morning close) is refused', () => {
  assert.match(dayHoursProblem('15:00', '14:00'), /מוקדמת/);
  assert.match(dayHoursProblem('22:00', '06:30'), /מוקדמת/);
});

test('identical open/close is refused', () => {
  assert.match(dayHoursProblem('10:00', '10:00'), /זהות/);
});

test('a day over 20 hours is refused', () => {
  assert.match(dayHoursProblem('06:30', '06:00'), /20/);
  assert.match(dayHoursProblem('02:00', '23:00'), /20/);
  assert.equal(dayHoursProblem('06:00', '02:00'), null);   // exactly 20h
});

test('malformed times are refused', () => {
  assert.ok(dayHoursProblem('24:00', '10:00'));
  assert.ok(dayHoursProblem('1500', '14:00'));
  assert.ok(dayHoursProblem(undefined, '14:00'));
});

test('week: closed days skipped, same problem grouped by day', () => {
  const hours = {
    0: { closed: false, open: '15:00', close: '14:00' },
    1: { closed: false, open: '15:00', close: '14:00' },
    2: { closed: false, open: '10:00', close: '22:00' },
    3: { closed: true },
    4: { closed: false, open: '20:00', close: '02:00' },
    5: { closed: false, open: '10:00', close: '10:00' },
    6: { closed: true, open: '15:00', close: '14:00' },
  };
  const list = hoursProblems(hours);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].days, [0, 1]);
  assert.match(list[0].text, /^ראשון ושני: /);
  assert.deepEqual(list[1].days, [5]);
  assert.equal(hoursProblem({ 0: { closed: false, open: '09:00', close: '17:00' } }), null);
});
