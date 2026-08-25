// v6 preview screen — Michael's swipe deck UI over v5's per-direction anchor
// track selection.
//
// One anchor track per direction (from /api/v5/anchor-tracks, same as v5).
// Rendered one at a time as a Tinder-style card: big album art + track title +
// artist, hidden Spotify iframe drives audio, custom play button, drag/swipe
// or thumbs-up/down to decide. Swipe right = "build a playlist for this
// direction", swipe left = "skip this direction". Returns the array of liked
// directions, matching v5's runDirectionPreviewFlow contract.

const HEADING = 'בחרו כיוונים מוזיקליים שמתאימים לעסק';

// Play/pause glyphs are sized 36×36 (up from 22×22) so they fill more of
// the 56px button and read as a proper media control rather than a small
// icon floating in the middle.
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" aria-hidden="true"><path d="M8.2 5.6v12.8L19 12z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" aria-hidden="true"><rect x="6.6" y="5.6" width="3.9" height="12.8" rx="1.2"/><rect x="13.5" y="5.6" width="3.9" height="12.8" rx="1.2"/></svg>';

// Feather-style shuffle icon shown inside the "נסו שיר אחר..." pill.
const SHUFFLE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<polyline points="16 3 21 3 21 8"/>' +
  '<line x1="4" y1="20" x2="21" y2="3"/>' +
  '<polyline points="21 16 21 21 16 21"/>' +
  '<line x1="15" y1="15" x2="21" y2="21"/>' +
  '<line x1="4" y1="4" x2="9" y2="9"/>' +
  '</svg>';

// Full innerHTML for the swap-button's "resting" state (label + icon).
// Reused when the button first renders and when the async swap handler
// resets after a successful/failed swap — previously this used a bare
// text label constant that got removed in the swap-button restyle, which
// left the spinner state permanently stuck.
const SWAP_BUTTON_HTML = '<span>שמעו שיר אחר מהכיוון הזה</span>' + SHUFFLE_ICON;

function fmtTime(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ---------- Spotify IFrame API singleton ----------
let _apiPromise = null;
function getSpotifyIframeApi() {
  if (_apiPromise) return _apiPromise;
  _apiPromise = new Promise((resolve) => {
    if (window.__sbIframeApi) { resolve(window.__sbIframeApi); return; }
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      window.__sbIframeApi = IFrameAPI;
      resolve(IFrameAPI);
    };
  });
  return _apiPromise;
}

// ---------- small DOM helper ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function showLoading(card, text = 'טוען שירים לדוגמא…') {
  card.replaceChildren(
    el('div', { class: 'preview-load-column' },
      el('div', { class: 'preview-load-label' }, text),
      el('div', { class: 'preview-load-progress' },
        el('div', { class: 'preview-load-progress-fill' }),
      ),
    ),
  );
}

// Ephemeral swipe-feedback toast. Single body-appended pill that shows
// for ~1.8s and fades. Reused across super-like / yes / no decisions —
// each new call resets the timer, swaps the label, and swaps the tone
// class so the color matches the action. Style lives in v6/index.html
// under `.sl-toast` (base + `.tone-yes` / `.tone-no` variants).
let _slToastEl = null;
let _slToastTimer = null;
function showSwipeToast(text, tone = 'super') {
  if (!_slToastEl) {
    _slToastEl = document.createElement('div');
    _slToastEl.className = 'sl-toast';
    document.body.append(_slToastEl);
  }
  _slToastEl.classList.remove('tone-yes', 'tone-no');
  if (tone === 'yes' || tone === 'no') _slToastEl.classList.add('tone-' + tone);
  _slToastEl.textContent = text;
  _slToastEl.classList.add('show');
  clearTimeout(_slToastTimer);
  _slToastTimer = setTimeout(() => _slToastEl.classList.remove('show'), 1800);
}

// Gray "undo" pill shown for 3s after every yes/no/super-like decision.
// Whole toast IS the button — clicking it invokes the passed rollback fn.
// A new call replaces the previous action (the previous card is already
// gone from the deck; only the most recent decision is reversible).
let _undoToastEl = null;
let _undoToastTimer = null;
function showUndoToast(undoFn) {
  if (!_undoToastEl) {
    _undoToastEl = document.createElement('button');
    _undoToastEl.type = 'button';
    _undoToastEl.className = 'undo-toast';
    _undoToastEl.setAttribute('aria-label', 'ביטול הפעולה האחרונה');
    _undoToastEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9 14 L4 9 L9 4"/><path d="M4 9 h10 a6 6 0 0 1 6 6 v1 a4 4 0 0 1 -4 4 h-3"/>' +
      '</svg>' +
      '<span>בטל</span>';
    document.body.append(_undoToastEl);
  }
  _undoToastEl.onclick = () => {
    clearTimeout(_undoToastTimer);
    _undoToastEl.classList.remove('show');
    _undoToastEl.onclick = null;
    undoFn();
  };
  _undoToastEl.classList.add('show');
  clearTimeout(_undoToastTimer);
  _undoToastTimer = setTimeout(() => {
    _undoToastEl.classList.remove('show');
    _undoToastEl.onclick = null;
  }, 3000);
}

function spotifyBadge() {
  const s = el('span', { class: 'sw2-spbadge', 'aria-hidden': 'true' });
  s.innerHTML =
    '<svg viewBox="0 0 24 24" width="30" height="30">' +
    '<circle cx="12" cy="12" r="11.5" fill="#000"/>' +
    '<path d="M6.4 9.3c3.6-1.1 7.8-.6 10.9 1.2" stroke="#1DB954" stroke-width="1.7" fill="none" stroke-linecap="round"/>' +
    '<path d="M7 12.2c3.1-.9 6.5-.4 9.2 1.1" stroke="#1DB954" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M7.6 15c2.5-.7 5.2-.3 7.3 1" stroke="#1DB954" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
    '</svg>';
  return s;
}

// ---------- v5 anchor tracks (one per direction) ----------
// Returns a genre from a direction's `genres` list, picked at random.
// Backward-compat: falls back to legacy [anchor_genre, ...secondary_genres]
// if `genres` isn't present (persisted pre-refactor data).
function directionGenres(d) {
  if (Array.isArray(d.genres) && d.genres.length) return d.genres;
  return [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])]
    .filter((g) => typeof g === 'string' && g.length);
}

function pickPreviewGenre(d) {
  const list = directionGenres(d);
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

// fetchAnchorTracks — one representative track per (rank, genre, BPM) spec.
// Endpoint name is legacy ("anchor-tracks") but the concept of a designated
// anchor genre is gone: each spec passes the specific genre to draw from.
// Callers construct specs — random pick for the initial preview, explicit
// per-genre for the swap-track cycler.
//
// Retry-once wrapper: the underlying Postgres RPC (v5_anchor_tracks) does
// a heavy multi-table JOIN with random ordering and its plan can take
// several seconds to compile on a cold PgBouncer session — long enough
// to trip Supabase's statement_timeout (57014). supabase-client.js's
// server-side retry-at-300ms often lands on ANOTHER cold session before
// the plan can propagate through the pool, so it doesn't help this case.
// A 2s wait client-side gives whichever session gets the retry time to
// finish its own plan compile. If the retry still fails, the throw
// propagates to preparePreview's outer catch and page 2 falls back to
// empty (existing degradation).
async function fetchAnchorTracks(specs, popularityWindow) {
  const payload = specs.map((s) => ({
    rank: s.rank,
    genre: s.genre,
    bpm_lo: Math.floor(s.bpm_range.min),
    bpm_hi: Math.ceil(s.bpm_range.max),
    // Per-spec 'none' | 'soft' | 'hard' from the direction's
    // Gemini-assigned instrumentalness_preference — the SQL RPC applies
    // the matching WHERE filter (hard) or ORDER BY bias (soft).
    inst_pref: s.inst_pref || 'none',
  }));
  const attempt = async () => {
    const r = await fetch('/api/v5/anchor-tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specs: payload, popularity: popularityWindow }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(`anchor-tracks ${r.status}: ${data?.error || r.statusText}`);
    }
    const { byRank } = await r.json();
    return byRank || {};
  };
  try {
    return await attempt();
  } catch (e) {
    console.warn('[v6 preview] anchor-tracks failed, retrying once in 2s:', e.message);
    await new Promise((r) => setTimeout(r, 2000));
    return attempt();
  }
}

// Initial preview fetch: random genre per direction.
async function fetchInitialPreviewTracks(directions, popularityWindow) {
  const specs = directions.map((d) => ({
    rank: d.rank,
    genre: pickPreviewGenre(d),
    bpm_range: d.bpm_range,
    inst_pref: d.instrumentalness_preference || 'none',
  })).filter((s) => s.genre);
  if (!specs.length) return {};
  return fetchAnchorTracks(specs, popularityWindow);
}

// ---------- track metadata (via v4 Spotify proxy — client credentials) ----------
async function fetchTrackMeta(trackIds) {
  const meta = {};
  await Promise.all([...new Set(trackIds)].filter(Boolean).map(async (id) => {
    try {
      const r = await fetch('/api/v4/spotify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_track', track_id: id }),
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.name) {
        meta[id] = {
          name: d.name,
          artist: (d.artists || []).map((a) => a.name).filter(Boolean).join(', '),
          art: d.album?.images?.[1]?.url || d.album?.images?.[0]?.url || '',
        };
      }
    } catch (err) { console.warn('get_track failed:', id, err); }
  }));
  return meta;
}

// Combine v5 directions with their anchor tracks. Drops directions whose
// anchor genre had no cached track (byRank[rank] is empty).
function directionsToPreviews(directions, byRank) {
  const out = [];
  for (const d of directions) {
    const trackId = byRank[String(d.rank)];
    if (!trackId) continue;
    out.push({ direction: d, trackId });
  }
  out.sort((a, b) => a.direction.rank - b.direction.rank);
  return out;
}

// ---------- swipe deck ----------
// trackMeta is provided pre-fetched by preparePreview so we don't re-hit
// Spotify get_track at render time. The swap button still fetches metadata
// on demand for its own replacement tracks (see below).
//
// `page2Ready` (nullable) is a Promise that resolves with the page-2 batch
// of previews + trackMeta when it's ready. The deck renders with page 1's
// 4 cards immediately; when page 2 lands, its 4 previews are appended to
// the same deck so the user can keep swiping seamlessly. If the user
// reaches the end of page 1 before page 2 arrives, we show a brief
// "loading more" state until it does.
async function renderSwipeDeck(card, initialPreviews, initialTrackMeta, popularityWindow, page2Ready, superLikedTracks) {
  const api = await getSpotifyIframeApi();

  return new Promise((resolve) => {
    // Mutable so page 2 can push into them once it resolves.
    const previews = [...initialPreviews];
    const trackMeta = { ...initialTrackMeta };
    let page2Settled = false;

    const likedDirections = [];
    let index = 0;
    let controller = null;
    let busy = false;

    const progLabel = el('div', { class: 'swipe-progress-label' });
    const progFill = el('div', { class: 'swipe-progress-fill' });
    const progBar = el('div', { class: 'swipe-progress-bar' }, progFill);
    const deck = el('div', { class: 'swipe-deck' });
    const railNo = el('div', { class: 'sw2-rail no' },
      el('span', { class: 'sw2-chev' }, '‹'),
      el('span', { class: 'sw2-rail-label' }, 'לא בשבילי'),
    );
    const railYes = el('div', { class: 'sw2-rail yes' },
      el('span', { class: 'sw2-chev' }, '›'),
      el('span', { class: 'sw2-rail-label' }, 'אהבתי'),
    );
    // Top rail for the swipe-up super-like gesture. Cyan to match the toast
    // + card glow. Same chevron character as the yes/no rails (rotated 90°
    // in CSS so it points up) so the three rails read as a set.
    const railSuper = el('div', { class: 'sw2-rail super' },
      el('span', { class: 'sw2-chev' }, '‹'),
      el('span', { class: 'sw2-rail-label' }, 'סופר לייק'),
    );
    const deckWrap = el('div', { class: 'sw2-deckwrap' }, deck, railNo, railYes, railSuper);
    // yes/no buttons are intentionally NOT mounted into the card — the user
    // decides purely via swipe now. Kept in memory (with their click handlers
    // wired below) as a one-line-change fallback if we want to bring them
    // back: append `btns` into card.replaceChildren.
    const noBtn = el('button', { class: 'swipe-btn swipe-no', type: 'button' }, '👎 לא בשבילי');
    const yesBtn = el('button', { class: 'swipe-btn swipe-yes', type: 'button' }, '👍 אהבתי');
    const btns = el('div', { class: 'swipe-actions' }, noBtn, yesBtn);
    void btns; // eslint: intentionally unused — see comment above

    card.replaceChildren(el('h1', {}, HEADING), progLabel, progBar, deckWrap);

    const setProgress = () => {
      // Pin the denominator to the pipeline's expected total (2 pages × 4)
      // so the label never flashes "1/4 → 1/8" when page 2 lands. Math.max
      // guards the theoretical case where more than 8 previews sneak in.
      const total = Math.max(previews.length, 8);
      // Spinner next to the count while page 2 is still en route — it means
      // "more cards are loading", now that the denominator itself is stable.
      const spinner = page2Settled
        ? ''
        : '<span class="sb-spinner" style="width:11px;height:11px;margin-inline-start:6px;vertical-align:-1px"></span>';
      progLabel.innerHTML = 'רובין לומד את הטעם שלכם 🎧 · ' + Math.min(index + 1, total) + '/' + total + spinner;
      progFill.style.width = ((index / total) * 100) + '%';
    };

    // Wait for page 2 (if there is one). When it lands, append its previews
    // to the deck and merge its metadata. If the user is already at the end
    // of page 1 waiting, showCard() picks the new cards up next time it's
    // called (via the retry inside its "no more cards yet" branch).
    if (page2Ready) {
      page2Ready.then((page2) => {
        page2Settled = true;
        if (page2 && Array.isArray(page2.previews) && page2.previews.length) {
          previews.push(...page2.previews);
          Object.assign(trackMeta, page2.trackMeta || {});
        }
        // If we've been waiting on page 2 (the "loading more" state), the
        // waitingResume closure below is set and will fire showCard again.
        if (waitingResume) {
          const r = waitingResume;
          waitingResume = null;
          r();
        } else {
          // Update the progress label to reflect the new denominator.
          setProgress();
        }
      });
    } else {
      page2Settled = true;
    }
    // Set when showCard bails because we've reached the end of the currently
    // known previews and page 2 hasn't arrived yet — page2Ready.then() calls
    // it to resume rendering when the new previews land.
    let waitingResume = null;

    const railsIdle = () => {
      railNo.style.opacity = '';
      railYes.style.opacity = '';
      railSuper.style.opacity = '';
    };

    const destroyController = () => {
      try { controller?.destroy(); } catch { }
      controller = null;
    };

    const showCard = () => {
      busy = false;
      railsIdle();
      if (index >= previews.length) {
        if (!page2Settled) {
          // Page 2 is still loading — show a brief "loading more" state and
          // resume when page2Ready resolves (see waitingResume above).
          destroyController();
          deck.replaceChildren(
            // .in-deck modifier flex-centers the content vertically INSIDE
            // the deck's bounds and adds top padding equal to the swipe-up
            // rail height, so "טוענים עוד שירים…" lands mid-deck instead of
            // being pinned to the top where the "סופר לייק" rail sits.
            // Other preview-load-column callers (initial preview load,
            // direction generation) don't get the class so their layout
            // stays as-is.
            el('div', { class: 'preview-load-column in-deck' },
              el('div', { class: 'preview-load-label' }, 'טוענים עוד שירים…'),
              el('div', { class: 'preview-load-progress' },
                el('div', { class: 'preview-load-progress-fill' }),
              ),
            ),
          );
          waitingResume = showCard;
          return;
        }
        destroyController();
        resolve(likedDirections);
        return;
      }
      setProgress();
      const p = previews[index];
      const d = p.direction;
      const m = trackMeta[p.trackId] || {};

      const mount = el('div', { class: 'preview-spotify-mount' });
      // The iframe lives inside .sw2-artwrap as a nearly-invisible overlay
      // (see CSS): the visible viewport keeps the media pipeline active, and
      // the custom play button drives it via the IFrame API.
      const embedWrap = el('div', { class: 'sw2-embed-hidden' }, mount);

      const playBtn = el('button', { class: 'sw2-play', type: 'button', 'aria-label': 'נגן' });
      playBtn.innerHTML = PLAY_ICON;

      // Super-like input is now a swipe-up gesture (handled in the pointer
      // block below); it commits the track to the shared Set + advances the
      // card, so there's no persistent per-card indicator to render here.

      const artImg = m.art
        ? el('img', { class: 'sw2-art', src: m.art, alt: '' })
        : el('div', { class: 'sw2-art sw2-art-ph' }, '🎵');
      const artWrap = el('div', { class: 'sw2-artwrap' }, artImg, spotifyBadge(), playBtn, embedWrap);

      const titleEl = el('div', { class: 'sw2-title', dir: 'ltr' }, m.name || '');
      const artistEl = el('div', { class: 'sw2-artist', dir: 'ltr' }, m.artist || '');

      // Show the v5 direction's Hebrew description as the reason line — that's
      // the model's one-line pitch for the direction.
      const reasonEl = d.description_he
        ? el('div', { class: 'preview-reason sw2-reason' }, d.description_he)
        : null;

      // Swap button — pill CTA with an inline shuffle icon. Text first in
      // source order so the SVG renders on the LEFT of the label in RTL.
      const swap = el('button', { class: 'swap-btn', type: 'button' });
      swap.innerHTML = SWAP_BUTTON_HTML;

      // --- Playback progress bar. Interpolates position between the (sparse)
      // playback_update events via a RAF loop, so scrubbing feels smooth. The
      // outer .sw2-prog-bar reserves fixed 14px in the layout so hovering
      // never pushes the swap button / hint downward. ---
      const pbState = {
        lastPosition: 0,
        lastTimestamp: Date.now(),
        duration: 0,
        isPaused: true,
        dragging: false,
        pendingSeek: null,     // seconds, set during drag; committed on release
        // playback_update `position` values are ignored while this timestamp
        // is in the future — after a controller.seek(), Spotify fires one
        // more update with the stale pre-seek position before catching up,
        // which without this guard makes the dot jump back for one frame.
        seekLockUntil: 0,
      };
      const pbFill = el('div', { class: 'sw2-prog-fill' });
      const pbTrack = el('div', { class: 'sw2-prog-track' }, pbFill);
      const pbThumb = el('div', { class: 'sw2-prog-thumb' });
      const pbBar = el('div', { class: 'sw2-prog-bar' }, pbTrack, pbThumb);
      const pbCurrent = el('span', {}, '0:00');
      const pbTotal = el('span', {}, '0:00');
      const pbTimes = el('div', { class: 'sw2-timestamps' }, pbCurrent, pbTotal);
      const pbContainer = el('div', { class: 'sw2-progress' }, pbBar, pbTimes);

      const cardEl = el('div',
        {
          class: 'preview-card swipe-card swipe-card2',
          'data-rank': String(d.rank),
          'data-track-id': p.trackId,
          'data-uri': `spotify:track:${p.trackId}`,
        },
        artWrap,
        titleEl,
        artistEl,
        // Swap CTA lives between artist and reason (used to sit under the
        // reason with a dashed utility look; the old "Preview" chip that
        // used to be here is gone — decorative, no data behind it).
        swap,
        reasonEl,
        pbContainer,
        el('div', { class: 'sw2-hint' }, 'גררו לצדדים · גררו למעלה לסופר לייק'),
      );
      deck.replaceChildren(cardEl);

      // Progress bar interactions
      function pbPctFromEvent(e) {
        const rect = pbBar.getBoundingClientRect();
        const x = Math.max(rect.left, Math.min(rect.right, e.clientX));
        return (x - rect.left) / rect.width;
      }
      function pbSeekTo(seconds) {
        if (!controller) return;
        try { controller.seek(seconds); } catch { }
        // Snap the local mirror so the RAF loop doesn't interpolate from the
        // old position for one frame before the next playback_update lands.
        pbState.lastPosition = seconds * 1000;
        pbState.lastTimestamp = Date.now();
        // Give Spotify ~500ms to actually process the seek before we accept
        // its position updates again. Without this the first update after
        // seek carries the pre-seek position and briefly jumps the dot back.
        pbState.seekLockUntil = Date.now() + 500;
      }
      pbBar.addEventListener('pointerdown', (e) => {
        if (!pbState.duration) return;
        e.stopPropagation();          // don't let the card's swipe handler catch this
        pbState.dragging = true;
        pbState.pendingSeek = pbPctFromEvent(e) * (pbState.duration / 1000);
        pbBar.classList.add('dragging');
        try { pbBar.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault();
      });
      pbBar.addEventListener('pointermove', (e) => {
        if (!pbState.dragging) return;
        pbState.pendingSeek = pbPctFromEvent(e) * (pbState.duration / 1000);
      });
      const endPbDrag = () => {
        if (!pbState.dragging) return;
        const target = pbState.pendingSeek;
        pbState.dragging = false;
        pbState.pendingSeek = null;
        pbBar.classList.remove('dragging');
        if (target != null) pbSeekTo(target);
      };
      pbBar.addEventListener('pointerup', endPbDrag);
      pbBar.addEventListener('pointercancel', endPbDrag);

      // RAF loop drives the visual fill + timestamps between playback_update
      // events. Exits when the card is disconnected (next swipe / decide).
      function pbCurrentPosMs() {
        if (pbState.dragging && pbState.pendingSeek != null) return pbState.pendingSeek * 1000;
        if (pbState.isPaused) return pbState.lastPosition;
        const elapsed = Date.now() - pbState.lastTimestamp;
        return Math.min(pbState.duration || Infinity, pbState.lastPosition + elapsed);
      }
      (function pbTick() {
        if (!cardEl.isConnected) return;
        const pos = pbCurrentPosMs();
        const dur = pbState.duration;
        const pct = dur > 0 ? Math.min(1, pos / dur) : 0;
        pbFill.style.width = (pct * 100) + '%';
        pbThumb.style.left = (pct * 100) + '%';
        pbCurrent.textContent = fmtTime(pos);
        pbTotal.textContent = fmtTime(dur);
        requestAnimationFrame(pbTick);
      })();

      function resetPbState() {
        pbState.lastPosition = 0;
        pbState.lastTimestamp = Date.now();
        pbState.duration = 0;
        pbState.isPaused = true;
        pbState.pendingSeek = null;
        pbFill.style.width = '0%';
        pbThumb.style.left = '0%';
        pbCurrent.textContent = '0:00';
        pbTotal.textContent = '0:00';
      }

      let pendingPlay = false;
      const wireController = (mountNode) => {
        api.createController(mountNode, { uri: cardEl.dataset.uri, width: '100%', height: 80 }, (c) => {
          if (!cardEl.isConnected) { try { c.destroy(); } catch { } return; }
          controller = c;
          c.addListener('playback_update', (e) => {
            const dd = e?.data || {};
            const paused = dd.isPaused !== false;
            playBtn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
            // Capture position/duration into pbState so the RAF loop and
            // seek/scrub UI reflect the actual iframe state.
            if (typeof dd.duration === 'number' && dd.duration > 0) pbState.duration = dd.duration;
            if (typeof dd.position === 'number' && Date.now() >= pbState.seekLockUntil) {
              pbState.lastPosition = dd.position;
              pbState.lastTimestamp = Date.now();
            }
            pbState.isPaused = paused;
          });
          // If the user clicked play before the controller was ready, honour
          // it now. Otherwise stay paused — autoplay is browser-blocked and
          // trying anyway just noises up the console.
          if (pendingPlay) {
            pendingPlay = false;
            playBtn.classList.remove('waiting');
            try { c.play(); } catch { }
          }
        });
      };
      wireController(mount);

      playBtn.addEventListener('click', () => {
        if (controller) {
          try { controller.togglePlay(); } catch { }
        } else {
          pendingPlay = true;
          playBtn.classList.add('waiting');
        }
      });

      // "Another song from this direction" — cycles through the direction's
      // genres. The AI treats all genres as equal weight; the initial preview
      // track was drawn from a random one. Swap walks the same list starting
      // from a random position and relies on card-scoped seenIds to avoid
      // repeats. Strategy:
      //   1. TIGHT PASS: starting at cycleIdx, walk the full genre cycle once
      //      with the original BPM + popularity window. Per genre we retry
      //      twice — random draws from a small pool can return an already-
      //      seen track by chance. First not-yet-seen track wins.
      //   2. WIDE PASS: if no genre in the cycle yielded a new track, walk
      //      the whole cycle again with BPM+popularity constraints dropped.
      //      Keeps the user swapping even after they've exhausted the tight
      //      window — better UX than flashing "no more songs" while
      //      out-of-profile alternatives still exist.
      //   3. Only if the wide pass also produces nothing new do we show the
      //      "no more songs" message.
      // Card-scoped `seenIds` tracks every track ever displayed on this card
      // (including the initial one) so cycling around a tiny pool never
      // shows a duplicate — a stricter guarantee than the older "not equal
      // to current track" check, which allowed A→B→A over two swaps.
      // (Reported by Ami — small directions like Klezmer or tight BPM ranges
      // exhaust the tight pool within a handful of swaps.)
      const cycleGenres = directionGenres(d);
      let cycleIdx = cycleGenres.length ? Math.floor(Math.random() * cycleGenres.length) : 0;
      const seenIds = new Set([p.trackId]);
      const drawUnique = async (spec, pop) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          let byRank;
          try {
            byRank = await fetchAnchorTracks([spec], pop);
          } catch (e) {
            // Server-side failure (usually Postgres 57014 statement timeout on
            // a cold query plan). Don't block the swap — skip this genre so
            // walkCycle tries the next one. A subsequent swap on the same
            // genre often succeeds because the plan is now warm in cache.
            console.warn(`swap: fetchAnchorTracks failed for genre "${spec.genre}" (attempt ${attempt + 1}):`, e?.message || e);
            return null;
          }
          const candidate = byRank[String(spec.rank)];
          if (candidate && !seenIds.has(candidate)) return candidate;
        }
        return null;
      };
      const walkCycle = async (bpmRange, pop) => {
        for (let step = 0; step < cycleGenres.length; step++) {
          const idx = (cycleIdx + step) % cycleGenres.length;
          const spec = {
            rank: d.rank,
            genre: cycleGenres[idx],
            bpm_range: bpmRange,
            inst_pref: d.instrumentalness_preference || 'none',
          };
          const hit = await drawUnique(spec, pop);
          if (hit) { cycleIdx = (idx + 1) % cycleGenres.length; return hit; }
        }
        return null;
      };
      swap.addEventListener('click', async () => {
        swap.disabled = true;
        // Reset to the canonical label — NOT the current DOM text, which may
        // be a stale "אין עוד שירים" message from a prior click that failed
        // to widen. Otherwise a successful swap after that message would end
        // up restoring the message, and the user sees "no more songs" while
        // songs keep loading.
        swap.innerHTML = '<span class="sb-spinner" style="width:12px;height:12px;margin-inline-end:6px;vertical-align:-2px"></span>מחליפים…';
        try {
          let nextId = await walkCycle(d.bpm_range, popularityWindow);
          if (!nextId) {
            nextId = await walkCycle({ min: 0, max: 300 }, [0, 100]);
          }
          if (!nextId) {
            swap.textContent = 'אין עוד שירים בכיוון הזה';
            return;
          }
          seenIds.add(nextId);
          const m2 = (await fetchTrackMeta([nextId]))[nextId] || {};
          trackMeta[nextId] = m2;
          cardEl.dataset.trackId = nextId;
          cardEl.dataset.uri = `spotify:track:${nextId}`;
          destroyController();
          pendingPlay = false;
          playBtn.classList.remove('waiting');
          playBtn.innerHTML = PLAY_ICON;
          resetPbState();
          if (artImg.tagName === 'IMG' && m2.art) artImg.src = m2.art;
          titleEl.textContent = m2.name || '';
          artistEl.textContent = m2.artist || '';
          embedWrap.querySelector('.preview-spotify-mount')?.remove();
          embedWrap.querySelector('iframe')?.remove();
          const newMount = el('div', { class: 'preview-spotify-mount' });
          embedWrap.append(newMount);
          wireController(newMount);
          swap.innerHTML = SWAP_BUTTON_HTML;
        } catch (err) {
          console.warn('swap failed:', err);
          swap.innerHTML = SWAP_BUTTON_HTML;
        } finally {
          swap.disabled = false;
        }
      });

      const flyOff = (dir) => {
        // dir: 'left' | 'right' | 'up'
        const w = window.innerWidth || 600;
        const h = window.innerHeight || 800;
        cardEl.style.transition = 'transform .28s ease, opacity .28s ease';
        if (dir === 'up') {
          cardEl.style.transform = 'translateY(' + (-h) + 'px)';
        } else {
          const like = dir === 'right';
          cardEl.style.transform = 'translateX(' + (like ? w : -w) + 'px) rotate(' + (like ? 18 : -18) + 'deg)';
        }
        cardEl.style.opacity = '0';
      };

      const decide = (like) => {
        if (busy) return;
        busy = true;
        destroyController();
        if (like) likedDirections.push(d);
        index += 1;
        progFill.style.width = ((index / previews.length) * 100) + '%';
        showSwipeToast(like ? 'אהבת' : 'לא בשבילך', like ? 'yes' : 'no');
        flyOff(like ? 'right' : 'left');
        // Undo rolls this exact swipe back: pop the direction from likes
        // (if applicable), rewind the index, re-render the previous card.
        showUndoToast(() => {
          if (like) {
            const idx = likedDirections.lastIndexOf(d);
            if (idx !== -1) likedDirections.splice(idx, 1);
          }
          index -= 1;
          progFill.style.width = ((index / previews.length) * 100) + '%';
          showCard();
        });
        setTimeout(showCard, 300);
      };

      // Super-like = "yes on the direction PLUS save this specific track as
      // a favorite for future taste-tuning". Semantically a commit + advance,
      // so we fly the card upward and step to the next preview. Distinct from
      // plain yes only in that the track's spotify_id also lands in the
      // shared Set that the signup step persists.
      const superLike = () => {
        if (busy) return;
        busy = true;
        destroyController();
        const trackId = cardEl.dataset.trackId || p.trackId;
        // Only .delete on undo if this call was the one that added it;
        // otherwise we'd clobber a previous super-like of the same track.
        const trackWasAlreadyLiked = !!(superLikedTracks && superLikedTracks.has(trackId));
        if (superLikedTracks) superLikedTracks.add(trackId);
        likedDirections.push(d);
        index += 1;
        progFill.style.width = ((index / previews.length) * 100) + '%';
        showSwipeToast('סופר לייק', 'super');
        flyOff('up');
        showUndoToast(() => {
          if (superLikedTracks && !trackWasAlreadyLiked) superLikedTracks.delete(trackId);
          const idx = likedDirections.lastIndexOf(d);
          if (idx !== -1) likedDirections.splice(idx, 1);
          index -= 1;
          progFill.style.width = ((index / previews.length) * 100) + '%';
          showCard();
        });
        setTimeout(showCard, 300);
      };
      noBtn.onclick = () => decide(false);
      yesBtn.onclick = () => decide(true);

      // Swipe hit-area is the album art (artWrap) ONLY. Everywhere else on
      // the card (title, artist, swap button, description, progress bar)
      // scrolls the page normally on touch — the card is often taller than
      // the viewport on smaller phones, so hijacking every pixel for swipe
      // would break vertical page scrolling. The card as a whole still
      // animates on swipe (transform lives on cardEl); only the input
      // surface is scoped down.
      // Horizontal swipe decides yes/no; upward swipe past the threshold
      // super-likes and advances. Rails glow with the dominant axis so the
      // user sees which gesture they're heading into before releasing.
      const SUPER_LIKE_THRESHOLD = 100;
      let startX = null;
      let startY = null;
      let dx = 0;
      let dy = 0;
      let dragging = false;
      artWrap.addEventListener('pointerdown', (e) => {
        // Play button lives INSIDE artWrap and handles its own click — don't
        // start a swipe on it. (The swap/prog-bar guards from the previous
        // version are gone because those elements are outside artWrap.)
        if (busy || e.target.closest('.sw2-play')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        dx = 0;
        dy = 0;
        cardEl.classList.add('dragging');
        try { artWrap.setPointerCapture(e.pointerId); } catch { }
      });
      artWrap.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        dx = e.clientX - startX;
        dy = e.clientY - startY;
        // Translate on both axes; rotate is driven only by horizontal
        // movement so an upward drag doesn't spin the card.
        cardEl.style.transform =
          'translate(' + dx + 'px, ' + dy + 'px) rotate(' + (dx / 22) + 'deg)';
        // Which axis is the user committing to? Bias slightly toward
        // horizontal (the primary decision) so a diagonal drag with slightly
        // more vertical movement doesn't accidentally show super-like.
        const vertDominant = dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.2;
        if (vertDominant) {
          railSuper.style.opacity = String(Math.min(1, 0.75 - dy / 150));
          railYes.style.opacity = '0.35';
          railNo.style.opacity = '0.35';
        } else {
          railYes.style.opacity = dx > 0 ? String(Math.min(1, 0.75 + dx / 150)) : '0.35';
          railNo.style.opacity = dx < 0 ? String(Math.min(1, 0.75 - dx / 150)) : '0.35';
          railSuper.style.opacity = '0.35';
        }
      });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        cardEl.classList.remove('dragging');
        const vertDominant = dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.2;
        if (vertDominant && dy <= -SUPER_LIKE_THRESHOLD) {
          railsIdle();
          superLike();
          return;
        }
        if (dx > 90) { decide(true); railsIdle(); return; }
        if (dx < -90) { decide(false); railsIdle(); return; }
        cardEl.style.transform = '';
        railsIdle();
      };
      artWrap.addEventListener('pointerup', endDrag);
      artWrap.addEventListener('pointercancel', endDrag);
    };

    showCard();
  });
}

// Prepares everything the swipe deck needs — page 1 + page 2 anchor tracks
// AND metadata for all preview tracks — up front. Callers can fire this in
// the background (e.g. while the user picks opening hours) so that when the
// swipe deck is actually needed it can render instantly.
//
// Page 1 anchor fetch runs first; page 2 anchor fetch is intentionally
// SEQUENCED after page 1 completes. Running both fetches concurrently caused
// the v5_anchor_tracks RPC (JOIN-heavy random-order query) to trip Supabase's
// statement_timeout on page 2 while page 1 warmed the plan cache — the two
// batches contended and page 2 lost. Sequencing lets page 2's queries reuse
// page 1's warm plan and connections. Total prep goes from max() to sum()
// (~1-2s slower), but that stays hidden behind the hours picker.
export async function preparePreview({ directions, page2Promise, popularityWindow }) {
  // Sequence anchor-tracks calls (page 2's anchor fetch waits for page 1's
  // to finish) so page 2's query hits the warm v5_anchor_tracks plan cache
  // and doesn't trip Supabase's statement_timeout. Metadata (get_track)
  // calls hit Spotify directly and don't need this — they run in parallel.
  let anchorSeq = Promise.resolve();
  const sequencedAnchors = (dirs) => {
    const prev = anchorSeq;
    const next = (async () => {
      await prev.catch(() => { });
      return fetchInitialPreviewTracks(dirs, popularityWindow);
    })();
    anchorSeq = next;
    return next;
  };

  // Diagnostic: log directions that came from the model vs. previews that
  // actually rendered. Any gap = anchor-tracks returned no cached song for
  // that direction's genre pool (directionsToPreviews silently drops).
  const logPageOutcome = (label, dirs, previews, byRank) => {
    const missing = (dirs || []).filter((d) => !byRank[String(d.rank)]);
    const missingTitles = missing.map((d) => d.title_en || d.anchor_genre || '(no title)');
    console.log(`[v6 preview] ${label}: model returned ${dirs.length}, previews rendered ${previews.length}` +
      (missingTitles.length ? ` — ${missingTitles.length} dropped due to empty anchor pool: ${missingTitles.join(' | ')}` : ''));
  };

  // Page 1: anchors → previews → metadata, chained together.
  const page1Ready = (async () => {
    console.log('[v6 preview] page 1 model directions:', directions.map((d) => ({ rank: d.rank, title: d.title_en, genres: directionGenres(d), bpm: d.bpm_range })));
    const byRank = await sequencedAnchors(directions);
    const previews = directionsToPreviews(directions, byRank);
    logPageOutcome('page 1', directions, previews, byRank);
    const trackMeta = previews.length ? await fetchTrackMeta(previews.map((p) => p.trackId)) : {};
    return { previews, trackMeta };
  })().catch((e) => {
    console.warn('[v6 preview] page 1 pipeline failed (network / anchor-tracks throw / metadata throw):', e);
    return { previews: [], trackMeta: {} };
  });

  // Page 2: waits for Gemini's second call, then hits anchor-tracks (queued
  // behind page 1 via sequencedAnchors), then metadata. Runs concurrently
  // with page 1's metadata fetch — that's the whole point of the refactor.
  //
  // The 5 possible failure modes here, each with a distinct log line so
  // Ami (or whoever's testing) can screenshot and we know exactly which
  // one fired without having to reproduce:
  //   1. Gemini's page 2 call throws (network / proxy 5xx / abort)
  //        → "page 2 model call threw"
  //   2. Gemini returns a valid response but with an error object
  //        (matcher_error, off_topic, etc. — usually MAX_TOKENS →
  //        unparseable → matcher_error before the raise to 65536)
  //        → "page 2 model returned error"
  //   3. Gemini returns fewer than 4 valid directions (some got filtered
  //        by normalizeDirections for missing fields)
  //        → "page 2 model returned fewer than 4 valid directions"
  //   4. anchor-tracks returns no rows for any direction (all empty pools)
  //        → logged by logPageOutcome, previews.length === 0
  //   5. anchor-tracks throws (Postgres 57014 double-hit, etc.)
  //        → "page 2 pipeline failed"
  const page2Ready = page2Promise
    ? (async () => {
      let page2Result;
      try {
        page2Result = await page2Promise;
      } catch (e) {
        console.warn('[v6 preview] page 2 model call threw (network / proxy / abort):', e);
        return { previews: [], trackMeta: {} };
      }
      if (!page2Result) {
        console.warn('[v6 preview] page 2 model returned null/undefined result');
        return { previews: [], trackMeta: {} };
      }
      if (page2Result.error) {
        console.warn(`[v6 preview] page 2 model returned error "${page2Result.error}" — ${page2Result.reasoning_en || '(no reason)'}`);
        return { previews: [], trackMeta: {} };
      }
      if (!Array.isArray(page2Result.directions) || !page2Result.directions.length) {
        console.warn('[v6 preview] page 2 model returned no directions at all (empty array or non-array)');
        return { previews: [], trackMeta: {} };
      }
      if (page2Result.directions.length < 4) {
        console.warn(`[v6 preview] page 2 model returned fewer than 4 valid directions (got ${page2Result.directions.length}) — some may have been dropped by normalizeDirections for missing required fields`);
      }
      console.log('[v6 preview] page 2 model directions:', page2Result.directions.map((d) => ({ rank: d.rank, title: d.title_en, genres: directionGenres(d), bpm: d.bpm_range })));
      try {
        const byRank = await sequencedAnchors(page2Result.directions);
        const previews = directionsToPreviews(page2Result.directions, byRank);
        logPageOutcome('page 2', page2Result.directions, previews, byRank);
        const trackMeta = previews.length ? await fetchTrackMeta(previews.map((p) => p.trackId)) : {};
        return { previews, trackMeta };
      } catch (e) {
        console.warn('[v6 preview] page 2 pipeline failed after model (anchor-tracks throw / metadata throw):', e);
        return { previews: [], trackMeta: {} };
      }
    })()
    : Promise.resolve({ previews: [], trackMeta: {} });

  // Once both pages settle, emit a single summary line so at-a-glance
  // debugging is one grep away: `[v6 preview] SUMMARY page1=X/4 page2=Y/4`.
  Promise.all([page1Ready, page2Ready]).then(([p1, p2]) => {
    console.log(`[v6 preview] SUMMARY page1=${p1.previews.length}/4 page2=${p2.previews.length}/4 total=${p1.previews.length + p2.previews.length}/8`);
  });

  return { page1Ready, page2Ready };
}

// If `preparedPromise` is supplied, its resolution is what actually drives
// the swipe deck — the caller has already kicked off preparePreview() in the
// background. Otherwise we do the prep synchronously here as a fallback.
// When the prepared payload is already resolved, `await` returns in the same
// microtask so the swipe deck appears without a visible loading flash.
export async function runDirectionPreviewFlow({ directions, page2Promise, popularityWindow, preparedPromise, superLikedTracks }) {
  const container = document.querySelector('.screen-card');
  if (!container) throw new Error('preview: .screen-card not found');

  showLoading(container);

  const prepared = preparedPromise
    ? await preparedPromise
    : await preparePreview({ directions, page2Promise, popularityWindow });

  // The deck starts rendering as soon as page 1 is ready. Page 2's promise
  // is handed to renderSwipeDeck, which appends its previews to the deck
  // when it resolves — users can swipe through the first 4 cards while
  // cards 5-8 are still loading behind them.
  //
  // `superLikedTracks` is a Set the caller owns (state.superLikedTracks in
  // app.js). Each card's super-like button toggles items in the same Set,
  // so navigating back and forward preserves picks and the final list is
  // ready to hand off to signup at the end of the flow.
  const page1 = await prepared.page1Ready;
  if (!page1.previews.length) {
    // Page 1 empty — fall back to page 2 as a last chance.
    const page2 = await prepared.page2Ready;
    if (!page2.previews.length) return [];
    return renderSwipeDeck(container, page2.previews, page2.trackMeta, popularityWindow, null, superLikedTracks);
  }

  return renderSwipeDeck(container, page1.previews, page1.trackMeta, popularityWindow, prepared.page2Ready, superLikedTracks);
}
