/* /api/v4/ami-stop.js
   POST /api/v4/ami-stop

   Ami's STOP button. Marks all active scan_jobs (pending / fetching_tracks /
   analyzing) as 'stopped'. Progress made so far is preserved — tracks
   already in track_analyses stay there, and scan_jobs.tracks_analyzed keeps
   its current value.

   If a cron tick is mid-flight when this runs, it holds the row lock but
   polls status between RapidAPI calls; it will bail within one call (~30s
   max) and NOT overwrite the 'stopped' status it observes.

   Restart: when Ami hits Scan again, ami-scan revives stopped jobs whose
   playlist_id is still in the sheet, and cascade-deletes those whose
   playlist_id was removed.
*/

import { pgrRpc } from './supabase-client.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        // Flip is_active=false first so the next cron tick short-circuits and
        // doesn't try to acquire a new job. Then mark the currently-active
        // jobs as 'stopped' (an in-flight cron will finish its last RapidAPI
        // call, poll status, see 'stopped', and bail).
        await pgrRpc('set_batch_active', { p_active: false }, { useService: true });
        const rowsAffected = await pgrRpc('stop_active_scan_jobs', {}, { useService: true });
        return res.status(200).json({ ok: true, stopped: rowsAffected });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
