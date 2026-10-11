/* /api/v7/account/daily-status.js
   Why the Home tab has no daily playlists right now — the line under
   "לא נוצרו פלייליסטים" — and the owner's "דווחו" report (2026-10-06).

     GET ?business_id=<uuid>  → { reason, hasLive }
       reason:
         null                 nothing to explain (live playlists exist, or no
                              daily-playlist type chosen yet)
         'subscription-ended' the cancelled subscription has run out
         'closed'             closed today
         'after-close'        today is over (playlists expire 2h after closing)
         'needs-directions'   Option 1 without its directions — the cron can't
                              build; the owner's "השלימו עכשיו" can
         'before-build'       before the run that builds today's set
         'building'           that run is going now (or due a few minutes ago)
         'error'              the run should have built them and didn't
       hasLive: today's daily playlists exist — a dashboard that shows none
                reloads (e.g. the cron built them while the page was open).

     POST { business_id, action: 'report' }  → { ok: true }
       Emails OPS_EMAIL_TO everything we know: today's build log (with the
       errors), hours, type, directions, Spotify pause, the computed reason.

   "When does the cron build?" mirrors api/cron/v7-generate-daily.js: hourly
   at :00, at the first run within BUILD_LEAD_MINUTES of opening.

   Auth: owner JWT, checked in parallel with the reads; nothing is returned
   unless the business's owner_id is the logged-in user.
*/

import { pgrSelect } from '../../v5/supabase-client.js';
import { setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { runningCrons } from '../../_cron-running.js';
import { verifyUser, readHours, readSettings } from './_settings-helpers.js';
import { subscriptionEnded } from './_subscription.js';
import { readBuildLog, BUILD_LEAD_MINUTES } from './_build-log.js';
import { emailOps, ilDate } from '../_ops-email.js';
import { businessWindowAt } from '../../../v7/generation/energy-timeline.js';
import { ilPartsFromDate } from '../../../v7/generation/playlist-length.js';

// After the cron's due run, how long "building" is assumed before a missing
// set counts as an error (the run starts a little late and goes business by
// business, a few seconds each).
const BUILD_GRACE_MIN = 10;
const FAILED_OUTCOMES = new Set(['zero-built', 'build-failed', 'outer-throw', 'no-directions', 'no-genres',
  'no-hours', 'bad-hours', 'no-taste-profile']);

const REASON_HE = {
  'subscription-ended': 'המנוי הסתיים',
  'closed':             'המקום סגור היום',
  'after-close':        'היום הסתיים',
  'needs-directions':   'הכנת הפלייליסטים לא הושלמה (אין כיווני אפשרות 1)',
  'before-build':       'לפני זמן הבנייה',
  'building':           'נבנים עכשיו',
  'error':              'שגיאה',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readBusiness(businessId) {
  const rows = await pgrSelect('businesses', { id: `eq.${businessId}` },
    { select: 'id,name,owner_id', limit: 1, useService: true });
  return rows?.[0] || null;
}

async function liveDailyRows(businessId, now) {
  const rows = await pgrSelect('business_playlists',
    { business_id: `eq.${businessId}`, event_id: 'is.null', expires_at: `gt.${now.toISOString()}` },
    { select: 'spotify_id', limit: 10, useService: true });
  return Array.isArray(rows) ? rows : [];
}

async function hasOption1Directions(businessId) {
  const rows = await pgrSelect('business_v7_directions', { business_id: `eq.${businessId}`, active: 'is.true' },
    { select: 'id', limit: 1, useService: true });
  return Array.isArray(rows) && rows.length > 0;
}

// The minute (of the business day) of the cron run that builds the day.
function buildTickMin(openMin) {
  return Math.max(0, Math.ceil((openMin - BUILD_LEAD_MINUTES) / 60) * 60);
}

// Everything in one parallel batch (the dashboard waits on this to show its
// "no playlists" line) — run alongside the login check. The caller checks
// biz.owner_id against the logged-in user before using anything else.
async function computeStatus(businessId, now = new Date()) {
  const [biz, settings, hours, ended, live, hasDirections, running, log] = await Promise.all([
    readBusiness(businessId),
    readSettings(businessId),
    readHours(businessId),
    subscriptionEnded(businessId, now),
    liveDailyRows(businessId, now),
    hasOption1Directions(businessId).catch(() => true),   // a read error never claims "missing"
    runningCrons(),
    readBuildLog(businessId, new Date(now.getTime() - 30 * 3600 * 1000).toISOString(), 5),
  ]);
  const mode = settings?.delivery_mode || null;
  const w = hours ? businessWindowAt(hours, now) : null;
  const facts = { mode, hours, w, live: live.length };
  const done = (reason) => ({ biz, reason, hasLive: live.length > 0, facts });

  if (!biz || !mode) return done(null);
  if (ended) return done('subscription-ended');
  if (live.length) return done(null);
  if (!w) return done('error');
  if (w.phase === 'closed') return done('closed');
  if (w.phase === 'after-close') return done('after-close');
  if (mode === 'option1' && !hasDirections) return done('needs-directions');

  const tick = buildTickMin(w.openMin);
  facts.tickMin = tick;
  if (w.nowMin < tick) return done('before-build');
  if (running.includes('v7-daily')) return done('building');
  // A run that already failed today (this business day) → error now, no grace.
  const dayFrom = Date.parse(w.dayStartIso) - 3 * 3600 * 1000;
  const lastToday = (log || []).find((r) => Date.parse(r.created_at) >= dayFrom);
  if (lastToday && FAILED_OUTCOMES.has(lastToday.outcome)) return done('error');
  if (w.nowMin < tick + BUILD_GRACE_MIN) return done('building');
  return done('error');
}

// Spotify's global pause (api/new/spotify.js) → epoch ms, or null.
async function spotifyPausedUntil() {
  const url   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', 'spotify:pause_until']]),
    });
    const until = parseInt((await r.json())?.[0]?.result, 10);
    return until > Date.now() ? until : null;
  } catch { return null; }
}

const pad = (n) => String(n).padStart(2, '0');
function ilClock(d) {
  const p = ilPartsFromDate(d);
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}
const hhmm = (min) => `${pad(Math.floor((min % 1440) / 60))}:${pad(min % 60)}`;

async function sendReport({ biz, user, status, now }) {
  const businessId = biz.id;
  const { facts } = status;
  const since = facts.w ? new Date(Date.parse(facts.w.dayStartIso) - 3 * 3600 * 1000).toISOString()
    : new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const [log, pausedUntil, running, taste, dirs, levelDirs, todays] = await Promise.all([
    readBuildLog(businessId, since, 20),
    spotifyPausedUntil(),
    runningCrons(),
    pgrSelect('business_taste_profiles', { business_id: `eq.${businessId}` },
      { select: 'approved_genres', limit: 1, useService: true }).catch(() => null),
    pgrSelect('business_v7_directions', { business_id: `eq.${businessId}`, active: 'is.true' },
      { select: 'id', limit: 50, useService: true }).catch(() => null),
    pgrSelect('business_v7_level_directions', { business_id: `eq.${businessId}`, active: 'is.true' },
      { select: 'id', limit: 100, useService: true }).catch(() => null),
    pgrSelect('business_playlists', { business_id: `eq.${businessId}`, event_id: 'is.null', created_at: `gte.${since}` },
      { select: 'label,created_at,expires_at', order: 'created_at.desc', limit: 20, useService: true }).catch(() => null),
  ]);

  const w = facts.w;
  const dayLine = !w ? 'אין שעות פעילות שמורות'
    : w.phase === 'closed' ? 'סגור היום'
    : `${hhmm(w.openMin)}–${hhmm(w.closeMin)}${facts.tickMin != null ? ` (הקרון בונה ב-${hhmm(facts.tickMin)})` : ''}`;
  const modeLine = facts.mode === 'option1' ? 'אפשרות 1 (4 ביום)' : facts.mode === 'option2' ? 'אפשרות 2 (2 ביום, ציר אנרגיה)' : 'לא נבחר';

  const logLines = log == null ? ['(היומן לא זמין — המיגרציה 2026-10-06-v7-daily-build-log.sql לא הורצה?)']
    : !log.length ? ['(אין רשומות להיום — לא נעשה ניסיון בנייה)']
    : log.flatMap((r) => [
      `${ilClock(new Date(r.created_at))} · ${r.source} · ${r.outcome} · נבנו ${r.built}, נכשלו ${r.failed}`,
      ...(r.detail ? String(r.detail).split('\n').map((l) => `    ${l}`) : []),
    ]);

  return emailOps({
    subject: `דיווח: פלייליסטים יומיים לא נוצרו — ${biz.name || businessId}`,
    lines: [
      'בעל עסק לחץ "דווחו" — הפלייליסטים היומיים לא נוצרו.',
      '',
      `עסק: ${biz.name || '(ללא שם)'}`,
      `אימייל: ${user.email || '—'}`,
      `מזהה עסק: ${businessId}`,
      `זמן הדיווח: ${ilClock(now)} (שעון ישראל)`,
      `יום עסקים: ${w ? ilDate(w.isoDate) : '—'} · ${dayLine}`,
      `סוג פלייליסטים: ${modeLine}`,
      `מה הדשבורד מציג: ${REASON_HE[status.reason] || status.reason || '—'}`,
      `סגנונות מאושרים בפרופיל הטעם: ${taste?.[0]?.approved_genres?.length ?? 'אין פרופיל'}`,
      `כיווני אפשרות 1 פעילים: ${dirs ? dirs.length : '?'} · כיווני רמות (אפשרות 2): ${levelDirs ? levelDirs.length : '?'}`,
      `Spotify: ${pausedUntil ? `מושהה עד ${ilClock(new Date(pausedUntil))}` : 'לא מושהה'}`,
      `קרון רץ עכשיו: ${running.length ? running.join(', ') : 'לא'}`,
      `פלייליסטים יומיים מהיום: ${todays ? todays.length : '?'} (חיים: ${facts.live})`,
      '',
      'יומן בנייה היום:',
      ...logLines,
    ],
  });
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const isReport = req.method === 'POST';
  if (!await guard(req, res, isReport ? 'v7-daily-report' : 'v7-daily-status', isReport ? 5 : 60, isReport ? 3600 : 60)) return;

  try {
    const businessId = isReport ? req.body?.business_id : String(req.query?.business_id || '');
    if (!UUID_RE.test(String(businessId || ''))) return res.status(400).json({ error: 'business_id required' });
    // The login check and the reads at the same time (one round trip instead
    // of two); nothing read is used or returned unless both checks pass.
    const now = new Date();
    const [user, status] = await Promise.all([verifyUser(req), computeStatus(businessId, now)]);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const { biz } = status;
    if (!biz || biz.owner_id !== user.id) return res.status(403).json({ error: 'not your business' });

    if (!isReport) return res.status(200).json({ reason: status.reason, hasLive: status.hasLive });

    if (req.body?.action !== 'report') return res.status(400).json({ error: 'action must be report' });
    const sent = await sendReport({ biz, user, status, now });
    console.log(`[v7 daily-status] report for biz ${businessId} (${status.reason}) — sent=${sent}`);
    if (!sent) return res.status(502).json({ error: 'לא הצלחנו לשלוח את הדיווח — נסו שוב בעוד רגע' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[v7 daily-status] failed:', err.message);
    return res.status(500).json({ error: 'משהו השתבש — נסו שוב' });
  }
}
