// Ami's dashboard — "צ'אט פלייליסטים מיוחדים" tab (2026-10-21).
//
// A test bench for the special-playlists chat ("צריכים משהו אחר היום?" on the
// owner's Home tab) and the classifier that turns its brief into genres,
// tempo and preferences. Ami edits both prompts and talks to the chat as an
// owner. No Spotify, no real customer.
//
// Looks and behaves like the owner's chat (v7/account/app.js
// sendChatMessage / finalizeAndSaveEvent): bubbles, the three-dot "typing"
// bubble, the input shrinking after the first message, and "הכן פלייליסט" in a
// reply that proposes a playlist. Here that button runs the classifier and
// says, in plain words, what would go into the playlist; then the chat starts
// over, as it does for the owner (and "made today" goes up by one).
//
// Same pieces as production: the chat prompt + buildEventChatContext's
// "## Today" block (api/v7/account/event-chat.js; low thinking, 1500 tokens),
// and for the classifier buildEventPlaylistUserMessage +
// normalizeEventPlaylistParams (api/v7/account/event-playlist.js; high
// thinking). When the owner chose their daily styles (genre_source "daily"),
// the genre menu is the onboarding tab's taste profile (step 3).

import { callModel, parseJSONFromText } from '../../v7/generation/ai-provider.js';
import { EVENT_CHAT_SYSTEM_PROMPT, buildEventChatContext } from '../../v7/generation/event-chat-prompt.js';
import {
  EVENT_PLAYLIST_SYSTEM_PROMPT, buildEventPlaylistUserMessage, normalizeEventPlaylistParams,
} from '../../v7/generation/event-playlist-prompt.js';

const $ = (id) => document.getElementById(id);
const GENRE_SOURCES = new Set(['event', 'daily']);
// = CHAT_PLACEHOLDER in v7/account/app.js
const PLACEHOLDER = 'לדוגמה: הערב יש לנו מסיבת יום הולדת - פופ שמח וקליל...';
const DOTS = '<span class="typing-dots"><span></span><span></span><span></span></span>';
const SPINNER = '<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>';
const PREF_WORD = { none: 'בלי העדפה', soft: 'בעיקר', hard: 'רק' };
// Left-to-right isolate, so "90–120" stays in order inside Hebrew text.
const ltr = (s) => `⁦${s}⁩`;

let getSource = () => ({});
let history = [];
let busy = false;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const status = (text, kind = '') => {
  const s = $('ecStatus');
  s.textContent = text || '';
  s.className = `oc-msg${kind ? ` ${kind}` : ''}`;
};

// Israel date parts, the shape buildEventChatContext wants.
function ilParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute),
    dayIdx: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

// The next 04:00 in Israel (when a special playlist is deleted): tomorrow's
// date at 04:00 if it's past 04:00 now, else today's.
function deadlineParts(now) {
  const p = ilParts(now);
  const base = p.hour >= 4 ? new Date(now.getTime() + 24 * 3600 * 1000) : now;
  return { ...ilParts(base), hour: 4, minute: 0 };
}

// Same check as the owner's chat: a proposal needs state "confirming", a name
// and a description of at least 5 characters.
function normalizeReply(parsed) {
  const reply_he = typeof parsed?.reply_he === 'string' ? parsed.reply_he : '';
  const state = typeof parsed?.state === 'string' ? parsed.state : 'gathering';
  const p = parsed?.proposed;
  let proposal = null;
  if (state === 'confirming' && p && typeof p.name_he === 'string' && typeof p.description_he === 'string' && p.description_he.trim().length >= 5) {
    proposal = {
      name_he: String(p.name_he).trim().slice(0, 40),
      description_he: String(p.description_he).trim().slice(0, 4000),
      genre_source: GENRE_SOURCES.has(p.genre_source) ? p.genre_source : 'event',
    };
  }
  return { reply_he, state, proposal };
}

// ---------- the conversation ----------

const scrollDown = () => { const log = $('ecLog'); log.scrollTop = log.scrollHeight; };

function bubble(role, text, { thinking = false } = {}) {
  const b = el('div', { class: `oc-bubble ${role}${thinking ? ' thinking' : ''}` });
  if (thinking) b.innerHTML = DOTS;
  else b.textContent = text;
  $('ecLog').append(b);
  scrollDown();
  return b;
}

function resetInput() {
  const input = $('ecInput');
  input.rows = 3;
  input.classList.remove('compact');
  input.setAttribute('placeholder', PLACEHOLDER);
}

// What production does after "הכן פלייליסט": the next message starts a new
// conversation, and today's count goes up. Here the messages stay on screen,
// under a separator, so the result can still be read.
function startOver(note) {
  history = [];
  resetInput();
  const count = $('ecMadeToday');
  count.value = String(Math.min(2, (Number(count.value) || 0) + 1));
  $('ecLog').append(el('div', { class: 'oc-sep' }, note));
  scrollDown();
}

// Under a reply that proposes a playlist: what the chat would hand on, in
// plain words, then the owner's "הכן פלייליסט".
function addProposal(b, proposal) {
  const info = el('div', { class: 'oc-info' },
    el('div', {}, `הצ'אט מציע פלייליסט: "${proposal.name_he}"`),
    el('div', {}, proposal.genre_source === 'daily'
      ? 'מהסגנונות של הפלייליסטים היומיים של העסק.'
      : 'מכל הסגנונות בקטלוג, לפי התיאור.'),
    el('div', {}, `התיאור שיישלח ליצירת הפלייליסט: ${proposal.description_he}`));
  b.append(info);
  const row = el('div', { class: 'oc-actions' });
  const btn = el('button', { class: 'oc-btn', type: 'button' }, 'הכן פלייליסט');
  btn.addEventListener('click', () => makePlaylist(proposal, b, row, btn));
  row.append(btn);
  b.append(row);
  scrollDown();
}

// "הכן פלייליסט": the classifier, as event-playlist.js runs it, and its
// answer in plain words.
async function makePlaylist(proposal, b, row, btn) {
  const src = getSource() || {};
  const profile = src.profile || null;
  const daily = proposal.genre_source === 'daily';
  if (daily && !profile) {
    status('בעל העסק בחר בסגנונות היומיים שלו, אבל אין פרופיל טעם — הריצו קודם את שלב 3 בלשונית האונבורדינג.', 'err');
    return;
  }
  btn.disabled = true;
  btn.innerHTML = `${SPINNER}מכינים…`;
  status('');
  try {
    const instPref = profile?.instrumentalness_preference || 'none';
    const popPref = profile?.popularity_preference || 'none';
    const approved = daily ? profile.approved_genres : [];
    const { text: raw } = await callModel({
      system: $('ecPlaylistPrompt').value,
      userMessage: buildEventPlaylistUserMessage({
        description: proposal.description_he, genreSource: proposal.genre_source,
        approvedGenres: approved, energyLevelsTotal: profile?.energy_levels_total ?? null, instPref, popPref,
      }),
      maxTokens: 4096, label: 'ami-event-playlist',
    });
    let parsed = null;
    try { parsed = parseJSONFromText(raw); } catch { /* handled below */ }
    const params = parsed ? normalizeEventPlaylistParams(parsed, {
      allowed: daily ? new Set(approved.map((g) => g.genre)) : null, instPref, popPref,
    }) : { error: 'bad-json' };

    let result;
    if (params.error || !params.genres?.length) {
      result = el('div', { class: 'oc-info' },
        el('div', { class: 'no' }, 'יצירת הפלייליסט לא מצאה לתיאור הזה סגנונות, אז הפלייליסט לא היה נבנה. בעל העסק היה רואה "נסו שוב".'));
    } else {
      result = el('div', { class: 'oc-info' },
        el('div', {}, 'ייכנסו לפלייליסט:'),
        el('ul', {},
          el('li', {}, `סגנונות: ${params.genres.join(', ')}`),
          el('li', {}, params.bpm ? `קצב: ${ltr(`${params.bpm.min}–${params.bpm.max}`)} BPM` : 'קצב: כל קצב'),
          el('li', {}, `שירים אינסטרומנטליים: ${PREF_WORD[params.instPref] || params.instPref}`),
          el('li', {}, `שירים מוכרים: ${PREF_WORD[params.popPref] || params.popPref}`)));
    }
    row.replaceWith(result);
    startOver('— בעל העסק היה מקבל כאן את הפלייליסט, והצ\'אט מתחיל מחדש —');
  } catch (e) {
    console.error('event bench classifier:', e);
    btn.disabled = false;
    btn.textContent = 'הכן פלייליסט';
    status('משהו השתבש — נסו שוב.', 'err');
  }
}

async function send() {
  if (busy) return;
  const input = $('ecInput');
  const text = input.value.trim();
  if (!text) return;
  busy = true;
  $('ecSend').disabled = true;
  input.value = '';
  input.rows = 1;
  input.classList.add('compact');
  input.removeAttribute('placeholder');
  status('');
  bubble('user', text);
  const thinking = bubble('assistant', '', { thinking: true });
  try {
    const now = new Date();
    const src = getSource() || {};
    const businessName = src.inputs?.bizName || $('bizName')?.value.trim() || '';
    const system = $('ecChatPrompt').value + buildEventChatContext({
      businessName, now: ilParts(now), deadline: deadlineParts(now), madeToday: Number($('ecMadeToday').value) || 0,
    });
    const { text: raw } = await callModel({
      system, userMessage: text, history, maxTokens: 1500, thinkingLevel: 'low', label: 'ami-event-chat',
    });
    let parsed = null;
    try { parsed = parseJSONFromText(raw); } catch { /* not JSON */ }
    if (!parsed) throw new Error('not JSON');
    history.push({ role: 'user', text }, { role: 'model', text: raw });
    const reply = normalizeReply(parsed);
    thinking.classList.remove('thinking');
    thinking.textContent = reply.reply_he.trim() || '(אין תשובה)';
    if (reply.proposal) addProposal(thinking, reply.proposal);
  } catch (e) {
    console.error('event bench chat:', e);
    thinking.classList.remove('thinking');
    thinking.textContent = 'שגיאה בצ׳אט — נסו שוב.';
  } finally {
    busy = false;
    $('ecSend').disabled = false;
    input.focus();
  }
}

export function mountEventChatTab(opts) {
  getSource = opts.getSource || getSource;
  $('ecLoading').hidden = true;   // shown until this module has loaded
  $('ecChatPrompt').value = EVENT_CHAT_SYSTEM_PROMPT;
  $('ecPlaylistPrompt').value = EVENT_PLAYLIST_SYSTEM_PROMPT;
  const copy = async (id) => {
    try { await navigator.clipboard.writeText($(id).value); status('הפרומפט הועתק.', 'ok'); } catch { status('ההעתקה נכשלה.', 'err'); }
  };
  $('ecCopyChat').addEventListener('click', () => copy('ecChatPrompt'));
  $('ecCopyPlaylist').addEventListener('click', () => copy('ecPlaylistPrompt'));
  $('ecSend').addEventListener('click', send);
  $('ecInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('ecNewChat').addEventListener('click', () => {
    if (busy) return;
    history = [];
    $('ecLog').replaceChildren();
    resetInput();
    status('');
  });
}
