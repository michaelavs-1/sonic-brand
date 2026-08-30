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
      ? el('div', { style: 'display:flex;gap:10px;align-items:center' },
          el('a', { href: '#/',      style: 'color:var(--text-dim)' }, 'Users'),
          el('a', { href: '#/spend', style: 'color:var(--text-dim)' }, 'Gemini spend'),
          el('button', {
            class: 'ghost',
            onclick: () => { clearKey(); location.hash = '#/'; route(); },
          }, 'Sign out'),
        )
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
  const directions       = data.directions         || [];
  const playlists        = data.playlists          || [];
  const directionChanges = data.direction_changes  || [];
  const chatTranscript   = data.chat_transcript    || [];
  const geminiSpend      = data.gemini_spend       || { total_usd: 0, call_count: 0, by_label: [] };
  const geminiCalls      = data.gemini_calls       || [];
  const opens            = data.playlist_opens     || [];
  const opensSummary     = data.playlist_opens_summary || { total: 0, by_playlist: [], by_source: [] };

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

  // Build lookup so change rows can show the direction's current title
  // instead of just a bare UUID.
  const directionById = new Map(directions.map((d) => [d.id, d]));

  const changesCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Direction-edit changes'),
      el('span', { class: 'meta' }, `${directionChanges.length} rows (newest first)`),
    ),
    directionChanges.length === 0
      ? el('div', { class: 'empty' }, 'Owner has not edited directions via the chat.')
      : el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'When'),
            el('th', {}, 'Kind'),
            el('th', {}, 'Direction'),
            el('th', {}, 'Playlist'),
            el('th', {}, 'Snapshot'),
          )),
          el('tbody', {}, ...directionChanges.map(renderChangeRow.bind(null, directionById))),
        ),
  );

  const chatCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Direction-edit chat transcript'),
      el('span', { class: 'meta' }, `${chatTranscript.length} messages`),
    ),
    chatTranscript.length === 0
      ? el('div', { class: 'empty' }, 'No chat transcript for this business.')
      : renderChatTranscript(chatTranscript, directionById),
  );

  const geminiCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Gemini spend'),
      el('span', { class: 'meta' },
        `${fmtUsd(geminiSpend.total_usd)} · ${geminiSpend.call_count} calls`),
    ),
    geminiCalls.length === 0
      ? el('div', { class: 'empty' }, 'No Gemini calls attributed to this business.')
      : el('div', {},
          (geminiSpend.by_label && geminiSpend.by_label.length
            ? el('table', {},
                el('thead', {}, el('tr', {},
                  el('th', {}, 'Label'),
                  el('th', {}, 'Spend'),
                  el('th', {}, 'Calls'),
                )),
                el('tbody', {}, ...geminiSpend.by_label.map((l) => el('tr', {},
                  el('td', {}, l.label),
                  el('td', {}, fmtUsd(l.usd)),
                  el('td', {}, String(l.calls)),
                ))),
              )
            : null),
          el('details', { class: 'tracks' },
            el('summary', {}, `Individual calls (${geminiCalls.length})`),
            el('div', { style: 'padding:0 14px 14px' },
              el('table', {},
                el('thead', {}, el('tr', {},
                  el('th', {}, 'When'),
                  el('th', {}, 'Label'),
                  el('th', {}, 'Tokens (in / out / think)'),
                  el('th', {}, 'Cost'),
                )),
                el('tbody', {}, ...geminiCalls.map((c) => el('tr', {},
                  el('td', {}, fmtDate(c.created_at)),
                  el('td', {}, c.label || '(unlabeled)'),
                  el('td', {}, `${c.input_tokens ?? '?'} / ${c.output_tokens ?? '?'} / ${c.thinking_tokens ?? 0}`),
                  el('td', {}, fmtUsd(c.cost_usd)),
                ))),
              ),
            ),
          ),
        ),
  );

  // Build a spotify_id → playlist lookup so open rows can display the
  // playlist's label instead of a bare Spotify ID.
  const playlistById = new Map(playlists.map((p) => [p.spotify_id, p]));

  const opensCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Playlist opens'),
      el('span', { class: 'meta' }, `${opensSummary.total} clicks total`),
    ),
    opens.length === 0
      ? el('div', { class: 'empty' }, 'No playlist-open clicks logged yet.')
      : el('div', {},
          // Per-source breakdown
          opensSummary.by_source.length > 0
            ? el('table', {},
                el('thead', {}, el('tr', {},
                  el('th', {}, 'Source'),
                  el('th', {}, 'Clicks'),
                )),
                el('tbody', {}, ...opensSummary.by_source.map((s) => el('tr', {},
                  el('td', {}, s.source),
                  el('td', {}, String(s.count)),
                ))),
              )
            : null,
          // Per-playlist breakdown (top playlists by open count)
          el('details', { class: 'tracks', open: true },
            el('summary', {}, `By playlist (${opensSummary.by_playlist.length})`),
            el('div', { style: 'padding:0 14px 14px' },
              el('table', {},
                el('thead', {}, el('tr', {},
                  el('th', {}, 'Playlist'),
                  el('th', {}, 'Clicks'),
                  el('th', {}, 'Last opened'),
                )),
                el('tbody', {}, ...opensSummary.by_playlist.map((b) => {
                  const p = playlistById.get(b.spotify_id);
                  return el('tr', {},
                    el('td', {},
                      p?.url
                        ? el('a', { href: p.url, target: '_blank', rel: 'noopener' },
                            p.label || b.spotify_id)
                        : (p?.label || b.spotify_id)),
                    el('td', {}, String(b.count)),
                    el('td', {}, fmtDate(b.last_opened_at)),
                  );
                })),
              ),
            ),
          ),
          // Raw log
          el('details', { class: 'tracks' },
            el('summary', {}, `Individual clicks (${opens.length})`),
            el('div', { style: 'padding:0 14px 14px' },
              el('table', {},
                el('thead', {}, el('tr', {},
                  el('th', {}, 'When'),
                  el('th', {}, 'Source'),
                  el('th', {}, 'Playlist'),
                )),
                el('tbody', {}, ...opens.map((o) => {
                  const p = playlistById.get(o.spotify_id);
                  return el('tr', {},
                    el('td', {}, fmtDate(o.opened_at)),
                    el('td', {}, o.source || '—'),
                    el('td', {}, p?.label || o.spotify_id),
                  );
                })),
              ),
            ),
          ),
        ),
  );

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
      changesCard,
      chatCard,
      geminiCard,
      opensCard,
    ),
  );
}

function kindPill(kind) {
  const cls = kind === 'add' ? 'good' : kind === 'remove' ? 'warn' : '';
  return el('span', { class: `pill ${cls}` }, kind || '?');
}

function directionLabel(directionById, dirId) {
  if (!dirId) return '—';
  const d = directionById.get(dirId);
  if (d) return d.title_en || `(${dirId.slice(0, 8)}…)`;
  return `(${dirId.slice(0, 8)}…)`;
}

function renderChangeRow(directionById, c) {
  const jsonBlock = (obj) => obj
    ? el('pre', { class: 'dump' }, JSON.stringify(obj, null, 2))
    : el('div', { class: 'empty', style: 'padding:10px' }, '(none)');
  return el('tr', {},
    el('td', {}, fmtDate(c.applied_at)),
    el('td', {}, kindPill(c.kind)),
    el('td', {}, directionLabel(directionById, c.direction_id)),
    el('td', {}, c.playlist_action
      ? el('span', { class: 'pill' }, c.playlist_action)
      : el('span', { class: 'pill dim' }, '—')),
    el('td', {},
      el('details', {},
        el('summary', { style: 'cursor:pointer;color:var(--text-dim)' }, 'before / after'),
        el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px' },
          el('div', {}, el('div', { class: 'k', style: 'padding:4px 0' }, 'before'), jsonBlock(c.before)),
          el('div', {}, el('div', { class: 'k', style: 'padding:4px 0' }, 'after'),  jsonBlock(c.after)),
        ),
      ),
    ),
  );
}

function renderChatTranscript(messages, directionById) {
  const wrap = el('div', {
    style: 'display:flex;flex-direction:column;gap:10px;padding:14px 18px;max-height:600px;overflow-y:auto',
  });
  for (const m of messages) {
    const isUser = m.role === 'user';
    const align = isUser ? 'flex-end' : 'flex-start';
    const bg = isUser ? 'var(--accent-dim)' : 'var(--panel-2)';
    const border = isUser ? '1px solid #4a2a1a' : '1px solid var(--border)';

    const meta = el('div', {
      style: 'font-size:11px;color:var(--text-dim);margin-bottom:4px',
    }, `${m.role} · ${fmtDate(m.created_at)}`
       + (m.selected_direction_id
         ? ` · targeting ${directionLabel(directionById, m.selected_direction_id)}`
         : ''));

    const content = el('div', {
      style: `background:${bg};border:${border};border-radius:8px;padding:10px 12px;`
           + 'max-width:70%;white-space:pre-wrap;word-break:break-word;font-size:13px',
    }, m.content || '(empty)');

    const bubbleChildren = [meta, content];
    if (m.proposal) {
      bubbleChildren.push(
        el('details', { style: 'margin-top:6px;max-width:70%' },
          el('summary', { style: 'cursor:pointer;color:var(--text-dim);font-size:11px' },
            `proposal (${m.proposal.kind || 'unknown'})`),
          el('pre', { class: 'dump', style: 'margin-top:6px' },
            JSON.stringify(m.proposal, null, 2)),
        ),
      );
    }

    wrap.append(el('div', {
      style: `display:flex;flex-direction:column;align-items:${align}`,
    }, ...bubbleChildren));
  }
  return wrap;
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

// ---------- gemini spend view ----------
function fmtUsd(n) {
  const v = Number(n) || 0;
  // Small totals display more precision so tiny values don't collapse to $0.00.
  if (v < 0.01) return '$' + v.toFixed(6);
  return '$' + v.toFixed(4);
}

async function renderSpend() {
  app.replaceChildren(
    renderAppbar(true),
    el('main', {},
      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'Gemini spend'),
          el('span', { class: 'meta' }, el('span', { class: 'spinner' }), ' loading…'),
        ),
      ),
    ),
  );

  let data;
  try { data = await api('/api/internal/gemini-spend'); }
  catch (e) {
    if (e.authFailed) return renderLogin(e.message);
    return renderError(e.message);
  }

  const t = data.totals || {};
  const totalsCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Totals')),
    renderKV([
      ['All-time spend',           fmtUsd(t.all_time_usd)],
      ['Pre-logging baseline',     `${fmtUsd(t.baseline_usd)} (from Google Cloud Billing pre-2026-08-25)`],
      ['Since logging started',    `${fmtUsd(t.since_logging_usd)} · ${t.all_time_calls ?? 0} calls`],
      ['Attributed to a business', `${fmtUsd(t.attributed_usd)} · ${t.attributed_calls ?? 0} calls`],
      ['Abandoned onboarding',     `${fmtUsd(t.abandoned_usd)} · ${t.abandoned_calls ?? 0} calls`],
    ]),
  );

  const byDay = Array.isArray(data.by_day) ? data.by_day : [];
  const dayCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'By day'),
      el('span', { class: 'meta' }, `${byDay.length} days (newest first)`),
    ),
    byDay.length === 0
      ? el('div', { class: 'empty' }, 'No calls logged yet.')
      : el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Day (UTC)'),
            el('th', {}, 'Spend'),
            el('th', {}, 'Calls'),
          )),
          el('tbody', {}, ...byDay.map((d) => el('tr', {},
            el('td', {}, d.day),
            el('td', {}, fmtUsd(d.usd)),
            el('td', {}, String(d.calls)),
          ))),
        ),
  );

  const byLabel = Array.isArray(data.by_label) ? data.by_label : [];
  const labelCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'By label'),
      el('span', { class: 'meta' }, `${byLabel.length} labels`),
    ),
    byLabel.length === 0
      ? el('div', { class: 'empty' }, '—')
      : el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Label'),
            el('th', {}, 'Spend'),
            el('th', {}, 'Calls'),
          )),
          el('tbody', {}, ...byLabel.map((l) => el('tr', {},
            el('td', {}, l.label),
            el('td', {}, fmtUsd(l.usd)),
            el('td', {}, String(l.calls)),
          ))),
        ),
  );

  const byBusiness = Array.isArray(data.by_business) ? data.by_business : [];
  const businessCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'By business'),
      el('span', { class: 'meta' }, `${byBusiness.length} businesses (attributed calls only)`),
    ),
    byBusiness.length === 0
      ? el('div', { class: 'empty' }, 'No attributed spend yet.')
      : el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Owner email'),
            el('th', {}, 'Business name'),
            el('th', {}, 'Spend'),
            el('th', {}, 'Calls'),
            el('th', {}, ''),
          )),
          el('tbody', {}, ...byBusiness.map((b) => el('tr', {},
            el('td', {}, b.owner_email
              ? el('a', { href: `#/business/${b.business_id}` }, b.owner_email)
              : el('span', { class: 'pill warn' }, '(no email)')),
            el('td', {}, b.business_name || el('span', { class: 'pill dim' }, '(unnamed)')),
            el('td', {}, fmtUsd(b.usd)),
            el('td', {}, String(b.calls)),
            el('td', {}, el('a', { href: `#/business/${b.business_id}` }, 'view →')),
          ))),
        ),
  );

  const recent = Array.isArray(data.recent) ? data.recent : [];
  const recentCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Recent calls'),
      el('span', { class: 'meta' }, `last ${recent.length}`),
    ),
    recent.length === 0
      ? el('div', { class: 'empty' }, '—')
      : el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'When'),
            el('th', {}, 'Label'),
            el('th', {}, 'Model'),
            el('th', {}, 'Tokens (in / out / think)'),
            el('th', {}, 'Cost'),
            el('th', {}, 'Attribution'),
          )),
          el('tbody', {}, ...recent.map((r) => el('tr', {},
            el('td', {}, fmtDate(r.created_at)),
            el('td', {}, r.label || '(unlabeled)'),
            el('td', {}, r.model),
            el('td', {}, `${r.input_tokens ?? '?'} / ${r.output_tokens ?? '?'} / ${r.thinking_tokens ?? 0}`),
            el('td', {}, fmtUsd(r.cost_usd)),
            el('td', {}, r.business_id
              ? el('a', { href: `#/business/${r.business_id}` }, `biz ${r.business_id.slice(0, 8)}…`)
              : r.onboarding_session_id
                ? el('span', { class: 'pill dim' }, 'onboarding (abandoned)')
                : el('span', { class: 'pill dim' }, '—')),
          ))),
        ),
  );

  app.replaceChildren(
    renderAppbar(true),
    el('main', {},
      totalsCard,
      dayCard,
      labelCard,
      businessCard,
      recentCard,
    ),
  );
}

// ---------- router ----------
function route() {
  if (!getKey()) return renderLogin();
  const hash = location.hash || '#/';
  if (hash === '#/spend' || hash === '#/spend/') return renderSpend();
  const m = hash.match(/^#\/business\/([0-9a-f-]{36})$/i);
  if (m) return renderDetail(m[1]);
  return renderList();
}

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', route);
