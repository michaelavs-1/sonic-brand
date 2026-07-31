// v6 result screen. Uses v5's progressive placeholder-then-swap pattern for
// the playlist cards, then shows a minimal signup card (email + password
// only, no subscription/pricing) that POSTs to /api/v6/account/signup with
// the playlists attached so they land on the account home.

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
   Signup card — shown after playlists are done. Minimal: email + password.
   Sends { email, password, business_name, atmospheres, place, playlists }
   to /api/v6/account/signup. On success signs the user in and redirects to
   /v6/account.
   ========================================================================= */

const SB_URL  = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

async function passwordLogin(email, password) {
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || 'login failed');
  if (!j.expires_at && j.expires_in) j.expires_at = Math.floor(Date.now() / 1000) + j.expires_in;
  localStorage.setItem('sb-xhkqrxljncazvbgkmqex-auth-token', JSON.stringify(j));
}

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
  const genres = [d.anchor_genre, ...(d.secondary_genres || [])].filter(Boolean);
  return {
    ico:        '🎵',
    label:      r.name || d.title_en || 'פלייליסט',
    url:        r.url,
    id:         r.id,
    trackCount: r.trackCount,
    genres,
    createdAt:  new Date().toISOString().slice(0, 10),
    expansion:  r.expansion || null,
  };
}

// Called by app.js after all playlists have finished building.
// results = array from buildDirectionPlaylists (some may be skipped)
// biz     = { name, atmospheres, place }
export function showSignupCard(results, biz) {
  const card = getCard();
  const arr  = Array.isArray(results) ? results : [];
  const usable = arr.filter((r) => r && !r.skipped && r.url);

  if (!usable.length) {
    card.replaceChildren(
      el('h1', {}, 'לא נוצרו פלייליסטים'),
      el('p', { class: 'preview-empty' }, 'לא הצלחנו להרכיב פלייליסט מתוך הכיוונים שנבחרו.'),
    );
    return;
  }

  const playlists = usable.map(toAccountPlaylist);

  // If already logged in, skip signup and go straight to /v6/account after
  // POST-ing the fresh playlists.
  const existing = existingSessionEmail();
  if (existing) {
    postSignupAndRedirect({ email: existing, business_name: biz?.name, biz, playlists, isNew: false });
    return;
  }

  const emailInput = el('input', { class: 'input-text', type: 'email',    autocomplete: 'username',     inputmode: 'email', placeholder: 'you@business.co.il' });
  const passInput  = el('input', { class: 'input-text', type: 'password', autocomplete: 'new-password', placeholder: 'לפחות 6 תווים' });
  const msg = el('p', { class: 'hint', style: 'color:#ff9b8a;font-size:13px' }, '');
  const goBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'צרו חשבון ועברו לאזור האישי ←');

  goBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim().toLowerCase();
    const pass  = passInput.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'הזינו כתובת אימייל תקינה'; emailInput.focus(); return; }
    if (pass.length < 6) { msg.textContent = 'הסיסמה צריכה להיות באורך 6 תווים לפחות'; passInput.focus(); return; }
    goBtn.disabled = true;
    const origHtml = goBtn.innerHTML;
    goBtn.innerHTML = '<span class="sb-spinner"></span>';
    msg.textContent = '';
    try {
      await postSignupAndRedirect({ email, password: pass, business_name: biz?.name, biz, playlists, isNew: true });
    } catch (err) {
      goBtn.disabled = false;
      goBtn.innerHTML = origHtml;
      msg.textContent = String(err?.message || 'משהו השתבש — נסו שוב');
    }
  });

  card.replaceChildren(
    el('h1', {}, 'הפלייליסטים מוכנים 🎉'),
    el('p',  { class: 'subtitle', style: 'margin-bottom:12px' }, 'צרו חשבון כדי לשמור אותם ולנהל את המוזיקה של העסק שלכם.'),
    el('div', { class: 'input-wrap' }, el('label', { class: 'input-label' }, 'אימייל'), emailInput),
    el('div', { class: 'input-wrap' }, el('label', { class: 'input-label' }, 'סיסמה'), passInput),
    goBtn,
    msg,
  );
}

async function postSignupAndRedirect({ email, password, business_name, biz, playlists, isNew }) {
  const r = await fetch('/api/v6/account/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      business_name: business_name || null,
      business_type: null,
      atmospheres:   biz?.atmospheres || [],
      place:         biz?.place || null,
      playlists,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data?.error || r.statusText);
  if (isNew && password) {
    try { await passwordLogin(email, password); } catch (e) { console.warn('auto-login failed:', e); }
  }
  window.location.href = '/v6/account';
}
