// Offline tests (node --test) for the 04:00-IL day boundary used by v7's
// special playlists: prevIl4amIso (card visibility + daily cap) and
// nextIl4amIso (playlist expiry). Both must agree — a card created at T is
// visible exactly until nextIl4amIso(T), i.e. while prevIl4amIso(now) <= T.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prevIl4amIso, nextIl4amIso } from '../v7/generation/playlist-length.js';

const at = (iso) => ({ now: new Date(iso) });

test('afternoon: day started at 04:00 today (IL summer, UTC+3)', () => {
  // 2026-07-15 15:00 IL = 12:00Z
  assert.equal(prevIl4amIso(at('2026-07-15T12:00:00Z')), '2026-07-15T01:00:00.000Z');
  assert.equal(nextIl4amIso(at('2026-07-15T12:00:00Z')), '2026-07-16T01:00:00.000Z');
});

test('01:30 IL: still yesterday\'s day', () => {
  // 2026-07-16 01:30 IL = 2026-07-15T22:30Z
  assert.equal(prevIl4amIso(at('2026-07-15T22:30:00Z')), '2026-07-15T01:00:00.000Z');
  assert.equal(nextIl4amIso(at('2026-07-15T22:30:00Z')), '2026-07-16T01:00:00.000Z');
});

test('exactly 04:00 IL starts a new day', () => {
  assert.equal(prevIl4amIso(at('2026-07-16T01:00:00Z')), '2026-07-16T01:00:00.000Z');
  assert.equal(nextIl4amIso(at('2026-07-16T01:00:00Z')), '2026-07-17T01:00:00.000Z');
});

test('winter (UTC+2)', () => {
  // 2026-12-10 20:00 IL = 18:00Z
  assert.equal(prevIl4amIso(at('2026-12-10T18:00:00Z')), '2026-12-10T02:00:00.000Z');
});

test('the morning after the autumn DST change (IL back to UTC+2 on 2026-10-25)', () => {
  // 2026-10-25 10:00 IL (UTC+2) = 08:00Z. Day started 04:00 IL = 02:00Z —
  // nextIl4amIso − 24h would give 01:00Z (wrong by an hour).
  assert.equal(prevIl4amIso(at('2026-10-25T08:00:00Z')), '2026-10-25T02:00:00.000Z');
});

test('a card created at T is visible until nextIl4amIso(T), never across 04:00', () => {
  const created = '2026-07-15T20:00:00Z';                      // 23:00 IL
  const until   = Date.parse(nextIl4amIso(at(created)));       // 04:00 IL next day
  const before  = new Date(until - 60_000).toISOString();
  const after   = new Date(until + 60_000).toISOString();
  assert.ok(Date.parse(created) >= Date.parse(prevIl4amIso(at(before))));
  assert.ok(Date.parse(created) <  Date.parse(prevIl4amIso(at(after))));
});
