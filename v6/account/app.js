// v6 account dashboard.
//
// Trimmed from Michael's v4 dashboard: only Home tab (playlists + special
// events). No profile, no music, no plan, no chat, no mic.
//
// Storage: per-business data lives in Postgres tables (see the 2026-08-05
// migration). user_metadata.sonic keeps only { currentBizId, onboarding:
// { bizType, atmospheres } } — small identity flags. Data-loading fans out
// four parallel Supabase SELECTs on business_playlists / business_events /
// business_hours / business_place, cached on state.dashboard for the life
// of the page. RLS restricts each SELECT to rows for businesses owned by
// the caller. Writes go through server endpoints (upsert-event,
// delete-event, update-hours + the existing expand/event-playlist/
// generate-daily) so ownership can be enforced with the service role and
// row-level UPDATEs bypass user_metadata entirely.

const SUPABASE_URL  = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

// ?reset=1 → clear any saved session so the account starts fresh.
if (new URLSearchParams(location.search).has('reset')) {
  Object.keys(localStorage).filter((k) => k.startsWith('sb-')).forEach((k) => localStorage.removeItem(k));
}

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { computeTargetForToday } from '../generation/playlist-length.js?v=13082026a';
import { mountHoursEditor } from '../hours-selector.js?v=03082026a';
import { EVENT_CHAT_SYSTEM_PROMPT } from '../generation/event-chat-prompt.js?v=20082026c';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $ = (id) => document.getElementById(id);
const show = (id) => { ['loginView', 'dashView', 'loading'].forEach((v) => $(v).classList.add('hide')); $(id).classList.remove('hide'); };

let businesses = [];
let business   = null;
let user       = null;
let meta       = {};

// Per-business data loaded from tables and refreshed on writes. Shape:
//   { playlists, events, hours, longestMinutes, place }
// Field names are camelCase (mapped from snake_case Postgres columns) so
// the rest of the render / event-management code doesn't need to know
// where the data comes from.
const state = { dashboard: null };

// Chat state for the special-events panel. Ephemeral — cleared on refresh
// and on a successful finalize. `messages` holds the visible transcript
// (both roles) and doubles as the multi-turn history sent to Gemini.
// `proposed` is the last confirming-state summary Gemini offered; clicking
// the inline "צור פלייליסט" button uses it as-is (no extra round trip).
const chatState = {
  messages:  [],        // [{ role: 'user' | 'assistant', text: string }]
  proposed:  null,      // { name_he, description_he } | null
  busy:      false,     // true while a Gemini round trip is in flight
};

// ---------- per-business data accessor ----------
// Kept as a function so all render code can call `bmeta().playlists` etc.
// unchanged. If dashboard data hasn't loaded yet, returns an empty object
// so renders paint an empty state instead of crashing.
function bmeta() { return state.dashboard || {}; }

// Map a business_playlists row (snake_case columns) into the camelCase
// shape the render code (renderPlaylists, activePlaylistForEvent,
// playlistIsExpanding, playlistIsLive) already expects.
function playlistRowToClient(r) {
  return {
    id:         r.spotify_id,
    url:        r.url,
    label:      r.label,
    ico:        r.ico,
    trackCount: r.track_count,
    genres:     Array.isArray(r.genres) ? r.genres : [],
    bpmRange:   r.bpm_range || null,
    expansion:  r.expansion || null,
    eventId:    r.event_id || null,
    expandedAt: r.expanded_at ? Date.parse(r.expanded_at) : null,
    expiresAt:  r.expires_at  ? Date.parse(r.expires_at)  : null,
    createdAt:  r.created_at  ? String(r.created_at).slice(0, 10) : null,
  };
}

// Load everything the dashboard needs in four parallel table reads. RLS
// filters each SELECT to rows for businesses owned by the caller — the
// business_id filter is defence-in-depth (client already knows which biz
// is active). On error, we log and fall back to empty arrays / null so
// the dashboard still renders instead of white-screening.
async function loadDashboardData(businessId) {
  const [plRes, evRes, hoursRes, placeRes] = await Promise.all([
    sb.from('business_playlists').select('*').eq('business_id', businessId).order('created_at', { ascending: false }),
    sb.from('business_events').select('id,name,description,created_at').eq('business_id', businessId).order('created_at', { ascending: true }),
    sb.from('business_hours').select('hours,longest_minutes').eq('business_id', businessId).limit(1),
    sb.from('business_place').select('*').eq('business_id', businessId).limit(1),
  ]);
  if (plRes.error)    console.warn('business_playlists load:', plRes.error.message);
  if (evRes.error)    console.warn('business_events load:',    evRes.error.message);
  if (hoursRes.error) console.warn('business_hours load:',     hoursRes.error.message);
  if (placeRes.error) console.warn('business_place load:',     placeRes.error.message);
  state.dashboard = {
    playlists:      (plRes.data || []).map(playlistRowToClient),
    events:         evRes.data || [],
    hours:          hoursRes.data?.[0]?.hours || null,
    longestMinutes: hoursRes.data?.[0]?.longest_minutes || null,
    place:          placeRes.data?.[0] || null,
  };
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
  if (business.id !== meta.currentBizId) {
    // currentBizId is one of the few things that stays in user_metadata —
    // it identifies which biz the dashboard opens to and is tiny (uuid).
    meta = { ...meta, currentBizId: business.id };
    try { await sb.auth.updateUser({ data: { sonic: meta } }); }
    catch (e) { console.warn('currentBizId write failed:', e?.message || e); }
  }

  await loadDashboardData(business.id);
  renderAll();
  show('dashView');

  // Background expansion of any onboarding playlists that are still at
  // sample size. The endpoint streams progress and updateCountInRow ticks
  // the count live. Fire-and-forget so the dashboard is interactive
  // immediately.
  expandPendingPlaylists().catch((e) => console.warn('expandPendingPlaylists:', e));
}

// Businesses table read — includes onboarding_expanded (moved off user_metadata
// in the tables migration), used by expandPendingPlaylists as its one-time gate.
async function loadBusinesses() {
  const { data } = await sb.from('businesses')
    .select('id,owner_id,name,monthly_credits,credits_remaining,onboarding_expanded,created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true });
  return data || [];
}

function renderAll() {
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
// The Google Places integration no longer fetches photos (see api/v6/
// place-lookup.js and the migration that dropped `photos` from the field
// mask). Without a photo_url the banner has nothing to render — hide the
// element permanently. Kept as a no-op function so callers don't have to
// know the feature is gone.
function renderPlaceBanner() {
  $('placeBanner')?.classList.add('hide');
}

// ---------- tabs (Home / Profile) ----------
// The profile tab is mounted lazily on switch — this lets us pull the latest
// business.name + bmeta().hours each time the user opens it (so edits made
// elsewhere, like the onboarding-time hours, always appear fresh) and lets
// the hours editor rebuild its DOM from scratch instead of us wiring a
// separate "reset" path.
let hoursEditor = null;
// Snapshot of the profile form values at last-saved (or at tab-open) so the
// save button can dirty-track: disabled while the form matches the snapshot,
// enabled the moment the user edits anything.
let profileSnapshot = null;

document.querySelectorAll('.nav button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  ['Home', 'Profile'].forEach((t) => {
    $('tab' + t)?.classList.toggle('hide', t !== tab);
  });
  document.querySelectorAll('.nav button[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  if (tab === 'Profile') renderProfileTab();
}

function renderProfileTab() {
  $('profileBizName').value = business?.name || '';
  $('profileMsg').textContent = '';
  const savedHours = bmeta().hours;
  hoursEditor = mountHoursEditor($('hoursHost'), {
    prechecked: savedHours ? { hours: savedHours } : null,
    onChange: () => updateProfileSaveButton(),
  });
  profileSnapshot = {
    name:  ($('profileBizName').value || '').trim(),
    hours: JSON.stringify(hoursEditor.getPayload().hours),
  };
  $('profileBizName').oninput = () => updateProfileSaveButton();
  updateProfileSaveButton();
}

function updateProfileSaveButton() {
  const btn = $('saveProfile');
  if (!btn || !profileSnapshot || !hoursEditor) return;
  const nameNow  = ($('profileBizName').value || '').trim();
  const hoursNow = JSON.stringify(hoursEditor.getPayload().hours);
  const dirty    = nameNow !== profileSnapshot.name || hoursNow !== profileSnapshot.hours;
  const valid    = !!nameNow && !hoursEditor.isAllClosed();
  btn.disabled = !(dirty && valid);
}

$('saveProfile')?.addEventListener('click', async () => {
  const name = $('profileBizName').value.trim();
  const msg  = $('profileMsg');
  const btn  = $('saveProfile');
  msg.style.color = '';
  msg.textContent = '';

  if (!name) { msg.style.color = '#ff9b8a'; msg.textContent = 'הכניסו שם לעסק'; return; }
  if (!hoursEditor || hoursEditor.isAllClosed()) {
    msg.style.color = '#ff9b8a';
    msg.textContent = 'סמנו לפחות יום פתוח אחד';
    return;
  }
  const { hours, longestMinutes } = hoursEditor.getPayload();

  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = 'שומרים…';
  try {
    if (name !== business.name) {
      const { error } = await sb.from('businesses').update({ name }).eq('id', business.id);
      if (error) console.warn('name update blocked:', error.message);
      else business.name = name;
    }
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v6/account/update-hours', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: business.id, hours, longestMinutes }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
    // Reflect the change locally so the title renderer and
    // hasPlaylistsForToday pick up the new hours immediately.
    state.dashboard = { ...(state.dashboard || {}), hours, longestMinutes };
    renderBusiness();
    renderPlaylistsTitle();
    msg.style.color = 'var(--teal-soft)';
    msg.textContent = 'נשמר ✓';
    // Refresh the dirty-tracking snapshot so the button goes back to
    // disabled until the user makes another change.
    profileSnapshot = { name, hours: JSON.stringify(hours) };
  } catch (e) {
    console.error('saveProfile:', e);
    msg.style.color = '#ff9b8a';
    msg.textContent = 'שגיאה בשמירה — נסו שוב';
  } finally {
    btn.textContent = origLabel;
    // Restore the correct enabled/disabled state via the snapshot compare,
    // rather than blanket-enabling.
    updateProfileSaveButton();
  }
});

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

// "Daily playlists exist for today" — checked via createdAt (YYYY-MM-DD).
// Used to tell apart the onboarding day (daily playlists just created →
// normal title) from a later closed-day visit (no daily playlists → show
// the closed prompt). Only LIVE playlists (not past their expiresAt) count,
// and event playlists are excluded — they surface in the events section,
// so their presence must not flip the daily-playlists title to "open day".
function isoDateToday() { return new Date().toISOString().slice(0, 10); }
function hasPlaylistsForToday() {
  const today = isoDateToday();
  return (bmeta().playlists || []).some((p) =>
    p && !p.eventId && p.createdAt === today && playlistIsLive(p),
  );
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
  // Daily list shows only daily playlists — event playlists surface in
  // the events section via activePlaylistForEvent → "▶ פתח" on the event
  // row. Filtering them out here avoids the duplicate listing.
  const playlists = (bmeta().playlists || []).filter((p) => playlistIsLive(p) && !p.eventId);
  if (!playlists.length) {
    wrap.innerHTML = '<p class="muted">עדיין לא נוצרו פלייליסטים.</p>';
    return;
  }
  const target = dayTargetTracks();
  for (const p of playlists) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.dataset.playlistId = p.id || '';
    const showBar = playlistIsExpanding(p, target);
    const barHtml = showBar
      ? `<div class="pl-expand-bar" data-target="${target}" data-current="${p.trackCount || 0}"><div class="pl-expand-fill"></div></div>`
      : '';
    const spinnerHtml = showBar ? '<span class="pl-inline-spinner" aria-label="בונים"></span>' : '';
    row.innerHTML =
      `<div class="s-info">` +
        `<div class="s-title">${p.ico || '🎵'} ${p.label || 'פלייליסט'}</div>` +
        `<div class="s-meta"><span class="pl-count">${p.trackCount || 0}</span> שירים${spinnerHtml}</div>` +
        barHtml +
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
  if (business?.onboarding_expanded) return false;
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
async function markOnboardingExpanded() {
  const { error } = await sb.from('businesses')
    .update({ onboarding_expanded: true })
    .eq('id', business.id);
  if (error) console.warn('onboarding_expanded update failed:', error.message);
  else business.onboarding_expanded = true;
}

async function expandPendingPlaylists() {
  if (business?.onboarding_expanded) return;

  const playlists = bmeta().playlists || [];
  const target    = dayTargetTracks();
  const pending   = playlists.filter((p) => playlistIsExpanding(p, target));

  // Even if nothing to expand (pre-flag user with all playlists already
  // marked expandedAt), still stamp the flag so we short-circuit next load.
  if (!pending.length) {
    await markOnboardingExpanded();
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) return;

  // Set the flag NOW — before we do any expansion work. This is the
  // durable "we've done this" guarantee. If the tab closes mid-way, some
  // playlists may end up under-populated, but nothing will re-populate
  // them. That is intentional per the product spec.
  await markOnboardingExpanded();

  for (const p of pending) {
    await expandOne(p, session.access_token, target);
  }

  // Refresh dashboard data so subsequent renders see the new track_counts
  // + expanded_at fields (server persisted them). Won't re-render — the
  // DOM is already up to date from the stream. Later navigations use this.
  try {
    await loadDashboardData(business.id);
    // Remove the progress bar from any rows that just finished so they
    // don't look "still working" on next render.
    document.querySelectorAll('#slotsWrap .slot').forEach((row) => {
      const bar = row.querySelector('.pl-expand-bar');
      if (bar && bar.classList.contains('done')) bar.remove();
    });
  } catch (e) { console.warn('post-expand dashboard refresh failed:', e); }
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
    // Server INSERTed the new playlists into business_playlists — refresh
    // the local mirror so the title flips back to normal ("playlists for
    // today exist") and the new rows appear.
    await loadDashboardData(business.id);
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
  // Hide the whole "פלייליסטים אחרים" section when there are no events —
  // otherwise the user sees a titled but empty box between the daily
  // playlists section and the chat section.
  const box = $('specialBox');
  if (box) box.classList.toggle('hide', events.length === 0);
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'slot';

    const info = document.createElement('div');
    info.className = 's-info';

    const title = document.createElement('div');
    title.className = 's-title';
    title.textContent = `🎪 ${ev.name || 'אירוע'}`;
    info.append(title);

    // Description line: click to toggle between the 90-char truncation and
    // the full text when it's been cut. truncate() appends '…' as the
    // visual "there's more" cue; the meta line also gets cursor:pointer +
    // hover lift via .s-meta-expandable to signal it's interactive.
    const meta = document.createElement('div');
    meta.className = 's-meta';
    const desc  = ev.description || '';
    const short = truncate(desc, 90);
    if (desc.length > short.length) {
      meta.classList.add('s-meta-expandable');
      meta.textContent = short;
      meta.title = 'לחצו להרחבה';
      meta.addEventListener('click', () => {
        const expanded = meta.classList.toggle('expanded');
        meta.textContent = expanded ? desc : short;
      });
    } else {
      meta.textContent = desc;
    }
    info.append(meta);

    row.append(info);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger event-del';
    delBtn.title     = 'מחיקה';
    delBtn.setAttribute('aria-label', 'מחיקה');
    // Generic trash icon (outline). currentColor picks up .btn-danger's red.
    delBtn.innerHTML =
      '<svg class="event-del-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6h18"/>' +
      '<path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/>' +
      '<path d="M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14"/>' +
      '<path d="M10 11v6"/>' +
      '<path d="M14 11v6"/>' +
      '</svg>';
    delBtn.addEventListener('click', () => deleteEvent(ev.id, delBtn));
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
    // The endpoint INSERTed the row into business_playlists. Refresh the
    // dashboard mirror so renderPlaylists picks it up and activePlaylist
    // ForEvent finds the new row for the event card.
    await loadDashboardData(business.id);
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

async function deleteEvent(id, btn) {
  if (!confirm('למחוק את האירוע?')) return;
  const origHtml = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="sb-spinner" style="width:16px;height:16px;display:block"></span>';
  }
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v6/account/delete-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: business.id, eventId: id }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
    // Trim locally so we don't need a round-trip for the next render.
    // renderEvents() rebuilds the whole list so the button state resets
    // naturally — no need to restore origHtml on the success path.
    state.dashboard = {
      ...(state.dashboard || {}),
      events: (bmeta().events || []).filter((e) => e.id !== id),
    };
    renderEvents();
  } catch (e) {
    console.error('deleteEvent failed:', e);
    if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    toast(String(e.message || 'שגיאה במחיקה'));
  }
}

// ---------- events chat ----------
// Replaces the old textarea + "שמור אירוע" button. The user chats with
// Gemini until Gemini's reply carries state="confirming" + a `proposed`
// summary; a "צור פלייליסט" button then appears inline in that reply
// bubble. Clicking it runs the same upsert-event → event-playlist chain
// the old handler ran, so the card that lands in #eventsWrap and its
// downstream generate-daily behavior are identical to before.

const GEMINI_MODEL          = 'gemini-3.6-flash';
const GEMINI_THINKING_LEVEL = 'low';
const CHAT_MAX_TOKENS       = 2000;

function scrollChatToBottom() {
  const box = $('chatMessages');
  if (box) box.scrollTop = box.scrollHeight;
}

// Renders one message bubble. `role` is 'user' | 'assistant'. When
// thinking=true the bubble contains three animated bouncing dots — the
// standard LLM typing indicator — instead of the text arg. Once the real
// reply arrives the caller does `bubble.textContent = replyText`, which
// replaces the dot children with plain text automatically.
function renderBubble(role, text, { thinking = false } = {}) {
  const box = $('chatMessages');
  const b = document.createElement('div');
  b.className = `chat-bubble ${role}` + (thinking ? ' thinking' : '');
  if (thinking) {
    b.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  } else {
    b.textContent = text;
  }
  box.append(b);
  scrollChatToBottom();
  return b;
}

// Called after Gemini replies with state="confirming". Adds an inline
// "הכן פלייליסט" button inside the given bubble. Clicking it hands
// Gemini's distilled summary off as a business_events row — internally
// still just an upsert, but the user-facing verb is "prepare" to pair
// naturally with the card's later "צרו פלייליסט" (create) button. Two
// stages: prepare → create. If the user isn't ready yet they keep
// typing in the chat input, so no explicit dismiss button is needed.
function appendConfirmActions(bubble) {
  const row = document.createElement('div');
  row.className = 'chat-actions';

  const goBtn = document.createElement('button');
  goBtn.className   = 'btn';
  goBtn.textContent = 'הכן פלייליסט';
  goBtn.addEventListener('click', () => finalizeAndSaveEvent(goBtn));

  row.append(goBtn);
  bubble.append(row);
  scrollChatToBottom();
}

// Multi-turn Gemini call. Sends the full chat history + system prompt each
// turn (Gemini is stateless — the transcript is our memory). Returns the
// parsed JSON reply, or throws on transport / parse failure.
async function callChatModel(userMessage) {
  // Convert the visible transcript into Gemini's { role, text } shape.
  // 'assistant' → 'model' (Gemini's naming). The current user message is
  // sent as the `user` field, not appended to history.
  const history = chatState.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    text: m.text,
  }));

  const r = await fetch('/api/v6/gemini', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:             GEMINI_MODEL,
      max_output_tokens: CHAT_MAX_TOKENS,
      thinking_level:    GEMINI_THINKING_LEVEL,
      system:            EVENT_CHAT_SYSTEM_PROMPT,
      user:              userMessage,
      history,
      label:             'event-chat',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || r.statusText;
    throw new Error(`gemini ${r.status}: ${msg}`);
  }
  const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const text = Array.isArray(cand?.content?.parts)
    ? cand.content.parts.find((p) => typeof p?.text === 'string')?.text
    : null;
  if (typeof text !== 'string') throw new Error('no text from model');

  // System prompt forces JSON via responseMimeType; be defensive anyway.
  const trimmed = String(text).trim();
  const fenced  = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body    = fenced ? fenced[1] : trimmed;
  return JSON.parse(body);
}

// Send-button handler. Guards against double-fire while a call is in flight.
async function sendChatMessage() {
  const input = $('chatInput');
  const text  = (input.value || '').trim();
  if (!text || chatState.busy) return;
  input.value = '';
  $('eventsMsg').textContent = '';
  // Collapse the textarea to a single line and drop the placeholder once
  // the chat is live — the initial 3-row hint is only useful before the
  // conversation starts. Reset in finalizeAndSaveEvent for the next event.
  input.rows = 1;
  input.classList.add('compact');
  input.removeAttribute('placeholder');

  renderBubble('user', text);
  chatState.messages.push({ role: 'user', text });

  chatState.busy = true;
  $('chatSend').disabled = true;
  const thinking = renderBubble('assistant', '…', { thinking: true });

  try {
    const reply = await callChatModel(text);
    const replyText = (reply?.reply_he || '').trim() || '(אין תשובה)';
    thinking.classList.remove('thinking');
    thinking.textContent = replyText;
    chatState.messages.push({ role: 'assistant', text: replyText });

    if (reply?.state === 'confirming' && reply?.proposed
        && typeof reply.proposed.name_he === 'string'
        && typeof reply.proposed.description_he === 'string'
        && reply.proposed.description_he.trim().length >= 5) {
      chatState.proposed = {
        name_he:        String(reply.proposed.name_he).trim().slice(0, 40),
        description_he: String(reply.proposed.description_he).trim(),
      };
      appendConfirmActions(thinking);
    } else {
      // Any other reply (gathering / off_topic / malformed proposed):
      // clear stale proposed so an old "צור פלייליסט" click can't fire
      // on a description the user has since revised.
      chatState.proposed = null;
    }
  } catch (err) {
    console.error('event-chat failed:', err);
    thinking.classList.remove('thinking');
    thinking.textContent = 'שגיאה בצ׳אט — נסו שוב.';
    // Roll back the user's turn from history so they can retry without
    // the model seeing a dangling user message with no reply.
    chatState.messages.pop();
  } finally {
    chatState.busy = false;
    $('chatSend').disabled = false;
    input.focus();
  }
}

// Runs when the user clicks "שמור אירוע" inside a confirming reply.
// Semantics match the old textarea + "שמור אירוע" button exactly:
//   - POST /api/v6/account/upsert-event with Gemini's distilled summary
//   - Splice the returned row into state; renderEvents shows the new card
//     with its own "צרו פלייליסט" button.
// The actual Spotify playlist is built later, when the user clicks that
// card button — createEventPlaylist handles that leg. Two separate steps,
// no coupling between them, and no cold-plan issue at chat-finalize time
// because we don't call v5_direction_tracks here at all.
async function finalizeAndSaveEvent(goBtn) {
  if (!chatState.proposed) {
    toast('חסר תיאור — כתבו עוד קצת');
    return;
  }
  const { name_he: name, description_he: description } = chatState.proposed;
  goBtn.disabled = true;
  const origHtml = goBtn.innerHTML;
  goBtn.innerHTML = '<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>מכינים…';

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');

    const upsertRes = await fetch('/api/v6/account/upsert-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: business.id, event: { name, description } }),
    });
    const upsertData = await upsertRes.json().catch(() => ({}));
    if (!upsertRes.ok || !upsertData.ok || !upsertData.event) {
      throw new Error(upsertData?.error || `שגיאה ${upsertRes.status}`);
    }
    const ev = upsertData.event;

    // Splice into local state so the card appears immediately with its
    // "צרו פלייליסט" action — same as the old textarea-based save.
    const events = [...(bmeta().events || []), ev];
    state.dashboard = { ...(state.dashboard || {}), events };
    renderEvents();
    toast('מוכן ✓');

    // Reset the chat for the next event. Restore the textarea to its
    // initial multi-row + placeholder state so the next event begins fresh.
    chatState.messages = [];
    chatState.proposed = null;
    $('chatMessages').innerHTML = '';
    const ci = $('chatInput');
    ci.rows = 3;
    ci.classList.remove('compact');
    ci.setAttribute('placeholder', 'לדוגמה: ערב סטנדאפ בכל יום שלישי — קלילה, לא רועשת מדי...');
  } catch (err) {
    console.error('finalizeAndSaveEvent failed:', err);
    goBtn.disabled = false;
    goBtn.innerHTML = origHtml;
    toast(String(err.message || 'משהו השתבש — נסו שוב').slice(0, 120));
  }
}

$('chatSend')?.addEventListener('click', sendChatMessage);
$('chatInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
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
