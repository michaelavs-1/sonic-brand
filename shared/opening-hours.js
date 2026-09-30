// Opening-hours rules for v7 — one source for the browser (the hours editor
// in onboarding + the Profile tab) and the server (signup, update-hours).
//
// A day's hours are valid when the closing time is after the opening time, or
// — for a venue that closes after midnight — the closing time is no later than
// 06:00 (so 20:00–02:00 is fine, 15:00–14:00 is not). A day is also capped at
// 20 hours, so "opens half an hour after it closes" (06:30–06:00) is refused
// too. Without these, an overnight window swallows the next day's opening:
// businessWindowAt (v7/generation/energy-timeline.js) would keep treating the
// next morning as the previous business day.
//
// Server-reachable: bare imports only, no ?v= on imports inside this file.

export const LATEST_AFTER_MIDNIGHT_CLOSE = '06:00';
export const MAX_DAY_HOURS = 20;

const LATEST_AFTER_MIDNIGHT_MIN = 6 * 60;
const MAX_DAY_MIN = MAX_DAY_HOURS * 60;

export const DAY_NAMES_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function parseTime(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Hebrew "a, b ו־c" — the conjunction attaches to the last item.
function joinHe(items) {
  if (items.length < 2) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} ו${items[items.length - 1]}`;
}

// Hebrew description of what's wrong with one day's open/close, or null.
export function dayHoursProblem(open, close) {
  const o = parseTime(open);
  const c = parseTime(close);
  if (o == null || c == null) return 'שעה לא תקינה';
  if (o === c) return 'שעת הפתיחה ושעת הסגירה זהות';
  if (c < o && c > LATEST_AFTER_MIDNIGHT_MIN) {
    return `שעת הסגירה מוקדמת משעת הפתיחה (סגירה אחרי חצות — עד ${LATEST_AFTER_MIDNIGHT_CLOSE})`;
  }
  const total = c > o ? c - o : c + 1440 - o;
  if (total > MAX_DAY_MIN) return `יותר מ־${MAX_DAY_HOURS} שעות פתיחה ביום`;
  return null;
}

// Every problem in a week's hours ({0..6: {closed} | {open, close}}), grouped
// by message: [{ days: [dayIdx], message, text }] where text reads
// "ראשון ושני: …". Closed / missing days are skipped.
export function hoursProblems(hours) {
  const byMessage = new Map();
  for (let d = 0; d < 7; d++) {
    const h = hours && typeof hours === 'object' ? (hours[d] ?? hours[String(d)]) : null;
    if (!h || h.closed) continue;
    const message = dayHoursProblem(h.open, h.close);
    if (!message) continue;
    if (!byMessage.has(message)) byMessage.set(message, []);
    byMessage.get(message).push(d);
  }
  return [...byMessage].map(([message, days]) => ({
    days,
    message,
    text: `${joinHe(days.map((d) => DAY_NAMES_HE[d]))}: ${message}`,
  }));
}

// All problems as one Hebrew string (one line each), or null when valid.
export function hoursProblem(hours) {
  const list = hoursProblems(hours);
  return list.length ? list.map((p) => p.text).join('\n') : null;
}
