/* /api/v4/ami-atmospheres-scan.js
   POST /api/v4/ami-atmospheres-scan

   The "atmospheres" counterpart to /api/v4/ami-scan. Reads the atmosphere-
   parameter Google Sheet fresh, diffs against the Supabase `atmospheres`
   table, applies changes via service_role, and returns a human-readable
   summary that the dashboard renders as summary cards.

   Diff buckets (all under `applied` in the response for shape-consistency
   with ami-scan):
     - atmospheresAdded[]        (names in sheet, not in DB)
     - atmospheresRemoved[]      (names in DB, not in sheet)
     - atmosphereParamsChanged[] ([{ name, changes: [{ param, from, to }] }])

   NOTE on BPM (column I in the sheet): captured, persisted to
   `atmospheres.ranges.bpm`, and included in the diff summary — but the
   runtime pipeline does NOT filter by BPM yet. Storing it now so Ami's
   edits are recorded; wiring it into screening is a follow-up.
*/

import { pgrSelect, pgrUpsert, pgrDelete } from './supabase-client.js';
import { fetchAtmospheresFromSheet, PARAMS } from './databox-atmospheres.js';

// Two `[lo, hi]` tuples (or nulls) are equal iff both are null, or both are
// arrays with the same lo and hi. We use JSON.stringify for the array case
// so [10, 80] and [10, 80] compare equal without a manual index loop.
function rangeEqual(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

// Compare two `ranges` objects across the full PARAMS list. Returns an array
// of `{ param, from, to }` deltas (empty if identical). Both arguments may
// be missing keys; missing = null (no constraint).
function paramDiff(dbRanges, sheetRanges) {
    const changes = [];
    for (const p of PARAMS) {
        const from = dbRanges?.[p] ?? null;
        const to   = sheetRanges?.[p] ?? null;
        if (!rangeEqual(from, to)) changes.push({ param: p, from, to });
    }
    return changes;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        // ---- 1. Fetch sheet + load DB in parallel ----
        // Direct sheet fetch (not through the databox-atmospheres endpoint) so
        // there's no chance of edge-cache interference.
        const [sheetRows, dbRows] = await Promise.all([
            fetchAtmospheresFromSheet(),
            pgrSelect('atmospheres', {}, { select: 'name,ranges,row_in_sheet' }),
        ]);

        // ---- 2. Index by name for the diff ----
        const sheetByName = new Map(sheetRows.map((r) => [r.atmosphere, r]));
        const dbByName    = new Map(dbRows.map((r) => [r.name, r]));

        // ---- 3. Compute diff buckets ----
        const atmospheresAdded   = [];
        const atmospheresRemoved = [];
        const atmosphereParamsChanged = [];

        for (const [name, sheetRow] of sheetByName) {
            const dbRow = dbByName.get(name);
            if (!dbRow) {
                atmospheresAdded.push(name);
                continue;
            }
            const changes = paramDiff(dbRow.ranges, sheetRow.ranges);
            if (changes.length) atmosphereParamsChanged.push({ name, changes });
        }
        for (const [name] of dbByName) {
            if (!sheetByName.has(name)) atmospheresRemoved.push(name);
        }

        // ---- 4. Apply changes ----
        // Upsert every sheet row: covers added rows and updates params-changed
        // rows in one call. Cheaper than filtering to only the changed ones.
        if (sheetRows.length) {
            const upsertPayload = sheetRows.map((r) => ({
                name:         r.atmosphere,
                ranges:       r.ranges,
                row_in_sheet: r.row,
                updated_at:   new Date().toISOString(),
            }));
            await pgrUpsert('atmospheres', upsertPayload);
        }
        // Delete rows that are in DB but not in sheet.
        if (atmospheresRemoved.length) {
            // in.(...) — quote each name in case it contains a comma.
            const inList = `in.(${atmospheresRemoved.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(',')})`;
            await pgrDelete('atmospheres', { name: inList });
        }

        atmospheresAdded.sort();
        atmospheresRemoved.sort();
        atmosphereParamsChanged.sort((a, b) => a.name.localeCompare(b.name));

        return res.status(200).json({
            applied: {
                atmospheresAdded,
                atmospheresRemoved,
                atmosphereParamsChanged,
            },
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
