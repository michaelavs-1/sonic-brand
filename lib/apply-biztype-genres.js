// lib/apply-biztype-genres.js
//
// Shared logic for computing the canonical `biztype_genres` rows from the
// live Data Box Tab 1, diffing against what's in Supabase, and applying the
// resulting inserts/updates/deletes. Used by:
//   - api/v4/ami-scan.js (dashboard-driven scan)
//   - v4/precompute/populate-biztype-genres.mjs (legacy local runner)
//
// Splitter follows the Data Box convention: cells split on / or , but keep
// combined-name canonical genres like "Heavy Rock+Metal" intact (no split
// on +). Genre names normalized to lowercase, trimmed.
//
// Diff semantics for the dashboard summary:
//   - bizTypesAdded: biz types in sheet with any (G or H) genres, not present
//     in DB at all.
//   - bizTypesRemoved: biz types present in DB but with zero rows in sheet.
//   - genresAddedToBiz: (bizType, genre) pairs in sheet, not in DB.
//   - genresRemovedFromBiz: (bizType, genre) pairs in DB, not in sheet.
//
// Position/column-letter changes on existing (bizType, genre) rows are silently
// upserted — not surfaced in the summary since they're internal ordering.

import { pgrSelect, pgrUpsert, pgrDelete } from '../api/v4/supabase-client.js';

const norm = (s) => String(s || '').trim().toLowerCase();

// Split a raw cell (string or array of strings) into normalized genre tokens.
// Splits on / or , only; + is preserved for combined-name canonical genres.
export function splitToTokens(raw) {
    const out = [];
    const cells = Array.isArray(raw) ? raw : [raw];
    for (const cell of cells) {
        if (cell == null) continue;
        for (const p of String(cell).split(/\s*[\/,]\s*/)) {
            const n = norm(p);
            if (n && !out.includes(n)) out.push(n);
        }
    }
    return out;
}

// Given the Tab 1 rows returned by /api/v4/databox (each with { bizType,
// genres1, genres2, ... }), compute the canonical list of biztype_genres
// rows the DB should contain.
//
// A biz type may appear in multiple sheet rows (one per energy level). We
// aggregate all G/H tokens across those rows and pick the first row that has
// any H tokens as the canonical source of positions for H, and analogously
// for G. In practice the sheet uses a single row per biz type for genres,
// so this is a no-op; the aggregation is just belt-and-suspenders.
export function computeBiztypeGenresFromSheet(tab1Rows) {
    const byBiz = new Map(); // bizType -> { gTokens: [], hTokens: [] }
    for (const r of tab1Rows) {
        if (!r?.bizType) continue;
        const g = splitToTokens(r.genres1);
        const h = splitToTokens(r.genres2);
        if (g.length === 0 && h.length === 0) continue;
        const cur = byBiz.get(r.bizType) || { gTokens: [], hTokens: [] };
        if (cur.gTokens.length === 0 && g.length) cur.gTokens = g;
        if (cur.hTokens.length === 0 && h.length) cur.hTokens = h;
        byBiz.set(r.bizType, cur);
    }

    const rows = [];
    for (const [bizType, { gTokens, hTokens }] of byBiz) {
        gTokens.forEach((g, i) => rows.push({
            business_type:      bizType,
            genre:              g,
            column_letter:      'G',
            position_in_column: i + 1,
        }));
        hTokens.forEach((g, i) => rows.push({
            business_type:      bizType,
            genre:              g,
            column_letter:      'H',
            position_in_column: i + 1,
        }));
    }
    return rows;
}

const keyOf = (r) => `${r.business_type}${r.genre}`;

// Diff sheet-derived rows vs. current DB rows. Returns:
//   {
//     toUpsert: rows to write (all sheet rows — upsert handles new + position updates),
//     toDelete: [{ business_type, genre }] rows to remove,
//     summary: {
//       bizTypesAdded: string[],
//       bizTypesRemoved: string[],
//       genresAddedToBiz: [{ bizType, genres: string[] }],
//       genresRemovedFromBiz: [{ bizType, genres: string[] }],
//     }
//   }
export function diffBiztypeGenres(sheetRows, dbRows) {
    const sheetByKey = new Map(sheetRows.map((r) => [keyOf(r), r]));
    const dbByKey    = new Map(dbRows.map((r) => [keyOf(r), r]));

    const sheetBizTypes = new Set(sheetRows.map((r) => r.business_type));
    const dbBizTypes    = new Set(dbRows.map((r) => r.business_type));

    const bizTypesAdded   = [...sheetBizTypes].filter((b) => !dbBizTypes.has(b)).sort();
    const bizTypesRemoved = [...dbBizTypes].filter((b) => !sheetBizTypes.has(b)).sort();

    const genresAdded = new Map();   // bizType -> Set<genre>
    const genresRemoved = new Map(); // bizType -> Set<genre>
    const toDelete = [];

    for (const [k, r] of sheetByKey) {
        if (!dbByKey.has(k)) {
            if (!genresAdded.has(r.business_type)) genresAdded.set(r.business_type, new Set());
            genresAdded.get(r.business_type).add(r.genre);
        }
    }
    for (const [k, r] of dbByKey) {
        if (!sheetByKey.has(k)) {
            if (!genresRemoved.has(r.business_type)) genresRemoved.set(r.business_type, new Set());
            genresRemoved.get(r.business_type).add(r.genre);
            toDelete.push({ business_type: r.business_type, genre: r.genre });
        }
    }

    const pairsToSummary = (m) => [...m.entries()]
        .map(([bizType, set]) => ({ bizType, genres: [...set].sort() }))
        .sort((a, b) => a.bizType.localeCompare(b.bizType));

    return {
        toUpsert: sheetRows,
        toDelete,
        summary: {
            bizTypesAdded,
            bizTypesRemoved,
            genresAddedToBiz:     pairsToSummary(genresAdded),
            genresRemovedFromBiz: pairsToSummary(genresRemoved),
        },
    };
}

// Read current biztype_genres from Supabase.
export async function readDbBiztypeGenres() {
    const rows = await pgrSelect('biztype_genres', {}, {
        select: 'business_type,genre,column_letter,position_in_column',
    });
    return rows || [];
}

// Apply the diff atomically-ish. Upserts happen first (safe under partial
// failure — worst case we still have the removed rows lingering, which the
// next scan cleans up). Deletes are grouped by business_type so we make one
// DELETE per biz type instead of one per row.
export async function applyBiztypeGenresDiff({ toUpsert, toDelete }) {
    if (toUpsert.length) {
        const CHUNK = 500;
        for (let i = 0; i < toUpsert.length; i += CHUNK) {
            await pgrUpsert('biztype_genres', toUpsert.slice(i, i + CHUNK));
        }
    }

    if (toDelete.length) {
        const byBiz = new Map();
        for (const d of toDelete) {
            if (!byBiz.has(d.business_type)) byBiz.set(d.business_type, []);
            byBiz.get(d.business_type).push(d.genre);
        }
        for (const [bizType, genres] of byBiz) {
            // PostgREST in.(...) — quote each value in case a genre name has commas.
            const inList = `in.(${genres.map((g) => `"${g.replace(/"/g, '\\"')}"`).join(',')})`;
            await pgrDelete('biztype_genres', {
                business_type: `eq.${bizType}`,
                genre:         inList,
            });
        }
    }
}
