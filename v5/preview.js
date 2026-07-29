// v5 preview screens (2 + 3).
// Renders one Spotify-embed card per direction, 4 per page across 2 pages.
// Each card carries data-rank so we know which direction was picked.
//
// Anchor tracks come from /api/v5/anchor-tracks (Supabase cache). If a
// direction's anchor genre has no cached tracks, that direction is dropped
// from the preview (no card rendered) — the user simply sees fewer options.

const HEADING = 'בחרו את השירים שאהבתם';

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

function showLoading(card) {
  card.replaceChildren(
    el('div', { class: 'preview-loading' },
      el('span', { class: 'sb-spinner' }),
      el('span', {}, 'טוען שירים לדוגמא...'),
    ),
  );
}

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

// Renders one page of preview cards. Returns a Promise resolving with an array
// of the picked directions (from the input `cards` list).
async function renderBatch(container, cards, submitLabel) {
  const list = el('div', { class: 'preview-list' });

  for (const c of cards) {
    const d = c.direction;
    const mount    = el('div', { class: 'preview-spotify-mount' });
    const checkbox = el('input', { type: 'checkbox', class: 'preview-checkbox' });

    const secondaryList = Array.isArray(d.secondary_genres) && d.secondary_genres.length
      ? d.secondary_genres.join(', ')
      : '—';

    const infoEl = el('div', { class: 'preview-info' },
      el('div', { class: 'preview-info-title' }, d.title_en || '(no title)'),
      el('div', { class: 'preview-info-genres' },
        el('span', { class: 'preview-info-label' }, 'anchor: '),
        el('span', {}, d.anchor_genre || '—'),
        el('span', { class: 'preview-info-sep' }, ' · '),
        el('span', { class: 'preview-info-label' }, 'with: '),
        el('span', {}, secondaryList),
      ),
      el('div', { class: 'preview-info-desc' }, d.description_he || ''),
    );

    const cardEl = el('div',
      {
        class:       'preview-card',
        'data-rank': String(d.rank),
        'data-uri':  `spotify:track:${c.trackId}`,
      },
      el('div', { class: 'preview-card-row' },
        el('label', { class: 'preview-check-wrap' }, checkbox),
        el('div',   { class: 'preview-embed' }, mount),
      ),
      infoEl,
    );
    list.append(cardEl);
  }

  const submitBtn = el('button',
    { class: 'btn btn-primary btn-block', type: 'button' },
    submitLabel,
  );

  container.replaceChildren(el('h1', {}, HEADING), list, submitBtn);

  const api = await getSpotifyIframeApi();
  const controllers = [];
  const lastIsPaused = new Map();

  list.querySelectorAll('.preview-spotify-mount').forEach((mount) => {
    const cardEl = mount.closest('.preview-card');
    const uri = cardEl?.dataset.uri;
    if (!uri) return;
    api.createController(mount, { uri, width: '100%', height: 80 }, (controller) => {
      controllers.push(controller);
      lastIsPaused.set(controller, true);
      controller.addListener('playback_update', (e) => {
        const isPaused  = e?.data?.isPaused !== false;
        const wasPaused = lastIsPaused.get(controller) ?? true;
        lastIsPaused.set(controller, isPaused);
        if (wasPaused && !isPaused) {
          for (const other of controllers) {
            if (other !== controller) {
              try { other.pause(); } catch { }
            }
          }
        }
      });
    });
  });

  return new Promise((resolve) => {
    submitBtn.addEventListener('click', () => {
      const picked = [];
      list.querySelectorAll('.preview-card').forEach((c) => {
        const cb = c.querySelector('.preview-checkbox');
        if (cb && cb.checked) {
          const rank = Number(c.dataset.rank);
          const match = cards.find(x => x.direction.rank === rank);
          if (match) picked.push(match.direction);
        }
      });
      for (const c of controllers) {
        try { c.destroy(); } catch { }
      }
      resolve(picked);
    });
  });
}

// Given page 1 directions + a promise for page 2, builds two preview pages.
// Page 1 renders immediately. Page 2 is awaited when the user clicks continue
// on page 1 — normally already resolved by then. Returns the union of picked
// directions after both pages submit.
async function directionsToCards(directions, popularityWindow) {
  const byRank = await fetchAnchorTracks(directions, popularityWindow);
  const cards = directions
    .map((d) => {
      const trackId = byRank[String(d.rank)];
      if (!trackId) return null;
      return { direction: d, trackId };
    })
    .filter(Boolean);
  cards.sort((a, b) => a.direction.rank - b.direction.rank);
  return cards;
}

export async function runDirectionPreviewFlow({ directions, page2Promise, popularityWindow }) {
  const container = document.querySelector('.screen-card');
  if (!container) throw new Error('preview: .screen-card not found');

  showLoading(container);

  // Page 1 — render as soon as anchor tracks resolve.
  const page1Cards = await directionsToCards(directions, popularityWindow);
  const picked1 = page1Cards.length ? await renderBatch(container, page1Cards, 'המשך ←') : [];

  // Page 2 — await the background call. By the time the user clicks continue
  // on page 1 it's usually already resolved.
  showLoading(container);
  let picked2 = [];
  if (page2Promise) {
    let page2Result;
    try {
      page2Result = await page2Promise;
    } catch (e) {
      console.warn('v5 preview: page 2 promise rejected', e);
    }
    if (page2Result?.error) {
      console.warn('v5 preview: page 2 unavailable —', page2Result.error, page2Result.reasoning_en);
    } else if (Array.isArray(page2Result?.directions) && page2Result.directions.length) {
      console.log('v5 musical directions (page 2):', { directions: page2Result.directions });
      const page2Cards = await directionsToCards(page2Result.directions, popularityWindow);
      if (page2Cards.length) {
        picked2 = await renderBatch(container, page2Cards, 'סיים ←');
      }
    }
  }

  const seen = new Set();
  const out = [];
  for (const d of [...picked1, ...picked2]) {
    if (seen.has(d.rank)) continue;
    seen.add(d.rank);
    out.push(d);
  }
  return out;
}
