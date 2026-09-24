// Offline tests for the v7 Option-2 energy timeline model + assembler.
// No network, no env. Run: node --test scripts/test-energy-timeline.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHM, fmtHM, windowOf, hoursGroups, groupDaysLabel, slotMinutes, defaultPoints,
  curveThrough, energyAtFn, levelOf, effectiveLevel, sanitizePoints, reconcileTimeline,
  groupForDay, mainGroup, businessWindowAt, MAX_POINTS,
} from '../v7/generation/energy-timeline.js';
import { assembleMixes, estimateDemand, mulberry32, shuffle, seedFrom } from '../v7/generation/timeline-assembler.js';
import { planWindow } from '../api/v7/account/_option2-builder.js';

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
    for (const s of segments(m.tracks)) assert.ok(s.n <= 5, `run of ${s.n} ${s.genre}`);
    // cumulative duration is consistent
    let c = 540;
    for (const t of m.tracks) { assert.ok(Math.abs(t.startMin - c) < .02); c += t.sec / 60; }
  }
  assert.equal(stats.short, false);
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
