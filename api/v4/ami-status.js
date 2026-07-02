/* /api/v4/ami-status.js
   GET /api/v4/ami-status

   Returns the current scan_jobs queue (ordered by priority) plus aggregate
   counters and the RapidAPI monthly-usage snapshot. The dashboard polls this
   every 5 seconds to refresh progress bars.
*/

import { pgrSelect } from './supabase-client.js';

const MONTHLY_CAP      = 50_000;
const SAFETY_THRESHOLD = 48_000;

function currentMonthUtc() {
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${yyyy}-${mm}`;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

    try {
        // Use allSettled so a missing rapidapi_usage or batch_control (e.g.
        // the DDL for those tables hasn't been run yet) doesn't kill the
        // whole status response. scan_jobs is the core payload — if THAT
        // fails, we surface the error.
        const results = await Promise.allSettled([
            pgrSelect('scan_jobs', {}, {
                select: 'playlist_id,playlist_title,playlist_url,genre,business_types,priority,status,tracks_total,tracks_analyzed,error,updated_at',
                order: 'priority.asc,created_at.asc',
            }),
            pgrSelect('rapidapi_usage', { month: `eq.${currentMonthUtc()}` }, { select: 'calls' }),
            pgrSelect('batch_control',  { id: 'eq.1' }, { select: 'is_active', limit: 1 }),
        ]);
        if (results[0].status === 'rejected') {
            throw new Error(`scan_jobs read failed: ${results[0].reason?.message || results[0].reason}`);
        }
        const jobs         = results[0].value;
        const usageRows    = results[1].status === 'fulfilled' ? results[1].value : [];
        const controlRows  = results[2].status === 'fulfilled' ? results[2].value : [];
        const degradations = [
            results[1].status === 'rejected' ? 'rapidapi_usage' : null,
            results[2].status === 'rejected' ? 'batch_control'  : null,
        ].filter(Boolean);

        const counts = {
            activeCount:  0,
            pendingCount: 0,
            doneCount:    0,
            errorCount:   0,
            pausedCount:  0,
            stoppedCount: 0,
            skippedCount: 0,
        };
        for (const j of jobs) {
            if (j.status === 'analyzing' || j.status === 'fetching_tracks') counts.activeCount++;
            else if (j.status === 'pending') counts.pendingCount++;
            else if (j.status === 'done')    counts.doneCount++;
            else if (j.status === 'error')   counts.errorCount++;
            else if (j.status === 'paused')  counts.pausedCount++;
            else if (j.status === 'stopped') counts.stoppedCount++;
            else if (j.status === 'skipped') counts.skippedCount++;
        }

        const monthlyCalls = usageRows?.[0]?.calls ?? 0;
        const batchActive  = controlRows?.[0]?.is_active === true;

        return res.status(200).json({
            batchActive,
            degradations,
            jobs: jobs.map((j) => ({
                playlistId:     j.playlist_id,
                title:          j.playlist_title,
                url:            j.playlist_url,
                genre:          j.genre,
                businessTypes:  j.business_types || [],
                priority:       j.priority,
                status:         j.status,
                tracksTotal:    j.tracks_total,
                tracksAnalyzed: j.tracks_analyzed,
                error:          j.error,
                updatedAt:      j.updated_at,
            })),
            counts,
            monthlyRapidapi: {
                month:           currentMonthUtc(),
                calls:           monthlyCalls,
                cap:             MONTHLY_CAP,
                safetyThreshold: SAFETY_THRESHOLD,
            },
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
