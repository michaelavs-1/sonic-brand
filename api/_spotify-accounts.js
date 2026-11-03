/* /api/_spotify-accounts.js
   Which Spotify account a playlist is made on (2026-11-03).

   Every playlist used to go on one account, "Robin - Sonic Brands" (the
   RUBIN_* env vars). More accounts are coming, and Roni sets each business to
   one of them (businesses.spotify_account_id, migration
   2026-11-03-spotify-accounts.sql). A business's NEW playlists are made on its
   account; a playlist that already exists is changed and deleted on the
   account it was made on (created_playlists.spotify_account_id), so moving a
   business never strands its live playlists.

   Each account's login token (never in the database):
     'robin-1'   RUBIN_REFRESH_TOKEN + RUBIN_SPOTIFY_CLIENT_ID / _SECRET, as before.
     any other   SPOTIFY_ACCOUNT_<ID>_REFRESH_TOKEN, the id upper-cased with
                 '-' → '_' (robin-2 → SPOTIFY_ACCOUNT_ROBIN_2_REFRESH_TOKEN).
                 SPOTIFY_ACCOUNT_<ID>_CLIENT_ID / _CLIENT_SECRET only if the
                 account authorised its own Spotify app; else Robin's app.
   A Spotify call that names no account goes to 'robin-1'.

   Before the migration has run, every lookup answers 'robin-1' and ledger
   rows are written without the column, so nothing changes.

   Used by api/new/spotify.js (the tokens), the v7 builders, the expire path
   and api/internal/spotify-accounts.js. Not an HTTP endpoint. Bare imports only. */

import { pgrSelect, pgrUpsert } from './v5/supabase-client.js';

export const DEFAULT_SPOTIFY_ACCOUNT = 'robin-1';
export const SPOTIFY_ACCOUNT_RE = /^[a-z0-9-]{1,40}$/;

// The env vars holding an account's login. refreshVar names the one to set.
export function spotifyAccountEnv(account) {
  const id = account || DEFAULT_SPOTIFY_ACCOUNT;
  if (id === DEFAULT_SPOTIFY_ACCOUNT) {
    return {
      refreshVar:   'RUBIN_REFRESH_TOKEN',
      refreshToken: process.env.RUBIN_REFRESH_TOKEN || '',
      clientId:     process.env.RUBIN_SPOTIFY_CLIENT_ID || '',
      clientSecret: process.env.RUBIN_SPOTIFY_CLIENT_SECRET || '',
    };
  }
  const prefix = `SPOTIFY_ACCOUNT_${id.toUpperCase().replace(/-/g, '_')}`;
  return {
    refreshVar:   `${prefix}_REFRESH_TOKEN`,
    refreshToken: process.env[`${prefix}_REFRESH_TOKEN`] || '',
    clientId:     process.env[`${prefix}_CLIENT_ID`] || process.env.RUBIN_SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || process.env.RUBIN_SPOTIFY_CLIENT_SECRET || '',
  };
}

// The column or table isn't there yet (migration not run). The error text
// also carries the request path, so the column name alone isn't enough.
const notMigrated = (e) => {
  const msg = String(e?.message || '');
  return /spotify_account/.test(msg) && /does not exist|could not find|schema cache/i.test(msg);
};

function warnFallback(what, e) {
  if (!notMigrated(e)) console.warn(`[spotify-accounts] ${what} failed — using ${DEFAULT_SPOTIFY_ACCOUNT}:`, e.message);
}

// The account a business's NEW playlists are made on.
export async function businessSpotifyAccount(businessId) {
  if (!businessId) return DEFAULT_SPOTIFY_ACCOUNT;
  try {
    const rows = await pgrSelect('businesses', { id: `eq.${businessId}` },
      { select: 'spotify_account_id', limit: 1, useService: true });
    return rows?.[0]?.spotify_account_id || DEFAULT_SPOTIFY_ACCOUNT;
  } catch (e) {
    warnFallback(`business ${businessId}'s account lookup`, e);
    return DEFAULT_SPOTIFY_ACCOUNT;
  }
}

// spotify_id → the account each playlist was made on (the expiry ledger).
// A playlist the ledger doesn't know is on 'robin-1'.
export async function playlistSpotifyAccounts(spotifyIds) {
  const ids = [...new Set((spotifyIds || []).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, DEFAULT_SPOTIFY_ACCOUNT]));
  if (!ids.length) return out;
  try {
    const rows = await pgrSelect('created_playlists',
      { spotify_id: `in.(${ids.map((id) => `"${id}"`).join(',')})` },
      { select: 'spotify_id,spotify_account_id', useService: true });
    for (const r of rows || []) if (r.spotify_account_id) out.set(r.spotify_id, r.spotify_account_id);
  } catch (e) {
    warnFallback('playlist account lookup', e);
  }
  return out;
}

export async function playlistSpotifyAccount(spotifyId) {
  return (await playlistSpotifyAccounts([spotifyId])).get(spotifyId) || DEFAULT_SPOTIFY_ACCOUNT;
}

// The expiry-ledger row for a new playlist, with its account. Before the
// migration it's written without the column. Other errors throw, as pgrUpsert.
export async function upsertLedgerRow(row) {
  try {
    await pgrUpsert('created_playlists', row, { onConflict: 'spotify_id' });
  } catch (e) {
    if (!('spotify_account_id' in row) || !notMigrated(e)) throw e;
    const { spotify_account_id, ...rest } = row;
    await pgrUpsert('created_playlists', rest, { onConflict: 'spotify_id' });
  }
}

// Epoch ms until which the proxy's pause switch holds every Spotify write
// (api/new/spotify.js, key spotify:pause_until), or null. Fail-open.
export async function spotifyPausedUntil() {
  const url   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', 'spotify:pause_until']]),
    });
    if (!r.ok) return null;
    const until = parseInt((await r.json().catch(() => null))?.[0]?.result, 10);
    return until > Date.now() ? until : null;
  } catch { return null; }
}
