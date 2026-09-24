// v6/account/direction-chat.js — direction-edit chat on the profile tab.
//
// Owns:
//   - The row of clickable direction cards above the chat (renderDirectionCards).
//   - The chat transcript + input UI (renderTranscript, sendTurn).
//   - The preview modal that opens when the chat proposes an add/edit
//     (openPreviewModal). Modal is a single-card variant of the onboarding
//     swipe deck: play button + "שמעו שיר אחר..." swap + confirm/dismiss.
//   - Inline "expire live playlist?" prompt for a remove proposal.
//
// Exposes `mountDirectionChat({ supabase, getBusiness })` which the account
// app.js calls once the dashboard has loaded. The chat lazy-loads its
// transcript + directions the first time the profile tab is opened, so
// nothing hits the network until the user switches to the Profile tab.

const $ = (id) => document.getElementById(id);

const SPOTIFY_ART_FALLBACK = '🎵';

// "1:23" formatter for the playback timestamps.
function fmtTime(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Play/pause icons — reuse the same 36×36 SVGs the onboarding preview uses.
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M8.2 5.6v12.8L19 12z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><rect x="6.6" y="5.6" width="3.9" height="12.8" rx="1.2"/><rect x="13.5" y="5.6" width="3.9" height="12.8" rx="1.2"/></svg>';
const SWAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';
// Star icon for the super-like button — same visual style as the
// onboarding swipe deck's super-like.
const STAR_ICON = '<svg class="dp-super-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Spotify IFrame API singleton — mirrors the pattern in v6/preview.js.
let _apiPromise = null;
function getSpotifyIframeApi() {
  if (_apiPromise) return _apiPromise;
  _apiPromise = new Promise((resolve) => {
    if (window.__sbIframeApi) { resolve(window.__sbIframeApi); return; }
    // The onboarding page + the account page both include the iframe api
    // script. This callback races the two — first to set the singleton
    // wins; the other side just reads it.
    const prev = window.onSpotifyIframeApiReady;
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      window.__sbIframeApi = IFrameAPI;
      if (typeof prev === 'function') { try { prev(IFrameAPI); } catch { } }
      resolve(IFrameAPI);
    };
  });
  return _apiPromise;
}

// ---- Module-level state, set by mountDirectionChat ----------------------

let sb = null;
let getBusiness = () => null;
let mounted = false;
let bootPromise = null;

// Page-load timestamp. Chat starts empty on every hard refresh (module
// scope resets on load) — we send this to the server so Gemini's context
// only includes messages typed IN THIS session, not the persisted tail
// from previous visits. Persistence itself still happens: every message
// is written to business_direction_chats so the admin API's transcript
// keeps the full history and prior-change audit rows still reference
// real message ids.
const SESSION_START_AT_ISO = new Date().toISOString();

// Transcript + directions + changes, cached client-side after first load.
// Refreshed after any successful apply-direction-change commit.
let state = {
  directions: [],   // rows from business_directions (active + inactive)
  messages: [],   // rows from business_direction_chats (ascending)
  changes: [],   // rows from business_direction_changes (descending, tail)
  selectedDirectionId: null,
  busy: false,
};

// ---- public API ---------------------------------------------------------

export function mountDirectionChat(opts) {
  if (mounted) return;
  mounted = true;
  sb = opts.supabase;
  getBusiness = opts.getBusiness;

  $('dirChatSend')?.addEventListener('click', sendTurn);
  $('dirChatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTurn(); }
  });
  $('dpClose')?.addEventListener('click', closePreviewModal);
  $('dirPreviewModal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'dirPreviewModal') closePreviewModal();
  });
}

// Called by the account app when the user switches to the Profile tab.
// Idempotent — the first call kicks off the boot promise; subsequent
// calls piggyback on the same promise.
export function openDirectionChat() {
  const biz = getBusiness();
  if (!biz) return;
  if (!bootPromise) bootPromise = bootOnce(biz.id);
  return bootPromise;
}

// Programmatic entry point used by the Home tab's per-playlist edit
// icon: awaits the boot (loads directions if needed), then selects the
// given direction and fires the synthetic "מה תרצו לשנות בכיוון X?"
// prompt. Always ends in the "selected" state — repeated calls on the
// same id re-fire the prompt for visibility rather than toggling off.
export async function selectDirectionInChat(directionId) {
  const biz = getBusiness();
  if (!biz || !directionId) return;
  if (!bootPromise) bootPromise = bootOnce(biz.id);
  await bootPromise;
  state.selectedDirectionId = directionId;
  renderDirectionCards();
  const dir = (state.directions || []).find((d) => d.id === directionId);
  const title = dir?.title_en || 'הכיוון הזה';
  appendSyntheticAssistantMessage(`מה תרצו לשנות בכיוון "${title}"?`);
  const input = $('dirChatInput');
  if (input) input.focus();
}

// Programmatic entry point used by the Home tab's per-playlist trash
// confirmation modal. Posts kind='remove' to the apply endpoint,
// refreshes the direction-chat's local cache so the Profile tab
// reflects the change, and dispatches direction-change-applied so the
// Home tab reruns loadDashboardData + renderPlaylists. Caller handles
// its own UI (toast, button spinner). Returns the shape callApply
// returns — { ok, error?, code? }.
export async function removeDirectionFromCard(directionId, { expireLive = true } = {}) {
  const biz = getBusiness();
  if (!biz || !directionId) return { ok: false, error: 'no business' };
  const result = await callApply({
    kind: 'remove',
    directionId,
    expireLivePlaylist: expireLive,
  });
  if (!result.ok) return result;
  // Sync the profile-tab chat's cached direction list so a follow-up
  // switch to Profile shows the removed direction as inactive without
  // a hard refresh. Best-effort.
  try {
    await reloadState(biz.id);
    renderDirectionCards();
  } catch { }
  // Fire the same event runApplyWithSpinnerBubble does so the Home tab's
  // listener refreshes its playlist mirror + re-renders.
  document.dispatchEvent(new CustomEvent('direction-change-applied', {
    detail: { businessId: biz.id },
  }));
  return result;
}

// Optimistic in-place update for a direction's user-visible fields. Called
// by the Home tab's inline-rename flow so the Profile-tab direction cards
// reflect the new title (or description) the instant the owner hits save,
// before the network round trip. Safe no-op when the profile tab has
// never been opened (state.directions is empty) — a subsequent tab open
// will `reloadState` and pick up the persisted version.
//
// Revert path: caller passes the previous values on failure so we roll
// back the same field. No dirty-tracking beyond that — if the caller
// forgets to revert on failure, cards drift until the next reload.
export function patchDirectionOptimistic(directionId, patch) {
  if (!directionId || !patch || typeof patch !== 'object') return;
  const dir = (state.directions || []).find((d) => d.id === directionId);
  if (!dir) return;
  if (typeof patch.title_en === 'string')       dir.title_en       = patch.title_en;
  if (typeof patch.description_he === 'string') dir.description_he = patch.description_he;
  renderDirectionCards();
}

// ---- boot / load --------------------------------------------------------

async function bootOnce(businessId) {
  try {
    await reloadState(businessId);
    renderAll();
  } catch (e) {
    console.warn('[direction-chat] boot failed:', e.message);
    setChatMsg('שגיאה בטעינת הצ׳אט — רעננו את הדף');
  }
}

async function reloadState(businessId) {
  // Direct-from-Postgres reads — anon key + RLS filter. No new endpoint
  // needed; matches how the rest of the dashboard loads its data.
  //
  // We deliberately skip loading business_direction_chats: the transcript
  // is meant to start empty on every hard refresh. Prior messages still
  // live in the DB (audit trail + admin API), but the client only shows
  // what's been said in this session. Server-side, the direction-chat
  // endpoint filters its message-tail context by SESSION_START_AT_ISO so
  // Gemini's memory matches what the owner sees on screen.
  const [dirRes, chgRes] = await Promise.all([
    sb.from('business_directions')
      .select('id,rank,title_en,description_he,genres,bpm_range,popularity_window,instrumentalness_preference,active,created_at')
      .eq('business_id', businessId)
      .order('rank', { ascending: true, nullsFirst: false }),
    sb.from('business_direction_changes')
      .select('id,kind,direction_id,before,after,playlist_action,applied_at')
      .eq('business_id', businessId)
      .order('applied_at', { ascending: false })
      .limit(50),
  ]);
  if (dirRes.error) console.warn('business_directions load:', dirRes.error.message);
  if (chgRes.error) console.warn('business_direction_changes load:', chgRes.error.message);
  state = {
    ...state,
    directions: dirRes.data || [],
    // messages left as whatever's in state (in-session only; empty on boot).
    changes: chgRes.data || [],
  };
}

// ---- render: cards + transcript ----------------------------------------

function renderAll() {
  renderDirectionCards();
  renderTranscript();
}

function renderDirectionCards() {
  const wrap = $('dirCards');
  if (!wrap) return;
  wrap.replaceChildren();
  const active = (state.directions || []).filter((d) => d.active !== false);
  if (!active.length) return;
  for (const d of active) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'dir-card' + (state.selectedDirectionId === d.id ? ' selected' : '');
    card.dataset.directionId = d.id;
    card.innerHTML =
      `<div class="dc-title">${escHtml(d.title_en || 'כיוון')}</div>` +
      `<div class="dc-desc">${escHtml(d.description_he || '')}</div>`;
    card.addEventListener('click', () => toggleSelection(d.id));
    wrap.append(card);
  }
}

function toggleSelection(directionId) {
  const wasSelected = state.selectedDirectionId === directionId;
  state.selectedDirectionId = wasSelected ? null : directionId;
  renderDirectionCards();
  // On SELECT (not deselect), append a synthetic assistant question so the
  // owner immediately sees the chat scoping to that direction. The bubble
  // is not persisted — Gemini gets the direction via the `selectedDirectionId`
  // in the next turn's context block anyway. Skipped on deselect since
  // there's no meaningful message to show for "unselect".
  if (!wasSelected) {
    const dir = (state.directions || []).find((d) => d.id === directionId);
    const title = dir?.title_en || 'הכיוון הזה';
    appendSyntheticAssistantMessage(`מה תרצו לשנות בכיוון "${title}"?`);
  }
  const input = $('dirChatInput');
  if (input) input.focus();
}

function renderTranscript() {
  const box = $('dirChatMessages');
  if (!box) return;
  box.replaceChildren();
  for (const m of state.messages) {
    box.append(renderMessage(m));
  }
  scrollTranscriptToBottom();
}

// Assistant `content` is stored as raw JSON from the model. Parse for the
// display shape; if parse fails (very rare, model regressed to prose),
// fall back to showing the raw content.
function parseAssistant(m) {
  try {
    const j = JSON.parse(m.content);
    return {
      reply: typeof j.reply_he === 'string' ? j.reply_he : String(m.content),
      state: j.state || 'gathering',
      proposal: m.proposal || j.proposal || null,
    };
  } catch {
    return { reply: String(m.content), state: 'gathering', proposal: m.proposal || null };
  }
}

function renderMessage(m) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}`;
  bubble.dataset.messageId = m.id;
  if (m.role === 'user') {
    bubble.textContent = m.content || '';
    return bubble;
  }
  const parsed = parseAssistant(m);
  bubble.textContent = parsed.reply || '(אין תשובה)';
  if (parsed.proposal) {
    appendProposalActions(bubble, m.id, parsed.proposal);
  }
  return bubble;
}

// Inline confirm buttons for a proposal — the interaction pattern matches
// the events chat's "צור פלייליסט" button but the click targets differ
// per kind. Also kicks off preview prefetch for edit/add proposals so the
// modal opens with the card ready when the owner clicks.
function appendProposalActions(bubble, messageId, proposal) {
  const row = document.createElement('div');
  row.className = 'chat-actions';

  if (proposal.kind === 'edit') {
    const updates = proposal.updates || {};
    // Cosmetic-only fast path: owner asked to rename or reword only, no
    // musical changes. The music doesn't change, so there's nothing to
    // preview — one confirm button, straight to the apply endpoint. The
    // server auto-detects this same shape and takes the rename-only path
    // (no rebuild, live Spotify playlist gets renamed in place).
    const isCosmeticOnly = isCosmeticOnlyUpdates(updates);
    if (isCosmeticOnly) {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn';
      confirmBtn.textContent = 'אשרו את השינוי';
      confirmBtn.addEventListener('click', () => {
        confirmBtn.disabled = true;
        runApplyWithSpinnerBubble({
          body: {
            kind: 'edit',
            directionId: proposal.direction_id,
            updates,
            // Explicit false — cosmetic edits never rebuild. Server also
            // ignores this flag when it detects the cosmetic-only shape.
            expireLivePlaylist: false,
            messageIdFirst: messageId || null,
            messageIdLast: messageId || null,
          },
          inProgressLabel: cosmeticInProgressLabel(updates),
          successLabel:    cosmeticSuccessLabel(updates),
        });
      });
      row.append(confirmBtn);
    } else {
      ensurePreviewPrefetch(messageId, proposal);
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn';
      previewBtn.textContent = 'שמעו את הכיוון החדש';
      previewBtn.addEventListener('click', () => openPreviewModal({
        kind: 'edit',
        directionId: proposal.direction_id,
        updates,
        messageId,
      }));
      row.append(previewBtn);

      // Skip-preview shortcut: same eventual outcome as swiping right in
      // the modal, minus the listening step. Goes straight to the "החליפו
      // עכשיו / השאירו עד סגירה" follow-up so the owner still gets to
      // decide about today's live playlist.
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn-ghost';
      skipBtn.textContent = 'דלגו על ההאזנה ואשרו';
      skipBtn.addEventListener('click', () => {
        previewBtn.disabled = true;
        skipBtn.disabled = true;
        askEditPlaylistOption(proposal.direction_id, updates, messageId);
      });
      row.append(skipBtn);
    }
  } else if (proposal.kind === 'add') {
    // Prefetch even when the owner is at the cap — the cap check may
    // change (they might remove one first) and a wasted preview-direction
    // call is cheap. If they never click, the promise just sits.
    ensurePreviewPrefetch(messageId, proposal);
    const previewBtn = document.createElement('button');
    previewBtn.className = 'btn';
    previewBtn.textContent = 'שמעו את הכיוון החדש';
    previewBtn.addEventListener('click', () => {
      // Client-side pre-check for the 8-active cap. Cheaper than opening
      // the modal, loading a preview track, letting the owner swipe, and
      // then discovering the cap on commit. The server enforces the same
      // check as the source of truth (see commitCurrent's cap_reached
      // handling for the race-condition path).
      if (activeDirectionCount() >= MAX_ACTIVE_DIRECTIONS) {
        appendSyntheticAssistantMessage(
          `אי אפשר להוסיף עוד כיוון — כבר יש ${MAX_ACTIVE_DIRECTIONS} כיוונים פעילים, שזה המקסימום. הסירו כיוון קיים קודם ואז נוכל להוסיף את החדש.`,
        );
        return;
      }
      openPreviewModal({
        kind: 'add',
        spec: proposal.spec,
        messageId,
      });
    });
    row.append(previewBtn);

    // Skip-preview shortcut for add: no "keep old vs replace now" step
    // (add has no old playlist), so this goes directly to the apply +
    // spinner-in-chat path. Same cap check as the preview button so a
    // stale proposal doesn't bypass it.
    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn-ghost';
    skipBtn.textContent = 'דלגו על ההאזנה ואשרו';
    skipBtn.addEventListener('click', () => {
      if (activeDirectionCount() >= MAX_ACTIVE_DIRECTIONS) {
        appendSyntheticAssistantMessage(
          `אי אפשר להוסיף עוד כיוון — כבר יש ${MAX_ACTIVE_DIRECTIONS} כיוונים פעילים, שזה המקסימום. הסירו כיוון קיים קודם ואז נוכל להוסיף את החדש.`,
        );
        return;
      }
      previewBtn.disabled = true;
      skipBtn.disabled = true;
      runApplyWithSpinnerBubble({
        body: {
          kind: 'add',
          spec: proposal.spec,
          messageIdFirst: messageId || null,
          messageIdLast: messageId || null,
        },
        inProgressLabel: 'בונים את הכיוון החדש…',
        successLabel: '✓ נוסף כיוון חדש',
      });
    });
    row.append(skipBtn);
  } else if (proposal.kind === 'remove') {
    const goBtn = document.createElement('button');
    goBtn.className = 'btn btn-danger';
    goBtn.textContent = 'הסירו את הכיוון';
    goBtn.addEventListener('click', () => {
      goBtn.disabled = true;
      askRemoveOptions(proposal.direction_id, messageId);
    });
    row.append(goBtn);
  }
  bubble.append(row);
}

// Second-step follow-up for a remove: "expire today's playlist too, or
// keep it until closing?" A NEW bubble (not the proposal bubble) — the
// pick handler mutates that new bubble into a spinner and then into the
// success/error marker via runApplyWithSpinnerBubble. Consistent with
// edit's askEditPlaylistOption pattern.
function askRemoveOptions(directionId, messageId) {
  const box = $('dirChatMessages');
  if (!box) return;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble assistant';
  bubble.textContent = 'למחוק את הפלייליסט הפעיל עכשיו או להשאיר עד הסגירה?';
  const row = document.createElement('div');
  row.className = 'chat-actions';
  const off = document.createElement('button');
  off.className = 'btn';
  off.textContent = 'מחק עכשיו';
  const keep = document.createElement('button');
  keep.className = 'btn btn-ghost';
  keep.textContent = 'השאירו עד סגירה';
  row.append(off, keep);
  bubble.append(row);
  box.append(bubble);
  scrollTranscriptToBottom();

  const pick = (expireLive) => {
    off.disabled = true;
    keep.disabled = true;
    bubble.textContent = '';
    const spinnerSpan = document.createElement('span');
    spinnerSpan.className = 'sb-spinner';
    spinnerSpan.style.cssText = 'width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px';
    bubble.append(spinnerSpan);
    bubble.append(document.createTextNode(
      expireLive ? 'מסירים את הכיוון ומכבים את הפלייליסט…' : 'מסירים את הכיוון…',
    ));
    runApplyWithSpinnerBubble({
      body: {
        kind: 'remove',
        directionId,
        expireLivePlaylist: expireLive,
        messageIdFirst: messageId || null,
        messageIdLast: messageId || null,
      },
      inProgressLabel: null,
      successLabel: expireLive ? '✓ הכיוון הוסר והפלייליסט כובה' : '✓ הכיוון הוסר',
      existingBubble: bubble,
    });
  };
  off.addEventListener('click', () => pick(true));
  keep.addEventListener('click', () => pick(false));
}

function setChatMsg(text) {
  const el = $('dirChatMsg');
  if (el) el.textContent = text || '';
}

function scrollTranscriptToBottom() {
  const box = $('dirChatMessages');
  if (box) box.scrollTop = box.scrollHeight;
}

function toast(text) {
  const el = $('dpToast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2000);
}

// ---- chat turn ---------------------------------------------------------

async function sendTurn() {
  const input = $('dirChatInput');
  if (!input) return;
  const text = (input.value || '').trim();
  if (!text || state.busy) return;
  const biz = getBusiness();
  if (!biz) return;
  input.value = '';
  setChatMsg('');
  state.busy = true;
  $('dirChatSend')?.setAttribute('disabled', 'disabled');

  // Optimistic: render the user's bubble immediately.
  const box = $('dirChatMessages');
  const pending = document.createElement('div');
  pending.className = 'chat-bubble user';
  pending.textContent = text;
  box.append(pending);
  const thinking = document.createElement('div');
  thinking.className = 'chat-bubble assistant thinking';
  thinking.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  box.append(thinking);
  scrollTranscriptToBottom();

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v6/account/direction-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        businessId: biz.id,
        message: text,
        selectedDirectionId: state.selectedDirectionId || null,
        // Server filters its message-tail context by this timestamp so
        // Gemini only remembers what was said this session (matches what
        // the owner sees on screen after a hard refresh).
        sessionStartAt: SESSION_START_AT_ISO,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `שגיאה ${r.status}`);

    // Replace optimistic bubbles with the canonical rows from the server.
    pending.remove();
    thinking.remove();
    if (data.userMessage) {
      state.messages.push(data.userMessage);
      box.append(renderMessage(data.userMessage));
    }
    if (data.assistantMessage) {
      // The server returns { ...row, parsed }. We store the row (parsed is
      // recomputed at render time from row.content), matching the shape
      // reloadState() reads from the DB.
      const { parsed: _ignore, ...row } = data.assistantMessage;
      state.messages.push(row);
      box.append(renderMessage(row));
    }
    scrollTranscriptToBottom();
  } catch (err) {
    console.error('[direction-chat] send failed:', err);
    pending.remove();
    thinking.remove();
    setChatMsg(String(err.message || 'שגיאה בצ׳אט'));
    // Restore the user's text so they can retry / tweak.
    input.value = text;
  } finally {
    state.busy = false;
    $('dirChatSend')?.removeAttribute('disabled');
    input.focus();
  }
}

// Shared helper for both apply-endpoint callers. Returns { ok, error?,
// code?, ... } — `code` is forwarded through so callers can branch on
// specific failure modes (e.g., 'cap_reached' for the 8-direction cap on
// add).
async function callApply(body) {
  const biz = getBusiness();
  if (!biz) throw new Error('no business');
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('לא מחוברים');
  const r = await fetch('/api/v6/account/apply-direction-change', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ businessId: biz.id, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data?.error || `שגיאה ${r.status}`, code: data?.code || null };
  return data;
}

// Server-of-truth active-direction count from the client's cached state.
// Used as a pre-check before opening the preview modal for an `add` and
// as the friendly-message trigger when the server rejects with cap_reached.
function activeDirectionCount() {
  return (state.directions || []).filter((d) => d.active !== false).length;
}
const MAX_ACTIVE_DIRECTIONS = 8;

// An edit is "cosmetic-only" when the proposal's updates blob contains
// nothing but title_en and/or description_he — no musical changes (genres,
// BPM, inst_pref, popularity_pref). Same-music renames don't need a preview
// swipe deck or a "החליפו עכשיו / השאירו עד סגירה" question — one confirm
// tap, straight to apply, live Spotify playlist gets renamed in place.
// Empty/undefined values are stripped first so a `{title_en: "", ...}` blob
// (model regression) doesn't accidentally count as a rename.
function isCosmeticOnlyUpdates(updates) {
  if (!updates || typeof updates !== 'object') return false;
  const meaningful = Object.entries(updates).filter(([_, v]) => {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }).map(([k]) => k);
  if (!meaningful.length) return false;
  return meaningful.every((k) => k === 'title_en' || k === 'description_he');
}

function cosmeticInProgressLabel(updates) {
  const hasTitle = typeof updates?.title_en === 'string' && updates.title_en.trim().length > 0;
  const hasDesc  = typeof updates?.description_he === 'string' && updates.description_he.trim().length > 0;
  if (hasTitle && hasDesc) return 'מעדכנים את הכיוון…';
  if (hasTitle) return 'מעדכנים את השם…';
  return 'מעדכנים את התיאור…';
}

function cosmeticSuccessLabel(updates) {
  const hasTitle = typeof updates?.title_en === 'string' && updates.title_en.trim().length > 0;
  const hasDesc  = typeof updates?.description_he === 'string' && updates.description_he.trim().length > 0;
  if (hasTitle && hasDesc) return '✓ הכיוון עודכן';
  if (hasTitle) return '✓ השם עודכן';
  return '✓ התיאור עודכן';
}

// Append a synthetic assistant bubble that isn't persisted to the DB —
// used for out-of-band notices like "you're at the 8-direction cap".
// (Not saved because these messages describe the current dashboard state,
// which will be visible authoritatively on next load anyway.)
function appendSyntheticAssistantMessage(text) {
  const box = $('dirChatMessages');
  if (!box) return;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble assistant';
  bubble.textContent = text;
  box.append(bubble);
  scrollTranscriptToBottom();
}

// ---- preview modal -----------------------------------------------------
//
// Single-card variant. Layout per index.html's .dp-modal block. Distinct
// from the onboarding swipe deck's multi-card renderer — one card at a
// time, no rails, one swap button, one confirm/dismiss row.

let currentModalCtx = null;

// Set of spotify ids the owner has super-liked SINCE this modal session
// started. Persisted server-side via toggle-super-like on each click, so
// the DB stays in sync even if the modal is dismissed. Kept per-session
// (not loaded from DB on open) — a track flipped ON in this session
// paints .saved when the owner swaps back to it inside the same modal.
let modalSuperLiked = new Set();

function openPreviewModal(ctx) {
  // ctx: { kind:'edit', directionId, updates, messageId }
  //   or { kind:'add',  spec, messageId }
  currentModalCtx = { ...ctx, seenIds: [], cycleIndex: 0, currentSpotifyId: null, controller: null };
  modalSuperLiked = new Set();
  const overlay = $('dirPreviewModal');
  if (!overlay) return;
  overlay.classList.remove('hide');
  const title = ctx.kind === 'add' ? 'כיוון חדש — לפני שמחילים' : 'עדכון כיוון — לפני שמחילים';
  $('dpTitle').textContent = title;
  $('dpDesc').textContent = '';
  showLoading();
  loadFirstCard();
}

function closePreviewModal() {
  const overlay = $('dirPreviewModal');
  if (!overlay) return;
  overlay.classList.add('hide');
  if (currentModalCtx?.controller) {
    try { currentModalCtx.controller.destroy(); } catch { }
  }
  currentModalCtx = null;
}

function showLoading() {
  $('dpBody').innerHTML =
    '<div class="dp-loading"><span class="sb-spinner"></span>בונים דוגמה…</div>';
  $('dpActions').replaceChildren();
}

function showEmpty(reason) {
  $('dpBody').innerHTML =
    `<div class="dp-empty">${escHtml(reason || 'לא מצאנו שיר מתאים בפול. אפשר לחדד עוד בצ׳אט.')}</div>`;
  const actions = $('dpActions');
  actions.replaceChildren();
  const back = document.createElement('button');
  back.className = 'btn btn-ghost';
  back.textContent = 'חזרה לצ׳אט';
  back.addEventListener('click', closePreviewModal);
  actions.append(back);
}

// Map of messageId → in-flight/completed prefetch promise. Populated by
// ensurePreviewPrefetch when a proposal-carrying assistant message renders,
// consumed by loadFirstCard when the owner opens the modal. Idempotent —
// prefetching the same messageId twice returns the same promise.
const previewPrefetchByMessageId = new Map();

// Kick off (once per messageId) a background preview fetch so the modal
// opens with the card ready. Cheap when the owner ends up clicking; a
// wasted API call when they don't — the preview endpoint shares the
// anchor-tracks bucket and is well under any budget concern.
function ensurePreviewPrefetch(messageId, proposal) {
  if (!messageId || !proposal) return null;
  if (proposal.kind !== 'edit' && proposal.kind !== 'add') return null;
  if (previewPrefetchByMessageId.has(messageId)) return previewPrefetchByMessageId.get(messageId);
  const p = fetchPreviewOnce({ proposal });
  previewPrefetchByMessageId.set(messageId, p);
  return p;
}

// Reconstruct the proposal shape from currentModalCtx so swap calls (which
// use the same fetcher) don't need a second copy of the direction-id vs
// inline-spec branching.
function proposalFromCtx(ctx) {
  if (!ctx) return null;
  if (ctx.kind === 'edit') return { kind: 'edit', direction_id: ctx.directionId, updates: ctx.updates || {} };
  if (ctx.kind === 'add') return { kind: 'add', spec: ctx.spec };
  return null;
}

// One preview-direction round trip + track meta lookup. Never rejects —
// returns { ok:true, spotifyId, meta, mergedSpec, nextCycleIndex } on
// success or { ok:false, error, mergedSpec? } on failure. Shared by
// prefetch, initial modal load, and swap.
async function fetchPreviewOnce({ proposal, excludeSpotifyIds = [], cycleIndex = 0 }) {
  const biz = getBusiness();
  if (!biz) return { ok: false, error: 'no business' };
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) return { ok: false, error: 'לא מחוברים' };
    const body = { businessId: biz.id, excludeSpotifyIds, cycleIndex };
    if (proposal.kind === 'edit') { body.directionId = proposal.direction_id; body.updates = proposal.updates || {}; }
    if (proposal.kind === 'add') { body.inlineSpec = proposal.spec; }
    const r = await fetch('/api/v6/account/preview-direction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data?.error || `שגיאה ${r.status}` };
    if (!data.ok || !data.spotifyId) {
      return { ok: false, error: data.error || 'no track matched', mergedSpec: data.mergedSpec };
    }
    const meta = await fetchTrackMeta(data.spotifyId).catch(() => ({}));
    return {
      ok: true,
      spotifyId: data.spotifyId,
      meta: meta || {},
      mergedSpec: data.mergedSpec,
      nextCycleIndex: data.nextCycleIndex,
    };
  } catch (e) {
    return { ok: false, error: e.message || 'שגיאה' };
  }
}

// Load the FIRST card of a modal session. Uses the prefetched promise (if
// any) so the modal renders instantly for the common case where the owner
// clicks the preview button seconds after the proposal arrived.
async function loadFirstCard() {
  if (!currentModalCtx) return;
  const messageId = currentModalCtx.messageId;
  const cached = messageId ? previewPrefetchByMessageId.get(messageId) : null;
  const result = cached
    ? await cached
    : await fetchPreviewOnce({ proposal: proposalFromCtx(currentModalCtx) });
  if (!currentModalCtx) return;  // user closed the modal mid-await
  if (!result.ok) {
    showEmpty(result.error === 'no track matched'
      ? 'לא מצאנו שיר בפול הנוכחי. אולי כדאי לחדד עוד בצ׳אט.'
      : (result.error || undefined));
    return;
  }
  applyResultToModalState(result);
  renderCard(result.spotifyId, result.meta, result.mergedSpec);
}

// Swap to the next track. Always a fresh fetch (never uses the prefetch
// cache — that was for the initial card only).
async function loadNextCardForSwap() {
  if (!currentModalCtx) return;
  const { seenIds, cycleIndex } = currentModalCtx;
  const result = await fetchPreviewOnce({
    proposal: proposalFromCtx(currentModalCtx),
    excludeSpotifyIds: seenIds,
    cycleIndex,
  });
  if (!currentModalCtx) return;
  if (!result.ok) {
    // Pool exhausted / server error — keep the current track on screen
    // and re-enable the swap button with a soft notice.
    toast(result.error === 'no track matched' ? 'אין עוד שירים בכיוון הזה' : (result.error || 'שגיאה'));
    const swap = $('dpBody')?.querySelector('.dp-swap');
    if (swap) { swap.disabled = false; swap.innerHTML = `${SWAP_ICON}<span>שמעו עוד שיר מהכיוון הזה</span>`; }
    return;
  }
  applyResultToModalState(result);
  renderCard(result.spotifyId, result.meta, result.mergedSpec);
}

function applyResultToModalState(result) {
  if (!currentModalCtx) return;
  currentModalCtx.mergedSpec = result.mergedSpec;
  if (Number.isFinite(result.nextCycleIndex)) currentModalCtx.cycleIndex = result.nextCycleIndex;
  currentModalCtx.currentSpotifyId = result.spotifyId;
  currentModalCtx.seenIds = [...currentModalCtx.seenIds, result.spotifyId];
}

async function fetchTrackMeta(spotifyId) {
  const r = await fetch('/api/v4/spotify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_track', track_id: spotifyId }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d?.name) return {};
  return {
    name: d.name,
    artist: (d.artists || []).map((a) => a.name).filter(Boolean).join(', '),
    art: d.album?.images?.[1]?.url || d.album?.images?.[0]?.url || '',
  };
}

// Renders the preview card into the modal. Wires up the play button
// (Spotify IFrame API), the swap button, and the two footer buttons
// (dismiss / confirm+super-like combined via the star icon).
async function renderCard(spotifyId, meta, mergedSpec) {
  const body = $('dpBody');
  if (!body || !currentModalCtx) return;

  // Update the description above the card with the merged spec's
  // Hebrew description — that's what the owner is really committing to.
  const dpDesc = $('dpDesc');
  if (dpDesc) dpDesc.textContent = mergedSpec?.description_he || '';

  body.innerHTML = '';

  const art = meta.art
    ? `<img class="dp-art" src="${escHtml(meta.art)}" alt="">`
    : `<div class="dp-art dp-art-ph">${SPOTIFY_ART_FALLBACK}</div>`;
  const inner = document.createElement('div');
  inner.className = 'dp-card';
  inner.innerHTML =
    `<div class="dp-art-wrap">${art}` +
    `<button class="dp-super" type="button" title="סופר לייק — נשמור את השיר">${STAR_ICON}</button>` +
    `<button class="dp-play" type="button" aria-label="נגן">${PLAY_ICON}</button>` +
    `<div class="dp-hidden-embed"><div class="dp-embed-mount"></div></div>` +
    `</div>` +
    `<div class="dp-title-row">` +
    `<div class="dp-track-name">${escHtml(meta.name || '')}</div>` +
    `<div class="dp-track-artist">${escHtml(meta.artist || '')}</div>` +
    `</div>` +
    `<div class="dp-progress">` +
    `<div class="dp-prog-bar">` +
    `<div class="dp-prog-track"><div class="dp-prog-fill"></div></div>` +
    `<div class="dp-prog-thumb"></div>` +
    `</div>` +
    `<div class="dp-timestamps"><span class="dp-prog-current">0:00</span><span class="dp-prog-total">0:00</span></div>` +
    `</div>` +
    `<button class="dp-swap" type="button">${SWAP_ICON}<span>שמעו עוד שיר מהכיוון הזה</span></button>`;
  body.append(inner);

  const playBtn = inner.querySelector('.dp-play');
  const swapBtn = inner.querySelector('.dp-swap');
  const superBtn = inner.querySelector('.dp-super');
  const mount = inner.querySelector('.dp-embed-mount');
  const pbBar = inner.querySelector('.dp-prog-bar');
  const pbFill = inner.querySelector('.dp-prog-fill');
  const pbThumb = inner.querySelector('.dp-prog-thumb');
  const pbCurrent = inner.querySelector('.dp-prog-current');
  const pbTotal = inner.querySelector('.dp-prog-total');
  // If the owner already super-liked this track earlier in this modal
  // session (e.g., swapped away and back), paint .saved so the button
  // visibly reflects the current state.
  if (modalSuperLiked.has(spotifyId)) superBtn.classList.add('saved');

  // Playback progress bar. Same pattern as the onboarding preview:
  //   - pbState mirrors the iframe's play position between the sparse
  //     playback_update events
  //   - RAF loop interpolates so the fill/thumb move smoothly
  //   - seekLockUntil guards against the stale post-seek update Spotify
  //     fires once with the pre-seek position, which without the guard
  //     briefly jerks the dot backward
  //   - Click or drag on the bar → controller.seek(seconds)
  const pbState = {
    lastPosition: 0,
    lastTimestamp: Date.now(),
    duration: 0,
    isPaused: true,
    dragging: false,
    pendingSeek: null,
    seekLockUntil: 0,
  };

  function pbPctFromEvent(e) {
    const rect = pbBar.getBoundingClientRect();
    const x = Math.max(rect.left, Math.min(rect.right, e.clientX));
    return rect.width > 0 ? (x - rect.left) / rect.width : 0;
  }
  function pbSeekTo(seconds) {
    const c = currentModalCtx?.controller;
    if (!c) return;
    try { c.seek(seconds); } catch { }
    pbState.lastPosition = seconds * 1000;
    pbState.lastTimestamp = Date.now();
    pbState.seekLockUntil = Date.now() + 500;
  }
  pbBar.addEventListener('pointerdown', (e) => {
    if (!pbState.duration) return;
    e.stopPropagation();
    pbState.dragging = true;
    pbState.pendingSeek = pbPctFromEvent(e) * (pbState.duration / 1000);
    pbBar.classList.add('dragging');
    try { pbBar.setPointerCapture(e.pointerId); } catch { }
    e.preventDefault();
  });
  pbBar.addEventListener('pointermove', (e) => {
    if (!pbState.dragging) return;
    pbState.pendingSeek = pbPctFromEvent(e) * (pbState.duration / 1000);
  });
  const endPbDrag = () => {
    if (!pbState.dragging) return;
    const target = pbState.pendingSeek;
    pbState.dragging = false;
    pbState.pendingSeek = null;
    pbBar.classList.remove('dragging');
    if (target != null) pbSeekTo(target);
  };
  pbBar.addEventListener('pointerup', endPbDrag);
  pbBar.addEventListener('pointercancel', endPbDrag);

  function pbCurrentPosMs() {
    if (pbState.dragging && pbState.pendingSeek != null) return pbState.pendingSeek * 1000;
    if (pbState.isPaused) return pbState.lastPosition;
    const elapsed = Date.now() - pbState.lastTimestamp;
    return Math.min(pbState.duration || Infinity, pbState.lastPosition + elapsed);
  }
  // RAF loop self-terminates when the card element is removed from the DOM
  // (swap or modal close).
  (function pbTick() {
    if (!inner.isConnected) return;
    const pos = pbCurrentPosMs();
    const dur = pbState.duration;
    const pct = dur > 0 ? Math.min(1, pos / dur) : 0;
    pbFill.style.width = (pct * 100) + '%';
    pbThumb.style.left = (pct * 100) + '%';
    pbCurrent.textContent = fmtTime(pos);
    pbTotal.textContent = fmtTime(dur);
    requestAnimationFrame(pbTick);
  })();

  // Wire the Spotify IFrame API.
  let pendingPlay = false;
  const api = await getSpotifyIframeApi();
  if (!currentModalCtx || currentModalCtx.currentSpotifyId !== spotifyId) return; // swapped out mid-await
  api.createController(mount, { uri: `spotify:track:${spotifyId}`, width: '100%', height: 80 }, (c) => {
    if (!currentModalCtx || currentModalCtx.currentSpotifyId !== spotifyId) {
      try { c.destroy(); } catch { }
      return;
    }
    // Clean up any previous controller before assigning the new one.
    if (currentModalCtx.controller && currentModalCtx.controller !== c) {
      try { currentModalCtx.controller.destroy(); } catch { }
    }
    currentModalCtx.controller = c;
    c.addListener('playback_update', (e) => {
      const dd = e?.data || {};
      const paused = dd.isPaused !== false;
      playBtn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
      // Feed position + duration into pbState so the RAF loop / scrub
      // handlers reflect the actual iframe state. Ignore position while
      // the seek-lock window is active — Spotify emits one stale update
      // right after seek() with the pre-seek position.
      if (typeof dd.duration === 'number' && dd.duration > 0) pbState.duration = dd.duration;
      if (typeof dd.position === 'number' && Date.now() >= pbState.seekLockUntil) {
        pbState.lastPosition = dd.position;
        pbState.lastTimestamp = Date.now();
      }
      pbState.isPaused = paused;
    });
    if (pendingPlay) {
      pendingPlay = false;
      try { c.play(); } catch { }
    }
  });

  playBtn.addEventListener('click', () => {
    if (currentModalCtx?.controller) {
      try { currentModalCtx.controller.togglePlay(); } catch { }
    } else {
      pendingPlay = true;
    }
  });

  swapBtn.addEventListener('click', async () => {
    swapBtn.disabled = true;
    swapBtn.innerHTML = '<span class="sb-spinner" style="width:14px;height:14px;margin-inline-end:6px;vertical-align:-2px"></span>מחליפים…';
    // Tear down the current embed so a fresh createController fires cleanly
    // — otherwise Chromium keeps the old iframe around and the new play
    // button ends up controlling the previous track.
    if (currentModalCtx?.controller) {
      try { currentModalCtx.controller.destroy(); } catch { }
      currentModalCtx.controller = null;
    }
    await loadNextCardForSwap();
  });

  superBtn.addEventListener('click', () => {
    // Toggle-only: super-liking a track saves/unsaves it for future
    // taste-tuning but does NOT commit the direction change. The confirm
    // button below the card is the sole commit path.
    toggleSuperLike(superBtn, spotifyId);
  });

  // Action row: dismiss + confirm.
  const actions = $('dpActions');
  actions.replaceChildren();
  const dismiss = document.createElement('button');
  dismiss.className = 'btn btn-ghost';
  dismiss.textContent = 'לא מתאים · חזרה לצ׳אט';
  dismiss.addEventListener('click', closePreviewModal);
  const confirm = document.createElement('button');
  confirm.className = 'btn';
  confirm.textContent = currentModalCtx.kind === 'add' ? 'אישור והוספה' : 'אישור והחלה';
  confirm.addEventListener('click', () => commitCurrent());
  actions.append(dismiss, confirm);
}

// Optimistic toggle of the .saved / .burst classes + non-blocking persist
// via /api/v6/account/toggle-super-like. On persist failure, roll the UI
// back so the button reflects the actual DB state.
async function toggleSuperLike(superBtn, spotifyId) {
  if (!spotifyId) return;
  const biz = getBusiness();
  if (!biz) return;

  // Replay the burst ring on every click via remove/reflow/add.
  superBtn.classList.remove('burst');
  void superBtn.offsetWidth;
  superBtn.classList.add('burst');

  const willBeSaved = !superBtn.classList.contains('saved');
  superBtn.classList.toggle('saved', willBeSaved);
  if (willBeSaved) modalSuperLiked.add(spotifyId);
  else modalSuperLiked.delete(spotifyId);
  toast(willBeSaved ? 'סופר לייק נשמר' : 'סופר לייק הוסר');

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('לא מחוברים');
    const r = await fetch('/api/v6/account/toggle-super-like', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ businessId: biz.id, spotifyId, active: willBeSaved }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data?.error || `שגיאה ${r.status}`);
    }
  } catch (e) {
    console.warn('[direction-chat] super-like toggle failed:', e.message);
    // Roll the optimistic UI back.
    superBtn.classList.toggle('saved', !willBeSaved);
    if (willBeSaved) modalSuperLiked.delete(spotifyId);
    else modalSuperLiked.add(spotifyId);
    toast('שגיאה');
  }
}

async function commitCurrent() {
  if (!currentModalCtx) return;
  const { kind, directionId, updates, spec, messageId } = currentModalCtx;

  // Close the modal RIGHT AWAY. For edit the next step is an inline
  // chat question (keep-old vs replace-now); for add we go straight to
  // the spinner bubble because there's no old playlist to reason about.
  if (currentModalCtx?.controller) {
    try { currentModalCtx.controller.destroy(); } catch { }
  }
  closePreviewModal();

  if (kind === 'edit') {
    // Symmetric to the remove flow's inline follow-up: the owner picks
    // whether to replace today's playlist now or leave it until closing
    // time. Only after they pick does the server touch anything.
    askEditPlaylistOption(directionId, updates, messageId);
    return;
  }

  // Add — go straight to the in-progress bubble + commit.
  runApplyWithSpinnerBubble({
    body: {
      kind: 'add',
      spec,
      messageIdFirst: messageId || null,
      messageIdLast: messageId || null,
    },
    inProgressLabel: 'בונים את הכיוון החדש…',
    successLabel: '✓ נוסף כיוון חדש',
  });
}

// Appends an assistant question bubble with two buttons for the edit
// playlist decision. Clicking either disables both, mutates the bubble
// into a spinner state, and runs the commit.
function askEditPlaylistOption(directionId, updates, messageId) {
  const box = $('dirChatMessages');
  if (!box) return;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble assistant';
  bubble.textContent = 'להחליף את הפלייליסט של הכיוון עכשיו, או להשאיר את הקיים עד סגירה ולהתחיל את החדש רק מחר?';
  const row = document.createElement('div');
  row.className = 'chat-actions';
  const replaceBtn = document.createElement('button');
  replaceBtn.className = 'btn';
  replaceBtn.textContent = 'החליפו עכשיו';
  const keepBtn = document.createElement('button');
  keepBtn.className = 'btn btn-ghost';
  keepBtn.textContent = 'השאירו עד סגירה';
  row.append(replaceBtn, keepBtn);
  bubble.append(row);
  box.append(bubble);
  scrollTranscriptToBottom();

  const pick = (expireLive) => {
    replaceBtn.disabled = true;
    keepBtn.disabled = true;
    // Rewrite the bubble to the in-progress state (drops the buttons).
    bubble.textContent = '';
    const spinnerSpan = document.createElement('span');
    spinnerSpan.className = 'sb-spinner';
    spinnerSpan.style.cssText = 'width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px';
    bubble.append(spinnerSpan);
    bubble.append(document.createTextNode(
      expireLive ? 'מעדכנים את הכיוון ובונים פלייליסט חדש…' : 'מעדכנים את הכיוון…',
    ));
    runApplyWithSpinnerBubble({
      body: {
        kind: 'edit',
        directionId,
        updates,
        expireLivePlaylist: expireLive,
        messageIdFirst: messageId || null,
        messageIdLast: messageId || null,
      },
      inProgressLabel: null,       // bubble already shows the label
      successLabel: expireLive
        ? '✓ הכיוון עודכן ופלייליסט חדש נבנה'
        : '✓ הכיוון עודכן — הפלייליסט החדש יופיע מחר',
      existingBubble: bubble,
    });
  };
  replaceBtn.addEventListener('click', () => pick(true));
  keepBtn.addEventListener('click', () => pick(false));
}

// Shared spinner-bubble commit path. Either appends a new bubble with the
// spinner (add flow) or mutates an existing bubble (edit's follow-up).
async function runApplyWithSpinnerBubble({ body, inProgressLabel, successLabel, existingBubble }) {
  const box = $('dirChatMessages');
  let bubble = existingBubble;
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant';
    bubble.innerHTML =
      `<span class="sb-spinner" style="width:14px;height:14px;vertical-align:-2px;margin-inline-end:6px"></span>${escHtmlInline(inProgressLabel || '…')}`;
    if (box) { box.append(bubble); scrollTranscriptToBottom(); }
  }

  try {
    const res = await callApply(body);
    if (!res.ok) {
      if (res.code === 'cap_reached') {
        bubble.textContent = `אי אפשר להוסיף עוד כיוון — כבר יש ${MAX_ACTIVE_DIRECTIONS} כיוונים פעילים, שזה המקסימום. הסירו כיוון קיים קודם ואז נוכל להוסיף את החדש.`;
        // Refresh only the cards — renderAll would wipe the transcript
        // (including this just-set synthetic bubble) since messages don't
        // load on hard refresh.
        const biz = getBusiness();
        if (biz) reloadState(biz.id).then(renderDirectionCards).catch(() => { });
        return;
      }
      throw new Error(res.error || 'לא הצלחנו להחיל');
    }
    bubble.textContent = successLabel;
    // When a fresh playlist was actually built (add + edit-replace-now),
    // append a yellow "open playlist" button — matches the other CTA
    // buttons in the chat (הסירו את הכיוון, שמעו את הכיוון החדש, etc.)
    // instead of a plain underlined link. 'kept' edits and any add whose
    // build fell through won't have a url — success label stands alone.
    if (res.playlist?.url) {
      const actions = document.createElement('div');
      actions.className = 'chat-actions';
      const link = document.createElement('a');
      link.href = res.playlist.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'btn';
      link.style.textDecoration = 'none';
      link.textContent = 'פתחו את הפלייליסט';
      actions.append(link);
      bubble.append(actions);
    }
    bubble.style.background = 'rgba(87,163,189,.18)';
    bubble.style.borderColor = 'rgba(87,163,189,.5)';
    await refreshAfterCommit();
  } catch (e) {
    console.error('[direction-chat] apply failed:', e);
    bubble.textContent = String(e.message || 'שגיאה בעדכון הכיוון');
  }
}

// Tiny html-escape used only when we're constructing a spinner + label
// via innerHTML. Kept as its own function so the escHtml at the top of
// this file (used for user-controlled text) stays a single-purpose util.
function escHtmlInline(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// Post-commit: reload state + rerender the cards/transcript, and notify
// the Home tab. Split out of the older postCommitRefresh because that
// version also appended its own ✓ marker — the new commit path writes
// the marker in place by mutating the spinner bubble, so we skip the
// marker step here.
async function refreshAfterCommit() {
  const biz = getBusiness();
  if (!biz) return;
  try {
    await reloadState(biz.id);
    renderDirectionCards();
    // Do NOT rerender the transcript from scratch — the in-place mutated
    // bubble above is a synthetic (non-persisted) message and a full
    // rerender from DB would drop it. Card refresh is enough here.
  } catch (e) {
    console.warn('[direction-chat] post-commit reload failed:', e.message);
  }
  document.dispatchEvent(new CustomEvent('direction-change-applied', {
    detail: { businessId: biz.id },
  }));
}
