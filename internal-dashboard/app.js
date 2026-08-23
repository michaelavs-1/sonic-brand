// Robin internal admin dashboard — test/scaffolding page.
//
// Placeholder for Michael's forthcoming real dashboard (his own repo).
// This page exists so we can eyeball the /api/internal/* endpoints locally
// against `vercel dev` before Michael builds anything of his own. Not
// intended as the shipped product.
//
// Auth: prompts once for INTERNAL_ADMIN_API_KEY, stores in sessionStorage
// (auto-clears when the tab closes; not localStorage — the key shouldn't
// linger across sessions on shared machines). Sent as
// `Authorization: Bearer <key>` on every API call.
//
// Routes (hash-based, no server config needed):
//   #/               → list of businesses
//   #/business/<id>  → detail view for one business

const KEY_STORAGE = 'robin.internal.adminKey';
const app = document.getElementById('app');

function getKey()    { return sessionStorage.getItem(KEY_STORAGE) || ''; }
function setKey(k)   { sessionStorage.setItem(KEY_STORAGE, k); }
function clearKey()  { sessionStorage.removeItem(KEY_STORAGE); }

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class')          n.className = v;
    else if (k === 'html')      n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else                        n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

async function api(path) {
  const key = getKey();
  const r = await fetch(path, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (r.status === 401 || r.status === 403) {
    clearKey();
    const err = new Error('Admin key rejected. Sign in again.');
    err.authFailed = true;
    throw err;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ---------- appbar ----------
function renderAppbar(showSignOut) {
  return el('header', { class: 'appbar' },
    el('div', { class: 'title' }, 'Robin Internal Dashboard', el('small', {}, '· test scaffolding')),
    showSignOut
      ? el('button', {
          class: 'ghost',
          onclick: () => { clearKey(); location.hash = '#/'; route(); },
        }, 'Sign out')
      : null,
  );
}

// ---------- login ----------
function renderLogin(errText = '') {
  const input = el('input', {
    type: 'password',
    placeholder: 'INTERNAL_ADMIN_API_KEY',
    autocomplete: 'off',
    autofocus: true,
  });
  const err = el('div', { class: 'login-err' }, errText);
  const submit = async () => {
    const k = input.value.trim();
    if (!k) { err.textContent = 'Enter the admin API key'; return; }
    setKey(k);
    err.textContent = '';
    try {
      await api('/api/internal/users');   // validates the key
      route();                             // key good → render list
    } catch (e) {
      err.textContent = e.message || 'Sign-in failed';
    }
  };
  const go = el('button', { onclick: submit }, 'Enter');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  app.replaceChildren(
    renderAppbar(false),
    el('div', { class: 'banner' },
      'Local test page. Set INTERNAL_ADMIN_API_KEY in .env.local and paste the same value here to sign in.'),
    el('div', { class: 'login-wrap' },
      el('div', { class: 'login-card' },
        el('h1', {}, 'Sign in'),
        el('p', {}, 'Bearer token from your .env.local (INTERNAL_ADMIN_API_KEY).'),
        input,
        el('div', { class: 'row' }, go),
        err,
      ),
    ),
  );
}

// ---------- list view ----------
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

async function renderList() {
  app.replaceChildren(
    renderAppbar(true),
    el('main', {},
      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'Users'),
          el('span', { class: 'meta' }, el('span', { class: 'spinner' }), ' loading…'),
        ),
      ),
    ),
  );

  let data;
  try { data = await api('/api/internal/users'); }
  catch (e) {
    if (e.authFailed) return renderLogin(e.message);
    return renderError(e.message);
  }

  const rows = (data.businesses || []).map((b) => el('tr', {},
    el('td', {},
      b.owner_email
        ? el('a', { href: `#/business/${b.business_id}` }, b.owner_email)
        : el('span', { class: 'pill warn' }, '(no email)'),
    ),
    el('td', {}, b.name || el('span', { class: 'pill dim' }, '(unnamed)')),
    el('td', {}, fmtDate(b.created_at)),
    el('td', {},
      b.has_prompt
        ? el('span', { class: 'pill good' }, 'yes')
        : el('span', { class: 'pill dim' }, 'no'),
    ),
    el('td', {},
      el('a', { href: `#/business/${b.business_id}` }, 'view →'),
    ),
  ));

  app.replaceChildren(
    renderAppbar(true),
    el('main', {},
      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'Users'),
          el('span', { class: 'meta' }, `${data.count} businesses`),
        ),
        rows.length === 0
          ? el('div', { class: 'empty' }, 'No businesses yet.')
          : el('table', {},
              el('thead', {}, el('tr', {},
                el('th', {}, 'Owner email'),
                el('th', {}, 'Business name'),
                el('th', {}, 'Created'),
                el('th', {}, 'Prompt captured'),
                el('th', {}, ''),
              )),
              el('tbody', {}, ...rows),
            ),
      ),
    ),
  );
}

// ---------- detail view ----------
function renderKV(entries) {
  return el('div', { class: 'kv' },
    ...entries.flatMap(([k, v, opts = {}]) => [
      el('div', { class: 'k' }, k),
      el('div', { class: `v${opts.mono ? ' mono' : ''}` }, v == null || v === '' ? '—' : v),
    ]),
  );
}

function renderHours(hours) {
  if (!hours || !hours.hours) return el('div', { class: 'empty' }, 'No hours set.');
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows = names.map((n, i) => {
    const h = hours.hours[i] || {};
    const open = h.closed ? 'closed' : `${h.open || '?'} – ${h.close || '?'}`;
    return el('tr', {},
      el('td', {}, n),
      el('td', {}, open),
    );
  });
  return el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Day'), el('th', {}, 'Hours'))),
    el('tbody', {}, ...rows),
  );
}

function renderTracks(track_ids) {
  if (!Array.isArray(track_ids) || track_ids.length === 0) {
    return el('div', { class: 'track-list' }, '(no track_ids stored)');
  }
  return el('div', { class: 'track-list' },
    ...track_ids.map((id) => el('code', {}, id)),
  );
}

function renderPlaylistCard(p) {
  const expired = p.expires_at && new Date(p.expires_at) < new Date();
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {},
        p.ico || '🎵', ' ', p.label || '(unnamed)',
        expired
          ? el('span', { class: 'pill warn', style: 'margin-left:10px' }, 'expired')
          : el('span', { class: 'pill good', style: 'margin-left:10px' }, 'live'),
      ),
      el('span', { class: 'meta' },
        el('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'open on Spotify ↗'),
      ),
    ),
    renderKV([
      ['Spotify ID',   p.spotify_id,                    { mono: true }],
      ['Track count',  p.track_count == null ? '—' : String(p.track_count)],
      ['Genres',       Array.isArray(p.genres) ? p.genres.join(', ') : '—'],
      ['Direction ID', p.direction_id || '—',           { mono: !!p.direction_id }],
      ['Event ID',     p.event_id     || '—',           { mono: !!p.event_id }],
      ['Created',      fmtDate(p.created_at)],
      ['Expires',      fmtDate(p.expires_at)],
      ['Expanded at',  fmtDate(p.expanded_at)],
    ]),
    el('details', { class: 'tracks' },
      el('summary', {},
        `Track IDs (${Array.isArray(p.track_ids) ? p.track_ids.length : 0})`),
      renderTracks(p.track_ids),
    ),
  );
}

async function renderDetail(id) {
  app.replaceChildren(
    renderAppbar(true),
    el('main', {},
      el('div', { class: 'back-row' }, el('a', { href: '#/' }, '← back to users')),
      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'Loading…'),
          el('span', { class: 'meta' }, el('span', { class: 'spinner' })),
        ),
      ),
    ),
  );

  let data;
  try { data = await api(`/api/internal/business?id=${encodeURIComponent(id)}`); }
  catch (e) {
    if (e.authFailed) return renderLogin(e.message);
    return renderError(e.message);
  }

  const b = data.business || {};
  const o = data.onboarding || {};
  const p = data.place || {};
  const directions = data.directions || [];
  const playlists  = data.playlists  || [];

  const header = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, b.name || '(unnamed business)'),
      el('span', { class: 'meta' }, b.owner_email || '(no email)'),
    ),
    renderKV([
      ['Business ID',       b.id,                            { mono: true }],
      ['Owner ID',          b.owner_id,                      { mono: true }],
      ['Owner email',       b.owner_email],
      ['Created',           fmtDate(b.created_at)],
      ['Onboarding expanded', b.onboarding_expanded ? 'yes' : 'no'],
      ['Credits (remaining / monthly)', `${b.credits_remaining ?? '—'} / ${b.monthly_credits ?? '—'}`],
    ]),
  );

  const onboarding = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Onboarding prompt inputs')),
    renderKV([
      ['Business description', o.business_description],
      ['Musical emphases',     o.musical_emphases],
      ['Atmospheres',
        Array.isArray(o.atmospheres) && o.atmospheres.length
          ? el('div', {}, ...o.atmospheres.map((a) =>
              el('span', { class: 'pill', style: 'margin:0 6px 4px 0' }, a)))
          : '—',
      ],
    ]),
  );

  const placeCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Google Places')),
    data.place
      ? renderKV([
          ['Name',              p.name],
          ['Address',           p.address],
          ['Place ID',          p.place_id, { mono: true }],
          ['Primary type',      p.primary_type],
          ['Types',             Array.isArray(p.types) ? p.types.join(', ') : '—'],
          ['Editorial summary', p.editorial_summary],
          ['Price level',       p.price_level],
          ['Website',           p.website_uri
            ? el('a', { href: p.website_uri, target: '_blank', rel: 'noopener' }, p.website_uri)
            : '—'],
        ])
      : el('div', { class: 'empty' }, 'No Places lookup was captured for this business.'),
  );

  const hoursCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Opening hours'),
      el('span', { class: 'meta' },
        data.hours?.longest_minutes
          ? `Longest open window: ${data.hours.longest_minutes} min`
          : ''),
    ),
    renderHours(data.hours),
  );

  const directionsCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Musical directions'),
      el('span', { class: 'meta' }, `${directions.length} rows`),
    ),
    directions.length === 0
      ? el('div', { class: 'empty' }, 'No directions saved for this business.')
      : el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, '#'),
            el('th', {}, 'Title'),
            el('th', {}, 'Genres'),
            el('th', {}, 'BPM'),
            el('th', {}, 'Instrumentalness'),
            el('th', {}, 'Active'),
          )),
          el('tbody', {}, ...directions.map((d) => el('tr', {},
            el('td', {}, d.rank ?? '—'),
            el('td', {}, d.title_en || '—'),
            el('td', {}, Array.isArray(d.genres) ? d.genres.join(', ') : '—'),
            el('td', {}, d.bpm_range
              ? `${d.bpm_range.min ?? '?'}–${d.bpm_range.max ?? '?'}`
              : '—'),
            el('td', {}, d.instrumentalness_preference || 'none'),
            el('td', {}, d.active ? '✓' : '—'),
          ))),
        ),
  );

  const playlistsHeader = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Playlists'),
      el('span', { class: 'meta' }, `${playlists.length} rows (live + expired)`),
    ),
    playlists.length === 0
      ? el('div', { class: 'empty' }, 'No playlists on record.')
      : null,
  );

  const playlistCards = playlists.map(renderPlaylistCard);

  app.replaceChildren(
    renderAppbar(true),
    el('main', {},
      el('div', { class: 'back-row' }, el('a', { href: '#/' }, '← back to users')),
      header,
      onboarding,
      placeCard,
      hoursCard,
      directionsCard,
      playlistsHeader,
      ...playlistCards,
    ),
  );
}

function renderError(msg) {
  app.replaceChildren(
    renderAppbar(true),
    el('main', {},
      el('div', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Error')),
        el('div', { class: 'empty' }, msg || 'Something went wrong.'),
      ),
    ),
  );
}

// ---------- router ----------
function route() {
  if (!getKey()) return renderLogin();
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/business\/([0-9a-f-]{36})$/i);
  if (m) return renderDetail(m[1]);
  return renderList();
}

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', route);
