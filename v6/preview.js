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
async function renderSwipeDeck(card, previews, trackMeta, popularityWindow) {
  const api = await getSpotifyIframeApi();

  return new Promise((resolve) => {
    const total = previews.length;
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
      progLabel.textContent = 'רובין לומד את הטעם שלכם 🎧 · ' + Math.min(index + 1, total) + '/' + total;
      progFill.style.width = ((index / total) * 100) + '%';
    };

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
      if (index >= total) {
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

      const swap = el('button', { class: 'swap-btn', type: 'button' }, '🔀 שיר אחר מהכיוון הזה');

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
        el('div', {}, swap),
        el('div', { class: 'sw2-hint' }, '👆 אפשר גם לגרור את הכרטיס לצדדים'),
      );
      deck.replaceChildren(cardEl);

      let pendingPlay = false;
      const wireController = (mountNode) => {
        api.createController(mountNode, { uri: cardEl.dataset.uri, width: '100%', height: 80 }, (c) => {
          if (!cardEl.isConnected) { try { c.destroy(); } catch { } return; }
          controller = c;
          c.addListener('playback_update', (e) => {
            const paused = e?.data?.isPaused !== false;
            playBtn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
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
      // just this direction. The endpoint picks randomly, so a repeat call
      // usually returns a different track.
      swap.addEventListener('click', async () => {
        swap.disabled = true;
        const orig = swap.textContent;
        swap.innerHTML = '<span class="sb-spinner" style="width:12px;height:12px;margin-inline-end:6px;vertical-align:-2px"></span>מחליפים…';
        try {
          const byRank = await fetchAnchorTracks([d], popularityWindow);
          const nextId = byRank[String(d.rank)];
          if (!nextId || nextId === cardEl.dataset.trackId) {
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
          if (artImg.tagName === 'IMG' && m2.art) artImg.src = m2.art;
          titleEl.textContent  = m2.name   || '';
          artistEl.textContent = m2.artist || '';
          embedWrap.querySelector('.preview-spotify-mount')?.remove();
          embedWrap.querySelector('iframe')?.remove();
          const newMount = el('div', { class: 'preview-spotify-mount' });
          embedWrap.append(newMount);
          wireController(newMount);
          swap.textContent = orig;
        } catch (err) {
          console.warn('swap failed:', err);
          swap.textContent = orig;
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
        progFill.style.width = ((index / total) * 100) + '%';
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
        // Don't start a swipe on the swap or play buttons — they need their
        // own click events.
        if (busy || e.target.closest('.swap-btn') || e.target.closest('.sw2-play')) return;
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
  console.log('v6 musical directions (page 1):', { directions });
  const page1ByRank   = await fetchAnchorTracks(directions, popularityWindow);
  const page1Previews = directionsToPreviews(directions, page1ByRank);

  let page2Previews = [];
  if (page2Promise) {
    try {
      const page2Result = await page2Promise;
      if (page2Result && !page2Result.error && Array.isArray(page2Result.directions) && page2Result.directions.length) {
        console.log('v6 musical directions (page 2):', { directions: page2Result.directions });
        const page2ByRank = await fetchAnchorTracks(page2Result.directions, popularityWindow);
        page2Previews = directionsToPreviews(page2Result.directions, page2ByRank);
      } else if (page2Result?.error) {
        console.warn('v6 preview: page 2 unavailable —', page2Result.error, page2Result.reasoning_en);
      }
    } catch (e) {
      console.warn('v6 preview: page 2 promise rejected', e);
    }
  }

  const previews = [...page1Previews, ...page2Previews];

  // Track metadata (name / artist / art). Runs after we know the full preview
  // set — parallelised across all IDs inside fetchTrackMeta.
  const trackMeta = previews.length ? await fetchTrackMeta(previews.map((p) => p.trackId)) : {};

  return { previews, trackMeta };
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

  if (!prepared.previews.length) return [];
  return renderSwipeDeck(container, prepared.previews, prepared.trackMeta, popularityWindow);
}
