// v4/precompute/check-rapidapi-health.mjs
//
// Cheap health probe for track-analysis.p.rapidapi.com — fires N direct calls
// against known-good spotify_ids pulled from Supabase (status='ok' rows) and
// reports latency + result per call. Total cost: N RapidAPI calls (default 3).
//
// Use before resuming a batch after a storm-triggered abort, to confirm the
// upstream is actually healthy again.
//
// Prereqs:
//   .env.local with TRACK_ANALYSIS_RAPIDAPI_KEY + SUPABASE_URL + SUPABASE_ANON_KEY
//
// CLI:
//   --n=N               how many test calls (default 3, max 10)
//   --timeout-ms=N      per-call timeout (default 40000 = 40s)
//
// Run:
//   node v4/precompute/check-rapidapi-health.mjs
//   node v4/precompute/check-rapidapi-health.mjs --n=5

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

(function loadDotEnv() {
    const p = path.join(REPO_ROOT, '.env.local');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
})();

function parseArgs() {
    const a = {};
    for (const s of process.argv.slice(2)) {
        const m = s.match(/^--([a-z0-9-]+)(?:=(.+))?$/);
        if (m) a[m[1]] = m[2] ?? true;
    }
    return a;
}
const args = parseArgs();
const N = Math.max(1, Math.min(10, parseInt(args.n ?? '3', 10) || 3));
const TIMEOUT_MS = parseInt(args['timeout-ms'] ?? '40000', 10);

const KEY  = process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;
const SB   = process.env.SUPABASE_URL;
const SBK  = process.env.SUPABASE_ANON_KEY;
if (!KEY) { console.error('TRACK_ANALYSIS_RAPIDAPI_KEY missing'); process.exit(1); }
if (!SB || !SBK) { console.error('SUPABASE_URL / SUPABASE_ANON_KEY missing'); process.exit(1); }

// Pick N spotify_ids known to have succeeded before.
console.log(`Fetching ${N} known-good spotify_ids from Supabase (status='ok')...`);
const r = await fetch(`${SB}/rest/v1/track_analyses?select=spotify_id&status=eq.ok&limit=${N}`, {
    headers: { apikey: SBK, Authorization: `Bearer ${SBK}` },
});
if (!r.ok) { console.error('supabase fetch failed:', r.status, await r.text()); process.exit(1); }
const ids = (await r.json()).map(row => row.spotify_id);
if (ids.length === 0) { console.error('no status=ok rows to use as probes'); process.exit(1); }
console.log(`  test ids: ${ids.join(', ')}\n`);

const HOST = 'track-analysis.p.rapidapi.com';

function looksLikeHtml(s) {
    if (!s) return false;
    const h = s.trimStart().slice(0, 200).toLowerCase();
    return h.startsWith('<') && (h.includes('<html') || h.includes('<!doctype') || h.includes('<head'));
}

let ok = 0, empty = 0, err = 0, html = 0, timeout = 0;
const results = [];

for (let i = 0; i < ids.length; i++) {
    const sid = ids[i];
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let status = '-', body = '', latencyMs = '-';
    try {
        const r = await fetch(`https://${HOST}/pktx/spotify/${encodeURIComponent(sid)}`, {
            method: 'GET',
            headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST },
            signal: ctrl.signal,
        });
        latencyMs = Date.now() - t0;
        status = r.status;
        body = await r.text().catch(() => '');
        clearTimeout(timer);
        if (looksLikeHtml(body)) { html++; results.push({ sid, status, latencyMs, verdict: 'HTML' }); continue; }
        if (r.status === 401 || r.status === 403) { err++; results.push({ sid, status, latencyMs, verdict: 'AUTH', body: body.slice(0, 100) }); continue; }
        if (r.status === 429) { err++; results.push({ sid, status, latencyMs, verdict: 'RATE-LIMIT' }); continue; }
        if (!r.ok) { err++; results.push({ sid, status, latencyMs, verdict: 'HTTP-ERR', body: body.slice(0, 100) }); continue; }
        let json = null;
        try { json = JSON.parse(body); } catch {}
        if (!json || json.error) { empty++; results.push({ sid, status, latencyMs, verdict: 'ERR-PAYLOAD', body: (json?.error || 'invalid JSON').slice(0, 100) }); continue; }
        const hasFields = json.energy != null || json.danceability != null || json.popularity != null;
        if (!hasFields) { empty++; results.push({ sid, status, latencyMs, verdict: 'STUB' }); continue; }
        ok++;
        results.push({ sid, status, latencyMs, verdict: 'OK' });
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') { timeout++; results.push({ sid, status: '-', latencyMs: `>${TIMEOUT_MS}ms`, verdict: 'TIMEOUT' }); }
        else { err++; results.push({ sid, status: '-', latencyMs: '-', verdict: 'NETWORK-ERR', body: e.message.slice(0, 100) }); }
    }
}

console.log('spotify_id'.padEnd(24) + 'HTTP  latency         verdict');
console.log('-'.repeat(75));
for (const r of results) {
    const lat = typeof r.latencyMs === 'number' ? `${r.latencyMs}ms` : r.latencyMs;
    const line = `${r.sid.padEnd(24)}${String(r.status).padEnd(6)}${String(lat).padEnd(16)}${r.verdict}${r.body ? ' — ' + r.body : ''}`;
    console.log(line);
}
console.log('-'.repeat(75));
console.log(`OK: ${ok}   ERR-PAYLOAD/STUB: ${empty}   HTTP-ERR: ${err}   HTML: ${html}   TIMEOUT: ${timeout}`);

// Verdict
console.log('');
if (ok === ids.length) {
    console.log('✓ HEALTHY — all probes returned usable analyses. Safe to resume batch.');
    process.exit(0);
} else if (html > 0) {
    console.log('✗ GATEWAY DOWN — RapidAPI returning HTML. Wait longer.');
    process.exit(2);
} else if (err > 0 && results.some(r => r.verdict === 'AUTH')) {
    console.log('✗ AUTH — subscription issue, fix billing first.');
    process.exit(2);
} else if (timeout > 0 || err > 0) {
    console.log('⚠ UPSTREAM DEGRADED — some probes failed. Consider waiting more.');
    process.exit(1);
} else if (empty > 0) {
    console.log(`⚠ SUSPICIOUS — ${empty}/${ids.length} probes returned error/stub payloads for known-good IDs. Upstream may still be flaky.`);
    process.exit(1);
} else {
    console.log('✓ Probably healthy.');
    process.exit(0);
}
