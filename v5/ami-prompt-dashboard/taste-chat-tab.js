// Ami's dashboard — "צ'אט הטעם המוזיקלי" tab (2026-10-21).
//
// A test bench for the taste chat ("הטעם המוזיקלי שלכם" on the owner's Home
// tab) on REAL accounts. Ami picks a business; the bench loads exactly the
// context production builds for it each turn (GET /api/internal/taste-bench)
// and shows its profile and recipes. He talks to the chat as the owner, with
// the prompt from this tab, in a chat that looks and behaves like the owner's
// (bubbles, the three-dot "typing" bubble, "אישור" in the reply, and the
// sample songs + genre deck: "שמעו דוגמה" before adding a new style, "בואו
// נשמע" for suggested styles, with the results sent back to the chat).
//
// - Prompts: both are shown until a business is chosen; then only the one of
//   its playlist type. "העבר את העסק לאפשרות X" tries the business on the
//   other type: its stored library for that type, or one built now with the
//   production generator — on the working copy only.
// - Under each reply, in plain words: what the change would do and what
//   wouldn't go through (a dry run with taste-ops applyOps). "אישור" tries it
//   on the working copy, so the next message — and the profile shown — sees it.
// - "שמירה בפרופיל" saves everything tried (the type switch, then the changes)
//   to the real profile (POST /api/internal/taste-bench — logged as an admin
//   change; from the next build).
//
// Same pieces as production (api/v7/account/taste-chat.js): the prompt
// (editable part + fixed part), formatTasteContext, Gemini with medium
// thinking and the conversation history, normalizeTasteReply + vetReply.
// Not in the bench: Spotify links (not looked up), the energy-curve editor
// and "a new mix from now" (described in words instead).
//
// Access: /api/internal/* needs INTERNAL_ADMIN_API_KEY (customer data, on a
// public page). Ami enters it once; it's kept in this browser's localStorage
// until "יציאה".

import { callModel, parseJSONFromText } from '../../v7/generation/ai-provider.js';
import {
  tasteChatEditableSection, assembleTasteChatSystemPrompt, formatTasteContext, normalizeTasteReply, vetReply,
  tasteChatPlaceholder,
} from '../../v7/generation/taste-chat-prompt.js';
import { applyOps, snapshotOf, stateFromSnapshot, withMode, rangeOf, canonicalGenre } from '../../v7/generation/taste-ops.js';
import { levelEnergyWindow } from '../../v7/generation/energy-windows.js';
import { generateEnergyDirections } from '../../v7/generation/energy-directions.js';
import { generateLevelDirections } from '../../v7/generation/level-directions.js';

const $ = (id) => document.getElementById(id);
const KEY_STORE = 'ami-admin-key';
const MODES = ['option1', 'option2'];
const MODE_NAME = { option1: 'אפשרות 1 — 4 פלייליסטים', option2: 'אפשרות 2 — 2 מיקסים' };
const SPINNER = '<span class="sb-spinner"></span>';
const DOTS = '<span class="typing-dots"><span></span><span></span><span></span></span>';

let key = '';
let users = [];          // [{ business_id, name, delivery_mode }]
let loaded = null;       // { business_id, name, mode, ctx } from the server
let state = null;        // working copy of the business's taste state
let switched = null;     // { mode, library } — the type switch tried here, or null
let tried = [];          // changes tried here, newest first: { when, summary_he, ops, undone, before }
let history = [];        // [{ role: 'user' | 'model', text }]
let busy = false;        // a chat turn, a type switch or a save in flight

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const ilTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const pendingChanges = () => tried.filter((c) => !c.undone);
const pendingCount = () => (switched ? 1 : 0) + pendingChanges().length;
const promptOf = (mode) => $(mode === 'option2' ? 'tcPromptOption2' : 'tcPromptOption1');

const status = (text, kind = '') => {
  const s = $('tcStatus');
  s.textContent = text || '';
  s.className = `oc-msg${kind ? ` ${kind}` : ''}`;
};
function loading(text) {
  $('tcLoading').hidden = !text;
  $('tcLoadingText').textContent = text || '';
}
function error(text) {
  $('tcError').hidden = !text;
  $('tcError').textContent = text || '';
}
// A button showing a spinner while its action runs.
function spin(btn, text) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.innerHTML = `${SPINNER}${text}`;
}
function unspin(btn) {
  btn.disabled = false;
  btn.classList.remove('is-busy');
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
  delete btn.dataset.label;
}

// ---------- plain-words descriptions of the chat's changes ----------

const TIER_PLAYLISTS = { high: 'הפלייליסטים האנרגטיים', low: 'הפלייליסטים הרגועים' };
const PREF_WORD = { none: 'בלי העדפה', soft: 'בעיקר', hard: 'רק' };
const WEIGHT_WORD = { 0.25: 'הרבה פחות', 0.5: 'פחות', 1: 'כרגיל', 1.5: 'יותר', 2: 'הרבה יותר' };
// Left-to-right isolate: keeps "50–80" and "H1: Funk, Soul" in order inside
// Hebrew text (without it a range at the end of a line shows as "80–50").
const ltr = (s) => `⁦${s}⁩`;
const rng = (a, b) => ltr(`${a}–${b}`);

// A recipe as "H1: Funk, Soul" (left-to-right, so it stays in order).
function recipeName(s, key) {
  const d = [...(s?.option1Dirs || []), ...(s?.levelDirs || [])].find((x) => x.key === String(key || '').toUpperCase());
  return d ? ltr(`${d.key}: ${d.genres.join(', ')}`) : ltr(String(key || ''));
}

// One op as a short Hebrew sentence, against the state it applies to
// (`after` = the state with the proposal applied, when known).
function describeOp(op, s, after = null) {
  const g = op.genre;
  switch (op.op) {
    case 'set_weight': return op.weight === 1 ? `${g} בכמות הרגילה` : `${WEIGHT_WORD[op.weight] || `משקל ${op.weight}`} ${g}`;
    case 'remove_genre': return `להוציא את ${g} מהפרופיל (ולא להציע אותו שוב)`;
    case 'reject_genre': return `לסמן את ${g} כלא מתאים (לא יוצע שוב)`;
    case 'add_genre': return `להוסיף את ${g} לפרופיל, ברמת אנרגיה ${op.energy_level}`;
    case 'move_genre': return `להעביר את ${g} לרמת אנרגיה ${op.energy_level}`;
    case 'set_requested': {
      const isNew = s && !s.approved.some((a) => a.genre === g);
      const add = isNew ? `להוסיף את ${g} לפרופיל, ברמת אנרגיה ${op.energy_level}, ו` : '';
      return s?.mode === 'option1'
        ? `${add}${isNew ? 'לשים אותו' : `${g} יהיה`} בכל פלייליסט של רמת האנרגיה שלו, כל יום (סופר לייק)`
        : `${add}לסמן את ${isNew ? 'הסגנון' : g} כמבוקש (סופר לייק)`;
    }
    case 'dir_add': return `להוסיף את ${g} למתכון ${recipeName(s, op.dir)}`;
    case 'dir_remove': return `להוציא את ${g} מהמתכון ${recipeName(s, op.dir)}`;
    case 'dir_new': return op.tier
      ? `מתכון חדש ל${TIER_PLAYLISTS[op.tier] || op.tier}: ${(op.genres || []).join(', ')}`
      : `מתכון חדש ברמת אנרגיה ${op.energy_level}: ${(op.genres || []).join(', ')}`;
    case 'dir_delete': return `למחוק את המתכון ${recipeName(s, op.dir)}`;
    case 'set_pref': {
      const what = op.field === 'instrumentalness' ? 'שירים אינסטרומנטליים' : 'שירים מוכרים';
      const where = op.tier === 'high' || op.tier === 'low' ? ` ב${TIER_PLAYLISTS[op.tier]}` : '';
      return `${what}${where}: ${PREF_WORD[op.value] || op.value}`;
    }
    case 'shift_window': {
      const w = s?.windows?.[op.tier];
      const w2 = after?.windows?.[op.tier];
      const to = w && w2 ? ` (מ-${rng(w[0], w[1])} ל-${rng(w2[0], w2[1])})` : '';
      return `${op.delta > 0 ? 'להעלות' : 'להוריד'} את האנרגיה של ${TIER_PLAYLISTS[op.tier] || op.tier} ב-${Math.abs(op.delta)}${to}`;
    }
    case 'set_range': return `טווח אנרגיה ${rng(op.min, op.max)} למתכון ${recipeName(s, op.dir)}`;
    case 'allow_track': return `להוסיף את השיר שבעל העסק שלח ל${g}`;
    case 'undo': return 'לבטל את השינוי האחרון';
    default: return op.op;
  }
}

const PAIRING_HE = {
  'LoFi only with LoFi': 'LoFi רק עם LoFi',
  'DownTempo only with DownTempo': 'DownTempo רק עם DownTempo',
  'Electronic R&B only with house / Nu Disco / Indie Dance': 'Electronic R&B רק עם האוס, Nu Disco או Indie Dance',
};
const pairingHe = (rule) => PAIRING_HE[rule] || rule;

// taste-ops' reasons (English) in Hebrew; anything unknown stays as it is.
function reasonHe(reason) {
  const r = String(reason || '');
  const pr = r.match(/^would break a pairing rule \((.+)\)$/);
  if (pr) return `שובר חוק שילוב: ${pairingHe(pr[1])}`;
  const map = [
    [/^not one of the approved genres$/, 'הז\'אנר לא בפרופיל'],
    [/^genre must be one of the approved genres$/, 'הז\'אנר לא בפרופיל'],
    [/^not a genre from the catalog$/, 'הז\'אנר לא קיים בקטלוג'],
    [/^unknown genre$/, 'הז\'אנר לא קיים בקטלוג'],
    [/^not in the profile$/, 'הז\'אנר לא בפרופיל'],
    [/^already approved$/, 'הז\'אנר כבר בפרופיל'],
    [/^already at that level$/, 'הז\'אנר כבר ברמה הזו'],
    [/^energy_level must be/, 'רמת אנרגיה לא תקינה'],
    [/^not approved yet/, 'הז\'אנר עוד לא בפרופיל וחסרה לו רמת אנרגיה'],
    [/^no such recipe$/, 'אין מתכון כזה'],
    [/^genre is at another energy level$/, 'הז\'אנר ברמת אנרגיה אחרת'],
    [/^genre is in the other energy tier$/, 'הז\'אנר בפלייליסטים מהסוג השני (אנרגטי / רגוע)'],
    [/^genre is not in that recipe$/, 'הז\'אנר לא במתכון הזה'],
    [/most recipes allowed$/, 'כבר יש מקסימום מתכונים'],
    [/^no approved genre of that (level|tier)$/, 'אין ז\'אנר מהפרופיל שמתאים לשם'],
    [/^the window is already at the edge of the scale$/, 'טווח האנרגיה כבר בקצה'],
    [/^Option 1 only$/, 'רק באפשרות 1'],
    [/^Option 2 only$/, 'רק באפשרות 2'],
    [/^tier is for Option 1 only$/, 'רק באפשרות 1'],
    [/^not a song the owner linked/, 'השיר לא נשלח בשיחה (כאן בבדיקה קישורים לא נקראים)'],
    [/^approved — use remove_genre$/, 'הז\'אנר בפרופיל — צריך להוציא אותו, לא לדחות'],
    [/^weight must be/, 'משקל לא תקין'],
    [/^value must be/, 'ערך לא תקין'],
    [/^min\/max must be/, 'טווח אנרגיה לא תקין'],
    [/^delta must be/, 'שינוי אנרגיה לא תקין'],
    [/^tier must be/, 'לא צוין אם אלה האנרגטיים או הרגועים'],
    [/^tier is for popularity only$/, 'הפרדה לפי סוג פלייליסט קיימת רק לשירים מוכרים'],
    [/^field must be/, 'העדפה לא מוכרת'],
    [/^unknown op$/, 'פעולה לא מוכרת'],
  ];
  for (const [re, he] of map) if (re.test(r)) return he;
  return r;
}

// finalize's notes (English) in Hebrew.
function noteHe(note) {
  const n = String(note || '');
  let m = n.match(/^gave (.+) a recipe of its own$/);
  if (m) return `${m[1]} קיבל מתכון משלו`;
  m = n.match(/^the (high|low) tier had no recipe left/);
  if (m) return `ל${TIER_PLAYLISTS[m[1]]} לא נשאר מתכון — נבנה אחד מכל הז'אנרים שלהם`;
  m = n.match(/^pairing rules: (?:(?:high|low|L\d): )?"(.+)": took out (.+) \((.+)\)$/);
  if (m) return `חוקי השילוב: מהמתכון "${m[1]}" יצאו ${m[2]} (${pairingHe(m[3])})`;
  m = n.match(/^pairing rules: (?:(?:high|low|L\d): )?new recipe for (.+)$/);
  if (m) return `חוקי השילוב: מתכון חדש ל-${m[1]}`;
  return n;
}

// ---------- access + the business list ----------

function storedKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } }
function storeKey(k) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch { /* private mode */ } }

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('המפתח לא נכון.'), { badKey: true });
  if (!r.ok) throw Object.assign(new Error(data?.error || `שגיאה ${r.status}`), { status: r.status, data });
  return data;
}

function showKeyRow() {
  $('tcKeyRow').hidden = false;
  $('tcPicker').hidden = true;
  $('tcLogout').hidden = true;
}

function resetBusiness() {
  loaded = null;
  state = null;
  switched = null;
  tried = [];
  history = [];
  heard.clear();
  $('tcLog').replaceChildren();
  status('');
}

function logout() {
  if (pendingCount() && !window.confirm('יש שינויים שנוסו כאן ולא נשמרו. לצאת ולוותר עליהם?')) return;
  key = '';
  storeKey('');
  users = [];
  resetBusiness();
  error('');
  showKeyRow();
  render();
  $('tcKey').focus();
}

async function loadUsers() {
  const btn = $('tcKeySave');
  error('');
  if ($('tcKeyRow').hidden) loading('טוען את רשימת העסקים…');
  else spin(btn, 'בודק…');
  try {
    const data = await api('/api/internal/users');
    users = (data.businesses || []).filter((b) => b.delivery_mode)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he'));
    $('tcUser').replaceChildren(el('option', { value: '' }, 'בחרו עסק…'),
      ...users.map((u) => el('option', { value: u.business_id }, `${u.name || '(בלי שם)'} · ${u.delivery_mode === 'option2' ? '2 מיקסים' : '4 פלייליסטים'}`)));
    $('tcKeyRow').hidden = true;
    $('tcPicker').hidden = false;
    $('tcLogout').hidden = false;
    $('tcKey').value = '';
  } catch (e) {
    if (e.badKey) { storeKey(''); key = ''; showKeyRow(); }
    error(e.message);
  } finally {
    loading('');
    unspin(btn);
  }
}

// ---------- the business's profile ----------

function chip(text, mark = '', title = null) {
  const c = el('span', { class: 'tcp-chip', title, dir: 'auto' }, text);
  if (mark) c.append(el('span', { class: 'mark' }, mark));
  return c;
}

function genreChip(g) {
  const marks = [];
  const titles = [];
  if (state.requested.includes(g)) { marks.push('★'); titles.push('מבוקש — בכל פלייליסט של הרמה שלו'); }
  const w = state.weights[g];
  if (w != null && w !== 1) { marks.push(w > 1 ? '↑' : '↓'); titles.push(`משקל ${w} (${WEIGHT_WORD[w] || ''})`); }
  return chip(g, marks.join(''), titles.join(' · ') || null);
}

function row(label, children, sub = null) {
  const right = el('div', {}, el('div', { class: 'tcp-chips' }, ...children));
  if (sub) right.append(el('div', { class: 'tcp-sub' }, sub));
  return el('div', { class: 'tcp-row' }, el('div', { class: 'tcp-label' }, label), right);
}

function renderProfile() {
  const card = $('tcProfileCard');
  card.hidden = !loaded;
  if (!loaded) return;
  const s = state;
  $('tcProfileTitle').textContent = `הפרופיל של ${loaded.name || 'העסק'} · ${MODE_NAME[s.mode]}`;
  $('tcProfileHint').hidden = !pendingCount();
  const box = $('tcProfile');
  box.replaceChildren();

  // Genres by energy level, the most energetic first.
  const levels = el('div', { class: 'tcp-section' }, el('div', { class: 'tcp-h' }, `ז'אנרים לפי רמת אנרגיה (${s.N} רמות)`));
  for (let L = s.N; L >= 1; L--) {
    const genres = s.approved.filter((a) => a.energy_level === L).map((a) => a.genre);
    let label = `רמה ${L}`;
    let sub = null;
    if (s.mode === 'option1') label += L > s.N / 2 ? ' · אנרגטי' : ' · רגוע';
    else { const w = levelEnergyWindow(L, s.N); sub = `טווח אנרגיה של השירים: ${rng(w.min, w.max)}`; }
    levels.append(row(label, genres.length ? genres.map(genreChip) : [el('span', { class: 'tcp-sub' }, '—')], sub));
  }
  if (s.mode === 'option1') {
    levels.append(el('div', { class: 'tcp-sub' },
      `טווח אנרגיה של השירים: בפלייליסטים האנרגטיים ${rng(...s.windows.high)}, ברגועים ${rng(...s.windows.low)}. ★ = מבוקש, ↑ / ↓ = יותר / פחות מהרגיל.`));
  } else {
    levels.append(el('div', { class: 'tcp-sub' }, '★ = מבוקש, ↑ / ↓ = יותר / פחות מהרגיל.'));
  }
  box.append(levels);

  // Recipes.
  const recipes = el('div', { class: 'tcp-section' }, el('div', { class: 'tcp-h' }, 'מתכונים'));
  if (s.mode === 'option1') {
    for (const tier of ['high', 'low']) {
      const dirs = s.option1Dirs.filter((d) => d.energy_tier === tier);
      recipes.append(row(tier === 'high' ? 'אנרגיה גבוהה' : 'אנרגיה רגועה',
        dirs.length ? dirs.map((d) => chip(`${d.key} · ${d.genres.join(', ')}`)) : [el('span', { class: 'tcp-sub' }, '—')]));
    }
  } else {
    for (let L = s.N; L >= 1; L--) {
      const dirs = s.levelDirs.filter((d) => d.energy_level === L);
      if (!dirs.length && !s.approved.some((a) => a.energy_level === L)) continue;
      recipes.append(row(`רמה ${L}`, dirs.length
        ? dirs.map((d) => chip(`${d.key} · ${d.genres.join(', ')}${d.energy_range ? ` (${rangeOf(d, s.N).join('–')})` : ''}`))
        : [el('span', { class: 'tcp-sub' }, 'אין מתכונים — כל הז\'אנרים של הרמה מתנגנים יחד')]));
    }
  }
  box.append(recipes);

  // The rest, collapsed.
  const more = el('details', { class: 'tcp-more' }, el('summary', {}, 'עוד: העדפות, בהמתנה, נדחו, שירים של בעל העסק'));
  const pop = s.mode === 'option1' && s.popTiers
    ? `באנרגטיים ${PREF_WORD[s.popTiers.high]}, ברגועים ${PREF_WORD[s.popTiers.low]}`
    : PREF_WORD[s.pop];
  more.append(
    row('העדפות', [chip(`אינסטרומנטליים: ${PREF_WORD[s.inst]}`), chip(`שירים מוכרים: ${pop}`)]),
    row('בהמתנה (לא מתנגנים)', s.conditional.length ? s.conditional.map((c) => chip(`${c.genre} · רמה ${c.energy_level}`)) : [el('span', { class: 'tcp-sub' }, '—')]),
    row('נדחו', s.rejected.length ? s.rejected.map((g) => chip(g)) : [el('span', { class: 'tcp-sub' }, '—')]),
    row('שירים של בעל העסק', s.allowed.length ? s.allowed.map((a) => chip(`${a.title || a.spotify_id} — ${a.artist || '?'} (${a.genre})`)) : [el('span', { class: 'tcp-sub' }, '—')]),
  );
  box.append(more);
}

// ---------- the chosen business ----------

// Everything that depends on the current state: profile, prompts, business
// line, switch button, save button.
function render() {
  const mode = state?.mode || null;
  for (const block of document.querySelectorAll('#tabTaste .tc-prompt')) block.hidden = !!mode && block.dataset.opt !== mode;
  $('tcPromptHint').textContent = !loaded
    ? 'פרומפט נפרד לכל סוג פלייליסטים יומיים. אחרי שבוחרים עסק נשאר רק הפרומפט של הסוג שלו.'
    : `הצ'אט של ${loaded.name || 'העסק'} עובד עם הפרומפט של ${MODE_NAME[mode]}.`;
  // The owner's placeholder for this type (while the input still shows one).
  if (!$('tcInput').classList.contains('compact')) $('tcInput').setAttribute('placeholder', tasteChatPlaceholder(mode));

  $('tcBusiness').hidden = !loaded;
  if (loaded) {
    const recipes = mode === 'option2' ? state.levelDirs.length : state.option1Dirs.length;
    $('tcUserLine').textContent = `${state.approved.length} ז'אנרים מאושרים · ${state.N} רמות אנרגיה · ${recipes} מתכונים`;
    $('tcSwitched').hidden = !switched;
    $('tcSwitched').textContent = switched ? `בבדיקה: העסק הועבר ל${MODE_NAME[switched.mode]} — עוד לא נשמר בפרופיל.` : '';
    const target = mode === 'option1' ? 'option2' : 'option1';
    const sw = $('tcSwitch');
    if (!sw.dataset.label) {
      sw.textContent = `העבר את העסק ל${MODE_NAME[target]} (השינוי לא יישמר בפרופיל בלי האישור הסופי שלך)`;
      sw.disabled = busy;
    }
  }
  renderProfile();

  const n = pendingCount();
  const save = $('tcSave');
  if (!save.dataset.label) {
    save.disabled = !n || busy;
    save.textContent = n ? `שמירה בפרופיל של ${loaded?.name || 'העסק'} (${n})` : 'שמירה בפרופיל';
  }
}

async function loadUser(id, { keepChat = false } = {}) {
  error('');
  loading('טוען את העסק…');
  $('tcBusiness').hidden = true;
  $('tcProfileCard').hidden = true;
  try {
    loaded = await api(`/api/internal/taste-bench?id=${encodeURIComponent(id)}`);
    state = clone(loaded.ctx.state);
    switched = null;
    tried = [];
    if (!keepChat) { history = []; heard.clear(); $('tcLog').replaceChildren(); resetInput(); }
  } catch (e) {
    loaded = null;
    state = null;
    if (e.badKey) { storeKey(''); key = ''; showKeyRow(); }
    error(e.data?.code === 'not-ready' ? 'לעסק הזה עוד אין פרופיל טעם או סוג פלייליסטים.' : e.message);
  } finally {
    loading('');
    render();
  }
}

function contextNow() {
  const ctx = loaded.ctx;
  return {
    ...ctx,
    state,
    // After a type switch tried here, today's playlists and the energy curve
    // belong to the other type — the chat sees none, as on a fresh switch.
    ...(switched ? { today: {}, curve: null } : {}),
    changes: [
      ...tried.map(({ when, summary_he, ops, undone }) => ({ when, summary_he, ops, undone })),
      ...(ctx.changes || []),
    ],
  };
}

// The library for `mode`: the business's stored one when it has it, else one
// built now with the production generator (as an owner's own switch does).
async function libraryFor(mode) {
  const orig = loaded.ctx.state;
  if (mode === 'option1' && orig.option1Dirs.length) {
    return orig.option1Dirs.map(({ energy_tier, title_en, genres }) => ({ energy_tier, title_en, genres }));
  }
  if (mode === 'option2' && orig.levelDirs.length) {
    return orig.levelDirs.map(({ energy_level, title_en, genres }) => ({ energy_level, title_en, genres }));
  }
  const tasteProfile = { energy_levels_total: orig.N, approved_genres: orig.approved, requested_genres: orig.requested };
  const b = loaded.ctx.business || {};
  const args = { tasteProfile, bizName: b.name, bizDesc: b.description, atmospheres: [], musicalEmphases: b.emphases, place: null };
  const r = mode === 'option1'
    ? await generateEnergyDirections(args)
    : await generateLevelDirections({ ...args, label: 'ami-level-directions' });
  if (r.error) throw new Error(`בניית המתכונים נכשלה: ${r.reasoning_en || r.error}`);
  return r.directions;
}

async function switchType() {
  if (!loaded || busy) return;
  const target = state.mode === 'option1' ? 'option2' : 'option1';
  if (pendingChanges().length && !window.confirm('השינויים שנוסו כאן ועוד לא נשמרו יימחקו. להמשיך?')) return;
  // Back to the business's own type = drop the switch.
  if (target === loaded.mode) {
    state = clone(loaded.ctx.state);
    switched = null;
    tried = [];
    $('tcLog').append(el('div', { class: 'oc-sep' }, `— העסק חזר ל${MODE_NAME[target]} —`));
    render();
    return;
  }
  const btn = $('tcSwitch');
  const stored = target === 'option1' ? loaded.ctx.state.option1Dirs.length : loaded.ctx.state.levelDirs.length;
  busy = true;
  spin(btn, stored ? 'מעביר…' : 'בונה מתכונים לסוג החדש… (עד דקה)');
  error('');
  try {
    const library = await libraryFor(target);
    state = withMode(loaded.ctx.state, target, library);
    switched = { mode: target, library };
    tried = [];
    $('tcLog').append(el('div', { class: 'oc-sep' }, `— בבדיקה: העסק הועבר ל${MODE_NAME[target]} —`));
  } catch (e) {
    error(e.message);
  } finally {
    busy = false;
    unspin(btn);
    render();
  }
}

// ---------- the sample songs and the genre deck (as on the owner's page) ----------
// Copied from v7/account/taste-chat.js (openSamples / openDeck / renderPlayer):
// one card at a time in #tcModal, the song from /api/v7/anchor-tracks with the
// business's instrumental / popularity preferences. Differences: the deck's
// "לא בשבילי" goes into the working copy as a tried change (production writes
// it at once), and "אישור" applies here only.

const DECK_RESULTS_PREFIX = '[תוצאות ההאזנה]';   // = taste-chat-prompt.js / v7/account/taste-chat.js
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M8.2 5.6v12.8L19 12z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><rect x="6.6" y="5.6" width="3.9" height="12.8" rx="1.2"/><rect x="13.5" y="5.6" width="3.9" height="12.8" rx="1.2"/></svg>';
const SWAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';
const STAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtTime = (ms) => { const s = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const heard = new Set();   // genres heard in this conversation (no second sample), as on the owner's page
let modal = null;          // { controller }

// Spotify IFrame API. index.html catches an early load in window.__sbIframeApi.
let apiPromise = null;
function spotifyApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.__sbIframeApi) { resolve(window.__sbIframeApi); return; }
    const prev = window.onSpotifyIframeApiReady;
    window.onSpotifyIframeApiReady = (api) => {
      window.__sbIframeApi = api;
      if (typeof prev === 'function') { try { prev(api); } catch { /* ignore */ } }
      resolve(api);
    };
  });
  return apiPromise;
}

async function sampleTrack(genre, seen) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('/api/v7/anchor-tracks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specs: [{ rank: 1, genre, inst_pref: state?.inst || 'none', pop_pref: state?.pop || 'none' }] }),
    });
    const d = await r.json().catch(() => ({}));
    const id = d?.byRank?.['1'];
    if (!id) return null;
    if (!seen.has(id) || attempt === 2) return id;
  }
  return null;
}

async function trackMeta(id) {
  try {
    const r = await fetch('/api/v4/spotify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_track', track_id: id }),
    });
    const d = await r.json().catch(() => ({}));
    return { name: d?.name || '', artist: (d?.artists || []).map((a) => a.name).join(', '), art: d?.album?.images?.[1]?.url || d?.album?.images?.[0]?.url || '' };
  } catch { return { name: '', artist: '', art: '' }; }
}

function destroyPlayer() {
  if (modal?.controller) { try { modal.controller.destroy(); } catch { /* ignore */ } }
  if (modal) modal.controller = null;
}

function openModal(title, desc) {
  destroyPlayer();
  modal = { controller: null };
  $('tmTitle').textContent = title;
  $('tmDesc').textContent = desc || '';
  $('tcModal').hidden = false;
}

function closeModal() {
  destroyPlayer();
  modal = null;
  $('tcModal').hidden = true;
}

// One song card: art + play/pause + progress + "another song".
async function renderPlayer(genre, seen) {
  $('tmBody').innerHTML = `<div class="dp-loading">${SPINNER}מחפשים שיר לדוגמה…</div>`;
  const id = await sampleTrack(genre, seen).catch(() => null);
  if (!modal) return null;
  if (!id) {
    $('tmBody').innerHTML = '<div class="dp-empty">לא מצאנו שיר לדוגמה לסגנון הזה.</div>';
    return null;
  }
  seen.add(id);
  const meta = await trackMeta(id);
  if (!modal) return null;
  destroyPlayer();
  const art = meta.art ? `<img class="dp-art" src="${esc(meta.art)}" alt="">` : '<div class="dp-art dp-art-ph">🎵</div>';
  const body = $('tmBody');
  body.innerHTML =
    `<div class="dp-card"><div class="dp-art-wrap">${art}` +
    `<button class="dp-play" type="button" aria-label="נגן">${PLAY_ICON}</button>` +
    '<div class="dp-hidden-embed"><div class="dp-embed-mount"></div></div></div>' +
    `<div class="dp-title-row"><div class="dp-track-name">${esc(meta.name)}</div><div class="dp-track-artist">${esc(meta.artist)}</div></div>` +
    '<div class="dp-progress"><div class="dp-prog-bar"><div class="dp-prog-track"><div class="dp-prog-fill"></div></div><div class="dp-prog-thumb"></div></div>' +
    '<div class="dp-timestamps"><span class="dp-prog-current">0:00</span><span class="dp-prog-total">0:00</span></div></div>' +
    `<button class="dp-swap" type="button">${SWAP_ICON}<span>שמעו שיר אחר</span></button></div>`;
  const card = body.querySelector('.dp-card');
  const playBtn = card.querySelector('.dp-play');
  const fill = card.querySelector('.dp-prog-fill');
  const thumb = card.querySelector('.dp-prog-thumb');
  const cur = card.querySelector('.dp-prog-current');
  const tot = card.querySelector('.dp-prog-total');
  const bar = card.querySelector('.dp-prog-bar');
  const pb = { pos: 0, at: Date.now(), dur: 0, paused: true };
  (function tick() {
    if (!card.isConnected) return;
    const pos = pb.paused ? pb.pos : Math.min(pb.dur || Infinity, pb.pos + Date.now() - pb.at);
    const pct = pb.dur > 0 ? Math.min(1, pos / pb.dur) : 0;
    fill.style.width = `${pct * 100}%`;
    thumb.style.left = `${pct * 100}%`;
    cur.textContent = fmtTime(pos);
    tot.textContent = fmtTime(pb.dur);
    requestAnimationFrame(tick);
  })();
  bar.addEventListener('click', (e) => {
    if (!pb.dur || !modal?.controller) return;
    const r = bar.getBoundingClientRect();
    const sec = ((Math.max(r.left, Math.min(r.right, e.clientX)) - r.left) / r.width) * (pb.dur / 1000);
    try { modal.controller.seek(sec); } catch { /* ignore */ }
    pb.pos = sec * 1000;
    pb.at = Date.now();
  });
  let pendingPlay = false;
  playBtn.addEventListener('click', () => {
    if (modal?.controller) { try { modal.controller.togglePlay(); } catch { /* ignore */ } } else pendingPlay = true;
  });
  card.querySelector('.dp-swap').addEventListener('click', () => { renderPlayer(genre, seen); });
  const api = await spotifyApi();
  if (!modal || !card.isConnected) return id;
  api.createController(card.querySelector('.dp-embed-mount'), { uri: `spotify:track:${id}`, width: '100%', height: 80 }, (c) => {
    if (!modal || !card.isConnected) { try { c.destroy(); } catch { /* ignore */ } return; }
    modal.controller = c;
    c.addListener('playback_update', (e) => {
      const d = e?.data || {};
      pb.paused = d.isPaused !== false;
      playBtn.innerHTML = pb.paused ? PLAY_ICON : PAUSE_ICON;
      if (d.duration > 0) pb.dur = d.duration;
      if (typeof d.position === 'number') { pb.pos = d.position; pb.at = Date.now(); }
    });
    if (pendingPlay) { pendingPlay = false; try { c.play(); } catch { /* ignore */ } }
  });
  return id;
}

function setActions(buttons) {
  $('tmActions').replaceChildren(...buttons.map(({ label, ghost, onClick, html }) => {
    const b = el('button', { class: ghost ? 'dp-btn ghost' : 'dp-btn', type: 'button' });
    if (html) b.innerHTML = html; else b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }));
}

// Before confirming a change that adds genres: a sample per genre, then
// "אישור והוספה" (onConfirm) or back to the chat.
function openSamples(genres, onConfirm) {
  let i = 0;
  const seen = new Set();
  const step = () => {
    const g = genres[i];
    openModal(genres.length > 1 ? `דוגמה ${i + 1} מתוך ${genres.length}` : 'דוגמה לפני שמוסיפים', g);
    renderPlayer(g, seen);
    const last = i === genres.length - 1;
    setActions([
      { label: 'לא מתאים · חזרה לצ׳אט', ghost: true, onClick: closeModal },
      last
        ? { label: 'אישור והוספה', onClick: () => { genres.forEach((x) => heard.add(x)); closeModal(); onConfirm(); } }
        : { label: 'לשיר הבא', onClick: () => { i++; step(); } },
    ]);
  };
  step();
}

// The genre deck: a card per suggestion → like / dislike / super-like; the
// results go back to the chat as the same message the owner's page sends.
function openDeck(suggestions, btn) {
  let i = 0;
  const seen = new Set();
  const results = { liked: [], super: [], disliked: [] };
  const label = (s) => s.label_he || s.genre;
  const finish = () => {
    closeModal();
    btn.disabled = true;
    suggestions.forEach((s) => heard.add(s.genre));
    if (results.disliked.length) {
      const r = applyOps(state, results.disliked.map((s) => ({ op: 'reject_genre', genre: s.genre })));
      if (r.changed) {
        tried.unshift({ when: ilTime(), summary_he: `לא בשבילי: ${results.disliked.map(label).join(', ')}`, ops: r.applied, undone: false, before: snapshotOf(state) });
        state = r.state;
        render();
      }
    }
    const part = (name, list) => (list.length ? `${name}: ${list.map((s) => `${label(s)} (${s.genre})`).join(', ')}.` : '');
    const parts = [part('סופר לייק', results.super), part('אהבתי', results.liked), part('לא בשבילי', results.disliked)].filter(Boolean);
    send([DECK_RESULTS_PREFIX, ...parts].join(' '), { visibleText: parts.join(' ') || 'שמעתי את כולם' });
  };
  const step = () => {
    const s = suggestions[i];
    openModal(`${label(s)} · ${i + 1} מתוך ${suggestions.length}`, '');
    renderPlayer(s.genre, seen);
    const next = (bucket) => () => {
      results[bucket].push(s);
      i++;
      if (i < suggestions.length) step(); else finish();
    };
    setActions([
      { label: 'לא בשבילי', ghost: true, onClick: next('disliked') },
      { label: 'אהבתי', onClick: next('liked') },
      { html: `${STAR_ICON}<span>סופר לייק</span>`, onClick: next('super') },
    ]);
  };
  step();
}

// ---------- the conversation (the owner chat's look and behaviour) ----------

const scrollDown = () => { const log = $('tcLog'); log.scrollTop = log.scrollHeight; };

function resetInput() {
  const input = $('tcInput');
  input.rows = 3;
  input.classList.remove('compact');
  input.setAttribute('placeholder', tasteChatPlaceholder(state?.mode));
}

function bubble(role, text, { thinking = false } = {}) {
  const b = el('div', { class: `oc-bubble ${role}${thinking ? ' thinking' : ''}` });
  if (thinking) b.innerHTML = DOTS;
  else b.textContent = text;
  $('tcLog').append(b);
  scrollDown();
  return b;
}

// A change from the reply, tried on the working copy → the note shown instead
// of the button.
function tryChange(summary_he, ops) {
  const again = applyOps(state, ops);
  tried.unshift({ when: ilTime(), summary_he: summary_he || '', ops: again.applied, undone: false, before: snapshotOf(state) });
  state = again.state;
  return '✓ עודכן כאן — עוד לא נשמר בפרופיל';
}

// The reply as the owner would see it (after production's checks, vetReply),
// then (bench only) what it means in plain words, then the owner's buttons.
//   original — the model's own text (vetReply replaces it when nothing applies)
//   dry      — the proposal's dry run, for "what would change / what wouldn't"
//   offered  — the suggestions before vetReply filtered them
function fillReply(b, reply, { original, dry, isUndo, offered }) {
  b.classList.remove('thinking');
  b.textContent = (reply.reply_he || '').trim() || '(אין תשובה)';
  const info = el('div', { class: 'oc-info' });
  let act = null;

  if (reply.proposal && isUndo) {
    const last = tried.find((c) => !c.undone);
    info.append(el('div', {}, last
      ? `ביטול של "${last.summary_he}" (שינוי שנוסה כאן).`
      : 'ביטול השינוי האחרון של בעל העסק — לא נבדק כאן.'));
    if (last) {
      act = () => {
        state = applyOps(stateFromSnapshot(state, last.before), []).state;
        last.undone = true;
        return '✓ בוטל כאן';
      };
    }
  } else if (reply.proposal) {
    info.append(el('div', {}, 'מה ישתנה:'), el('ul', {}, ...dry.applied.map((o) => el('li', {}, describeOp(o, state, dry.state)))));
    if (dry.notes.length) info.append(el('ul', {}, ...dry.notes.map((n) => el('li', {}, noteHe(n)))));
    act = () => tryChange(reply.proposal.summary_he, dry.applied);
  } else if (dry) {
    info.append(el('div', { class: 'no' }, `הצ'אט ענה: "${original}". שום דבר מההצעה לא יכול להשתנות, ולכן בעל העסק רואה במקומה את ההודעה שלמעלה.`));
  }
  if (dry?.dropped.length) {
    info.append(el('div', { class: 'no' }, 'לא יעבור:'),
      el('ul', { class: 'no' }, ...dry.dropped.map((d) => el('li', {}, `${describeOp(d.op || {}, state)} — ${reasonHe(d.reason)}`))));
  }
  if (offered?.length) {
    const kept = new Set((reply.suggestions || []).map((s) => s.genre));
    const out = offered.filter((s) => !kept.has(canonicalGenre(s.genre)));
    if (reply.suggestions) info.append(el('div', {}, `הצ'אט מציע לשמוע: ${reply.suggestions.map((s) => `${s.label_he} (${s.genre})`).join(', ')}.`));
    if (out.length) {
      info.append(el('div', { class: 'no' },
        `${reply.suggestions ? 'לא יוצעו' : 'אף סגנון לא יוצע'} (כבר בפרופיל, נדחו בעבר או לא בקטלוג): ${out.map((s) => s.genre).join(', ')}`));
    }
  }
  if (reply.timeline_hint) info.append(el('div', {}, `הצ'אט מציע לפתוח את ציר האנרגיה, ${reply.timeline_hint.direction === 'down' ? 'להוריד' : 'להעלות'} ב-${reply.timeline_hint.time}.`));
  if (reply.offer_new_mix) info.append(el('div', {}, 'הצ\'אט מציע לבנות מיקס חדש מעכשיו.'));
  if (info.childNodes.length) b.append(info);

  // The owner's buttons (renderActions in v7/account/taste-chat.js).
  const row = el('div', { class: 'oc-actions' });
  const addButton = (label, onClick) => {
    const btn = el('button', { class: 'oc-btn', type: 'button' }, label);
    btn.addEventListener('click', () => onClick(btn));
    row.append(btn);
  };
  const done = (note) => { row.replaceWith(el('div', { class: 'oc-note' }, note)); render(); };
  if (reply.state === 'confirming' && act) {
    const toHear = (reply.proposal.new_genres || []).filter((g) => !heard.has(g));
    if (toHear.length) addButton(toHear.length > 1 ? 'שמעו דוגמאות' : 'שמעו דוגמה', () => openSamples(toHear, () => done(act())));
    else addButton('אישור', () => done(act()));
  }
  if (reply.state === 'suggesting' && reply.suggestions?.length) addButton('בואו נשמע', (btn) => openDeck(reply.suggestions, btn));
  if (row.childNodes.length) b.append(row);
  scrollDown();
}

// A turn. `textArg` + `visibleText` = the deck's results (sent to the chat,
// shown short), as on the owner's page; otherwise the input box.
async function send(textArg, { visibleText } = {}) {
  if (busy) return;
  const input = $('tcInput');
  const fromInput = typeof textArg !== 'string';
  const text = fromInput ? input.value.trim() : textArg;
  if (!text) return;
  if (!loaded) { status('בחרו קודם עסק.', 'err'); return; }
  busy = true;
  $('tcSend').disabled = true;
  render();
  if (fromInput) {
    input.value = '';
    input.rows = 1;
    input.classList.add('compact');
    input.removeAttribute('placeholder');
  }
  status('');
  bubble('user', visibleText || text);
  const thinking = bubble('assistant', '', { thinking: true });
  try {
    const mode = state.mode;
    const system = assembleTasteChatSystemPrompt(promptOf(mode).value, mode) + formatTasteContext(contextNow());
    const { text: raw } = await callModel({
      system, userMessage: text, history, maxTokens: 12000, thinkingLevel: 'medium', label: 'ami-taste-chat',
    });
    let parsed = null;
    try { parsed = parseJSONFromText(raw); } catch { /* not JSON */ }
    if (!parsed) throw new Error('not JSON');
    history.push({ role: 'user', text }, { role: 'model', text: raw });
    const reply = normalizeTasteReply(parsed, { mode });
    const original = reply.reply_he;
    const ops = reply.proposal?.ops || null;
    const isUndo = !!ops?.some((o) => o.op === 'undo');
    const dry = ops && !isUndo ? applyOps(state, ops) : null;
    const offered = reply.suggestions ? reply.suggestions.slice() : null;
    // Production's checks. An undo is always kept here: the bench can undo a
    // change tried here, and says so when there's none.
    vetReply(reply, state, { linkedTracks: new Map(), hasUndoable: true });
    fillReply(thinking, reply, { original, dry, isUndo, offered });
  } catch (e) {
    console.error('taste bench:', e);
    thinking.classList.remove('thinking');
    thinking.textContent = 'שגיאה בצ׳אט — נסו שוב.';
  } finally {
    busy = false;
    $('tcSend').disabled = false;
    render();
    input.focus();
  }
}

async function save() {
  const changes = pendingChanges().slice().reverse();   // oldest first
  if (!loaded || !pendingCount()) return;
  const name = loaded.name || 'העסק';
  const parts = [switched ? `העברה ל${MODE_NAME[switched.mode]}` : '', changes.length ? `${changes.length === 1 ? 'שינוי אחד' : `${changes.length} שינויים`} בטעם` : ''].filter(Boolean);
  if (!window.confirm(`לשמור בפרופיל האמיתי של ${name}: ${parts.join(' + ')}?\nזה ייכנס לתוקף מהבנייה הבאה של הפלייליסטים.`)) return;
  const btn = $('tcSave');
  busy = true;
  spin(btn, 'שומר…');
  status('');
  try {
    const r = await api('/api/internal/taste-bench', {
      method: 'POST',
      body: {
        business_id: loaded.business_id,
        ops: changes.flatMap((c) => c.ops),
        summary_he: changes.map((c) => c.summary_he).filter(Boolean).join(' · '),
        ...(switched ? { switch: switched } : {}),
      },
    });
    unspin(btn);
    busy = false;
    await loadUser(loaded.business_id, { keepChat: true });   // the saved profile is the new starting point
    const sel = users.find((u) => u.business_id === loaded?.business_id);
    if (sel && r.switched) {
      sel.delivery_mode = r.switched;
      $('tcUser').selectedOptions[0].textContent = `${sel.name || '(בלי שם)'} · ${r.switched === 'option2' ? '2 מיקסים' : '4 פלייליסטים'}`;
    }
    status(r.dropped?.length
      ? `נשמר — חוץ מ-${r.dropped.length} שלא מתאימים לפרופיל הנוכחי: ${r.dropped.map((d) => reasonHe(d.reason)).join(' · ')}`
      : `נשמר בפרופיל של ${name} ✓ — ייכנס לתוקף מהבנייה הבאה.`, r.dropped?.length ? 'err' : 'ok');
  } catch (e) {
    unspin(btn);
    busy = false;
    render();
    status(`השמירה נכשלה: ${e.message}`, 'err');
  }
}

// ---------- mount ----------

export function mountTasteChatTab() {
  loading('');   // the page shows "טוען…" until this module has loaded
  for (const m of MODES) promptOf(m).value = tasteChatEditableSection(m);
  key = storedKey();
  if (!key) showKeyRow();
  render();

  const enter = () => {
    const k = $('tcKey').value.trim();
    if (!k) { error('הזינו את המפתח.'); return; }
    key = k;
    storeKey(k);
    loadUsers();
  };
  $('tcKeySave').addEventListener('click', enter);
  $('tcKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); enter(); } });
  $('tcLogout').addEventListener('click', logout);
  $('tcUser').addEventListener('change', (e) => {
    const id = e.target.value;
    if (pendingCount() && !window.confirm('יש שינויים שנוסו כאן ולא נשמרו. לעבור עסק ולוותר עליהם?')) {
      e.target.value = loaded?.business_id || '';
      return;
    }
    if (!id) { resetBusiness(); render(); return; }
    loadUser(id);
  });
  $('tcSwitch').addEventListener('click', switchType);
  for (const b of document.querySelectorAll('#tabTaste [data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($(b.dataset.copy).value); status('הפרומפט הועתק.', 'ok'); } catch { status('ההעתקה נכשלה.', 'err'); }
    });
  }
  $('tcSave').addEventListener('click', save);
  $('tcNewChat').addEventListener('click', () => {
    if (!loaded) { history = []; heard.clear(); $('tcLog').replaceChildren(); resetInput(); return; }
    if (pendingCount() && !window.confirm('יש שינויים שנוסו כאן ולא נשמרו. להתחיל מחדש ולוותר עליהם?')) return;
    loadUser(loaded.business_id);
  });
  $('tcSend').addEventListener('click', () => send());
  $('tcInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('tmClose').addEventListener('click', closeModal);
}

// Called when the tab is opened: loads the business list the first time.
export function onTasteTabShown() {
  if (key && !users.length) loadUsers();
}
