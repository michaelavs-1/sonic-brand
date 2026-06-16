// v4 final result screen.
// Replaces .screen-card with an accordion-style header (playlist name +
// "40 שירים · Spotify" meta line) and an action footer (צרו שוב / שמור ב-Spotify).
//
// We deliberately do NOT render the Spotify embed iframe: the playlist is
// private+collaborative, and in production browsers block third-party cookies
// on the embed iframe, so Spotify shows it as anonymous → empty track list.
// The "שמור ב-Spotify" button opens open.spotify.com as a first-party
// navigation, where the user's cookies are visible and the playlist works.
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

// Renders the result UI. `onRegenerate` is an async function that triggers
// another buildFinalPlaylist run with the same inputs — wired up by app.js.
export async function showPlaylistResult(result, onRegenerate) {
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

  const playlistName = result.name || 'הפלייליסט שלכם';
  const metaLine     = `${result.trackCount} שירים · Spotify`;

  const saveBtn = el('a',
    {
      class:  'btn btn-primary',
      href:   result.url,
      target: '_blank',
      rel:    'noopener',
      style:  'text-decoration:none',
    },
    'פתח ב-Spotify ▶',
  );

  const regenBtn = el('button',
    { class: 'btn btn-secondary', type: 'button' },
    '🔄 צרו שוב',
  );

  if (typeof onRegenerate === 'function') {
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      saveBtn.style.pointerEvents = 'none';
      saveBtn.style.opacity = '0.5';
      try {
        await onRegenerate();
      } catch (err) {
        console.error('v4 regenerate failed:', err);
        regenBtn.disabled = false;
        saveBtn.style.pointerEvents = '';
        saveBtn.style.opacity = '';
      }
    });
  } else {
    regenBtn.disabled = true;
  }

  card.replaceChildren(
    el('h1', {}, 'הפלייליסט מוכן'),
    el('div', { class: 'pl-accordion' },
      el('div', { class: 'pl-accordion-head' },
        el('div', { class: 'pl-accordion-info' },
          el('div', { class: 'pl-accordion-title' }, playlistName),
          el('div', { class: 'pl-accordion-meta' }, metaLine),
        ),
      ),
      el('div', { class: 'pl-accordion-actions' }, saveBtn, regenBtn),
    ),
  );
}
