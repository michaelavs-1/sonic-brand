// v6 result screen. Uses v5's progressive placeholder-then-swap pattern for
// the playlist cards, then shows a minimal signup card (email only — no
// password anywhere in the system) that POSTs to /api/v6/account/signup
// with the playlists attached so they land on the account home once the
// magic link is clicked.

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
    ? 'בונים פלייליסט לדוגמה'
    : 'בונים פלייליסטים לדוגמה';
}

function readyHeadingText(built, total) {
  if (built === total && built > 0) {
    return built === 1 ? 'פלייליסט קצר לדוגמה מוכן' : 'פלייליסטים קצרים לדוגמה מוכנים';
  }
  if (built === 0) return 'הפלייליסטים לא נוצרו';
  return `${built} מתוך ${total} פלייליסטים לדוגמה מוכנים`;
}

function renderPlaceholderCard(direction) {
  const title = direction?.title_en || 'פלייליסט';
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
          class: 'btn btn-primary',
          type: 'button',
          disabled: 'true',
          style: 'text-decoration:none',
        },
        'פתח ב-Spotify ▶',
      ),
    ),
  );
}

function renderPlaylistRow(r) {
  const title = r.name || r.direction?.title_en || 'פלייליסט';

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
      class: 'btn btn-primary',
      href: r.url,
      target: '_blank',
      rel: 'noopener',
      style: 'text-decoration:none',
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

export function updateOnePlaylistResult(index, result) {
  const wrap = document.getElementById('pl-results-wrap');
  if (!wrap) return;
  const existing = wrap.children[index];
  if (!existing) return;
  existing.replaceWith(renderPlaylistRow(result));
}

export function finalizePlaylistResultsHeading(results) {
  const heading = document.getElementById('pl-results-heading');
  if (!heading) return;
  const arr = Array.isArray(results) ? results : [];
  const built = arr.filter((r) => r && !r.skipped).length;
  heading.textContent = readyHeadingText(built, arr.length);

  // Insert a subtitle just under the heading only in the "everything built"
  // case — the "0 built" / partial states already communicate a problem and
  // a signup nudge would read as tone-deaf there.
  const existingSub = document.getElementById('pl-results-subtitle');
  if (built === arr.length && built > 0) {
    if (!existingSub) {
      const sub = el('p', { id: 'pl-results-subtitle', class: 'subtitle' },
        'כדי לקבל גרסאות באורך מלא מדי יום לצד פיצ׳רים נוספים - הרשמו לרובין למטה');
      heading.after(sub);
    }
  } else if (existingSub) {
    existingSub.remove();
  }
}

// Renders the "אני רוצה את רובין לעסק שלי" CTA below the finalized playlist
// cards. Clicking it invokes onClick — which the caller wires up to
// showSignupCard so the signup form only appears after this button is clicked.
export function showRubinCTA(onClick) {
  const card = document.querySelector('.screen-card');
  if (!card) return;
  const existing = card.querySelector('#pl-results-cta');
  if (existing) existing.remove();
  const btn = document.createElement('button');
  btn.id = 'pl-results-cta';
  btn.className = 'btn btn-primary btn-block';
  btn.type = 'button';
  btn.textContent = 'אני רוצה את רובין לעסק שלי ←';
  btn.style.marginTop = '18px';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    onClick();
  });
  card.append(btn);
}

/* =========================================================================
   Signup card — shown after playlists are done. Email only (magic-link
   auth, no passwords anywhere). Sends { email, business_name, atmospheres,
   place, hours, longestMinutes, playlists } to /api/v6/account/signup, which
   creates/updates the user + business and emails a magic link. Client
   swaps in a "check your email" state; the user finishes login by clicking
   the emailed link, which lands them on /v6/account with their new
   playlists already saved.
   ========================================================================= */

function existingSessionEmail() {
  try {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.includes('auth-token'));
    if (!k) return null;
    const s = JSON.parse(localStorage.getItem(k));
    return s?.user?.email
      || (s?.access_token ? (JSON.parse(atob(s.access_token.split('.')[1])).email || null) : null);
  } catch { return null; }
}

// Turn a v5 buildDirectionPlaylists result into the account-home playlist shape.
// `expansion` carries the direction spec + popularity window forward so the
// dashboard's background expander can grow the playlist to a full day without
// having to re-run the atmosphere/directions flow.
function toAccountPlaylist(r) {
  const d = r.direction || {};
  const genres = Array.isArray(d.genres) && d.genres.length
    ? d.genres
    : [d.anchor_genre, ...(d.secondary_genres || [])].filter(Boolean);
  return {
    ico: '🎵',
    label: r.name || d.title_en || 'פלייליסט',
    url: r.url,
    id: r.id,
    trackCount: r.trackCount,
    genres,
    createdAt: new Date().toISOString().slice(0, 10),
    expansion: r.expansion || null,
  };
}

// Called by app.js after all playlists have finished building.
// results = array from buildDirectionPlaylists (some may be skipped)
// biz     = { name, atmospheres, place, hours, longestMinutes }
export function showSignupCard(results, biz) {
  const card = getCard();
  const arr = Array.isArray(results) ? results : [];
  const usable = arr.filter((r) => r && !r.skipped && r.url);

  if (!usable.length) {
    card.replaceChildren(
      el('h1', {}, 'לא נוצרו פלייליסטים'),
      el('p', { class: 'preview-empty' }, 'לא הצלחנו להרכיב פלייליסט מתוך הכיוונים שנבחרו.'),
    );
    return;
  }

  const playlists = usable.map(toAccountPlaylist);

  // Already logged in → save the new business under their account and go
  // straight to /v6/account. No email needed.
  const existing = existingSessionEmail();
  if (existing) {
    postSignupAndRedirect({ email: existing, business_name: biz?.name, biz, playlists });
    return;
  }

  const emailInput = el('input', {
    class: 'input-text',
    type: 'email',
    autocomplete: 'email',
    inputmode: 'email',
    placeholder: 'you@business.co.il',
  });
  const msg = el('p', { class: 'hint', style: 'color:#ff9b8a;font-size:13px' }, '');
  const goBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'שלחו לי קישור לאימייל ←');

  const submit = async () => {
    if (goBtn.disabled) return;
    const email = emailInput.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg.textContent = 'הזינו כתובת אימייל תקינה';
      emailInput.focus();
      return;
    }
    goBtn.disabled = true;
    const origHtml = goBtn.innerHTML;
    goBtn.innerHTML = '<span class="sb-spinner"></span>';
    msg.textContent = '';
    try {
      await postSignup({ email, business_name: biz?.name, biz, playlists });
      showCheckEmailState({ email, biz, playlists });
    } catch (err) {
      goBtn.disabled = false;
      goBtn.innerHTML = origHtml;
      msg.textContent = String(err?.message || 'משהו השתבש — נסו שוב');
    }
  };

  goBtn.addEventListener('click', submit);
  // Enter in the email input submits — the input isn't wrapped in a <form>,
  // so browsers won't do this for us.
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  card.replaceChildren(
    el('h1', {}, 'פלייליסטים לדוגמה מוכנים 🎉'),
    el('p', { class: 'subtitle', style: 'margin-bottom:12px' },
      'השאירו אימייל ונשלח קישור כניסה — ללא סיסמה. הפלייליסטים ימתינו לכם באזור האישי.'),
    el('div', { class: 'input-wrap' }, el('label', { class: 'input-label' }, 'אימייל'), emailInput),
    goBtn,
    msg,
  );
}

// After successful signup, replace the form with a "check your email" state
// including a resend link (in case the mail didn't arrive).
function showCheckEmailState({ email, biz, playlists }) {
  const card = getCard();
  const msg = el('p', { class: 'hint', style: 'margin-top:10px' }, '');

  const resend = el('button', { class: 'btn-ghost', type: 'button', style: 'display:block;margin-inline:auto' }, 'לא הגיע? שלחו שוב');
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    const orig = resend.textContent;
    resend.textContent = 'שולחים…';
    msg.style.color = '';
    msg.textContent = '';
    try {
      await postSignup({ email, business_name: biz?.name, biz, playlists });
      msg.style.color = 'var(--teal-soft)';
      msg.textContent = 'שלחנו שוב ✓';
    } catch (err) {
      msg.style.color = '#ff9b8a';
      msg.textContent = String(err?.message || 'שליחה נכשלה — נסו עוד רגע');
    } finally {
      setTimeout(() => { resend.disabled = false; resend.textContent = orig; }, 3000);
    }
  });

  card.replaceChildren(
    el('h1', {}, 'בדקו את המייל ✉️'),
    el('p', { class: 'subtitle', style: 'margin-bottom:8px' },
      `שלחנו קישור כניסה חד־פעמי אל ${email}`),
    el('p', { class: 'hint', style: 'margin-top:14px' },
      'הפלייליסטים כבר שמורים בחשבון — יופיעו לכם ברגע שתיכנסו.'),
    resend,
    msg,
  );
}

async function postSignup({ email, business_name, biz, playlists }) {
  const r = await fetch('/api/v6/account/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      business_name: business_name || null,
      business_type: null,
      atmospheres: biz?.atmospheres || [],
      place: biz?.place || null,
      hours: biz?.hours || null,
      longestMinutes: biz?.longestMinutes || 0,
      // Array of spotify_ids the user super-liked in the preview swipe deck.
      // Server persists to super_liked_tracks table (see the 2026-08-20
      // migration). Nothing consumes these rows yet — future playlist
      // tuning will read them.
      superLikedTracks: Array.isArray(biz?.superLikedTracks) ? biz.superLikedTracks : [],
      playlists,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data?.error || r.statusText);
  return data;
}

// Already-logged-in fast path: server just adds the new business/playlists
// to the existing account (JWT is unused server-side here — email is the
// key). No magic link needed; redirect straight to the dashboard.
async function postSignupAndRedirect({ email, business_name, biz, playlists }) {
  await postSignup({ email, business_name, biz, playlists });
  window.location.href = '/v6/account';
}
