/* /api/v4/ami-start.js
   POST /api/v4/ami-start

   Ami's START button. Sets batch_control.is_active = true so the cron worker
   begins picking up pending scan_jobs on its next tick (fires every minute).

   Also revives any 'stopped' scan_jobs — Ami wanted them ready to run again
   when he starts. Revival mirrors ami-scan's rule: if tracks_total > 0 the
   playlist was already partway through analysis, so revive as 'analyzing';
   otherwise revive as 'pending' (fetch will re-run).
*/

import { pgrRpc } from './supabase-client.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        console.log('[ami-start] invoked');

        // 1. Revive stopped jobs so they get picked up alongside pendings.
        //    Pure UPDATE via RPC — no INSERT path, so scan_jobs' NOT NULL
        //    constraints aren't a hazard.
        console.log('[ami-start] calling revive_stopped_scan_jobs RPC...');
        const revivedCount = await pgrRpc('revive_stopped_scan_jobs', {}, { useService: true });
        console.log('[ami-start] revive_stopped_scan_jobs returned:', revivedCount);

        // 2. Flip is_active. Cron's next tick will pick up the first job.
        console.log('[ami-start] calling set_batch_active(true)...');
        const setResult = await pgrRpc('set_batch_active', { p_active: true }, { useService: true });
        console.log('[ami-start] set_batch_active returned:', setResult);

        console.log('[ami-start] success — cron will pick up on next tick');
        return res.status(200).json({
            ok: true,
            revivedCount,
        });
    } catch (err) {
        console.error('[ami-start] FAILED:', err.message, err.stack);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
