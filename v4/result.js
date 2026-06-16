// v4 final result screen.
// Replaces .screen-card with a Spotify IFrame embed of the freshly-built
// playlist + a primary "open in Spotify" button. Uses the same IFrame API
// pattern as v4/preview.js (script is already loaded by v4/index.html).
//
// On build failure or skip (no tracks matched), shows a friendly message.

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

function getCard() {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('result: .screen-card not found');
  return card;
}

export function showBuildingPlaylist() {
  const card = getCard();
  card.replaceChildren(
    el('h1', {}, 'בונים את הפלייליסט שלכם'),
    el('div', { class: 'preview-loading' },
      el('span', { class: 'sb-spinner' }),
      el('span', {}, 'יוצרים פלייליסט ב-Spotify…'),
    ),
  );
}

export async function showPlaylistResult(result) {
  const card = getCard();

  if (result?.skipped || !result?.url) {
    card.replaceChildren(
      el('h1', {}, 'הפלייליסט לא נוצר'),
      el('p', { class: 'preview-empty' },
        result?.reason
          ? `סיבה: ${result.reason}`
          : 'לא נמצאו שירים מתאימים בקאש. נסו שוב או הרחיבו את הקאש.'),
    );
    return;
  }

  const trackLine = result.trackCount === result.requested
    ? `${result.trackCount} שירים`
    : `${result.trackCount} שירים (מתוך ${result.requested} מבוקשים)`;

  const mount = el('div', { class: 'preview-spotify-mount', style: 'min-height:380px' });
  const openBtn = el('a',
    {
      class:  'btn btn-primary btn-block',
      href:   result.url,
      target: '_blank',
      rel:    'noopener',
      style:  'display:block;text-align:center;text-decoration:none;margin-top:16px',
    },
    'פתחו ב-Spotify ←',
  );

  card.replaceChildren(
    el('h1', {}, 'הפלייליסט מוכן'),
    el('p', { class: 'subtitle', style: 'text-align:center' }, trackLine),
    el('div', { class: 'preview-embed', style: 'margin-top:18px' }, mount),
    openBtn,
  );

  const api = await getSpotifyIframeApi();
  api.createController(
    mount,
    { uri: `spotify:playlist:${result.id}`, width: '100%', height: 380 },
    () => { /* nothing to wire — single embed */ },
  );
}
