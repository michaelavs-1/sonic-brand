/* /api/v7/account/_spotify-links.js
   Spotify song links in an owner's chat message (the v7 taste chat asks for
   a song's share link whenever it needs to know which song the owner means).

     findSpotifyLinks(text)            → up to MAX_LINKS link strings
     resolveSongLink(link, { origin }) → { spotify_id, title, artist, duration_sec,
                                           catalog_genres, energy, analyzed }
                                       | { link, error: 'not-a-song' | 'unreadable' | 'not-found' }

   Accepted: open.spotify.com/[intl-xx/][embed/]track/<id>, spotify:track:<id>,
   and the phone app's short links (open.spotify.com/s/…, spotify.link/…),
   which are followed to the full link first. The parsing is the same as Ami's
   track lookup (api/v4/ami-track-lookup.js). Title / artist / length come
   from Spotify (Michael's app via /api/v4/spotify, market IL, so a relinked
   song resolves to the id our catalog stores); catalog genres from
   playlist_tracks → playlist_genres; energy from track_analyses.

   Not an HTTP endpoint. Bare imports only. */

import { pgrSelect } from '../../v5/supabase-client.js';
import { GENRES } from '../../../shared/genre-universe.js';

export const MAX_LINKS = 3;
const CANON = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const LINK_RE = /(spotify:(?:track|album|artist|playlist|episode|show):[A-Za-z0-9]{22}|https?:\/\/(?:open\.spotify\.com|spotify\.link)\/[^\s<>"')]+)/gi;

export function findSpotifyLinks(text) {
  return [...new Set(String(text || '').match(LINK_RE) || [])].slice(0, MAX_LINKS);
}

async function unshorten(link) {
  if (!/^https?:\/\/(open\.spotify\.com\/s\/|spotify\.link\/)/i.test(link)) return link;
  try {
    const r = await fetch(link, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
    // spotify.link lands on an app page that carries the open.spotify.com
    // link in its body when the redirect doesn't reach it.
    if (/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|album|artist|playlist|episode|show)\//i.test(r.url || '')) return r.url;
    const body = await r.text().catch(() => '');
    const m = body.match(/https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|album|artist|playlist|episode|show)\/[A-Za-z0-9]{22}/i);
    return m ? m[0] : (r.url || link);
  } catch {
    return link;
  }
}

function extract(link) {
  let m = String(link).match(/^spotify:(track|album|artist|playlist|episode|show):([A-Za-z0-9]{22})/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  m = String(link).match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(track|album|artist|playlist|episode|show)\/([A-Za-z0-9]{22})/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}

async function spotifyTrack(origin, id) {
  const r = await fetch(`${origin}/api/v4/spotify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sonic-internal': process.env.INTERNAL_API_KEY || '' },
    body: JSON.stringify({ action: 'get_track', track_id: id, market: 'IL' }),
  });
  const d = await r.json().catch(() => ({}));
  return r.ok && d?.id ? d : null;
}

// Catalog genres + analysis of one track id.
export async function catalogInfo(spotifyId) {
  const [placements, analyses] = await Promise.all([
    pgrSelect('playlist_tracks', { spotify_id: `eq.${spotifyId}` }, { select: 'playlist_id', limit: 200, useService: true }).catch(() => []),
    pgrSelect('track_analyses', { spotify_id: `eq.${spotifyId}` }, { select: 'status,energy,duration_sec', limit: 1, useService: true }).catch(() => []),
  ]);
  let genres = [];
  const ids = [...new Set((placements || []).map((p) => p.playlist_id))];
  if (ids.length) {
    const rows = await pgrSelect('playlist_genres',
      { playlist_id: `in.(${ids.map((x) => `"${String(x).replace(/"/g, '')}"`).join(',')})` },
      { select: 'genre', useService: true }).catch(() => []);
    genres = [...new Set((rows || []).map((r) => CANON.get(String(r.genre).toLowerCase())).filter(Boolean))];
  }
  const a = analyses?.[0];
  const analyzed = a?.status === 'ok';
  return {
    catalog_genres: genres,
    energy: analyzed && Number.isFinite(Number(a.energy)) ? Number(a.energy) : null,
    analyzed,
    duration_sec: analyzed && Number.isFinite(Number(a.duration_sec)) ? Number(a.duration_sec) : null,
  };
}

export async function resolveSongLink(link, { origin }) {
  const full = await unshorten(link);
  const res = extract(full);
  if (!res) return { link, error: 'unreadable' };
  if (res.type !== 'track') return { link, error: 'not-a-song', type: res.type };
  const t = await spotifyTrack(origin, res.id).catch(() => null);
  if (!t) return { link, error: 'not-found' };
  const id = t.id;   // market-canonical (relinking)
  const info = await catalogInfo(id);
  return {
    link,
    spotify_id: id,
    title: t.name || '',
    artist: (t.artists || []).map((a) => a.name).filter(Boolean).join(', '),
    duration_sec: info.duration_sec ?? (Number.isFinite(Number(t.duration_ms)) ? Math.round(t.duration_ms / 1000) : null),
    catalog_genres: info.catalog_genres,
    energy: info.energy,
    analyzed: info.analyzed,
  };
}

// Title / artist of several track ids (for "the song playing now" in the
// chat's context). Never throws; unknown ids are left out.
export async function songNames(ids, { origin }) {
  const out = new Map();
  await Promise.all([...new Set(ids)].filter(Boolean).slice(0, 8).map(async (id) => {
    const t = await spotifyTrack(origin, id).catch(() => null);
    if (t) out.set(id, { title: t.name || '', artist: (t.artists || []).map((a) => a.name).filter(Boolean).join(', ') });
  }));
  return out;
}
