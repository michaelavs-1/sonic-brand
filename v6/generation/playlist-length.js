// Playlist-length math for daily playlists.
//
// Two cases:
//   1. Regular daily playlist (open day) → today's opening hours + 1h buffer.
//   2. Closed-day playlist (user opted in via "המקום פתוח?" on a closed day)
//      → a flat 12h general length. We deliberately do NOT ask the user for a
//      length here — closed-day generation is a one-off convenience, so a
//      generic 12h target is used instead of a per-day figure.
//
// Callers:
//   - v6/account/app.js sizes the onboarding-sample expansion for "today".
//   - api/v6/account/generate-daily.js uses closedDayTargetTracks() for the
//     closed-day flow.
//   - Future daily-gen cron will use computeTargetForToday() with the venue's
//     hours for the calendar day being generated.
//
// Timezone note: `computeTargetForToday` calls `now.getDay()` which uses the
// runtime's local timezone. In the browser that's the venue owner's own
// timezone (correct for this Israel-focused app). Server-side callers must
// pass a Date already shifted into the venue's timezone.

export const AVG_TRACK_MINUTES  = 3.5;
export const BUFFER_MINUTES     = 60;
// 12h general length used when today is closed but we still want playlists
// (either landing on the dashboard for the first time on a closed day, or the
// user explicitly clicked "המקום פתוח?" on a non-onboarding closed day).
export const CLOSED_DAY_MINUTES = 12 * 60;
// Floor so a very short day (e.g. Friday 10-14 = 4h → ~86 tracks) doesn't
// fall below the onboarding sample size.
export const MIN_TARGET_TRACKS  = 10;

// Convert an "open minutes" figure into a track count.
// dayMinutes = raw minutes the venue is open that day (or CLOSED_DAY_MINUTES
// for the closed-day flow). Adds BUFFER_MINUTES and rounds up.
export function computeTargetTracks(dayMinutes) {
  const mins  = Number.isFinite(dayMinutes) && dayMinutes > 0 ? dayMinutes : CLOSED_DAY_MINUTES;
  const total = mins + BUFFER_MINUTES;
  return Math.max(MIN_TARGET_TRACKS, Math.ceil(total / AVG_TRACK_MINUTES));
}

// Returns minutes the venue is open on `dayIdx` (0=Sunday…6=Saturday):
//   - 0        if that day is marked closed
//   - null     if hours object is missing / lacks that day
//   - integer  otherwise
// Mirrors the arithmetic in v6/hours-selector.js collectHours().
export function dayMinutesFromHours(hours, dayIdx) {
  if (!hours || typeof hours !== 'object') return null;
  const h = hours[dayIdx];
  if (!h) return null;
  if (h.closed) return 0;
  const [oh, om] = String(h.open  || '10:00').split(':').map(Number);
  const [ch, cm] = String(h.close || '22:00').split(':').map(Number);
  let mins = (ch * 60 + cm) - (oh * 60 + om);
  if (mins <= 0) mins += 24 * 60;
  return mins;
}

// Regular daily target: today's opening hours + 1h buffer.
// If today is closed (or hours unknown), fall back to CLOSED_DAY_MINUTES so
// the onboarding-day-is-closed case still produces a full-length playlist.
export function computeTargetForToday({ hours, now = new Date() } = {}) {
  const idx    = now.getDay();
  const today  = dayMinutesFromHours(hours, idx);
  const chosen = (today && today > 0) ? today : CLOSED_DAY_MINUTES;
  return computeTargetTracks(chosen);
}

// Explicit closed-day target — 12h + 1h buffer. Used by the "המקום פתוח?"
// flow on days the venue is marked closed.
export function closedDayTargetTracks() {
  return computeTargetTracks(CLOSED_DAY_MINUTES);
}

// -------- direction key --------
// Stable string identifier for a musical direction, used to look up per-biz
// track-serve history in the v6_daily_track_history table. Derived from the
// full sorted genre list + BPM range: same direction (same genre set + BPM)
// across days → same key → history dedup works. Title_en can be regenerated
// with wording tweaks so it's not part of the key.
//
// Backward-compat: legacy directions stored `anchor_genre` + `secondary_genres`
// instead of a flat `genres` list. We accept either shape and derive the
// same key. Note: pre-refactor rows in v6_daily_track_history were keyed on
// anchor_genre alone (no secondaries in the key); after the refactor, keys
// include the full sorted set. Old history rows won't match new keys — a
// few days of possible track repeats before the new history fills in.
export function directionKey(direction) {
  const bpm = direction?.bpm_range || {};
  const genres = Array.isArray(direction?.genres) && direction.genres.length
    ? direction.genres
    : [direction?.anchor_genre, ...(direction?.secondary_genres || [])].filter(Boolean);
  const genrePart = genres.map((g) => String(g).toLowerCase()).sort().join('|');
  return `${genrePart}|${bpm.min ?? '?'}-${bpm.max ?? '?'}`;
}

// -------- daily-playlist expiry --------
// All venues are in Israel today; timezone is hardcoded here as a single
// future config point. When venues outside IL become a thing, pass this per
// business instead.
export const VENUE_TZ           = 'Asia/Jerusalem';
export const EXPIRY_BUFFER_MINS = 120;

const IL_WEEKDAY_TO_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Extract IL-local date parts + weekday from any Date instance.
export function ilPartsFromDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: VENUE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return {
    year:    Number(parts.year),
    month:   Number(parts.month),
    day:     Number(parts.day),
    hour:    Number(parts.hour === '24' ? '00' : parts.hour),
    minute:  Number(parts.minute),
    dayIdx:  IL_WEEKDAY_TO_IDX[parts.weekday],
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// UTC offset in MINUTES for a given UTC instant, evaluated in Asia/Jerusalem.
// Positive = ahead of UTC (IL is UTC+2 in winter, +3 in summer).
// Uses Intl.DateTimeFormat.formatToParts with `timeZoneName: 'shortOffset'`,
// which returns strings like "GMT+3" / "GMT+03:00" / "GMT" — normalize both.
function ilOffsetMinutes(utcInstant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: VENUE_TZ,
    timeZoneName: 'shortOffset',
  }).formatToParts(utcInstant);
  const tag = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = tag.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const h    = Number(m[2]);
  const mm   = Number(m[3] || 0);
  return sign * (h * 60 + mm);
}

// Convert a wall-clock instant IN IL (year/month/day/hour/minute as the venue
// owner would read them on the clock) to a UTC Date. DST-safe: uses the
// offset that applies at that specific composed instant, not at "now".
function ilWallClockToUtc({ year, month, day, hour, minute }) {
  // First pass: pretend the wall-clock is UTC so we have a candidate instant.
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Ask IL what offset applies at that instant. Subtracting the offset from
  // the guess gives the true UTC instant. One iteration is enough because
  // the offset doesn't change within a 24h window except on the DST
  // transition day, and even there a second pass would converge — we do a
  // second pass to be safe.
  const off1 = ilOffsetMinutes(new Date(guess));
  const cand = guess - off1 * 60 * 1000;
  const off2 = ilOffsetMinutes(new Date(cand));
  return new Date(guess - off2 * 60 * 1000);
}

// Returns the UTC ISO string for the NEXT 04:00 Asia/Jerusalem strictly
// after `now`. Used by event playlists and closed-day manual playlists —
// one-offs we keep visible through the night but sweep before the morning
// so the dashboard doesn't accumulate stale entries.
//
// Boundary: at exactly 04:00 IL, we roll to the next day (24h later).
export function nextIl4amIso({ now = new Date() } = {}) {
  const il      = ilPartsFromDate(now);
  const nowMins = il.hour * 60 + il.minute;
  const target  = 4 * 60;
  let year = il.year, month = il.month, day = il.day;
  if (nowMins >= target) {
    // 04:00 IL today already passed → +1 IL calendar day.
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year  = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day   = next.getUTCDate();
  }
  return ilWallClockToUtc({ year, month, day, hour: 4, minute: 0 }).toISOString();
}

// Returns the UTC ISO string for "closing time + 2h" in IL local time, for
// the calendar day at IL now. Returns null when today is closed or hours
// are missing (caller falls back to 24h TTL).
//
// Overnight-wrap handling: if close <= open (e.g. open 20:00, close 02:00),
// the close is on the FOLLOWING IL calendar day.
export function dailyPlaylistExpiryIso({ hours, now = new Date() } = {}) {
  if (!hours || typeof hours !== 'object') return null;
  const il = ilPartsFromDate(now);
  const h  = hours[il.dayIdx];
  if (!h || h.closed) return null;

  const [oh, om] = String(h.open  || '10:00').split(':').map(Number);
  const [ch, cm] = String(h.close || '22:00').split(':').map(Number);
  if (![oh, om, ch, cm].every(Number.isFinite)) return null;

  const openMins  = oh * 60 + om;
  const closeMins = ch * 60 + cm;
  const wrapsOvernight = closeMins <= openMins;

  // Compose the close wall-clock. Start from IL "today"; if wrap, add a day.
  let year = il.year, month = il.month, day = il.day;
  let expiryTotalMins = closeMins + EXPIRY_BUFFER_MINS;
  if (wrapsOvernight) expiryTotalMins += 24 * 60;

  // Roll overflow days if expiry crosses midnight (e.g. close 23:00 + 2h → 25:00 = next day 01:00).
  while (expiryTotalMins >= 24 * 60) {
    expiryTotalMins -= 24 * 60;
    // Add one day using UTC arithmetic to avoid IL/DST weirdness in the
    // component walker; ilWallClockToUtc handles the DST offset separately.
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year  = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day   = next.getUTCDate();
  }
  const hour   = Math.floor(expiryTotalMins / 60);
  const minute = expiryTotalMins % 60;

  return ilWallClockToUtc({ year, month, day, hour, minute }).toISOString();
}
