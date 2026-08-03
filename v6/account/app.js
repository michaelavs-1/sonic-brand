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
import { computeTargetForToday } from '../generation/playlist-length.js?v=02082026a';

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
  if (event === 'SIGNED_OUT') {
    if (loggingOut) return; // logout button handles its own navigation
    show('loginView');
    return;
  }
  if (event === 'SIGNED_IN' && session) {
    setTimeout(() => { if (!business && !entering) enterDashboard(); }, 0);
  }
});

// ---------- login (magic link) ----------
// Supabase enforces a per-address rate limit (~60s) between OTP sends. We
// mirror that on the client with a countdown so users can't just spam the
// button — and once they've sent one, the UI switches to a "resend / change
// address" panel instead of leaving them staring at the same form.
const RESEND_COOLDOWN_SEC = 60;
let resendTimerId = null;
let pendingEmail = '';

async function sendMagicLink(email, { isResend = false } = {}) {
  const btn = isResend ? $('resendLink') : $('sendLink');
  const spinner = isResend ? $('resendSpinner') : $('sendSpinner');
  btn.disabled = true;
  spinner?.classList.remove('hide');
  $('loginMsg').textContent = '';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + '/v6/account' },
  });
  spinner?.classList.add('hide');
  if (error) {
    btn.disabled = false;
    $('loginMsg').textContent = 'שגיאה: ' + error.message;
    return false;
  }
  pendingEmail = email;
  showResendPanel(email);
  startResendCooldown();
  if (isResend) flashResendConfirm();
  return true;
}

function showResendPanel(email) {
  $('sentToEmail').textContent = email;
  $('emailForm').classList.add('hide');
  $('resendRow').classList.remove('hide');
  $('loginMsg').textContent = '';
}

function showEmailForm() {
  if (resendTimerId) { clearInterval(resendTimerId); resendTimerId = null; }
  $('resendRow').classList.add('hide');
  $('emailForm').classList.remove('hide');
  $('sendLink').disabled = false;
  $('loginMsg').textContent = '';
  $('email').focus();
}

function startResendCooldown() {
  const btn = $('resendLink');
  const baseLabel = 'שלחו לי קישור חדש';
  let left = RESEND_COOLDOWN_SEC;
  const tick = () => {
    if (left <= 0) {
      btn.disabled = false;
      btn.textContent = baseLabel;
      clearInterval(resendTimerId);
      resendTimerId = null;
      return;
    }
    btn.disabled = true;
    btn.textContent = `${baseLabel} (${left})`;
    left--;
  };
  if (resendTimerId) clearInterval(resendTimerId);
  tick();
  resendTimerId = setInterval(tick, 1000);
}

function flashResendConfirm() {
  const msg = $('loginMsg');
  msg.textContent = 'נשלח שוב ✉️';
  setTimeout(() => { if (msg.textContent === 'נשלח שוב ✉️') msg.textContent = ''; }, 4000);
}

// Bind on the form so Enter inside the email input submits (native <form>
// behavior) — not just mouse clicks on the button. Prevent default to avoid a
// page reload; sendMagicLink handles the rest.
$('emailForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  if (!email) { $('loginMsg').textContent = 'הכניסו אימייל'; return; }
  await sendMagicLink(email);
});

$('resendLink')?.addEventListener('click', async () => {
  if (!pendingEmail) return;
  await sendMagicLink(pendingEmail, { isResend: true });
});

$('changeEmail')?.addEventListener('click', () => {
  pendingEmail = '';
  showEmailForm();
});

// Logout: swallow the SIGNED_OUT event so we don't briefly flash the loginView
// on this page, then hop back to /v6 with ?intro=1 (which tells that page to
// skip the splash + entrance animation and land on the "have an account?" card
// straight away).
let loggingOut = false;
$('logout')?.addEventListener('click', async () => {
  loggingOut = true;
  try { await sb.auth.signOut(); } catch { /* proceed regardless */ }
  window.location.replace('/v6?intro=1');
});

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
  renderPlaylistsTitle();
  renderPlaylists();
  renderEvents();
}

// Title above the playlists box. Two variants:
//   Normal (open day OR closed day with playlists for today):
//     "🎵 הפלייליסטים היומיים שלכם - יום א' - dd/mm/yy"
//   Closed day, no playlists for today:
//     "🎵 יום ש' - המקום סגור   [המקום פתוח?]"   ← link opens the generate popup
function renderPlaylistsTitle() {
  const h = $('playlistsTitle');
  if (!h) return;
  h.replaceChildren();

  const ico = document.createElement('span');
  ico.className   = 'h-ico';
  ico.textContent = '🎵';
  h.append(ico);

  const dayLetter = HE_DAY_LETTERS[todayDayIdx()];
  const dateStr   = todayDdMmYy();

  if (todayIsClosed() && !hasPlaylistsForToday()) {
    h.append(document.createTextNode(`יום ${dayLetter}' - המקום סגור`));
    const openLink = document.createElement('a');
    openLink.href        = '#';
    openLink.className   = 'closed-open-link';
    openLink.textContent = 'המקום פתוח?';
    openLink.addEventListener('click', (e) => {
      e.preventDefault();
      openGenerateDailyModal();
    });
    h.append(openLink);
  } else {
    h.append(document.createTextNode(`הפלייליסטים היומיים שלכם - יום ${dayLetter}' - ${dateStr}`));
  }
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
// Target length for daily playlists = today's open hours + 1h buffer. The
// onboarding builds each playlist to a 10-track sample up front; the
// dashboard's background expansion grows each one to that per-day target
// after the user lands here. If today is closed (onboarding-day-is-closed
// case), computeTargetForToday falls back to 12h + 1h.
function dayTargetTracks() {
  return computeTargetForToday({ hours: bmeta().hours });
}

// --- title / closed-day helpers ---
const HE_DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

function todayDayIdx() { return new Date().getDay(); }

function todayDdMmYy() {
  const d  = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// Today's closed status from the persisted hours object. `null` means we
// have no hours data at all (treat as open — better to render playlists than
// to gate the user out).
function todayIsClosed() {
  const h = bmeta().hours || {};
  const t = h[todayDayIdx()];
  if (!t) return false;
  return !!t.closed;
}

// "Playlists exist for today" — checked via createdAt (YYYY-MM-DD). Used to
// tell apart the onboarding day (playlists were just created → normal title)
// from a later closed-day visit (no playlists → show the closed prompt).
// Only LIVE playlists (not past their expiresAt) count.
function isoDateToday() { return new Date().toISOString().slice(0, 10); }
function hasPlaylistsForToday() {
  const today = isoDateToday();
  return (bmeta().playlists || []).some((p) => p && p.createdAt === today && playlistIsLive(p));
}

// Shared expiry gate for daily playlists AND event playlists. Missing
// expiresAt = "no expiry recorded" → treat as live (backward compat for
// entries written before per-day expiry existed; the ledger cron will
// still unfollow them at their old 24h TTL).
function playlistIsLive(p) {
  return !!p && (!p.expiresAt || p.expiresAt > Date.now());
}

function renderPlaylists() {
  const wrap = $('slotsWrap');
  wrap.innerHTML = '';
  const playlists = (bmeta().playlists || []).filter(playlistIsLive);
  if (!playlists.length) {
    wrap.innerHTML = '<p class="muted">עדיין לא נוצרו פלייליסטים.</p>';
    return;
  }
  const target = dayTargetTracks();
  for (const p of playlists) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.dataset.playlistId = p.id || '';
    const genresLine = p.genres?.length
      ? `<div class="pl-explain" style="padding:8px 0 0;font-size:12px">🎨 מורכב מהסגנונות: ${p.genres.slice(0, 6).join(' · ')}</div>`
      : '';
    const showBar = playlistIsExpanding(p, target);
    const barHtml = showBar
      ? `<div class="pl-expand-bar" data-target="${target}" data-current="${p.trackCount || 0}"><div class="pl-expand-fill"></div></div>`
      : '';
    const spinnerHtml = showBar ? '<span class="pl-inline-spinner" aria-label="בונים"></span>' : '';
    row.innerHTML =
      `<div class="s-info">` +
        `<div class="s-title">${p.ico || '🎵'} ${p.label || 'פלייליסט'}</div>` +
        `<div class="s-meta"><span class="pl-count">${p.trackCount || 0}</span> שירים${spinnerHtml}${p.createdAt ? ` · נבנה ${p.createdAt}` : ''}</div>` +
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
// playlist that still needs expanding. Two conditions:
//   1. Business-level `onboardingExpanded` flag is NOT set — the expansion
//      is a strict one-time-per-business event (set at the start of the
//      first expansion pass and never cleared). If the flag is set, we
//      never show a bar or trigger expansion again, regardless of what any
//      individual playlist's expandedAt looks like.
//   2. This specific playlist has expansion metadata (direction spec) and
//      hasn't been individually expanded yet, and is below target.
function playlistIsExpanding(p, target) {
  if (bmeta().onboardingExpanded) return false;
  const t = target ?? dayTargetTracks();
  return !!p && !!p.expansion?.direction && !p.expandedAt && (p.trackCount || 0) < t;
}

function updateExpandBar(row, current) {
  const bar = row.querySelector('.pl-expand-bar');
  if (!bar) return;
  const target = Number(bar.dataset.target) || dayTargetTracks();
  const fill   = bar.querySelector('.pl-expand-fill');
  if (fill) fill.style.width = Math.min(100, Math.round((current / target) * 100)) + '%';
}

function updateCountInRow(row, count) {
  const countEl = row.querySelector('.pl-count');
  if (countEl) countEl.textContent = String(count);
  updateExpandBar(row, count);
}

// Expansion is a STRICT one-time-per-business event. It runs on the very
// first dashboard visit after onboarding: the 10-track sample playlists
// each grow to today's opening hours + 1h buffer (or 12h if today is
// closed). After that first pass, it must never run again — the daily-gen
// mechanism (a separate future task) handles fresh playlists on subsequent
// days.
//
// Enforcement:
//   - Business-level `onboardingExpanded` flag guards re-entry. Set BEFORE
//     any expansion starts so a mid-pass tab close / refresh / crash never
//     causes a second pass.
//   - Expansions still run sequentially (Σ times, not max()) so each
//     per-playlist expand-playlist call reads-writes user_metadata cleanly.
//     A parallel Promise.all previously caused a last-writer-wins race
//     that clobbered sibling expandedAt fields.
async function expandPendingPlaylists() {
  const b = bmeta();
  if (b.onboardingExpanded) return;

  const playlists = b.playlists || [];
  const target    = dayTargetTracks();
  const pending   = playlists.filter((p) => playlistIsExpanding(p, target));

  // Even if nothing to expand (pre-flag user with all playlists already
  // expandedAt), still stamp the flag so we short-circuit next load.
  if (!pending.length) {
    await saveB({ onboardingExpanded: true });
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) return;

  // Set the flag NOW — before we do any expansion work. This is the
  // durable "we've done this" guarantee. If the tab closes mid-way, some
  // playlists may end up under-populated, but nothing will re-populate
  // them. That is intentional per the product spec.
  await saveB({ onboardingExpanded: true });

  for (const p of pending) {
    await expandOne(p, session.access_token, target);
  }

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

async function expandOne(playlist, token, target) {
  const targetCount = target ?? dayTargetTracks();
  const row = document.querySelector(`#slotsWrap .slot[data-playlist-id="${cssEscape(playlist.id)}"]`);
  // Belt-and-suspenders spinner cleanup: any exit path (success, stream
  // reports done, HTTP error, exception) must clear the inline spinner
  // so it never keeps spinning on a stalled row.
  const clearSpinner = () => {
    if (!row) return;
    const s = row.querySelector('.pl-inline-spinner');
    if (s) s.remove();
  };
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
        targetCount,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn(`expand-playlist ${playlist.id} failed:`, err?.error || r.statusText);
      clearSpinner();
      return;
    }
    if (!r.body) { clearSpinner(); return; }   // fallback for browsers without ReadableStream
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
            const spinner = row.querySelector('.pl-inline-spinner');
            if (spinner) spinner.remove();
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
    clearSpinner();
  }
}

// ---------- closed-day → generate daily playlists ----------
// Shown when today is a closed day AND no playlists were created for today
// yet. Confirms with the user, then hits /api/v6/account/generate-daily
// which reuses the last direction set to build fresh 12h playlists.

function openGenerateDailyModal() {
  const modal = $('genDailyModal');
  if (!modal) return;
  modal.classList.remove('hide');
}

function closeGenerateDailyModal() {
  const modal = $('genDailyModal');
  if (!modal) return;
  modal.classList.add('hide');
  // Reset button state in case a prior attempt left it disabled.
  const btn = $('genDailyConfirm');
  if (btn) { btn.disabled = false; btn.textContent = 'צור פלייליסטים יומיים'; }
}

async function runGenerateDaily() {
  const btn = $('genDailyConfirm');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>בונים…';
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v6/account/generate-daily', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        businessId: business.id,
        bizName:    business.name || '',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
    // Server already wrote to user_metadata — refresh the local mirror and
    // re-render the dashboard so the new playlists appear and the title
    // flips back to normal ("playlists for today exist").
    const { data: refreshed } = await sb.auth.getUser();
    meta = (refreshed?.user?.user_metadata?.sonic) || meta;
    closeGenerateDailyModal();
    renderPlaylistsTitle();
    renderPlaylists();
    toast(`נבנו ${data.count || 0} פלייליסטים ✓`);
  } catch (err) {
    console.error('generate-daily failed:', err);
    toast(String(err.message || 'משהו השתבש — נסו שוב').slice(0, 120));
    btn.disabled = false;
    btn.textContent = 'צור פלייליסטים יומיים';
  }
}

$('genDailyConfirm')?.addEventListener('click', runGenerateDaily);
$('genDailyCancel') ?.addEventListener('click', closeGenerateDailyModal);
$('genDailyModal')  ?.addEventListener('click', (e) => {
  // Click on backdrop (the modal wrapper itself) closes.
  if (e.target?.id === 'genDailyModal') closeGenerateDailyModal();
});

// CSS.escape polyfill for safety with unusual Spotify IDs (they're alphanumeric
// so this is just defensive — but cheap).
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/[^\w-]/g, '\\$&');
}

// ---------- special events ----------
// Look up an event's live (unexpired) playlist by cross-referencing the
// event's id against bmeta().playlists[i].eventId. Shares the expiry gate
// with daily playlists via playlistIsLive.
function activePlaylistForEvent(eventId) {
  return (bmeta().playlists || []).find((p) => p && p.eventId === eventId && playlistIsLive(p)) || null;
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
