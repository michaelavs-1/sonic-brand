/* /api/v4/ami-logs.js
   GET /api/v4/ami-logs?since_id=<n>&limit=<n>

   Returns recent scan_logs rows in ASCENDING id order so the client can just
   append to the terminal view. On first call (no since_id), returns the last
   `limit` rows. On subsequent calls, returns only rows with id > since_id.

   The dashboard polls this every ~2s and appends to the "Live activity log"
   terminal panel.
*/

import { pgrSelect } from './supabase-client.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

    try {
        const sinceId = req.query?.since_id ? parseInt(String(req.query.since_id), 10) : null;
        const limit   = Math.min(500, parseInt(String(req.query?.limit || '100'), 10));

        // For "give me the latest N" (no cursor), we need id-desc + limit,
        // then reverse in JS. For "give me rows > N", we use id-asc + limit.
        let logs;
        if (Number.isFinite(sinceId) && sinceId > 0) {
            logs = await pgrSelect('scan_logs',
                { id: `gt.${sinceId}` },
                {
                    select: 'id,playlist_id,playlist_title,spotify_id,level,kind,message,duration_ms,tracks_analyzed,tracks_total,created_at',
                    order:  'id.asc',
                    limit,
                },
            );
        } else {
            const desc = await pgrSelect('scan_logs',
                {},
                {
                    select: 'id,playlist_id,playlist_title,spotify_id,level,kind,message,duration_ms,tracks_analyzed,tracks_total,created_at',
                    order:  'id.desc',
                    limit,
                },
            );
            logs = desc.reverse();
        }

        return res.status(200).json({
            logs,
            lastId: logs.length ? logs[logs.length - 1].id : (sinceId || 0),
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
