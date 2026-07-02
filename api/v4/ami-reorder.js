/* /api/v4/ami-reorder.js
   POST /api/v4/ami-reorder
   Body: { order: ["playlistId1", "playlistId2", ...] }

   Bulk-updates scan_jobs.priority so that the given order becomes the
   scan order. Priorities are spaced by 10 (10, 20, 30, ...) to leave room
   for the next scan's inserts to slot in without a rewrite.

   Only affects jobs whose IDs are in the request. Jobs not mentioned keep
   their existing priorities — which will typically place them at the end
   of the queue since new-scan priorities start above 1000.
*/

import { pgrRpc } from './supabase-client.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { order } = req.body || {};
        if (!Array.isArray(order) || order.length === 0) {
            return res.status(400).json({ error: 'order[] required' });
        }

        // Bulk UPDATE via reorder_scan_jobs RPC — pure UPDATE (no INSERT),
        // so we don't trip the NOT NULL constraints if a caller sends a
        // stale playlist_id that was deleted since the last poll.
        const rowsAffected = await pgrRpc('reorder_scan_jobs',
            { p_order: order.map(String) },
            { useService: true },
        );

        return res.status(200).json({ ok: true, updated: rowsAffected });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
