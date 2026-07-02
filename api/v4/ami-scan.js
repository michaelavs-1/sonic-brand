/* /api/v4/ami-scan.js
   The one-button endpoint driving the Ami dashboard.

   POST /api/v4/ami-scan  (no body needed)

   Steps:
     1. Fetch Data Box Tab 1 (fresh) + Tab 2 (fresh) via the in-process
        databox / databox-genres endpoints (bypass their 30-min cache).
     2. Load current Supabase state: biztype_genres, playlist_genres,
        playlist_tracks (spotify_ids), scan_jobs (playlist_ids).
     3. Compute diffs:
          - biztype_genres:  full sheet vs. DB
          - playlist_genres: (playlist_id, genre) pairs, sheet vs. DB
     4. Apply immediately (service_role):
          - biztype_genres  upserts + deletes
          - playlist_genres deletes (playlists removed from a genre)
          - playlist_genres inserts for playlists that are already known
            (present in playlist_tracks) — no RapidAPI work needed.
     5. For genuinely-new playlist IDs (not in playlist_tracks and not
        already in scan_jobs), fetch Spotify metadata (playlist name) and
        insert scan_jobs rows for cron pick-up.
     6. Return a JSON summary of everything applied + everything pending.

   Idempotent: re-running with no sheet changes returns empty applied +
   empty pending. Playlists already queued in scan_jobs are not re-enqueued.
*/

import {
    pgrSelect,
    pgrSelectIn,
    pgrUpsert,
    pgrDelete,
    pgrRpc,
} from './supabase-client.js';

import {
    computeBiztypeGenresFromSheet,
    diffBiztypeGenres,
    applyBiztypeGenresDiff,
} from '../../lib/apply-biztype-genres.js';

const norm = (s) => String(s || '').trim().toLowerCase();

// -----------------------------------------------------------------------------
// Sheet fetchers — call sibling endpoints via in-process fetch. Vercel serverless
// functions are reachable from each other via the deployment URL, but in local
// dev we hit localhost:3000. Use the request's own host header to build the URL.
// -----------------------------------------------------------------------------

function sameOriginUrl(req, pathname) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${proto}://${host}${pathname}`;
}

async function fetchTab1(req) {
    const r = await fetch(sameOriginUrl(req, '/api/v4/databox?fresh=1'));
    if (!r.ok) throw new Error(`databox fetch failed: ${r.status}`);
    const d = await r.json();
    return d.rows || [];
}

async function fetchTab2(req) {
    const r = await fetch(sameOriginUrl(req, '/api/v4/databox-genres?fresh=1'));
    if (!r.ok) throw new Error(`databox-genres fetch failed: ${r.status}`);
    const d = await r.json();
    return d.rows || [];
}

// -----------------------------------------------------------------------------
// Compute canonical playlist_genres rows from Tab 2.
// A playlist may appear under multiple genres; we emit one row per pairing.
// Genre names are stored lowercase to match the biztype_genres convention.
// -----------------------------------------------------------------------------

function computePlaylistGenresFromSheet(tab2Rows) {
    const rows = [];
    for (const gRow of tab2Rows) {
        const genre = norm(gRow.genre);
        if (!genre) continue;
        gRow.playlists.forEach((p, idx) => {
            rows.push({
                playlist_id:       p.id,
                playlist_url:      p.url,
                genre,
                position_in_genre: idx + 1,
            });
        });
    }
    return rows;
}

const plgKey = (r) => `${r.playlist_id}||${r.genre}`;

const setsEqual = (a, b) => {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
};

// -----------------------------------------------------------------------------
// Rename detection. Strict rules to avoid misclassifying a delete+add:
//   - Biz type rename: exactly ONE biz type missing from sheet, exactly ONE new
//     in sheet, and their full genre sets are equal (non-empty).
//   - Genre rename: BOTH Tab 1 (biz-type-cell-level position match) AND Tab 2
//     (playlist-set match) must agree on the same old→new mapping. If only one
//     tab shows the rename, we emit a warning and leave it as a delete+add.
// -----------------------------------------------------------------------------

function detectRenames({ tab1, sheetBiztypeRows, sheetPlaylistRows, dbBiztypeGenres, dbPlaylistGenres }) {
    const result = { bizType: null, genres: [], warnings: [] };

    // ---- Biz type rename ---------------------------------------------------
    const sheetBizTypes = new Set(tab1.map((r) => (r?.bizType || '').trim()).filter(Boolean));
    const dbBizTypes    = new Set(dbBiztypeGenres.map((r) => r.business_type));
    const bizTypesAdded   = [...sheetBizTypes].filter((b) => !dbBizTypes.has(b));
    const bizTypesRemoved = [...dbBizTypes].filter((b) => !sheetBizTypes.has(b));
    if (bizTypesAdded.length === 1 && bizTypesRemoved.length === 1) {
        const oldName = bizTypesRemoved[0];
        const newName = bizTypesAdded[0];
        const oldGenres = new Set(dbBiztypeGenres.filter((r) => r.business_type === oldName).map((r) => r.genre));
        const newGenres = new Set(sheetBiztypeRows.filter((r) => r.business_type === newName).map((r) => r.genre));
        if (oldGenres.size > 0 && setsEqual(oldGenres, newGenres)) {
            result.bizType = { old: oldName, new: newName };
        }
    }

    // ---- Genre rename: Tab 1 candidates (cell-position match) --------------
    const dbTab1Genres    = new Set(dbBiztypeGenres.map((r) => r.genre));
    const sheetTab1Genres = new Set(sheetBiztypeRows.map((r) => r.genre));
    const tab1Candidates  = new Map(); // oldGenre -> newGenre

    for (const oldGenre of dbTab1Genres) {
        if (sheetTab1Genres.has(oldGenre)) continue;
        const oldPositions = dbBiztypeGenres.filter((r) => r.genre === oldGenre);
        const newAtPositions = new Set();
        for (const pos of oldPositions) {
            const match = sheetBiztypeRows.find((r) =>
                r.business_type      === pos.business_type &&
                r.column_letter      === pos.column_letter &&
                r.position_in_column === pos.position_in_column,
            );
            newAtPositions.add(match ? match.genre : null);
        }
        if (newAtPositions.size === 1) {
            const newGenre = [...newAtPositions][0];
            if (newGenre && !dbTab1Genres.has(newGenre)) {
                tab1Candidates.set(oldGenre, newGenre);
            }
        }
    }

    // ---- Genre rename: Tab 2 candidates (playlist-set match) --------------
    const dbTab2Genres    = new Set(dbPlaylistGenres.map((r) => r.genre));
    const sheetTab2Genres = new Set(sheetPlaylistRows.map((r) => r.genre));

    const dbGenrePlaylists    = new Map();
    for (const r of dbPlaylistGenres) {
        if (!dbGenrePlaylists.has(r.genre)) dbGenrePlaylists.set(r.genre, new Set());
        dbGenrePlaylists.get(r.genre).add(r.playlist_id);
    }
    const sheetGenrePlaylists = new Map();
    for (const r of sheetPlaylistRows) {
        if (!sheetGenrePlaylists.has(r.genre)) sheetGenrePlaylists.set(r.genre, new Set());
        sheetGenrePlaylists.get(r.genre).add(r.playlist_id);
    }

    const tab2Candidates = new Map();
    for (const oldGenre of dbTab2Genres) {
        if (sheetTab2Genres.has(oldGenre)) continue;
        const oldSet = dbGenrePlaylists.get(oldGenre);
        if (!oldSet || oldSet.size === 0) continue;
        for (const newGenre of sheetTab2Genres) {
            if (dbTab2Genres.has(newGenre)) continue;
            const newSet = sheetGenrePlaylists.get(newGenre);
            if (newSet && setsEqual(oldSet, newSet)) {
                tab2Candidates.set(oldGenre, newGenre);
                break;
            }
        }
    }

    // ---- Intersect: apply only if BOTH tabs agree on the same mapping -----
    const bothTabs = new Map();
    for (const [oldGenre, newGenre] of tab1Candidates) {
        if (tab2Candidates.get(oldGenre) === newGenre) {
            bothTabs.set(oldGenre, newGenre);
        }
    }
    for (const [oldGenre, newGenre] of bothTabs) {
        result.genres.push({ old: oldGenre, new: newGenre });
    }

    // ---- Warnings for partial-tab-only renames ----------------------------
    for (const [oldGenre, newGenre] of tab1Candidates) {
        if (bothTabs.has(oldGenre)) continue;
        result.warnings.push({
            type:    'tab1_only_rename',
            message: `"${oldGenre}" → "${newGenre}" detected in Tab 1 (biz type G/H cells) but not in Tab 2 (genre→playlists). Rename in Tab 2 too and re-scan. Not auto-applied.`,
        });
    }
    for (const [oldGenre, newGenre] of tab2Candidates) {
        if (bothTabs.has(oldGenre)) continue;
        result.warnings.push({
            type:    'tab2_only_rename',
            message: `"${oldGenre}" → "${newGenre}" detected in Tab 2 (genre→playlists) but not in Tab 1 (biz type G/H cells). Rename in Tab 1 too and re-scan. Not auto-applied.`,
        });
    }

    return result;
}

// -----------------------------------------------------------------------------
// Look up which biz types reference a given genre (via biztype_genres).
// Used to display "biz types this playlist will feed into" in the dashboard.
// -----------------------------------------------------------------------------

function bizTypesForGenre(genre, biztypeGenresRows) {
    const g = norm(genre);
    const bts = new Set();
    for (const r of biztypeGenresRows) {
        if (norm(r.genre) === g) bts.add(r.business_type);
    }
    return [...bts].sort();
}

// -----------------------------------------------------------------------------
// Concurrent map with a small pool. Used for Spotify get_playlist fetches
// (~200-500ms each, want them in parallel without hammering the API).
// -----------------------------------------------------------------------------

async function poolMap(items, worker, concurrency = 5) {
    const out = new Array(items.length);
    let idx = 0;
    async function next() {
        while (idx < items.length) {
            const i = idx++;
            out[i] = await worker(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
    return out;
}

async function fetchPlaylistMeta(req, playlistId) {
    const r = await fetch(sameOriginUrl(req, '/api/v4/spotify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_playlist', playlist_id: playlistId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { name: null, tracksTotal: 0, error: data?.error || `HTTP ${r.status}` };
    return {
        name:        data?.name || null,
        tracksTotal: data?.tracks?.total ?? 0,
        error:       null,
    };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        // ---- 1. Fetch sheet ----------------------------------------------------
        const [tab1, tab2] = await Promise.all([fetchTab1(req), fetchTab2(req)]);

        // ---- 2. Load DB state --------------------------------------------------
        const [dbBiztypeGenres, dbPlaylistGenres, existingScanJobs] = await Promise.all([
            pgrSelect('biztype_genres', {}, {
                select: 'business_type,genre,column_letter,position_in_column',
            }),
            pgrSelect('playlist_genres', {}, {
                select: 'playlist_id,genre,position_in_genre',
            }),
            pgrSelect('scan_jobs', {}, { select: 'playlist_id,status,tracks_total,priority' }),
        ]);

        // ---- 3a. Compute the canonical sheet-side rows for both tabs. -------
        const sheetBiztypeRows  = computeBiztypeGenresFromSheet(tab1);
        const sheetPlaylistRows = computePlaylistGenresFromSheet(tab2);

        // ---- 3b. Rename detection + application (must run before the diff) --
        // Strict rules — see detectRenames() above. If a rename is detected,
        // we apply it via a pure-UPDATE RPC (never INSERT), then mutate the
        // in-memory `dbBiztypeGenres` / `dbPlaylistGenres` arrays so the rest
        // of the diff logic operates on the post-rename state.
        const renameResult = detectRenames({
            tab1,
            sheetBiztypeRows,
            sheetPlaylistRows,
            dbBiztypeGenres,
            dbPlaylistGenres,
        });
        const appliedRenames = { bizType: null, genres: [] };

        if (renameResult.bizType) {
            const { old: oldName, new: newName } = renameResult.bizType;
            await pgrRpc('rename_biztype',
                { p_old: oldName, p_new: newName },
                { useService: true },
            );
            for (const r of dbBiztypeGenres) {
                if (r.business_type === oldName) r.business_type = newName;
            }
            for (const j of existingScanJobs) {
                if (Array.isArray(j.business_types)) {
                    j.business_types = j.business_types.map((b) => (b === oldName ? newName : b));
                }
            }
            appliedRenames.bizType = renameResult.bizType;
        }

        for (const gr of renameResult.genres) {
            await pgrRpc('rename_genre_globally',
                { p_old: gr.old, p_new: gr.new },
                { useService: true },
            );
            for (const r of dbBiztypeGenres) if (r.genre === gr.old) r.genre = gr.new;
            for (const r of dbPlaylistGenres) if (r.genre === gr.old) r.genre = gr.new;
            appliedRenames.genres.push(gr);
        }

        // ---- 3c. biztype_genres diff ------------------------------------------
        const bizDiff = diffBiztypeGenres(sheetBiztypeRows, dbBiztypeGenres);

        // Biz-type-name diff, computed from the RAW Tab 1 rows (not from the
        // filtered biztype_genres rows) so that a newly-added biz type with no
        // genres yet still shows up in the summary. Empty biz types don't
        // produce biztype_genres rows so there's nothing to persist, but we
        // want the user to see the change was detected.
        const allSheetBizTypeSet = new Set(
            tab1.map((r) => (r?.bizType || '').trim()).filter(Boolean),
        );
        const allDbBizTypeSet = new Set(
            dbBiztypeGenres.map((r) => r.business_type).filter(Boolean),
        );
        const bizTypesAddedFull   = [...allSheetBizTypeSet].filter((b) => !allDbBizTypeSet.has(b)).sort();
        const bizTypesRemovedFull = [...allDbBizTypeSet].filter((b) => !allSheetBizTypeSet.has(b)).sort();

        // ---- 3d. playlist_genres diff -----------------------------------------
        const sheetPlgByKey = new Map(sheetPlaylistRows.map((r) => [plgKey(r), r]));
        const dbPlgByKey    = new Map(dbPlaylistGenres.map((r) => [plgKey(r), r]));

        const plgAdded   = [];  // in sheet, not in DB
        const plgRemoved = [];  // in DB, not in sheet
        for (const [k, r] of sheetPlgByKey) if (!dbPlgByKey.has(k)) plgAdded.push(r);
        for (const [k, r] of dbPlgByKey)    if (!sheetPlgByKey.has(k)) plgRemoved.push(r);

        // ---- 4a. Apply biztype_genres diff ------------------------------------
        await applyBiztypeGenresDiff(bizDiff);

        // ---- 4b. Apply playlist_genres deletes --------------------------------
        // Group by genre to reduce round trips.
        if (plgRemoved.length) {
            const byGenre = new Map();
            for (const r of plgRemoved) {
                if (!byGenre.has(r.genre)) byGenre.set(r.genre, []);
                byGenre.get(r.genre).push(r.playlist_id);
            }
            for (const [genre, pids] of byGenre) {
                const inList = `in.(${pids.map((p) => `"${p}"`).join(',')})`;
                await pgrDelete('playlist_genres', {
                    genre:       `eq.${genre}`,
                    playlist_id: inList,
                });
            }
        }

        // ---- 4b'. Cascade-delete orphaned playlists ---------------------------
        // A playlist is orphaned if it's no longer referenced by ANY row in the
        // sheet's Tab 2. Sources of stale rows:
        //   1. Playlists that had rows in playlist_genres but were removed from
        //      every genre in this scan.
        //   2. Playlists queued in scan_jobs whose sheet entry was removed
        //      (e.g. Ami added a playlist, hit STOP, then decided to remove it
        //      before restarting).
        // Cascade: delete their playlist_tracks (frees cache slot for anything
        // else that shares those spotify_ids — track_analyses is preserved,
        // since spotify_ids may reappear later under new playlists).
        // Also delete their scan_jobs row.
        const sheetPlaylistIdSet = new Set(sheetPlaylistRows.map((r) => r.playlist_id));
        const orphanedPids = new Set();
        for (const r of plgRemoved) {
            if (!sheetPlaylistIdSet.has(r.playlist_id)) orphanedPids.add(r.playlist_id);
        }
        for (const j of existingScanJobs) {
            if (!sheetPlaylistIdSet.has(j.playlist_id)) orphanedPids.add(j.playlist_id);
        }
        const orphanedList = [...orphanedPids];
        if (orphanedList.length) {
            const inList = `in.(${orphanedList.map((p) => `"${p}"`).join(',')})`;
            await pgrDelete('playlist_tracks', { playlist_id: inList });
            await pgrDelete('scan_jobs',       { playlist_id: inList });
        }

        // ---- 4b''. Revive stopped jobs whose playlist is still in the sheet --
        // At this point the orphan cascade above has already deleted stopped
        // rows whose playlist was removed from the sheet, so any surviving
        // 'stopped' scan_job is a genuine revive candidate.
        //
        // We use a bulk-UPDATE RPC instead of a partial upsert because
        // PostgREST's ON CONFLICT DO UPDATE occasionally slips into an INSERT
        // path with partial payloads, tripping scan_jobs' NOT NULL
        // constraints (playlist_title, playlist_url, genre, etc.).
        //
        // The in-memory `stoppedAlive` list is still computed for the
        // response summary; it may differ from the actual DB-side count by a
        // tiny amount if something raced between the SELECT and the UPDATE,
        // but that's acceptable — the summary is a UX nicety, not a source
        // of truth.
        const stoppedAlive = existingScanJobs.filter((j) =>
            j.status === 'stopped' && sheetPlaylistIdSet.has(j.playlist_id)
        );
        if (stoppedAlive.length) {
            await pgrRpc('revive_stopped_scan_jobs', {}, { useService: true });
        }
        const stoppedJobsResumed = stoppedAlive.map((j) => j.playlist_id);

        // ---- 4c. Split plgAdded into "already-known" vs. "truly-new" ----------
        const addedPlaylistIds = [...new Set(plgAdded.map((r) => r.playlist_id))];
        const knownPlaylistTrackRows = addedPlaylistIds.length
            ? await pgrSelectIn('playlist_tracks', 'playlist_id', addedPlaylistIds, { select: 'playlist_id' })
            : [];
        const knownPlaylistIds = new Set(knownPlaylistTrackRows.map((r) => r.playlist_id));
        // Rows we deleted in the orphan pass are no longer queued, even though
        // they were in existingScanJobs. If Ami removed and re-added the same
        // playlist in one scan session, we want to re-enqueue it fresh.
        const queuedPlaylistIds = new Set(
            existingScanJobs
                .filter((r) => !orphanedPids.has(r.playlist_id))
                .map((r) => r.playlist_id),
        );

        const plgAddedForKnown = [];   // insert playlist_genres now
        const plgAddedForNew   = [];   // enqueue in scan_jobs (cron will insert playlist_genres later)
        for (const r of plgAdded) {
            if (knownPlaylistIds.has(r.playlist_id)) plgAddedForKnown.push(r);
            else                                    plgAddedForNew.push(r);
        }

        if (plgAddedForKnown.length) {
            await pgrUpsert('playlist_genres', plgAddedForKnown.map((r) => ({
                playlist_id:       r.playlist_id,
                genre:             r.genre,
                position_in_genre: r.position_in_genre,
            })));
        }

        // ---- 5. Enqueue truly-new playlists into scan_jobs --------------------
        // De-dup by playlist_id — a playlist appearing in multiple new (genre)
        // rows becomes one scan_jobs row (with its first-encountered genre).
        // The secondary placements will be picked up by the next scan after the
        // cron finishes the primary one.
        const newPlaylistFirstSeen = new Map();  // pid -> { genre, position_in_genre }
        for (const r of plgAddedForNew) {
            if (!newPlaylistFirstSeen.has(r.playlist_id)) {
                newPlaylistFirstSeen.set(r.playlist_id, {
                    genre:             r.genre,
                    position_in_genre: r.position_in_genre,
                    playlist_url:      r.playlist_url,
                });
            }
        }
        // Filter out playlists already in scan_jobs (idempotency)
        const toEnqueueEntries = [...newPlaylistFirstSeen.entries()]
            .filter(([pid]) => !queuedPlaylistIds.has(pid));

        // Fetch Spotify metadata in a small pool.
        const metaResults = await poolMap(
            toEnqueueEntries,
            async ([pid]) => fetchPlaylistMeta(req, pid),
            5,
        );

        // Determine next priority slot — new jobs land at end of queue.
        const currentMaxPriority = existingScanJobs.length
            ? Math.max(1000, ...existingScanJobs.map((r) => r.priority || 1000))
            : 1000;

        const scanJobRows = [];
        toEnqueueEntries.forEach(([pid, info], i) => {
            const meta = metaResults[i];
            scanJobRows.push({
                playlist_id:       pid,
                playlist_title:    meta.name || pid,
                playlist_url:      info.playlist_url,
                genre:             info.genre,
                position_in_genre: info.position_in_genre,
                business_types:    bizTypesForGenre(info.genre, sheetBiztypeRows),
                priority:          currentMaxPriority + 10 + i * 10,
                status:            meta.error ? 'error' : 'pending',
                error:             meta.error || null,
                tracks_total:      meta.tracksTotal || 0,
                tracks_analyzed:   0,
            });
        });

        if (scanJobRows.length) {
            await pgrUpsert('scan_jobs', scanJobRows);
        }

        // ---- 6. Response summary ----------------------------------------------
        return res.status(200).json({
            applied: {
                bizTypeRenamed:              appliedRenames.bizType,   // null or {old, new}
                genresRenamed:               appliedRenames.genres,    // [{old, new}, ...]
                bizTypesAdded:               bizTypesAddedFull,
                bizTypesRemoved:             bizTypesRemovedFull,
                genresAddedToBiz:            bizDiff.summary.genresAddedToBiz,
                genresRemovedFromBiz:        bizDiff.summary.genresRemovedFromBiz,
                playlistsRemoved:            plgRemoved.map((r) => ({
                    playlistId: r.playlist_id,
                    genre:      r.genre,
                })),
                playlistsAddedToKnownGenres: plgAddedForKnown.map((r) => ({
                    playlistId: r.playlist_id,
                    genre:      r.genre,
                })),
                playlistsFullyRemoved:       orphanedList,
                stoppedJobsResumed,
            },
            warnings: renameResult.warnings,
            pending: scanJobRows.map((r) => ({
                playlistId:    r.playlist_id,
                title:         r.playlist_title,
                genre:         r.genre,
                businessTypes: r.business_types,
                tracksTotal:   r.tracks_total,
                status:        r.status,
                error:         r.error,
            })),
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
