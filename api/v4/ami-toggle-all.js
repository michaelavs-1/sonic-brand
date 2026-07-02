/* /api/v4/ami-toggle-all.js
   POST /api/v4/ami-toggle-all
   Body: { skip: true|false }

   Bulk-toggles every scan_jobs row between 'pending' and 'skipped':
     - skip=true  → all 'pending' rows become 'skipped'
     - skip=false → all 'skipped' rows become 'pending'

   Rows in other statuses (analyzing, done, error, paused, stopped) are
   untouched. Called from the "Skip all" / "Queue all" button at the top of
   the playlist queue.
*/

import { pgrRpc } from './supabase-client.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { skip } = req.body || {};
        if (typeof skip !== 'boolean') {
            return res.status(400).json({ error: 'skip (boolean) required' });
        }
        const rowsAffected = await pgrRpc('toggle_all_scan_jobs_skip',
            { p_skip: skip },
            { useService: true },
        );
        return res.status(200).json({ ok: true, updated: rowsAffected });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
