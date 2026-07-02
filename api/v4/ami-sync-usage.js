/* /api/v4/ami-sync-usage.js
   POST /api/v4/ami-sync-usage

   Fires ONE probe call through the track-analysis RapidAPI proxy, reads
   RapidAPI's authoritative rate-limit headers (X-RateLimit-Requests-Limit /
   -Remaining), and updates rapidapi_usage.calls to the true value. Used when
   the local counter drifted (e.g., the trial existed before this dashboard
   did, so the counter started at 0 while actual usage was in the tens of
   thousands).

   Cost: 1 RapidAPI call per invocation. Use sparingly — typically just once
   after standing the dashboard up, or when you know the counter has drifted.

   The probe uses a well-known real Spotify track ("Never Gonna Give You Up",
   spotify_id 4uLU6hMCjMI75M1A2tKUQC) so we get a 200 response with headers.
   The response body is discarded; we only care about the headers.
*/

import { pgrRpc } from './supabase-client.js';

const PROBE_SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';

function currentMonthUtc() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sameOriginUrl(req, pathname) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${proto}://${host}${pathname}`;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const r = await fetch(sameOriginUrl(req, '/api/v4/track-analysis'), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ action: 'analyze_track', spotify_id: PROBE_SPOTIFY_ID }),
        });
        const data = await r.json().catch(() => ({}));

        const usage = data?._rapidapi_usage;
        if (!usage || !Number.isFinite(usage.used) || !Number.isFinite(usage.limit)) {
            return res.status(502).json({
                error: 'RapidAPI response did not include rate-limit headers',
                proxy_status: r.status,
                proxy_body:   data,
            });
        }

        await pgrRpc('sync_rapidapi_usage',
            { p_month: currentMonthUtc(), p_calls: usage.used },
            { useService: true },
        );

        return res.status(200).json({
            ok:        true,
            month:     currentMonthUtc(),
            calls:     usage.used,
            limit:     usage.limit,
            remaining: usage.remaining,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
