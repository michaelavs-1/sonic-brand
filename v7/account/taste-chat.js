// v7 taste chat — "שינויים בפרופיל המוזיקלי שלכם" (Home tab card, 2026-10-13;
// renamed from "הטעם המוזיקלי שלכם" on 2026-10-26).
//
// The owner tells the chat what they think of their daily music; the server
// (api/v7/account/taste-chat.js) answers and may:
//   - propose a change (state "confirming") → a confirm button; when the
//     change adds genres the owner hasn't heard yet, "שמעו דוגמה" first opens
//     a sample song per genre and the confirm lives in that modal;
//   - suggest new genres (state "suggesting") → "בואו נשמע" opens the genre
//     deck: a card per genre with a sample song and like / dislike /
//     super-like. Dislikes are recorded at once (taste-apply action
//     "reject"); the results go back to the chat as a message, and the chat
//     then proposes adding what was liked;
//   - suggest a curve change (Option 2) → opens the energy-curve editor with
//     the change ready (hooks.openTimelineWithHint);
//   - offer a new mix starting now (Option 2) → hooks.runReplaceToday().
// Applying = taste-apply.js; afterwards the dashboard asks the usual
// "replace today's playlists now or keep them until closing?" question
// (hooks.askReplace — the same modal step as the Profile tab).
//
// Messages are persisted server-side; the on-screen transcript and the
// model's memory both start fresh on every page load (sessionStartAt), and
// at 04:00 IL on a page left open (resetTasteChat).

import { WAIT_DOTS_HTML } from '../wait-dots.js?v=28092026a';
import { tasteChatPlaceholder } from '../generation/taste-chat-prompt.js?v=21102026a';

const $ = (id) => document.getElementById(id);
const DECK_RESULTS_PREFIX = '[תוצאות ההאזנה]';   // = taste-chat-prompt.js
// The input's placeholder follows the playlist type (syncTastePlaceholder).
let placeholderMode = null;

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M8.2 5.6v12.8L19 12z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><rect x="6.6" y="5.6" width="3.9" height="12.8" rx="1.2"/><rect x="13.5" y="5.6" width="3.9" height="12.8" rx="1.2"/></svg>';
const SWAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';
const STAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtTime = (ms) => { const s = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let sb = null;
let getBusiness = () => null;
let hooks = {};
let mounted = false;
let SESSION_START_AT_ISO = new Date().toISOString();
const heard = new Set();          // genres the owner heard in the deck this session (no second sample)
let busy = false;

// Spotify IFrame API (the script tag is in index.html).
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

async function authed(path, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('לא מחוברים');
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw Object.assign(new Error(data?.error || `שגיאה ${r.status}`), { status: r.status, code: data?.code });
  return data;
}

// ---------- transcript ----------

function scrollDown() {
  const box = $('tasteChatMessages');
  if (box) box.scrollTop = box.scrollHeight;
}

function bubble(role, text, { thinking = false } = {}) {
  const b = document.createElement('div');
  b.className = `chat-bubble ${role}${thinking ? ' thinking' : ''}`;
  if (thinking) b.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  else b.textContent = text;
  $('tasteChatMessages').append(b);
  scrollDown();
  return b;
}

function actionRow(b) {
  const row = document.createElement('div');
  row.className = 'chat-actions';
  b.append(row);
  return row;
}

function button(row, label, onClick, { ghost = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = ghost ? 'btn-ghost' : 'btn';
  btn.textContent = label;
  btn.addEventListener('click', () => onClick(btn));
  row.append(btn);
  scrollDown();
  return btn;
}

function setStatus(btn, html) {
  const note = document.createElement('div');
  note.className = 'taste-note';
  note.innerHTML = html;
  btn.closest('.chat-actions')?.replaceWith(note);
  scrollDown();
}

// ---------- a turn ----------

async function send(text, { visibleText } = {}) {
  if (!text || busy) return;
  busy = true;
  $('tasteChatSend').disabled = true;
  $('tasteChatMsg').textContent = '';
  bubble('user', visibleText || text);
  const thinking = bubble('assistant', '', { thinking: true });
  try {
    const data = await authed('/api/v7/account/taste-chat', {
      businessId: getBusiness()?.id, message: text, sessionStartAt: SESSION_START_AT_ISO,
    });
    const reply = data.assistantMessage?.parsed || {};
    thinking.classList.remove('thinking');
    thinking.textContent = (reply.reply_he || '').trim() || '(אין תשובה)';
    renderActions(thinking, data.assistantMessage?.id, reply);
    // A success (a change the owner can confirm) → the portrait is rewritten
    // in the background from the messages that led to it.
    if (reply.proposal?.ops?.length && data.assistantMessage?.id) {
      updatePortrait({ action: 'chat', messageId: data.assistantMessage.id }).catch(() => {});
    }
  } catch (e) {
    thinking.classList.remove('thinking');
    thinking.textContent = e.code === 'not-ready' || e.code === 'subscription_ended' ? e.message : 'שגיאה בצ׳אט — נסו שוב.';
  } finally {
    busy = false;
    $('tasteChatSend').disabled = false;
    $('tasteChatInput')?.focus();
  }
}

function renderActions(b, messageId, reply) {
  if (reply.state === 'confirming' && reply.proposal && messageId) {
    const row = actionRow(b);
    const toHear = (reply.new_genres || []).filter((g) => !heard.has(g));
    if (toHear.length) {
      button(row, toHear.length > 1 ? 'שמעו דוגמאות' : 'שמעו דוגמה', (btn) => openSamples(toHear, () => apply(btn, messageId)));
    } else {
      button(row, 'אישור', (btn) => apply(btn, messageId));
    }
  }
  if (reply.state === 'suggesting' && reply.suggestions?.length) {
    button(actionRow(b), 'בואו נשמע', (btn) => openDeck(reply.suggestions, btn));
  }
  if (reply.timeline_hint) {
    button(actionRow(b), 'פתחו את ציר האנרגיה', async () => { await hooks.openTimelineWithHint?.(reply.timeline_hint); }, { ghost: true });
  }
  if (reply.offer_new_mix) {
    button(actionRow(b), 'בנו מיקס חדש מעכשיו', (btn) => { btn.disabled = true; hooks.runReplaceToday?.(); }, { ghost: true });
  }
}

async function apply(btn, messageId) {
  btn.disabled = true;
  btn.innerHTML = '<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>מעדכנים' + WAIT_DOTS_HTML;
  try {
    const data = await authed('/api/v7/account/taste-apply', { businessId: getBusiness()?.id, action: 'apply', messageId });
    setStatus(btn, data.undone ? '✓ השינוי בוטל' : '✓ עודכן — השינוי ייכנס לפלייליסטים הבאים');
    hooks.onApplied?.();
    if (data.replace?.eligible && await hooks.askReplace?.(data.replace)) hooks.runReplaceToday?.();
  } catch (e) {
    if (e.code === 'already-applied' || e.code === 'nothing-to-change' || e.code === 'nothing-to-undo') { setStatus(btn, esc(e.message)); return; }
    btn.disabled = false;
    btn.textContent = 'נסו שוב';
    $('tasteChatMsg').textContent = e.message || 'משהו השתבש — נסו שוב';
  }
}

// ---------- the sample-song player (modal) ----------

let modal = null;   // { controller, onClose }

async function sampleTrack(genre, seen) {
  const { inst, pop } = hooks.prefs?.() || {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('/api/v7/anchor-tracks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specs: [{ rank: 1, genre, inst_pref: inst || 'none', pop_pref: pop || 'none' }] }),
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
  $('tasteModal').classList.remove('hide');
}

function closeModal() {
  destroyPlayer();
  modal = null;
  $('tasteModal').classList.add('hide');
}

function showLoading(text = 'מחפשים שיר לדוגמה') {
  $('tmBody').innerHTML = `<div class="dp-loading"><span class="sb-spinner"></span>${esc(text)}${WAIT_DOTS_HTML}</div>`;
}

// One song card: art + play/pause + progress + "another song".
async function renderPlayer(genre, seen) {
  showLoading();
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
  playBtn.addEventListener('click', () => {
    if (modal?.controller) { try { modal.controller.togglePlay(); } catch { /* ignore */ } } else pendingPlay = true;
  });
  card.querySelector('.dp-swap').addEventListener('click', () => { renderPlayer(genre, seen); });
  return id;
}

function setActions(buttons) {
  const box = $('tmActions');
  box.replaceChildren(...buttons.map(({ label, ghost, onClick, html }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = ghost ? 'btn-ghost' : 'btn';
    if (html) b.innerHTML = html; else b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }));
}

// Before confirming a change that adds genres: a sample per genre, then
// "אישור" (onConfirm) or back to the chat.
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

// The genre deck: a card per suggestion → like / dislike / super-like.
function openDeck(suggestions, btn) {
  let i = 0;
  const seen = new Set();
  const results = { liked: [], super: [], disliked: [] };
  const label = (s) => s.label_he || s.genre;
  const finish = async () => {
    closeModal();
    btn.disabled = true;
    suggestions.forEach((s) => heard.add(s.genre));
    if (results.disliked.length) {
      authed('/api/v7/account/taste-apply', { businessId: getBusiness()?.id, action: 'reject', genres: results.disliked.map((s) => s.genre) })
        .catch(() => {});
    }
    const part = (name, list) => (list.length ? `${name}: ${list.map((s) => `${label(s)} (${s.genre})`).join(', ')}.` : '');
    const text = [DECK_RESULTS_PREFIX, part('סופר לייק', results.super), part('אהבתי', results.liked), part('לא בשבילי', results.disliked)].filter(Boolean).join(' ');
    const visible = [part('סופר לייק', results.super), part('אהבתי', results.liked), part('לא בשבילי', results.disliked)].filter(Boolean).join(' ');
    send(text, { visibleText: visible || 'שמעתי את כולם' });
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
      { html: `${STAR_ICON}<span style="margin-inline-start:6px">סופר לייק</span>`, onClick: next('super') },
    ]);
  };
  step();
}

// ---------- mount ----------

// The owner's musical portrait (2026-10-21; api/v7/account/taste-portrait.js).
// Background only — never awaited by the chat, and keepalive so a request
// still finishes if the owner closes the page right after.
async function updatePortrait(body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token || !getBusiness()?.id) return;
  await fetch('/api/v7/account/taste-portrait', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ businessId: getBusiness().id, sessionStartAt: SESSION_START_AT_ISO, ...body }),
  });
}

// The first version, from the onboarding answers, when the business has none
// yet (the server skips it otherwise). Called once on the dashboard's load.
export function ensurePortrait() {
  updatePortrait({ action: 'init' }).catch(() => {});
}

// A new day (04:00 IL, called by the dashboard — Ami, 2026-10-21): yesterday's
// messages leave the screen and the model starts fresh, as on a page load.
// Not while a turn is in flight; the dashboard tries again later.
export function resetTasteChat() {
  if (busy) return false;
  SESSION_START_AT_ISO = new Date().toISOString();
  heard.clear();
  const box = $('tasteChatMessages');
  if (box) box.innerHTML = '';
  const input = $('tasteChatInput');
  if (input && !input.value.trim()) {
    input.rows = 3;
    input.classList.remove('compact');
    input.setAttribute('placeholder', tasteChatPlaceholder(placeholderMode));
  }
  return true;
}

// The dashboard calls this whenever the playlist type is set or changes.
// Leaves the input alone once a conversation has shrunk it.
export function syncTastePlaceholder(mode) {
  placeholderMode = mode || null;
  const input = $('tasteChatInput');
  if (input && !input.classList.contains('compact')) input.setAttribute('placeholder', tasteChatPlaceholder(placeholderMode));
}

export function mountTasteChat(opts) {
  sb = opts.supabase;
  getBusiness = opts.getBusiness || getBusiness;
  hooks = opts.hooks || {};
  if (mounted) return;
  mounted = true;
  const input = $('tasteChatInput');
  if (input && !input.classList.contains('compact')) input.setAttribute('placeholder', tasteChatPlaceholder(placeholderMode));
  const go = () => {
    const text = (input.value || '').trim();
    if (!text || busy) return;
    input.value = '';
    input.rows = 1;
    input.classList.add('compact');
    input.removeAttribute('placeholder');
    send(text);
  };
  $('tasteChatSend')?.addEventListener('click', go);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  });
  $('tmClose')?.addEventListener('click', closeModal);
}
