/* GET /api/internal/business?id=<business_uuid>
   Everything the admin console shows about one business (v7 since
   2026-10-13 — the makeover for Michael's list). Field-by-field reference:
   docs/admin-api-for-michael.md.

   Auth: bearer token in `Authorization: Bearer <INTERNAL_ADMIN_API_KEY>` (see
   ./_guard.js). CORS: `*` — the bearer token IS the boundary.

   Sections (Michael's list item in brackets):
     business          name, owner email, version, created / paid dates     [1]
     onboarding        free text, atmospheres, emphases, Round 2 text,
                       Google place, hours, and the swipe deck: the cards
                       shown + what the owner did with each (since
                       2026-10-13; older accounts: the per-genre tally)    [2, 3]
     taste_profile     approved genres by energy level (+ weights,
                       requested), conditional / excluded / turned down,
                       preferences                                          [4]
     delivery          playlist type, Option 2's energy timeline, Option 1's
                       energy windows
     directions        the Option 1 + Option 2 libraries, with the keys the
                       edit endpoint takes; `in_use` = the one that builds  [5]
     daily             the daily playlists by business day: slot, the
                       direction(s) each played, opens                     [5, 6]
     daily_picks       the admin's picks from today on                      [11]
     clicks            every "▶ פתח" click, by Israel date and playlist     [6]
     taste_chat        the owner's "הטעם המוזיקלי שלכם" messages + every change
                       it applied (and every admin edit)                    [7]
     special_requests  the special-playlist requests ("צריכים משהו אחר היום?"):
                       each request, its playlist, the chat, deleted ones   [8]
     payment           paid or not, when, the subscription's state, every
                       checkout                                             [9]
     settings_changes, build_log, admin_actions, gemini_spend, gemini_calls,
     cleanup_backlog, playlists (every playlist row, with track_ids +
     track_genres), legacy_v6 (the pre-v7 fields; empty for v7 businesses)
   Actions live in directions.js [10], daily-picks.js [11], coupons.js [12].
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import {
  UUID_RE, hasServiceKey, fetchAuthUser, loadBusiness, selectAll, selectOrEmpty, ilDateOf, round6,
} from './_admin.js';
import { readLibrary } from './_library.js';
import { dailyByDay, playedOf } from './_daily-view.js';
import { businessWindowAt } from '../../v7/generation/energy-timeline.js';
import { subscriptionStatus, nextChargeDate } from '../v7/account/_subscription.js';

// A chat row's readable text: the owner's message, or the reply_he inside the
// model's raw JSON.
function chatText(m) {
  if (m.role !== 'assistant') return m.content;
  try { return JSON.parse(m.content)?.reply_he ?? m.content; } catch { return m.content; }
}

function geminiRollup(calls) {
  let total = 0;
  const byLabel = new Map();
  for (const c of calls) {
    const cost = Number(c.cost_usd) || 0;
    total += cost;
    const lbl = c.label || '(unlabeled)';
    const b = byLabel.get(lbl) || { label: lbl, usd: 0, calls: 0 };
    b.usd += cost;
    b.calls += 1;
    byLabel.set(lbl, b);
  }
  return {
    total_usd: round6(total),
    call_count: calls.length,
    by_label: [...byLabel.values()].sort((a, b) => b.usd - a.usd).map((l) => ({ ...l, usd: round6(l.usd) })),
  };
}

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    const id = String(req.query?.id || '').trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'query param `id` must be a business uuid' });
    const business = await loadBusiness(id);
    if (!business) return res.status(404).json({ error: 'business not found' });

    const by = { business_id: `eq.${id}` };
    const now = new Date();
    const nowIso = now.toISOString();
    const [
      owner, lib, placeRows, hoursRows, playlistRows, openRows, superLiked, tasteChat, tasteChanges,
      events, eventChats, deletedEvents, checkouts, settingsChanges, buildLog, geminiRows, backlog,
      adminActions, picks, v6Directions, v6Changes, portraits,
    ] = await Promise.all([
      fetchAuthUser(business.owner_id),
      readLibrary(id),
      selectOrEmpty('business_place', by, { limit: 1 }),
      selectOrEmpty('business_hours', by, { limit: 1 }),
      selectAll('business_playlists', by, {
        select: 'spotify_id,url,label,ico,track_count,genres,bpm_range,event_id,direction_id,track_ids,track_genres,expansion,expanded_at,expires_at,created_at',
        order: 'spotify_id.asc',
      }),
      selectAll('business_playlist_opens', by, { select: 'id,spotify_id,source,opened_at', order: 'id.asc' }),
      selectOrEmpty('super_liked_tracks', by, { select: 'spotify_id,created_at,deleted_at', order: 'created_at.asc' }),
      selectAll('business_direction_chats', by, { select: 'id,role,content,proposal,created_at', order: 'id.asc' }),
      selectOrEmpty('business_taste_changes', by, { select: '*', order: 'applied_at.desc' }),
      selectOrEmpty('business_events', by, { select: '*', order: 'created_at.desc' }),
      selectOrEmpty('business_event_chats', by, { select: 'id,role,content,proposal,event_id,created_at', order: 'created_at.asc' }),
      selectOrEmpty('deleted_events', by, { select: '*', order: 'deleted_at.desc' }),
      selectOrEmpty('payment_checkouts', by, {
        select: 'id,order_no,hyp_env,status,email,coupon_code,percent_off,amount_first,amount_monthly,paid_at,created_at,billing,hyp_trans_id,hyp_hk_id',
        order: 'created_at.asc',
      }),
      selectOrEmpty('business_settings_changes', by, { select: 'id,field,before,after,changed_at', order: 'changed_at.desc' }),
      selectOrEmpty('v7_daily_build_log', { ...by, created_at: `gte.${new Date(now.getTime() - 60 * 86400e3).toISOString()}` },
        { select: 'il_date,source,outcome,built,failed,detail,created_at', order: 'created_at.desc' }),
      selectAll('gemini_call_log', by, {
        select: '*', order: 'id.asc',
      }),
      // Expired playlists whose Spotify cleanup has failed at least once.
      selectOrEmpty('created_playlists', { ...by, deleted_at: 'is.null', expires_at: `lte.${nowIso}`, attempts: 'gte.1' }, {
        select: 'spotify_id,name,expires_at,attempts,last_error,next_attempt_at,alerted_at', order: 'attempts.desc', limit: 50,
      }),
      selectOrEmpty('admin_actions', by, { select: 'id,action,detail,created_at', order: 'created_at.desc', limit: 200 }),
      selectOrEmpty('business_v7_daily_picks', by, { select: '*', order: 'il_date.asc,slot.asc' }),
      selectOrEmpty('business_directions', by, {
        select: 'id,rank,title_en,description_he,genres,bpm_range,instrumentalness_preference,popularity_preference,active,created_at,updated_at',
        order: 'rank.asc.nullslast',
      }),
      selectOrEmpty('business_direction_changes', by, {
        select: 'id,kind,direction_id,before,after,playlist_action,message_id_first,message_id_last,applied_at', order: 'applied_at.desc',
      }),
      // The owner's musical portrait, every version, newest first (2026-10-21).
      selectOrEmpty('business_taste_portraits', by, { select: 'id,portrait_he,source,message_id,created_at', order: 'created_at.desc' }),
    ]);

    const hours = hoursRows[0]?.hours || null;
    const today = businessWindowAt(hours || {}, now).isoDate;
    const profile = lib.profile;
    const playlists = [...playlistRows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const byPlaylist = new Map(playlists.map((p) => [p.spotify_id, p]));

    // ---- clicks ----
    const opens = [...openRows].sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)));
    const clickDays = new Map();
    const clickPlaylists = new Map();
    const clickSources = new Map();
    for (const o of opens) {
      const p = byPlaylist.get(o.spotify_id);
      const day = ilDateOf(o.opened_at);
      if (!clickDays.has(day)) clickDays.set(day, new Map());
      const dm = clickDays.get(day);
      const e = dm.get(o.spotify_id) || { spotify_id: o.spotify_id, label: p?.label || null, kind: p ? (p.event_id ? 'special' : 'daily') : 'unknown', count: 0, times: [] };
      e.count += 1;
      e.times.push(o.opened_at);
      dm.set(o.spotify_id, e);
      const cp = clickPlaylists.get(o.spotify_id) || { spotify_id: o.spotify_id, label: p?.label || null, count: 0, last_opened_at: null };
      cp.count += 1;
      if (!cp.last_opened_at || o.opened_at > cp.last_opened_at) cp.last_opened_at = o.opened_at;
      clickPlaylists.set(o.spotify_id, cp);
      const src = o.source || '(unspecified)';
      clickSources.set(src, (clickSources.get(src) || 0) + 1);
    }

    // ---- special requests: each event with its playlist(s) + chat ----
    const eventPlaylists = playlists.filter((p) => p.event_id);
    const specialRequests = events.map((e) => ({
      ...e,
      il_date: ilDateOf(e.created_at),
      genre_source: e.genre_source || 'event',
      playlists: eventPlaylists.filter((p) => p.event_id === e.id).map((p) => ({
        spotify_id: p.spotify_id, url: p.url, label: p.label, track_count: p.track_count, genres: p.genres,
        bpm_range: p.bpm_range, created_at: p.created_at, expires_at: p.expires_at,
        opens: clickPlaylists.get(p.spotify_id)?.count || 0,
      })),
    }));

    // ---- payment ----
    const paidCheckouts = checkouts.filter((c) => c.status === 'paid');
    const firstPaid = paidCheckouts[0] || null;
    const lastPaid = paidCheckouts[paidCheckouts.length - 1] || null;
    const subStatus = subscriptionStatus(business, now);
    const payment = {
      // 'paid' = a real Hyp payment exists; 'no-payment' = signed up while
      // payments were switched off (businesses.paid_at is then just the signup time).
      status: paidCheckouts.length ? 'paid' : 'no-payment',
      first_paid_at: firstPaid?.paid_at || null,
      last_paid_at: lastPaid?.paid_at || null,
      terminal: lastPaid?.hyp_env || null,   // 'production' = real money; 'test' = Hyp's test terminal
      first_month_ils: firstPaid ? Number(firstPaid.amount_first) : null,
      monthly_ils: lastPaid ? Number(lastPaid.amount_monthly) : null,
      coupon: firstPaid?.coupon_code ? { code: firstPaid.coupon_code, percent_off: firstPaid.percent_off } : null,
      subscription: paidCheckouts.length ? {
        status: subStatus,                                     // 'active' | 'cancelled' (until ends_at) | 'ended'
        next_charge_date: subStatus === 'active' && lastPaid?.paid_at ? nextChargeDate(lastPaid.paid_at, now) : null,
        cancelled_at: business.subscription_cancelled_at || null,
        ends_at: business.subscription_ends_at || null,
        cancel_reason: business.subscription_cancel_reason || null,
      } : null,
      checkouts,
    };

    // ---- taste chat ----
    const tasteMessages = [...tasteChat].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((m) => ({
      id: m.id, role: m.role, text: chatText(m), created_at: m.created_at,
      proposal: m.proposal || null,
    }));

    const geminiCalls = [...geminiRows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const sonic = owner?.user_metadata?.sonic || {};

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      business: {
        id:              business.id,
        name:            business.name || null,
        version:         business.version || null,
        owner_id:        business.owner_id,
        owner_email:     owner?.email || null,
        email_verified:  !!owner?.email_confirmed_at,
        last_sign_in_at: owner?.last_sign_in_at || null,
        created_at:      business.created_at,
        paid_at:         business.paid_at || null,   // see payment.status — not always a real payment
      },
      onboarding: {
        business_description: business.business_description,
        musical_emphases:     business.musical_emphases,
        atmospheres:          Array.isArray(sonic?.onboarding?.atmospheres) ? sonic.onboarding.atmospheres : [],
        round2_emphases:      profile?.round2_emphases ?? null,
        place:                placeRows[0] || null,
        hours:                hoursRows[0] || null,
        swipe: {
          // The cards shown, in order, each { round, rank, title_en,
          // description_he, genres, verdict: liked|disliked|not-swiped }.
          // null = signed up before 2026-10-13 (only the tally below exists).
          cards:              profile?.onboarding_probes ?? null,
          // Per genre across all cards: how many liked / disliked cards it was in.
          genre_tally:        Array.isArray(profile?.audit_tally) ? profile.audit_tally : [],
          super_liked_genres: profile?.super_liked_genres ?? null,
          super_liked_tracks: superLiked,
        },
      },
      taste_profile: profile ? {
        energy_levels_total:         profile.energy_levels_total,
        approved_by_level:           lib.approved_by_level,
        approved_genres:             profile.approved_genres || [],
        conditional_genres:          profile.conditional_genres || [],
        excluded_genres:             profile.excluded_genres || [],
        requested_genres:            profile.requested_genres || [],
        rejected_genres:             profile.rejected_genres || [],
        genre_weights:               profile.genre_weights || null,
        instrumentalness_preference: profile.instrumentalness_preference,
        popularity_preference:       profile.popularity_preference,
        popularity_tiers:            profile.popularity_tiers || null,   // Option 1 per tier (2026-10-14)
        reasoning_en:                profile.reasoning_en,
        updated_at:                  profile.updated_at || null,
        // The taste chat reads the newest version every turn (2026-10-21).
        portrait:                    portraits[0]
          ? { text: portraits[0].portrait_he, source: portraits[0].source, updated_at: portraits[0].created_at, versions: portraits.length }
          : null,
        portrait_history:            portraits.map((r) => ({ text: r.portrait_he, source: r.source, message_id: r.message_id, created_at: r.created_at })),
      } : null,
      delivery: {
        mode:           lib.mode,
        mode_set_at:    lib.settings?.updated_at || null,
        timeline:       lib.settings?.timeline || null,
        energy_windows: lib.energy_windows,
      },
      directions: {
        in_use:                  lib.mode,
        option1:                 lib.option1,
        option2:                 lib.option2,
        option2_matches_profile: lib.option2_matches_profile,
      },
      daily: dailyByDay(playlists, opens, now),
      daily_picks: picks.filter((p) => p.il_date >= today),
      clicks: {
        total:       opens.length,
        by_day:      [...clickDays.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([il_date, m]) => ({
          il_date,
          total: [...m.values()].reduce((n, x) => n + x.count, 0),
          playlists: [...m.values()].sort((a, b) => b.count - a.count),
        })),
        by_playlist: [...clickPlaylists.values()].sort((a, b) => b.count - a.count),
        by_source:   [...clickSources.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
        raw:         opens,
      },
      taste_chat: {
        messages: tasteMessages,
        // Every change applied to the taste profile / directions, newest
        // first. source: 'chat' (the owner) | 'admin' (this console).
        changes: tasteChanges.map((c) => ({ ...c, source: c.source || 'chat' })),
      },
      special_requests: {
        requests: specialRequests,
        deleted:  deletedEvents,
        chat:     eventChats.map((m) => ({ id: m.id, role: m.role, text: chatText(m), proposal: m.proposal || null, event_id: m.event_id, created_at: m.created_at })),
      },
      payment,
      settings_changes: settingsChanges,
      build_log:        buildLog,
      admin_actions:    adminActions,
      gemini_spend:     geminiRollup(geminiCalls),
      gemini_calls:     geminiCalls,
      cleanup_backlog:  backlog,
      playlists: playlists.map(({ expansion, ...p }) => ({ ...p, kind: p.event_id ? 'special' : 'daily', played: p.event_id ? null : playedOf({ ...p, expansion }) })),
      legacy_v6: {
        onboarding_expanded: business.onboarding_expanded ?? null,
        monthly_credits:     business.monthly_credits ?? null,
        credits_remaining:   business.credits_remaining ?? null,
        directions:          v6Directions,
        direction_changes:   v6Changes,
      },
    });
  } catch (err) {
    console.error('[internal:business] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
