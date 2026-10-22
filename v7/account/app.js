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

const SUPABASE_URL = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

// ?reset=1 → clear any saved session so the account starts fresh.
if (new URLSearchParams(location.search).has('reset')) {
  Object.keys(localStorage).filter((k) => k.startsWith('sb-')).forEach((k) => localStorage.removeItem(k));
}

// Emailed links land here with their result in the URL hash. Read it BEFORE
// createClient below — supabase-js consumes the tokens and clears the hash.
//   #...type=recovery...   a "שכחתי סיסמה" link → ask for a new password.
//                          Remembered in sessionStorage until it's saved, so a
//                          reload of this tab still asks.
//   #error_code=...        an expired / already-used link.
// ?email= pre-fills the login form (the onboarding's "already registered"
// screen links here with it).
const RECOVERY_KEY = 'rubin-v7-set-password';
const LINK_ERROR = (() => {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  if (hash.get('type') === 'recovery') {
    try { sessionStorage.setItem(RECOVERY_KEY, '1'); } catch { /* private mode */ }
  }
  const err = hash.get('error_code') || hash.get('error') || query.get('error_code');
  if (err) history.replaceState(null, '', location.pathname);
  return err || null;
})();
const PREFILL_EMAIL = new URLSearchParams(location.search).get('email') || '';

function needsNewPassword() {
  try { return sessionStorage.getItem(RECOVERY_KEY) === '1'; } catch { return false; }
}
function clearNeedsNewPassword() {
  try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* ignore */ }
}

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { computeTargetForToday, ilPartsFromDate, datedLabel, undatedLabel, prevIl4amIso, nextIl4amIso } from '../generation/playlist-length.js?v=03102026a';
import {
  reconcileTimeline, groupForDay, groupDaysLabel, businessWindowAt, normLevels, energyAtFn, windowOf, levelOf, fmtHM,
  parseHM, nudgePoints,
} from '../generation/energy-timeline.js?v=13102026a';
import { TimelineEditor, energyColor } from './energy-timeline-editor.js?v=24092026a';
import { mountHoursEditor } from '../hours-selector.js?v=29092026a';
// direction-chat.js (v6's chat) is no longer mounted in v7 — the Home tab's
// card is the taste chat since 2026-10-13. Its exports are still referenced by
// the per-playlist edit / trash paths, which v7 rows never show (no direction_id).
import { openDirectionChat, selectDirectionInChat, removeDirectionFromCard, patchDirectionOptimistic } from './direction-chat.js?v=03102026a';
import { mountTasteChat, resetTasteChat, ensurePortrait, syncTastePlaceholder } from './taste-chat.js?v=21102026c';
import { generateEnergyDirections } from '../generation/energy-directions.js?v=21102026b';
import { generateLevelDirections } from '../generation/level-directions.js?v=21102026b';
import { pickLevelDirections, levelProfileKey } from '../generation/timeline-assembler.js?v=28092026a';
import { setWaitText, WAIT_DOTS_HTML } from '../wait-dots.js?v=28092026a';
import { nudgeOptions } from '../generation/energy-windows.js?v=21102026a';
import { mountHypPayment, ensureHypPaymentStyles } from '../hyp-payment.js?v=06102026a';
import { PASSWORD_RULES_TEXT, passwordProblem } from '/shared/password-rules.js?v=28092026a';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $ = (id) => document.getElementById(id);
const show = (id) => { ['loginView', 'newPasswordView', 'dashView', 'loading'].forEach((v) => $(v).classList.add('hide')); $(id).classList.remove('hide'); };

// HTML-escape for the (rare) sites where user- or AI-provided strings need
// to flow into innerHTML because the surrounding markup is complex enough
// that createElement + textContent would be a heavier refactor. AI-generated
// direction titles (p.label) are the concrete concern — a prompt injection
// could otherwise land an executable <script> in the DOM at render time.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

let businesses = [];
let business = null;
let user = null;
let meta = {};

// Per-business data loaded from tables and refreshed on writes. Shape:
//   { playlists, events, hours, longestMinutes, place }
// Field names are camelCase (mapped from snake_case Postgres columns) so
// the rest of the render / event-management code doesn't need to know
// where the data comes from.
const state = { dashboard: null };

// Every change of the playlist type goes through here, so the taste chat's
// placeholder follows it.
function setDeliveryModeState(mode) {
  const changed = state.deliveryMode !== mode;
  state.deliveryMode = mode;
  syncTastePlaceholder(mode);
  // The cards are drawn before the type is read on load; the energy circles
  // (Option 1 only) need it, so redraw once it's known.
  if (changed && state.dashboard && !state.generating) renderPlaylists();
}

// Chat state for the special-playlists panel. `messages` is the visible
// transcript; `proposed` is the last confirming-state summary Gemini
// offered.
//
// Every message is also persisted server-side via /api/v7/account/event-chat
// (business_event_chats table; the prompt lives on the server). The
// client's visible transcript is still cleared on hard refresh and on
// a successful finalize — SESSION_START_AT_ISO gates BOTH what the
// client shows AND what the server includes in Gemini's context, so
// the on-screen chat and the model's memory stay in sync.
//
// SESSION_START_AT_ISO is bumped on every finalize so the NEXT event
// chat starts fresh without dragging the just-finalized session's
// messages into Gemini's context. Hard refresh regenerates the
// timestamp naturally.
let SESSION_START_AT_ISO = new Date().toISOString();
const chatState = {
  messages: [],        // [{ role: 'user' | 'assistant', text: string }]
  proposed: null,      // { name_he, description_he, genre_source } | null
  busy: false,     // true while a Gemini round trip is in flight
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
    id: r.spotify_id,
    url: r.url,
    label: r.label,
    ico: r.ico,
    trackCount: r.track_count,
    genres: Array.isArray(r.genres) ? r.genres : [],
    bpmRange: r.bpm_range || null,
    expansion: r.expansion || null,
    eventId: r.event_id || null,
    // Nullable back-ref used by the Home tab's per-playlist edit + trash
    // icons to send the owner to the profile-tab direction-edit chat
    // for that specific direction. Set at signup + on every daily-gen /
    // apply-direction-change build; NULL for pre-migration rows.
    directionId: r.direction_id || null,
    expandedAt: r.expanded_at ? Date.parse(r.expanded_at) : null,
    expiresAt: r.expires_at ? Date.parse(r.expires_at) : null,
    // IL calendar date (a UTC slice is off by a day between 00:00 and
    // 02:00/03:00 IL) + the exact instant for business-day checks.
    createdAt: r.created_at ? ilPartsFromDate(new Date(r.created_at)).isoDate : null,
    createdAtMs: r.created_at ? Date.parse(r.created_at) : null,
  };
}

// Load everything the dashboard needs in four parallel table reads. RLS
// filters each SELECT to rows for businesses owned by the caller — the
// business_id filter is defence-in-depth (client already knows which biz
// is active). On error, we log and fall back to empty arrays / null so
// the dashboard still renders instead of white-screening.
async function loadDashboardData(businessId) {
  const [plRes, evRes, hoursRes, placeRes, opensRes] = await Promise.all([
    sb.from('business_playlists').select('*').eq('business_id', businessId).order('created_at', { ascending: false }),
    sb.from('business_events').select('id,name,description,created_at').eq('business_id', businessId).order('created_at', { ascending: true }),
    sb.from('business_hours').select('hours,longest_minutes').eq('business_id', businessId).limit(1),
    sb.from('business_place').select('*').eq('business_id', businessId).limit(1),
    // Click log for the "▶ פתח" open button. Small table per biz; aggregated
    // client-side into a { spotify_id → total } map used by renderPlaylists
    // to sort most-clicked first. See sortPlaylistsByClicksDesc below.
    sb.from('business_playlist_opens').select('spotify_id').eq('business_id', businessId),
  ]);
  if (plRes.error)    console.warn('business_playlists load:',     plRes.error.message);
  if (evRes.error)    console.warn('business_events load:',        evRes.error.message);
  if (hoursRes.error) console.warn('business_hours load:',         hoursRes.error.message);
  if (placeRes.error) console.warn('business_place load:',         placeRes.error.message);
  if (opensRes.error) console.warn('business_playlist_opens load:', opensRes.error.message);
  const clicksBySpotifyId = new Map();
  for (const o of (opensRes.data || [])) {
    if (!o.spotify_id) continue;
    clicksBySpotifyId.set(o.spotify_id, (clicksBySpotifyId.get(o.spotify_id) || 0) + 1);
  }
  state.dashboard = {
    playlists: (plRes.data || []).map(playlistRowToClient),
    events: evRes.data || [],
    hours: hoursRes.data?.[0]?.hours || null,
    longestMinutes: hoursRes.data?.[0]?.longest_minutes || null,
    place: placeRes.data?.[0] || null,
    clicksBySpotifyId,
  };
}

// v7's daily playlists have fixed names, shown in that order (2026-10-13):
// "#1" before "#2", the energetic ones before the calm ones — the order
// they're built in and the order the loading placeholders show
// (expectedDailySlots).
const OPTION1_DAILY_TITLES = ['אנרגיה גבוהה #1', 'אנרגיה גבוהה #2', 'אנרגיה רגועה #1', 'אנרגיה רגועה #2'];
const OPTION2_DAILY_TITLES = ['Daily Mix #1', 'Daily Mix #2'];
const DAILY_ORDER = [...OPTION1_DAILY_TITLES, ...OPTION2_DAILY_TITLES];
const dailyRank = (p) => {
  const i = DAILY_ORDER.indexOf(undatedLabel(p.label));
  return i < 0 ? DAILY_ORDER.length : i;
};

// The fixed names first, in DAILY_ORDER; anything else (rows from before the
// fixed names) after them, most-clicked first, then the newest.
function sortPlaylistsByClicksDesc(playlists) {
  const counts = state.dashboard?.clicksBySpotifyId || new Map();
  return [...playlists].sort((a, b) => {
    const ra = dailyRank(a);
    const rb = dailyRank(b);
    if (ra !== rb) return ra - rb;
    const ca = counts.get(a.id) || 0;
    const cb = counts.get(b.id) || 0;
    if (cb !== ca) return cb - ca;
    return (b.createdAtMs || 0) - (a.createdAtMs || 0);
  });
}

// ---------- boot ----------
(async function boot() {
  show('loading');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    clearNeedsNewPassword();
    showLogin();
    if (LINK_ERROR) {
      setLoginMsg('הקישור פג תוקף או שכבר השתמשו בו. היכנסו עם הסיסמה, או לחצו "שכחתי סיסמה" לקישור חדש.', 'err');
    }
    return;
  }
  if (needsNewPassword()) { showNewPasswordView(session.user?.email); return; }
  await enterDashboard();
})();

// Never call auth methods synchronously inside this callback — supabase-js
// holds an internal lock during it and updateUser() would deadlock.
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    if (loggingOut) return; // logout button handles its own navigation
    showLogin();
    return;
  }
  if (event === 'PASSWORD_RECOVERY' && session) {
    try { sessionStorage.setItem(RECOVERY_KEY, '1'); } catch { /* ignore */ }
    setTimeout(() => showNewPasswordView(session.user?.email), 0);
    return;
  }
  if (event === 'SIGNED_IN' && session) {
    setTimeout(() => { if (!business && !entering && !needsNewPassword()) enterDashboard(); }, 0);
  }
});

// ---------- login (email + password) ----------
// Three panels inside #loginView (showLoginPanel):
//   login   email + password → signInWithPassword
//   forgot  "שכחתי סיסמה" → resetPasswordForEmail → a link that lands back
//           here and asks for a new password (#newPasswordView)
//   link    "we sent a link" + resend. Also used when the account was never
//           verified: password login is refused until the email link is
//           clicked, so the owner can ask for a new one (signInWithOtp with
//           shouldCreateUser:false — the login page never creates accounts).
// Supabase sends at most one email per address per ~60s, so resending waits
// out a countdown.
const LINK_COOLDOWN_SEC = 60;
let linkTimerId = null;
let linkMode = 'reset';   // 'reset' | 'verify'
let linkEmail = '';

function showLogin() {
  show('loginView');
  showLoginPanel('login');
}

function setLoginMsg(text, kind) {
  const msg = $('loginMsg');
  msg.style.color = kind === 'err' ? '#ff9b8a' : '';
  msg.textContent = text || '';
}

function showLoginPanel(panel) {
  if (linkTimerId) { clearInterval(linkTimerId); linkTimerId = null; }
  $('loginForm').classList.toggle('hide', panel !== 'login');
  $('forgotForm').classList.toggle('hide', panel !== 'forgot');
  $('linkPanel').classList.toggle('hide', panel !== 'link');
  $('loginSub').textContent = panel === 'forgot'
    ? 'הזינו את האימייל ונשלח לכם קישור לבחירת סיסמה חדשה'
    : 'היכנסו עם האימייל והסיסמה שלכם';
  $('loginBtn').disabled = false;
  $('forgotSend').disabled = false;
  setLoginMsg('');
}

function isRateLimited(error) {
  return error?.status === 429 || /rate limit|security purposes/i.test(error?.message || '');
}

function emailSpan(email) {
  const span = document.createElement('span');
  span.dir = 'ltr';
  span.style.cssText = 'unicode-bidi:isolate;font-weight:700;color:var(--text)';
  span.textContent = email;
  return span;
}

// sent=false: the "not verified yet" prompt (button enabled, nothing sent).
// sent=true:  "we sent a link" + resend countdown.
function showLinkPanel(mode, email, { sent }) {
  linkMode = mode;
  linkEmail = email;
  showLoginPanel('link');
  const text = $('linkText');
  if (sent) {
    text.replaceChildren('שלחנו קישור ל־', emailSpan(email), mode === 'reset'
      ? ' ✉️ לחצו עליו כדי לבחור סיסמה חדשה.'
      : ' ✉️ לחצו עליו כדי לאשר את האימייל ולהיכנס.');
    startLinkCooldown();
  } else {
    text.replaceChildren('עוד לא אישרתם את האימייל ', emailSpan(email),
      '. לחצו על הקישור ששלחנו לכם בהרשמה, או בקשו קישור חדש.');
    $('linkSend').disabled = false;
    $('linkLabel').textContent = 'שלחו לי קישור חדש';
  }
}

function startLinkCooldown() {
  const btn = $('linkSend');
  const label = $('linkLabel');
  const base = 'שלחו שוב';
  let left = LINK_COOLDOWN_SEC;
  const tick = () => {
    if (left <= 0) {
      clearInterval(linkTimerId);
      linkTimerId = null;
      btn.disabled = false;
      label.textContent = base;
      return;
    }
    btn.disabled = true;
    label.textContent = `${base} (${left})`;
    left--;
  };
  if (linkTimerId) clearInterval(linkTimerId);
  tick();
  linkTimerId = setInterval(tick, 1000);
}

async function requestLink(mode, email, btn, spinner) {
  btn.disabled = true;
  spinner.classList.remove('hide');
  setLoginMsg('');
  const redirectTo = window.location.origin + '/v7/account';
  const { error } = mode === 'reset'
    ? await sb.auth.resetPasswordForEmail(email, { redirectTo })
    : await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
  spinner.classList.add('hide');
  if (error && !isRateLimited(error)) {
    btn.disabled = false;
    setLoginMsg('השליחה נכשלה — נסו שוב עוד רגע', 'err');
    return;
  }
  showLinkPanel(mode, email, { sent: true });
  // Rate-limited = a link already went out within the last minute.
  if (error) setLoginMsg('שלחנו קישור לפני רגע — אפשר לבקש שוב בעוד דקה');
}

$('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim().toLowerCase();
  const password = $('password').value;
  if (!email) { setLoginMsg('הכניסו אימייל', 'err'); $('email').focus(); return; }
  if (!password) { setLoginMsg('הכניסו סיסמה', 'err'); $('password').focus(); return; }
  const btn = $('loginBtn');
  btn.disabled = true;
  $('loginSpinner').classList.remove('hide');
  setLoginMsg('');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $('loginSpinner').classList.add('hide');
  btn.disabled = false;
  if (!error) { await enterDashboard(); return; }
  if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message || '')) {
    showLinkPanel('verify', email, { sent: false });
    return;
  }
  if (isRateLimited(error)) { setLoginMsg('יותר מדי ניסיונות — נסו שוב בעוד כמה דקות', 'err'); return; }
  // Same message whether the email exists or not.
  setLoginMsg('האימייל או הסיסמה שגויים', 'err');
});

$('forgotLink')?.addEventListener('click', () => {
  $('forgotEmail').value = $('email').value.trim();
  showLoginPanel('forgot');
  $('forgotEmail').focus();
});

$('forgotForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('forgotEmail').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setLoginMsg('הכניסו כתובת אימייל תקינה', 'err'); return; }
  await requestLink('reset', email, $('forgotSend'), $('forgotSpinner'));
});

$('linkSend')?.addEventListener('click', async () => {
  if (!linkEmail) return;
  await requestLink(linkMode, linkEmail, $('linkSend'), $('linkSpinner'));
});

document.querySelectorAll('[data-login-back]').forEach((b) => b.addEventListener('click', () => {
  showLoginPanel('login');
  $('email').focus();
}));

if (PREFILL_EMAIL) $('email').value = PREFILL_EMAIL;

// Rules hint under every new-password field (text lives in shared/password-rules.js).
document.querySelectorAll('.pw-hint').forEach((p) => { p.textContent = PASSWORD_RULES_TEXT; });

// Eye icon on every password field (login, new password, Profile).
document.querySelectorAll('.pw-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('showing', show);
    btn.setAttribute('aria-label', show ? 'הסתרת הסיסמה' : 'הצגת הסיסמה');
  });
});

// Supabase's reasons for refusing a new password, in Hebrew.
function passwordErrorText(error) {
  // Length / characters are checked before saving (shared/password-rules.js),
  // so a refusal here is normally the leaked-password check.
  if (error?.code === 'weak_password') {
    return (error.reasons || []).includes('pwned')
      ? 'הסיסמה הזו הופיעה בדליפת מידע ולכן לא בטוחה — בחרו סיסמה אחרת'
      : 'הסיסמה לא עומדת בדרישות — בחרו סיסמה אחרת';
  }
  if (error?.code === 'same_password') return 'זו הסיסמה הנוכחית — בחרו סיסמה אחרת';
  return 'שגיאה בשמירה — נסו שוב';
}

// ---------- new password (after a "שכחתי סיסמה" link) ----------
function showNewPasswordView(email) {
  $('newPasswordUser').value = email || '';
  $('newPasswordMsg').textContent = '';
  show('newPasswordView');
  $('newPassword').focus();
}

$('newPasswordForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('newPasswordMsg');
  const password = $('newPassword').value;
  msg.style.color = '#ff9b8a';
  const problem = passwordProblem(password);
  if (problem) {
    msg.textContent = problem;
    return;
  }
  const btn = $('newPasswordSave');
  btn.disabled = true;
  $('newPasswordSpinner').classList.remove('hide');
  msg.textContent = '';
  const { error } = await sb.auth.updateUser({ password });
  $('newPasswordSpinner').classList.add('hide');
  btn.disabled = false;
  // Typing the password they already had is fine — they're in.
  if (error && error.code !== 'same_password') {
    msg.textContent = passwordErrorText(error);
    return;
  }
  clearNeedsNewPassword();
  await enterDashboard();
});

// Logout: swallow the SIGNED_OUT event so we don't briefly flash the loginView
// on this page, then hop back to /v6 with ?intro=1 (which tells that page to
// skip the splash + entrance animation and land on the "have an account?" card
// straight away).
let loggingOut = false;
$('logout')?.addEventListener('click', async () => {
  loggingOut = true;
  clearNeedsNewPassword();
  try { await sb.auth.signOut(); } catch { /* proceed regardless */ }
  window.location.replace('/v7?intro=1');
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
  if (!u) { showLogin(); return; }
  user = u;
  meta = (u.user_metadata && u.user_metadata.sonic) || {};

  businesses = await loadBusinesses();
  if (!businesses.length) {
    // A login with no business behind it — sign out, or /v7 would keep
    // redirecting here on the saved session.
    loggingOut = true;
    try { await sb.auth.signOut(); } catch { /* ignore */ }
    loggingOut = false;
    showLogin();
    setLoginMsg('לא מצאנו עסק שמחובר לחשבון הזה.', 'err');
    return;
  }
  const wanted = businesses.find((b) => b.id === meta.currentBizId);
  business = wanted || businesses[0];
  if (business.id !== meta.currentBizId) {
    // currentBizId is one of the few things that stays in user_metadata —
    // it identifies which biz the dashboard opens to and is tiny (uuid).
    meta = { ...meta, currentBizId: business.id };
    try { await sb.auth.updateUser({ data: { sonic: meta } }); }
    catch (e) { console.warn('currentBizId write failed:', e?.message || e); }
  }

  // Profile → מנוי + the Home tab's "subscription ended" banner. Started now,
  // alongside the dashboard data, so it's usually in before Profile opens.
  loadSubscription();
  // The Home tab's "why no playlists" line — also started now, so the line
  // can appear whole with the box instead of a moment later.
  const dailyStatusPending = dailyStatusRequest('GET');
  dailyStatusPending.catch(() => {});   // handled in loadDailyStatus

  await loadDashboardData(business.id);
  renderAll();
  show('dashView');
  logTasteForTesting();   // TEMPORARY — Ami's testing (see DEBUG_TASTE_LOG)
  loadDailyStatus(dailyStatusPending);

  // v7 first-login gate: block the dashboard behind #v7ModeGate until the
  // owner picks a daily-delivery mode. Resolves immediately if already chosen.
  const pickedModeNow = await checkV7ModeGate();

  // First login (onboarded + paid + just picked a daily-playlist type): build
  // TODAY's set right away via the same streaming flow as the "צור פלייליסטים"
  // link — expires 2h after today's close (next 04:00 IL on a closed day or
  // after closing). The v7 cron takes over from tomorrow; it skips a business
  // for 15 min after a mode change so it can't race this build.
  if (pickedModeNow && !hasPlaylistsForToday()) runGenerateDaily();

  // The Home tab's "הטעם המוזיקלי שלכם" chat (taste-chat.js; idempotent).
  syncTastePlaceholder(state.deliveryMode);
  mountTasteChat({
    supabase: sb,
    getBusiness: () => business,
    hooks: {
      askReplace: (replace) => askReplaceToday(replace),
      runReplaceToday,
      openTimelineWithHint: editTimelineWithHint,
      prefs: () => state.tastePrefs || {},
    },
  });
  loadTastePrefs();
  startChatDayReset();
  // The owner's musical portrait: the first version from the onboarding
  // answers if there's none yet (background; the server skips it otherwise).
  ensurePortrait();

  // Background expansion of any onboarding playlists that are still at
  // sample size. The endpoint streams progress and updateCountInRow ticks
  // the count live. Fire-and-forget so the dashboard is interactive
  // immediately.
  expandPendingPlaylists().catch((e) => console.warn('expandPendingPlaylists:', e));
}

// ---------- TEMPORARY: taste log for Ami's testing (2026-09-24) ----------
// On every dashboard load (login / refresh), print this account's musical
// taste to the browser console (DevTools → Console): the taste profile's
// genres by energy level, the Option-1 directions (each genre with its
// level) or the Option-2 timeline (each dot with its level), and today's
// playlists (Option 2: the level/genre runs through the day). Read-only,
// owner-scoped reads. Set DEBUG_TASTE_LOG = false (or delete this block and
// its call in enterDashboardInner) once testing is done.
const DEBUG_TASTE_LOG = true;

async function logTasteForTesting() {
  if (!DEBUG_TASTE_LOG || !business) return;
  try {
    const [tpRes, setRes, dirRes, lvlRes] = await Promise.all([
      sb.from('business_taste_profiles').select('*')   // '*': requested_genres only exists after the 2026-10-05 migration
        .eq('business_id', business.id).maybeSingle(),
      sb.from('business_v7_settings').select('delivery_mode,timeline').eq('business_id', business.id).maybeSingle(),
      sb.from('business_v7_directions').select('energy_tier,rank,title_en,genres')
        .eq('business_id', business.id).eq('active', true).order('energy_tier').order('rank'),
      sb.from('business_v7_level_directions').select('id,energy_level,rank,title_en,genres,profile_key')
        .eq('business_id', business.id).eq('active', true).order('energy_level').order('rank'),
    ]);
    const tp = tpRes.data;
    const mode = setRes.data?.delivery_mode || null;
    const N = normLevels(tp?.energy_levels_total);
    const levelOfGenre = new Map((tp?.approved_genres || []).map((g) => [g.genre, g.energy_level]));
    const withLevel = (g) => `${g} (${levelOfGenre.has(g) ? `L${levelOfGenre.get(g)}` : 'not approved'})`;

    console.group(`%c[Rubin testing] ${business.name || business.id} — musical taste`, 'font-weight:bold;color:#f0a73f');
    if (!tp) {
      console.log('No taste profile saved for this business.');
    } else {
      console.log(`Energy levels: ${tp.energy_levels_total} (L1 = calmest … L${tp.energy_levels_total} = most energetic) · instrumental pref: ${tp.instrumentalness_preference} · popularity pref: ${tp.popularity_preference}`);
      console.log('Approved genres (what playlists are built from), most energetic first:');
      console.table([...(tp.approved_genres || [])]
        .sort((a, b) => b.energy_level - a.energy_level || a.genre.localeCompare(b.genre))
        .map((g) => ({ level: `L${g.energy_level}`, genre: g.genre })));
      const byLevel = {};
      for (const g of tp.approved_genres || []) (byLevel[`L${g.energy_level}`] ||= []).push(g.genre);
      for (let L = N; L >= 1; L--) console.log(`  L${L}: ${(byLevel[`L${L}`] || []).join(', ') || '— (no genres at this level)'}`);
      console.log(`Requested genres (super-liked or asked for in the emphases — Option 1 puts each in every playlist of its tier): ${(tp.requested_genres || []).map(withLevel).join(', ') || (Array.isArray(tp.requested_genres) ? 'none' : 'not recorded (signed up before 2026-10-05)')}`);
      if ((tp.conditional_genres || []).length) {
        console.groupCollapsed(`Conditional genres (${tp.conditional_genres.length}) — stored, NOT used for playlists`);
        console.table(tp.conditional_genres.map((g) => ({ level: `L${g.energy_level}`, genre: g.genre, note: g.note_en })));
        console.groupEnd();
      }
      console.log(`Excluded genres (${(tp.excluded_genres || []).length}): ${(tp.excluded_genres || []).join(', ')}`);
      if (tp.reasoning_en) console.log(`Model reasoning: ${tp.reasoning_en}`);
    }

    console.log(`Daily playlist type: ${mode === 'option1' ? 'Option 1 — 4 playlists (2 high + 2 low energy)' : mode === 'option2' ? 'Option 2 — 2 mixes following the energy timeline' : 'not chosen yet'}`);
    const dirs = dirRes.data || [];
    if (dirs.length) {
      console.log('Option 1 directions (each day 2 per tier: one at random, then the one least like it):');
      console.table(dirs.map((d) => ({ tier: d.energy_tier, rank: d.rank, title: d.title_en, genres: (d.genres || []).map(withLevel).join(', ') })));
    }
    const tl = setRes.data?.timeline;
    if (tl && bmeta().hours) {
      const rec = reconcileTimeline(tl, bmeta().hours);
      console.log('Option 2 energy timeline (dot → level on this profile\'s scale):');
      for (const g of rec.groups) {
        console.log(`  ${groupDaysLabel(g.days)} ${g.open}–${g.close}: ` + g.points.map((p) => `${fmtHM(p.m)} → ${p.e} (L${levelOf(p.e, N)})`).join(' · '));
      }
    }
    const lvl = lvlRes.data || [];
    if (lvl.length) {
      const fits = tp && lvl.every((d) => d.profile_key === levelProfileKey(tp));
      console.log(`Option 2 level directions (${lvl.length}; ${fits ? 'built from the current taste profile' : 'built from an OLDER taste profile — regenerated on the next switch to Option 2'}). Each day every level plays one of its directions per mix, then moves on to the next:`);
      console.table(lvl.map((d) => ({ level: `L${d.energy_level}`, rank: d.rank, title: d.title_en, genres: (d.genres || []).join(', ') })));
      if (bmeta().hours) {
        const lib = new Map();
        for (const d of lvl) (lib.get(d.energy_level) || lib.set(d.energy_level, []).get(d.energy_level)).push(d);
        const isoDate = businessWindowAt(bmeta().hours, new Date()).isoDate;
        const picks = pickLevelDirections(lib, isoDate);
        console.log(`Today's picks (${isoDate}):`);
        picks.forEach((m, i) => console.log(`  Daily Mix #${i + 1}: ` + [...m].sort((a, b) => a[0] - b[0]).map(([L, d]) => `L${L} ${d.title_en}`).join(' · ')));
      }
    }

    const today = (bmeta().playlists || []).filter((p) => p && !p.eventId && playlistIsLive(p));
    if (today.length) {
      console.log(`Live daily playlists (${today.length}):`);
      for (const p of today) {
        const t = p.expansion?.v7_timeline;
        if (!t || !Array.isArray(t.starts)) {
          console.log(`  ${p.label} — ${p.trackCount} tracks — genres: ${(p.genres || []).map(withLevel).join(', ')}`);
          continue;
        }
        // Option 2: collapse consecutive tracks with the same level + genre into runs.
        const runs = [];
        t.starts.forEach((start, i) => {
          const last = runs[runs.length - 1];
          if (last && last.level === t.levels[i] && last.genre === t.run_genres[i]) last.tracks++;
          else runs.push({ from: fmtHM(start), level: t.levels[i], genre: t.run_genres[i], tracks: 1 });
        });
        console.groupCollapsed(`  ${p.label} — ${p.trackCount} tracks, ${fmtHM(t.window[0])}–${fmtHM(t.window[1])}, ${runs.length} genre runs`);
        if (t.directions) {
          console.log('  Directions per level: ' + Object.entries(t.directions).map(([L, d]) => `L${L} ${d.title_en} [${d.genres.join(', ')}]`).join(' · '));
        } else {
          console.log('  Every genre of each level (no level-direction library at build time).');
        }
        console.table(runs.map((r) => ({ from: r.from, level: `L${r.level}`, genre: r.genre, tracks: r.tracks })));
        console.groupEnd();
      }
    }
    console.groupEnd();
  } catch (e) {
    console.warn('[Rubin testing] taste log failed:', e?.message || e);
  }
}

// v7 first-login delivery-mode gate. Reads business_v7_settings.delivery_mode
// client-direct (owner-scoped RLS SELECT). If already chosen, resolves at once.
// If null, shows the blocking #v7ModeGate overlay and resolves only after the
// owner picks Option 1 / Option 2 and the choice persists. Fails open (skips
// the gate) if the read errors or the markup is missing, so a transient DB
// hiccup never traps the owner on a blank overlay.
// Returns true ONLY when the owner just picked a mode in the gate (first
// login) — the caller then builds today's playlists right away.
async function checkV7ModeGate() {
  let mode = null;
  try {
    const { data } = await sb.from('business_v7_settings')
      .select('delivery_mode,timeline')
      .eq('business_id', business.id)
      .maybeSingle();
    mode = data?.delivery_mode || null;
    state.timeline = data?.timeline || null;
  } catch (e) {
    console.warn('v7 mode gate read failed:', e?.message || e);
    return false;
  }
  setDeliveryModeState(mode);
  if (mode === 'option1') {
    // Option 1 is only buildable once energy-tiered directions exist. If a
    // previous build failed (or the tab closed mid-build), flag it so the
    // Profile tab tells the owner and lets a click on Option 1 retry —
    // otherwise the cron skips this business every day as no-directions.
    try {
      const { count } = await sb.from('business_v7_directions')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .eq('active', true);
      state.energyBuildFailed = !count;
    } catch (e) {
      console.warn('v7 energy-directions check failed:', e?.message || e);
    }
  }
  if (mode === 'option2') {
    // Option 2 still builds without its level directions (every genre of the
    // level), but flag a missing library so the Profile tab offers a retry.
    // A read error (e.g. the table isn't there yet) leaves the flag off.
    try {
      const { count, error } = await sb.from('business_v7_level_directions')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .eq('active', true);
      if (!error) state.levelBuildFailed = !count;
    } catch (e) {
      console.warn('v7 level-directions check failed:', e?.message || e);
    }
  }
  if (mode) return false;

  const gate = $('v7ModeGate');
  const err  = $('v7ModeErr');
  const opt1 = $('v7ModeOption1');
  const opt2 = $('v7ModeOption2');
  const building = $('v7ModeBuilding');
  if (!gate || !opt1 || !opt2) return false;

  await new Promise((resolve) => {
    let busy = false;
    const pick = async (choice) => {
      if (busy) return;
      busy = true;
      err?.classList.add('hide');
      opt1.disabled = true;
      opt2.disabled = true;
      try {
        await setDeliveryMode(choice);
        setDeliveryModeState(choice);
        // Option 1 needs energy-tiered directions before the cron can build.
        // Generate + persist them now (best-effort) while keeping the owner on
        // the gate with a spinner, so a mid-generation tab close is unlikely.
        if (choice === 'option1') {
          building?.classList.remove('hide');
          const ok = await buildEnergyDirections();
          building?.classList.add('hide');
          state.energyBuildFailed = !ok;
          if (!ok) {
            // The mode is saved, but without energy directions the cron
            // can't build Option 1. Keep the gate open so the owner can
            // retry (click Option 1 again) or switch to Option 2.
            if (err) { err.textContent = 'לא הצלחנו להכין את הפלייליסטים שלכם. נסו שוב או בחרו באפשרות השנייה.'; err.classList.remove('hide'); }
            opt1.disabled = false;
            opt2.disabled = false;
            busy = false;
            return;
          }
        }
        gate.classList.add('hide');
        resolve();
      } catch (e) {
        console.error('setDeliveryMode:', e);
        building?.classList.add('hide');
        if (err) { err.textContent = 'משהו השתבש. נסו שוב.'; err.classList.remove('hide'); }
        opt1.disabled = false;
        opt2.disabled = false;
        busy = false;
      }
    };
    // Option 2 → the energy-timeline modal first (stacked above the gate).
    // Saving it IS choosing Option 2 (mode + timeline in one POST); "חזרה"
    // returns to the gate to choose again. Then the per-level directions are
    // prepared (a new account always generates them) under the gate's
    // "מכינים את הכיוונים המוזיקליים…" line. A failed build doesn't hold the
    // owner here: Option 2 still builds without it (every genre of the
    // level), and the Profile tab offers the retry.
    const pickOption2 = async () => {
      if (busy) return;
      busy = true;
      err?.classList.add('hide');
      const r = await openTimelineModal({
        context: 'gate',
        onSave: async (timeline) => {
          const data = await setDeliveryMode('option2', timeline);
          setDeliveryModeState('option2');
          state.timeline = data.timeline || timeline;
          return {};
        },
      });
      if (!r.saved) { busy = false; return; }
      await showShuffleWarning();
      opt1.disabled = true;
      opt2.disabled = true;
      const { ok } = await ensureLevelDirections({ onGenerate: () => building?.classList.remove('hide') });
      building?.classList.add('hide');
      state.levelBuildFailed = !ok;
      busy = false;
      gate.classList.add('hide');
      resolve();
    };
    opt1.addEventListener('click', () => pick('option1'));
    opt2.addEventListener('click', pickOption2);
    gate.classList.remove('hide');
  });
  return true;
}

// ---------- Option-2 energy timeline (modal) ----------
// One modal (#timelineModal) for every place the owner edits the timeline:
// the first-login gate (choosing Option 2), the Profile tab's "עריכת ציר
// האנרגיה", and the Profile tab's Option 1 → 2 switch (mandatory there — the
// type only switches on save). The editor is the sandbox-approved one
// (energy-timeline-editor.js); one timeline per opening-hours group, shown as
// tabs when the week has more than one schedule. Step 2 of the same modal
// asks whether to replace today's playlists now (Profile tab only).
let timelineEditor = null;

// Grid rows = the taste profile's energy levels (never shown to the owner).
async function loadEnergyLevels() {
  if (state.energyLevels) return state.energyLevels;
  try {
    const { data } = await sb.from('business_taste_profiles')
      .select('energy_levels_total')
      .eq('business_id', business.id)
      .maybeSingle();
    state.energyLevels = normLevels(data?.energy_levels_total);
  } catch {
    state.energyLevels = normLevels(null);
  }
  return state.energyLevels;
}

async function postTimeline(timeline) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('לא מחוברים');
  const r = await fetch('/api/v7/account/update-timeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ business_id: business.id, timeline }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
  return data;
}

function showTimelineStep(step) {
  $('tlStepEdit')?.classList.toggle('hide', step !== 'edit');
  $('tlStepReplace')?.classList.toggle('hide', step !== 'replace');
}

function closeTimelineModal() {
  $('timelineModal')?.classList.add('hide');
}

// Step 2: "replace today's playlists now, or keep them until closing?" with
// the daily cap (2) made visible. `replace` = the server's replaceStatus
// ({ eligible, left, cap }). Resolves true = replace now.
function askReplaceStep(replace) {
  return new Promise((resolve) => {
    showTimelineStep('replace');
    const cap = $('tlReplaceCap');
    const nowBtn = $('tlReplaceNow');
    const keepBtn = $('tlReplaceKeep');
    const left = Number(replace?.left ?? 0);
    const max = Number(replace?.cap || 2);
    const atMax = left <= 0;
    cap.classList.toggle('max', atMax);
    // One line with the daily limit and what's left (Roni, 2026-10-13); the
    // taste chat asks through this same step.
    cap.textContent = atMax
      ? `הגעתם למקסימום של ${max} החלפות ביום — השינוי ייכנס לתוקף מחר.`
      : `אפשר להחליף את הפלייליסטים עד ${max === 2 ? 'פעמיים' : `${max} פעמים`} ביום · נותרו היום: ${left}`;
    nowBtn.disabled = atMax;
    keepBtn.textContent = atMax ? 'הבנתי' : 'השאירו עד סגירה';
    nowBtn.onclick = () => resolve(true);
    keepBtn.onclick = () => resolve(false);
  });
}

// Replace question on its own (type switch 2 → 1, which has no timeline step).
async function askReplaceToday(replace) {
  $('timelineModal').classList.remove('hide');
  const now = await askReplaceStep(replace);
  closeTimelineModal();
  return now;
}

// Mini preview of today's curve for the Profile tab's edit button.
function renderTimelineSpark() {
  const svg = $('deliveryTimelineSpark');
  if (!svg) return;
  const hours = bmeta().hours;
  const tl = reconcileTimeline(state.timeline, hours);
  const g = groupForDay(tl, todayDayIdx()) || tl.groups[0];
  if (!g) { svg.innerHTML = ''; return; }
  const { openMin, total } = windowOf(g);
  const f = energyAtFn(g.points);
  const W = 72, H = 26, P = 3;
  let d = '';
  for (let k = 0; k <= 36; k++) {
    const x = P + (k / 36) * (W - 2 * P);          // opening on the left
    const y = H - P - f(openMin + (k / 36) * total) * (H - 2 * P);
    d += `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  svg.innerHTML =
    `<defs><linearGradient id="tlSparkGrad" x1="0" x2="0" y1="${P}" y2="${H - P}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0%" stop-color="${energyColor(1)}"/><stop offset="50%" stop-color="${energyColor(.5)}"/>` +
    `<stop offset="100%" stop-color="${energyColor(0)}"/></linearGradient></defs>` +
    `<path d="${d}L${W - P},${H - P}L${P},${H - P}Z" fill="url(#tlSparkGrad)" fill-opacity=".22"/>` +
    `<path d="${d}" fill="none" stroke="url(#tlSparkGrad)" stroke-width="2" stroke-linecap="round"/>`;
}

// Open the editor. `onSave(timeline)` persists it (throws → error shown in
// the modal, which stays open) and returns the server response; when that
// carries replace.eligible (Profile tab), step 2 asks about today's
// playlists. Resolves once the modal closes:
//   { saved:false }                       cancelled / "חזרה"
//   { saved:true, replaceNow, result }    saved (replaceNow → caller rebuilds today)
// `hint` (the taste chat, 2026-10-13): { time: 'HH:MM', direction: 'up'|'down' }
// — today's curve opens already moved one level at that time (nudgePoints);
// the owner saves it or not.
function openTimelineModal({ context, onSave, hint = null }) {
  return new Promise(async (resolve) => {
    const modal = $('timelineModal');
    const saveBtn = $('tlSave');
    const cancelBtn = $('tlCancel');
    const errEl = $('tlErr');
    const tabs = $('tlTabs');
    const empty = $('tlEmpty');
    const hours = bmeta().hours;
    const groups = reconcileTimeline(state.timeline, hours).groups.map((g) => ({ ...g, points: g.points.map((p) => ({ ...p })) }));
    const N = await loadEnergyLevels();
    let active = Math.max(0, groups.findIndex((g) => g.days.includes(todayDayIdx())));
    if (hint && groups[active]) {
      const g = groups[active];
      let m = parseHM(hint.time);
      if (Number.isFinite(m)) {
        if (m < windowOf(g).openMin) m += 1440;   // after midnight, on an overnight day
        g.points = nudgePoints(g.points, g, m, hint.direction, N);
      }
    }

    const loadActive = () => {
      const g = groups[active];
      const opts = { group: g, N, points: g.points, openRight: false };
      if (!timelineEditor) timelineEditor = new TimelineEditor($('tlEditor'), opts);
      else timelineEditor.load(opts, { silent: true });
    };
    const paintTabs = () => {
      tabs.classList.toggle('hide', groups.length < 2);
      tabs.innerHTML = groups.map((g, i) =>
        `<button type="button" role="tab" aria-selected="${i === active}" class="tl-tab${i === active ? ' on' : ''}" data-i="${i}">` +
        `<span class="tl-tab-days">${escHtml(groupDaysLabel(g.days))}</span>` +
        `<span class="tl-tab-hours"><bdi dir="ltr">${escHtml(g.open)}–${escHtml(g.close)}</bdi></span></button>`).join('');
    };
    tabs.onclick = (e) => {
      const b = e.target.closest('.tl-tab');
      if (!b || !timelineEditor) return;
      groups[active].points = timelineEditor.getPoints();
      active = Number(b.dataset.i);
      loadActive();
      paintTabs();
    };

    showTimelineStep('edit');
    errEl.classList.add('hide');
    empty.classList.toggle('hide', groups.length > 0);
    $('tlEditor').classList.toggle('hide', !groups.length);
    saveBtn.disabled = !groups.length;
    saveBtn.textContent = 'שמירה';
    cancelBtn.textContent = context === 'gate' ? 'חזרה' : 'ביטול';
    paintTabs();
    modal.classList.remove('hide');
    if (groups.length) {
      loadActive();
      requestAnimationFrame(() => timelineEditor?.relayout());   // measure now that it's visible
    }

    cancelBtn.onclick = () => {
      closeTimelineModal();
      resolve({ saved: false });
    };
    saveBtn.onclick = async () => {
      groups[active].points = timelineEditor.getPoints();
      const timeline = { version: 2, groups };
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      setWaitText(saveBtn, 'שומרים…');
      errEl.classList.add('hide');
      let result;
      try {
        result = await onSave(timeline);
      } catch (e) {
        console.error('timeline save:', e);
        errEl.textContent = e?.message || 'שגיאה בשמירה — נסו שוב';
        errEl.classList.remove('hide');
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = 'שמירה';
        return;
      }
      cancelBtn.disabled = false;
      renderTimelineSpark();
      let replaceNow = false;
      if (context !== 'gate' && result?.replace?.eligible) replaceNow = await askReplaceStep(result.replace);
      closeTimelineModal();
      resolve({ saved: true, replaceNow, result });
    };
  });
}

// "החליפו עכשיו": show the Home tab and rebuild today's set from now.
function runReplaceToday() {
  switchTab('Home');
  runGenerateDaily({ replaceToday: true });
}

// The taste chat's curve suggestion: the editor opens with the change ready;
// saving runs the usual save + "replace today's playlists?" step.
async function editTimelineWithHint(hint) {
  const r = await openTimelineModal({
    context: 'edit',
    hint,
    onSave: async (timeline) => {
      const data = await postTimeline(timeline);
      state.timeline = data.timeline || timeline;
      return data;
    },
  });
  if (r.saved && r.replaceNow) runReplaceToday();
  return r;
}

// The owner's instrumental / well-known preferences — the taste chat's
// sample songs follow them, like the onboarding swipe deck's.
async function loadTastePrefs() {
  try {
    const { data } = await sb.from('business_taste_profiles')
      .select('instrumentalness_preference,popularity_preference')
      .eq('business_id', business.id)
      .maybeSingle();
    state.tastePrefs = { inst: data?.instrumentalness_preference || 'none', pop: data?.popularity_preference || 'none' };
  } catch { /* the samples go without preferences */ }
}

// Whenever Option 2 is chosen (Roni, 2026-10-13): the mixes follow the
// curve song by song, so shuffle (and Smart Shuffle) must be off and each
// mix starts from its first song at opening. Resolves on "הבנתי".
function showShuffleWarning() {
  return new Promise((resolve) => {
    const m = $('shuffleModal');
    const ok = $('shuffleOk');
    if (!m || !ok) { resolve(); return; }
    ok.onclick = () => { m.classList.add('hide'); resolve(); };
    m.classList.remove('hide');
  });
}

// Status line after a save that didn't (or couldn't) replace today's set.
function savedNote(replace, replaceNow) {
  if (replaceNow) return 'נשמר ✓ — בונים פלייליסטים חדשים בדף הבית';
  if (replace?.eligible) return '✓ השינוי ייכנס לתוקף מחר';
  if (replace?.reason === 'past-close' || replace?.reason === 'closed-today') return 'נשמר ✓ — השינוי ייכנס לתוקף מחר';
  return 'נשמר ✓';
}

// POST the chosen delivery mode (+ Option 2's timeline). Returns the server
// response: { ok, delivery_mode, timeline, replace }.
async function setDeliveryMode(mode, timeline) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('לא מחוברים');
  const body = { business_id: business.id, delivery_mode: mode };
  if (timeline) body.timeline = timeline;
  const r = await fetch('/api/v7/account/set-delivery-mode', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
  return data;
}

// Option-1 energy-directions build. callModel in v7/generation/ai-provider.js
// does a RELATIVE fetch to /api/v6/gemini, so generation runs in the browser
// (same as R1/R2/taste-profile did during onboarding). The result is POSTed to
// save-energy-directions.js, which replaces the business's active
// business_v7_directions rows. BEST-EFFORT: every failure is logged, never
// thrown — the delivery-mode POST already succeeded, and re-picking Option 1
// retries. Returns true only on a successful persist.
// Shown under "מכינים את הכיוונים המוזיקליים…" while buildEnergyDirections
// runs (Profile tab; the first-login gate has the same line in index.html).
// Large taste profiles take up to ~70s, and closing the tab loses the build.
const ENERGY_BUILD_WAIT_NOTE = 'עלול לארוך עד דקה וחצי, נא לא לסגור את החלון...';

async function buildEnergyDirections() {
  try {
    // '*' rather than a column list: requested_genres (the genres that go into
    // every direction of their tier) is read when the column exists, and the
    // read still works before migration 2026-10-05-v7-requested-genres.sql.
    const { data: tp } = await sb.from('business_taste_profiles')
      .select('*')
      .eq('business_id', business.id)
      .maybeSingle();
    if (!tp?.approved_genres?.length) {
      console.warn('buildEnergyDirections: no taste profile / approved genres — skipping');
      return false;
    }

    const result = await generateEnergyDirections({
      tasteProfile: tp,
      bizName: business.name || '',
      bizDesc: business.business_description || '',
      atmospheres: meta.onboarding?.atmospheres || [],
      musicalEmphases: business.musical_emphases || '',
      place: bmeta().place || null,
      businessId: business.id,
    });
    if (result?.error || !Array.isArray(result?.directions) || !result.directions.length) {
      console.warn('buildEnergyDirections: generation returned no directions', result?.error || '');
      return false;
    }

    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) { console.warn('buildEnergyDirections: no session'); return false; }
    const r = await fetch('/api/v7/account/save-energy-directions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ business_id: business.id, directions: result.directions }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { console.warn('buildEnergyDirections: persist failed', data?.error || r.status); return false; }
    console.log(`buildEnergyDirections: saved ${data.count} directions`);
    return true;
  } catch (e) {
    console.warn('buildEnergyDirections failed:', e?.message || e);
    return false;
  }
}

// Option-2 level directions: a library of directions per energy level (each
// day every level plays one direction per mix — v7/generation/level-
// directions.js, rotation in timeline-assembler.js). Kept across type
// switches: when the stored library was built from the same taste profile
// (same genres at the same levels — levelProfileKey), it's reused with no
// Gemini call; otherwise it's generated in the browser (like Option 1's) and
// POSTed to save-level-directions.js, which replaces the stored set.
// onGenerate() fires just before a generation starts, so callers show the
// "מכינים את הכיוונים המוזיקליים…" wait only when there's a wait.
// BEST-EFFORT: never throws. → { ok, generated }
async function ensureLevelDirections({ onGenerate } = {}) {
  try {
    const [{ data: tp }, stored] = await Promise.all([
      sb.from('business_taste_profiles')
        .select('approved_genres,energy_levels_total')
        .eq('business_id', business.id)
        .maybeSingle(),
      sb.from('business_v7_level_directions')
        .select('profile_key')
        .eq('business_id', business.id)
        .eq('active', true),
    ]);
    if (!tp?.approved_genres?.length) {
      console.warn('ensureLevelDirections: no taste profile / approved genres — skipping');
      return { ok: false, generated: false };
    }
    const key = levelProfileKey(tp);
    const rows = stored?.error ? [] : (stored?.data || []);
    if (rows.length && rows.every((r) => r.profile_key === key)) {
      console.log(`ensureLevelDirections: reusing the ${rows.length} stored directions (taste profile unchanged)`);
      return { ok: true, generated: false };
    }

    onGenerate?.();
    const result = await generateLevelDirections({
      tasteProfile: tp,
      bizName: business.name || '',
      bizDesc: business.business_description || '',
      atmospheres: meta.onboarding?.atmospheres || [],
      musicalEmphases: business.musical_emphases || '',
      place: bmeta().place || null,
      businessId: business.id,
    });
    if (result?.error || !Array.isArray(result?.directions) || !result.directions.length) {
      console.warn('ensureLevelDirections: generation returned no directions', result?.error || '');
      return { ok: false, generated: true };
    }

    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) { console.warn('ensureLevelDirections: no session'); return { ok: false, generated: true }; }
    const r = await fetch('/api/v7/account/save-level-directions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ business_id: business.id, directions: result.directions }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { console.warn('ensureLevelDirections: persist failed', data?.error || r.status); return { ok: false, generated: true }; }
    console.log(`ensureLevelDirections: saved ${data.count} directions`);
    return { ok: true, generated: true };
  } catch (e) {
    console.warn('ensureLevelDirections failed:', e?.message || e);
    return { ok: false, generated: false };
  }
}

// The direction-edit chat fires this custom event after any successful
// commit (add/edit/remove). Reload the dashboard's dashboard-data mirror
// so the Home tab's playlist list picks up the newly-built playlist,
// removes the expired one, etc., without a page refresh.
document.addEventListener('direction-change-applied', async (e) => {
  if (!business || e.detail?.businessId !== business.id) return;
  try {
    await loadDashboardData(business.id);
    renderPlaylistsTitle();
    renderPlaylists();
  } catch (err) {
    console.warn('post direction-change reload failed:', err);
  }
});

// Businesses table read — includes onboarding_expanded (moved off user_metadata
// in the tables migration), used by expandPendingPlaylists as its one-time gate.
async function loadBusinesses() {
  const { data } = await sb.from('businesses')
    .select('id,owner_id,name,monthly_credits,credits_remaining,onboarding_expanded,business_description,musical_emphases,created_at')
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
//   Normal (open day OR closed day with playlists for today OR closed day
//   during a manual generate in progress):
//     "🎵 הפלייליסטים היומיים שלכם - יום א' - dd/mm/yy"
//   Closed day, no playlists for today AND no generate in flight:
//     "🎵 יום ש' - המקום סגור   [המקום פתוח?]"   ← link opens the generate popup
//
// The `state.generating` override flips the closed-day title to normal the
// instant the owner clicks generate, rather than waiting for the first
// playlist to land in business_playlists — otherwise the "המקום סגור"
// title would stay onscreen (and the "המקום פתוח?" link would remain
// clickable for a second duplicate build) while placeholders build.
function renderPlaylistsTitle() {
  const h = $('playlistsTitle');
  if (!h) return;
  h.replaceChildren();

  const ico = document.createElement('span');
  ico.className = 'h-ico';
  ico.textContent = '🎵';
  h.append(ico);

  const dayLetter = HE_DAY_LETTERS[todayDayIdx()];
  const dateStr = todayDdMmYy();

  if (todayIsClosed() && !hasPlaylistsForToday() && !state.generating) {
    h.append(document.createTextNode(`יום ${dayLetter}' - המקום סגור`));
    const openLink = document.createElement('a');
    openLink.href = '#';
    openLink.className = 'closed-open-link';
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
  $('acctEmail').textContent = user?.email || '';
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
// Two independent snapshots so name and hours each dirty-track against
// their own last-saved value. The name row and the hours section have
// separate save/cancel controls now — no single "save profile" button.
let nameSnapshot = '';
let hoursSnapshot = '';

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

// Open the "חידודים מוזיקליים" card on the Home tab (used by the per-playlist
// edit icon — which v7 rows never show, since they carry no direction_id).
function openDirectionsSection() {
  switchTab('Home');
  const toggle = $('directionsToggle');
  toggle?.setAttribute('aria-expanded', 'true');
  $('directionsBody')?.classList.remove('hide');
  toggle?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  openDirectionChat();
}

function renderProfileTab() {
  const nameInput = $('profileBizName');
  nameInput.value = business?.name || '';
  nameSnapshot = (nameInput.value || '').trim();
  $('nameMsg').textContent = '';

  const savedHours = bmeta().hours;
  hoursEditor = mountHoursEditor($('hoursHost'), {
    prechecked: savedHours ? { hours: savedHours } : null,
    onChange: () => updateSaveHoursButton(),
  });
  hoursSnapshot = JSON.stringify(hoursEditor.getPayload().hours);
  $('hoursMsg').textContent = '';

  nameInput.oninput = () => updateNameActions();
  // Enter saves the name (when dirty + non-empty); Esc reverts to the
  // last-saved value. Only wired on the input itself so it doesn't clash
  // with keyboard interactions inside the hours editor below.
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (isNameDirty() && nameInput.value.trim()) saveName(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelName(); }
  };
  updateNameActions();
  updateSaveHoursButton();
  renderDeliverySection();
  renderSubscriptionSection();
  loadSubscription();   // refresh (dates move on; a cancellation may have run out)

  $('passwordUser').value = user?.email || '';
  $('currentPassword').value = '';
  $('nextPassword').value = '';
  $('passwordMsg').textContent = '';

  // Reset every collapsible Profile section to closed on each tab open.
  // The hours editor above stays mounted so its dirty-tracking + save-state
  // are ready the moment the owner expands.
  document.querySelectorAll('#tabProfile .hours-toggle').forEach((toggle) => {
    const body = document.getElementById(toggle.getAttribute('aria-controls'));
    toggle.setAttribute('aria-expanded', 'false');
    body?.classList.add('hide');
  });
}

// v7 daily-playlist type (Profile tab). Reflects state.deliveryMode on the two
// cards and shows "עריכת ציר האנרגיה" on Option 2. onclick is reassigned on
// every render (idempotent — no listener stacking across tab re-opens).
//   Option 1 → 2: the timeline modal is MANDATORY — the type only switches
//                 when the owner saves a timeline; cancel keeps Option 1.
//   Option 2 → 1: regenerates the energy-tiered directions (as before).
//   → Option 2:   after the timeline is saved, prepares the per-level
//                 directions (ensureLevelDirections — reused when the taste
//                 profile hasn't changed since they were built, else ~1 min
//                 of generation), then any "replace now" build.
//   Either switch, and every timeline save, then asks whether to replace
//   today's playlists now (only when today has a live set — see
//   api/v7/account/_replace-status.js — and at most 2 times a day).
function renderDeliverySection() {
  const opt1 = $('deliveryOpt1');
  const opt2 = $('deliveryOpt2');
  const editBtn = $('deliveryTimelineEdit');
  const msg = $('deliveryMsg');
  if (!opt1 || !opt2) return;

  const paint = (mode) => {
    opt1.classList.toggle('selected', mode === 'option1');
    opt2.classList.toggle('selected', mode === 'option2');
    editBtn?.classList.toggle('hide', mode !== 'option2');
    if (mode === 'option2') renderTimelineSpark();
  };
  const setMsg = (text, kind) => {
    if (!msg) return;
    msg.style.color = kind === 'err' ? '#ff9b8a' : kind === 'ok' ? 'var(--teal-soft)' : '';
    setWaitText(msg, text);
  };
  const lock = (on) => {
    opt1.disabled = on;
    opt2.disabled = on;
    if (editBtn) editBtn.disabled = on;
  };
  paint(state.deliveryMode);
  setMsg('');
  if (state.deliveryMode === 'option1' && state.energyBuildFailed) {
    setMsg('הכנת הפלייליסטים לא הושלמה — לחצו על האפשרות הראשונה כדי לנסות שוב', 'err');
  }
  if (state.deliveryMode === 'option2' && state.levelBuildFailed) {
    setMsg('הכנת הפלייליסטים לא הושלמה — לחצו על האפשרות השנייה כדי לנסות שוב', 'err');
  }

  // Option 2's per-level directions (see ensureLevelDirections). The wait
  // message shows only when they're actually generated. → ok
  const prepareLevelDirections = async (replaceNow) => {
    const { ok } = await ensureLevelDirections({
      onGenerate: () => setMsg((replaceNow
        ? 'מכינים את הפלייליסטים החדשים שלכם…'
        : 'מכינים את הפלייליסטים שלכם…') + '\n' + ENERGY_BUILD_WAIT_NOTE),
    });
    state.levelBuildFailed = !ok;
    return ok;
  };

  const afterModal = (r) => {
    if (!r.saved) return;
    setMsg(savedNote(r.result?.replace, r.replaceNow), 'ok');
    if (r.replaceNow) runReplaceToday();
  };

  const chooseOption1 = async () => {
    // Re-clicking is a no-op — except after a failed energy-directions build,
    // where the click IS the retry.
    if (state.deliveryMode === 'option1' && !state.energyBuildFailed) return;
    const prev = state.deliveryMode;
    lock(true);
    setMsg('שומרים…');
    paint('option1'); // optimistic — the ✓ moves at once
    try {
      const data = await setDeliveryMode('option1');
      setDeliveryModeState('option1');
      // 2 → 1: ask about today's playlists RIGHT AWAY — the same question as
      // the 1 → 2 switch — not after the directions build below (a Gemini
      // call of ~a minute), which also must not swallow the question if it
      // fails.
      let replaceNow = false;
      if (prev === 'option2' && data.replace?.eligible) replaceNow = await askReplaceToday(data.replace);
      // Choosing Option 1 regenerates the energy-tiered directions (the
      // persist endpoint replace-existing DELETEs the old set first). Option 1
      // can't build without them, so a replacement waits for this.
      setMsg((replaceNow
        ? 'מכינים את הפלייליסטים החדשים שלכם…'
        : 'מכינים את הפלייליסטים שלכם…') + '\n' + ENERGY_BUILD_WAIT_NOTE);
      const ok = await buildEnergyDirections();
      state.energyBuildFailed = !ok;
      if (!ok) {
        setMsg(replaceNow
          ? 'הכנת הפלייליסטים לא הושלמה, ולכן הפלייליסטים של היום לא הוחלפו — לחצו שוב על האפשרות הראשונה'
          : 'הכנת הפלייליסטים לא הושלמה — לחצו שוב על האפשרות הראשונה', 'err');
        return;
      }
      setMsg(savedNote(prev === 'option2' ? data.replace : null, replaceNow), 'ok');
      if (replaceNow) runReplaceToday();
    } catch (e) {
      console.error('renderDeliverySection option1:', e);
      setDeliveryModeState(prev);
      paint(prev);
      setMsg('שגיאה בשמירה — נסו שוב', 'err');
    } finally {
      lock(false);
    }
  };

  const chooseOption2 = async () => {
    // Re-clicking is a no-op — except after a failed level-directions build,
    // where the click IS the retry (directions only; the timeline stays).
    if (state.deliveryMode === 'option2') {
      if (!state.levelBuildFailed) return;
      lock(true);
      try {
        const ok = await prepareLevelDirections(false);
        setMsg(ok ? 'ההכנה הושלמה ✓' : 'הכנת הפלייליסטים לא הושלמה — לחצו שוב על האפשרות השנייה', ok ? 'ok' : 'err');
      } finally {
        lock(false);
      }
      return;
    }
    lock(true);
    setMsg('');
    try {
      const r = await openTimelineModal({
        context: 'switch',
        onSave: async (timeline) => {
          const data = await setDeliveryMode('option2', timeline);
          setDeliveryModeState('option2');
          state.timeline = data.timeline || timeline;
          state.energyBuildFailed = false;
          return data;
        },
      });
      if (!r.saved) return;            // cancelled → still Option 1
      paint('option2');
      await showShuffleWarning();
      // The level directions come before any "replace now" build, which
      // plays from them. If they fail, the replacement still runs — Option 2
      // builds without them (every genre of each level).
      if (!await prepareLevelDirections(r.replaceNow)) {
        setMsg(r.replaceNow
          ? 'הכנת הפלייליסטים לא הושלמה (לחצו שוב על האפשרות השנייה) — בונים בינתיים את הפלייליסטים של היום בדף הבית'
          : 'הכנת הפלייליסטים לא הושלמה — לחצו שוב על האפשרות השנייה', 'err');
        if (r.replaceNow) runReplaceToday();
        return;
      }
      afterModal(r);
    } finally {
      lock(false);
    }
  };

  const editTimeline = async () => {
    lock(true);
    setMsg('');
    try {
      const r = await openTimelineModal({
        context: 'edit',
        onSave: async (timeline) => {
          const data = await postTimeline(timeline);
          state.timeline = data.timeline || timeline;
          return data;
        },
      });
      afterModal(r);
    } finally {
      lock(false);
    }
  };

  opt1.onclick = chooseOption1;
  opt2.onclick = chooseOption2;
  if (editBtn) editBtn.onclick = editTimeline;
}

// ---------- subscription (Profile → מנוי, 2026-10-06) ----------
// The monthly subscription (Hyp recurring agreement): status, price, next
// charge, invoice details, cancel (two steps + optional reason) and resume
// (only until the paid month runs out). Shown only while real payments are on
// and this account has a paid subscription — GET /api/v7/account/subscription
// answers { paymentsEnabled, subscription }. Once a cancelled subscription has
// run out, the Home tab shows #subEndedBanner (the server then refuses builds).
state.subscription = null;
state.subscriptionLoaded = false;   // false until the first answer arrives

// Whether this account had the section last time, per device — so the section
// shows at once on the next visit (a spinner inside until the details load)
// instead of popping in a second later. Unknown → shown, then hidden if the
// answer says there's no subscription.
const SUB_VISIBLE_KEY = 'rubin-v7-sub-visible:';
function rememberedSubVisible() {
  try { return localStorage.getItem(SUB_VISIBLE_KEY + business.id); } catch { return null; }
}
function rememberSubVisible(visible) {
  try { localStorage.setItem(SUB_VISIBLE_KEY + business.id, visible ? '1' : '0'); } catch { /* private mode */ }
}

const heDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
// The day before a 'YYYY-MM-DD' date (the last day of service before a charge date).
function dayBefore(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

async function subscriptionRequest(method, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('לא מחוברים');
  const url = method === 'GET'
    ? `/api/v7/account/subscription?business_id=${encodeURIComponent(business.id)}`
    : '/api/v7/account/subscription';
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    ...(body ? { body: JSON.stringify({ business_id: business.id, ...body }) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
  return data;
}

// One request at a time: a second call while one is in flight shares it.
let subscriptionLoad = null;
function loadSubscription() {
  if (!business) return Promise.resolve();
  if (subscriptionLoad) return subscriptionLoad;
  subscriptionLoad = (async () => {
    try {
      const data = await subscriptionRequest('GET');
      state.subscription = data.paymentsEnabled ? (data.subscription || null) : null;
      rememberSubVisible(!!state.subscription);
    } catch (e) {
      console.warn('loadSubscription:', e?.message || e);
      state.subscription = null;
    } finally {
      state.subscriptionLoaded = true;
      subscriptionLoad = null;
      renderSubscriptionSection();
      // The Home line's "חדשו את המנוי" link needs the subscription too.
      if (state.dailyStatus?.reason === 'subscription-ended' && !state.generating) renderPlaylists();
    }
  })();
  return subscriptionLoad;
}

function setSubMsg(text, kind) {
  const msg = $('subMsg');
  if (!msg) return;
  msg.style.color = kind === 'err' ? '#ff9b8a' : kind === 'ok' ? 'var(--teal-soft)' : '';
  setWaitText(msg, text);
}

function renderSubscriptionSection() {
  if (!business) return;
  if (!state.subscriptionLoaded) {
    // Still loading: show the section (unless this device knows there's
    // none) with a spinner inside, in case the owner opens it.
    $('subscriptionSection')?.classList.toggle('hide', rememberedSubVisible() === '0');
    const spin = document.createElement('div');
    spin.className = 'sub-loading';
    spin.innerHTML = '<span class="sb-spinner" aria-label="טוען"></span>';
    $('subRows').replaceChildren(spin);
    for (const id of ['subCancel', 'subConfirm', 'subResume', 'subRenew']) $(id)?.classList.add('hide');
    setSubMsg('');
    return;
  }
  const sub = state.subscription;
  $('subscriptionSection')?.classList.toggle('hide', !sub);
  const banner = $('subEndedBanner');
  if (banner) {
    banner.classList.toggle('hide', sub?.status !== 'ended');
    banner.replaceChildren();
    if (sub?.status === 'ended') {
      banner.append(`המנוי שלכם הסתיים ב־${heDate(sub.lastDay)}, ולכן לא נבנים יותר פלייליסטים חדשים. `,
        renewLink());
    }
  }
  if (!sub) return;

  const statusText = { active: 'פעיל', cancelled: 'בוטל', ended: 'הסתיים' }[sub.status] || '';
  const rows = [['סטטוס', statusText]];
  if (sub.status === 'active') {
    rows.push(['מחיר', `₪${sub.amountMonthly} לחודש`]);
    rows.push(['החיוב הבא', `${heDate(sub.nextChargeOn)} · ₪${sub.amountMonthly}`]);
  } else {
    rows.push([sub.status === 'cancelled' ? 'הפלייליסטים ממשיכים עד' : 'פעיל עד', heDate(sub.lastDay)]);
  }
  rows.push(['מנוי מאז', heDate(sub.startedOn)]);
  if (sub.invoiceEmail) rows.push(['חשבוניות נשלחות אל', sub.invoiceEmail, 'ltr']);
  if (sub.invoiceName)  rows.push(['חשבונית על שם', sub.invoiceName]);
  if (sub.taxId)        rows.push(['ח.פ / ע.מ', sub.taxId]);

  $('subRows').replaceChildren(...rows.map(([label, value, cls]) => {
    const row = document.createElement('div');
    row.className = 'sub-row';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (cls) dd.className = cls;
    row.append(dt, dd);
    return row;
  }));

  $('subCancel').classList.toggle('hide', sub.status !== 'active');
  $('subConfirm').classList.add('hide');
  $('subResume').classList.toggle('hide', sub.status !== 'cancelled');
  $('subRenew').classList.toggle('hide', sub.status !== 'ended');
  setSubMsg(sub.status === 'cancelled' ? 'לא תחויבו יותר.' : '');
}

function lockSubscriptionButtons(on) {
  for (const id of ['subCancel', 'subCancelConfirm', 'subResume', 'subRenew']) {
    const b = $(id);
    if (b) b.disabled = on;
  }
}

// ---- renewal after the end (2026-10-06) ----
// A new payment from inside the account: the shared Hyp form
// (v7/hyp-payment.js) on a sheet, pre-filled with last time's details. The
// checkout is tied to this business from the start (renewBusinessId), and
// api/v7/payment/return.js reactivates the subscription as soon as Hyp
// confirms — even if this page is closed by then. Here, once it's paid: the
// section refreshes, and today's playlists are built if the place is open
// today and nothing was built yet (like the first login).
let renewal = null;   // the mounted payment form while the sheet is open

function renewLink() {
  const a = document.createElement('a');
  a.href = '#';
  a.className = 'closed-open-link';
  a.textContent = 'חדשו את המנוי';
  a.addEventListener('click', (e) => { e.preventDefault(); startRenewal(); });
  return a;
}

function startRenewal() {
  const sub = state.subscription;
  if (!business || sub?.status !== 'ended' || renewal) return;
  ensureHypPaymentStyles();
  $('renewModal').classList.remove('hide');
  renewal = mountHypPayment($('renewHost'), {
    heading: 'חידוש המנוי',
    email: user?.email || '',
    businessName: business.name || '',
    renewal: {
      businessId: business.id,
      getToken: async () => (await sb.auth.getSession()).data.session?.access_token || '',
    },
    prefill: sub.billing || null,
  });
  renewal.promise.then(afterRenewal);
}

function closeRenewal() {
  renewal?.destroy();
  renewal = null;
  $('renewModal').classList.add('hide');
  $('renewHost').replaceChildren();
}

async function afterRenewal() {
  closeRenewal();
  toast('המנוי חודש ✓');
  await loadSubscription();
  if (state.subscription?.status === 'active') {
    setSubMsg(`המנוי חודש ✓ החיוב הבא ב־${heDate(state.subscription.nextChargeOn)}.`, 'ok');
  }
  state.dailyStatus = null;
  if (!state.generating) renderPlaylists();
  await loadDailyStatus();
  const reason = state.dailyStatus?.reason;
  if (reason === 'before-build' || reason === 'error') {
    switchTab('Home');
    runGenerateDaily();
  }
}

$('subRenew')?.addEventListener('click', startRenewal);
$('renewClose')?.addEventListener('click', closeRenewal);

$('subCancel')?.addEventListener('click', () => {
  const sub = state.subscription;
  if (!sub?.nextChargeOn) return;
  $('subConfirmText').textContent =
    `לבטל את המנוי? לא תחויבו יותר, והפלייליסטים ימשיכו להגיע עד ${heDate(dayBefore(sub.nextChargeOn))} — סוף החודש ששולם.`;
  $('subReason').value = '';
  $('subCancel').classList.add('hide');
  $('subConfirm').classList.remove('hide');
  setSubMsg('');
});

$('subCancelConfirm')?.addEventListener('click', async () => {
  lockSubscriptionButtons(true);
  setSubMsg('מבטלים את המנוי…');
  try {
    const data = await subscriptionRequest('POST', { action: 'cancel', reason: $('subReason').value.trim() });
    state.subscription = data.subscription;
    renderSubscriptionSection();
    setSubMsg(`המנוי בוטל. לא תחויבו יותר, והפלייליסטים ימשיכו עד ${heDate(data.subscription?.lastDay)}.`, 'ok');
  } catch (e) {
    console.error('cancel subscription:', e);
    setSubMsg(e.message || 'משהו השתבש — נסו שוב', 'err');
  } finally {
    lockSubscriptionButtons(false);
  }
});

$('subResume')?.addEventListener('click', async () => {
  lockSubscriptionButtons(true);
  setSubMsg('מחדשים את המנוי…');
  try {
    const data = await subscriptionRequest('POST', { action: 'resume' });
    state.subscription = data.subscription;
    renderSubscriptionSection();
    setSubMsg(`המנוי חודש ✓ החיוב הבא ב־${heDate(data.subscription?.nextChargeOn)}.`, 'ok');
  } catch (e) {
    console.error('resume subscription:', e);
    setSubMsg(e.message || 'משהו השתבש — נסו שוב', 'err');
  } finally {
    lockSubscriptionButtons(false);
  }
});

// Toggle any `.hours-toggle` (naming is historical — same styling +
// behavior now covers the directions section too). aria-controls points
// to the body id. Wired once at module load so it survives tab switches.
document.querySelectorAll('.hours-toggle').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const body = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!body) return;
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    body.classList.toggle('hide', open);
  });
});

// Esc inside the hours editor reverts to the last-saved schedule. Bound
// once via delegation on the body so it survives editor re-mounts (the
// editor swaps out its own children on cancel + on tab re-open).
document.getElementById('hoursBody')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!isHoursDirty()) return;
  e.preventDefault();
  cancelHours();
});

// ---- name row ----
function isNameDirty() {
  return ($('profileBizName').value || '').trim() !== nameSnapshot;
}

function updateNameActions() {
  const actions = $('nameActions');
  const saveBtn = $('saveName');
  if (!actions || !saveBtn) return;
  const dirty = isNameDirty();
  actions.classList.toggle('hide', !dirty);
  saveBtn.disabled = !dirty || !$('profileBizName').value.trim();
}

function cancelName() {
  $('profileBizName').value = nameSnapshot;
  $('nameMsg').textContent = '';
  updateNameActions();
  $('profileBizName').blur();
}

async function saveName() {
  const nameInput = $('profileBizName');
  const name = nameInput.value.trim();
  const msg = $('nameMsg');
  const btn = $('saveName');
  msg.style.color = '';
  msg.textContent = '';
  if (!name) { msg.style.color = '#ff9b8a'; msg.textContent = 'הכניסו שם לעסק'; return; }
  if (name === nameSnapshot) return;

  btn.disabled = true;
  const origLabel = btn.textContent;
  setWaitText(btn, 'שומרים…');
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v6/account/update-business-name', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: business.id, name }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
    business.name = name;
    nameSnapshot = name;
    renderBusiness();
    msg.style.color = 'var(--teal-soft)';
    msg.textContent = 'נשמר ✓';
  } catch (e) {
    console.error('saveName:', e);
    msg.style.color = '#ff9b8a';
    msg.textContent = 'שגיאה בשמירה — נסו שוב';
  } finally {
    btn.textContent = origLabel;
    updateNameActions();
  }
}

$('saveName')?.addEventListener('click', saveName);
$('cancelName')?.addEventListener('click', cancelName);

// ---- password section ----
// The current password is checked first (signInWithPassword on the same
// account — it just refreshes the session), so an unlocked, logged-in device
// can't be used to lock the owner out.
async function savePassword(e) {
  e.preventDefault();
  const current = $('currentPassword').value;
  const next = $('nextPassword').value;
  const msg = $('passwordMsg');
  const btn = $('savePassword');
  const setMsg = (text, kind) => {
    msg.style.color = kind === 'err' ? '#ff9b8a' : kind === 'ok' ? 'var(--teal-soft)' : '';
    msg.textContent = text;
  };
  if (!current) { setMsg('הכניסו את הסיסמה הנוכחית', 'err'); return; }
  const problem = passwordProblem(next);
  if (problem) { setMsg(problem, 'err'); return; }

  btn.disabled = true;
  setWaitText(btn, 'שומרים…');
  setMsg('');
  try {
    const { error: authErr } = await sb.auth.signInWithPassword({ email: user.email, password: current });
    if (authErr) {
      setMsg(isRateLimited(authErr) ? 'יותר מדי ניסיונות — נסו שוב בעוד כמה דקות' : 'הסיסמה הנוכחית שגויה', 'err');
      return;
    }
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) { setMsg(passwordErrorText(error), 'err'); return; }
    $('currentPassword').value = '';
    $('nextPassword').value = '';
    setMsg('הסיסמה עודכנה ✓', 'ok');
  } catch (err) {
    console.error('savePassword:', err);
    setMsg('שגיאה בשמירה — נסו שוב', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'שמור סיסמה';
  }
}

$('passwordForm')?.addEventListener('submit', savePassword);

// ---- hours section ----
function isHoursDirty() {
  if (!hoursEditor) return false;
  return JSON.stringify(hoursEditor.getPayload().hours) !== hoursSnapshot;
}

function updateSaveHoursButton() {
  const btn = $('saveHours');
  if (!btn || !hoursEditor) return;
  const valid = !hoursEditor.isAllClosed() && !hoursEditor.getProblem();
  btn.disabled = !(isHoursDirty() && valid);
}

// Revert by re-mounting the editor with the snapshot hours. mountHoursEditor
// wipes and rebuilds #hoursHost's children, so any in-flight edits are
// discarded cleanly.
function cancelHours() {
  const savedHours = hoursSnapshot ? JSON.parse(hoursSnapshot) : null;
  hoursEditor = mountHoursEditor($('hoursHost'), {
    prechecked: savedHours ? { hours: savedHours } : null,
    onChange: () => updateSaveHoursButton(),
  });
  $('hoursMsg').textContent = '';
  updateSaveHoursButton();
}

async function saveHours() {
  const msg = $('hoursMsg');
  const btn = $('saveHours');
  msg.style.color = '';
  msg.textContent = '';
  if (!hoursEditor || hoursEditor.isAllClosed()) {
    msg.style.color = '#ff9b8a';
    msg.textContent = 'סמנו לפחות יום פתוח אחד';
    return;
  }
  // Invalid hours are shown inside the editor (shared/opening-hours.js).
  if (hoursEditor.getProblem()) return;
  const { hours, longestMinutes } = hoursEditor.getPayload();

  btn.disabled = true;
  const origLabel = btn.textContent;
  setWaitText(btn, 'שומרים…');
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    // v7's own endpoint: same save + audit as v6's, and it brings the
    // Option-2 energy timeline in line with the new hours (dots keep their
    // clock times) in the same request.
    const r = await fetch('/api/v7/account/update-hours', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: business.id, hours, longestMinutes }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
    // Reflect locally so the title renderer + hasPlaylistsForToday pick
    // up the new hours immediately.
    state.dashboard = { ...(state.dashboard || {}), hours, longestMinutes };
    if (data.timeline) state.timeline = data.timeline;
    if (state.deliveryMode === 'option2') renderTimelineSpark();
    renderPlaylistsTitle();
    hoursSnapshot = JSON.stringify(hours);
    msg.style.color = 'var(--teal-soft)';
    msg.textContent = 'נשמר ✓';
  } catch (e) {
    console.error('saveHours:', e);
    msg.style.color = '#ff9b8a';
    // The server's hours check answers in Hebrew — show it as is.
    msg.textContent = /[\u0590-\u05FF]/.test(e?.message || '') ? e.message : 'שגיאה בשמירה — נסו שוב';
  } finally {
    btn.textContent = origLabel;
    updateSaveHoursButton();
  }
}

$('saveHours')?.addEventListener('click', saveHours);

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

// "Today" = the venue's BUSINESS day in Israel time, not the browser's
// calendar day: an overnight venue (Mon 18:00–02:00) at 01:00 Tuesday is
// still on Monday. businessWindowAt handles both (IL timezone + overnight).
function todayDayIdx() { return businessWindowAt(bmeta().hours).dayIdx; }

function todayDdMmYy() {
  const [y, m, d] = businessWindowAt(bmeta().hours).isoDate.split('-');
  return `${d}/${m}/${y.slice(-2)}`;
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

// "Daily playlists exist for today" — built during the current business day
// (from 3h before its IL midnight: the cron builds up to 2h before opening,
// same window as the server's _replace-status.js). Used to tell apart the
// onboarding day (daily playlists just created → normal title) from a later
// closed-day visit (no daily playlists → show the closed prompt). Only LIVE
// playlists (not past their expiresAt) count, and event playlists are
// excluded — they surface in the events section, so their presence must not
// flip the daily-playlists title to "open day".
function hasPlaylistsForToday() {
  const since = Date.parse(businessWindowAt(bmeta().hours).dayStartIso) - 3 * 3600 * 1000;
  return (bmeta().playlists || []).some((p) =>
    p && !p.eventId && (p.createdAtMs || 0) >= since && playlistIsLive(p),
  );
}

// Shared expiry gate for daily playlists AND event playlists. Missing
// expiresAt = "no expiry recorded" → treat as live (backward compat for
// entries written before per-day expiry existed; the ledger cron will
// still unfollow them at their old 24h TTL).
function playlistIsLive(p) {
  return !!p && (!p.expiresAt || p.expiresAt > Date.now());
}

// Fire-and-forget engagement log. Called from every dashboard "▶ פתח"
// click. Never blocks the actual navigation — the Spotify link opens
// via the browser's normal <a target="_blank"> handling and this POST
// races it in the background. Failure is swallowed silently; the row
// is an analytics signal, not user-facing state.
function logPlaylistOpen(spotifyId, source) {
  if (!spotifyId || !business?.id) return;
  (async () => {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) return;
      await fetch('/api/v6/account/log-playlist-open', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          businessId: business.id,
          spotifyId,
          source: source || 'home',
        }),
        keepalive: true,
      });
    } catch { /* swallow — analytics, not critical */ }
  })();
}

// ---------- why there are no daily playlists (2026-10-06) ----------
// GET /api/v7/account/daily-status → { reason, hasLive }; the reason line
// under "לא נוצרו פלייליסטים" (see that endpoint for the reasons). While the
// cron is building ('building') it re-checks every 15s, and before the build
// ('before-build') every 5 min, so an open page picks up the new set. "דווחו"
// emails Roni a report (POST action:'report'); "השלימו עכשיו" redoes Option
// 1's missing directions, then builds today's set if its time has passed.
state.dailyStatus = null;      // { reason, hasLive } | null (not loaded yet)
state.dailyReport = null;      // null | 'sending' | 'sent'
state.completingSetup = false; // "השלימו עכשיו" in progress
let dailyStatusTimer = null;

const DAILY_REASON_TEXT = {
  'subscription-ended': 'המנוי שלכם הסתיים',
  'closed':             'המקום סגור היום',
  'before-build':       'הפלייליסטים ייווצרו לפני הפתיחה',
  'after-close':        'הפלייליסטים הבאים ייווצרו לפני הפתיחה הבאה',
};

const reportedKey = () => `rubin-v7-reported:${business.id}:${businessWindowAt(bmeta().hours).isoDate}`;
function reportedToday() {
  try { return !!localStorage.getItem(reportedKey()); } catch { return false; }
}

async function dailyStatusRequest(method, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('לא מחוברים');
  const url = method === 'GET'
    ? `/api/v7/account/daily-status?business_id=${encodeURIComponent(business.id)}`
    : '/api/v7/account/daily-status';
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    ...(body ? { body: JSON.stringify({ business_id: business.id, ...body }) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
  return data;
}

// `pending` = a request already in flight (boot starts it alongside the
// dashboard data, so the line is usually ready when the box first renders).
async function loadDailyStatus(pending) {
  if (!business) return;
  clearTimeout(dailyStatusTimer);
  try {
    state.dailyStatus = await (pending || dailyStatusRequest('GET'));
  } catch (e) {
    console.warn('loadDailyStatus:', e?.message || e);
    // Show the line without a reason rather than leave the box empty.
    if (!state.dailyStatus) state.dailyStatus = { reason: null, hasLive: false };
    if (!state.generating) renderPlaylists();
    return;
  }
  // Built elsewhere (the cron) while this page showed none → reload once.
  const showing = (bmeta().playlists || []).some((p) => playlistIsLive(p) && !p.eventId);
  if (state.dailyStatus.hasLive && !showing && !state.generating) {
    try { await loadDashboardData(business.id); } catch { /* soft */ }
    renderPlaylistsTitle();
  }
  if (!state.generating) renderPlaylists();
  const reason = state.dailyStatus.reason;
  if (reason === 'building' || reason === 'before-build') {
    dailyStatusTimer = setTimeout(loadDailyStatus, reason === 'building' ? 15000 : 5 * 60 * 1000);
  }
}

async function reportDailyProblem() {
  state.dailyReport = 'sending';
  renderPlaylists();
  try {
    await dailyStatusRequest('POST', { action: 'report' });
    state.dailyReport = 'sent';
    try { localStorage.setItem(reportedKey(), '1'); } catch { /* private mode */ }
  } catch (e) {
    state.dailyReport = null;
    toast(String(e.message || 'משהו השתבש — נסו שוב').slice(0, 120));
  }
  renderPlaylists();
}

async function completeSetup() {
  state.completingSetup = true;
  renderPlaylists();
  const ok = await buildEnergyDirections();
  state.energyBuildFailed = !ok;
  state.completingSetup = false;
  if (!ok) {
    toast('ההכנה לא הושלמה — נסו שוב');
    renderPlaylists();
    return;
  }
  await loadDailyStatus();
  // Past the build time → nobody else will build today's set now.
  if (state.dailyStatus?.reason === 'error') runGenerateDaily();
}

// The empty state of the daily-playlists box: one line,
// "לא נוצרו פלייליסטים · <reason> · צור פלייליסטים". Drawn only once the
// reason is known, so the line appears whole rather than in two steps.
function renderEmptyDaily(wrap) {
  if (!state.dailyStatus && !state.completingSetup) {
    // Reason still loading → a spinner in the line's place.
    const spin = document.createElement('div');
    spin.className = 'daily-loading';
    spin.innerHTML = '<span class="sb-spinner" aria-label="טוען"></span>';
    wrap.append(spin);
    return;
  }
  const reason = state.dailyStatus?.reason || null;
  const link = (text, onClick) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'closed-open-link';
    a.textContent = text;
    a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return a;
  };

  if (reason === 'building' || state.completingSetup) {
    const p = document.createElement('p');
    p.className = 'muted daily-wait';
    if (state.completingSetup) {
      setWaitText(p, `מכינים את הפלייליסטים שלכם…\n${ENERGY_BUILD_WAIT_NOTE}`);
    } else {
      setWaitText(p, 'הפלייליסטים נבנים עכשיו…');
      const spin = document.createElement('span');
      spin.className = 'pl-inline-spinner';
      spin.setAttribute('aria-label', 'בונים');
      p.append(spin);
    }
    wrap.append(p);
    return;
  }

  const msg = document.createElement('p');
  msg.className = 'muted';
  msg.textContent = 'לא נוצרו פלייליסטים';
  const sep = () => msg.append(' · ');

  if (reason === 'subscription-ended' && state.subscription?.status === 'ended') {
    sep();
    msg.append(`${DAILY_REASON_TEXT[reason]} – `, renewLink());
  } else if (DAILY_REASON_TEXT[reason]) {
    sep();
    msg.append(DAILY_REASON_TEXT[reason]);
  } else if (reason === 'needs-directions') {
    sep();
    msg.append('הכנת הפלייליסטים שלכם לא הושלמה – ', link('השלימו עכשיו', completeSetup));
  } else if (reason === 'error') {
    sep();
    if (state.dailyReport === 'sent' || (state.dailyReport == null && reportedToday())) {
      msg.append('דיווחנו, נבדוק את זה ✓');
    } else if (state.dailyReport === 'sending') {
      const s = document.createElement('span');
      setWaitText(s, 'שולחים דיווח…');
      msg.append(s);
    } else {
      msg.append('שגיאה – ', link('דווחו', reportDailyProblem));
    }
  }

  // On closed days the title already offers "המקום פתוח?" which opens the
  // same modal — skip the link there to avoid a redundant CTA. No link either
  // when a build can't work (setup incomplete / subscription ended).
  if (!todayIsClosed() && reason !== 'needs-directions' && reason !== 'subscription-ended') {
    // Before opening: build now, as though the place opens now (it replaces
    // the build the cron would do before opening).
    const openNow = reason === 'before-build';
    sep();
    msg.append(link(openNow ? 'צור פלייליסטים עכשיו' : 'צור פלייליסטים', () => openGenerateDailyModal({ openNow })));
  }
  wrap.append(msg);
}

function renderPlaylists() {
  const wrap = $('slotsWrap');
  wrap.innerHTML = '';
  // Daily list shows only daily playlists — event playlists surface in
  // the events section via activePlaylistForEvent → "▶ פתח" on the event
  // row. Filtering them out here avoids the duplicate listing.
  const playlists = (bmeta().playlists || []).filter((p) => playlistIsLive(p) && !p.eventId);
  // Generate-daily streaming: server sent us a plan (ordered directions),
  // and we're accumulating built/failed status per direction as ndjson
  // lines arrive. Render each planned direction in order — real row if
  // built, spinner-placeholder if pending, error-placeholder if failed.
  // The plan's order IS the render order (server sorted by click count).
  //
  // Falls back to a single generic placeholder for the sub-second gap
  // between "click generate" and "server sends the plan line".
  if (state.generating) {
    const plan   = state.generating.plan;   // [{direction_id, title}, ...] or null
    const status = state.generating.status; // Map<direction_id, 'pending'|'built'|'failed'>
    const built  = state.generating.builtRows; // Map<direction_id, clientRow>
    if (!plan || !plan.length) {
      const row = document.createElement('div');
      row.className = 'slot slot-pending';
      row.innerHTML =
        `<div class="s-info">` +
        `<div class="s-title">🎵 פלייליסט</div>` +
        `<div class="s-meta">בונים${WAIT_DOTS_HTML}<span class="pl-inline-spinner" aria-label="בונים"></span></div>` +
        `</div>`;
      wrap.append(row);
      return;
    }
    for (const { direction_id, title } of plan) {
      const s = status.get(direction_id);
      if (s === 'built') {
        const row = built.get(direction_id);
        if (row) { wrap.append(buildPlaylistRow(row)); continue; }
        // Fallthrough to pending if builtRows map is inconsistent (shouldn't happen).
      }
      const row = document.createElement('div');
      row.className = 'slot slot-pending' + (s === 'failed' ? ' slot-failed' : '');
      const metaText = s === 'failed'
        ? 'לא הצליח — ננסה שוב בבנייה הבאה'
        : `בונים${WAIT_DOTS_HTML}`;
      const spinnerHtml = s === 'failed'
        ? ''
        : '<span class="pl-inline-spinner" aria-label="בונים"></span>';
      row.innerHTML =
        `<div class="s-info">` +
        `<div class="s-title">🎵 ${escHtml(undatedLabel(title) || 'פלייליסט')}</div>` +
        `<div class="s-meta">${metaText}${spinnerHtml}</div>` +
        `</div>`;
      wrap.append(row);
    }
    return;
  }
  if (!playlists.length) {
    renderEmptyDaily(wrap);
    return;
  }
  // Fixed order by name (#1 before #2); see sortPlaylistsByClicksDesc.
  const sorted = sortPlaylistsByClicksDesc(playlists);
  for (const p of sorted) {
    wrap.append(buildPlaylistRow(p));
  }
}

// Extracted from renderPlaylists so the streaming build path can drop
// finished rows into the DOM one at a time as they arrive, using the same
// markup as the steady-state list.
function buildPlaylistRow(p) {
  const target = dayTargetTracks();
  const row = document.createElement('div');
  row.className = 'slot';
  row.dataset.playlistId = p.id || '';
  const showBar = playlistIsExpanding(p, target);
  const barHtml = showBar
    ? `<div class="pl-expand-bar" data-target="${target}" data-current="${p.trackCount || 0}"><div class="pl-expand-fill"></div></div>`
    : '';
  const spinnerHtml = showBar ? '<span class="pl-inline-spinner" aria-label="בונים"></span>' : '';
  // The stored label carries the business day's date ("אנרגיה גבוהה #1 · 21.10.2026");
  // the dashboard shows the name only (Roni, 2026-10-22). Spotify's name keeps the date.
  // p.ico / p.label originate from AI-generated direction data (Gemini /
  // Claude via musical-directions.js). Escape both before dropping them
  // into innerHTML — a prompt-injection that produces a `<script>` in a
  // title would otherwise execute here at render time. p.trackCount is
  // clamped to a number by `|| 0`, so it doesn't need escaping.
  //
  // Label wrapped in .s-label so the inline-rename handler can swap it
  // for an input on click. .editable class (and the click handler) only
  // attach when the row is backed by a direction_id AND no generate flow
  // is in progress (mid-stream re-renders would clobber an in-progress
  // rename — see enterRenameMode below).
  const canRename = !!p.directionId && !state.generating;
  const labelClass = canRename ? 's-label editable' : 's-label';
  row.innerHTML =
    `<div class="s-info">` +
    // The track count sits on the name's line (Roni, 2026-10-22).
    `<div class="s-title">${escHtml(p.ico || '🎵')} <span class="${labelClass}" dir="auto">${escHtml(undatedLabel(p.label) || 'פלייליסט')}</span>` +
    `<span class="s-count"> · <span class="pl-count">${p.trackCount || 0}</span> שירים${spinnerHtml}</span></div>` +
    barHtml +
    `</div>`;
  if (canRename) {
    const labelEl = row.querySelector('.s-label');
    labelEl.title = 'לחצו כדי לערוך את השם';
    labelEl.addEventListener('click', () => enterRenameMode(labelEl, p));
  }
  // Edit + trash icon buttons — one each per row, only when the row
  // has a direction_id back-ref (missing on pre-migration rows). Sit
  // between the info column and the "▶ פתח" button.
  if (p.directionId) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'slot-icon slot-edit';
    editBtn.title = 'עריכת הכיוון';
    editBtn.setAttribute('aria-label', 'עריכת הכיוון');
    editBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>' +
      '</svg>';
    editBtn.addEventListener('click', () => editDirectionFromCard(p.directionId));
    row.append(editBtn);

    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    trashBtn.className = 'slot-icon slot-trash';
    trashBtn.title = 'מחיקת הכיוון';
    trashBtn.setAttribute('aria-label', 'מחיקת הכיוון');
    trashBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/>' +
      '<path d="M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14"/>' +
      '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    trashBtn.addEventListener('click', () => openTrashDirectionModal(p.directionId));
    row.append(trashBtn);
    // Direction id also lives on the row itself so the delete flow can
    // find the correct trash button by directionId after the modal has
    // closed (the modal doesn't hold a reference to the row).
    row.dataset.directionId = p.directionId;
  }
  if (p.url) {
    const open = document.createElement('a');
    open.className = 'btn';
    open.style.textDecoration = 'none';
    open.href = p.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = '▶ פתח';
    open.addEventListener('click', () => logPlaylistOpen(p.id, 'home-daily'));
    row.append(open);
  }
  if (showBar) updateExpandBar(row, p.trackCount || 0);
  const ns = nudgeState(p);
  if (ns) row.querySelector('.s-info').append(buildNudgeRow(p, ns));
  return row;
}

// ---------- "today only" energy for one playlist (4 a day; Ami + Roni, 2026-10-21) ----------
// Three circles under each of the 4 daily playlists: calmer / as usual / more
// energetic — the windows from nudgeOptions (v7/generation/energy-windows.js):
// the playlist's usual window ±10, or, at an end of the scale, the usual one
// there and two steps the other way. A tap asks once, then
// api/v7/account/energy-nudge.js swaps that playlist's songs in place, for
// today only. One change a day per business, across all 4; tomorrow's
// playlists are back to usual. A permanent change goes through the taste chat.
const nudge = { busyId: null, usedDayStart: null, pending: null };
const NUDGE_WORDS = { '-2': 'הרבה פחות אנרגטי', '-1': 'קצת פחות אנרגטי', 0: 'כרגיל', 1: 'קצת יותר אנרגטי', 2: 'הרבה יותר אנרגטי' };
// Drawn icons (not text) so they sit exactly in the middle of the circle.
const NUDGE_ICONS = {
  1: '<path d="M7 12h10M12 7v10"/>',
  2: '<path d="M3.5 12h7M7 8.5v7M13.5 12h7M17 8.5v7"/>',
  '-1': '<path d="M7 12h10"/>',
  '-2': '<path d="M4 12h6M14 12h6"/>',
  dot: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
};
const nudgeIcon = (key) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">${NUDGE_ICONS[key]}</svg>`;
const nudgeDayStart = () => businessWindowAt(bmeta().hours).dayStartIso;

function nudgeUsedToday() {
  const since = nudgeDayStart();
  if (nudge.usedDayStart === since) return true;
  return (bmeta().playlists || []).some((p) => playlistIsLive(p) && !p.eventId
    && Date.parse(p.expansion?.direction?.energy_nudge?.at || 0) >= Date.parse(since));
}

// { windows, usualIndex, currentIndex } for a card that gets the circles, else null.
function nudgeState(p) {
  if (state.deliveryMode !== 'option1' || state.generating || !p.url) return null;
  if (!OPTION1_DAILY_TITLES.includes(undatedLabel(p.label))) return null;
  const d = p.expansion?.direction;
  const cur = [Number(d?.energy_range?.min), Number(d?.energy_range?.max)];
  if (!Number.isFinite(cur[0]) || !Number.isFinite(cur[1])) return null;
  const u = d.energy_nudge?.usual;
  const { windows, usualIndex } = nudgeOptions(u ? [u.min, u.max] : cur);
  const currentIndex = windows.findIndex((w) => w[0] === cur[0] && w[1] === cur[1]);
  return currentIndex < 0 ? null : { windows, usualIndex, currentIndex };
}

function buildNudgeRow(p, ns) {
  const used = nudgeUsedToday();
  const row = document.createElement('div');
  row.className = 'nrg-row';
  const label = document.createElement('span');
  label.textContent = 'אנרגיה להיום';
  const dots = document.createElement('div');
  dots.className = 'nrg-dots';
  dots.dir = 'ltr';   // calmer on the left, more energetic on the right
  ns.windows.forEach((_, i) => {
    const k = i - ns.usualIndex;
    const on = i === ns.currentIndex;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `nrg-dot${on ? ' on' : ''}`;
    // + / − while the change is available; a dot on the usual circle, and on
    // every empty circle once today's change is used.
    if (!on) b.innerHTML = nudgeIcon(k && !used ? k : 'dot');
    if (!on && (used || !k)) b.classList.add('plain');
    const words = `${NUDGE_WORDS[k]}${on ? ' (עכשיו)' : ''}`;
    b.title = words;
    b.setAttribute('aria-label', words);
    b.disabled = on || used || !!nudge.busyId;
    if (!b.disabled) b.addEventListener('click', () => openNudgeConfirm(p, i, k));
    dots.append(b);
  });
  const note = document.createElement('span');
  note.className = 'nrg-note';
  if (nudge.busyId === p.id) note.innerHTML = `מעדכנים${WAIT_DOTS_HTML}<span class="pl-inline-spinner" aria-label="מעדכנים"></span>`;
  else if (used && !p.expansion?.direction?.energy_nudge) note.textContent = 'השינוי של היום נוצל';
  row.append(label, dots, note);
  return row;
}

function openNudgeConfirm(p, choice, k) {
  nudge.pending = { p, choice };
  const name = undatedLabel(p.label);
  const more = k > 0;
  $('nudgeTitle').textContent = `${Math.abs(k) > 1 ? 'הרבה' : 'קצת'} ${more ? 'יותר' : 'פחות'} אנרגטי, רק להיום?`;
  $('nudgeText').textContent = `נעדכן את "${name}" לאנרגיה ${more ? 'גבוהה' : 'רגועה'} יותר. מחר הוא יחזור להיות כרגיל. אפשר לשנות רק פלייליסט אחד, פעם אחת ביום. לשינוי קבוע נסו את צ'אט הטעם המוזיקלי.`;
  $('nudgeModal').classList.remove('hide');
}

function closeNudgeConfirm() {
  nudge.pending = null;
  $('nudgeModal').classList.add('hide');
}

async function confirmNudge() {
  const pending = nudge.pending;
  closeNudgeConfirm();
  if (!pending || nudge.busyId) return;
  const { p, choice } = pending;
  nudge.busyId = p.id;
  renderPlaylists();
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v7/account/energy-nudge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ businessId: business?.id, spotifyId: p.id, choice }),
    });
    const data = await r.json().catch(() => ({}));
    if (data?.code === 'nudge-used') nudge.usedDayStart = nudgeDayStart();
    if (!r.ok || !data?.ok) throw new Error(data?.error || 'משהו השתבש — נסו שוב.');
    nudge.usedDayStart = nudgeDayStart();
    const fresh = data.playlist;
    state.dashboard = {
      ...(state.dashboard || {}),
      playlists: (bmeta().playlists || []).map((x) => (x.id === fresh.spotify_id
        ? { ...x, trackCount: fresh.track_count, expansion: fresh.expansion } : x)),
    };
    toast('הפלייליסט עודכן, רק להיום');
  } catch (e) {
    console.error('energy-nudge:', e);
    toast(String(e.message || 'משהו השתבש — נסו שוב.').slice(0, 120));
  } finally {
    nudge.busyId = null;
    renderPlaylists();
  }
}

$('nudgeGo')?.addEventListener('click', confirmNudge);
$('nudgeCancel')?.addEventListener('click', closeNudgeConfirm);
$('nudgeModal')?.addEventListener('click', (e) => { if (e.target?.id === 'nudgeModal') closeNudgeConfirm(); });

// ---- inline direction rename on Home tab playlist rows ----
// Clicking a row's .s-label span calls enterRenameMode, which replaces the
// span with an input + save/cancel buttons. Save fires the cosmetic-only
// edit path on /api/v6/account/apply-direction-change (the server auto-
// detects title-only edits and takes the rename-only branch — renames the
// live Spotify playlist in place, updates business_playlists.label, no
// track rebuild). Cancel restores the original text.
//
// Refresh comes via the `direction-change-applied` document event that the
// same listener on the home tab already handles — same channel the chat's
// apply flow uses, so both paths converge to a single reload.
const RENAME_MAX_LEN = 120;                            // matches server's sanitizeUpdates cap
const RENAME_ICON_SAVE   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>';
const RENAME_ICON_CANCEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

function enterRenameMode(labelEl, playlist) {
  // Guard: only one row in edit mode at a time. If another rename is in
  // flight, ignore additional clicks — simpler than juggling nested
  // rollback state.
  if (document.querySelector('.s-label-edit')) return;
  const originalText = playlist.label || 'פלייליסט';
  // Mark the parent .slot so narrow-viewport CSS can hide the row's
  // trash + edit icons while the input is up (they'd otherwise crush the
  // save/cancel buttons on small screens). Class is stripped in both the
  // restore and commit paths below.
  const slotEl = labelEl.closest('.slot');
  slotEl?.classList.add('slot--renaming');

  const wrap = document.createElement('span');
  wrap.className = 's-label-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = originalText;
  input.maxLength = RENAME_MAX_LEN;
  input.setAttribute('aria-label', 'שם הכיוון');
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 's-label-edit-btn s-label-edit-save';
  saveBtn.title = 'שמירה (Enter)';
  saveBtn.setAttribute('aria-label', 'שמירה');
  saveBtn.innerHTML = RENAME_ICON_SAVE;
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 's-label-edit-btn s-label-edit-cancel';
  cancelBtn.title = 'ביטול (Esc)';
  cancelBtn.setAttribute('aria-label', 'ביטול');
  cancelBtn.innerHTML = RENAME_ICON_CANCEL;
  wrap.append(input, saveBtn, cancelBtn);

  labelEl.replaceWith(wrap);
  // Focus + select all on entry so a keyboard-first user can immediately
  // start typing over the old name.
  input.focus();
  input.select();

  // Rebuild a static .s-label span (out of edit mode) with the given text
  // and re-arm the click handler. Used both when the owner cancels AND
  // when the optimistic commit swaps back to display mode — same shape.
  const renderStaticSpan = (text) => {
    const span = document.createElement('span');
    span.className = 's-label editable';
    span.textContent = text || 'פלייליסט';
    span.title = 'לחצו כדי לערוך את השם';
    span.addEventListener('click', () => enterRenameMode(span, playlist));
    return span;
  };
  const exitEditUi = () => slotEl?.classList.remove('slot--renaming');
  const restore = () => {
    wrap.replaceWith(renderStaticSpan(originalText));
    exitEditUi();
  };

  const commit = () => {
    const newName = input.value.trim().slice(0, RENAME_MAX_LEN);
    if (!newName || newName === originalText) {
      // Empty or no-op → silently revert (server would reject empty
      // anyway via sanitizeUpdates).
      restore();
      return;
    }

    // ---- optimistic UI: swap immediately, save in background ----
    // 1) DOM: replace the edit wrap with a static span carrying the new
    //    name. From the owner's POV the rename is done.
    wrap.replaceWith(renderStaticSpan(newName));
    exitEditUi();
    // 2) Local state mirror: mutating playlist.label also mutates the
    //    entry in state.dashboard.playlists (same object reference), so
    //    a spurious re-render from anywhere else keeps the new label.
    playlist.label = newName;
    // 3) "חידודים מוזיקליים" direction cards: patch in place so they
    //    already reflect the change. No-op when direction-chat's
    //    state.directions is empty (card never opened) — a first-open
    //    reload will pick it up.
    patchDirectionOptimistic(playlist.directionId, { title_en: newName });

    // ---- background persist ----
    (async () => {
      try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session?.access_token) throw new Error('לא מחוברים');
        const r = await fetch('/api/v6/account/apply-direction-change', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            businessId:         business.id,
            kind:               'edit',
            directionId:        playlist.directionId,
            updates:            { title_en: newName },
            expireLivePlaylist: false,   // ignored server-side on the cosmetic-only branch
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
        // Silent success — the owner already sees the new name. Dispatch
        // the standard event anyway so downstream views (audit log etc.)
        // pick up the eventual-consistency reload.
        document.dispatchEvent(new CustomEvent('direction-change-applied', {
          detail: { businessId: business.id },
        }));
      } catch (err) {
        console.warn('rename failed:', err);
        // ---- revert optimistic changes ----
        playlist.label = originalText;
        patchDirectionOptimistic(playlist.directionId, { title_en: originalText });
        // Repaint the whole list so the failed row swaps back to the old
        // name — cheaper than tracking the specific DOM node the
        // optimistic swap produced.
        renderPlaylists();
        toast(String(err.message || 'לא הצליח לשמור את השם').slice(0, 120));
      }
    })();
  };

  saveBtn.addEventListener('click', commit);
  cancelBtn.addEventListener('click', restore);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')       { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });
}

// Edit icon on a playlist row → open the "חידודים מוזיקליים" card and prime
// the direction-edit chat with the corresponding direction selected. The
// chat itself fires the "מה תרצו לשנות בכיוון X?" synthetic prompt.
async function editDirectionFromCard(directionId) {
  if (!directionId) return;
  openDirectionsSection();
  try { await selectDirectionInChat(directionId); }
  catch (e) { console.warn('editDirectionFromCard failed:', e); }
}

// Trash icon on a playlist row → open the confirmation modal. The
// caller then picks between editing (same path as the edit icon) and
// removing (fires apply-direction-change with expireLive=true).
let pendingTrashDirectionId = null;
function openTrashDirectionModal(directionId) {
  if (!directionId) return;
  pendingTrashDirectionId = directionId;
  const btn = $('trashDirRemove');
  if (btn) { btn.disabled = false; btn.textContent = 'כן, למחוק'; }
  $('trashDirModal')?.classList.remove('hide');
}

function closeTrashDirectionModal() {
  pendingTrashDirectionId = null;
  $('trashDirModal')?.classList.add('hide');
}

async function confirmTrashDirectionRemove() {
  const id = pendingTrashDirectionId;
  if (!id) return;
  // Close the modal RIGHT AWAY. The actual expire+unfollow round-trip
  // takes a few seconds; we don't want the owner stuck staring at a
  // modal spinner for that time. Instead the trash icon on the row
  // rotates in place, giving the same "something's happening" signal
  // without blocking the rest of the UI.
  closeTrashDirectionModal();

  const row      = document.querySelector(`#slotsWrap .slot[data-direction-id="${cssEscape(id)}"]`);
  const trashBtn = row?.querySelector('.slot-trash');
  const editBtn  = row?.querySelector('.slot-edit');
  const origTrashHtml = trashBtn?.innerHTML;
  if (trashBtn) {
    trashBtn.disabled = true;
    trashBtn.innerHTML = '<span class="sb-spinner" style="width:16px;height:16px;display:block"></span>';
  }
  if (editBtn) editBtn.disabled = true;

  try {
    // Trash from the Home card carries "expire the live playlist too"
    // as the default — the owner is looking at the card that's playing
    // right now and hit trash on it. If they wanted to keep today's
    // music running, they'd have used the chat.
    const res = await removeDirectionFromCard(id, { expireLive: true });
    if (!res.ok) throw new Error(res.error || 'לא הצלחנו למחוק');
    // direction-change-applied event (fired inside removeDirectionFromCard)
    // triggers the app.js listener → loadDashboardData + renderPlaylists,
    // and the row disappears naturally. No explicit re-render needed here.
    toast('הכיוון הוסר');
  } catch (e) {
    console.error('confirmTrashDirectionRemove failed:', e);
    toast(String(e.message || 'שגיאה במחיקה'));
    // Restore the row buttons so the owner can retry.
    if (trashBtn) { trashBtn.disabled = false; trashBtn.innerHTML = origTrashHtml || ''; }
    if (editBtn) editBtn.disabled = false;
  }
}

function pickEditFromTrashModal() {
  const id = pendingTrashDirectionId;
  closeTrashDirectionModal();
  if (id) editDirectionFromCard(id);
}

$('trashDirEdit')?.addEventListener('click', pickEditFromTrashModal);
$('trashDirRemove')?.addEventListener('click', confirmTrashDirectionRemove);
$('trashDirCancel')?.addEventListener('click', closeTrashDirectionModal);
$('trashDirModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'trashDirModal') closeTrashDirectionModal();
});

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
  const fill = bar.querySelector('.pl-expand-fill');
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
  const target = dayTargetTracks();
  const pending = playlists.filter((p) => playlistIsExpanding(p, target));

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
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        businessId: business.id,
        playlistId: playlist.id,
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
    const reader = r.body.getReader();
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
          bar.style.opacity = '0';
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
// yet (also the "צור פלייליסטים" link on an empty open day). Confirms with the
// user, then hits /api/v7/account/generate-daily, which builds today's set for
// the business's delivery mode (Option 1: 4 energy-tier playlists; Option 2: 2
// full-length mixes) — the same plan the v7 cron uses.

// The popup's wording per case:
//   openNow   — "צור פלייליסטים עכשיו" before opening: the build acts as
//               though today opens now (api/v7/account/generate-daily.js).
//   closed    — "המקום פתוח?" on a closed day: a ~12-hour set.
//   otherwise — today's set.
const GEN_DAILY_COPY = {
  openNow: { title: 'צור פלייליסטים עכשיו', btn: 'צור פלייליסטים עכשיו',
    text: 'ניצור את הפלייליסטים של היום כבר עכשיו, כאילו המקום נפתח עכשיו — הם יימשכו עד הסגירה.' },
  closed:  { title: 'צור פלייליסטים יומיים', btn: 'צור פלייליסטים יומיים',
    text: 'ניצור לכם סט פלייליסטים באורך של כ־12 שעות לפי הטעם המוזיקלי שלכם.' },
  today:   { title: 'צור פלייליסטים יומיים', btn: 'צור פלייליסטים יומיים',
    text: 'ניצור לכם את הפלייליסטים של היום לפי הטעם המוזיקלי שלכם.' },
};
let genDailyOpenNow = false;

function openGenerateDailyModal({ openNow = false } = {}) {
  // Silently no-op if a build is already running — the closed-day title
  // link stays visible during generation (placeholders don't count as
  // "playlists for today"), so guard against a second confirmation opening
  // the modal and firing a duplicate build.
  if (state.generating) return;
  const modal = $('genDailyModal');
  if (!modal) return;
  genDailyOpenNow = openNow;
  const copy = GEN_DAILY_COPY[openNow ? 'openNow' : todayIsClosed() ? 'closed' : 'today'];
  $('genDailyTitle').textContent = copy.title;
  $('genDailyText').textContent = copy.text;
  const btn = $('genDailyConfirm');
  if (btn) { btn.disabled = false; btn.textContent = copy.btn; }
  modal.classList.remove('hide');
}

function closeGenerateDailyModal() {
  const modal = $('genDailyModal');
  if (!modal) return;
  modal.classList.add('hide');
  // Reset button state in case a prior attempt left it disabled.
  const btn = $('genDailyConfirm');
  if (btn) btn.disabled = false;
}

// Today's playlist names are fixed per type — same order the server plans them
// (api/v7/account/_daily-builder.js planOption1: high tier first; Option 2:
// _option2-builder.js OPTION2_TITLES). null → unknown type, generic placeholder.
function expectedDailySlots(mode) {
  const titles = mode === 'option1' ? OPTION1_DAILY_TITLES
    : mode === 'option2' ? OPTION2_DAILY_TITLES
    : null;
  if (!titles) return null;
  // Dated like the rows the server builds ("Daily Mix #1 · 28.09.2026").
  let isoDate = null;
  try { isoDate = businessWindowAt(bmeta().hours, new Date()).isoDate; } catch { /* undated placeholder */ }
  return titles.map((title, i) => ({ direction_id: `slot-${i}`, title: datedLabel(title, isoDate) }));
}

// replaceToday (Profile tab "החליפו עכשיו"): the server builds a new set that
// starts now and hides each old playlist as its replacement lands. While it
// streams, the list shows only the new set's rows; any old playlist whose
// replacement failed comes back on the final reload.
async function runGenerateDaily({ replaceToday = false, openNow = false } = {}) {
  if (state.generating) return;
  // Close the modal immediately — the build runs in the background and
  // the owner watches placeholders → real rows fill in as each playlist
  // finishes.
  closeGenerateDailyModal();
  // Kick off with an empty plan; the server's first ndjson line ('plan')
  // will populate it in the correctly-ordered set of directions. The names
  // are fixed per daily-playlist type, so the right placeholders go up
  // IMMEDIATELY (the server's plan line only lands after its auth checks,
  // DB reads and planning — seconds on a cold start); the server's plan then
  // replaces this one (same slot-N keys, so nothing flickers when they match).
  const expected = expectedDailySlots(state.deliveryMode);
  state.generating = {
    plan:       expected,                 // [{direction_id, title}, ...]; the server's 'plan' line replaces it
    status:     new Map((expected || []).map((d) => [d.direction_id, 'pending'])),  // → 'pending' | 'built' | 'failed'
    builtRows:  new Map(),                // direction_id → clientRow (from playlistRowToClient)
  };
  // Repaint the title too — on a closed day this flips it from
  // "המקום סגור [המקום פתוח?]" to the normal day/date format immediately,
  // matching the placeholder rows that just appeared below.
  renderPlaylistsTitle();
  renderPlaylists();

  const cleanupOnExit = async () => {
    // Refresh state from DB before clearing state.generating so we don't
    // flicker through an empty-state render between "streaming done" and
    // "loadDashboardData resolved". Built rows are already persisted per
    // direction as they arrived, so the reload picks them up regardless
    // of how the stream ended (done / connection drop / mid-flight error).
    try { await loadDashboardData(business.id); } catch { /* soft */ }
    state.generating = null;
    state.dailyStatus = null;   // stale — the line waits for the fresh one below
    renderPlaylistsTitle();
    renderPlaylists();
    loadDailyStatus();   // the "why no playlists" line, in case nothing was built
  };

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v7/account/generate-daily', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        businessId: business.id,
        bizName: business.name || '',
        replaceToday: !!replaceToday,
        openNow: !!openNow,
      }),
    });
    if (!r.ok) {
      // Pre-streaming error — server returned JSON, not ndjson.
      const data = await r.json().catch(() => ({}));
      throw new Error(data?.error || `שגיאה ${r.status}`);
    }
    if (!r.body) throw new Error('streaming not supported in this browser');

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let builtCount = 0;
    let failedCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch { console.warn('[generate-daily] bad ndjson line:', line.slice(0, 160)); continue; }
        if (!state.generating) continue; // safety: tab or state reset mid-stream

        if (msg.type === 'plan' && Array.isArray(msg.directions)) {
          state.generating.plan = msg.directions.map((d) => ({
            direction_id: d.direction_id,
            title:        d.title || 'פלייליסט',
          }));
          for (const d of state.generating.plan) {
            if (!state.generating.status.has(d.direction_id)) state.generating.status.set(d.direction_id, 'pending');
          }
          renderPlaylists();
        } else if (msg.type === 'built' && msg.direction_id && msg.row) {
          state.generating.status.set(msg.direction_id, 'built');
          state.generating.builtRows.set(msg.direction_id, playlistRowToClient(msg.row));
          builtCount++;
          renderPlaylists();
        } else if (msg.type === 'failed' && msg.direction_id) {
          state.generating.status.set(msg.direction_id, 'failed');
          failedCount++;
          renderPlaylists();
        } else if (msg.type === 'done') {
          // Server-authoritative counts (in case a line was dropped).
          if (Number.isFinite(msg.built))  builtCount  = msg.built;
          if (Number.isFinite(msg.failed)) failedCount = msg.failed;
        }
      }
    }

    await cleanupOnExit();
    if (builtCount && !failedCount)       toast(`נבנו ${builtCount} פלייליסטים ✓`);
    else if (builtCount && failedCount)   toast(`נבנו ${builtCount} מתוך ${builtCount + failedCount} פלייליסטים`);
    else                                  toast('לא הצלחנו לבנות אף פלייליסט — נסו שוב');
  } catch (err) {
    console.error('generate-daily failed:', err);
    await cleanupOnExit();
    toast(String(err.message || 'משהו השתבש — נסו שוב').slice(0, 120));
  }
}

$('genDailyConfirm')?.addEventListener('click', () => runGenerateDaily({ openNow: genDailyOpenNow }));
$('genDailyCancel')?.addEventListener('click', closeGenerateDailyModal);
$('genDailyModal')?.addEventListener('click', (e) => {
  // Click on backdrop (the modal wrapper itself) closes.
  if (e.target?.id === 'genDailyModal') closeGenerateDailyModal();
});

// CSS.escape polyfill for safety with unusual Spotify IDs (they're alphanumeric
// so this is just defensive — but cheap).
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/[^\w-]/g, '\\$&');
}

// ---------- special playlists (v7, 2026-10-03) ----------
// "Tell us which special playlist you need right now": the chat's
// "הכן פלייליסט" saves a card (business_events) and its playlist is built at
// once — the card's button shows a spinner, then "▶ פתח". A card lives only
// for its day (04:00 → 04:00 IL): the playlist expires at the next 04:00
// (ledger + expire cron) and the card is hidden from then on (the row stays
// as history). At most 2 per day — api/v7/account/save-event.js enforces it
// and the chat is told the count.
//
// Build state per card, kept outside the DOM so a re-render (another card
// saved or deleted, the 04:00 refresh) never drops a spinner:
//   'building' → disabled button with a spinner (trash disabled too)
//   'failed'   → "נסו שוב"
// A card whose playlist is live shows "▶ פתח" whatever its state.
const eventBuilds = new Map();      // eventId → 'building' | 'failed'
const RESUME_BUILD_WINDOW_MS = 3 * 60 * 1000;   // a playlist-less card this young is probably still building
const EVENT_BUILD_LOCK_MS    = 190 * 1000;      // a little past event-playlist.js's build lock
let eventsDayTimer = null;

// Look up an event's live (unexpired) playlist by cross-referencing the
// event's id against bmeta().playlists[i].eventId. Shares the expiry gate
// with daily playlists via playlistIsLive.
function activePlaylistForEvent(eventId) {
  return (bmeta().playlists || []).find((p) => p && p.eventId === eventId && playlistIsLive(p)) || null;
}

// Cards of the current special-playlists day (created since the last 04:00 IL).
function todaysEvents() {
  const dayStart = Date.parse(prevIl4amIso());
  return (bmeta().events || []).filter((ev) => Date.parse(ev.created_at) >= dayStart);
}

function renderEvents() {
  const wrap = $('eventsWrap');
  wrap.innerHTML = '';
  const events = todaysEvents();
  // Hide the whole "פלייליסטים אחרים" section when there are no cards —
  // otherwise the user sees a titled but empty box between the daily
  // playlists section and the chat section.
  const box = $('specialBox');
  if (box) box.classList.toggle('hide', events.length === 0);
  // At 04:00 today's cards go; an open page re-renders itself then.
  clearTimeout(eventsDayTimer);
  eventsDayTimer = setTimeout(renderEvents, Math.max(1000, Date.parse(nextIl4amIso()) - Date.now() + 1000));
  for (const ev of events) {
    const live = activePlaylistForEvent(ev.id);
    // After a refresh mid-build the in-memory state is gone: a very young
    // card without a playlist is treated as still building.
    if (!live && !eventBuilds.has(ev.id) && Date.now() - Date.parse(ev.created_at) < RESUME_BUILD_WINDOW_MS) {
      eventBuilds.set(ev.id, 'building');
      waitForEventPlaylist(ev, Date.parse(ev.created_at));
    }
    const building = !live && eventBuilds.get(ev.id) === 'building';

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
    const desc = ev.description || '';
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
    delBtn.title = 'מחיקה';
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
    delBtn.disabled = building;
    delBtn.addEventListener('click', () => openTrashEventModal(ev.id));
    row.append(delBtn);

    if (live) {
      const openA = document.createElement('a');
      openA.className = 'btn';
      openA.style.textDecoration = 'none';
      openA.href = live.url;
      openA.target = '_blank';
      openA.rel = 'noopener';
      openA.textContent = '▶ פתח';
      openA.addEventListener('click', () => logPlaylistOpen(live.id, 'home-event'));
      row.append(openA);
    } else if (building) {
      const busyBtn = document.createElement('button');
      busyBtn.className = 'btn';
      busyBtn.disabled = true;
      busyBtn.innerHTML = '<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>בונים' + WAIT_DOTS_HTML;
      row.append(busyBtn);
    } else {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn';
      retryBtn.textContent = 'נסו שוב';
      retryBtn.addEventListener('click', () => buildEventPlaylist(ev));
      row.append(retryBtn);
    }

    wrap.append(row);
  }
}

// Builds the card's playlist (api/v7/account/event-playlist.js). Called right
// after the chat saves the card, and by "נסו שוב". No auto-open — the button
// turns into "▶ פתח".
async function buildEventPlaylist(ev) {
  if (eventBuilds.get(ev.id) === 'building') return;
  eventBuilds.set(ev.id, 'building');
  renderEvents();
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v7/account/event-playlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: business.id, eventId: ev.id }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409 && data?.code === 'building') {
      waitForEventPlaylist(ev, Date.now());
      return;
    }
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
    eventBuilds.delete(ev.id);
    await loadDashboardData(business.id);
    renderPlaylists();
    renderEvents();
    toast('הפלייליסט מוכן ✓');
  } catch (err) {
    console.error('event-playlist failed:', err);
    if (eventBuilds.has(ev.id)) eventBuilds.set(ev.id, 'failed');
    renderEvents();
    toast(String(err.message || 'משהו השתבש — נסו שוב').slice(0, 120));
  }
}

// Another build of this card is running (a refresh mid-build, a second tab):
// watch the table — no rate limit, unlike the endpoint — until its playlist
// lands. Past the server's build lock, try building again ourselves.
async function waitForEventPlaylist(ev, since) {
  await new Promise((r) => setTimeout(r, 10000));
  if (eventBuilds.get(ev.id) !== 'building') return;            // card deleted meanwhile
  await loadDashboardData(business.id);
  if (activePlaylistForEvent(ev.id) || !todaysEvents().some((e) => e.id === ev.id)) {
    eventBuilds.delete(ev.id);
    renderPlaylists();
    renderEvents();
    return;
  }
  if (Date.now() - since > EVENT_BUILD_LOCK_MS) {
    eventBuilds.delete(ev.id);
    buildEventPlaylist(ev);
    return;
  }
  waitForEventPlaylist(ev, since);
}

// Trash icon on a card → confirmation modal → the card goes at once and the
// server deletes its Spotify playlist too (right away, or after the crons
// when one is running — api/v7/account/delete-event.js). Disabled while the
// card is building.
let pendingTrashEventId = null;
function openTrashEventModal(id) {
  if (!id) return;
  pendingTrashEventId = id;
  const confirmBtn = $('trashEventRemove');
  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'כן, למחוק'; }
  $('trashEventModal')?.classList.remove('hide');
}

function closeTrashEventModal() {
  pendingTrashEventId = null;
  $('trashEventModal')?.classList.add('hide');
}

async function confirmTrashEventRemove() {
  const id = pendingTrashEventId;
  if (!id) return;
  closeTrashEventModal();

  // Remove the card first (Roni, 2026-10-03); put it back if the server fails.
  const removed = (bmeta().events || []).find((e) => e.id === id);
  eventBuilds.delete(id);
  state.dashboard = {
    ...(state.dashboard || {}),
    events: (bmeta().events || []).filter((e) => e.id !== id),
  };
  renderEvents();
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v7/account/delete-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: business.id, eventId: id }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);
    // The server set its playlist's expires_at to now; mirror that.
    state.dashboard = {
      ...(state.dashboard || {}),
      playlists: (bmeta().playlists || []).filter((p) => p.eventId !== id),
    };
  } catch (e) {
    console.error('deleteEvent failed:', e);
    if (removed && !(bmeta().events || []).some((x) => x.id === id)) {
      const events = [...(bmeta().events || []), removed]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      state.dashboard = { ...(state.dashboard || {}), events };
      renderEvents();
    }
    toast(String(e.message || 'שגיאה במחיקה'));
  }
}

$('trashEventRemove')?.addEventListener('click', confirmTrashEventRemove);
$('trashEventCancel')?.addEventListener('click', closeTrashEventModal);
$('trashEventModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'trashEventModal') closeTrashEventModal();
});

// ---------- special-playlists chat ----------
// The owner chats with Gemini (api/v7/account/event-chat.js — prompt, today's
// date and the daily count live on the server) until a reply carries
// state="confirming" + a `proposed` brief; a "הכן פלייליסט" button then
// appears in that bubble. Clicking it saves the card (save-event) and builds
// its playlist straight away (buildEventPlaylist).

const CHAT_PLACEHOLDER = 'לדוגמה: הערב יש לנו מסיבת יום הולדת - פופ שמח וקליל...';

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
// "הכן פלייליסט" button inside the given bubble: it saves the card and
// starts building the playlist. If the user isn't ready yet they keep
// typing in the chat input, so no explicit dismiss button is needed.
function appendConfirmActions(bubble) {
  const row = document.createElement('div');
  row.className = 'chat-actions';

  const goBtn = document.createElement('button');
  goBtn.className = 'btn';
  goBtn.textContent = 'הכן פלייליסט';
  goBtn.addEventListener('click', () => finalizeAndSaveEvent(goBtn));

  row.append(goBtn);
  bubble.append(row);
  scrollChatToBottom();
}

// One turn against /api/v7/account/event-chat — the server-side wrapper
// that persists both messages to business_event_chats and calls Gemini.
// Returns the parsed reply shape { reply_he, state, proposed? }, or
// throws on transport failure.
async function callChatModel(userMessage) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('לא מחוברים');

  const r = await fetch('/api/v7/account/event-chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      businessId:     business?.id,
      message:        userMessage,
      sessionStartAt: SESSION_START_AT_ISO,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) {
    throw new Error(data?.error || `event-chat ${r.status}`);
  }
  return data.assistantMessage?.parsed || {};
}

// Send-button handler. Guards against double-fire while a call is in flight.
async function sendChatMessage() {
  const input = $('chatInput');
  const text = (input.value || '').trim();
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
        name_he: String(reply.proposed.name_he).trim().slice(0, 40),
        description_he: String(reply.proposed.description_he).trim(),
        genre_source: reply.proposed.genre_source === 'daily' ? 'daily' : 'event',
      };
      appendConfirmActions(thinking);
    } else {
      // Any other reply (gathering / off_topic / malformed proposed):
      // clear stale proposed so an old "הכן פלייליסט" click can't fire
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

// "הכן פלייליסט" inside a confirming reply:
//   - POST /api/v7/account/save-event with Gemini's brief (409 'daily_cap'
//     once 2 were made today — its Hebrew message goes to the toast);
//   - splice the row into state and start buildEventPlaylist, which draws
//     the card with its spinner right away;
//   - reset the chat for the next one.
async function finalizeAndSaveEvent(goBtn) {
  if (!chatState.proposed) {
    toast('חסר תיאור — כתבו עוד קצת');
    return;
  }
  const { name_he: name, description_he: description, genre_source } = chatState.proposed;
  goBtn.disabled = true;
  const origHtml = goBtn.innerHTML;
  goBtn.innerHTML = '<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>מכינים' + WAIT_DOTS_HTML;

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');

    const saveRes = await fetch('/api/v7/account/save-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        businessId: business.id,
        event:      { name, description, genre_source },
        // Server backfills business_event_chats.event_id on every row
        // from this chat session so the admin API can surface "here's
        // the conversation that produced event X".
        sessionStartAt: SESSION_START_AT_ISO,
      }),
    });
    const saveData = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok || !saveData.ok || !saveData.event) {
      throw new Error(saveData?.error || `שגיאה ${saveRes.status}`);
    }
    const ev = saveData.event;

    state.dashboard = { ...(state.dashboard || {}), events: [...(bmeta().events || []), ev] };
    buildEventPlaylist(ev);

    // Reset the chat for the next one. Restore the textarea to its initial
    // multi-row + placeholder state. Bump SESSION_START_AT_ISO so the next
    // chat starts with no context from this session — like a hard refresh.
    chatState.messages = [];
    chatState.proposed = null;
    SESSION_START_AT_ISO = new Date().toISOString();
    $('chatMessages').innerHTML = '';
    const ci = $('chatInput');
    ci.rows = 3;
    ci.classList.remove('compact');
    ci.setAttribute('placeholder', CHAT_PLACEHOLDER);
  } catch (err) {
    console.error('finalizeAndSaveEvent failed:', err);
    goBtn.disabled = false;
    goBtn.innerHTML = origHtml;
    toast(String(err.message || 'משהו השתבש — נסו שוב').slice(0, 120));
  }
}

// Both Home-tab chats start each day empty (Ami, 2026-10-21). A page left
// open overnight clears them at 04:00 IL (the special-playlists day), and the
// model forgets yesterday's messages too (a new sessionStartAt), as on a page
// load. Checked by a timer and whenever the page comes back on screen — a
// phone can sleep through the timer. A chat mid-reply is cleared on the next
// check instead.
const chatDay = { taste: prevIl4amIso(), event: prevIl4amIso() };
let chatDayTimer = null;
let chatDayStarted = false;

function resetEventChat() {
  if (chatState.busy) return false;
  chatState.messages = [];
  chatState.proposed = null;
  SESSION_START_AT_ISO = new Date().toISOString();
  $('chatMessages').innerHTML = '';
  const ci = $('chatInput');
  if (ci && !ci.value.trim()) {
    ci.rows = 3;
    ci.classList.remove('compact');
    ci.setAttribute('placeholder', CHAT_PLACEHOLDER);
  }
  return true;
}

function resetChatsIfNewDay() {
  clearTimeout(chatDayTimer);
  const today = prevIl4amIso();
  if (chatDay.taste !== today && resetTasteChat()) chatDay.taste = today;
  if (chatDay.event !== today && resetEventChat()) chatDay.event = today;
  const pending = chatDay.taste !== today || chatDay.event !== today;
  chatDayTimer = setTimeout(resetChatsIfNewDay,
    pending ? 30000 : Math.max(1000, Date.parse(nextIl4amIso()) - Date.now() + 1000));
}

function startChatDayReset() {
  if (chatDayStarted) return;
  chatDayStarted = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resetChatsIfNewDay();
  });
  window.addEventListener('pageshow', resetChatsIfNewDay);
  resetChatsIfNewDay();
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
