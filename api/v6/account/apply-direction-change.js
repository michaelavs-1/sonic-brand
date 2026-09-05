/* /api/v6/account/apply-direction-change.js
   Commits one direction-edit chat proposal.

   Called when the owner swipes right (or super-likes) in the preview modal
   for an edit or add, or clicks the inline confirm on a remove proposal.

   Three flavors, per the `kind` field in the request body:

     'add' — insert a new business_directions row (active=true) and build
       ONE playlist for today from the fresh direction. Enforces the
       ≤8-active cap.

     'edit' — apply an `updates` blob to an existing direction. Mutations
       mirror the merge in /api/v6/account/preview-direction. After the
       row is updated, the direction's currently-live playlist (if any)
       is expired on Rubin's side and a fresh playlist gets built with
       the new spec. The old row stays in business_playlists (soft-
       expired via expires_at).

     'remove' — set active=false on the direction (the row is preserved
       so the admin API and future audit-log queries can still see it).
       Depending on `expireLivePlaylist`, either expire today's playlist
       immediately or let it run out to its own expires_at.

   Every commit writes an audit row in business_direction_changes with a
   before/after snapshot + the message-range that produced the change
   (both `messageIdFirst` and `messageIdLast` are optional; pass either
   from the client after a proposal is accepted).

   Bonus: if the client passes `superLikedTrackId`, that Spotify id is
   upserted into super_liked_tracks so the owner's tap on the modal's
   super-like button is preserved for future taste-tuning. Same table +
   unique constraint as onboarding's flow — safe to call with the same
   id twice.

   Request body:
     {
       businessId,
       kind: 'add' | 'edit' | 'remove',
       directionId?,           // required for edit / remove
       updates?,               // for edit
       spec?,                  // for add
       expireLivePlaylist?,    // for remove, default false
       superLikedTrackId?,     // optional; upsert to super_liked_tracks
       messageIdFirst?,        // audit trail refs into business_direction_chats
       messageIdLast?,
     }

   Response:
     { ok: true, change: {...}, direction?: {...}, playlist?: {...} }
       change   = the business_direction_changes row that was inserted
       direction = updated / inserted business_directions row (add / edit)
       playlist = the newly-built business_playlists row (add / edit)
*/

import { pgrSelect, pgrInsert, pgrPatch, pgrUpsert } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from './_require-business-owner.js';
import { setCors } from '../origin-guard.js';
import { guard } from '../ratelimit.js';
import { buildOneDailyPlaylist, playlistName } from './_daily-builder.js';
import { expirePlaylistNow } from './_expire-playlist.js';
import { computeTargetForToday, dailyPlaylistExpiryIso, nextIl4amIso } from '../../../v6/generation/playlist-length.js';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Mirror of the postSpotify helper in _expire-playlist.js — carries the
// internal-key header so /api/new/spotify's origin-guard + rate-limit skip
// this server-to-server call.
async function postSpotify(origin, action, body) {
  const r = await fetch(`${origin}/api/new/spotify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sonic-internal': INTERNAL_API_KEY,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || r.statusText;
    throw new Error(`spotify ${action} ${r.status}: ${msg}`);
  }
  return data;
}

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_ACTIVE_DIRECTIONS = 8;

// -- helpers --------------------------------------------------------------

async function verifyUser(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

function selfOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

// The direction snapshot we persist to business_direction_changes.before /
// .after — small enough to store many, complete enough to reproduce the
// state at that moment.
function snapshotDirection(dir) {
  if (!dir) return null;
  return {
    id:                          dir.id,
    title_en:                    dir.title_en,
    description_he:              dir.description_he,
    genres:                      Array.isArray(dir.genres) ? dir.genres : [],
    bpm_range:                   dir.bpm_range,
    instrumentalness_preference: dir.instrumentalness_preference || 'none',
    popularity_preference:       dir.popularity_preference       || 'none',
    active:                      dir.active !== false,
  };
}

// Merge apply — mirror of preview-direction's mergeUpdates so the preview
// the owner saw and the committed spec agree.
function mergeUpdates(dir, updates) {
  const merged = { ...dir, genres: Array.isArray(dir.genres) ? [...dir.genres] : [] };
  if (!updates) return merged;
  if (Array.isArray(updates.exclude_genres) && updates.exclude_genres.length) {
    const drop = new Set(updates.exclude_genres.map((g) => String(g).toLowerCase()));
    merged.genres = merged.genres.filter((g) => !drop.has(String(g).toLowerCase()));
  }
  if (Array.isArray(updates.add_genres) && updates.add_genres.length) {
    const seen = new Set(merged.genres.map((g) => String(g).toLowerCase()));
    for (const g of updates.add_genres) {
      if (typeof g === 'string' && g.length && !seen.has(g.toLowerCase())) {
        merged.genres.push(g);
        seen.add(g.toLowerCase());
      }
    }
  }
  if (updates.bpm_range && Number.isFinite(updates.bpm_range.min) && Number.isFinite(updates.bpm_range.max)) {
    merged.bpm_range = { min: Math.round(updates.bpm_range.min), max: Math.round(updates.bpm_range.max) };
  }
  if (updates.instrumentalness_preference === 'none'
      || updates.instrumentalness_preference === 'soft'
      || updates.instrumentalness_preference === 'hard') {
    merged.instrumentalness_preference = updates.instrumentalness_preference;
  }
  if (updates.popularity_preference === 'none'
      || updates.popularity_preference === 'soft'
      || updates.popularity_preference === 'hard') {
    merged.popularity_preference = updates.popularity_preference;
  }
  if (typeof updates.title_en === 'string' && updates.title_en.trim().length) {
    merged.title_en = updates.title_en.trim();
  }
  if (typeof updates.description_he === 'string' && updates.description_he.trim().length) {
    merged.description_he = updates.description_he.trim();
  }
  return merged;
}

// Live Spotify playlist (if any) currently associated with a given
// direction. Preferred: direction_id FK. Fallback: match on the
// expansion.direction.title_en, for pre-2026-08-20 rows that predate the
// direction_id column.
async function findLivePlaylistForDirection(businessId, dir) {
  const rows = await pgrSelect('business_playlists',
    { business_id: `eq.${businessId}`, direction_id: `eq.${dir.id}` },
    { select: 'spotify_id,label,expires_at,event_id',
      order: 'created_at.desc', limit: 5, useService: true });
  const now = Date.now();
  const live = (rows || []).find((r) => !r.event_id && (!r.expires_at || Date.parse(r.expires_at) > now));
  return live || null;
}

// Best-effort super-liked persistence. Silent-fail: nothing consumes these
// rows yet, so a botched insert must not block the primary commit path.
// deleted_at:null resurrects any previously soft-deleted row (see
// toggle-super-like.js for the soft-delete pattern added 2026-09-05).
async function persistSuperLike(businessId, spotifyId) {
  if (!spotifyId || typeof spotifyId !== 'string') return;
  try {
    await pgrUpsert('super_liked_tracks',
      [{ business_id: businessId, spotify_id: spotifyId, deleted_at: null }],
      { onConflict: 'business_id,spotify_id' });
  } catch (e) {
    console.warn('[apply-direction-change] super_liked_tracks upsert failed:', e.message);
  }
}

// Build one fresh playlist for `direction` today, sized to today's opening
// hours. Reuses the same primitive daily-gen and expand-playlist use, so
// the resulting business_playlists row is identical in shape.
async function buildTodayPlaylist({ origin, ownerId, businessId, bizName, direction }) {
  // Today's target — open hours + 1h buffer, 12h floor for closed days.
  const hoursRows = await pgrSelect('business_hours',
    { business_id: `eq.${businessId}` },
    { select: 'hours', limit: 1, useService: true });
  const hours = hoursRows?.[0]?.hours || null;
  const target = computeTargetForToday({ hours });
  const expiryIso = dailyPlaylistExpiryIso({ hours }) || nextIl4amIso();

  const result = await buildOneDailyPlaylist({
    origin,
    ownerId,
    businessId,
    direction: {
      id:                          direction.id,
      title_en:                    direction.title_en,
      description_he:              direction.description_he,
      genres:                      direction.genres,
      bpm_range:                   direction.bpm_range,
      instrumentalness_preference: direction.instrumentalness_preference || 'none',
      popularity_preference:       direction.popularity_preference       || 'none',
    },
    target,
    bizName,
    expiryIso,
  });

  if (result.skipped) {
    throw new Error(`build failed: ${result.reason || 'no tracks matched'}`);
  }

  // buildOneDailyPlaylist builds the row shape but doesn't INSERT — the
  // batch version normally does that. Here we insert one row directly.
  try {
    await pgrInsert('business_playlists', result.row, { ignoreDuplicates: true });
  } catch (e) {
    console.error('[apply-direction-change] business_playlists insert failed:', e.message);
    throw e;
  }
  return result.row;
}

// -- handler --------------------------------------------------------------

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!await guard(req, res, 'apply-direction-change', 10, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const {
      businessId, kind, directionId, updates, spec,
      expireLivePlaylist, superLikedTrackId,
      messageIdFirst, messageIdLast,
    } = req.body || {};
    if (!businessId || !kind) return res.status(400).json({ error: 'businessId and kind required' });
    if (!['add', 'edit', 'remove'].includes(kind)) return res.status(400).json({ error: `unknown kind "${kind}"` });
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Best-effort super-liked persist happens up front so a downstream
    // failure doesn't cost us the tap.
    await persistSuperLike(businessId, superLikedTrackId);

    const bizRows = await pgrSelect('businesses',
      { id: `eq.${businessId}` }, { select: 'id,owner_id,name', limit: 1, useService: true });
    const business = bizRows?.[0];
    if (!business) return res.status(404).json({ error: 'business not found' });

    const origin = selfOrigin(req);

    // ============================ ADD =====================================
    if (kind === 'add') {
      if (!spec || typeof spec !== 'object') return res.status(400).json({ error: 'spec required for add' });
      if (!Array.isArray(spec.genres) || !spec.genres.length) return res.status(400).json({ error: 'spec.genres required' });
      if (!spec.bpm_range || !Number.isFinite(spec.bpm_range.min) || !Number.isFinite(spec.bpm_range.max)) {
        return res.status(400).json({ error: 'spec.bpm_range required' });
      }

      // Enforce the 8-active cap. Distinct error code so the client can
      // surface this as an inline chat message ("you're at 8 — remove one
      // first") rather than a generic error toast.
      const activeRows = await pgrSelect('business_directions',
        { business_id: `eq.${businessId}`, active: 'is.true' },
        { select: 'id', useService: true });
      if ((activeRows || []).length >= MAX_ACTIVE_DIRECTIONS) {
        return res.status(400).json({
          error: 'active direction cap reached (8) — remove one first',
          code:  'cap_reached',
        });
      }

      // popularity_window column is legacy (dropped from writes 2026-09-02).
      // New rows leave it NULL. The column stays in schema so existing rows
      // preserve their historical values; nothing reads them.
      const inserted = await pgrInsert('business_directions', {
        business_id:                 businessId,
        rank:                        null,
        title_en:                    String(spec.title_en || '').trim().slice(0, 120) || 'New Direction',
        description_he:              String(spec.description_he || '').trim().slice(0, 800),
        genres:                      spec.genres,
        bpm_range:                   { min: Math.round(spec.bpm_range.min), max: Math.round(spec.bpm_range.max) },
        instrumentalness_preference: (spec.instrumentalness_preference === 'soft' || spec.instrumentalness_preference === 'hard')
                                       ? spec.instrumentalness_preference : 'none',
        popularity_preference:       (spec.popularity_preference       === 'soft' || spec.popularity_preference       === 'hard')
                                       ? spec.popularity_preference       : 'none',
        active:                      true,
      }, { returnRows: true });
      const dirRow = Array.isArray(inserted) ? inserted[0] : inserted;
      if (!dirRow?.id) return res.status(500).json({ error: 'direction insert returned no row' });

      // Build a fresh playlist for today from the new direction.
      let playlistRow = null;
      let playlistAction = 'rebuilt';
      try {
        playlistRow = await buildTodayPlaylist({
          origin, ownerId: user.id, businessId, bizName: business.name, direction: dirRow,
        });
      } catch (e) {
        console.error('[apply-direction-change:add] playlist build failed:', e.message);
        playlistAction = null;   // audit row still gets written; owner sees a soft error toast
      }

      const changeInserted = await pgrInsert('business_direction_changes', {
        business_id:      businessId,
        direction_id:     dirRow.id,
        kind:             'add',
        before:           null,
        after:            snapshotDirection(dirRow),
        message_id_first: messageIdFirst || null,
        message_id_last:  messageIdLast  || null,
        playlist_action:  playlistAction,
      }, { returnRows: true });
      const changeRow = Array.isArray(changeInserted) ? changeInserted[0] : changeInserted;

      return res.status(200).json({
        ok:         true,
        change:     changeRow,
        direction:  dirRow,
        playlist:   playlistRow,
      });
    }

    // ============================ EDIT ====================================
    if (kind === 'edit') {
      if (!directionId) return res.status(400).json({ error: 'directionId required for edit' });
      if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates required for edit' });

      const rows = await pgrSelect('business_directions',
        { id: `eq.${directionId}`, business_id: `eq.${businessId}` },
        { select: 'id,rank,title_en,description_he,genres,bpm_range,instrumentalness_preference,popularity_preference,active',
          limit: 1, useService: true });
      const dir = rows?.[0];
      if (!dir) return res.status(404).json({ error: 'direction not found' });

      const before = snapshotDirection(dir);
      const merged = mergeUpdates(dir, updates);
      if (!merged.genres.length) return res.status(400).json({ error: 'edit would leave the direction with zero genres' });

      // Apply the update in place. We PATCH only the fields the merge
      // actually moved; that keeps concurrent unrelated updates (e.g.,
      // rank re-ordering) intact.
      const patch = {};
      if (JSON.stringify(merged.genres)         !== JSON.stringify(before.genres))         patch.genres = merged.genres;
      if (JSON.stringify(merged.bpm_range)      !== JSON.stringify(before.bpm_range))      patch.bpm_range = merged.bpm_range;
      if (merged.instrumentalness_preference    !== before.instrumentalness_preference)    patch.instrumentalness_preference = merged.instrumentalness_preference;
      if (merged.popularity_preference          !== before.popularity_preference)          patch.popularity_preference       = merged.popularity_preference;
      if (merged.title_en                       !== before.title_en)                       patch.title_en = merged.title_en;
      if (merged.description_he                 !== before.description_he)                 patch.description_he = merged.description_he;
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        await pgrPatch('business_directions',
          { id: `eq.${directionId}`, business_id: `eq.${businessId}` }, patch);
      }
      const updatedDir = { ...dir, ...patch };

      // Cosmetic-only fast path — the merge only moved title_en and/or
      // description_he (no genres, BPM, or preference changes). Same music,
      // just a new label. Rebuilding here would waste an API budget's worth
      // of Spotify writes and produce a completely different playlist
      // (fresh random draw from the same spec) — the owner asked for a
      // rename, not a reshuffle. Instead: rename the live playlist in place
      // via Spotify's PUT /playlists/{id} and update business_playlists.label
      // to match. `expireLivePlaylist` is intentionally IGNORED on this
      // path — cosmetic edits never rebuild.
      const changedFields = Object.keys(patch).filter((k) => k !== 'updated_at');
      const cosmeticOnly  = changedFields.length > 0
        && changedFields.every((k) => k === 'title_en' || k === 'description_he');

      let playlistRow    = null;
      let playlistAction = 'kept';

      if (cosmeticOnly) {
        const live = await findLivePlaylistForDirection(businessId, dir);
        if (live?.spotify_id) {
          const newSpotifyName = playlistName(business.name, updatedDir);
          const newDescription = updatedDir.description_he || updatedDir.title_en || '';
          try {
            await postSpotify(origin, 'update_playlist', {
              playlist_id: live.spotify_id,
              name:        newSpotifyName,
              description: newDescription,
            });
            // Mirror the label change onto business_playlists so the home
            // tab picks up the new title on its next loadDashboardData.
            // Only PATCH the label column when title_en actually moved —
            // description-only edits don't need a label change.
            const bpPatch = {};
            if (patch.title_en) bpPatch.label = updatedDir.title_en || 'פלייליסט';
            if (Object.keys(bpPatch).length) {
              await pgrPatch('business_playlists',
                { spotify_id: `eq.${live.spotify_id}`, business_id: `eq.${businessId}` },
                bpPatch);
            }
            // Also refresh the created_playlists ledger's mirror of the
            // Spotify name so the expire cron's "(expired) <name>" rename
            // uses the current title when the playlist eventually ages out.
            try {
              await pgrPatch('created_playlists',
                { spotify_id: `eq.${live.spotify_id}` },
                { name: newSpotifyName });
            } catch (e) {
              console.warn('[apply-direction-change:edit-rename] ledger name mirror failed:', e.message);
            }
            playlistAction = 'renamed';
            // Deliberately leave playlistRow null. The client uses
            // `res.playlist?.url` to decide whether to render a "פתחו את
            // הפלייליסט" link on the success bubble; for a rename there IS
            // no new thing to open (same playlist, same tracks, new label),
            // so we want the success bubble to stand alone. The home tab
            // still picks up the new label via the direction-change-applied
            // event → loadDashboardData reread of business_playlists.
          } catch (e) {
            console.warn('[apply-direction-change:edit-rename] spotify rename failed:', e.message);
            // Row was updated; Spotify rename failed. Audit as 'kept' since
            // the playlist wasn't actually renamed on Spotify's side.
          }
        }
      } else if (expireLivePlaylist) {
        // Non-cosmetic edit + owner opted to replace today's playlist.
        const live = await findLivePlaylistForDirection(businessId, dir);
        if (live?.spotify_id) {
          try {
            await expirePlaylistNow({ origin, spotifyId: live.spotify_id, name: live.label });
            // Mirror the expiry onto the business_playlists row so the
            // dashboard's playlistIsLive() filter hides it right away.
            await pgrPatch('business_playlists',
              { spotify_id: `eq.${live.spotify_id}`, business_id: `eq.${businessId}` },
              { expires_at: new Date().toISOString() });
          } catch (e) {
            console.warn('[apply-direction-change:edit] live playlist expiry failed:', e.message);
          }
        }
        try {
          playlistRow    = await buildTodayPlaylist({
            origin, ownerId: user.id, businessId, bizName: business.name, direction: updatedDir,
          });
          playlistAction = 'rebuilt';
        } catch (e) {
          console.error('[apply-direction-change:edit] rebuild failed:', e.message);
          playlistAction = null;
        }
      }
      // else: non-cosmetic edit + expireLivePlaylist=false → leave the old
      // playlist alone. Tomorrow's daily cron picks up the updated spec.
      // 'kept' in the audit row.

      const changeInserted = await pgrInsert('business_direction_changes', {
        business_id:      businessId,
        direction_id:     directionId,
        kind:             'edit',
        before,
        after:            snapshotDirection(updatedDir),
        message_id_first: messageIdFirst || null,
        message_id_last:  messageIdLast  || null,
        playlist_action:  playlistAction,
      }, { returnRows: true });
      const changeRow = Array.isArray(changeInserted) ? changeInserted[0] : changeInserted;

      return res.status(200).json({
        ok:        true,
        change:    changeRow,
        direction: updatedDir,
        playlist:  playlistRow,
      });
    }

    // ============================ REMOVE ==================================
    if (kind === 'remove') {
      if (!directionId) return res.status(400).json({ error: 'directionId required for remove' });

      const rows = await pgrSelect('business_directions',
        { id: `eq.${directionId}`, business_id: `eq.${businessId}` },
        { select: 'id,rank,title_en,description_he,genres,bpm_range,instrumentalness_preference,popularity_preference,active',
          limit: 1, useService: true });
      const dir = rows?.[0];
      if (!dir) return res.status(404).json({ error: 'direction not found' });
      const before = snapshotDirection(dir);

      // Soft-disable (row preserved). Nothing else in the daily-gen path
      // will pick this direction up because activeDirections() filters on
      // active=true. Historical playlists survive; the admin API still
      // sees the direction (with active=false).
      await pgrPatch('business_directions',
        { id: `eq.${directionId}`, business_id: `eq.${businessId}` },
        { active: false, updated_at: new Date().toISOString() });

      // Optionally expire today's playlist. The client asked the owner
      // inline; the answer arrives on `expireLivePlaylist`.
      //
      // 2026-09-05: this branch used to call `expirePlaylistNow` inline
      // (rename + empty + unfollow on Spotify — 3 sequential calls, 5-15s
      // realistic). The card only hid once the whole chain completed, so
      // the owner watched a spinner for that entire time. Now we do the
      // fast DB-only piece here — expire BOTH the business_playlists row
      // (dashboard filters on this) AND the created_playlists ledger row
      // (cleanup cron filters on this) — and hand the Spotify side off to
      // the next :30 cleanup cron tick. Card disappears in ~500ms instead
      // of 5-15s. Trade-off: the playlist stays under its original name in
      // Rubin's library for up to 30 minutes before the cron renames +
      // empties + unfollows it. Owners never see Rubin's library, so
      // this is invisible to them.
      let playlistAction = 'kept';
      if (expireLivePlaylist) {
        const live = await findLivePlaylistForDirection(businessId, dir);
        if (live?.spotify_id) {
          const nowIso = new Date().toISOString();
          try {
            // Parallel — no ordering dependency between the two tables.
            await Promise.all([
              pgrPatch('business_playlists',
                { spotify_id: `eq.${live.spotify_id}`, business_id: `eq.${businessId}` },
                { expires_at: nowIso }),
              pgrPatch('created_playlists',
                { spotify_id: `eq.${live.spotify_id}` },
                { expires_at: nowIso }),
            ]);
            playlistAction = 'expired';
          } catch (e) {
            console.warn('[apply-direction-change:remove] expiry PATCH failed:', e.message);
            // Keep playlist_action='kept' — dashboard will keep showing
            // the card until the next daily-gen tick or a manual retry.
          }
        }
      }

      const changeInserted = await pgrInsert('business_direction_changes', {
        business_id:      businessId,
        direction_id:     directionId,
        kind:             'remove',
        before,
        after:            null,
        message_id_first: messageIdFirst || null,
        message_id_last:  messageIdLast  || null,
        playlist_action:  playlistAction,
      }, { returnRows: true });
      const changeRow = Array.isArray(changeInserted) ? changeInserted[0] : changeInserted;

      return res.status(200).json({
        ok:        true,
        change:    changeRow,
        direction: { ...dir, active: false },
      });
    }

    // Unreachable — the kind whitelist above already returned.
    return res.status(400).json({ error: 'unhandled kind' });
  } catch (err) {
    console.error('[apply-direction-change] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
