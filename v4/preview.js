// v4 preview screens (2 + 3). Renders Spotify embeds via the IFrame API,
// captures selections, returns a deduped array of genres behind selected tracks.
//
// The user must NEVER see the genre name — they think they're picking songs.
// Genre lookup lives only in JS state (data-genre attribute on each card).
//
// The IFrame API gives us a controller per embed; we use it to auto-pause the
// other embeds when one starts playing.

import { buildCachedPreviews } from '/v4/generation/preview-builder.js?v=16062026a';

const HEADING = 'בחרו את השירים שאהבתם';

// Singleton: wait for the IFrame API script to call window.onSpotifyIframeApiReady.
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

function showEmpty(card, message) {
  card.replaceChildren(
    el('h1', {}, HEADING),
    el('p', { class: 'preview-empty' }, message),
  );
}

// Renders one batch of previews, wires the IFrame API controllers so only one
// embed plays at a time, and returns a Promise that resolves with the selected
// genres on submit. Tears down the controllers before resolving.
async function renderBatch(card, previews, submitLabel) {
  const list = el('div', { class: 'preview-list' });

  for (const p of previews) {
    const mount = el('div', { class: 'preview-spotify-mount' });
    const checkbox = el('input', { type: 'checkbox', class: 'preview-checkbox' });
    const cardEl = el('div',
      { class: 'preview-card', 'data-genre': p.genre, 'data-uri': `spotify:track:${p.trackId}` },
      el('label', { class: 'preview-check-wrap' }, checkbox),
      el('div', { class: 'preview-embed' }, mount),
    );
    list.append(cardEl);
  }

  const submitBtn = el('button',
    { class: 'btn btn-primary btn-block', type: 'button' },
    submitLabel,
  );

  card.replaceChildren(el('h1', {}, HEADING), list, submitBtn);

  // Now that mount nodes are in the DOM, attach Spotify IFrame API controllers.
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
        const isPaused = e?.data?.isPaused !== false;
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
      const selected = [];
      list.querySelectorAll('.preview-card').forEach((c) => {
        const cb = c.querySelector('.preview-checkbox');
        if (cb && cb.checked) selected.push(c.dataset.genre);
      });
      for (const c of controllers) {
        try { c.destroy(); } catch { }
      }
      resolve(selected);
    });
  });
}

export async function runPreviewFlow({ bizType, screenParams = {} }) {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('preview: .screen-card not found');

  showLoading(card);

  // One cached-preview round trip returns BOTH column-G (screen 2) and
  // column-H (screen 3) batches. No need to overlap network with the user's
  // listening time anymore — the DB returns both batches in <1s.
  const { G: previews1, H: previews2 } = await buildCachedPreviews(bizType, screenParams);

  let selected1 = [];
  if (!previews1.length) {
    console.warn('v4 preview: no cached previews for column G — skipping screen 2');
  } else {
    selected1 = await renderBatch(card, previews1, 'המשך ←');
  }

  showLoading(card);
  let selected2 = [];
  if (!previews2.length) {
    console.warn('v4 preview: no cached previews for column H — skipping screen 3');
  } else {
    selected2 = await renderBatch(card, previews2, 'סיים ←');
  }

  const desired = [...new Set([...selected1, ...selected2])];

  if (!previews1.length && !previews2.length) {
    showEmpty(card, 'אין דוגמיות זמינות — רענן ונסה שוב');
  } else {
    card.replaceChildren(
      el('h1', {}, HEADING),
      el('p', { class: 'preview-empty' }, 'תודה! בדקו את ה-Console לתוצאה.'),
    );
  }

  return desired;
}
