// v5 final result screen. Renders one accordion row per created playlist.
// Each row: title (playlist name), meta ("N שירים · Spotify"), and a
// "פתח ב-Spotify" link. Skipped rows show a friendly reason.
//
// Progressive rendering: initPlaylistResultsShell() renders one placeholder
// per selected direction up front. As each playlist finishes, the caller
// invokes updateOnePlaylistResult(index, result) to swap that placeholder
// for a real card. Once all are done, finalizePlaylistResultsHeading() updates
// the heading from "building…" to "ready".

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

function buildingHeadingText(count) {
  return count === 1
    ? 'בונים את הפלייליסט שלכם'
    : `בונים ${count} פלייליסטים שלכם`;
}

function readyHeadingText(built, total) {
  if (built === total && built > 0) {
    return built === 1 ? 'הפלייליסט מוכן' : `${built} פלייליסטים מוכנים`;
  }
  if (built === 0) return 'הפלייליסטים לא נוצרו';
  return `${built} מתוך ${total} פלייליסטים מוכנים`;
}

// Legacy single-spinner state (kept for callers that don't use the
// progressive shell). No longer used by the main v5 flow.
export function showBuildingPlaylists(count) {
  const card = getCard();
  card.replaceChildren(
    el('h1', {}, buildingHeadingText(count)),
    el('div', { class: 'preview-loading' },
      el('span', { class: 'sb-spinner' }),
      el('span', {}, 'יוצרים ב-Spotify…'),
    ),
  );
}

// Placeholder mirrors the finished card exactly (head + actions), so there's
// no layout shift when the real card swaps in. The button is disabled and
// dimmed via the .btn:disabled CSS rule already in index.html.
function renderPlaceholderCard(direction) {
  const title = direction?.title_he || 'פלייליסט';
  return el('div', { class: 'pl-accordion', 'data-placeholder': 'true' },
    el('div', { class: 'pl-accordion-head' },
      el('div', { class: 'pl-accordion-info' },
        el('div', { class: 'pl-accordion-title' }, title),
        el('div', { class: 'pl-accordion-meta' },
          el('span', { class: 'sb-spinner', style: 'margin-inline-end:8px' }),
          el('span', {}, 'יוצרים ב-Spotify…'),
        ),
      ),
    ),
    el('div', { class: 'pl-accordion-actions' },
      el('button',
        {
          class:    'btn btn-primary',
          type:     'button',
          disabled: 'true',
          style:    'text-decoration:none',
        },
        'פתח ב-Spotify ▶',
      ),
    ),
  );
}

function renderPlaylistRow(r) {
  const title = r.name || r.direction?.title_he || 'פלייליסט';

  if (r.skipped) {
    return el('div', { class: 'pl-accordion' },
      el('div', { class: 'pl-accordion-head' },
        el('div', { class: 'pl-accordion-info' },
          el('div', { class: 'pl-accordion-title' }, title),
          el('div', { class: 'pl-accordion-meta' }, `לא נוצר · ${r.reason || 'ללא סיבה'}`),
        ),
      ),
    );
  }

  const meta = `${r.trackCount} שירים · Spotify`;
  const open = el('a',
    {
      class:  'btn btn-primary',
      href:   r.url,
      target: '_blank',
      rel:    'noopener',
      style:  'text-decoration:none',
    },
    'פתח ב-Spotify ▶',
  );

  return el('div', { class: 'pl-accordion' },
    el('div', { class: 'pl-accordion-head' },
      el('div', { class: 'pl-accordion-info' },
        el('div', { class: 'pl-accordion-title' }, title),
        el('div', { class: 'pl-accordion-meta' }, meta),
      ),
    ),
    el('div', { class: 'pl-accordion-actions' }, open),
  );
}

// Renders the initial state: heading + N placeholder cards, one per direction,
// in rank order. Call once before firing the parallel playlist builds.
export function initPlaylistResultsShell(directions) {
  const card = getCard();
  const arr = Array.isArray(directions) ? directions : [];

  if (!arr.length) {
    card.replaceChildren(
      el('h1', {}, 'הפלייליסט לא נוצר'),
      el('p', { class: 'preview-empty' }, 'לא נבחרו כיוונים.'),
    );
    return;
  }

  const wrap = el('div', { id: 'pl-results-wrap' });
  for (const d of arr) wrap.append(renderPlaceholderCard(d));

  card.replaceChildren(
    el('h1', { id: 'pl-results-heading' }, buildingHeadingText(arr.length)),
    wrap,
  );
}

// Swap the placeholder at `index` for its final rendered card.
export function updateOnePlaylistResult(index, result) {
  const wrap = document.getElementById('pl-results-wrap');
  if (!wrap) return;
  const existing = wrap.children[index];
  if (!existing) return;
  existing.replaceWith(renderPlaylistRow(result));
}

// Update the heading once all playlists have settled.
export function finalizePlaylistResultsHeading(results) {
  const heading = document.getElementById('pl-results-heading');
  if (!heading) return;
  const arr = Array.isArray(results) ? results : [];
  const built = arr.filter((r) => r && !r.skipped).length;
  heading.textContent = readyHeadingText(built, arr.length);
}

// Legacy all-at-once renderer, kept for compatibility. Not used by the main
// v5 flow (which uses initPlaylistResultsShell + updateOnePlaylistResult).
export async function showPlaylistResults(results) {
  const card = getCard();
  const arr = Array.isArray(results) ? results : [];

  if (!arr.length) {
    card.replaceChildren(
      el('h1', {}, 'הפלייליסט לא נוצר'),
      el('p', { class: 'preview-empty' }, 'לא נבחרו כיוונים.'),
    );
    return;
  }

  const built = arr.filter((r) => !r.skipped).length;
  const children = [el('h1', {}, readyHeadingText(built, arr.length))];
  for (const r of arr) children.push(renderPlaylistRow(r));
  card.replaceChildren(...children);
}
