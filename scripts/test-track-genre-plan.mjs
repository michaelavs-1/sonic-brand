// Offline tests for the Track cleanup genre editor's planner
// (node --test scripts/test-track-genre-plan.mjs). See api/v4/_track-genres.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGenreChange, manualPlaylistId } from '../api/v4/_track-genres.js';

const T = 'track0000000000000000a';
const row = (playlist_id) => ({ playlist_id, spotify_id: T, position: 1 });
const ids = (rows) => rows.map((r) => r.playlist_id).sort();

test('removing a genre drops the track from that genre\'s playlists only', () => {
  const rows = [row('P1'), row('P2'), row('P3')];
  const g = new Map([['P1', ['rnb']], ['P2', ['rnb']], ['P3', ['funk']]]);
  const plan = planGenreChange(T, rows, g, ['funk']);
  assert.deepEqual(ids(plan.remove), ['P1', 'P2']);
  assert.deepEqual(ids(plan.keep), ['P3']);
  assert.deepEqual(plan.add, []);
});

test('adding a genre is a manual placement', () => {
  const plan = planGenreChange(T, [row('P1')], new Map([['P1', ['rnb']]]), ['rnb', 'neo soul']);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.add, [{ playlist_id: manualPlaylistId('neo soul'), spotify_id: T, position: null }]);
});

test('a two-genre playlist: removing one genre keeps the other through a manual placement', () => {
  const plan = planGenreChange(T, [row('P1')], new Map([['P1', ['late night jazz', 'smooth jazz']]]), ['smooth jazz']);
  assert.deepEqual(ids(plan.remove), ['P1']);
  assert.deepEqual(ids(plan.add), ['manual:smooth jazz']);
});

test('reclassify: out of one genre, into another', () => {
  const rows = [row('P1'), row('P2')];
  const g = new Map([['P1', ['folk', 'indie folk']], ['P2', ['folk']]]);
  const plan = planGenreChange(T, rows, g, ['indie folk', 'bossa nova']);
  assert.deepEqual(ids(plan.remove), ['P1', 'P2']);
  assert.deepEqual(ids(plan.add), ['manual:bossa nova', 'manual:indie folk']);
});

test('an existing manual placement is kept or removed like any playlist', () => {
  const rows = [row('P1'), row('manual:samba')];
  const g = new Map([['P1', ['rnb']], ['manual:samba', ['samba']]]);
  assert.deepEqual(ids(planGenreChange(T, rows, g, ['rnb']).remove), ['manual:samba']);
  const keepAll = planGenreChange(T, rows, g, ['rnb', 'samba']);
  assert.deepEqual(keepAll.remove, []);
  assert.deepEqual(keepAll.add, []);
});

test('a playlist with no genre row is left alone; no genres at all removes every tagged playlist', () => {
  const rows = [row('P1'), row('P9')];
  const g = new Map([['P1', ['rnb']], ['P9', []]]);
  const plan = planGenreChange(T, rows, g, []);
  assert.deepEqual(ids(plan.remove), ['P1']);
  assert.deepEqual(ids(plan.keep), ['P9']);
});
