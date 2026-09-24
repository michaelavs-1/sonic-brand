// v7 Option-2 energy timeline — the pure model shared by the browser editor
// (v7/account/energy-timeline-editor.js, v7/test-timeline), the account
// endpoints (update-timeline / set-delivery-mode / update-hours) and the
// Option-2 builder (api/v7/account/_option2-builder.js).
//
// Server-reachable: bare imports only, no ?v= query (see CLAUDE.md § Cache
// busting). No DOM, no network.
//
// Stored shape (business_v7_settings.timeline), version 2 — one timeline per
// HOURS GROUP (days with identical opening hours share one):
//
//   { version: 2, groups: [
//       { days: [0,1,2,3,4], open: '09:00', close: '23:00',
//         points: [ { m: 540, e: 0.2 }, { m: 720, e: 0.55 }, ... ] } ] }
//
//   m = minutes since midnight of the day the window OPENS, within
//       [openMin, closeMin]; an overnight window (18:00–02:00) runs past 1440.
//   e = energy 0..1 (top of the chart = 1). 2–12 points, unique m, sorted.
//
// Clock minutes (not positions relative to the window) so that "keep clock
// times" — the rule when the owner edits opening hours — is the identity on m,
// and so equality between dots is exact.

import { ilPartsFromDate, ilWallClockToUtc, EXPIRY_BUFFER_MINS } from './playlist-length.js';

export const TIMELINE_VERSION = 2;
export const SNAP_MIN = 30;           // dots sit on the clock's :00 / :30 (plus exact opening/closing)
export const MIN_POINTS = 2;
export const MAX_POINTS = 12;
export const AFTER_CLOSE_MIN = 30;    // Option-2 playlists run to closing + 30 min
export const DEFAULT_LEVELS = 4;      // grid rows when the taste profile has no usable energy_levels_total

const DEFAULT_OPEN = '10:00';         // same defaults as playlist-length.js dayMinutesFromHours
const DEFAULT_CLOSE = '22:00';
// The sandbox's starting shape: (position in the window, energy).
const DEFAULT_SHAPE = [[0, .2], [.25, .35], [.5, .6], [.75, .85], [1, .7]];
const DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Clock + windows
// ---------------------------------------------------------------------------

export function parseHM(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 24 || mm > 59 || (h === 24 && mm > 0)) return null;
  return h * 60 + mm;
}

export function fmtHM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const normHM = (s, fallback) => fmtHM(parseHM(s) ?? parseHM(fallback));

// { openMin, closeMin, total } for a group/day. closeMin > openMin always:
// close <= open means the window runs past midnight (or a full 24h).
export function windowOf(g) {
  const openMin = parseHM(g?.open) ?? parseHM(DEFAULT_OPEN);
  let closeMin = parseHM(g?.close) ?? parseHM(DEFAULT_CLOSE);
  if (closeMin <= openMin) closeMin += 1440;
  return { openMin, closeMin, total: closeMin - openMin };
}

function dayHours(hours, dayIdx) {
  const h = hours && typeof hours === 'object' ? (hours[dayIdx] ?? hours[String(dayIdx)]) : null;
  if (!h || h.closed) return null;
  return { open: normHM(h.open, DEFAULT_OPEN), close: normHM(h.close, DEFAULT_CLOSE) };
}

// Days with identical opening hours → one group. Closed / missing days have
// no group. Sorted by first day (Sunday first).
export function hoursGroups(hours) {
  const byKey = new Map();
  for (let d = 0; d < 7; d++) {
    const h = dayHours(hours, d);
    if (!h) continue;
    const key = `${h.open}-${h.close}`;
    if (!byKey.has(key)) byKey.set(key, { days: [], open: h.open, close: h.close });
    byKey.get(key).days.push(d);
  }
  return [...byKey.values()].sort((a, b) => a.days[0] - b.days[0]);
}

// "א׳–ה׳", "ו׳", "א׳, ג׳–ד׳" — for the editor's group tabs.
export function groupDaysLabel(days) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const runs = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else runs.push([d, d]);
  }
  return runs.map(([a, b]) => (a === b ? DAY_LETTERS[a] : `${DAY_LETTERS[a]}–${DAY_LETTERS[b]}`)).join(', ');
}

// Where a dot may sit: opening, every clock :00/:30 strictly inside, closing.
// Clock-aligned (not counted from opening), so a 09:15 opening still gives
// 09:30, 10:00, … — and slots stay aligned past midnight (1440 % 30 === 0).
export function slotMinutes(group) {
  const { openMin, closeMin } = windowOf(group);
  const out = [openMin];
  for (let m = Math.floor(openMin / SNAP_MIN) * SNAP_MIN + SNAP_MIN; m < closeMin; m += SNAP_MIN) out.push(m);
  out.push(closeMin);
  return out;
}

export function snapMinute(group, m, slots = slotMinutes(group)) {
  let best = slots[0];
  for (const s of slots) if (Math.abs(s - m) < Math.abs(best - m)) best = s;
  return best;
}

// ---------------------------------------------------------------------------
// Curve + levels
// ---------------------------------------------------------------------------

// Fritsch–Carlson monotone cubic through the dots (verbatim from the approved
// sandbox): smooth, and never overshoots them — the curve can't invent a peak
// the owner didn't set. Flat before the first dot and after the last one.
// `pts` = [{ m, e }] sorted by m.
export function curveThrough(pts) {
  if (!pts.length) return () => 0.5;
  if (pts.length === 1) return () => pts[0].e;
  const xs = pts.map((p) => p.m), ys = pts.map((p) => p.e);
  for (let i = 1; i < xs.length; i++) if (xs[i] <= xs[i - 1]) xs[i] = xs[i - 1] + 1e-4;
  const n = xs.length, dx = [], s = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i]; s[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  m[0] = s[0]; m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / s[i], b = m[i + 1] / s[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); m[i] = k * a * s[i]; m[i + 1] = k * b * s[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return clamp01((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]);
  };
}

export const energyAtFn = (points) => curveThrough([...points].sort((a, b) => a.m - b.m));

// Number of energy levels (grid rows) for a profile's energy_levels_total.
export function normLevels(N) {
  const n = Math.round(Number(N));
  return n >= 2 && n <= 6 ? n : DEFAULT_LEVELS;
}

// Energy 0..1 → profile level 1..N = the grid row the curve is in
// (N equal rows, 1 = bottom).
export function levelOf(e, N) {
  const n = normLevels(N);
  return Math.min(n, 1 + Math.floor(clamp01(e) * n));
}

// levelOf, but only among levels that can actually supply tracks: when the
// curve's row has no genres, the level whose row centre is nearest to e
// (ties → the calmer level). null when nothing is available.
export function effectiveLevel(e, N, isAvailable) {
  const n = normLevels(N);
  const L0 = levelOf(e, n);
  if (isAvailable(L0)) return L0;
  let best = null, bestD = Infinity;
  for (let L = 1; L <= n; L++) {
    if (!isAvailable(L)) continue;
    const d = Math.abs((L - .5) / n - clamp01(e));
    if (d < bestD - 1e-9) { best = L; bestD = d; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

function snapDedupe(raw, group) {
  const slots = slotMinutes(group);
  const byM = new Map();
  for (const p of raw) {
    const m = Number(p?.m), e = Number(p?.e);
    if (!Number.isFinite(m) || !Number.isFinite(e)) continue;
    const s = snapMinute(group, m, slots);
    if (!byM.has(s)) byM.set(s, { m: s, e: round2(clamp01(e)) });
  }
  return [...byM.values()].sort((a, b) => a.m - b.m);
}

// The sandbox's 5-dot starting shape, placed on this group's slots.
export function defaultPoints(group) {
  const { openMin, total } = windowOf(group);
  return snapDedupe(DEFAULT_SHAPE.map(([p, e]) => ({ m: openMin + p * total, e })), group);
}

// Snap to the group's slots, drop duplicates / junk, clamp energy, cap at
// MAX_POINTS, top up to MIN_POINTS. Idempotent.
export function sanitizePoints(points, group) {
  let pts = snapDedupe(Array.isArray(points) ? points : [], group);
  if (pts.length > MAX_POINTS) pts = pts.slice(0, MAX_POINTS);
  if (!pts.length) return defaultPoints(group);
  if (pts.length < MIN_POINTS) {
    const { openMin, closeMin } = windowOf(group);
    const only = pts[0];
    pts.push({ m: only.m === closeMin ? openMin : closeMin, e: only.e });
    pts.sort((a, b) => a.m - b.m);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Reconciliation: stored timeline × current hours → one timeline per group
// ---------------------------------------------------------------------------

// Old group → new window, keeping CLOCK TIMES: a dot on the old opening /
// closing moves to the new opening / closing; any other dot keeps its
// wall-clock time if that's still inside the new window (trying ±1440 so a
// day ↔ overnight change still lines up), else it's dropped. When an edge dot
// lands on the same minute as a kept clock-time dot, the clock-time dot wins.
// Fewer than 2 left → the new edges are added with the old curve's energy.
function reconcileGroupPoints(src, G) {
  const o = windowOf(src), n = windowOf(G);
  if (o.openMin === n.openMin && o.closeMin === n.closeMin) return sanitizePoints(src.points, G);
  const oldCurve = energyAtFn(src.points);
  const out = new Map();
  for (const p of src.points) {
    let m = null, edge = false;
    if (p.m === o.openMin) { m = n.openMin; edge = true; }
    else if (p.m === o.closeMin) { m = n.closeMin; edge = true; }
    else {
      for (const c of [p.m, p.m - 1440, p.m + 1440]) {
        if (c >= n.openMin && c <= n.closeMin) { m = c; break; }
      }
    }
    if (m == null) continue;
    const prev = out.get(m);
    if (prev && !prev.edge && edge) continue;
    out.set(m, { m, e: p.e, edge });
  }
  const pts = [...out.values()].map(({ m, e }) => ({ m, e }));
  const clampOld = (m) => Math.max(o.openMin, Math.min(o.closeMin, m));
  if (pts.length < MIN_POINTS && !out.has(n.openMin)) pts.push({ m: n.openMin, e: oldCurve(clampOld(n.openMin)) });
  if (pts.length < MIN_POINTS && !out.has(n.closeMin)) pts.push({ m: n.closeMin, e: oldCurve(clampOld(n.closeMin)) });
  return sanitizePoints(pts, G);
}

function clockOverlap(a, b) {
  const A = windowOf(a), B = windowOf(b);
  let best = 0;
  for (const shift of [-1440, 0, 1440]) {
    best = Math.max(best, Math.min(A.closeMin, B.closeMin + shift) - Math.max(A.openMin, B.openMin + shift));
  }
  return best;
}

// Highest score tuple wins (lexicographic).
function pickBest(items, scoreFns) {
  let best = null, bestScore = null;
  for (const it of items) {
    const sc = scoreFns.map((f) => f(it));
    let better = !best;
    for (let i = 0; !better && i < sc.length; i++) {
      if (sc[i] > bestScore[i]) better = true;
      else if (sc[i] < bestScore[i]) break;
    }
    if (better) { best = it; bestScore = sc; }
  }
  return best;
}

// Stored value (v2, the sandbox's v1 { points:[{t,e}] }, junk, or null) →
// a clean list of { days, open, close, points } groups.
function coerceGroups(input, targetGroups) {
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input.groups)) {
    const out = [];
    for (const g of input.groups.slice(0, 7)) {
      if (!g || typeof g !== 'object') continue;
      const days = [...new Set((Array.isArray(g.days) ? g.days : []).map(Number))]
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      if (!days.length || parseHM(g.open) == null || parseHM(g.close) == null) continue;
      const group = { days, open: normHM(g.open), close: normHM(g.close) };
      const { openMin, total } = windowOf(group);
      const raw = (Array.isArray(g.points) ? g.points : []).slice(0, 50).map((p) => (
        p && p.m == null && p.t != null ? { m: openMin + Number(p.t) * total, e: p.e } : p));
      out.push({ ...group, points: sanitizePoints(raw, group) });
    }
    return out;
  }
  if (Array.isArray(input.points)) {
    // v1 (the sandbox's JSON): one relative shape → every current group.
    return targetGroups.map((G) => {
      const { openMin, total } = windowOf(G);
      const raw = input.points.slice(0, 50).map((p) => ({ m: openMin + Number(p?.t) * total, e: p?.e }));
      return { ...G, points: sanitizePoints(raw, G) };
    });
  }
  return [];
}

function pointsForGroup(G, old) {
  const shared = (o) => o.days.filter((d) => G.days.includes(d)).length;
  const sources = old.filter((o) => shared(o) > 0);
  let src = null;
  if (sources.length === 1) {
    src = sources[0];                                 // unchanged, or a split-off day
  } else if (sources.length > 1) {
    src = pickBest(sources, [                         // merge
      (o) => (o.open === G.open && o.close === G.close ? 1 : 0),
      shared,
      (o) => clockOverlap(o, G),
      (o) => -Math.min(...o.days),
    ]);
  } else if (old.length) {
    const cand = pickBest(old, [                      // brand-new group (its days were closed)
      (o) => clockOverlap(o, G),
      (o) => o.days.length,
      (o) => -Math.min(...o.days),
    ]);
    if (cand && clockOverlap(cand, G) > 0) src = cand;
  }
  return src ? reconcileGroupPoints(src, G) : defaultPoints(G);
}

// The timeline that applies to `hours`: exactly one group per distinct
// schedule, carrying over the stored dots (keep-clock-times rules above).
// Idempotent: reconcileTimeline(reconcileTimeline(x, h), h) deep-equals
// reconcileTimeline(x, h).
export function reconcileTimeline(input, hours) {
  const target = hoursGroups(hours);
  const old = coerceGroups(input, target);
  return {
    version: TIMELINE_VERSION,
    groups: target.map((G) => ({ days: G.days, open: G.open, close: G.close, points: pointsForGroup(G, old) })),
  };
}

export const groupForDay = (tl, dayIdx) => (tl?.groups || []).find((g) => g.days.includes(dayIdx)) || null;

// The group covering the most days (ties → earliest day). Used for closed-day
// ("המקום פתוח?") builds.
export const mainGroup = (tl) => pickBest(tl?.groups || [], [(g) => g.days.length, (g) => -Math.min(...g.days)]);

export function timelinesEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------------------------------------------------------------------------
// Business-day window (IL)
// ---------------------------------------------------------------------------

function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// UTC ISO for `mins` minutes after midnight IL of the given calendar date
// (mins may exceed 1440 — rolls into the next day).
export function ilIsoAt(date, mins) {
  const dayOff = Math.floor(mins / 1440);
  const rem = mins - dayOff * 1440;
  const d = addDays(date, dayOff);
  return ilWallClockToUtc({ ...d, hour: Math.floor(rem / 60), minute: rem % 60 }).toISOString();
}

// Where "now" sits in the venue's business day. Unlike the IL-calendar-day
// helpers in playlist-length.js, an overnight venue (Mon 18:00–02:00) at
// 01:00 Tuesday is still in MONDAY's window.
//   → { dayIdx, isoDate, dayStartIso, group:{open,close}|null,
//       openMin, closeMin, nowMin, phase, expiryIso }
//   phase: 'closed' | 'before-open' | 'open' | 'after-close'
//   minutes are relative to midnight of the basis day (nowMin may be > 1440).
export function businessWindowAt(hours, now = new Date()) {
  const il = ilPartsFromDate(now);
  const clock = il.hour * 60 + il.minute;
  const today = { year: il.year, month: il.month, day: il.day };

  let basis = { date: today, dayIdx: il.dayIdx, nowMin: clock };
  const yIdx = (il.dayIdx + 6) % 7;
  const y = dayHours(hours, yIdx);
  if (y) {
    const yw = windowOf(y);
    if (yw.closeMin > 1440 && clock + 1440 < yw.closeMin) {
      basis = { date: addDays(today, -1), dayIdx: yIdx, nowMin: clock + 1440 };
    }
  }

  const d = basis.date;
  const isoDate = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  const base = { dayIdx: basis.dayIdx, isoDate, dayStartIso: ilIsoAt(d, 0), nowMin: basis.nowMin };
  const group = dayHours(hours, basis.dayIdx);
  if (!group) return { ...base, group: null, openMin: null, closeMin: null, phase: 'closed', expiryIso: null };

  const { openMin, closeMin } = windowOf(group);
  const phase = basis.nowMin < openMin ? 'before-open' : basis.nowMin < closeMin ? 'open' : 'after-close';
  return { ...base, group, openMin, closeMin, phase, expiryIso: ilIsoAt(d, closeMin + EXPIRY_BUFFER_MINS) };
}
