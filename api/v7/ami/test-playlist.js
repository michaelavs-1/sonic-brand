/* /api/v7/ami/test-playlist.js
   Test playlists for Ami's prompt dashboard (step 4, Option 1 directions):
   Ami is examining whether track_analyses.energy (0-100) is worth using in
   the daily playlists. Per direction he can build
     kind 'plain'  → 50 random tracks from the direction's genres, drawn
                     exactly like an Option-1 daily playlist
                     (v6_direction_tracks_recent, no business history);
     kind 'energy' → 50 random tracks from the same pool whose energy is in
                     [energyMin, energyMax] (v7_energy_tracks, migration
                     2026-09-30-v7-energy-tracks.sql).
   Both honour the taste profile's instrumental / popularity preferences, as
   production does. The playlist is created on Rubin's Spotify account
   (same proxy as the daily builds) and registered in created_playlists, so
   the expire cron deletes it after TEST_PLAYLIST_DAYS. No business rows.

   Crons first: while the daily build or the expire cron is running
   (api/_cron-running.js), POST answers 409 code 'cron-running' without
   touching Spotify; the dashboard waits (GET, cheap) and retries.

   GET  → { cronsRunning: ['v7-daily' | 'expire', ...] }
   POST { kind, title, genres, instPref?, popPref?, energyMin?, energyMax? }
     → 200 { ok:true, url, name, trackCount, requested, matches|null,
             energy: { min, max, avg } | null }
     → 200 { ok:false, code:'no-tracks', matches:0 }   (no playlist created)
     → 409 { ok:false, code:'cron-running', cronsRunning }
     → 503 { ok:false, code:'spotify-paused' }
     → 501 { ok:false, code:'needs-migration' }        (v7_energy_tracks missing)
     → 400 / 500 { ok:false, error }

   Site-only (origin guard) + rate-limited, like the Gemini proxy the same
   dashboard calls. */

import { pgrRpc, pgrSelect, pgrUpsert } from '../../v5/supabase-client.js';
import { requireSite, setCors } from '../../v6/origin-guard.js';
import { guard } from '../../v6/ratelimit.js';
import { spotifyCall, addAllTracks } from '../../v6/account/_daily-builder.js';
import { runningCrons } from '../../_cron-running.js';
import { GENRES } from '../../../shared/genre-universe.js';

const TARGET = 50;
const TEST_PLAYLIST_DAYS = 3;
const MAX_GENRES = 12;
const PREFS = new Set(['none', 'soft', 'hard']);
const CANONICAL = new Map(GENRES.map((g) => [g.toLowerCase(), g]));

function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

// "30.09 16:05" in Israel time.
function ilStamp(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

function energySummary(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return {
    min: Math.min(...v),
    max: Math.max(...v),
    avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
  };
}

// → { ok:true, body } | { ok:false, status, body }
function parseRequest(body) {
  const bad = (error) => ({ ok: false, status: 400, body: { ok: false, error } });
  const kind = body?.kind;
  if (kind !== 'plain' && kind !== 'energy') return bad('kind must be plain or energy');
  const title = String(body?.title || '').trim().slice(0, 80) || 'Direction';
  if (!Array.isArray(body?.genres) || !body.genres.length) return bad('genres required');
  const genres = [...new Set(body.genres.map((g) => CANONICAL.get(String(g).trim().toLowerCase())).filter(Boolean))];
  if (!genres.length) return bad('no known genres');
  if (genres.length > MAX_GENRES) return bad(`at most ${MAX_GENRES} genres`);
  const instPref = PREFS.has(body?.instPref) ? body.instPref : 'none';
  const popPref  = PREFS.has(body?.popPref) ? body.popPref : 'none';
  let energyMin = null, energyMax = null;
  if (kind === 'energy') {
    energyMin = Number(body?.energyMin);
    energyMax = Number(body?.energyMax);
    if (![energyMin, energyMax].every((n) => Number.isInteger(n) && n >= 0 && n <= 100) || energyMin > energyMax) {
      return bad('energyMin / energyMax must be whole numbers 0-100, min ≤ max');
    }
  }
  return { ok: true, body: { kind, title, genres, instPref, popPref, energyMin, energyMax } };
}

// → { ids, energies: Map<id, energy>|null, matches|null }
async function drawTracks({ kind, genres, instPref, popPref, energyMin, energyMax }) {
  if (kind === 'energy') {
    const rows = await pgrRpc('v7_energy_tracks', {
      p_genres: genres, p_energy_lo: energyMin, p_energy_hi: energyMax,
      p_inst_pref: instPref, p_pop_pref: popPref, p_limit: TARGET,
    }, { useService: true });
    const list = Array.isArray(rows) ? rows : [];
    return {
      ids: list.map((r) => r.spotify_id).filter(Boolean),
      energies: new Map(list.map((r) => [r.spotify_id, r.energy])),
      matches: list.length ? Number(list[0].matches) : 0,
    };
  }
  // Exactly how an Option-1 daily playlist draws (fetchTracksWithHistory in
  // api/v6/account/_daily-builder.js), minus the business's 7-day history.
  const rows = await pgrRpc('v6_direction_tracks_recent', {
    p_genres: genres, p_bpm_lo: 0, p_bpm_hi: 300, p_pop_lo: 0, p_pop_hi: 100,
    p_limit: TARGET, p_biz_id: null, p_direction_key: '', p_exclude_days: 0,
    p_inst_pref: instPref, p_pop_pref: popPref,
  }, { useService: true });
  return { ids: (rows || []).map((r) => r.spotify_id).filter(Boolean), energies: null, matches: null };
}

async function energiesOf(ids) {
  try {
    const rows = await pgrSelect('track_analyses',
      { spotify_id: `in.(${ids.map((id) => `"${id}"`).join(',')})` },
      { select: 'spotify_id,energy', useService: true });
    return new Map((rows || []).map((r) => [r.spotify_id, r.energy]));
  } catch (e) {
    console.warn('[ami test-playlist] energy lookup failed:', e.message);
    return new Map();
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireSite(req, res)) return;

  if (req.method === 'GET') {
    if (!await guard(req, res, 'ami-test-playlist-status', 120, 60)) return;
    return res.status(200).json({ cronsRunning: await runningCrons() });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!await guard(req, res, 'ami-test-playlist', 40, 3600)) return;

  const parsed = parseRequest(req.body);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  const q = parsed.body;

  const cronsRunning = await runningCrons();
  if (cronsRunning.length) return res.status(409).json({ ok: false, code: 'cron-running', cronsRunning });

  let drawn;
  try {
    drawn = await drawTracks(q);
  } catch (e) {
    // PGRST202 = PostgREST can't find the function (migration not run yet).
    if (q.kind === 'energy' && /PGRST202/.test(e.detail || '')) {
      return res.status(501).json({ ok: false, code: 'needs-migration', error: e.message });
    }
    console.error('[ami test-playlist] draw failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
  if (!drawn.ids.length) return res.status(200).json({ ok: false, code: 'no-tracks', matches: 0 });

  const range = q.kind === 'energy' ? `energy ${q.energyMin}–${q.energyMax}` : 'random';
  const name = `Ami test · ${q.title} · ${range} · ${ilStamp()}`.slice(0, 100);
  const description = `Ami prompt-dashboard test (${range}). Genres: ${q.genres.join(', ')}. Deleted after ${TEST_PLAYLIST_DAYS} days.`.slice(0, 300);
  const origin = selfOrigin(req);

  let created;
  try {
    created = await spotifyCall(origin, 'create_playlist', { name, description });
    if (!created?.id) throw new Error('create_playlist returned no id');
    await addAllTracks(origin, created.id, drawn.ids);
  } catch (e) {
    if (String(e.message || '').includes('spotify_paused')) {
      return res.status(503).json({ ok: false, code: 'spotify-paused' });
    }
    console.error('[ami test-playlist] spotify failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message, url: created?.external_urls?.spotify || null });
  }

  // Ledger row so the expire cron removes it later (no business / owner).
  try {
    await pgrUpsert('created_playlists', {
      spotify_id: created.id,
      name,
      expires_at: new Date(Date.now() + TEST_PLAYLIST_DAYS * 86400e3).toISOString(),
      deleted_at: null,
      error:      null,
      owner_id:    null,
      business_id: null,
    }, { onConflict: 'spotify_id' });
  } catch (e) {
    console.warn(`[ami test-playlist] ledger upsert failed for ${created.id}:`, e.message);
  }

  const energies = drawn.energies || await energiesOf(drawn.ids);
  return res.status(200).json({
    ok:         true,
    url:        created.external_urls?.spotify || `https://open.spotify.com/playlist/${created.id}`,
    name,
    trackCount: drawn.ids.length,
    requested:  TARGET,
    matches:    drawn.matches,
    energy:     energySummary(drawn.ids.map((id) => energies.get(id))),
  });
}
