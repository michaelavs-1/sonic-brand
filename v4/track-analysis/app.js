// v4 track-analysis page — single track + playlist analyzer.
//
// Pipeline:
//   single   → /api/v4/spotify (get_track) + /api/v4/track-analysis in parallel
//   playlist → /api/v4/spotify (get_playlist_tracks, paginated) → fan out per
//              track to /api/v4/track-analysis, streaming results into the DOM
//              as each settles.
//
// RapidAPI ceiling is 5 starts/sec — enforced by a 200ms-slot rate limiter
// shared across both flows (same primitive as v4/generation/preview-builder.js).
// Console logs are intentionally verbose so the user can diagnose stalls.

const PICK_FIELDS = ['id', 'name', 'tempo', 'popularity', 'energy', 'danceability', 'happiness'];
const ANALYSIS_RATE_PER_SEC = 5;
const PLAYLIST_PAGE_LIMIT = 100;
const PLAYLIST_FIELDS = 'items(track(id,name,artists(name)))';
const SLOW_WAIT_MS = 1500;

// ── logging ────────────────────────────────────────────────────────────────
let WALL_START = 0;
const elapsed = () => Math.round(performance.now() - WALL_START);
function log(scope, ...args) {
  console.log(`[track-analysis][${scope}][+${elapsed()}ms]`, ...args);
}
function warn(scope, ...args) {
  console.warn(`[track-analysis][${scope}][+${elapsed()}ms]`, ...args);
}
function logErr(scope, ...args) {
  console.error(`[track-analysis][${scope}][+${elapsed()}ms]`, ...args);
}

// ── rate limiter (5 starts/sec, 200ms slots) ───────────────────────────────
// Mirrors v4/generation/preview-builder.js so single + playlist flows share
// the same global quota window. Supports AbortSignal so a Stop click rejects
// all queued waits immediately instead of letting the queue drain.
const analysisRateLimiter = (() => {
  const intervalMs = 1000 / ANALYSIS_RATE_PER_SEC;
  let nextSlot = 0;
  return {
    async wait(signal) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const now = Date.now();
      const startAt = Math.max(now, nextSlot);
      nextSlot = startAt + intervalMs;
      const delay = startAt - now;
      if (delay > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          const onAbort = () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      return delay;
    },
  };
})();

function isAbortError(e) {
  return e && (e.name === 'AbortError' || e?.code === 20);
}

// ── DOM helper ─────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const $ = (id) => document.getElementById(id);

// ── input parsing ──────────────────────────────────────────────────────────
const TRACK_RE = /(?:open\.spotify\.com\/track\/|spotify:track:)?([A-Za-z0-9]{22})/;
const PLAYLIST_RE = /(?:open\.spotify\.com\/playlist\/|spotify:playlist:)?([A-Za-z0-9]{22})/;

function extractSpotifyId(input, kind) {
  if (!input) return null;
  const trimmed = String(input).trim();
  const re = kind === 'playlist' ? PLAYLIST_RE : TRACK_RE;
  const m = trimmed.match(re);
  return m ? m[1] : null;
}

function formatTrackName(track) {
  const artists = Array.isArray(track?.artists)
    ? track.artists.map(a => a?.name).filter(Boolean).join(', ')
    : '';
  const title = track?.name || '';
  if (artists && title) return `${artists} — ${title}`;
  return title || artists || '(unknown)';
}

// ── API calls ──────────────────────────────────────────────────────────────
async function analyzeTrack(spotifyId, ctx = {}) {
  const signal = ctx.signal;
  let waitedMs;
  try {
    waitedMs = await analysisRateLimiter.wait(signal);
  } catch (e) {
    if (isAbortError(e)) return { ok: false, totalMs: 0, error: 'aborted', aborted: true };
    throw e;
  }
  const startedAt = performance.now();
  ctx.onStart?.(Math.round(waitedMs));
  try {
    const r = await fetch('/api/v4/track-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'analyze_track', spotify_id: spotifyId }),
      signal,
    });
    const totalMs = Math.round(performance.now() - startedAt);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      warn('analysis', `${ctx.label || spotifyId} → HTTP ${r.status}`, text.slice(0, 300));
      return { ok: false, totalMs, error: `HTTP ${r.status}` };
    }
    const data = await r.json().catch(() => ({}));
    if (data.found === false) {
      return { ok: false, totalMs, error: 'not found' };
    }
    return { ok: true, totalMs, analysis: data };
  } catch (e) {
    const totalMs = Math.round(performance.now() - startedAt);
    if (isAbortError(e)) return { ok: false, totalMs, error: 'aborted', aborted: true };
    logErr('analysis', `${ctx.label || spotifyId} → exception`, e);
    return { ok: false, totalMs, error: e?.message || 'fetch error' };
  }
}

async function fetchTrackMeta(spotifyId, signal) {
  log('meta', `requesting track meta id=${spotifyId}`);
  const t0 = performance.now();
  try {
    const r = await fetch('/api/v4/spotify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_track', track_id: spotifyId }),
      signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      warn('meta', `HTTP ${r.status}`, text.slice(0, 300));
      return null;
    }
    const data = await r.json().catch(() => ({}));
    log('meta', `got name="${formatTrackName(data)}" in ${Math.round(performance.now() - t0)}ms`);
    return data;
  } catch (e) {
    if (isAbortError(e)) {
      log('meta', 'aborted');
      return null;
    }
    logErr('meta', 'exception', e);
    return null;
  }
}

async function fetchPlaylistTracks(playlistId, signal) {
  const all = [];
  let offset = 0;
  let pages = 0;
  const t0 = performance.now();
  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const pageStart = performance.now();
    let r;
    try {
      r = await fetch('/api/v4/spotify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'get_playlist_tracks',
          playlist_id: playlistId,
          offset,
          limit: PLAYLIST_PAGE_LIMIT,
          fields: PLAYLIST_FIELDS,
        }),
        signal,
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      logErr('playlist', `network error on page offset=${offset}`, e);
      throw e;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      warn('playlist', `page offset=${offset} → HTTP ${r.status}`, text.slice(0, 300));
      throw new Error(`Playlist fetch failed: HTTP ${r.status}`);
    }
    const data = await r.json().catch(() => ({}));
    const items = Array.isArray(data?.items) ? data.items : [];
    pages++;
    log('playlist', `page offset=${offset} limit=${PLAYLIST_PAGE_LIMIT} → got ${items.length} items in ${Math.round(performance.now() - pageStart)}ms`);
    for (const it of items) {
      const t = it?.track;
      if (t?.id) {
        all.push({ id: t.id, name: t.name, artists: t.artists || [] });
      }
    }
    if (items.length < PLAYLIST_PAGE_LIMIT) break;
    offset += PLAYLIST_PAGE_LIMIT;
  }
  log('playlist', `fetched ${all.length} usable tracks across ${pages} page(s) in ${Math.round(performance.now() - t0)}ms`);
  return all;
}

// ── result building ────────────────────────────────────────────────────────
function pickFields(track, analysis) {
  const name = formatTrackName(track);
  return {
    id: track?.id || analysis?.id || null,
    name,
    tempo: analysis?.tempo ?? null,
    popularity: analysis?.popularity ?? null,
    energy: analysis?.energy ?? null,
    danceability: analysis?.danceability ?? null,
    happiness: analysis?.happiness ?? null,
  };
}

function buildJsonString(track, analysis) {
  return JSON.stringify(pickFields(track, analysis), null, 2);
}

function renderJsonPre(jsonStr) {
  // light syntax-highlight by regex; keeps the text content identical for copy
  const escaped = jsonStr
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const highlighted = escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")\s*:|("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
    (m, key, str, num) => {
      if (key) return `<span class="key">${key}</span>:`;
      if (str) return `<span class="str">${str}</span>`;
      if (num) return `<span class="num">${num}</span>`;
      return m;
    }
  );
  const pre = el('pre', { class: 'result-json' });
  pre.innerHTML = highlighted;
  return pre;
}

function flashCopied(btn, label = 'Copied!') {
  const original = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = original; }, 1100);
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    log('input', `copied ${text.length} chars to clipboard`);
    if (btn) flashCopied(btn);
  } catch (e) {
    warn('input', 'clipboard write failed', e);
    if (btn) flashCopied(btn, 'Copy failed');
  }
}

function renderPendingCard(track) {
  const headerText = formatTrackName(track) || '(unknown)';
  const idText = track?.id ? ` · ${track.id}` : '';
  const card = el('div', { class: 'result-card pending' });
  card.append(
    el('div', { class: 'result-header' }, headerText, el('span', { class: 'muted' }, idText)),
    el('div', { class: 'result-pending-body' },
      el('span', { class: 'sb-spinner' }),
      'analyzing…'
    )
  );
  return card;
}

function fillCard(card, track, result) {
  card.classList.remove('pending');
  if (result.aborted) {
    card.classList.add('stopped');
    const body = el('div', { class: 'result-stopped-body' }, 'stopped');
    const pending = card.querySelector('.result-pending-body');
    if (pending) pending.replaceWith(body);
    else card.append(body);
    return;
  }
  if (!result.ok || !result.analysis) {
    card.classList.add('error');
    const body = el('div', { class: 'result-error-body' },
      `analysis not available${result.error ? ` — ${result.error}` : ''}`
    );
    const pending = card.querySelector('.result-pending-body');
    if (pending) pending.replaceWith(body);
    else card.append(body);
    return;
  }
  const jsonStr = buildJsonString(track, result.analysis);
  card.dataset.json = jsonStr;
  const pre = renderJsonPre(jsonStr);
  const copyBtn = el('button', {
    class: 'btn btn-ghost copy-btn',
    onclick: (e) => copyToClipboard(jsonStr, e.currentTarget),
  }, 'Copy');
  const pending = card.querySelector('.result-pending-body');
  if (pending) pending.replaceWith(pre);
  else card.append(pre);
  card.append(copyBtn);
}

function clearResults() {
  $('results').replaceChildren();
  $('copyAllWrap').classList.remove('show');
  $('status').textContent = '';
}

function showCopyAllIfAny() {
  const hasOk = $('results').querySelector('.result-card:not(.error):not(.pending)[data-json]');
  $('copyAllWrap').classList.toggle('show', !!hasOk);
}

function setButtonBusy(btn, busy, idleLabel) {
  if (busy) {
    btn.disabled = true;
    btn.dataset.idleLabel = idleLabel;
    btn.replaceChildren(el('span', { class: 'sb-spinner btn-spinner' }), 'working…');
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.idleLabel || idleLabel;
  }
}

// Only one run can be in flight at a time. While busy, both Analyze buttons
// are disabled and a single Stop button is shown.
let currentAbortController = null;

function beginRun(activeBtn, activeLabel, idleBtn) {
  currentAbortController = new AbortController();
  setButtonBusy(activeBtn, true, activeLabel);
  idleBtn.disabled = true;
  $('stopBtn').classList.add('show');
  return currentAbortController.signal;
}

function endRun(activeBtn, activeLabel, idleBtn) {
  currentAbortController = null;
  setButtonBusy(activeBtn, false, activeLabel);
  idleBtn.disabled = false;
  $('stopBtn').classList.remove('show');
}

function handleStop() {
  if (!currentAbortController) return;
  log('input', 'stop pressed — aborting in-flight requests');
  currentAbortController.abort();
}

// ── flows ──────────────────────────────────────────────────────────────────
async function handleSingleSubmit() {
  if (currentAbortController) return;
  WALL_START = performance.now();
  const raw = $('trackInput').value;
  $('trackInput').value = '';
  const id = extractSpotifyId(raw, 'track');
  log('input', `raw="${raw}" kind=track extracted=${id}`);
  if (!id) {
    $('status').textContent = 'Could not extract a track id from that input.';
    return;
  }
  clearResults();
  const signal = beginRun($('trackBtn'), 'Analyze track', $('playlistBtn'));
  $('status').textContent = 'Analyzing 1 track…';

  const placeholderTrack = { id, name: '', artists: [] };
  const card = renderPendingCard(placeholderTrack);
  $('results').append(card);

  log('analysis', `[1/1] queued id=${id}`);
  const [meta, result] = await Promise.all([
    fetchTrackMeta(id, signal),
    analyzeTrack(id, {
      signal,
      label: `[1/1] ${id}`,
      onStart: (waited) => {
        const line = `[1/1] started id=${id} waitedMs=${waited}`;
        if (waited > SLOW_WAIT_MS) warn('analysis', line);
        else log('analysis', line);
      },
    }),
  ]);
  const track = meta && meta.id ? meta : placeholderTrack;
  // refresh header now that we may have the real name
  const headerText = formatTrackName(track) || '(unknown)';
  const idText = track?.id ? ` · ${track.id}` : '';
  const header = card.querySelector('.result-header');
  if (header) header.replaceChildren(headerText, el('span', { class: 'muted' }, idText));

  log('analysis', `[1/1] done id=${id} totalMs=${result.totalMs} ok=${result.ok}${result.aborted ? ' (aborted)' : ''}`,
    result.ok ? pickFields(track, result.analysis) : result.error);
  fillCard(card, track, result);
  showCopyAllIfAny();

  const wall = elapsed();
  log('summary', `single track done — wall=${wall}ms, ok=${result.ok}${result.aborted ? ', aborted' : ''}`);
  $('status').textContent = result.aborted
    ? `Stopped after ${wall} ms.`
    : result.ok
      ? `Done in ${wall} ms.`
      : `Done in ${wall} ms — analysis unavailable.`;
  endRun($('trackBtn'), 'Analyze track', $('playlistBtn'));
}

async function handlePlaylistSubmit() {
  if (currentAbortController) return;
  WALL_START = performance.now();
  const raw = $('playlistInput').value;
  $('playlistInput').value = '';
  const id = extractSpotifyId(raw, 'playlist');
  log('input', `raw="${raw}" kind=playlist extracted=${id}`);
  if (!id) {
    $('status').textContent = 'Could not extract a playlist id from that input.';
    return;
  }
  clearResults();
  const signal = beginRun($('playlistBtn'), 'Analyze playlist', $('trackBtn'));
  $('status').textContent = 'Fetching playlist tracks…';

  let tracks;
  try {
    tracks = await fetchPlaylistTracks(id, signal);
  } catch (e) {
    if (isAbortError(e)) {
      log('playlist', 'aborted during pagination');
      $('status').textContent = `Stopped after ${elapsed()} ms.`;
    } else {
      logErr('playlist', 'fetch failed', e);
      $('status').textContent = `Playlist fetch failed: ${e.message || e}`;
    }
    endRun($('playlistBtn'), 'Analyze playlist', $('trackBtn'));
    return;
  }
  if (!tracks.length) {
    $('status').textContent = 'No analyzable tracks in that playlist.';
    endRun($('playlistBtn'), 'Analyze playlist', $('trackBtn'));
    return;
  }

  const total = tracks.length;
  $('status').textContent = `Analyzing 0 / ${total}…`;

  // Render placeholders up front so cards appear in playlist order.
  const cards = tracks.map((t) => {
    const c = renderPendingCard(t);
    $('results').append(c);
    return c;
  });

  let done = 0;
  let failed = 0;
  let aborted = 0;
  let maxWaited = 0;

  const promises = tracks.map((t, i) => {
    const label = `[${i + 1}/${total}] ${t.id}`;
    log('analysis', `[${i + 1}/${total}] queued id=${t.id} name="${formatTrackName(t)}"`);
    return analyzeTrack(t.id, {
      signal,
      label,
      onStart: (waited) => {
        if (waited > maxWaited) maxWaited = waited;
        const line = `[${i + 1}/${total}] started id=${t.id} waitedMs=${waited}`;
        if (waited > SLOW_WAIT_MS) warn('analysis', line);
        else log('analysis', line);
      },
    }).then((res) => {
      done++;
      if (res.aborted) aborted++;
      else if (!res.ok) failed++;
      log('analysis', `[${i + 1}/${total}] done id=${t.id} totalMs=${res.totalMs} ok=${res.ok}${res.aborted ? ' (aborted)' : ''}`,
        res.ok ? pickFields(t, res.analysis) : res.error);
      fillCard(cards[i], t, res);
      $('status').textContent = signal.aborted
        ? `Stopped — ${done - aborted} / ${total} analyzed before stop…`
        : `Analyzing ${done} / ${total}…`;
      showCopyAllIfAny();
    });
  });

  await Promise.all(promises);
  showCopyAllIfAny();

  const wall = elapsed();
  const avg = Math.round(wall / total);
  const okCount = total - failed - aborted;
  log('summary',
    `playlist done — ${okCount}/${total} ok, ${failed} failed, ${aborted} aborted, ` +
    `wall=${wall}ms, avg=${avg}ms/track, maxWaitedMs=${maxWaited}`);
  $('status').textContent = aborted
    ? `Stopped — ${okCount} / ${total} analyzed${failed ? `, ${failed} failed` : ''}, ${aborted} unstarted/aborted (${wall} ms).`
    : `Done — ${okCount} / ${total} analyzed${failed ? ` (${failed} failed)` : ''} in ${wall} ms.`;
  endRun($('playlistBtn'), 'Analyze playlist', $('trackBtn'));
}

function handleCopyAll(e) {
  const cards = Array.from($('results').querySelectorAll('.result-card[data-json]'));
  if (!cards.length) return;
  const arr = cards.map(c => JSON.parse(c.dataset.json));
  const text = JSON.stringify(arr, null, 2);
  copyToClipboard(text, e.currentTarget);
}

// ── wire up ────────────────────────────────────────────────────────────────
$('trackBtn').addEventListener('click', () => { handleSingleSubmit(); });
$('playlistBtn').addEventListener('click', () => { handlePlaylistSubmit(); });
$('stopBtn').addEventListener('click', handleStop);
$('copyAllBtn').addEventListener('click', handleCopyAll);

$('trackInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); handleSingleSubmit(); }
});
$('playlistInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); handlePlaylistSubmit(); }
});

console.log('[track-analysis] page ready');
