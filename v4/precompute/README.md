# v4/precompute

Everything related to populating and maintaining the Supabase-backed track-analysis cache that powers the v4 preview flow.

## Layout

```
v4/precompute/
├── dry-run.mjs                  # discovery + counting; writes execution plan
├── batch.mjs                    # the RapidAPI batch with iron-clad cost cap
├── populate-biztype-genres.mjs  # cheap, no-API refresh of biztype_genres only
├── deepen-genres.mjs            # round-robin: pull the 3rd, 4th… playlist per genre
├── snapshot-databox.mjs         # one-shot Data Box snapshot (for change tracking)
├── schema.sql                   # Supabase DDL — already applied; here for reference
├── README.md                    # you are here
├── databox-snapshots/           # committed JSON snapshots (diffable in git)
│   └── snapshot-*.json
└── state/                       # gitignored runtime artifacts
    ├── dry-run.json             # execution plan output by dry-run.mjs
    ├── progress.json            # per-id done/errored sets (crash-safe, resumable)
    ├── batch.log                # append-only per-call log
    └── rapidapi-call-count.json # month-keyed call counter for the cost cap
```

The shared Supabase REST wrapper lives in `api/v4/supabase-client.js` (one level up from this folder) — it's deliberately outside `precompute/` because the runtime proxies will use it too.

## Prerequisites

1. **`vercel dev` running** on port 3000 — serves `/api/v4/databox`, `/api/v4/databox-genres`, `/api/v4/spotify`.
2. **`.env.local` at repo root** with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TRACK_ANALYSIS_RAPIDAPI_KEY`. Refresh from cloud with `vercel env pull .env.local --environment=production`.
3. **Supabase tables created** — `schema.sql` was applied once via the Supabase SQL Editor. The four tables: `track_analyses`, `playlist_tracks`, `playlist_genres`, `biztype_genres`.

## The flow

```
dry-run.mjs ──> state/dry-run.json ──> batch.mjs ──> Supabase (track_analyses + provenance tables)
```

### 1. Take a Data Box snapshot (optional but recommended before each batch)

```powershell
node v4/precompute/snapshot-databox.mjs
```

Writes a timestamped JSON to `databox-snapshots/`. Commit it. Later, `git diff databox-snapshots/` shows exactly which rows changed since the last snapshot — useful to know whether a batch re-run will touch new tracks.

### 2. Dry-run

```powershell
node v4/precompute/dry-run.mjs
```

Walks EVERY biz type in Tab 1 that has column H populated (G ∪ H tokens after `/`-and-`,` splitting, first 2 playlists per Tab-2 row). Live-checks Supabase to see how many IDs are already cached. Writes `state/dry-run.json` (the execution plan the batch consumes). NO RapidAPI calls, NO database writes.

To add coverage for a new biz type: add its row(s) to Tab 1 (with column H populated), then re-run dry-run → batch. The script picks it up automatically.

### 3. Batch

```powershell
node v4/precompute/batch.mjs --max-rapidapi-calls=15000 --concurrency=3
```

Iron-clad cost cap — script refuses to start unless:
- `--max-rapidapi-calls=N` is provided, N ≤ HARDCODED_CEILING (50,000)
- `state/dry-run.json` exists and is ≤ 24h old
- Live `monthCounter + actualRemaining ≤ N` (uses live Supabase count, not the plan's possibly-stale number)

Execution profile: N worker pool (default 3), each doing serial RapidAPI calls. Throughput ≈ 1 call/sec at concurrency-3 with ~3s per healthy call. Retries with exponential backoff on 429 (5 attempts) and 5xx/network (6 attempts). Terminal failures recorded with `status='error'` so re-runs skip them.

Resumable: re-running picks up where it left off via the live cache check + `state/progress.json`. No double-paying.

## Cost discipline

PRO tier = 50,000 RapidAPI calls / month. Run `dry-run.mjs` first and read its `Expected new RapidAPI` figure before picking a cap. Sensible defaults:
- `--max-rapidapi-calls=15000` → 30% of monthly quota, comfortable retry buffer.
- Going above 20,000 should require a deliberate reason — that's >40% of the monthly budget.

If RapidAPI is having a bad moment (mass 504s, latencies ballooning past 30s consistently), stop the batch and try again later. Empirically those storms self-resolve in hours.

## Schema reminder

`schema.sql` defines four tables (DDL is idempotent, safe to re-run):

| Table | Purpose | PK |
|---|---|---|
| `track_analyses` | per-spotify_id audio features (typed cols + raw_analysis jsonb) | `spotify_id` |
| `playlist_tracks` | many-to-many: which tracks are in which playlists | `(playlist_id, spotify_id)` |
| `playlist_genres` | many-to-many: which playlists belong to which Data Box genres | `(playlist_id, genre)` |
| `biztype_genres` | column-G/H provenance per biz type (drives UI batch ordering) | `(business_type, genre)` |

Deleting a playlist from the cache: `DELETE FROM playlist_tracks WHERE playlist_id = 'X';`. Analyses for those tracks survive (still valid cache for any other playlist that contains them).

## Genre delimiter rule

Every genre cell — both Tab 1's `genres1`/`genres2` and Tab 2's `genre` field — may contain multiple genres separated by `/` or `,` with any whitespace pattern. Both `dry-run.mjs` and the runtime proxies must split on `/\s*[\/,]\s*/` and dedupe case-insensitively. Tab 2's `"Heavy Rock/Metal"` therefore covers two tokens (`heavy rock` and `metal`) — its playlists are reused for either token.

## Adding a new biz type

1. Add row(s) to Tab 1 in the Data Box (column H must be populated).
2. Make sure the genre tokens it references have rows in Tab 2 with at least the first 2 playlists filled in. Any genre cell missing from Tab 2 will be reported as "Uncovered tokens" in the dry-run output.
3. `node v4/precompute/dry-run.mjs` — see the expected RapidAPI cost.
4. `node v4/precompute/batch.mjs --max-rapidapi-calls=N` — populate.

`populate-biztype-genres.mjs` is a faster shortcut when you only changed Tab 1's column G or H ordering and don't need fresh playlists/analyses — it just rewrites `biztype_genres` to match the sheet.
