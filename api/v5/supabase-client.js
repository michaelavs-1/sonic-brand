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

async function pgrRequestOnce(method, path, { useService = false, body, prefer, query } = {}) {
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
        const err = new Error(`Supabase ${method} ${path} -> ${r.status}: ${detail.slice(0, 400)}`);
        err.status = r.status;
        err.detail = detail;
        throw err;
    }
    return data;
}

// Postgres error 57014 = statement_timeout. On Supabase's PgBouncer setup,
// the first call on a fresh connection has to compile the query plan; on a
// cold RPC this can push past the default 3s statement_timeout. Once the
// plan is compiled (which the failed call did before it got canceled), a
// retry on the same or another connection usually succeeds fast.
function isPlanColdStart(err) {
    return err && err.status === 500 && typeof err.detail === 'string'
        && err.detail.includes('"57014"');
}

async function pgrRequest(method, path, opts = {}) {
    try {
        return await pgrRequestOnce(method, path, opts);
    } catch (err) {
        if (!isPlanColdStart(err)) throw err;
        console.warn(`[supabase] 57014 on ${method} ${path} — retrying once after 300ms`);
        await new Promise((r) => setTimeout(r, 300));
        return pgrRequestOnce(method, path, opts);
    }
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

// Upsert one or many rows. PostgREST treats POST with merge-duplicates as
// upsert on the table's PK or a specified onConflict column list. Writes
// always use service_role (bypasses RLS).
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

// PATCH (partial UPDATE) by filter expressions. Never inserts — safe for
// updating a row that may or may not exist without tripping NOT NULL
// constraints on unsupplied columns. Writes always use service_role.
export function pgrPatch(table, filters, body) {
    if (!filters || Object.keys(filters).length === 0) {
        throw new Error('pgrPatch refuses unfiltered UPDATE');
    }
    return pgrRequest('PATCH', table, {
        useService: true,
        body,
        query: filters,
        prefer: 'return=minimal',
    });
}
