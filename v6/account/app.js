// v6 account dashboard.
//
// Trimmed from Michael's v4 dashboard: only Home tab (playlists + special
// events). No profile, no music, no plan, no chat, no mic. Playlists come
// from onboarding (stored in user_metadata.sonic.b[bizId].playlists) — no
// day-hours slot generation.
//
// Storage: user_metadata.sonic = {
//   onboarding: { atmospheres, place },     // carried from onboarding
//   currentBizId,
//   b: { [businessId]: {
//     playlists: [ { ico, label, url, id, trackCount, genres, createdAt } ],
//     events:    [ { id, name, description } ],
//   } }
// }

const SUPABASE_URL  = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

// ?reset=1 → clear any saved session so the account starts fresh.
if (new URLSearchParams(location.search).has('reset')) {
  Object.keys(localStorage).filter((k) => k.startsWith('sb-')).forEach((k) => localStorage.removeItem(k));
}

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $ = (id) => document.getElementById(id);
const show = (id) => { ['loginView', 'dashView', 'loading'].forEach((v) => $(v).classList.add('hide')); $(id).classList.remove('hide'); };

let businesses = [];
let business   = null;
let user       = null;
let meta       = {};

// Edit-mode marker for the events textarea. When set, the next save updates
// this event instead of appending a new one.
let editingEventId = null;

// ---------- per-business metadata helpers ----------
function bmeta() { return (meta.b && meta.b[business?.id]) || {}; }
async function saveB(patch) {
  const b = { ...(meta.b || {}) };
  b[business.id] = { ...(b[business.id] || {}), ...patch };
  return saveMeta({ b });
}
async function saveMeta(patch) {
  meta = { ...meta, ...patch };
  const { error } = await sb.auth.updateUser({ data: { sonic: meta } });
  if (error) { console.error('saveMeta:', error); toast('שגיאה בשמירה'); return false; }
  return true;
}

// ---------- boot ----------
(async function boot() {
  show('loading');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show('loginView'); return; }
  await enterDashboard();
})();

// Never call auth methods synchronously inside this callback — supabase-js
// holds an internal lock during it and updateUser() would deadlock.
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { show('loginView'); return; }
  if (event === 'SIGNED_IN' && session) {
    setTimeout(() => { if (!business && !entering) enterDashboard(); }, 0);
  }
});

// ---------- login (magic link fallback) ----------
$('emailToggle')?.addEventListener('click', () => {
  $('emailForm').classList.toggle('hide');
});

$('sendLink')?.addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) { $('loginMsg').textContent = 'הכניסו אימייל'; return; }
  $('sendLink').disabled = true;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + '/v6/account' },
  });
  $('sendLink').disabled = false;
  $('loginMsg').textContent = error ? ('שגיאה: ' + error.message) : 'שלחנו לכם קישור כניסה למייל ✉️';
});

$('logout')?.addEventListener('click', async () => { await sb.auth.signOut(); });

// ---------- dashboard ----------
let entering = false;
async function enterDashboard() {
  if (entering) return;
  entering = true;
  try { await enterDashboardInner(); }
  finally { entering = false; }
}

async function enterDashboardInner() {
  show('loading');
  const { data: { user: u } } = await sb.auth.getUser();
  if (!u) { show('loginView'); return; }
  user = u;
  meta = (u.user_metadata && u.user_metadata.sonic) || {};

  businesses = await loadBusinesses();
  if (!businesses.length) { show('loginView'); return; }
  const wanted = businesses.find((b) => b.id === meta.currentBizId);
  business = wanted || businesses[0];
  if (business.id !== meta.currentBizId) await saveMeta({ currentBizId: business.id });

  renderAll();
  show('dashView');

  // Background expansion of any onboarding playlists that are still at
  // sample size. The endpoint streams progress and updateCountInRow ticks
  // the count live. Fire-and-forget so the dashboard is interactive
  // immediately.
  expandPendingPlaylists().catch((e) => console.warn('expandPendingPlaylists:', e));
}

async function loadBusinesses() {
  const { data } = await sb.from('businesses').select('*').eq('owner_id', user.id).order('created_at', { ascending: true });
  return data || [];
}

function renderAll() {
  closeNameEdit();
  renderBusiness();
  renderPlaceBanner();
  renderPlaylists();
  renderEvents();
}

// ---------- greeting + business name ----------
function renderBusiness() {
  $('bizName').textContent = business.name || 'העסק שלי';
  const h = new Date().getHours();
  const hello = h < 5 ? 'לילה טוב' : h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : h < 22 ? 'ערב טוב' : 'לילה טוב';
  const g = $('greeting');
  if (g) g.textContent = `${hello} 👋`;
}

// ---------- Google Business photo banner ----------
function renderPlaceBanner() {
  const place  = (meta.onboarding || {}).place;
  const banner = $('placeBanner');
  if (!banner) return;
  if (place?.photo_url) {
    $('placeImg').src = place.photo_url;
    $('placeCap').textContent = `📍 ${place.name || business.name || ''}${place.address ? ' · ' + place.address : ''}`;
    banner.classList.remove('hide');
  } else {
    banner.classList.add('hide');
  }
}

// ---------- name editing ----------
$('editName')?.addEventListener('click', () => {
  $('nameInput').value = business.name || '';
  $('nameEdit').classList.remove('hide');
  $('nameInput').focus();
});
$('nameCancel')?.addEventListener('click', closeNameEdit);
$('nameSave')?.addEventListener('click', saveName);
$('nameInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
function closeNameEdit() { $('nameEdit')?.classList.add('hide'); }
async function saveName() {
  const name = $('nameInput').value.trim();
  if (!name) { toast('הכניסו שם לעסק'); return; }
  const { error } = await sb.from('businesses').update({ name }).eq('id', business.id);
  if (error) console.warn('name update blocked:', error.message);
  business.name = name;
  renderBusiness();
  closeNameEdit();
  toast('שם העסק עודכן ✓');
}

// ---------- playlists ----------
// Target length for daily playlists. ~120 tracks ≈ 7h at 3.5min/track avg —
// enough to cover a business day. Onboarding builds each playlist to
// TARGET_TRACKS (10) up front; the dashboard's background expansion grows
// each one to DAY_LENGTH_TRACKS after the user lands here.
const DAY_LENGTH_TRACKS = 120;

function renderPlaylists() {
  const wrap = $('slotsWrap');
  wrap.innerHTML = '';
  const playlists = bmeta().playlists || [];
  if (!playlists.length) {
    wrap.innerHTML = '<p class="muted">עדיין לא נוצרו פלייליסטים.</p>';
    return;
  }
  for (const p of playlists) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.dataset.playlistId = p.id || '';
    const genresLine = p.genres?.length
      ? `<div class="pl-explain" style="padding:8px 0 0;font-size:12px">🎨 מורכב מהסגנונות: ${p.genres.slice(0, 6).join(' · ')}</div>`
      : '';
    const showBar = playlistIsExpanding(p);
    const barHtml = showBar
      ? `<div class="pl-expand-bar" data-target="${DAY_LENGTH_TRACKS}" data-current="${p.trackCount || 0}"><div class="pl-expand-fill"></div></div>`
      : '';
    row.innerHTML =
      `<div class="s-info">` +
        `<div class="s-title">${p.ico || '🎵'} ${p.label || 'פלייליסט'}</div>` +
        `<div class="s-meta"><span class="pl-count">${p.trackCount || 0}</span> שירים${p.createdAt ? ` · נבנה ${p.createdAt}` : ''}</div>` +
        barHtml +
        genresLine +
      `</div>`;
    if (p.url) {
      const open = document.createElement('a');
      open.className = 'btn';
      open.style.textDecoration = 'none';
      open.href   = p.url;
      open.target = '_blank';
      open.rel    = 'noopener';
      open.textContent = '▶ פתח';
      row.append(open);
    }
    wrap.append(row);
    if (showBar) updateExpandBar(row, p.trackCount || 0);
  }
}

// A playlist should show the expansion progress bar when it's an onboarding
// playlist that still needs expanding — meaning it has expansion metadata
// (a direction spec) and hasn't been expanded yet.
function playlistIsExpanding(p) {
  return !!p && !!p.expansion?.direction && !p.expandedAt && (p.trackCount || 0) < DAY_LENGTH_TRACKS;
}

function updateExpandBar(row, current) {
  const bar = row.querySelector('.pl-expand-bar');
  if (!bar) return;
  const target = Number(bar.dataset.target) || DAY_LENGTH_TRACKS;
  const fill   = bar.querySelector('.pl-expand-fill');
  if (fill) fill.style.width = Math.min(100, Math.round((current / target) * 100)) + '%';
}

function updateCountInRow(row, count) {
  const countEl = row.querySelector('.pl-count');
  if (countEl) countEl.textContent = String(count);
  updateExpandBar(row, count);
}

// After renderAll, expand any playlist that still has < DAY_LENGTH_TRACKS
// tracks and carries an `expansion` field. Each playlist expands in
// parallel; the endpoint streams progress lines back and we tick the
// row's track count as each line arrives.
async function expandPendingPlaylists() {
  const playlists = bmeta().playlists || [];
  const pending   = playlists.filter(playlistIsExpanding);
  if (!pending.length) return;

  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) return;

  await Promise.all(pending.map((p) => expandOne(p, session.access_token)));

  // Refresh the local mirror so subsequent renders see the new counts +
  // expandedAt flags (server persisted them). This won't re-render — the
  // DOM is already up to date from the stream. Later navigations use this.
  try {
    const { data: refreshed } = await sb.auth.getUser();
    meta = (refreshed?.user?.user_metadata?.sonic) || meta;
    // Remove the progress bar from any rows that just finished so they
    // don't look "still working" on next render.
    document.querySelectorAll('#slotsWrap .slot').forEach((row) => {
      const bar = row.querySelector('.pl-expand-bar');
      if (bar && bar.classList.contains('done')) bar.remove();
    });
  } catch (e) { console.warn('post-expand metadata refresh failed:', e); }
}

async function expandOne(playlist, token) {
  const row = document.querySelector(`#slotsWrap .slot[data-playlist-id="${cssEscape(playlist.id)}"]`);
  try {
    const r = await fetch('/api/v6/account/expand-playlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${token}`,
      },
      body: JSON.stringify({
        businessId:  business.id,
        playlistId:  playlist.id,
        targetCount: DAY_LENGTH_TRACKS,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn(`expand-playlist ${playlist.id} failed:`, err?.error || r.statusText);
      return;
    }
    if (!r.body) return;   // fallback for browsers without ReadableStream
    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalCount = playlist.trackCount || 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.trackCount === 'number') {
            finalCount = msg.trackCount;
            if (row) updateCountInRow(row, msg.trackCount);
          }
          if (msg.done && row) {
            const bar = row.querySelector('.pl-expand-bar');
            if (bar) bar.classList.add('done');
          }
        } catch (e) {
          console.warn('expand-playlist: bad ndjson line', line);
        }
      }
    }
    // Fade the bar out shortly after completion so the row settles.
    if (row) {
      setTimeout(() => {
        const bar = row.querySelector('.pl-expand-bar');
        if (bar) {
          bar.style.transition = 'opacity .5s';
          bar.style.opacity    = '0';
          setTimeout(() => bar.remove(), 550);
        }
      }, 800);
    }
    return finalCount;
  } catch (err) {
    console.warn(`expand-playlist ${playlist.id} threw:`, err);
  }
}

// CSS.escape polyfill for safety with unusual Spotify IDs (they're alphanumeric
// so this is just defensive — but cheap).
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/[^\w-]/g, '\\$&');
}

// ---------- special events ----------
// Look up an event's live (unexpired) playlist by cross-referencing the
// event's id against bmeta().playlists[i].eventId.
function activePlaylistForEvent(eventId) {
  const playlists = bmeta().playlists || [];
  const now = Date.now();
  return playlists.find((p) => p.eventId === eventId && (!p.expiresAt || p.expiresAt > now)) || null;
}

function renderEvents() {
  const wrap = $('eventsWrap');
  wrap.innerHTML = '';
  const events = bmeta().events || [];
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'slot';

    const info = document.createElement('div');
    info.className = 's-info';
    info.innerHTML =
      `<div class="s-title">🎪 ${escapeHtml(ev.name || 'אירוע')}</div>` +
      `<div class="s-meta">${escapeHtml(truncate(ev.description || '', 90))}</div>`;
    row.append(info);

    const editBtn = document.createElement('button');
    editBtn.className   = 'btn-ghost';
    editBtn.title       = 'עריכה';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => startEditEvent(ev));
    row.append(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className   = 'btn-ghost';
    delBtn.title       = 'מחיקה';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => deleteEvent(ev.id));
    row.append(delBtn);

    const live = activePlaylistForEvent(ev.id);
    if (live) {
      // Playlist is still within its 24h window — offer to open it, no
      // create button. The button reappears once the playlist expires.
      const openA = document.createElement('a');
      openA.className    = 'btn';
      openA.style.textDecoration = 'none';
      openA.href         = live.url;
      openA.target       = '_blank';
      openA.rel          = 'noopener';
      openA.textContent  = '▶ פתח';
      row.append(openA);
    } else {
      const makeBtn = document.createElement('button');
      makeBtn.className   = 'btn';
      makeBtn.textContent = 'צרו פלייליסט';
      makeBtn.addEventListener('click', () => createEventPlaylist(ev, makeBtn));
      row.append(makeBtn);
    }

    wrap.append(row);
  }
}

async function createEventPlaylist(ev, btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>בונים…';
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v6/account/event-playlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        businessId:  business.id,
        eventId:     ev.id,
        eventName:   ev.name,
        description: ev.description,
        bizName:     business.name || '',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      throw new Error(data?.error || `שגיאה ${r.status}`);
    }
    // The endpoint already wrote the playlist into user_metadata. Refresh
    // the local mirror so renderPlaylists + renderEvents pick it up.
    const { data: refreshed } = await sb.auth.getUser();
    meta = (refreshed?.user?.user_metadata?.sonic) || meta;
    renderPlaylists();
    renderEvents();
    toast('הפלייליסט מוכן ✓');
    window.open(data.playlist.url, '_blank');
  } catch (err) {
    console.error('event-playlist failed:', err);
    toast(String(err.message || 'משהו השתבש — נסו שוב').slice(0, 120));
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function startEditEvent(ev) {
  editingEventId = ev.id;
  $('eventsText').value = ev.description || '';
  $('eventsText').focus();
  $('saveEvents').textContent = 'עדכן אירוע';
  $('eventsMsg').textContent = `עורכים: ${ev.name || 'אירוע'} — לחצו "עדכן" לשמירה`;
}

function endEditMode() {
  editingEventId = null;
  $('saveEvents').textContent = 'שמור אירוע';
  $('eventsMsg').textContent = '';
}

async function deleteEvent(id) {
  if (!confirm('למחוק את האירוע?')) return;
  const events = (bmeta().events || []).filter((e) => e.id !== id);
  const ok = await saveB({ events });
  if (ok) {
    if (editingEventId === id) endEditMode();
    renderEvents();
    toast('האירוע נמחק');
  }
}

$('saveEvents')?.addEventListener('click', async () => {
  const text = $('eventsText').value.trim();
  if (text.length < 5) { $('eventsMsg').textContent = 'כתבו לפחות משפט קצר'; return; }
  const name = firstLine(text, 40) || 'אירוע';
  const events = [...(bmeta().events || [])];
  if (editingEventId) {
    const idx = events.findIndex((e) => e.id === editingEventId);
    if (idx >= 0) events[idx] = { ...events[idx], name, description: text };
  } else {
    events.push({ id: (crypto.randomUUID?.() || String(Date.now())), name, description: text });
  }
  const ok = await saveB({ events });
  if (ok) {
    $('eventsText').value = '';
    endEditMode();
    renderEvents();
    toast('נשמר ✓');
  }
});

// ---------- toast ----------
function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; }, 2200);
}

// ---------- small utils ----------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
function firstLine(s, max) {
  const line = String(s).split('\n')[0].trim();
  return line.length <= max ? line : line.slice(0, max - 1) + '…';
}
