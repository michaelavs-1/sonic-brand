/* /api/v4/ami-track-genres.js
   POST /api/v4/ami-track-genres
   Body: { action: 'set', spotifyId, genres: ["rnb", "neo soul"], title?, artists? }
       | { action: 'undo', editId }

   Track cleanup's genre editor (Ami, 2026-10-05): put a catalog track in
   exactly the given genres — out of some, into others — or undo the last such
   change. How a genre change maps onto playlist_tracks / playlist_genres
   (including "manual" placements) is in ./_track-genres.js.

   'set': genres are lowercase names, each either canonical
   (shared/genre-universe.js) or one the track is already in. Adding a genre
   needs a usable audio analysis (status ok) — the playlist builders skip
   tracks without one. Every change is logged in track_genre_edits (migration
   v5/precompute/migrations/2026-10-05-track-genre-edits.sql) BEFORE it's
   applied, so even a half-applied change can be undone.
     → { ok, editId, genres, removedFrom: [playlist_id], addedManual: [genre] }
       | { ok, unchanged: true, genres }

   'undo': puts back the track's playlist_tracks rows from before that edit.
     → { ok, spotifyId, genres }

   Same access model as the other ami-track-* endpoints. All writes go
   through service_role.
*/

import { pgrSelect, pgrInsert, pgrPatch } from './supabase-client.js';
import { MANUAL_PREFIX, loadTrackGenres, planGenreChange, applyGenrePlan, restoreTrackRows } from './_track-genres.js';
import { GENRES } from '../../shared/genre-universe.js';

const CANONICAL = new Set(GENRES.map((g) => g.toLowerCase()));

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const body = req.body || {};
        if (body.action === 'undo') return await undo(body, res);
        if (body.action === 'set')  return await setGenres(body, res);
        return res.status(400).json({ error: "action must be 'set' or 'undo'" });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}

async function setGenres({ spotifyId, genres, title, artists }, res) {
    if (!spotifyId || !/^[a-zA-Z0-9]{22}$/.test(spotifyId)) {
        return res.status(400).json({ error: 'spotifyId (22-char alphanumeric) required' });
    }
    if (!Array.isArray(genres)) return res.status(400).json({ error: 'genres array required' });

    const state = await loadTrackGenres(spotifyId);
    const target = [...new Set(genres.map((g) => String(g || '').trim().toLowerCase()).filter(Boolean))].sort();
    const unknown = target.filter((g) => !CANONICAL.has(g) && !state.genres.includes(g));
    if (unknown.length) return res.status(400).json({ error: `Unknown genre(s): ${unknown.join(', ')}` });

    const plan = planGenreChange(spotifyId, state.rows, state.genresByPlaylist, target);
    if (!plan.remove.length && !plan.add.length) {
        return res.status(200).json({ ok: true, unchanged: true, genres: state.genres });
    }
    if (plan.add.length) {
        const [analysis] = await pgrSelect('track_analyses', { spotify_id: `eq.${spotifyId}` }, { select: 'status', limit: 1 });
        if (analysis?.status !== 'ok') {
            return res.status(400).json({
                error: "This track has no usable audio analysis, so the playlist builders skip it — it can't be added to a genre. Removing genres still works.",
            });
        }
    }

    const [edit] = await pgrInsert('track_genre_edits', [{
        spotify_id:    spotifyId,
        title:         typeof title === 'string' ? title.slice(0, 300) : null,
        artist:        Array.isArray(artists) ? artists.join(', ').slice(0, 300) : null,
        before_genres: state.genres,
        after_genres:  target,
        before_rows:   state.rows,
        after_rows:    [...plan.keep, ...plan.add],
    }], { returnRows: true });

    await applyGenrePlan(spotifyId, plan);
    const after = await loadTrackGenres(spotifyId);
    return res.status(200).json({
        ok:          true,
        editId:      edit?.id ?? null,
        genres:      after.genres,
        removedFrom: plan.remove.map((r) => r.playlist_id),
        addedManual: plan.add.map((r) => r.playlist_id.slice(MANUAL_PREFIX.length)),
    });
}

async function undo({ editId }, res) {
    if (!Number.isInteger(Number(editId))) return res.status(400).json({ error: 'editId required' });
    // useService: track_genre_edits has RLS on with no policies (server-only).
    const [edit] = await pgrSelect('track_genre_edits', { id: `eq.${Number(editId)}` }, { limit: 1, useService: true });
    if (!edit) return res.status(404).json({ error: 'No such genre change.' });
    if (edit.undone_at) return res.status(409).json({ error: 'This genre change was already undone.' });

    await restoreTrackRows(edit.spotify_id, edit.before_rows);
    await pgrPatch('track_genre_edits', { id: `eq.${edit.id}` }, { undone_at: new Date().toISOString() });
    const after = await loadTrackGenres(edit.spotify_id);
    return res.status(200).json({ ok: true, spotifyId: edit.spotify_id, genres: after.genres });
}
