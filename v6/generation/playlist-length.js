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
