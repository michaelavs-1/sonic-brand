// Offline tests for the v7 taste chat's ops (v7/generation/taste-ops.js), its
// prompt/context formatting and reply checks. No network, no env.
// Run: node --test scripts/test-taste-ops.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stateFromRows, applyOps, stateToRows, snapshotOf, stateFromSnapshot, snapWeight, rangeOf, popularityOfTier,
} from '../v7/generation/taste-ops.js';
import { tierPopularity } from '../v7/generation/option1-draw.js';
import {
  buildTasteChatSystemPrompt, formatTasteContext, normalizeTasteReply,
} from '../v7/generation/taste-chat-prompt.js';
import { vetReply, COULD_NOT_PREPARE } from '../api/v7/account/taste-chat.js';
import { playedShares, songAt } from '../api/v7/account/_taste-context.js';
import { GENRES } from '../shared/genre-universe.js';

const PROFILE = {
  energy_levels_total: 4,
  approved_genres: [
    { genre: 'Funk', energy_level: 4 }, { genre: 'Disco', energy_level: 4 }, { genre: 'Afro Funk', energy_level: 3 },
    { genre: 'Rnb', energy_level: 3 }, { genre: 'Neo Soul', energy_level: 2 },
    { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Jazz (Standards)', energy_level: 1 },
  ],
  conditional_genres: [{ genre: 'Samba', energy_level: 3, note_en: 'x' }],
  requested_genres: ['Rnb'],
  rejected_genres: ['Reggaeton'],
  genre_weights: { Funk: 1.4, Disco: 1 },
  instrumentalness_preference: 'none',
  popularity_preference: 'soft',
};
const OPT1_ROWS = [
  { energy_tier: 'high', rank: 1, title_en: 'Funk', genres: ['Funk', 'Afro Funk', 'Rnb'] },
  { energy_tier: 'high', rank: 2, title_en: 'Disco', genres: ['Disco', 'Funk'] },
  { energy_tier: 'low', rank: 1, title_en: 'Jazz', genres: ['Jazz (Standards)', 'Bossa Nova'] },
  { energy_tier: 'low', rank: 2, title_en: 'Soul', genres: ['Neo Soul'] },
];
const LEVEL_ROWS = [
  { energy_level: 4, rank: 1, title_en: 'Groove', genres: ['Funk', 'Disco'] },
  { energy_level: 3, rank: 1, title_en: 'Afro', genres: ['Afro Funk'] },
  { energy_level: 3, rank: 2, title_en: 'Rnb', genres: ['Rnb'], energy_range: [45, 65] },
  { energy_level: 1, rank: 1, title_en: 'Jazz', genres: ['Jazz (Standards)', 'Bossa Nova'] },
];
const opt1 = () => stateFromRows({ mode: 'option1', profile: PROFILE, settings: null, option1Rows: OPT1_ROWS });
const opt2 = () => stateFromRows({ mode: 'option2', profile: PROFILE, settings: null, levelRows: LEVEL_ROWS });

test('stateFromRows: keys, defaults, weights snapped, requested ⊆ approved', () => {
  const s = opt1();
  assert.deepEqual(s.option1Dirs.map((d) => d.key), ['H1', 'H2', 'C1', 'C2']);
  assert.deepEqual(s.windows, { high: [50, 80], low: [20, 50] });
  assert.deepEqual(s.weights, { Funk: 1.5 }, '1.4 snaps to 1.5, 1 is dropped');
  assert.deepEqual(s.requested, ['Rnb']);
  const t = opt2();
  assert.deepEqual(t.levelDirs.map((d) => d.key), ['L1-1', 'L3-1', 'L3-2', 'L4-1']);
  assert.deepEqual(rangeOf(t.levelDirs.find((d) => d.key === 'L3-2'), 4), [45, 65]);
  assert.deepEqual(rangeOf(t.levelDirs.find((d) => d.key === 'L3-1'), 4), [40, 70]);
  assert.equal(snapWeight(0.3), 0.25);
  assert.equal(snapWeight(0), null);
});

test('weights: steps, 1 removes, only approved genres', () => {
  const s = opt1();
  let r = applyOps(s, [{ op: 'set_weight', genre: 'rnb', weight: 0.5 }, { op: 'set_weight', genre: 'Funk', weight: 1 }, { op: 'set_weight', genre: 'Samba', weight: 2 }]);
  assert.deepEqual(r.state.weights, { Rnb: 0.5 });
  assert.equal(r.dropped.length, 1, 'Samba is not approved');
  assert.equal(r.changed, true);
});

test('remove_genre: out of the profile, every recipe and requested; turned down', () => {
  const r = applyOps(opt1(), [{ op: 'remove_genre', genre: 'Rnb' }]);
  assert.ok(!r.state.approved.some((a) => a.genre === 'Rnb'));
  assert.ok(r.state.option1Dirs.every((d) => !d.genres.includes('Rnb')));
  assert.deepEqual(r.state.requested, []);
  assert.ok(r.state.rejected.includes('Rnb'));
});

test('add_genre: placed by dir_add, or given a recipe of its own; wrong tier dropped', () => {
  const s = opt1();
  const placed = applyOps(s, [{ op: 'add_genre', genre: 'Latin Funk', energy_level: 4 }, { op: 'dir_add', dir: 'H1', genre: 'Latin Funk' }]);
  assert.ok(placed.state.option1Dirs.find((d) => d.key === 'H1').genres.includes('Latin Funk'));
  assert.equal(placed.state.option1Dirs.length, 4);
  const orphan = applyOps(s, [{ op: 'add_genre', genre: 'Fado', energy_level: 1 }, { op: 'dir_add', dir: 'H1', genre: 'Fado' }]);
  assert.equal(orphan.dropped.length, 1, 'Fado is calm — not into a high recipe');
  const own = orphan.state.option1Dirs.find((d) => d.genres.length === 1 && d.genres[0] === 'Fado');
  assert.ok(own && own.energy_tier === 'low', 'an unplaced added genre gets a calm recipe of its own');
  assert.ok(!orphan.state.conditional.some((c) => c.genre === 'Fado'));
  const bad = applyOps(s, [{ op: 'add_genre', genre: 'Not A Genre', energy_level: 2 }, { op: 'add_genre', genre: 'Funk', energy_level: 2 }]);
  assert.equal(bad.applied.length, 0);
  assert.equal(bad.changed, false);
});

test('move_genre across tiers: leaves the old tier, needs a new home', () => {
  const r = applyOps(opt1(), [{ op: 'move_genre', genre: 'Afro Funk', energy_level: 2 }, { op: 'dir_add', dir: 'C2', genre: 'Afro Funk' }]);
  assert.ok(r.state.option1Dirs.filter((d) => d.energy_tier === 'high').every((d) => !d.genres.includes('Afro Funk')));
  assert.ok(r.state.option1Dirs.find((d) => d.key === 'C2').genres.includes('Afro Funk'));
});

test('Option 1 windows: shift keeps width, clamps at the scale, overlap is fine', () => {
  const s = opt1();
  let r = applyOps(s, [{ op: 'shift_window', tier: 'high', delta: -10 }]);
  assert.deepEqual(r.state.windows.high, [40, 70]);
  r = applyOps(r.state, [{ op: 'shift_window', tier: 'high', delta: -25 }]);
  assert.deepEqual(r.state.windows.high, [15, 45], 'overlapping the calm window is allowed');
  r = applyOps(s, [{ op: 'shift_window', tier: 'high', delta: 30 }]);
  assert.deepEqual(r.state.windows.high, [70, 100], 'clamped at 100');
  assert.equal(applyOps(r.state, [{ op: 'shift_window', tier: 'high', delta: 5 }]).dropped.length, 1, 'already at the edge');
  assert.equal(applyOps(opt2(), [{ op: 'shift_window', tier: 'high', delta: 5 }]).dropped[0].reason, 'Option 1 only');
  assert.deepEqual(stateToRows(s, 'b').settings, { energy_windows: null });
  assert.deepEqual(stateToRows(applyOps(s, [{ op: 'shift_window', tier: 'low', delta: 5 }]).state, 'b').settings,
    { energy_windows: { high: [50, 80], low: [25, 55] } });
});

test('Option 2 ranges: own range, back to default = null, validation', () => {
  const s = opt2();
  let r = applyOps(s, [{ op: 'set_range', dir: 'l3-1', min: 40, max: 60 }]);
  assert.deepEqual(r.state.levelDirs.find((d) => d.key === 'L3-1').energy_range, [40, 60]);
  r = applyOps(r.state, [{ op: 'set_range', dir: 'L3-1', min: 40, max: 70 }]);
  assert.equal(r.state.levelDirs.find((d) => d.key === 'L3-1').energy_range, null, 'equal to the level default');
  assert.equal(applyOps(s, [{ op: 'set_range', dir: 'L3-1', min: 50, max: 55 }]).dropped.length, 1, 'too narrow');
  const rows = stateToRows(applyOps(s, [{ op: 'set_range', dir: 'L3-1', min: 35, max: 60 }]).state, 'b').levelRows;
  assert.deepEqual(rows.find((x) => x.title_en === 'Afro').energy_range, [35, 60]);
  assert.ok(rows.every((x) => typeof x.profile_key === 'string' && x.profile_key.startsWith('v1-')));
});

test('Option 2: an added genre at a level with recipes gets placed; a level without recipes plays it anyway', () => {
  const s = opt2();
  const r = applyOps(s, [{ op: 'add_genre', genre: 'Fado', energy_level: 1 }]);
  assert.ok(r.state.levelDirs.some((d) => d.energy_level === 1 && d.genres.length === 1 && d.genres[0] === 'Fado'));
  const r2 = applyOps(s, [{ op: 'add_genre', genre: 'Smooth Jazz', energy_level: 2 }]);
  assert.ok(!r2.state.levelDirs.some((d) => d.energy_level === 2), 'level 2 has no recipes — the builder plays its genres together');
});

test('allow_track: only linked songs, only under an approved genre', () => {
  const linked = new Map([['abcdefghijklmnopqrstuv', { title: 'Song', artist: 'Artist', duration_sec: 200 }]]);
  const ok = applyOps(opt1(), [{ op: 'allow_track', spotify_id: 'abcdefghijklmnopqrstuv', genre: 'Funk' }], { linkedTracks: linked });
  assert.equal(ok.state.allowed.length, 1);
  assert.deepEqual(ok.allowedAdded, ['abcdefghijklmnopqrstuv']);
  const notLinked = applyOps(opt1(), [{ op: 'allow_track', spotify_id: 'zzzzzzzzzzzzzzzzzzzzzz', genre: 'Funk' }], { linkedTracks: linked });
  assert.equal(notLinked.applied.length, 0);
  const withAdd = applyOps(opt1(), [
    { op: 'add_genre', genre: 'Latin Funk', energy_level: 4 }, { op: 'dir_add', dir: 'H2', genre: 'Latin Funk' },
    { op: 'allow_track', spotify_id: 'abcdefghijklmnopqrstuv', genre: 'Latin Funk' },
  ], { linkedTracks: linked });
  assert.equal(withAdd.applied.length, 3, 'a genre added earlier in the same proposal counts');
});

test('a tier left without recipes gets one; requested genres need no recipe in Option 1', () => {
  const r = applyOps(opt1(), [{ op: 'dir_delete', dir: 'C1' }, { op: 'dir_delete', dir: 'C2' }]);
  const calm = r.state.option1Dirs.filter((d) => d.energy_tier === 'low');
  assert.equal(calm.length, 1);
  assert.deepEqual([...calm[0].genres].sort(), ['Bossa Nova', 'Jazz (Standards)', 'Neo Soul']);
  const req = applyOps(opt1(), [{ op: 'set_requested', genre: 'Samba', energy_level: 3 }]);
  assert.ok(req.state.requested.includes('Samba'));
  assert.ok(!req.state.option1Dirs.some((d) => d.genres.includes('Samba')), 'requested: added at draw time, not placed');
});

test('rows: excluded = the rest of the catalog; snapshot round trip', () => {
  const s = opt1();
  const rows = stateToRows(s, 'biz');
  assert.equal(rows.profile.excluded_genres.length, GENRES.length - s.approved.length - s.conditional.length);
  assert.deepEqual(rows.option1Rows.map((x) => x.rank), [1, 2, 1, 2]);
  assert.equal(rows.levelRows, null);
  const changed = applyOps(s, [{ op: 'remove_genre', genre: 'Disco' }]).state;
  const back = stateFromSnapshot(changed, snapshotOf(s));
  assert.deepEqual(snapshotOf(back), snapshotOf(s));
});

test('prompt + context build for both modes, and stay internal-free in the right places', () => {
  for (const mode of ['option1', 'option2']) {
    const p = buildTasteChatSystemPrompt(mode);
    assert.ok(p.includes('Genre Universe') || p.includes('GENRE'), 'catalog included');
    assert.ok(p.includes('NEVER say "כיוון"'));
    assert.ok(mode === 'option2' ? p.includes('timeline_hint') : p.includes('shift_window'));
  }
  const s = opt2();
  const txt = formatTasteContext({
    business: { name: 'בר' }, state: s, now: { weekday: 2, date: '13.10.2026', time: '14:05', phase: 'open', open: '09:00', close: '23:00' },
    played: [{ genre: 'Funk', share: 0.3 }], today: { option2: [{ label: 'Daily Mix #1', start: '09:00', end: '23:30', planned_now: null }] },
    curve: { dots: [{ time: '09:00', e: 0.2 }], hours: [{ time: '09:00', level: 1, bottom: true }] },
    linked: [{ spotify_id: 'x', title: 'T', artist: 'A', catalog_genres: [], energy: null, analyzed: false, in_today: [] }],
    changes: [], replace: { eligible: true, left: 2, cap: 2 },
  });
  assert.ok(txt.includes('L3-2 (range 45–65, own)'));
  assert.ok(txt.includes('(bottom)'));
  assert.ok(txt.includes('not in our catalog'));
});

test('replies: shape check + vetting against the state', () => {
  const s = opt1();
  const r1 = normalizeTasteReply({ reply_he: 'x', state: 'confirming', proposal: { summary_he: 'y', ops: [{ op: 'set_weight', genre: 'Funk', weight: 0.5 }, { op: 'nonsense' }] } }, { mode: 'option1' });
  vetReply(r1, s, { linkedTracks: new Map(), hasUndoable: false });
  assert.equal(r1.state, 'confirming');
  assert.deepEqual(r1.proposal.ops, [{ op: 'set_weight', genre: 'Funk', weight: 0.5 }]);
  const r2 = normalizeTasteReply({ reply_he: 'x', state: 'confirming', proposal: { ops: [{ op: 'set_weight', genre: 'Samba', weight: 2 }] } }, { mode: 'option1' });
  vetReply(r2, s, { linkedTracks: new Map(), hasUndoable: false });
  assert.equal(r2.state, 'gathering');
  assert.equal(r2.reply_he, COULD_NOT_PREPARE);
  const r3 = normalizeTasteReply({ reply_he: 'x', state: 'confirming', proposal: { ops: [{ op: 'undo' }] } }, { mode: 'option1' });
  vetReply(r3, s, { linkedTracks: new Map(), hasUndoable: true });
  assert.deepEqual(r3.proposal.ops, [{ op: 'undo' }]);
  const r4 = normalizeTasteReply({ reply_he: 'x', state: 'suggesting', suggestions: [{ genre: 'funk', energy_level: 4 }, { genre: 'samba', energy_level: 9, label_he: 'סמבה' }, { genre: 'Reggaeton' }] }, { mode: 'option1' });
  vetReply(r4, s, { linkedTracks: new Map(), hasUndoable: false });
  assert.deepEqual(r4.suggestions, [{ genre: 'Samba', energy_level: 4, label_he: 'סמבה' }], 'approved and turned-down genres are dropped, level clamped');
  const r5 = normalizeTasteReply({ reply_he: 'x', state: 'confirming', proposal: { ops: [{ op: 'add_genre', genre: 'Fado', energy_level: 1 }] } }, { mode: 'option1' });
  vetReply(r5, s, { linkedTracks: new Map(), hasUndoable: false });
  assert.deepEqual(r5.proposal.new_genres, ['Fado']);
  assert.equal(normalizeTasteReply({ state: 'x', timeline_hint: { time: '9:00', direction: 'up' } }, { mode: 'option2' }).timeline_hint.time, '09:00');
  assert.equal(normalizeTasteReply({ timeline_hint: { time: '09:00', direction: 'up' } }, { mode: 'option1' }).timeline_hint, null);
});

test('context helpers: song playing at a time, genre shares', () => {
  assert.equal(songAt([540, 544, 548], 600, 545), 1);
  assert.equal(songAt([540, 544, 548], 600, 530), -1);
  assert.equal(songAt([540, 544, 548], 600, 600), -1);
  const shares = playedShares([{ track_ids: ['a', 'b', 'c', 'd'], track_genres: { a: ['Funk'], b: ['Funk', 'Disco'], c: ['Disco'], d: [] } }]);
  assert.deepEqual(shares.map((x) => [x.genre, Math.round(x.share * 100)]), [['Funk', 50], ['Disco', 50]]);
});

test('well-known songs per tier (Option 1); whole account clears tiers; Option 2 takes no tier', () => {
  const s = opt1();   // popularity_preference 'soft'
  assert.equal(s.popTiers, null);
  const hi = applyOps(s, [{ op: 'set_pref', field: 'popularity', value: 'hard', tier: 'high' }]);
  assert.equal(hi.changed, true);
  assert.deepEqual(hi.state.popTiers, { high: 'hard', low: 'soft' });
  assert.equal(hi.state.pop, 'soft', 'the account value stays');
  assert.equal(popularityOfTier(hi.state, 'high'), 'hard');
  assert.equal(popularityOfTier(hi.state, 'low'), 'soft');
  assert.deepEqual(stateToRows(hi.state, 'biz').profile.popularity_tiers, { high: 'hard', low: 'soft' });
  // the other tier the same → folds back into the account value
  const both = applyOps(hi.state, [{ op: 'set_pref', field: 'popularity', value: 'hard', tier: 'low' }]).state;
  assert.equal(both.popTiers, null);
  assert.equal(both.pop, 'hard');
  assert.equal(stateToRows(both, 'biz').profile.popularity_tiers, null);
  // no tier = all four, and the per-tier values go
  const all = applyOps(hi.state, [{ op: 'set_pref', field: 'popularity', value: 'none' }]).state;
  assert.equal(all.popTiers, null);
  assert.equal(all.pop, 'none');
  // bad tiers, a tier on instrumentalness, a tier in Option 2 → dropped
  assert.equal(applyOps(s, [{ op: 'set_pref', field: 'popularity', value: 'hard', tier: 'evening' }]).dropped.length, 1);
  assert.equal(applyOps(s, [{ op: 'set_pref', field: 'instrumentalness', value: 'hard', tier: 'high' }]).dropped.length, 1);
  assert.equal(applyOps(opt2(), [{ op: 'set_pref', field: 'popularity', value: 'hard', tier: 'high' }]).dropped.length, 1);
  assert.equal(applyOps(opt2(), [{ op: 'set_pref', field: 'popularity', value: 'hard' }]).state.pop, 'hard');
  // stored rows: equal tiers read as none; a missing tier follows the account
  const read = (t) => stateFromRows({ mode: 'option1', profile: { ...PROFILE, popularity_tiers: t }, option1Rows: OPT1_ROWS }).popTiers;
  assert.equal(read({ high: 'soft', low: 'soft' }), null);
  assert.deepEqual(read({ high: 'hard' }), { high: 'hard', low: 'soft' });
  assert.equal(read('junk'), null);
  // undo of a change logged before popTiers existed → no per-tier values
  const { popTiers, ...oldSnap } = snapshotOf(s);
  assert.equal(stateFromSnapshot(hi.state, oldSnap).popTiers, null);
  assert.deepEqual(stateFromSnapshot(s, snapshotOf(hi.state)).popTiers, { high: 'hard', low: 'soft' });
  // the builders' helper
  assert.equal(tierPopularity('soft', { high: 'hard', low: 'none' }, 'low'), 'none');
  assert.equal(tierPopularity('soft', null, 'high'), 'soft');
  assert.equal(tierPopularity(undefined, { high: 'junk' }, 'high'), 'none');
  // prompt + context
  assert.ok(buildTasteChatSystemPrompt('option1').includes('"tier":"high"}   (popularity only'));
  assert.ok(!buildTasteChatSystemPrompt('option2').includes('(popularity only'));
  for (const mode of ['option1', 'option2']) assert.ok(buildTasteChatSystemPrompt(mode).includes('## Aim to please'));
  const line = (st) => formatTasteContext({ state: st, business: {}, now: {} }).match(/Well-known songs: [^\n]*/)[0];
  assert.equal(line(hi.state), 'Well-known songs: energetic playlists only, calm playlists mostly');
  assert.equal(line(both), 'Well-known songs: only (all four playlists)');
  assert.equal(line(opt2()), 'Well-known songs: mostly');
});
