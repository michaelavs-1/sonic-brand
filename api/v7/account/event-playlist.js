/* /api/v7/account/event-playlist.js
   Build the Spotify playlist for one v7 special playlist (business_events
   row). The client calls it right after save-event (the card shows a spinner
   until it answers), and again from the card's "נסו שוב" after a failure.

   v7 rewrite of api/v6/account/event-playlist.js. Same shape — a model turns
   the brief into genres + tempo, v5_direction_tracks draws random tracks, the
   playlist goes on Rubin's account, expires at the next 04:00 IL (ledger +
   expire cron) — with these v7 differences (Roni, 2026-10-03):
   - the event is read from the DB, not trusted from the request;
   - genre menu: the owner's approved genres when the chat recorded
     genre_source 'daily', else the whole catalog (no pairing rules);
   - instrumental / popularity preferences from the taste profile, overridable
     by the brief (v7/generation/event-playlist-prompt.js);
   - no song that is already in one of today's live playlists of the business;
   - only events created since the last 04:00 IL can be built (410 otherwise);
   - an event that already has a live playlist returns it; one build per event
     at a time (409 'building');
   - the Spotify name's date is the IL date.
   Length is unchanged from v6: closedDayTargetTracks() ≈ 223, floor 5.
   TEMPORARY: tempo (bpm_range) still stands in for energy — see the prompt file.

   Request:  { businessId, eventId }
   Response: { ok: true, playlist: { id, url, label, trackCount, genres, bpmRange, eventId, expiresAt }, already? }
             409 { code: 'building' } | 410 { code: 'expired' } | 503 { code: 'spotify-paused' } | 4xx/5xx { error } */

import { pgrSelect, pgrRpc, pgrUpsert } from '../../v5/supabase-client.js';
import { setCors }      from '../../v6/origin-guard.js';
import { guard }        from '../../v6/ratelimit.js';
import { spotifyCall, addAllTracks } from '../../v6/account/_daily-builder.js';
import { attachTrackGenres, insertPlaylistRows } from './_daily-builder.js';
import { acquireBuildLock } from './_build-lock.js';
import { verifyUser }   from './_settings-helpers.js';
import { ownedBusiness, selfOrigin, parseModelJson, geminiText } from './_special-events.js';
import { nextIl4amIso, prevIl4amIso, closedDayTargetTracks, ilPartsFromDate } from '../../../v7/generation/playlist-length.js';
import {
  EVENT_PLAYLIST_SYSTEM_PROMPT, buildEventPlaylistUserMessage, normalizeEventPlaylistParams,
} from '../../../v7/generation/event-playlist-prompt.js';
import { PROVIDER, MODEL_ANTHROPIC, MODEL_GEMINI, GEMINI_THINKING_LEVEL } from '../../../v7/generation/ai-provider.js';

const SERVICE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

const MODEL_MAX_TOKENS = 4096;
const MIN_TRACKS       = 5;
const TARGET_TRACKS    = closedDayTargetTracks();   // ≈ 223, as in v6
const MAX_EXCLUDE_PAD  = 1500;                      // cap on the extra rows drawn to cover today's tracks
const PREFS = new Set(['none', 'soft', 'hard']);

// v7/generation/ai-provider.js's callModel uses relative URLs (browser only),
// so the server goes through the same proxies via selfOrigin.
async function askModel(origin, system, userMessage, businessId) {
  const headers = { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_API_KEY };
  if (PROVIDER === 'gemini') {
    const r = await fetch(`${origin}/api/v6/gemini`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model:             MODEL_GEMINI,
        max_output_tokens: MODEL_MAX_TOKENS,
        thinking_level:    GEMINI_THINKING_LEVEL,
        system,
        user:              userMessage,
        label:             'v7-event-playlist',
        business_id:       businessId || null,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`gemini ${r.status}: ${j?.error?.message || j?.error || 'proxy failed'}`);
    return parseModelJson(geminiText(j));
  }
  if (PROVIDER === 'anthropic') {
    const r = await fetch(`${origin}/api/v5/anthropic`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model:      MODEL_ANTHROPIC,
        max_tokens: MODEL_MAX_TOKENS,
        system:     [{ type: 'text', text: system }],
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${j?.error?.message || j?.error || 'proxy failed'}`);
    const text = Array.isArray(j?.content) ? j.content.find((b) => b?.type === 'text')?.text : null;
    if (typeof text !== 'string') throw new Error('anthropic: no text block in response');
    return parseModelJson(text);
  }
  throw new Error(`event-playlist: unknown PROVIDER "${PROVIDER}"`);
}

// The event row. Falls back to a select without genre_source when the
// migration hasn't run yet.
async function readEvent(businessId, eventId) {
  const filters = { id: `eq.${eventId}`, business_id: `eq.${businessId}` };
  try {
    const rows = await pgrSelect('business_events', filters,
      { select: 'id,name,description,created_at,genre_source', limit: 1, useService: true });
    return rows?.[0] || null;
  } catch (e) {
    if (!/genre_source/.test(e.detail || e.message || '')) throw e;
    const rows = await pgrSelect('business_events', filters,
      { select: 'id,name,description,created_at', limit: 1, useService: true });
    return rows?.[0] || null;
  }
}

const clientPlaylist = (r) => ({
  id:         r.spotify_id,
  url:        r.url,
  label:      r.label,
  trackCount: r.track_count,
  genres:     r.genres,
  bpmRange:   r.bpm_range,
  eventId:    r.event_id,
  expiresAt:  Date.parse(r.expires_at),
});

function ilDateHe(d = new Date()) {
  const p = ilPartsFromDate(d);
  return `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}.${p.year}`;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'v7-event-playlist', 20, 3600)) return;

  let lock = null;
  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, eventId } = req.body || {};
    if (!businessId || !eventId) return res.status(400).json({ error: 'businessId and eventId required' });
    let biz;
    try { biz = await ownedBusiness(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    const ev = await readEvent(businessId, eventId);
    if (!ev) return res.status(404).json({ error: 'הפלייליסט לא נמצא' });
    if (Date.parse(ev.created_at) < Date.parse(prevIl4amIso())) {
      return res.status(410).json({ code: 'expired', error: 'הצ׳אט מכין פלייליסטים לאותו היום בלבד. אפשר להכין חדש בצ׳אט.' });
    }

    const nowIso = new Date().toISOString();
    const existing = await pgrSelect('business_playlists',
      { business_id: `eq.${businessId}`, event_id: `eq.${eventId}`, expires_at: `gt.${nowIso}` },
      { select: 'spotify_id,url,label,track_count,genres,bpm_range,event_id,expires_at', limit: 1, useService: true });
    if (existing?.[0]) return res.status(200).json({ ok: true, already: true, playlist: clientPlaylist(existing[0]) });

    lock = await acquireBuildLock(`event:${eventId}`, 180);
    if (!lock.acquired) {
      lock = null;
      return res.status(409).json({ code: 'building', error: 'הפלייליסט עדיין נבנה…' });
    }

    // Taste profile (approved genres + preferences) and today's live tracks.
    const [profiles, liveRows] = await Promise.all([
      pgrSelect('business_taste_profiles', { business_id: `eq.${businessId}` },
        { select: 'approved_genres,energy_levels_total,instrumentalness_preference,popularity_preference', limit: 1, useService: true }),
      pgrSelect('business_playlists', { business_id: `eq.${businessId}`, expires_at: `gt.${nowIso}` },
        { select: 'track_ids', useService: true }),
    ]);
    const profile  = profiles?.[0] || {};
    const approved = (Array.isArray(profile.approved_genres) ? profile.approved_genres : [])
      .filter((g) => g && typeof g.genre === 'string');
    const instPref = PREFS.has(profile.instrumentalness_preference) ? profile.instrumentalness_preference : 'none';
    const popPref  = PREFS.has(profile.popularity_preference) ? profile.popularity_preference : 'none';
    const genreSource = ev.genre_source === 'daily' && approved.length ? 'daily' : 'event';
    const excluded = new Set((liveRows || []).flatMap((r) => (Array.isArray(r.track_ids) ? r.track_ids : [])));

    // 1) Model → genres + tempo + preferences.
    const origin = selfOrigin(req);
    const parsed = await askModel(origin, EVENT_PLAYLIST_SYSTEM_PROMPT, buildEventPlaylistUserMessage({
      description: ev.description,
      genreSource,
      approvedGenres: approved,
      energyLevelsTotal: profile.energy_levels_total || null,
      instPref,
      popPref,
    }), businessId);
    const params = normalizeEventPlaylistParams(parsed, {
      allowed: genreSource === 'daily' ? new Set(approved.map((g) => g.genre)) : null,
      instPref,
      popPref,
    });
    if (params.error === 'not_an_event') return res.status(400).json({ error: 'לא הצלחנו להבין את התיאור. נסחו שוב בצ׳אט.' });
    if (!params.genres.length)          return res.status(400).json({ error: 'לא הצלחנו להתאים סגנונות לתיאור. נסחו שוב בצ׳אט.' });
    if (!params.bpm)                    return res.status(400).json({ error: 'משהו השתבש בבחירת המוזיקה. נסו שוב.' });

    // 2) Tracks: random, in those genres + tempo, minus anything already
    //    playing today. Service key — the anon role's 3s timeout is too short.
    const rows = await pgrRpc('v5_direction_tracks', {
      p_genres:    params.genres,
      p_bpm_lo:    params.bpm.min,
      p_bpm_hi:    params.bpm.max,
      p_pop_lo:    0,
      p_pop_hi:    100,
      p_limit:     TARGET_TRACKS + Math.min(excluded.size, MAX_EXCLUDE_PAD),
      p_inst_pref: params.instPref,
      p_pop_pref:  params.popPref,
    }, { useService: true });
    const spotifyIds = (rows || []).map((r) => r.spotify_id).filter((id) => id && !excluded.has(id)).slice(0, TARGET_TRACKS);
    if (spotifyIds.length < MIN_TRACKS) {
      return res.status(400).json({ error: `נמצאו רק ${spotifyIds.length} שירים מתאימים. נסחו את הבקשה אחרת בצ׳אט.` });
    }

    // 3) Spotify on Rubin's account.
    const cleanBiz     = String(biz.name || '').trim().slice(0, 40);
    const cleanEvent   = String(ev.name || 'פלייליסט').trim().slice(0, 40);
    const playlistName = `${cleanBiz ? cleanBiz + ' · ' : ''}${cleanEvent} · ${ilDateHe()}`.slice(0, 100);
    let created;
    try {
      created = await spotifyCall(origin, 'create_playlist', { name: playlistName, description: `רובין · ${cleanEvent}` });
      if (!created?.id) throw new Error('create_playlist returned no id');
      await addAllTracks(origin, created.id, spotifyIds);
    } catch (e) {
      if (String(e.message || '').includes('spotify_paused')) {
        return res.status(503).json({ code: 'spotify-paused', error: 'Spotify עמוס כרגע. נסו שוב בעוד כמה דקות.' });
      }
      throw e;
    }
    const url = created.external_urls?.spotify || `https://open.spotify.com/playlist/${created.id}`;

    // 4) Expiry ledger (next 04:00 IL, swept by the expire cron) + dashboard row.
    const expiresAtIso = nextIl4amIso();
    try {
      await pgrUpsert('created_playlists', {
        spotify_id:  created.id,
        name:        playlistName,
        expires_at:  expiresAtIso,
        deleted_at:  null,
        error:       null,
        owner_id:    user.id,
        business_id: businessId,
      }, { onConflict: 'spotify_id' });
    } catch (e) {
      console.error(`[v7 event-playlist] ledger write failed for ${created.id} — it won't expire on its own:`, e.message);
    }
    const row = await attachTrackGenres({
      spotify_id:   created.id,
      business_id:  businessId,
      url,
      label:        cleanEvent,
      ico:          '🎪',
      track_count:  spotifyIds.length,
      genres:       params.genres,
      bpm_range:    params.bpm,
      expansion:    null,
      event_id:     eventId,
      direction_id: null,
      track_ids:    spotifyIds,
      expanded_at:  null,
      expires_at:   expiresAtIso,
      created_at:   new Date().toISOString(),
    });
    await insertPlaylistRows([row]);

    console.log(`[v7 event-playlist] biz=${businessId} event=${eventId} "${playlistName}" (${spotifyIds.length} tracks, source=${genreSource}, genres=${params.genres.join(',')}, bpm=${params.bpm.min}-${params.bpm.max}, inst=${params.instPref}, pop=${params.popPref}, excluded=${excluded.size})`);
    return res.status(200).json({ ok: true, playlist: clientPlaylist(row) });
  } catch (err) {
    console.error('[v7 event-playlist] failed:', err.message);
    return res.status(500).json({ error: 'משהו השתבש בבניית הפלייליסט. נסו שוב.' });
  } finally {
    if (lock) await lock.release();
  }
}
