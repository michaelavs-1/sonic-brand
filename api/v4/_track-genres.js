/* /api/v4/_track-genres.js
   Which genres a catalog track is in, and changing them — for the Ami
   dashboard's Track cleanup (Ami, 2026-10-05). Private helper (leading
   underscore — not an HTTP endpoint).

   A track has no genre column: it's "in" a genre because it sits in a
   playlist (playlist_tracks) tagged with that genre (playlist_genres). Every
   track-fetch RPC reads it that way, so edits change those two tables:
     - Removing a genre drops the track from every playlist it's in that is
       tagged with that genre. A few playlists carry two genres (8 of 1,024
       on 2026-10-05); when the track keeps the other one, it goes back into
       that genre through a manual placement (below).
     - Adding a genre is a "manual placement": the track joins the genre's
       manual playlist, `manual:<genre>` — a playlist that exists only in our
       DB, one per genre, tagged with that genre. The RPCs pick it up like any
       other playlist. Ami's sheet scan (ami-scan.js) and dry-run-fill.mjs skip
       manual playlists, so placements survive scans.
   Genres are stored lowercase in playlist_genres (the RPCs lowercase-match).
   Every edit is logged in track_genre_edits with the track's playlist_tracks
   rows before and after; undo puts the "before" rows back.
*/

import { pgrSelect, pgrSelectIn, pgrUpsert, pgrDelete } from './supabase-client.js';

export const MANUAL_PREFIX = 'manual:';
export const isManualPlaylist = (id) => String(id || '').startsWith(MANUAL_PREFIX);
export const manualPlaylistId = (genre) => `${MANUAL_PREFIX}${genre}`;
const manualGenre = (id) => String(id).slice(MANUAL_PREFIX.length);

const inList = (values) => `in.(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')})`;

// The track's playlist_tracks rows, the genres of each of those playlists, and
// the track's genres (the union).
export async function loadTrackGenres(spotifyId) {
    const rows = await pgrSelect('playlist_tracks', { spotify_id: `eq.${spotifyId}` }, {});
    const playlistIds = [...new Set((rows || []).map((r) => r.playlist_id))];
    const genreRows = playlistIds.length
        ? await pgrSelectIn('playlist_genres', 'playlist_id', playlistIds, { select: 'playlist_id,genre' })
        : [];
    const genresByPlaylist = new Map(playlistIds.map((id) => [id, []]));
    for (const r of genreRows || []) genresByPlaylist.get(r.playlist_id)?.push(r.genre);
    const genres = [...new Set([...genresByPlaylist.values()].flat())].sort();
    return { rows: rows || [], genresByPlaylist, genres };
}

// Pure: what to change so the track ends up in exactly `targetGenres`.
//   keep   — rows whose playlist's genres are all still wanted (a playlist with
//            no genre row says nothing about genres, so it stays too)
//   remove — every other row
//   add    — a manual placement for each wanted genre no kept row covers
export function planGenreChange(spotifyId, rows, genresByPlaylist, targetGenres) {
    const target = new Set(targetGenres);
    const keep = [];
    const remove = [];
    for (const r of rows) {
        const genres = genresByPlaylist.get(r.playlist_id) || [];
        (genres.every((g) => target.has(g)) ? keep : remove).push(r);
    }
    const covered = new Set(keep.flatMap((r) => genresByPlaylist.get(r.playlist_id) || []));
    const add = [...target].filter((g) => !covered.has(g)).sort()
        .map((genre) => ({ playlist_id: manualPlaylistId(genre), spotify_id: spotifyId, position: null }));
    return { keep, remove, add };
}

// Manual playlists need their playlist_genres row before the track joins them.
async function ensureManualPlaylists(playlistIds) {
    const manual = [...new Set(playlistIds.filter(isManualPlaylist))];
    if (!manual.length) return;
    await pgrUpsert('playlist_genres', manual.map((id) => ({
        playlist_id: id, genre: manualGenre(id), position_in_genre: null,
    })));
}

const slim = (r) => ({ playlist_id: r.playlist_id, spotify_id: r.spotify_id, position: r.position ?? null });

// Additions first, then removals, so a failure halfway leaves the track in
// more genres rather than fewer.
export async function applyGenrePlan(spotifyId, { remove, add }) {
    if (add.length) {
        await ensureManualPlaylists(add.map((r) => r.playlist_id));
        await pgrUpsert('playlist_tracks', add.map(slim));
    }
    if (remove.length) {
        await pgrDelete('playlist_tracks', {
            spotify_id:  `eq.${spotifyId}`,
            playlist_id: inList(remove.map((r) => r.playlist_id)),
        });
    }
}

// Undo: make the track's playlist_tracks rows exactly `beforeRows` again.
export async function restoreTrackRows(spotifyId, beforeRows) {
    const before = (Array.isArray(beforeRows) ? beforeRows : []).map(slim);
    const { rows } = await loadTrackGenres(spotifyId);
    const keepIds = new Set(before.map((r) => r.playlist_id));
    if (before.length) {
        await ensureManualPlaylists(before.map((r) => r.playlist_id));
        await pgrUpsert('playlist_tracks', before);
    }
    const extra = rows.filter((r) => !keepIds.has(r.playlist_id)).map((r) => r.playlist_id);
    if (extra.length) {
        await pgrDelete('playlist_tracks', { spotify_id: `eq.${spotifyId}`, playlist_id: inList(extra) });
    }
}
