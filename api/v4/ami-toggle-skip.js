/* /api/v4/ami-toggle-skip.js
   POST /api/v4/ami-toggle-skip
   Body: { playlistId: "abc123", skip: true|false }

   Toggles a single scan_jobs row between 'pending' and 'skipped'. Skipped
   rows stay in the queue (visually greyed) but the cron worker's
   acquireNextJob WHERE clause already excludes anything not in
   ('pending','fetching_tracks','analyzing'), so a skipped row is naturally
   passed over.

   Only fires the transition if the row's current status matches the request
   (pending -> skipped needs current status='pending', and vice versa).
   Rows in other states (analyzing, done, error, paused, stopped) are no-ops.
*/

import { pgrRpc } from './supabase-client.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { playlistId, skip } = req.body || {};
        if (!playlistId || typeof skip !== 'boolean') {
            return res.status(400).json({ error: 'playlistId (string) and skip (boolean) required' });
        }
        const newStatus = await pgrRpc('toggle_scan_job_skip',
            { p_playlist_id: String(playlistId), p_skip: skip },
            { useService: true },
        );
        return res.status(200).json({ ok: true, playlistId, status: newStatus });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
