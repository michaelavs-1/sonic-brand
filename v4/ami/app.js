/* v4/ami/app.js
   Client-side controller for the Data Box Dashboard.

   Behavior:
     - "Scan Data Box" button POSTs to /api/v4/ami-scan, then renders the
       diff summary and refreshes the queue.
     - The queue is polled every 5 seconds via GET /api/v4/ami-status.
     - Rows are draggable via SortableJS. On drop, POSTs the new order to
       /api/v4/ami-reorder.
     - The rendering strategy is in-place: existing rows are updated (title,
       progress bar, status class) rather than rebuilt, so an in-progress
       drag operation isn't interrupted by a poll cycle. Rows that no longer
       exist are removed; new rows are appended.
*/

const POLL_INTERVAL_MS = 5000;

const $ = (id) => document.getElementById(id);

const scanBtn      = $('scanBtn');
const startBtn     = $('startBtn');
const stopBtn      = $('stopBtn');
const scanHint     = $('scanHint');
const scanSpinner  = $('scanSpinner');
const banner       = $('banner');
const summaryGrid  = $('summaryGrid');
const queueSection = $('queueSection');
const queueEl      = $('queue');
const queueEmpty   = $('queueEmpty');
const queueCounts  = $('queueCounts');
const usageText    = $('usageText');
const usageFill    = $('usageFill');
const syncBtn      = $('syncBtn');
const batchProgress       = $('batchProgress');
const batchProgressLabel  = $('batchProgressLabel');
const batchProgressFill   = $('batchProgressFill');
const batchProgressPct    = $('batchProgressPct');
const batchProgressDetail = $('batchProgressDetail');
const logTerminal         = $('logTerminal');
const bulkToggleRow       = $('bulkToggleRow');
const bulkToggleBtn       = $('bulkToggleBtn');

// The queue section is hidden until the user clicks Scan Data Box in the
// current session. Persisting pending scan_jobs across page loads is fine
// (they're server-side state), but showing them silently on refresh is
// confusing — the user expects the queue to appear as a *response* to their
// Scan click. Resets on every page load (plain variable, not localStorage).
let hasScannedThisSession = false;

// Optimistic overrides for the trash icon. Key = playlistId, value = the
// status the user just asserted ('pending' or 'skipped'). The row is
// visually updated instantly on click; the POST fires in the background and
// on success this entry clears so subsequent polls take over. On failure
// we revert the visual and remove the entry.
const pendingOptimisticSkip = new Map();

// Tracks the previous poll's batchActive value so we can fire a
// "batch complete" banner on the true->false transition.
let lastBatchActive = null;

// scan_logs cursor. Terminal appends any row with id > lastLogId.
let lastLogId = 0;
const LOG_MAX_LINES = 400;
const LOG_POLL_MS   = 2000;

// Guards against overlapping refreshLogs calls (a slow fetch + the next
// interval tick can both race with the same `lastLogId` and re-append the
// same batch of rows).
let refreshLogsInFlight = false;

// Set of log ids that are already in the DOM. Belt-and-suspenders dedup so
// a duplicated row can never render twice, even under weird server-side or
// caching conditions.
const appendedLogIds = new Set();

let sortable       = null;
let pollTimer      = null;
let lastRenderedIds = [];
let reorderInFlight = false;

// -----------------------------------------------------------------------------
// Scan
// -----------------------------------------------------------------------------

scanBtn.addEventListener('click', async () => {
    scanBtn.disabled  = true;
    scanBtn.innerText = 'Scanning...';
    scanHint.innerText = 'Fetching sheet, diffing, applying changes...';
    scanSpinner.classList.add('show');
    banner.classList.remove('show');

    try {
        const r = await fetch('/api/v4/ami-scan', { method: 'POST' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

        renderSummary(data.applied);
        // Surface partial-tab-rename warnings as an amber banner. These are
        // NOT errors — the scan still succeeded — they're heads-ups that Ami
        // needs to also update the OTHER tab in the sheet for the rename to
        // take full effect.
        if (Array.isArray(data.warnings) && data.warnings.length > 0) {
            showBanner(data.warnings.map((w) => w.message).join('  |  '), 'error');
        }
        scanHint.innerText = renderScanHint(data);
        // Reveal the queue for this session and refresh immediately so
        // newly-enqueued rows appear.
        hasScannedThisSession = true;
        queueSection.style.display = 'block';
        await refreshStatus();
    } catch (err) {
        showBanner(`Scan failed: ${err.message}`);
        scanHint.innerText = 'Click to detect what changed in the Google Sheet since the last scan.';
    } finally {
        scanBtn.disabled  = false;
        scanBtn.innerText = 'Scan databox and update DB';
        scanSpinner.classList.remove('show');
    }
});

function renderScanHint(data) {
    const p = data.pending?.length || 0;
    const a = data.applied;
    const renameCount = (a.bizTypeRenamed ? 1 : 0) + (a.genresRenamed?.length || 0);
    const totalApplied =
        renameCount +
        (a.bizTypesAdded?.length || 0) +
        (a.bizTypesRemoved?.length || 0) +
        (a.genresAddedToBiz?.length || 0) +
        (a.genresRemovedFromBiz?.length || 0) +
        (a.playlistsRemoved?.length || 0) +
        (a.playlistsAddedToKnownGenres?.length || 0) +
        (a.playlistsFullyRemoved?.length || 0) +
        (a.stoppedJobsResumed?.length || 0);
    if (totalApplied === 0 && p === 0) return 'No changes detected.';
    const parts = [];
    if (totalApplied) parts.push(`${totalApplied} change${totalApplied === 1 ? '' : 's'} applied`);
    if (renameCount) parts.push(`${renameCount} rename${renameCount === 1 ? '' : 's'}`);
    if (p) parts.push(`${p} playlist${p === 1 ? '' : 's'} queued for scanning`);
    return parts.join(' · ');
}

// -----------------------------------------------------------------------------
// Summary rendering
// -----------------------------------------------------------------------------

function renderSummary(applied) {
    summaryGrid.innerHTML = '';
    summaryGrid.style.display = 'grid';

    // Renames are normalized into a uniform list-of-strings shape for the card
    // renderer (e.g. `"אשכנזית → ישראלי כללי"`).
    const renameItems = [];
    if (applied.bizTypeRenamed) {
        renameItems.push(`(biz type) ${applied.bizTypeRenamed.old} → ${applied.bizTypeRenamed.new}`);
    }
    for (const g of (applied.genresRenamed || [])) {
        renameItems.push(`(genre) ${g.old} → ${g.new}`);
    }

    const cards = [
        { title: 'Renames applied',          items: renameItems, isString: true },
        { title: 'Biz types added',          items: applied.bizTypesAdded, isString: true },
        { title: 'Biz types removed',        items: applied.bizTypesRemoved, isString: true },
        { title: 'Genres added to biz type', items: applied.genresAddedToBiz, kind: 'bizGenres' },
        { title: 'Genres removed from biz',  items: applied.genresRemovedFromBiz, kind: 'bizGenres' },
    ];

    for (const c of cards) {
        const items = c.items || [];
        const card = document.createElement('div');
        card.className = 'summary-card' + (items.length === 0 ? ' empty' : '');
        const h3 = document.createElement('h3');
        h3.innerHTML = `${escapeHtml(c.title)} <span class="count">${items.length}</span>`;
        card.appendChild(h3);
        if (items.length) {
            const ul = document.createElement('ul');
            for (const it of items) {
                const li = document.createElement('li');
                if (c.isString) {
                    li.textContent = it;
                } else if (c.kind === 'bizGenres') {
                    li.innerHTML = `${escapeHtml(it.bizType)} <span class="genres">${it.genres.map(escapeHtml).join(', ')}</span>`;
                } else if (c.kind === 'playlistGenre') {
                    li.innerHTML = `${escapeHtml(it.playlistId)} <span class="genres">→ ${escapeHtml(it.genre)}</span>`;
                }
                ul.appendChild(li);
            }
            card.appendChild(ul);
        }
        summaryGrid.appendChild(card);
    }
}

// -----------------------------------------------------------------------------
// Sync RapidAPI usage (manual button — costs 1 quota call)
// -----------------------------------------------------------------------------

syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.classList.add('spinning');
    try {
        const r = await fetch('/api/v4/ami-sync-usage', { method: 'POST' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        showBanner(`Usage synced: ${formatNumber(data.calls)} / ${formatNumber(data.limit)} used.`, 'success');
        await refreshStatus();
    } catch (err) {
        showBanner(`Sync failed: ${err.message}`);
    } finally {
        syncBtn.disabled = false;
        syncBtn.classList.remove('spinning');
    }
});

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

startBtn.addEventListener('click', async () => {
    console.log('[ami] Start button clicked');
    startBtn.disabled = true;
    startBtn.innerText = 'Starting...';
    try {
        console.log('[ami] POST /api/v4/ami-start');
        const r = await fetch('/api/v4/ami-start', { method: 'POST' });
        console.log('[ami] response status:', r.status);
        const data = await r.json();
        console.log('[ami] response body:', data);
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        const revivedNote = data.revivedCount ? ` (revived ${data.revivedCount} stopped)` : '';
        showBanner(`Batch started${revivedNote}. Cron picks up the first playlist within a minute.`, 'success');
        await refreshStatus();
        console.log('[ami] post-start status refreshed');
    } catch (err) {
        console.error('[ami] Start failed:', err);
        showBanner(`Start failed: ${err.message}`);
    } finally {
        startBtn.disabled = false;
        startBtn.innerText = 'Start batch';
    }
});

// -----------------------------------------------------------------------------
// Stop
// -----------------------------------------------------------------------------

stopBtn.addEventListener('click', async () => {
    if (!confirm('Stop the RapidAPI batch? The current in-flight track will finish (up to ~30s), then all pending playlists are paused. Progress so far is preserved. Click "Scan Data Box" again to resume.')) {
        return;
    }
    stopBtn.disabled = true;
    stopBtn.innerText = 'Stopping...';
    try {
        const r = await fetch('/api/v4/ami-stop', { method: 'POST' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        showBanner(`Stopped ${data.stopped} job${data.stopped === 1 ? '' : 's'}. In-flight RapidAPI calls will finish within ~30s.`);
        await refreshStatus();
    } catch (err) {
        showBanner(`Stop failed: ${err.message}`);
    } finally {
        stopBtn.disabled = false;
        stopBtn.innerText = 'Stop batch';
    }
});

// -----------------------------------------------------------------------------
// Status polling + queue rendering
// -----------------------------------------------------------------------------

async function refreshStatus() {
    try {
        const r = await fetch('/api/v4/ami-status');
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        renderUsage(data.monthlyRapidapi);
        // Only render the queue after the user has clicked Scan in this
        // session — a fresh page load should never surface persisted rows,
        // even if a batch happens to be running server-side.
        if (hasScannedThisSession) {
            queueSection.style.display = 'block';
            renderQueue(data);
            renderBatchProgress(data);
            detectBatchTransition(data);
        }
    } catch (err) {
        showBanner(`Status refresh failed: ${err.message}`);
    }
}

function renderBatchProgress({ jobs, counts, batchActive }) {
    if (!jobs.length) {
        batchProgress.classList.remove('show', 'done', 'errors');
        return;
    }
    batchProgress.classList.add('show');

    const skipped   = counts.skippedCount;
    const done      = counts.doneCount;
    const errors    = counts.errorCount;
    const workable  = jobs.length - skipped;   // skipped rows aren't part of the "work"
    const finished  = done + errors;
    const pct = workable ? Math.round((finished / workable) * 100) : 100;

    batchProgressFill.style.width = pct + '%';
    batchProgressPct.textContent  = pct + '%';

    batchProgress.classList.remove('done', 'errors');
    if (finished >= workable && workable > 0) {
        batchProgress.classList.add(errors > 0 ? 'errors' : 'done');
    }

    batchProgressLabel.textContent = batchActive
        ? 'Batch running'
        : (workable === 0 ? 'Nothing to run' : (finished >= workable ? 'Batch complete' : 'Batch paused'));

    // Detail line. If a cron tick is mid-flight (batch actually running),
    // show which playlist. Don't show it when the batch is paused — the
    // 'analyzing' row is just leftover state, no cron is touching it.
    const activeJob = jobs.find((j) => j.status === 'analyzing' || j.status === 'fetching_tracks');
    const parts = [
        `${done} playlist${done === 1 ? '' : 's'} done`,
        errors ? `${errors} playlist${errors === 1 ? '' : 's'} with errors` : null,
        skipped ? `${skipped} playlist${skipped === 1 ? '' : 's'} skipped` : null,
        `${workable - finished} playlist${(workable - finished) === 1 ? '' : 's'} left`,
    ].filter(Boolean);

    const currentLine = (batchActive && activeJob)
        ? `<span class="current">▸ ${escapeHtml(activeJob.title)} · ${activeJob.tracksAnalyzed}/${activeJob.tracksTotal || '?'} tracks</span>`
        : '';
    batchProgressDetail.innerHTML = `<span>${parts.join(' · ')}</span>${currentLine}`;
}

function detectBatchTransition(data) {
    const nowActive = data.batchActive === true;
    if (lastBatchActive === true && nowActive === false) {
        // Just ended.
        const done   = data.counts.doneCount;
        const errors = data.counts.errorCount;
        const paused = data.counts.pausedCount;
        if (errors > 0) {
            showBanner(`Batch ended: ${done} playlists succeeded, ${errors} errored. Check the red rows in the queue.`, 'error');
        } else if (paused > 0) {
            showBanner(`Batch paused: RapidAPI monthly cap reached. ${done} playlists finished before the cap.`, 'error');
        } else if (done > 0) {
            showBanner(`Batch complete: ${done} playlist${done === 1 ? '' : 's'} processed.`, 'success');
        } else {
            showBanner('Batch stopped with no playlists processed.', 'error');
        }
    }
    lastBatchActive = nowActive;
}

function renderUsage(u) {
    if (!u) return;
    const pct = Math.min(100, Math.round((u.calls / u.cap) * 100));
    usageText.textContent = `${formatNumber(u.calls)} / ${formatNumber(u.cap)}`;
    usageFill.style.width = pct + '%';
    usageFill.classList.remove('amber', 'red');
    if (u.calls >= u.safetyThreshold) {
        usageFill.classList.add('red');
        showBanner('Monthly RapidAPI cap almost reached — new scans paused. Resets on the 1st.');
    } else if (u.calls >= u.cap * 0.8) {
        usageFill.classList.add('amber');
    }
}

function renderQueue({ jobs, counts, batchActive }) {
    // Apply any pending optimistic overrides so a poll that lands before
    // the POST has propagated doesn't briefly revert the row.
    if (pendingOptimisticSkip.size > 0) {
        jobs = jobs.map((j) => {
            const override = pendingOptimisticSkip.get(j.playlistId);
            return override ? { ...j, status: override } : j;
        });
    }

    // Update counts
    queueCounts.textContent = [
        `${counts.pendingCount} pending`,
        counts.activeCount ? `${counts.activeCount} active` : null,
        `${counts.doneCount} done`,
        counts.errorCount ? `${counts.errorCount} error` : null,
        counts.pausedCount ? `${counts.pausedCount} paused` : null,
        counts.stoppedCount ? `${counts.stoppedCount} stopped` : null,
        counts.skippedCount ? `${counts.skippedCount} skipped` : null,
    ].filter(Boolean).join(' · ');

    // Start/Stop button visibility:
    //   - Start visible when batch is NOT active AND there's runnable work.
    //     Runnable = pending + stopped + active (analyzing/fetching_tracks).
    //     The active count matters when a batch was interrupted mid-flight —
    //     those jobs stayed in 'analyzing' status and need Start to resume.
    //   - Stop visible when batch IS active (regardless of activeCount —
    //     the first cron tick may be up to ~60s away).
    const hasRunnableWork = (counts.pendingCount + counts.stoppedCount + counts.activeCount) > 0;
    startBtn.classList.toggle('show', !batchActive && hasRunnableWork);
    stopBtn .classList.toggle('show',  batchActive);

    // TEMP: batching disabled for this deployment. Delete this line to re-enable.
    startBtn.classList.remove('show');

    // Bulk Skip all / Queue all button:
    //   - If any pending rows exist → show "🚫 Skip all" (skips all pending).
    //   - Else if any skipped rows exist → show "↻ Queue all" (revives skipped).
    //   - Otherwise hide.
    if (counts.pendingCount > 0) {
        bulkToggleBtn.dataset.action = 'skip';
        bulkToggleBtn.textContent = `🚫 Skip all (${counts.pendingCount})`;
        bulkToggleRow.classList.add('show');
    } else if (counts.skippedCount > 0) {
        bulkToggleBtn.dataset.action = 'unskip';
        bulkToggleBtn.textContent = `↻ Queue all (${counts.skippedCount})`;
        bulkToggleRow.classList.add('show');
    } else {
        bulkToggleRow.classList.remove('show');
    }

    if (jobs.length === 0) {
        queueEl.style.display = 'none';
        queueEmpty.style.display = 'block';
        lastRenderedIds = [];
        return;
    }
    queueEmpty.style.display = 'none';
    queueEl.style.display = 'block';

    // In-place update to preserve drag state.
    const seenIds = new Set();
    for (const job of jobs) {
        seenIds.add(job.playlistId);
        let li = queueEl.querySelector(`li[data-pid="${cssEscape(job.playlistId)}"]`);
        if (!li) {
            li = document.createElement('li');
            li.className = 'queue-item';
            li.dataset.pid = job.playlistId;
            queueEl.appendChild(li);
        }
        updateQueueItem(li, job);
    }
    // Remove rows that disappeared (deleted by admin or backend cleanup).
    for (const li of Array.from(queueEl.querySelectorAll('li'))) {
        if (!seenIds.has(li.dataset.pid)) li.remove();
    }
    // Reorder rows in DOM to match priority order (skips reorder if the user
    // is mid-drag, which SortableJS tracks internally via the sortable-chosen
    // class).
    const dragging = queueEl.querySelector('.sortable-chosen');
    if (!dragging) {
        const desired = jobs.map((j) => j.playlistId);
        const currentOrder = Array.from(queueEl.children).map((n) => n.dataset.pid);
        if (!arraysEqual(currentOrder, desired)) {
            for (const pid of desired) {
                const li = queueEl.querySelector(`li[data-pid="${cssEscape(pid)}"]`);
                if (li) queueEl.appendChild(li);
            }
        }
    }
    lastRenderedIds = jobs.map((j) => j.playlistId);

    // Rebind SortableJS if not yet.
    if (!sortable) {
        sortable = new Sortable(queueEl, {
            animation: 150,
            handle: '.drag-handle',
            filter: '.status-analyzing, .status-fetching_tracks, .status-done, .status-error, .status-paused, .status-stopped, .status-skipped, .skip-btn',
            preventOnFilter: false,
            onEnd: () => {
                const order = Array.from(queueEl.children).map((n) => n.dataset.pid);
                submitReorder(order);
            },
        });
    }
}

// Delegated click handler for the trash / restore button. Attached once at
// startup; still works after re-renders because queue items live under queueEl.
//
// Optimistic: the row's visual state is updated *before* the POST fires.
// The POST runs in the background; on success we clear the optimistic
// override (next poll takes over), on failure we revert + banner.
queueEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action="toggle-skip"]');
    if (!btn || btn.disabled) return;
    const li = btn.closest('li[data-pid]');
    if (!li) return;
    const playlistId = li.dataset.pid;
    const currentlySkipped = li.classList.contains('status-skipped');
    const skip = !currentlySkipped;
    const optimisticStatus = skip ? 'skipped' : 'pending';
    const previousStatus   = currentlySkipped ? 'skipped' : 'pending';

    // 1. Instant visual update.
    pendingOptimisticSkip.set(playlistId, optimisticStatus);
    applyRowStatusInline(li, btn, optimisticStatus);

    // 2. Fire POST in the background.
    fetch('/api/v4/ami-toggle-skip', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ playlistId, skip }),
    })
    .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        pendingOptimisticSkip.delete(playlistId);
    })
    .catch((err) => {
        // Revert.
        pendingOptimisticSkip.delete(playlistId);
        applyRowStatusInline(li, btn, previousStatus);
        showBanner(`Skip toggle failed: ${err.message}`);
    });
});

// Bulk Skip all / Queue all — optimistic like the individual toggle.
bulkToggleBtn.addEventListener('click', () => {
    if (bulkToggleBtn.disabled) return;
    const skip = bulkToggleBtn.dataset.action === 'skip';
    const targetStatus  = skip ? 'skipped' : 'pending';
    const currentStatus = skip ? 'pending' : 'skipped';

    // Collect the rows the bulk action applies to (visible rows whose
    // current class matches the transition source).
    const rows = Array.from(queueEl.querySelectorAll(`li.status-${currentStatus}`));
    if (rows.length === 0) return;

    // 1. Optimistic visual update.
    for (const li of rows) {
        const pid = li.dataset.pid;
        const btn = li.querySelector('button[data-action="toggle-skip"]');
        pendingOptimisticSkip.set(pid, targetStatus);
        applyRowStatusInline(li, btn, targetStatus);
    }
    bulkToggleBtn.disabled = true;

    // 2. Fire POST in the background.
    fetch('/api/v4/ami-toggle-all', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ skip }),
    })
    .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        for (const li of rows) pendingOptimisticSkip.delete(li.dataset.pid);
    })
    .catch((err) => {
        for (const li of rows) {
            pendingOptimisticSkip.delete(li.dataset.pid);
            const btn = li.querySelector('button[data-action="toggle-skip"]');
            applyRowStatusInline(li, btn, currentStatus);
        }
        showBanner(`Bulk toggle failed: ${err.message}`);
    })
    .finally(() => {
        bulkToggleBtn.disabled = false;
    });
});

// Update just the status-dependent bits of a row inline, without a full
// innerHTML replace. Used for the optimistic path so we don't clobber the
// row's current progress bar / meta.
function applyRowStatusInline(li, btn, status) {
    li.className = 'queue-item status-' + status;
    if (status === 'skipped') {
        btn.innerText = '↻';
        btn.title     = 'Include this playlist in the batch again';
    } else {
        btn.innerText = '🚫';
        btn.title     = 'Exclude this playlist from the batch';
    }
}

function updateQueueItem(li, job) {
    // Reset status classes
    li.className = 'queue-item status-' + job.status;

    const tracksTotal    = job.tracksTotal || 0;
    const tracksAnalyzed = job.tracksAnalyzed || 0;
    const pct = tracksTotal ? Math.round((tracksAnalyzed / tracksTotal) * 100) : 0;

    // Trash toggle is only meaningful for pending / skipped rows. For any
    // other status the icon is still rendered but disabled — so it doesn't
    // wobble the row layout as jobs progress.
    const canToggle = job.status === 'pending' || job.status === 'skipped';
    const trashLabel = job.status === 'skipped' ? '↻' : '🚫';
    const trashTitle = job.status === 'skipped'
        ? 'Include this playlist in the batch again'
        : 'Exclude this playlist from the batch';

    li.innerHTML = `
      <span class="drag-handle">⋮⋮</span>
      <div class="item-main">
        <div class="item-title">
          <a href="${escapeAttr(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a>
        </div>
        <div class="item-meta">
          <span class="badge genre">${escapeHtml(job.genre)}</span>
          ${(job.businessTypes || []).map((b) => `<span class="badge biz">${escapeHtml(b)}</span>`).join('')}
          ${job.error ? `<span class="badge" style="border-color:var(--red);color:var(--red);">${escapeHtml(job.error)}</span>` : ''}
        </div>
      </div>
      <div class="item-progress">
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-text">${tracksAnalyzed} / ${tracksTotal || '?'} · ${job.status}</div>
      </div>
      <button class="skip-btn" data-action="toggle-skip" title="${escapeAttr(trashTitle)}" ${canToggle ? '' : 'disabled'}>${trashLabel}</button>
    `;
}

// -----------------------------------------------------------------------------
// Reorder
// -----------------------------------------------------------------------------

async function submitReorder(order) {
    if (reorderInFlight) return;
    reorderInFlight = true;
    try {
        const r = await fetch('/api/v4/ami-reorder', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ order }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    } catch (err) {
        showBanner(`Reorder failed: ${err.message}`);
    } finally {
        reorderInFlight = false;
    }
}

// -----------------------------------------------------------------------------
// Poll loop
// -----------------------------------------------------------------------------

function startPolling() {
    if (pollTimer) return;
    refreshStatus();
    pollTimer = setInterval(refreshStatus, POLL_INTERVAL_MS);
}

// -----------------------------------------------------------------------------
// Live activity log — polls /api/v4/ami-logs and appends to the terminal panel
// -----------------------------------------------------------------------------

let logTimer = null;

async function refreshLogs() {
    if (refreshLogsInFlight) return;
    refreshLogsInFlight = true;
    try {
        const url = lastLogId
            ? `/api/v4/ami-logs?since_id=${lastLogId}`
            : '/api/v4/ami-logs?limit=100';
        const r = await fetch(url);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        if (!data.logs?.length) return;

        const wasAtBottom = isScrolledToBottom(logTerminal);
        for (const log of data.logs) {
            if (appendedLogIds.has(log.id)) continue;
            appendedLogIds.add(log.id);
            appendLogLine(log);
            if (log.id > lastLogId) lastLogId = log.id;
        }
        // Trim to LOG_MAX_LINES so the DOM doesn't grow unbounded. Also
        // prune appendedLogIds to prevent unbounded memory (keep last 1000
        // ids, which is well beyond LOG_MAX_LINES).
        while (logTerminal.children.length > LOG_MAX_LINES) {
            logTerminal.removeChild(logTerminal.firstChild);
        }
        if (appendedLogIds.size > 1000) {
            const sorted = [...appendedLogIds].sort((a, b) => a - b);
            for (const id of sorted.slice(0, sorted.length - 1000)) {
                appendedLogIds.delete(id);
            }
        }
        if (wasAtBottom) logTerminal.scrollTop = logTerminal.scrollHeight;
    } catch (err) {
        // Silent failure — don't spam banner for log poll blips.
        console.warn('[ami] refreshLogs failed:', err.message);
    } finally {
        refreshLogsInFlight = false;
    }
}

function appendLogLine(log) {
    const line = document.createElement('div');
    line.className = 'log-line level-' + (log.level || 'info');
    const time = new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false });
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = `[${time}]`;
    const msgSpan = document.createElement('span');
    msgSpan.textContent = log.message;
    line.appendChild(timeSpan);
    line.appendChild(msgSpan);
    logTerminal.appendChild(line);
}

function isScrolledToBottom(el) {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
}

function startLogPolling() {
    if (logTimer) return;
    refreshLogs();
    logTimer = setInterval(refreshLogs, LOG_POLL_MS);
}

// Render the empty summary grid on load so Ami sees the "0 changes detected"
// layout immediately, rather than nothing at all.
renderSummary({});

startPolling();
startLogPolling();

// Pause polling when the tab is hidden — reduce server load.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (logTimer)  { clearInterval(logTimer);  logTimer  = null; }
    } else {
        startPolling();
        startLogPolling();
    }
});

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function showBanner(msg, variant = 'error') {
    banner.textContent = msg;
    banner.classList.remove('success');
    if (variant === 'success') banner.classList.add('success');
    banner.classList.add('show');
    setTimeout(() => banner.classList.remove('show'), 8000);
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s)  { return String(s).replace(/(["\\])/g, '\\$1'); }
function formatNumber(n) { return Number(n).toLocaleString('en-US'); }
function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
