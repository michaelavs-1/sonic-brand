/* /api/v4/supabase-client.js
   Lightweight Supabase REST (PostgREST) wrapper. No dependencies — uses
   only fetch + URLSearchParams. Importable from both Vercel serverless
   functions (process.env from cloud env) and local Node scripts (process.env
   from shell or a dotenv-style loader).

   Two key choices:
   - service_role for writes (bypasses RLS); anon for reads (RLS-gated).
     Caller passes useService:true when it needs to insert/upsert/delete.
   - All HTTP errors throw with the response body included, so callers don't
     have to remember to check r.ok every time.
*/

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertConfigured(useService) {
    if (!SUPABASE_URL)      throw new Error('SUPABASE_URL not set');
    if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY not set');
    if (useService && !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY not set (required for writes)');
    }
}

function authHeaders(useService) {
    const key = useService ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY;
    return {
        apikey:        key,
        Authorization: `Bearer ${key}`,
    };
}

async function pgrRequest(method, path, { useService = false, body, prefer, query } = {}) {
    assertConfigured(useService);
    let url = `${SUPABASE_URL}/rest/v1/${path}`;
    if (query) {
        const qs = new URLSearchParams(query).toString();
        if (qs) url += `?${qs}`;
    }
    const headers = {
        ...authHeaders(useService),
        'Content-Type': 'application/json',
    };
    if (prefer) headers.Prefer = prefer;

    const r = await fetch(url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { data = text; }
    if (!r.ok) {
        const detail = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`Supabase ${method} ${path} -> ${r.status}: ${detail.slice(0, 400)}`);
    }
    return data;
}

/* ---------- public helpers ---------- */

// SELECT with filter expressions (PostgREST style: { col: 'eq.value' }).
// Examples:
//   pgrSelect('track_analyses', { spotify_id: 'eq.abc' })
//   pgrSelect('playlist_tracks', { playlist_id: 'eq.X' }, { select: 'spotify_id,position', order: 'position.asc' })
export function pgrSelect(table, filters = {}, { select = '*', order, limit, useService = false } = {}) {
    const query = { select, ...filters };
    if (order) query.order = order;
    if (limit != null) query.limit = String(limit);
    return pgrRequest('GET', table, { query, useService });
}

// SELECT WHERE col IN (...). Splits into ?col=in.(a,b,c). Caller may need to
// chunk for very large value lists (URL length limits) — we chunk at 200.
export async function pgrSelectIn(table, col, values, { select = '*', useService = false } = {}) {
    if (!values?.length) return [];
    const CHUNK = 200;
    const out = [];
    for (let i = 0; i < values.length; i += CHUNK) {
        const slice = values.slice(i, i + CHUNK);
        // PostgREST in.(...) requires comma-separated values. Wrap each in quotes
        // if it might contain a comma; for spotify_ids and similar tokens, plain works.
        const filter = `in.(${slice.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(',')})`;
        const data = await pgrRequest('GET', table, { query: { select, [col]: filter }, useService });
        if (Array.isArray(data)) out.push(...data);
    }
    return out;
}

// Upsert one or many rows. PostgREST treats POST with merge-duplicates as upsert
// on the table's PK or a specified onConflict column list.
export function pgrUpsert(table, rows, { onConflict, returnRows = false } = {}) {
    const body = Array.isArray(rows) ? rows : [rows];
    if (body.length === 0) return Promise.resolve([]);
    const prefer = [
        'resolution=merge-duplicates',
        returnRows ? 'return=representation' : 'return=minimal',
    ].join(',');
    const query = onConflict ? { on_conflict: onConflict } : undefined;
    return pgrRequest('POST', table, { useService: true, body, prefer, query });
}

// DELETE by filter expressions.
export function pgrDelete(table, filters) {
    if (!filters || Object.keys(filters).length === 0) {
        throw new Error('pgrDelete refuses unfiltered DELETE (would wipe table)');
    }
    return pgrRequest('DELETE', table, { useService: true, query: filters, prefer: 'return=minimal' });
}

// Call a PostgreSQL function (RPC). PostgREST exposes them under /rest/v1/rpc/<name>
// with the args as a JSON body. Returns whatever the function returns — usually
// an array of rows for SETOF/TABLE returns.
export function pgrRpc(fnName, args = {}, { useService = false } = {}) {
    return pgrRequest('POST', `rpc/${fnName}`, { body: args, useService });
}

// Convenience: row count via PostgREST exact-count header. No row data returned.
export async function pgrCount(table, filters = {}, { useService = false } = {}) {
    assertConfigured(useService);
    let url = `${SUPABASE_URL}/rest/v1/${table}`;
    const qs = new URLSearchParams({ select: '*', ...filters }).toString();
    if (qs) url += `?${qs}`;
    const r = await fetch(url, {
        method: 'HEAD',
        headers: {
            ...authHeaders(useService),
            Prefer: 'count=exact',
            Range:  '0-0',
        },
    });
    if (!r.ok && r.status !== 206) {
        const text = await r.text().catch(() => '');
        throw new Error(`Supabase COUNT ${table} -> ${r.status}: ${text.slice(0, 300)}`);
    }
    const contentRange = r.headers.get('content-range') || '';
    const total = parseInt(contentRange.split('/')[1] || '0', 10);
    return Number.isFinite(total) ? total : 0;
}
