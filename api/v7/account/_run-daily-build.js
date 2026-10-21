/* /api/v7/account/_run-daily-build.js
   Today's daily-playlist build for one v7 business, shared by:
     - generate-daily.js       (the owner's dashboard: first-login build,
                                "צור פלייליסטים", "המקום פתוח?", "החליפו עכשיו",
                                "צור פלייליסטים עכשיו")
     - api/internal/daily-picks.js  (the admin console's "rebuild today",
                                2026-10-13: admin: true — not counted toward
                                the owner's 2 replacements a day, audited
                                under its own field)
   Moved out of generate-daily.js unchanged on 2026-10-13; the behaviour
   (incl. the ndjson events) is documented there.

   runDailyBuild(opts, { beforeStream, send })
     opts: { businessId, ownerId, bizName, replaceToday, openNow, origin,
             admin?, now? }
     Refusals before anything is built → { status, body } (nothing sent).
     Otherwise calls beforeStream() once, streams the events through send(obj)
     and → { done: { built, failed } }.
   Takes the per-business build lock itself and always releases it.

   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect, pgrPatch } from '../../v5/supabase-client.js';
import { buildOneDailyPlaylist } from '../../v6/account/_daily-builder.js';
import { postSpotify } from '../../v6/account/_expire-playlist.js';
import { subscriptionEnded, SUBSCRIPTION_ENDED_MESSAGE } from './_subscription.js';
import { logDailyBuilds } from './_build-log.js';
import { planOption1, planOption2, attachTrackGenres, insertPlaylistRows } from './_daily-builder.js';
import { planOption2Timeline, createTimelineMix } from './_option2-builder.js';
import { replaceStatus, liveDailyRows, businessDaySinceIso, REPLACE_FIELD } from './_replace-status.js';
import { acquireBuildLock } from './_build-lock.js';
import { auditSetting } from './_settings-helpers.js';
import { businessWindowAt } from '../../../v7/generation/energy-timeline.js';
import { datedLabel, undatedLabel, ilPartsFromDate } from '../../../v7/generation/playlist-length.js';

const INTER_PLAYLIST_STAGGER_MS = 3000;   // same as _daily-builder.js BUILD_STAGGER_MS

// The admin console's rebuilds are audited under their own field, so they
// don't count toward the owner's REPLACE_CAP.
export const ADMIN_REPLACE_FIELD = 'daily_playlists_replaced_by_admin';
// Added to an old playlist's Spotify name when "replace now" replaces it.
const REPLACED_SUFFIX = ' (הוחלף)';

const NOTHING_TO_BUILD = {
  'no-directions':          'הכנת הפלייליסטים שלכם לא הושלמה — לחצו על "השלימו עכשיו" בדף הבית',
  'no-approved-genres':     'לא נמצא פרופיל מוזיקלי לבניית פלייליסטים',
  'directions-read-failed': 'שגיאה בטעינת הנתונים — נסו שוב',
  'past-close':             'היום כבר כמעט נגמר — הפלייליסטים הבאים ייבנו מחר',
  'closed-today':           'המקום סגור היום',
};

const CODE_MESSAGES = {
  'build-in-progress':  'כבר נבנים פלייליסטים — נסו שוב בעוד רגע',
  'replace-cap':        'הגעתם למקסימום של 2 החלפות ביום — השינוי ייכנס לתוקף מחר',
  'past-close':         'היום כבר כמעט נגמר — השינוי ייכנס לתוקף מחר',
  'closed-today':       'המקום סגור היום — השינוי ייכנס לתוקף ביום הפתיחה הבא',
  'nothing-to-replace': 'אין פלייליסטים להיום להחלפה',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The hours with day `dayIdx` opening at `now` (Israel clock, to the minute).
function hoursOpeningNow(hours, dayIdx, now) {
  const p = ilPartsFromDate(now);
  const open = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return { ...hours, [dayIdx]: { ...hours[dayIdx], open } };
}

// Today's slots as { key, title, label, build() → {skipped, reason?, row?} }.
// title = the undated name ("Daily Mix #1"), label = the dated dashboard name
// ("Daily Mix #1 · 28.09.2026") the built row carries.
async function planSlots({ mode, businessId, hours, now, replaceToday, origin, ownerId, bizName }) {
  if (mode === 'option2') {
    const plan = await planOption2Timeline({ businessId, hours, now, onDemand: true });
    if (!plan.fallback) {
      if (!plan.slots.length) return { slots: [], reason: plan.reason };
      return {
        reason: null,
        slots: plan.slots.map((s) => ({
          key: s.key,
          title: s.title,
          label: datedLabel(s.title, plan.meta?.il_date),
          build: () => createTimelineMix({
            origin, ownerId, businessId, bizName, title: s.title, tracks: s.tracks, expiryIso: plan.expiryIso, meta: s.meta,
          }),
        })),
      };
    }
  }
  const plan = mode === 'option1'
    ? await planOption1({ businessId, hours, now, onDemand: true, fromNow: replaceToday })
    : await planOption2({ businessId, hours, now, onDemand: true });   // naive fallback
  if (!plan.directions.length) return { slots: [], reason: plan.reason };
  return {
    reason: null,
    slots: plan.directions.map((direction, i) => ({
      key: `slot-${i}`,
      title: direction.title_en || 'פלייליסט',
      label: datedLabel(direction.title_en || 'פלייליסט', plan.labelDate),
      build: async () => {
        const r = await buildOneDailyPlaylist({
          origin, ownerId, businessId, direction, target: plan.target, bizName, expiryIso: plan.expiryIso,
        });
        if (!r.skipped) {
          r.row.label = datedLabel(r.row.label, plan.labelDate);
          await attachTrackGenres(r.row);
        }
        return r;
      },
    })),
  };
}

export async function runDailyBuild(opts, { beforeStream = () => {}, send }) {
  const { businessId, ownerId, bizName = '', replaceToday = false, openNow = false, origin, admin = false } = opts;
  const source = admin ? 'admin' : 'dashboard';
  const tag = admin ? '[v7 admin-build]' : '[v7 generate-daily]';
  const refuse = (status, error, code) => ({ status, body: { error, ...(code ? { code } : {}) } });

  if (await subscriptionEnded(businessId)) {
    return refuse(402, SUBSCRIPTION_ENDED_MESSAGE, 'subscription_ended');
  }

  const [settingsRows, hoursRows] = await Promise.all([
    pgrSelect('business_v7_settings',
      { business_id: `eq.${businessId}` },
      { select: 'delivery_mode', limit: 1, useService: true }),
    pgrSelect('business_hours',
      { business_id: `eq.${businessId}` },
      { select: 'hours', limit: 1, useService: true }),
  ]);
  const mode  = settingsRows?.[0]?.delivery_mode || null;
  const hours = hoursRows?.[0]?.hours || null;
  if (mode !== 'option1' && mode !== 'option2') {
    return refuse(400, 'בחרו קודם סוג פלייליסטים יומיים (בלשונית הפרופיל)', 'no-delivery-mode');
  }

  const lock = await acquireBuildLock(businessId);
  if (!lock.acquired) return refuse(409, CODE_MESSAGES['build-in-progress'], 'build-in-progress');
  try {
    const now = opts.now || new Date();
    const w = businessWindowAt(hours, now);
    let oldRows = [];
    if (replaceToday) {
      const status = await replaceStatus({ businessId, hours, now });
      if (!status.eligible) {
        const code = status.reason === 'no-live-playlists' ? 'nothing-to-replace' : status.reason;
        return refuse(409, CODE_MESSAGES[code] || CODE_MESSAGES['past-close'], code);
      }
      if (status.left <= 0 && !admin) {
        return refuse(429, CODE_MESSAGES['replace-cap'], 'replace-cap');
      }
      oldRows = await liveDailyRows(businessId, businessDaySinceIso(w), now);
    } else {
      // One live set per business day (the owner's build also fires
      // automatically right after the first-login gate — guard a
      // reload-and-click double). Live rows only: once today's set has
      // expired, a fresh one may still be built.
      const live = await liveDailyRows(businessId, businessDaySinceIso(w), now);
      if (live.length) return refuse(409, 'כבר יש פלייליסטים להיום', 'already-built');
    }

    // "צור פלייליסטים עכשיו" before opening: this build acts as though today
    // opens now — Option 1 sizes the playlists from now to closing, Option 2
    // starts its mixes now and moves the curve's opening dot to now (the
    // usual keep-clock-times rule for an hours change). The stored hours stay
    // as they are; the cron then skips the day (already built).
    const buildHours = openNow && !replaceToday && w.phase === 'before-open'
      ? hoursOpeningNow(hours, w.dayIdx, now) : hours;

    const { slots, reason } = await planSlots({
      mode, businessId, hours: buildHours, now, replaceToday, origin, ownerId, bizName,
    });
    if (!slots.length) {
      await logDailyBuilds([{
        business_id: businessId, il_date: w.isoDate, source, outcome: `nothing-to-build:${reason || '?'}`,
      }]);
      return refuse(400, NOTHING_TO_BUILD[reason] || 'אין מה לבנות כרגע', reason || undefined);
    }

    // ---- streaming phase ----
    beforeStream();
    send({ type: 'plan', directions: slots.map((s) => ({ direction_id: s.key, title: s.label })) });

    const plannedTitles = new Set(slots.map((s) => s.title));
    const pendingOld = new Map(oldRows.map((r) => [r.spotify_id, r]));
    // The old playlists' names on Spotify (the ledger has them).
    const spotifyName = new Map();
    if (oldRows.length) {
      try {
        const led = await pgrSelect('created_playlists',
          { spotify_id: `in.(${oldRows.map((r) => `"${r.spotify_id}"`).join(',')})` },
          { select: 'spotify_id,name', useService: true });
        for (const l of led || []) spotifyName.set(l.spotify_id, l.name);
      } catch (e) {
        console.warn(`${tag} reading the old playlists' names failed:`, e.message);
      }
    }
    // Each old playlist leaves the dashboard as its replacement lands. On
    // Spotify (Ami, 2026-10-21 — owners who saved the playlists saw 8 with the
    // same names until closing + 2h) it's renamed "… (הוחלף)" right away and
    // handed to the next hourly expire sweep (:30), so it's gone within the
    // hour. Its songs keep playing until then.
    const hideOld = async (rows) => {
      if (!rows.length) return;
      const nowIso = new Date().toISOString();
      const hidden = [];
      for (const r of rows) {
        try {
          await pgrPatch('business_playlists',
            { spotify_id: `eq.${r.spotify_id}`, business_id: `eq.${businessId}` }, { expires_at: nowIso });
          hidden.push(r.spotify_id);
        } catch (e) {
          console.warn(`${tag} hiding old playlist ${r.spotify_id} failed:`, e.message);
        }
        try {
          await pgrPatch('created_playlists', { spotify_id: `eq.${r.spotify_id}` }, { expires_at: nowIso });
        } catch (e) {
          console.warn(`${tag} handing old playlist ${r.spotify_id} to the expire sweep failed:`, e.message);
        }
        const name = spotifyName.get(r.spotify_id);
        if (name && !name.endsWith(REPLACED_SUFFIX)) {
          try {
            await postSpotify(origin, 'update_playlist', { playlist_id: r.spotify_id, name: `${name}${REPLACED_SUFFIX}` });
          } catch (e) {
            console.warn(`${tag} renaming old playlist ${r.spotify_id} failed:`, e.message);
          }
        }
        pendingOld.delete(r.spotify_id);
      }
      if (hidden.length) send({ type: 'replaced', spotify_ids: hidden });
    };

    let builtCount = 0;
    let failedCount = 0;
    const failures = [];   // for the build log
    for (let i = 0; i < slots.length; i++) {
      if (i > 0) await sleep(INTER_PLAYLIST_STAGGER_MS);
      const slot = slots[i];
      try {
        const result = await slot.build();
        if (result.skipped) {
          failedCount++;
          failures.push(`${slot.title}: ${result.reason || 'no tracks matched'}`);
          send({ type: 'failed', direction_id: slot.key, error: result.reason || 'no tracks matched' });
          continue;
        }
        try {
          await insertPlaylistRows([result.row]);
        } catch (e) {
          // The Spotify playlist exists (and is in the expiry ledger); only the
          // dashboard row failed. Report it and keep going.
          console.error(`${tag} business_playlists INSERT failed for ${result.row.spotify_id}:`, e.message);
          failedCount++;
          failures.push(`${slot.title}: db insert failed: ${e.message}`);
          send({ type: 'failed', direction_id: slot.key, error: `db insert failed: ${e.message}` });
          continue;
        }
        builtCount++;
        send({ type: 'built', direction_id: slot.key, row: result.row });

        if (replaceToday) {
          if (builtCount === 1) {
            // Counts toward today's cap only once something was actually built
            // (an admin rebuild is audited under its own field — never counted).
            await auditSetting(businessId, admin ? ADMIN_REPLACE_FIELD : REPLACE_FIELD,
              { mode, playlists: oldRows.map((r) => ({ spotify_id: r.spotify_id, label: r.label })) },
              { mode, titles: [...plannedTitles] });
            // Type switch: old names don't match the new ones → all go now.
            await hideOld([...pendingOld.values()].filter((r) => !plannedTitles.has(undatedLabel(r.label))));
          }
          // Names match without the date (older rows may carry none).
          await hideOld([...pendingOld.values()].filter((r) => undatedLabel(r.label) === slot.title));
        }
      } catch (e) {
        console.error(`${tag} "${slot.title}" build threw:`, e.message);
        failedCount++;
        failures.push(`${slot.title}: ${e.message || 'unknown error'}`);
        send({ type: 'failed', direction_id: slot.key, error: e.message || 'unknown error' });
      }
    }

    send({ type: 'done', built: builtCount, failed: failedCount });
    console.log(`${tag} owner=${ownerId} biz=${businessId} mode=${mode}${replaceToday ? ' REPLACE' : ''} built ${builtCount}/${slots.length}`);
    await logDailyBuilds([{
      business_id: businessId, il_date: w.isoDate, source,
      outcome: builtCount ? (failedCount ? 'partial' : 'built') : 'zero-built',
      built: builtCount, failed: failedCount, detail: failures.join('\n') || null,
    }]);
    return { done: { built: builtCount, failed: failedCount } };
  } finally {
    try { await lock?.release(); } catch {}
  }
}
