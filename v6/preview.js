// v6 preview screen — Michael's swipe deck UI over v5's per-direction anchor
// track selection.
//
// One anchor track per direction (from /api/v5/anchor-tracks, same as v5).
// Rendered one at a time as a Tinder-style card: big album art + track title +
// artist, hidden Spotify iframe drives audio, custom play button, drag/swipe
// or thumbs-up/down to decide. Swipe right = "build a playlist for this
// direction", swipe left = "skip this direction". Returns the array of liked
// directions, matching v5's runDirectionPreviewFlow contract.

const HEADING = 'בחרו את השירים שאהבתם';

const PLAY_ICON  = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8.2 5.6v12.8L19 12z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="6.6" y="5.6" width="3.9" height="12.8" rx="1.2"/><rect x="13.5" y="5.6" width="3.9" height="12.8" rx="1.2"/></svg>';

function fmtTime(ms) {
  const s   = Math.floor(Math.max(0, ms) / 1000);
  const m   = Math.floor(s / 60);
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
async function fetchAnchorTracks(directions, popularityWindow) {
  const specs = directions.map((d) => ({
    rank:   d.rank,
    genre:  d.anchor_genre,
    bpm_lo: Math.floor(d.bpm_range.min),
    bpm_hi: Math.ceil(d.bpm_range.max),
  }));
  const r = await fetch('/api/v5/anchor-tracks', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ specs, popularity: popularityWindow }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(`anchor-tracks ${r.status}: ${data?.error || r.statusText}`);
  }
  const { byRank } = await r.json();
  return byRank || {};
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
          name:   d.name,
          artist: (d.artists || []).map((a) => a.name).filter(Boolean).join(', '),
          art:    d.album?.images?.[1]?.url || d.album?.images?.[0]?.url || '',
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
async function renderSwipeDeck(card, initialPreviews, initialTrackMeta, popularityWindow, page2Ready) {
  const api = await getSpotifyIframeApi();

  return new Promise((resolve) => {
    // Mutable so page 2 can push into them once it resolves.
    const previews  = [...initialPreviews];
    const trackMeta = { ...initialTrackMeta };
    let page2Settled = false;

    const likedDirections = [];
    let index = 0;
    let controller = null;
    let busy = false;

    const progLabel = el('div', { class: 'swipe-progress-label' });
    const progFill  = el('div', { class: 'swipe-progress-fill' });
    const progBar   = el('div', { class: 'swipe-progress-bar' }, progFill);
    const deck      = el('div', { class: 'swipe-deck' });
    const railNo    = el('div', { class: 'sw2-rail no' },
      el('span', { class: 'sw2-chev' }, '‹'),
      el('span', { class: 'sw2-rail-label' }, 'לא אהבתי'),
    );
    const railYes = el('div', { class: 'sw2-rail yes' },
      el('span', { class: 'sw2-chev' }, '›'),
      el('span', { class: 'sw2-rail-label' }, 'אהבתי'),
    );
    const deckWrap = el('div', { class: 'sw2-deckwrap' }, deck, railNo, railYes);
    const noBtn    = el('button', { class: 'swipe-btn swipe-no',  type: 'button' }, '👎 לא בשבילי');
    const yesBtn   = el('button', { class: 'swipe-btn swipe-yes', type: 'button' }, '👍 אהבתי');
    const btns     = el('div', { class: 'swipe-actions' }, noBtn, yesBtn);
    const aiBox    = el('div', { class: 'ai-explain' },
      el('span', { class: 'ai-tag' }, '🎧 איך זה עובד?'),
      document.createTextNode(
        ' כל שיר מייצג כיוון מוזיקלי שמתאים לעסק שלך. אהבתם? החליקו ימינה או לחצו 👍 — ניצור פלייליסט מהכיוון הזה. פחות מתאים? החליקו שמאלה.',
      ),
    );

    card.replaceChildren(el('h1', {}, HEADING), aiBox, progLabel, progBar, deckWrap, btns);

    const setProgress = () => {
      const total = previews.length;
      // Show a small spinner next to the count until page 2 has settled
      // (either resolved with more previews or arrived empty). It signals
      // to the user that the denominator may still grow.
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
            el('div', { class: 'preview-load-column' },
              el('div', { class: 'preview-load-label' }, 'מכינים עוד שירים…'),
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

      const mount     = el('div', { class: 'preview-spotify-mount' });
      // The iframe lives inside .sw2-artwrap as a nearly-invisible overlay
      // (see CSS): the visible viewport keeps the media pipeline active, and
      // the custom play button drives it via the IFrame API.
      const embedWrap = el('div', { class: 'sw2-embed-hidden' }, mount);

      const playBtn = el('button', { class: 'sw2-play', type: 'button', 'aria-label': 'נגן' });
      playBtn.innerHTML = PLAY_ICON;
      const artImg = m.art
        ? el('img', { class: 'sw2-art', src: m.art, alt: '' })
        : el('div', { class: 'sw2-art sw2-art-ph' }, '🎵');
      const artWrap = el('div', { class: 'sw2-artwrap' }, artImg, spotifyBadge(), playBtn, embedWrap);

      const titleEl  = el('div', { class: 'sw2-title',  dir: 'ltr' }, m.name   || '');
      const artistEl = el('div', { class: 'sw2-artist', dir: 'ltr' }, m.artist || '');

      // Show the v5 direction's Hebrew description as the reason line — that's
      // Claude's one-line pitch for the direction.
      const reasonEl = d.description_he
        ? el('div', { class: 'preview-reason sw2-reason' }, d.description_he)
        : null;

      const SWAP_LABEL = '🔀 שיר אחר מהכיוון הזה';
      const swap = el('button', { class: 'swap-btn', type: 'button' }, SWAP_LABEL);

      // --- Playback progress bar. Interpolates position between the (sparse)
      // playback_update events via a RAF loop, so scrubbing feels smooth. The
      // outer .sw2-prog-bar reserves fixed 14px in the layout so hovering
      // never pushes the swap button / hint downward. ---
      const pbState = {
        lastPosition:  0,
        lastTimestamp: Date.now(),
        duration:      0,
        isPaused:      true,
        dragging:      false,
        pendingSeek:   null,     // seconds, set during drag; committed on release
        // playback_update `position` values are ignored while this timestamp
        // is in the future — after a controller.seek(), Spotify fires one
        // more update with the stale pre-seek position before catching up,
        // which without this guard makes the dot jump back for one frame.
        seekLockUntil: 0,
      };
      const pbFill      = el('div', { class: 'sw2-prog-fill' });
      const pbTrack     = el('div', { class: 'sw2-prog-track' }, pbFill);
      const pbThumb     = el('div', { class: 'sw2-prog-thumb' });
      const pbBar       = el('div', { class: 'sw2-prog-bar' }, pbTrack, pbThumb);
      const pbCurrent   = el('span', {}, '0:00');
      const pbTotal     = el('span', {}, '0:00');
      const pbTimes     = el('div', { class: 'sw2-timestamps' }, pbCurrent, pbTotal);
      const pbContainer = el('div', { class: 'sw2-progress' }, pbBar, pbTimes);

      const cardEl = el('div',
        {
          class: 'preview-card swipe-card swipe-card2',
          'data-rank':     String(d.rank),
          'data-track-id': p.trackId,
          'data-uri':      `spotify:track:${p.trackId}`,
        },
        artWrap,
        titleEl,
        artistEl,
        el('div', { class: 'sw2-chip' }, 'Preview'),
        reasonEl,
        pbContainer,
        el('div', {}, swap),
        el('div', { class: 'sw2-hint' }, '👆 אפשר גם לגרור את הכרטיס לצדדים'),
      );
      deck.replaceChildren(cardEl);

      // Progress bar interactions
      function pbPctFromEvent(e) {
        const rect = pbBar.getBoundingClientRect();
        const x    = Math.max(rect.left, Math.min(rect.right, e.clientX));
        return (x - rect.left) / rect.width;
      }
      function pbSeekTo(seconds) {
        if (!controller) return;
        try { controller.seek(seconds); } catch { }
        // Snap the local mirror so the RAF loop doesn't interpolate from the
        // old position for one frame before the next playback_update lands.
        pbState.lastPosition  = seconds * 1000;
        pbState.lastTimestamp = Date.now();
        // Give Spotify ~500ms to actually process the seek before we accept
        // its position updates again. Without this the first update after
        // seek carries the pre-seek position and briefly jumps the dot back.
        pbState.seekLockUntil = Date.now() + 500;
      }
      pbBar.addEventListener('pointerdown', (e) => {
        if (!pbState.duration) return;
        e.stopPropagation();          // don't let the card's swipe handler catch this
        pbState.dragging    = true;
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
        const target        = pbState.pendingSeek;
        pbState.dragging    = false;
        pbState.pendingSeek = null;
        pbBar.classList.remove('dragging');
        if (target != null) pbSeekTo(target);
      };
      pbBar.addEventListener('pointerup',     endPbDrag);
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
        pbFill.style.width  = (pct * 100) + '%';
        pbThumb.style.left  = (pct * 100) + '%';
        pbCurrent.textContent = fmtTime(pos);
        pbTotal.textContent   = fmtTime(dur);
        requestAnimationFrame(pbTick);
      })();

      function resetPbState() {
        pbState.lastPosition  = 0;
        pbState.lastTimestamp = Date.now();
        pbState.duration      = 0;
        pbState.isPaused      = true;
        pbState.pendingSeek   = null;
        pbFill.style.width    = '0%';
        pbThumb.style.left    = '0%';
        pbCurrent.textContent = '0:00';
        pbTotal.textContent   = '0:00';
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
              pbState.lastPosition  = dd.position;
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

      // "Another song from this direction" — re-hit /api/v5/anchor-tracks for
      // just this direction. The endpoint has no exclusion parameter — it
      // just draws randomly from the filtered pool — so a small pool can
      // return the same current track by chance. Strategy:
      //   1. Retry up to 4 times with the original (BPM + popularity) window
      //      to shrug off duplicate hits when the tight pool has ≥2 tracks.
      //   2. If that still fails, WIDEN: drop BPM + popularity constraints
      //      and draw purely from the anchor genre. Keeps the user swapping
      //      even after they've exhausted the tight window — better UX than
      //      flashing "no more songs" when we still have alternatives just
      //      outside the ideal profile.
      //   3. Only if the widened pool is also empty (or contains only the
      //      current track) do we show the "no more songs" message.
      // (Reported by Ami — small directions like Klezmer or tight BPM ranges
      // exhaust the tight pool within a handful of swaps.)
      const drawUnique = async (dir, pop) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const byRank = await fetchAnchorTracks([dir], pop);
          const candidate = byRank[String(dir.rank)];
          if (candidate && candidate !== cardEl.dataset.trackId) return candidate;
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
          let nextId = await drawUnique(d, popularityWindow);
          if (!nextId) {
            const wideDir = { ...d, bpm_range: { min: 0, max: 300 } };
            nextId = await drawUnique(wideDir, [0, 100]);
          }
          if (!nextId) {
            swap.textContent = 'אין עוד שירים בכיוון הזה';
            return;
          }
          const m2 = (await fetchTrackMeta([nextId]))[nextId] || {};
          trackMeta[nextId] = m2;
          cardEl.dataset.trackId = nextId;
          cardEl.dataset.uri     = `spotify:track:${nextId}`;
          destroyController();
          pendingPlay = false;
          playBtn.classList.remove('waiting');
          playBtn.innerHTML = PLAY_ICON;
          resetPbState();
          if (artImg.tagName === 'IMG' && m2.art) artImg.src = m2.art;
          titleEl.textContent  = m2.name   || '';
          artistEl.textContent = m2.artist || '';
          embedWrap.querySelector('.preview-spotify-mount')?.remove();
          embedWrap.querySelector('iframe')?.remove();
          const newMount = el('div', { class: 'preview-spotify-mount' });
          embedWrap.append(newMount);
          wireController(newMount);
          swap.textContent = SWAP_LABEL;
        } catch (err) {
          console.warn('swap failed:', err);
          swap.textContent = SWAP_LABEL;
        } finally {
          swap.disabled = false;
        }
      });

      const flyOff = (like) => {
        const w = window.innerWidth || 600;
        cardEl.style.transition = 'transform .28s ease, opacity .28s ease';
        cardEl.style.transform  = 'translateX(' + (like ? w : -w) + 'px) rotate(' + (like ? 18 : -18) + 'deg)';
        cardEl.style.opacity    = '0';
      };

      const decide = (like) => {
        if (busy) return;
        busy = true;
        destroyController();
        if (like) likedDirections.push(d);
        index += 1;
        progFill.style.width = ((index / previews.length) * 100) + '%';
        flyOff(like);
        setTimeout(showCard, 300);
      };
      noBtn.onclick  = () => decide(false);
      yesBtn.onclick = () => decide(true);

      // Drag anywhere on the card; side rails glow toward the decision.
      let startX = null;
      let dx = 0;
      let dragging = false;
      cardEl.addEventListener('pointerdown', (e) => {
        // Don't start a swipe on the swap/play buttons or the scrubbable
        // progress bar — they need their own pointer events.
        if (busy
            || e.target.closest('.swap-btn')
            || e.target.closest('.sw2-play')
            || e.target.closest('.sw2-prog-bar')) return;
        dragging = true;
        startX = e.clientX;
        dx = 0;
        cardEl.classList.add('dragging');
        try { cardEl.setPointerCapture(e.pointerId); } catch { }
      });
      cardEl.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        dx = e.clientX - startX;
        cardEl.style.transform  = 'translateX(' + dx + 'px) rotate(' + (dx / 22) + 'deg)';
        railYes.style.opacity   = dx > 0 ? String(Math.min(1, 0.75 + dx / 150)) : '0.35';
        railNo.style.opacity    = dx < 0 ? String(Math.min(1, 0.75 - dx / 150)) : '0.35';
      });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        cardEl.classList.remove('dragging');
        if (dx > 90)  { decide(true);  railsIdle(); return; }
        if (dx < -90) { decide(false); railsIdle(); return; }
        cardEl.style.transform = '';
        railsIdle();
      };
      cardEl.addEventListener('pointerup',     endDrag);
      cardEl.addEventListener('pointercancel', endDrag);
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
      await prev.catch(() => {});
      return fetchAnchorTracks(dirs, popularityWindow);
    })();
    anchorSeq = next;
    return next;
  };

  // Page 1: anchors → previews → metadata, chained together.
  const page1Ready = (async () => {
    console.log('v6 musical directions (page 1):', { directions });
    const byRank   = await sequencedAnchors(directions);
    const previews = directionsToPreviews(directions, byRank);
    const trackMeta = previews.length ? await fetchTrackMeta(previews.map((p) => p.trackId)) : {};
    return { previews, trackMeta };
  })().catch((e) => {
    console.warn('v6 preview: page 1 prep failed', e);
    return { previews: [], trackMeta: {} };
  });

  // Page 2: waits for Claude's second call, then hits anchor-tracks (queued
  // behind page 1 via sequencedAnchors), then metadata. Runs concurrently
  // with page 1's metadata fetch — that's the whole point of the refactor.
  const page2Ready = page2Promise
    ? (async () => {
        try {
          const page2Result = await page2Promise;
          if (!page2Result || page2Result.error
              || !Array.isArray(page2Result.directions) || !page2Result.directions.length) {
            if (page2Result?.error) console.warn('v6 preview: page 2 unavailable —', page2Result.error, page2Result.reasoning_en);
            return { previews: [], trackMeta: {} };
          }
          console.log('v6 musical directions (page 2):', { directions: page2Result.directions });
          const byRank   = await sequencedAnchors(page2Result.directions);
          const previews = directionsToPreviews(page2Result.directions, byRank);
          const trackMeta = previews.length ? await fetchTrackMeta(previews.map((p) => p.trackId)) : {};
          return { previews, trackMeta };
        } catch (e) {
          console.warn('v6 preview: page 2 promise rejected', e);
          return { previews: [], trackMeta: {} };
        }
      })()
    : Promise.resolve({ previews: [], trackMeta: {} });

  return { page1Ready, page2Ready };
}

// If `preparedPromise` is supplied, its resolution is what actually drives
// the swipe deck — the caller has already kicked off preparePreview() in the
// background. Otherwise we do the prep synchronously here as a fallback.
// When the prepared payload is already resolved, `await` returns in the same
// microtask so the swipe deck appears without a visible loading flash.
export async function runDirectionPreviewFlow({ directions, page2Promise, popularityWindow, preparedPromise }) {
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
  const page1 = await prepared.page1Ready;
  if (!page1.previews.length) {
    // Page 1 empty — fall back to page 2 as a last chance.
    const page2 = await prepared.page2Ready;
    if (!page2.previews.length) return [];
    return renderSwipeDeck(container, page2.previews, page2.trackMeta, popularityWindow, null);
  }

  return renderSwipeDeck(container, page1.previews, page1.trackMeta, popularityWindow, prepared.page2Ready);
}
