/* GET /api/internal/spotify-accounts
   The Spotify accounts our playlists are made on, and the businesses on each
   (2026-11-03, for Michael's back office). Roni sets which account a business
   uses (businesses.spotify_account_id, see api/_spotify-accounts.js); this
   only reports it. Read-only, and never calls Spotify: everything comes from
   our own tables, env and the Redis pause switch.

   Auth: bearer token in `Authorization: Bearer <INTERNAL_ADMIN_API_KEY>` (see
   ./_guard.js). CORS: `*` — the bearer token IS the boundary.

   Response:
     { accounts: [{
         id, label, email, spotify_user_id, display_name,
         profile_url,          open.spotify.com/user/<spotify_user_id>
         status,               'ok' | 'error' | 'disabled' (active = false)
         status_detail,        why, when not 'ok': the pause switch is on, or
                               this deployment has no login token for it
         last_ok_at,           the newest playlist made on the account
         playlist_count,       live playlists on the account (made, not yet removed)
         businesses: [{ business_id, name, owner_email, playlist_count }],
                               set to this account, plus any business that
                               moved away but still has live playlists here
       }],
       unassigned_businesses: [{ business_id, name, owner_email }],
       notes: [] }
   501 { code: 'needs-migration' } until 2026-11-03-spotify-accounts.sql has run.
*/

import { pgrSelect } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import { hasServiceKey, listAllAuthUsers, selectAll } from './_admin.js';
import { DEFAULT_SPOTIFY_ACCOUNT, spotifyAccountEnv, spotifyPausedUntil } from '../_spotify-accounts.js';

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res))  return;

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    let accounts;
    try {
      accounts = await selectAll('spotify_accounts', {}, { select: '*', order: 'id.asc' });
    } catch (e) {
      console.warn('[internal:spotify-accounts] spotify_accounts read failed (migration not run?):', e.message.slice(0, 200));
      return res.status(501).json({ code: 'needs-migration', error: 'Run migration 2026-11-03-spotify-accounts.sql.' });
    }

    const [businesses, users, live, pausedUntil, lastMade] = await Promise.all([
      pgrSelect('businesses', {}, { select: 'id,name,owner_id,spotify_account_id', order: 'created_at.desc', useService: true }),
      listAllAuthUsers(),
      selectAll('created_playlists', { deleted_at: 'is.null' },
        { select: 'spotify_id,business_id,spotify_account_id', order: 'spotify_id.asc' }),
      spotifyPausedUntil(),
      Promise.all(accounts.map((a) => pgrSelect('created_playlists', { spotify_account_id: `eq.${a.id}` },
        { select: 'created_at', order: 'created_at.desc', limit: 1, useService: true })
        .then((rows) => rows?.[0]?.created_at || null))),
    ]);

    const emailOf = new Map(users.filter((u) => u?.id).map((u) => [u.id, u.email || null]));
    const bizById = new Map(businesses.map((b) => [b.id, b]));
    const bizView = (b) => ({ business_id: b.id, name: b.name || null, owner_email: emailOf.get(b.owner_id) || null });

    // account → business → live playlist count (the ledger knows each
    // playlist's account; rows without one are on the default account).
    const liveCount = new Map();
    for (const p of live) {
      const acct = p.spotify_account_id || DEFAULT_SPOTIFY_ACCOUNT;
      if (!liveCount.has(acct)) liveCount.set(acct, new Map());
      const byBiz = liveCount.get(acct);
      byBiz.set(p.business_id || null, (byBiz.get(p.business_id || null) || 0) + 1);
    }

    const accountIds = new Set(accounts.map((a) => a.id));
    const out = accounts.map((a, i) => {
      const counts = liveCount.get(a.id) || new Map();
      const ids = new Set([
        ...businesses.filter((b) => b.spotify_account_id === a.id).map((b) => b.id),
        ...[...counts.keys()].filter((id) => id && bizById.has(id)),
      ]);
      const env = spotifyAccountEnv(a.id);
      let status = 'ok';
      let statusDetail = null;
      if (!a.active) {
        status = 'disabled';
      } else if (!env.refreshToken) {
        status = 'error';
        statusDetail = `no login token in this deployment (${env.refreshVar})`;
      } else if (pausedUntil) {
        status = 'error';
        statusDetail = `Spotify writes paused until ${new Date(pausedUntil).toISOString()}`;
      }
      return {
        id: a.id,
        label: a.label || null,
        email: a.email || null,
        spotify_user_id: a.spotify_user_id || null,
        display_name: a.display_name || null,
        profile_url: a.spotify_user_id ? `https://open.spotify.com/user/${encodeURIComponent(a.spotify_user_id)}` : null,
        status,
        status_detail: statusDetail,
        last_ok_at: lastMade[i],
        playlist_count: [...counts.values()].reduce((s, n) => s + n, 0),
        businesses: [...ids].map((id) => ({ ...bizView(bizById.get(id)), playlist_count: counts.get(id) || 0 }))
          .sort((x, y) => String(x.name || '').localeCompare(String(y.name || ''))),
      };
    });

    const unassigned = businesses.filter((b) => !b.spotify_account_id || !accountIds.has(b.spotify_account_id)).map(bizView);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ accounts: out, unassigned_businesses: unassigned, notes: [] });
  } catch (err) {
    console.error('[internal:spotify-accounts] failed:', err.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
