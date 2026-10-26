// Offline tests for the v7 Option-2 energy timeline model + assembler.
// No network, no env. Run: node --test scripts/test-energy-timeline.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHM, fmtHM, windowOf, hoursGroups, groupDaysLabel, slotMinutes, defaultPoints,
  curveThrough, energyAtFn, levelOf, effectiveLevel, sanitizePoints, reconcileTimeline,
  groupForDay, mainGroup, businessWindowAt, MAX_POINTS, nudgePoints,
} from '../v7/generation/energy-timeline.js';
import {
  assembleMixes, estimateDemand, estimateDemandPerMix, mulberry32, shuffle, seedFrom,
  dayNumber, pickLevelDirections, levelProfileKey, applyRequestedCoverage, requestedPerLevel,
} from '../v7/generation/timeline-assembler.js';
import { planWindow, levelLibrary } from '../api/v7/account/_option2-builder.js';
import { normalizeLevelDirections, MAX_PER_LEVEL } from '../v7/generation/level-directions.js';
import { shapeLevelRows } from '../api/v7/account/save-level-directions.js';

const week = (fn) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, fn(d)]));
const open = (o, c) => ({ closed: false, open: o, close: c });
const CLOSED = { closed: true, open: '10:00', close: '22:00' };
// Sun–Thu 09–17, Fri 09–14, Sat closed
const HOURS_A = week((d) => (d <= 4 ? open('09:00', '17:00') : d === 5 ? open('09:00', '14:00') : CLOSED));

// ---------------------------------------------------------------- clock
test('parseHM / fmtHM', () => {
  assert.equal(parseHM('09:15'), 555);
  assert.equal(parseHM('9:05'), 545);
  assert.equal(parseHM('24:00'), 1440);
  assert.equal(parseHM('25:00'), null);
  assert.equal(parseHM('x'), null);
  assert.equal(fmtHM(1500), '01:00');
  assert.equal(fmtHM(-30), '23:30');
});

test('windowOf handles overnight and 24h', () => {
  assert.deepEqual(windowOf({ open: '09:00', close: '17:00' }), { openMin: 540, closeMin: 1020, total: 480 });
  assert.deepEqual(windowOf({ open: '18:00', close: '02:00' }), { openMin: 1080, closeMin: 1560, total: 480 });
  assert.deepEqual(windowOf({ open: '00:00', close: '00:00' }), { openMin: 0, closeMin: 1440, total: 1440 });
});

test('hoursGroups groups identical days, skips closed', () => {
  const g = hoursGroups(HOURS_A);
  assert.deepEqual(g, [
    { days: [0, 1, 2, 3, 4], open: '09:00', close: '17:00' },
    { days: [5], open: '09:00', close: '14:00' },
  ]);
  assert.deepEqual(hoursGroups(null), []);
  assert.deepEqual(hoursGroups(week(() => open('9:00', '17:00'))), [{ days: [0, 1, 2, 3, 4, 5, 6], open: '09:00', close: '17:00' }]);
});

test('groupDaysLabel', () => {
  assert.equal(groupDaysLabel([0, 1, 2, 3, 4]), 'א׳–ה׳');
  assert.equal(groupDaysLabel([5]), 'ו׳');
  assert.equal(groupDaysLabel([3, 0, 2]), 'א׳, ג׳–ד׳');
});

test('slotMinutes: clock-aligned :00/:30 plus exact edges', () => {
  assert.deepEqual(slotMinutes({ open: '09:15', close: '11:00' }), [555, 570, 600, 630, 660]);
  assert.deepEqual(slotMinutes({ open: '09:59', close: '10:31' }), [599, 600, 630, 631]);
  assert.deepEqual(slotMinutes({ open: '23:00', close: '01:00' }), [1380, 1410, 1440, 1470, 1500]);
});

test('defaultPoints = the sandbox shape on the group slots', () => {
  assert.deepEqual(defaultPoints({ open: '09:00', close: '17:00' }), [
    { m: 540, e: 0.2 }, { m: 660, e: 0.35 }, { m: 780, e: 0.6 }, { m: 900, e: 0.85 }, { m: 1020, e: 0.7 },
  ]);
  const tiny = defaultPoints({ open: '10:00', close: '10:20' });
  assert.equal(tiny.length, 2);
});

// ---------------------------------------------------------------- curve + levels
test('curve passes through the dots, never overshoots, flat outside', () => {
  const pts = [{ m: 0, e: .1 }, { m: 100, e: .9 }, { m: 200, e: .9 }, { m: 300, e: .2 }];
  const f = curveThrough(pts);
  for (const p of pts) assert.ok(Math.abs(f(p.m) - p.e) < 1e-9);
  for (let x = 100; x <= 200; x += 5) assert.ok(Math.abs(f(x) - .9) < 1e-9, 'flat between equal dots');
  for (let x = 0; x <= 100; x += 2) assert.ok(f(x) >= .1 - 1e-9 && f(x) <= .9 + 1e-9, 'no overshoot');
  assert.equal(f(-50), .1);
  assert.equal(f(999), .2);
  assert.equal(energyAtFn([...pts].reverse())(300), .2, 'energyAtFn sorts');
});

test('levelOf = grid row, effectiveLevel falls back to nearest row', () => {
  assert.equal(levelOf(0, 4), 1);
  assert.equal(levelOf(.2499, 4), 1);
  assert.equal(levelOf(.25, 4), 2);
  assert.equal(levelOf(1, 4), 4);
  assert.equal(levelOf(.5, 99), levelOf(.5, 4), 'bad N → default 4');
  assert.equal(effectiveLevel(.9, 4, (L) => L <= 2), 2);
  assert.equal(effectiveLevel(.375, 4, (L) => L === 1 || L === 3), 1, 'tie → calmer');
  assert.equal(effectiveLevel(.5, 4, () => false), null);
});

test('sanitizePoints snaps, dedupes, clamps, caps, tops up', () => {
  const g = { open: '09:00', close: '17:00' };
  const s = sanitizePoints([{ m: 545, e: 2 }, { m: 552, e: .5 }, { m: 700, e: -1 }, { m: 'x', e: 1 }], g);
  assert.deepEqual(s, [{ m: 540, e: 1 }, { m: 690, e: 0 }]);
  const many = Array.from({ length: 20 }, (_, i) => ({ m: 540 + i * 30, e: .5 }));
  assert.equal(sanitizePoints(many, g).length, MAX_POINTS);
  assert.deepEqual(sanitizePoints([{ m: 780, e: .4 }], g), [{ m: 780, e: .4 }, { m: 1020, e: .4 }]);
  assert.deepEqual(sanitizePoints([], g), defaultPoints(g));
  assert.deepEqual(sanitizePoints(s, g), s, 'idempotent');
});

// ---------------------------------------------------------------- reconcile
const TL_A = {
  version: 2,
  groups: [
    { days: [0, 1, 2, 3, 4], open: '09:00', close: '17:00', points: [{ m: 540, e: .2 }, { m: 780, e: .9 }, { m: 1020, e: .4 }] },
    { days: [5], open: '09:00', close: '14:00', points: [{ m: 540, e: .5 }, { m: 840, e: .5 }] },
  ],
};

test('reconcile: null → defaults per group; identity + idempotent', () => {
  const d = reconcileTimeline(null, HOURS_A);
  assert.equal(d.groups.length, 2);
  assert.deepEqual(d.groups[0].points, defaultPoints(d.groups[0]));
  const r = reconcileTimeline(TL_A, HOURS_A);
  assert.deepEqual(r, TL_A);
  assert.deepEqual(reconcileTimeline(r, HOURS_A), r);
});

test('reconcile: hours change keeps clock times, edges follow, out-of-hours dropped', () => {
  const h = { ...HOURS_A, 0: open('10:00', '16:00'), 1: open('10:00', '16:00'), 2: open('10:00', '16:00'), 3: open('10:00', '16:00'), 4: open('10:00', '16:00') };
  const r = reconcileTimeline(TL_A, h);
  const g = groupForDay(r, 0);
  assert.equal(g.open, '10:00');
  assert.deepEqual(g.points, [{ m: 600, e: .2 }, { m: 780, e: .9 }, { m: 960, e: .4 }]);
  // shrink so the 13:00 dot falls out: 14:00–16:00
  const h2 = week((d) => (d <= 4 ? open('14:00', '16:00') : HOURS_A[d]));
  const g2 = groupForDay(reconcileTimeline(TL_A, h2), 1);
  assert.deepEqual(g2.points.map((p) => p.m), [840, 960]);
});

test('reconcile: interior clock dot beats a moved edge dot', () => {
  const tl = { version: 2, groups: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '09:00', close: '17:00',
    points: [{ m: 540, e: .1 }, { m: 600, e: .8 }, { m: 1020, e: .3 }] }] };
  const r = reconcileTimeline(tl, week(() => open('10:00', '17:00')));
  assert.deepEqual(r.groups[0].points, [{ m: 600, e: .8 }, { m: 1020, e: .3 }]);
});

test('reconcile: split copies the old group, merge prefers the unchanged hours', () => {
  // split: Wednesday gets its own hours → copies Sun–Thu's dots (clock kept)
  const hs = { ...HOURS_A, 3: open('09:00', '18:00') };
  const rs = reconcileTimeline(TL_A, hs);
  assert.equal(rs.groups.length, 3);
  assert.deepEqual(groupForDay(rs, 3).points, [{ m: 540, e: .2 }, { m: 780, e: .9 }, { m: 1080, e: .4 }]);
  assert.deepEqual(groupForDay(rs, 0).points, TL_A.groups[0].points);
  // merge: Friday now 09–17 like Sun–Thu → the Sun–Thu curve wins
  const hm = { ...HOURS_A, 5: open('09:00', '17:00') };
  const rm = reconcileTimeline(TL_A, hm);
  assert.equal(rm.groups.length, 1);
  assert.deepEqual(rm.groups[0].days, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(rm.groups[0].points, TL_A.groups[0].points);
});

test('reconcile: new group copies the most-overlapping old group; closed days dropped', () => {
  const h = { ...HOURS_A, 6: open('12:00', '20:00'), 5: CLOSED };
  const r = reconcileTimeline(TL_A, h);
  assert.deepEqual(r.groups.map((g) => g.days), [[0, 1, 2, 3, 4], [6]]);
  // Saturday 12–20 overlaps Sun–Thu 09–17 → keeps the 13:00 dot, edges from the old curve
  const sat = groupForDay(r, 6);
  assert.ok(sat.points.some((p) => p.m === 780 && p.e === .9));
});

test('reconcile: day ↔ overnight mapping', () => {
  const tl = { version: 2, groups: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '18:00', close: '02:00',
    points: [{ m: 1080, e: .2 }, { m: 1500, e: .9 }, { m: 1560, e: .5 }] }] };
  // 01:00 dot (m=1500) survives a change to 20:00–03:00 (window 1200..1620)
  const r = reconcileTimeline(tl, week(() => open('20:00', '03:00')));
  assert.deepEqual(r.groups[0].points, [{ m: 1200, e: .2 }, { m: 1500, e: .9 }, { m: 1620, e: .5 }]);
  // …and maps to m=60 for an early-morning 00:00–06:00 schedule
  const r2 = reconcileTimeline(tl, week(() => open('00:00', '06:00')));
  assert.ok(r2.groups[0].points.some((p) => p.m === 60 && p.e === .9));
});

test('reconcile: junk and v1 input', () => {
  assert.deepEqual(reconcileTimeline({ groups: 'x' }, HOURS_A), reconcileTimeline(null, HOURS_A));
  assert.deepEqual(reconcileTimeline(42, HOURS_A), reconcileTimeline(null, HOURS_A));
  const v1 = { version: 1, type: 'curve', points: [{ t: 0, e: .3 }, { t: .5, e: 1 }, { t: 1, e: .3 }] };
  const r = reconcileTimeline(v1, HOURS_A);
  assert.deepEqual(groupForDay(r, 0).points, [{ m: 540, e: .3 }, { m: 780, e: 1 }, { m: 1020, e: .3 }]);
  assert.equal(mainGroup(r).days.length, 5);
});

// ---------------------------------------------------------------- business window
test('businessWindowAt: open / before / after / closed / overnight', () => {
  const allDays = week(() => open('09:00', '17:00'));
  const w = businessWindowAt(allDays, new Date('2026-09-22T10:00:00Z'));   // 13:00 IL
  assert.equal(w.phase, 'open');
  assert.equal(w.nowMin, 780);
  assert.equal(w.isoDate, '2026-09-22');
  assert.equal(w.expiryIso, '2026-09-22T16:00:00.000Z');                   // 19:00 IL
  assert.equal(businessWindowAt(allDays, new Date('2026-09-22T04:00:00Z')).phase, 'before-open');
  assert.equal(businessWindowAt(allDays, new Date('2026-09-22T15:00:00Z')).phase, 'after-close');
  assert.equal(businessWindowAt(week(() => CLOSED), new Date('2026-09-22T10:00:00Z')).phase, 'closed');
  const night = week(() => open('18:00', '02:00'));
  const n = businessWindowAt(night, new Date('2026-09-22T22:00:00Z'));    // 01:00 IL on the 23rd
  assert.equal(n.isoDate, '2026-09-22');
  assert.equal(n.nowMin, 1500);
  assert.equal(n.phase, 'open');
  assert.equal(n.expiryIso, '2026-09-23T01:00:00.000Z');                  // 04:00 IL
  const after = businessWindowAt(night, new Date('2026-09-23T00:00:00Z'));  // 03:00 IL → today's window, before open
  assert.equal(after.isoDate, '2026-09-23');
  assert.equal(after.phase, 'before-open');
});

// ---------------------------------------------------------------- assembler
function synthPools(genres, perGenre, seed, { nullEvery = 0 } = {}) {
  const r = mulberry32(seed);
  const pools = new Map();
  for (const g of genres) {
    const list = Array.from({ length: perGenre }, (_, i) => ({
      id: `${g}-${i}`,
      sec: nullEvery && i % nullEvery === 0 ? null : 170 + Math.floor(r() * 140),
    }));
    pools.set(g, shuffle(list, r));
  }
  return pools;
}
const BY_LEVEL = new Map([[1, ['A', 'B']], [2, ['C', 'D']], [3, ['E', 'F']]]);
const CURVE = energyAtFn([{ m: 540, e: .05 }, { m: 780, e: .95 }, { m: 1020, e: .4 }]);
const base = (over = {}) => ({
  startMin: 540, endMin: 1050, energyAt: CURVE, N: 3, genresByLevel: BY_LEVEL,
  pools: synthPools(['A', 'B', 'C', 'D', 'E', 'F'], 150, 7), rng: mulberry32(1), ...over,
});

function segments(tracks) {
  const segs = [];
  for (const t of tracks) {
    const last = segs[segs.length - 1];
    if (last && last.genre === t.genre) last.n++;
    else segs.push({ genre: t.genre, n: 1 });
  }
  return segs;
}

test('assembler: covers the window, two disjoint mixes, levels follow the curve', () => {
  const { mixes, stats } = assembleMixes(base());
  assert.equal(mixes.length, 2);
  const all = mixes.flatMap((m) => m.tracks.map((t) => t.id));
  assert.equal(new Set(all).size, all.length, 'no track twice');
  for (const m of mixes) {
    assert.ok(m.endMin >= 1050, 'reaches closing + 30');
    assert.ok(m.tracks[m.tracks.length - 1].startMin < 1050, 'last track starts inside the window');
    assert.equal(m.tracks[0].startMin, 540);
    for (const t of m.tracks) assert.equal(t.level, levelOf(CURVE(t.startMin + 2), 3));
    // cumulative duration is consistent
    let c = 540;
    for (const t of m.tracks) { assert.ok(Math.abs(t.startMin - c) < .02); c += t.sec / 60; }
  }
  assert.equal(stats.short, false);
});

test('assembler: no genre runs — each track draws its genre at random from the level', () => {
  const { mixes } = assembleMixes(base());
  for (const m of mixes) {
    const segs = segments(m.tracks);
    const avg = m.tracks.length / segs.length;
    // Two genres per level, picked per track: consecutive tracks switch genre
    // about half the time (the old 3–5-song runs averaged 4 per stretch).
    assert.ok(avg < 2.6, `average same-genre stretch ${avg.toFixed(2)}`);
    assert.ok(segs.some((s) => s.n === 1), 'single-track stretches happen');
  }
});

test('assembler: deterministic per seed, different across seeds', () => {
  const a = assembleMixes(base({ rng: mulberry32(42) }));
  const b = assembleMixes(base({ rng: mulberry32(42) }));
  const c = assembleMixes(base({ rng: mulberry32(43) }));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.mixes[0].tracks.map((t) => t.id), c.mixes[0].tracks.map((t) => t.id));
  assert.equal(typeof seedFrom('abc'), 'number');
});

test('assembler: mid-day start, NULL durations, level fallback', () => {
  const mid = assembleMixes(base({ startMin: 780 }));
  assert.equal(mid.mixes[0].tracks[0].startMin, 780);
  const nulls = assembleMixes(base({ pools: synthPools(['A', 'B', 'C', 'D', 'E', 'F'], 150, 7, { nullEvery: 3 }) }));
  assert.ok(nulls.stats.nullDurations > 0);
  assert.ok(nulls.mixes.every((m) => m.tracks.every((t) => t.sec > 0)));
  const noTop = assembleMixes(base({ genresByLevel: new Map([[1, ['A', 'B']], [2, ['C', 'D']]]) }));
  assert.ok(noTop.stats.levelFallbacks > 0);
  assert.ok(noTop.mixes.every((m) => m.tracks.every((t) => t.level <= 2)));
});

test('assembler: small pool → short mixes, still no duplicates', () => {
  const { mixes, stats } = assembleMixes(base({ pools: synthPools(['A', 'B', 'C', 'D', 'E', 'F'], 8, 3) }));
  const all = mixes.flatMap((m) => m.tracks.map((t) => t.id));
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 48);
  assert.equal(stats.short, true);
});

test('estimateDemand sizes pools from the curve', () => {
  const { specs, minsByLevel } = estimateDemand({ startMin: 540, endMin: 1050, energyAt: CURVE, N: 3, genresByLevel: BY_LEVEL });
  assert.equal(specs.length, 6);
  const total = [...minsByLevel.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 510);
  assert.ok(specs.every((s) => s.n >= 10 && s.n <= 600 && s.playlists <= 200));
  const hard = estimateDemand({ startMin: 540, endMin: 1050, energyAt: CURVE, N: 3, genresByLevel: BY_LEVEL, hardPref: true });
  assert.ok(hard.specs[0].playlists > specs[0].playlists);
});

// ---------------------------------------------------------------- builder window
test('planWindow: day window starts at max(now, opening), ends closing + 30', () => {
  const allDays = week(() => open('09:00', '17:00'));
  const tl = reconcileTimeline(null, allDays);
  const mid = planWindow({ hours: allDays, timeline: tl, now: new Date('2026-09-22T10:00:00Z') });   // 13:00 IL
  assert.equal(mid.kind, 'day');
  assert.equal(mid.startMin, 780);
  assert.equal(mid.endMin, 1050);
  assert.equal(mid.expiryIso, '2026-09-22T16:00:00.000Z');
  const early = planWindow({ hours: allDays, timeline: tl, now: new Date('2026-09-22T04:00:00Z') }); // 07:00 IL
  assert.equal(early.startMin, 540);
  assert.equal(planWindow({ hours: allDays, timeline: tl, now: new Date('2026-09-22T15:00:00Z') }).reason, 'past-close');
});

test('planWindow: closed day on demand → main curve over now → now + 12h, expires 04:00', () => {
  const hours = { ...week(() => open('09:00', '17:00')), 2: CLOSED };                     // 2026-09-22 is a Tuesday
  const tl = { version: 2, groups: [{ days: [0, 1, 3, 4, 5, 6], open: '09:00', close: '17:00',
    points: [{ m: 540, e: .1 }, { m: 1020, e: .9 }] }] };
  const now = new Date('2026-09-22T10:00:00Z');                                           // 13:00 IL
  assert.equal(planWindow({ hours, timeline: tl, now }).reason, 'closed-today');
  const w = planWindow({ hours, timeline: tl, now, onDemand: true });
  assert.equal(w.kind, 'closed-day');
  assert.equal(w.startMin, 780);
  assert.equal(w.endMin, 780 + 720);
  assert.equal(w.expiryIso, '2026-09-23T01:00:00.000Z');
  assert.ok(Math.abs(w.energyAt(780) - .1) < 1e-9 && Math.abs(w.energyAt(1500) - .9) < 1e-9, 'curve stretched over the 12h');
});

// ---------------------------------------------------------------- level directions (2026-09-28)
const DAY0 = '2026-09-28';
const addDaysIso = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
const libOf = (K) => new Map([[1, Array.from({ length: K }, (_, i) => ({ id: `d${i}`, title_en: `D${i}`, genres: [`G${i}`] }))]]);
const pickIds = (lib, iso) => pickLevelDirections(lib, iso).map((m) => m.get(1).id);

test('dayNumber: consecutive calendar days, month/year boundaries', () => {
  assert.equal(dayNumber('2026-10-01') - dayNumber('2026-09-30'), 1);
  assert.equal(dayNumber('2027-01-01') - dayNumber('2026-12-31'), 1);
  assert.equal(dayNumber('garbage'), 0);
});

test('rotation: K=1 → both mixes the same direction every day', () => {
  for (let i = 0; i < 4; i++) assert.deepEqual(pickIds(libOf(1), addDaysIso(DAY0, i)), ['d0', 'd0']);
});

test('rotation: K=2 → the mixes swap every day', () => {
  const a = pickIds(libOf(2), DAY0);
  const b = pickIds(libOf(2), addDaysIso(DAY0, 1));
  assert.notEqual(a[0], a[1]);
  assert.deepEqual(b, [a[1], a[0]]);
});

test('rotation: K≥2 → mixes differ, each mix changes daily and covers all K; K≥4 → never two days in a row', () => {
  for (let K = 2; K <= 8; K++) {
    const days = Array.from({ length: K }, (_, i) => pickIds(libOf(K), addDaysIso(DAY0, i)));
    for (const [m1, m2] of days) assert.notEqual(m1, m2, `K=${K}: the two mixes differ`);
    for (const k of [0, 1]) {
      assert.equal(new Set(days.map((d) => d[k])).size, K, `K=${K}: mix ${k + 1} plays every direction once per cycle`);
      for (let i = 1; i < K; i++) assert.notEqual(days[i][k], days[i - 1][k], `K=${K}: mix ${k + 1} changes daily`);
    }
    if (K >= 4) {
      for (let i = 1; i < K; i++) {
        const prev = new Set(days[i - 1]);
        assert.ok(days[i].every((id) => !prev.has(id)), `K=${K}: nothing from yesterday`);
      }
    }
  }
  assert.deepEqual(pickIds(libOf(5), DAY0), pickIds(libOf(5), DAY0), 'same date → same picks');
});

test('rotation: every level rotates independently; empty levels skipped', () => {
  const lib = new Map([[1, libOf(3).get(1)], [2, []], [3, libOf(1).get(1)]]);
  const [m1, m2] = pickLevelDirections(lib, DAY0);
  assert.deepEqual([...m1.keys()].sort(), [1, 3]);
  assert.equal(m1.get(3).id, m2.get(3).id);
});

// ---- requested genres: one mix plays each of them every day (2026-10-26) ----

// A level library from genre lists: libFrom([['Funk','Disco'], ['Samba']]).
const libFrom = (sets, level = 1) => new Map([[level, sets.map((genres, i) => ({ id: `d${i}`, title_en: `D${i}`, genres }))]]);
const playedAt = (picks, level) => picks.flatMap((m) => m.get(level)?.genres || []);

test('coverage: a requested genre only one direction plays is played every day', () => {
  const lib = libFrom([['Funk'], ['Disco'], ['Samba'], ['Rnb']]);
  const req = new Map([[1, ['Rnb']]]);
  for (let i = 0; i < 12; i++) {
    const iso = addDaysIso(DAY0, i);
    const picks = applyRequestedCoverage(pickLevelDirections(lib, iso), lib, req, dayNumber(iso));
    assert.ok(playedAt(picks, 1).includes('Rnb'), `${iso} left Rnb out`);
    assert.notEqual(picks[0].get(1).id, picks[1].get(1).id, 'the mixes stay on different directions');
  }
});

test('coverage: two requested genres in different directions are both played', () => {
  const lib = libFrom([['Funk'], ['Deep House'], ['Italo Disco'], ['Samba'], ['Bolero']]);
  const req = new Map([[1, ['Deep House', 'Italo Disco']]]);
  for (let i = 0; i < 10; i++) {
    const iso = addDaysIso(DAY0, i);
    const played = playedAt(applyRequestedCoverage(pickLevelDirections(lib, iso), lib, req, dayNumber(iso)), 1);
    assert.ok(played.includes('Deep House') && played.includes('Italo Disco'), `${iso}: ${played}`);
  }
});

test('coverage: more requested genres than two mixes can carry → the most, rotating', () => {
  const lib = libFrom([['Funk'], ['Disco'], ['Samba']]);
  const req = new Map([[1, ['Funk', 'Disco', 'Samba']]]);
  const seen = new Set();
  for (let i = 0; i < 9; i++) {
    const iso = addDaysIso(DAY0, i);
    const played = playedAt(applyRequestedCoverage(pickLevelDirections(lib, iso), lib, req, dayNumber(iso)), 1);
    assert.equal(played.length, 2, `${iso} played ${played.length} of 3`);
    played.forEach((g) => seen.add(g));
  }
  assert.deepEqual([...seen].sort(), ['Disco', 'Funk', 'Samba']);
});

test('coverage: leaves the rotation alone when it already plays the requested genres', () => {
  const lib = libFrom([['Rnb', 'Funk'], ['Rnb', 'Disco'], ['Rnb', 'Samba']]);
  const req = new Map([[1, ['Rnb']]]);
  for (let i = 0; i < 6; i++) {
    const iso = addDaysIso(DAY0, i);
    const before = pickLevelDirections(lib, iso);
    const after = applyRequestedCoverage(before, lib, req, dayNumber(iso));
    assert.deepEqual(after.map((m) => m.get(1).id), before.map((m) => m.get(1).id));
  }
});

test('coverage: a one-direction level and a genre nothing plays are left as they are', () => {
  const lib = libFrom([['Funk']]);
  const picks = applyRequestedCoverage(pickLevelDirections(lib, DAY0), lib, new Map([[1, ['Rnb']]]), 0);
  assert.deepEqual(picks.map((m) => m.get(1).id), ['d0', 'd0']);
});

test('requestedPerLevel: the requested genres of each level, catalog spelling kept', () => {
  const byLevel = new Map([[1, ['Bossa Nova', 'Fado']], [3, ['Funk', 'Disco']]]);
  const out = requestedPerLevel(['funk', 'Bossa Nova', 'Samba'], byLevel);
  assert.deepEqual([...out.entries()], [[1, ['Bossa Nova']], [3, ['Funk']]]);
  assert.equal(requestedPerLevel([], byLevel).size, 0);
});

test('levelProfileKey: order-independent; changes on add / remove / level move / N', () => {
  const tp = { energy_levels_total: 4, approved_genres: [{ genre: 'Funk', energy_level: 3 }, { genre: 'Bossa Nova', energy_level: 1 }] };
  const k = levelProfileKey(tp);
  assert.match(k, /^v1-[0-9a-f]{16}$/);
  assert.equal(levelProfileKey({ ...tp, approved_genres: [...tp.approved_genres].reverse() }), k);
  assert.equal(levelProfileKey({ ...tp, approved_genres: [{ genre: 'funk', energy_level: 3 }, { genre: 'Bossa Nova', energy_level: 1 }] }), k, 'case-insensitive');
  assert.notEqual(levelProfileKey({ ...tp, approved_genres: [...tp.approved_genres, { genre: 'Disco', energy_level: 4 }] }), k);
  assert.notEqual(levelProfileKey({ ...tp, approved_genres: tp.approved_genres.slice(1) }), k);
  assert.notEqual(levelProfileKey({ ...tp, approved_genres: [{ genre: 'Funk', energy_level: 4 }, { genre: 'Bossa Nova', energy_level: 1 }] }), k);
  assert.notEqual(levelProfileKey({ ...tp, energy_levels_total: 5 }), k);
});

test('assembler: per-mix genre maps — each mix plays only its own direction per level, no shared tracks', () => {
  const perMix = [
    new Map([[1, ['A']], [2, ['C']], [3, ['E', 'F']]]),
    new Map([[1, ['B']], [2, ['C', 'D']], [3, ['F']]]),       // C and F shared with mix 1
  ];
  const { mixes } = assembleMixes(base({ genresByLevel: perMix }));
  mixes.forEach((m, k) => {
    for (const t of m.tracks) assert.ok(perMix[k].get(t.level).includes(t.genre), `mix ${k + 1}: ${t.genre} at L${t.level}`);
  });
  const all = mixes.flatMap((m) => m.tracks.map((t) => t.id));
  assert.equal(new Set(all).size, all.length);
});

test('assembler: per-mix level fallback when a mix has nothing at a level', () => {
  const perMix = [new Map([[1, ['A']], [3, ['E']]]), new Map([[1, ['B']], [2, ['D']], [3, ['F']]])];
  const { mixes, stats } = assembleMixes(base({ genresByLevel: perMix }));
  assert.ok(stats.levelFallbacks > 0);
  assert.ok(mixes[0].tracks.every((t) => t.level !== 2), 'mix 1 has no level-2 direction');
  assert.ok(mixes[1].tracks.some((t) => t.level === 2));
});

// ---- energy rings (2026-10-13) ----
// Pools the way the builder hands them over: each block shuffled. Entries are
// [ring, count, { side, refill }]; the id records them all.
function ringPools(spec, seed) {
  const r = mulberry32(seed);
  const pools = new Map();
  for (const [g, blocks] of Object.entries(spec)) {
    const list = [];
    for (const [ring, count, { side = 0, refill = false } = {}] of blocks) {
      const tag = `${refill ? 'p' : 'f'}${ring}${side > 0 ? 'a' : side < 0 ? 'b' : ''}`;
      const block = Array.from({ length: count }, (_, i) => ({
        id: `${g}-${tag}-${i}`, sec: 170 + Math.floor(r() * 140), ring, side, energy: 40 + ring,
        ...(refill ? { refill: true } : {}),
      }));
      list.push(...shuffle(block, r));
    }
    pools.set(g, list);
  }
  return pools;
}
const tagOf = (id) => {
  const [, refill, ring, side] = /-([fp])(\d+)([ab]?)-/.exec(id);
  return { refill: refill === 'p', ring: Number(ring), side: side === 'a' ? 1 : side === 'b' ? -1 : 0 };
};
const ringOf = (id) => tagOf(id).ring;
const orderOf = (id) => (tagOf(id).refill ? 1000 : 0) + tagOf(id).ring;
const ascending = (xs) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);
const FLAT = energyAtFn([{ m: 540, e: .2 }, { m: 1020, e: .2 }]);   // level 1 all day (N=3)

test('assembler: a level uses every in-range song, across its genres, before widening', () => {
  // A has few in-range songs, B many. ~110 tracks needed over both mixes, 165 available.
  const pools = ringPools({ A: [[0, 5], [1, 60]], B: [[0, 40], [1, 60]] }, 3);
  const { mixes, stats } = assembleMixes(base({ endMin: 770, energyAt: FLAT, genresByLevel: new Map([[1, ['A', 'B']]]), pools }));
  const placed = mixes.flatMap((m) => m.tracks);
  assert.ok(placed.length < 165 && placed.length > 60, `placed ${placed.length}`);
  assert.equal(stats.short, false);
  const inRange = placed.filter((t) => ringOf(t.id) === 0);
  assert.equal(inRange.length, 45, 'all 45 in-range songs used');
  for (const m of mixes) assert.ok(ascending(m.tracks.map((t) => ringOf(t.id))), 'never back inside the range after widening');
  assert.equal(stats.widened, placed.length - 45);
  assert.equal(stats.repeats, 0);
  assert.ok(placed.every((t) => t.energy === 40 + ringOf(t.id)), 'energy carried through');
});

test('assembler: the range widens fully before recently served songs come back', () => {
  const pools = ringPools({ A: [[0, 20], [2, 20], [0, 200, { refill: true }]], B: [[1, 20], [1, 200, { refill: true }]] }, 4);
  const { mixes, stats } = assembleMixes(base({ energyAt: FLAT, genresByLevel: new Map([[1, ['A', 'B']]]), pools }));
  const placed = mixes.flatMap((m) => m.tracks);
  assert.equal(placed.filter((t) => !tagOf(t.id).refill).length, 60, 'every fresh song used');
  assert.equal(stats.widened, 40);
  assert.equal(stats.repeats, placed.length - 60);
  for (const m of mixes) assert.ok(ascending(m.tracks.map((t) => orderOf(t.id))), 'ring order 0 → 1 → 2, then the refill');
});

test('assembler: a widened stretch takes the side the curve leans to, nearest first', () => {
  // N=2, level 1 = the lower half of the scale. The curve rises through it:
  // below its middle (e < .25) the calmer side, above it the more energetic one.
  const RISING = energyAtFn([{ m: 540, e: .02 }, { m: 1050, e: .48 }]);
  const pools = ringPools({
    A: [[0, 5], [1, 200, { side: -1 }], [1, 200, { side: 1 }]],
    B: [[0, 5], [2, 100, { side: -1 }], [2, 100, { side: 1 }]],
  }, 5);
  const { mixes, stats } = assembleMixes(base({ N: 2, energyAt: RISING, genresByLevel: new Map([[1, ['A', 'B']]]), pools }));
  const placed = mixes.flatMap((m) => m.tracks);
  assert.equal(placed.filter((t) => ringOf(t.id) === 0).length, 10, 'in-range songs first');
  const widened = placed.filter((t) => ringOf(t.id) > 0);
  assert.equal(widened.length, stats.widened);
  for (const t of widened) {
    const pref = RISING(t.startMin + 2) * 2 >= .5 ? 1 : -1;
    assert.equal(tagOf(t.id).side, pref, `${t.id} at ${fmtHM(t.startMin)}`);
    assert.equal(ringOf(t.id), 1, 'the nearer songs before the farther ones');
  }
  assert.ok(widened.some((t) => tagOf(t.id).side < 0) && widened.some((t) => tagOf(t.id).side > 0), 'both halves of the day');

  // The preferred side runs out → the other side, never back.
  const HIGH = energyAtFn([{ m: 540, e: .45 }, { m: 1020, e: .45 }]);   // upper half of level 1 → more energetic
  const few = ringPools({ A: [[0, 2], [1, 3, { side: 1 }], [1, 300, { side: -1 }]] }, 6);
  const r = assembleMixes(base({ N: 2, energyAt: HIGH, genresByLevel: new Map([[1, ['A']]]), pools: few, mixes: 1 }));
  const sides = r.mixes[0].tracks.map((t) => (ringOf(t.id) === 0 ? 'in' : tagOf(t.id).side > 0 ? 'above' : 'below'));
  assert.deepEqual(sides.slice(0, 5), ['in', 'in', 'above', 'above', 'above']);
  assert.ok(sides.slice(5).every((x) => x === 'below'));
});

test('assembler: no rings = the old draw, track for track', () => {
  const plain = synthPools(['A', 'B', 'C', 'D', 'E', 'F'], 150, 7);
  const zero = new Map([...plain].map(([g, list]) => [g, list.map((t) => ({ ...t, ring: 0 }))]));
  const a = assembleMixes(base({ pools: plain }));
  const b = assembleMixes(base({ pools: zero }));
  assert.deepEqual(a.mixes.map((m) => m.tracks.map((t) => t.id)), b.mixes.map((m) => m.tracks.map((t) => t.id)));
  assert.equal(a.stats.widened, 0);
  assert.equal(a.stats.repeats, 0);
});

test('estimateDemandPerMix: per-mix demand merged per genre', () => {
  const perMix = [new Map([[1, ['A']], [2, ['C']], [3, ['E']]]), new Map([[1, ['B']], [2, ['C']], [3, ['F']]])];
  const { specs, minsByLevelPerMix } = estimateDemandPerMix({ startMin: 540, endMin: 1050, energyAt: CURVE, N: 3, genresByLevelPerMix: perMix });
  assert.equal(minsByLevelPerMix.length, 2);
  const byG = Object.fromEntries(specs.map((sp) => [sp.genre, sp]));
  assert.deepEqual(Object.keys(byG).sort(), ['A', 'B', 'C', 'E', 'F']);
  assert.ok(byG.C.n > byG.A.n, 'a genre both mixes play gets both demands');
  assert.equal(byG.C.level, 2);
  assert.ok(specs.every((sp) => sp.n <= 600 && sp.playlists <= 200));
});

test('levelLibrary: rank order, profile filter, implicit direction for a level without one', () => {
  const byLevel = new Map([[1, ['Bossa Nova', 'Fado']], [2, ['Funk']], [3, ['Disco']]]);
  assert.equal(levelLibrary([], byLevel), null);
  const lib = levelLibrary([
    { id: 'b', energy_level: 1, rank: 2, title_en: 'B', genres: ['Fado'] },
    { id: 'a', energy_level: 1, rank: 1, title_en: 'A', genres: ['bossa nova', 'Funk'] },   // Funk is level 2 → dropped
    { id: 'x', energy_level: 2, rank: 1, title_en: 'X', genres: ['Disco'] },                // wrong level only → skipped
  ], byLevel);
  assert.deepEqual(lib.get(1).map((d) => d.id), ['a', 'b']);
  assert.deepEqual(lib.get(1)[0].genres, ['Bossa Nova']);
  assert.deepEqual(lib.get(2), [{ id: null, title_en: '(all level 2 genres)', genres: ['Funk'], energy_range: null }]);
  assert.deepEqual(lib.get(3)[0].genres, ['Disco']);
  // A recipe's own range (the taste chat) rides along; junk → null.
  const ranged = levelLibrary([
    { id: 'r', energy_level: 1, rank: 1, title_en: 'R', genres: ['Fado'], energy_range: [25, 45] },
    { id: 's', energy_level: 1, rank: 2, title_en: 'S', genres: ['Bossa Nova'], energy_range: [60, 40] },
  ], byLevel);
  assert.deepEqual(ranged.get(1).map((d) => d.energy_range), [[25, 45], null]);
});

test('nudgePoints: the nearest dot moves one level; far from any dot a dot is added', () => {
  const g = { open: '09:00', close: '17:00' };
  const pts = [{ m: 540, e: 0.2 }, { m: 780, e: 0.8 }, { m: 1020, e: 0.4 }];
  const down = nudgePoints(pts, g, 790, 'down', 4);
  assert.deepEqual(down.find((p) => p.m === 780), { m: 780, e: 0.55 }, 'within 45 min → that dot, one level (1/4) down');
  assert.equal(down.length, 3);
  const added = nudgePoints(pts, g, 660, 'up', 4);
  assert.equal(added.length, 4, 'two hours from any dot → a new dot');
  const nd = added.find((p) => p.m === 660);
  assert.ok(nd && nd.e > energyAtFn(pts)(660), 'above the old curve');
  assert.equal(nudgePoints([{ m: 540, e: 1 }, { m: 1020, e: 1 }], g, 540, 'up', 4)[0].e, 1, 'clamped at the top');
});

test('assembler: genre weights scale a genre\'s share', () => {
  const pools = synthPools(['A', 'B'], 400, 9);
  const one = new Map([[1, ['A', 'B']]]);
  const count = (r) => r.mixes.flatMap((m) => m.tracks).reduce((n, t) => n + (t.genre === 'A'), 0);
  const even = assembleMixes(base({ energyAt: FLAT, genresByLevel: one, pools }));
  const less = assembleMixes(base({ energyAt: FLAT, genresByLevel: one, pools, weights: new Map([['A', 0.25]]) }));
  const total = (r) => r.mixes.flatMap((m) => m.tracks).length;
  const shareEven = count(even) / total(even);
  const shareLess = count(less) / total(less);
  assert.ok(shareEven > 0.4 && shareEven < 0.6, `even share ${shareEven.toFixed(2)}`);
  assert.ok(shareLess < 0.32, `weight 0.25 share ${shareLess.toFixed(2)}`);
  const ones = assembleMixes(base({ energyAt: FLAT, genresByLevel: one, pools, weights: new Map([['A', 1], ['B', 1]]) }));
  assert.deepEqual(ones.mixes.map((m) => m.tracks.map((t) => t.id)), even.mixes.map((m) => m.tracks.map((t) => t.id)), 'weights of 1 = no weights');
});

test('normalizeLevelDirections + shapeLevelRows: level-checked genres, no duplicate sets, caps, profile key', () => {
  const tp = { energy_levels_total: 3, approved_genres: [
    { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Fado', energy_level: 1 }, { genre: 'Funk', energy_level: 3 },
  ] };
  const raw = { directions: [
    { energy_level: 1, title_en: 'A', genres: ['Bossa Nova', 'Funk', 'Made Up'] },
    { energy_level: 1, title_en: 'dup', genres: ['bossa nova'] },
    { energy_level: 1, title_en: 'B', genres: ['Fado', 'Bossa Nova'] },
    { energy_level: 9, title_en: 'bad', genres: ['Funk'] },
    { energy_level: 3, title_en: 'C', genres: ['Funk'] },
    ...Array.from({ length: MAX_PER_LEVEL + 3 }, (_, i) => ({ energy_level: 1, title_en: `x${i}`, genres: i % 2 ? ['Fado'] : ['Bossa Nova', 'Fado'] })),
  ] };
  const { directions } = normalizeLevelDirections(raw, tp.approved_genres, 3);
  assert.deepEqual(directions.map((d) => [d.energy_level, d.genres]), [
    [1, ['Bossa Nova']], [1, ['Fado', 'Bossa Nova']], [3, ['Funk']], [1, ['Fado']],
  ]);
  const { rows, profileKey } = shapeLevelRows('biz', directions, tp);
  assert.equal(profileKey, levelProfileKey(tp));
  assert.ok(rows.every((r) => r.profile_key === profileKey && r.business_id === 'biz' && r.active));
  assert.deepEqual(rows.map((r) => [r.energy_level, r.rank]), [[1, 1], [1, 2], [3, 1], [1, 3]]);
  assert.equal(shapeLevelRows('biz', [{ energy_level: 3, genres: ['Fado'] }], tp).rows.length, 0, 'wrong-level genre rejected server-side');
});

test('normalizeLevelDirections: a requested genre no direction plays gets one of its own', () => {
  const approved = [
    { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Fado', energy_level: 1 }, { genre: 'Funk', energy_level: 3 },
  ];
  const raw = { directions: [
    { energy_level: 1, title_en: 'A', genres: ['Bossa Nova', 'Fado'] },
    { energy_level: 3, title_en: 'B', genres: ['Funk'] },
  ] };
  // Fado is played → untouched. Samba isn't approved → nothing to do.
  assert.deepEqual(normalizeLevelDirections(raw, approved, 3, ['Fado', 'Samba']).directions.length, 2);
  // Funk requested but only at level 3 — level 1 is not affected.
  const out = normalizeLevelDirections(
    { directions: [{ energy_level: 1, title_en: 'A', genres: ['Bossa Nova'] }] }, approved, 3, ['Fado', 'Funk'],
  ).directions;
  assert.deepEqual(out.map((d) => [d.energy_level, d.genres]), [[1, ['Bossa Nova']], [1, ['Fado']], [3, ['Funk']]]);
});
