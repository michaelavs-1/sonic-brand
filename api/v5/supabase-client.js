/* /api/v5/supabase-client.js
   Lightweight Supabase REST (PostgREST) wrapper. Copied from api/v4 so v5
   is self-contained and can evolve independently.
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

export function pgrSelect(table, filters = {}, { select = '*', order, limit, useService = false } = {}) {
    const query = { select, ...filters };
    if (order) query.order = order;
    if (limit != null) query.limit = String(limit);
    return pgrRequest('GET', table, { query, useService });
}

export function pgrRpc(fnName, args = {}, { useService = false } = {}) {
    return pgrRequest('POST', `rpc/${fnName}`, { body: args, useService });
}
