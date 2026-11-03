/* /api/v4/ami-track-energy.js
   POST /api/v4/ami-track-energy
   Body: { spotifyId, energy }   // energy: a whole number 0–100

   Track cleanup's energy field (Ami, 2026-11-03): Ami sets a track's
   track_analyses.energy by hand. That column is what every energy range
   reads: both daily builders, the onboarding cards, the energy circles and
   Ami's test playlists. It takes effect from the next build or draw;
   playlists already on Spotify keep their songs.

   Only the column changes. raw_analysis keeps what the analysis service
   returned (its `energy` equals the column until an edit), so the card can
   show the original value and put it back. A re-analysis would overwrite an
   edit, but the scans only re-analyse failed tracks, and those can't be
   edited: only tracks with a usable analysis (status ok) — the rest don't
   play, so their energy means nothing.

   Every change is logged in admin_actions (action 'track:energy', no
   business; migration 2026-10-13-admin-console.sql), best-effort.
     → { ok, spotifyId, energy, before, analysisEnergy }
       | { ok, unchanged: true, spotifyId, energy, analysisEnergy }

   Same access model as the other ami-track-* endpoints. Writes go through
   service_role.
*/

import { pgrSelect, pgrPatch } from './supabase-client.js';
import { logAdminAction } from '../internal/_admin.js';
import { requireAmi } from './_ami-auth.js';

// raw_analysis.energy is a number in every row checked (2026-11-03); the
// scans parse it the same way when they fill the column (an int column, so
// rounded).
const rawEnergy = (raw) => {
    const v = raw?.energy;
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
    return Number.isFinite(n) ? Math.round(n) : null;
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!requireAmi(req, res)) return;
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { spotifyId, energy } = req.body || {};
        if (!spotifyId || !/^[a-zA-Z0-9]{22}$/.test(spotifyId)) {
            return res.status(400).json({ error: 'spotifyId (22-char alphanumeric) required' });
        }
        const value = (energy === null || energy === '' || energy === undefined) ? NaN : Number(energy);
        if (!Number.isInteger(value) || value < 0 || value > 100) {
            return res.status(400).json({ error: 'Energy must be a whole number from 0 to 100.' });
        }

        const [row] = await pgrSelect('track_analyses', { spotify_id: `eq.${spotifyId}` },
            { select: 'status,energy,raw_analysis', limit: 1, useService: true });
        if (!row) return res.status(404).json({ error: 'This track has no analysis yet, so it has no energy to change.' });
        if (row.status !== 'ok') {
            return res.status(400).json({ error: "This track's analysis failed, so it doesn't play and its energy can't be set." });
        }

        const analysisEnergy = rawEnergy(row.raw_analysis);
        if (row.energy === value) {
            return res.status(200).json({ ok: true, unchanged: true, spotifyId, energy: value, analysisEnergy });
        }

        await pgrPatch('track_analyses', { spotify_id: `eq.${spotifyId}`, status: 'eq.ok' }, { energy: value });
        await logAdminAction(null, 'track:energy', {
            spotify_id: spotifyId, before: row.energy, after: value, analysis: analysisEnergy,
        });
        return res.status(200).json({ ok: true, spotifyId, energy: value, before: row.energy, analysisEnergy });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
