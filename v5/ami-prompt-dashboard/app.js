// v5 Ami prompt dashboard.
// Lets Ami tweak the editable half of the musical-directions system prompt,
// fire one model call against real business inputs, and see the returned
// directions in a readable text block with a copy button.
//
// As of 2026-09-23 the dashboard reads the v7 prompt (diagnostic taste
// probes, homogeneous clusters — see v7/generation/musical-directions.js).
// It used to read v5's byte-identical mirror of v6's blend-style prompt.
// v5's file still exists for the legacy v5/app.js standalone UI, but Ami
// is no longer tuning against it.
//
// Which model runs (Anthropic vs Gemini) is controlled by v7/generation/ai-provider.js
// (v7 has its own provider switch, separate from v6's). Flipping PROVIDER in
// that file changes both this dashboard AND future v7 production traffic.
//
// Flow:
//   1. Import EDITABLE_PROMPT_SECTION + assembleSystemPrompt from the v7
//      musical-directions module (single source of truth for v7 prompt tuning).
//   2. Pre-fill the textarea with EDITABLE_PROMPT_SECTION.
//   3. On generate: assemble system = editedEditable + '\n\n' + FIXED,
//      user message = business inputs, call the shared ai-provider.
//   4. Parse response JSON, format each direction as text, display.
//   5. Copy button dumps the formatted text to clipboard.
//
// Taste-profile stage (added 2026-09-28) — the v7 prompt that runs after the
// swipe deck (v7/generation/taste-profile.js):
//   1. Once step 1 returns directions, a swipe-simulation card lists them:
//      Ami marks each liked / disliked, and clicks genres to super-like them
//      (a super-like also marks its direction liked, as in onboarding).
//   2. A second editor holds the taste-profile EDITABLE_PROMPT_SECTION.
//   3. On generate: system = that module's assembleSystemPrompt(edited),
//      user message = its own buildUserMessage (the exact prod format),
//      response normalized by its normalizeTasteProfile, then displayed.
//   Round 2 isn't simulated — the taste profile sees "Round 2 directions:
//   (not fired)", same as an onboarding where R1 yielded 3+ picks.
//
// Daily-playlist stage (added 2026-09-28) — step 4, once step 3 returned a
// taste profile: Ami picks Option 1 or Option 2, edits that option's prompt,
// and sees the directions the playlists would be built from, with a short
// Hebrew explanation of how the day's playlists use them (Option 2 also
// shows the next days' rotation). Each option keeps its own editor, last
// result and status, so Ami can switch back and forth (and one option can
// keep generating while he looks at the other). Production's FIXED section,
// user message and normalizer — see playlist-directions.js.
//
// Energy test playlists (added 2026-09-30) — under an Option 1 result, each
// direction gets a "50 random tracks" button and an energy-range modal that
// build real test playlists on Rubin's Spotify account — see test-playlists.js.
//
// Two decks (Ami, 2026-11-02) — steps 1–3 test the split onboarding the site
// runs: step 1 builds a calm deck and an energetic deck of 6
// (v7/generation/deck-directions.js, one call each, in parallel; calm first
// since 2026-11-03, as the owner sees them), step 2 marks likes per deck,
// step 3 runs the two-sided taste profile
// (v7/generation/taste-profile-decks.js), where a both-ways genre may be
// approved twice. Step 1 also shows the venue category the model picked,
// which chooses the picture before each deck (2026-11-03).

import { normalizeVenuePhrase } from '/v7/generation/musical-directions.js?v=02112026a';
import {
  DECK_EDITABLE_PROMPT_SECTION,
  DECK_ORDER,
  assembleDeckSystemPrompt,
  buildDeckUserMessage,
  normalizeDeckDirections,
  normalizeVenueCategory,
} from '/v7/generation/deck-directions.js?v=03112026a';
// Round 2 opens for a deck with fewer likes than this (3 since 2026-11-03), as in the onboarding.
import { ROUND2_MIN_LIKES } from '/v7/generation/refined-directions.js?v=03112026a';
import {
  DECK_TASTE_EDITABLE_PROMPT_SECTION,
  assembleDeckTasteSystemPrompt,
  buildDeckTasteUserMessage,
  normalizeDeckTasteProfile,
  calmTop,
} from '/v7/generation/taste-profile-decks.js?v=02112026a';
import { DECK_WINDOWS } from '/shared/genre-sides.js?v=02112026a';
import { callModel, parseJSONFromText, PROVIDER } from '/v7/generation/ai-provider.js?v=24102026a';
import { generateForOption, formatOption1, formatOption2, EXPLANATION_HE, DEFAULT_EDITABLE } from './playlist-directions.js?v=02112026a';
import { renderTestPlaylists } from './test-playlists.js?v=24102026a';
import { mountTasteChatTab, onTasteTabShown } from './taste-chat-tab.js?v=02112026a';
import { mountEventChatTab } from './event-chat-tab.js?v=21102026c';

// Match v6 production. Gemini 3.6-flash's hard output-token cap is 65536;
// values above that are silently clamped by Google. Under thinkingLevel
// 'high' the model burns a big chunk of the budget on thinking tokens, so
// a smaller cap here truncates the visible JSON mid-object (parse error
// "Expected double-quoted property name"). Only failing calls are
// affected — you only pay for tokens actually generated.
const MAX_TOKENS = 65536;

// Lenient wrapper around prod's strict assembleSystemPrompt, scoped to
// this dashboard only. Ami iterates on the prompt freely — renaming
// headings, restructuring sections, etc. — and prod's exact-anchor Places
// injection can't keep up. This function normalizes ONLY the version
// submitted to Gemini so previews still work; Ami's textarea keeps his
// original wording.
//
// Two normalizations:
//   1. Strip leftover `{{PLACES_*}}` sentinels. Older prompt versions had
//      them visible; a lingering copy in Ami's edit would be sent to
//      Gemini as literal noise.
//   2. Rename any `### <anything> Processing Rules:` heading to the exact
//      canonical form the strict assembleSystemPrompt anchors on. Both Places
//      blocks are placed relative to it (since 2026-09-30 the processing rule
//      goes at the end of that block; before, it anchored on
//      `## Energy & Pairing Constraints`, which this also used to rename).
//
// When Ami settles on a final prompt, Roni ports it into prod and
// reconciles heading names manually — prod stays strict on purpose so
// silent injection failures show up loudly as missing Places context.
function normalizeForProdAssembly(editable) {
  return editable
    .replace(/^\{\{PLACES_INPUT_BLOCK\}\}\n?/gm, '')
    .replace(/^\{\{PLACES_PROCESSING_RULE\}\}\n?/gm, '')
    .replace(/^### [^\n]*Processing Rules:$/gm, '### Processing Rules:');
}

const $ = (id) => document.getElementById(id);

const els = {
  bizName:          $('bizName'),
  bizDesc:          $('bizDesc'),
  atmoContainer:    $('atmoContainer'),
  musicalEmphases:  $('musicalEmphases'),
  promptEditor:     $('promptEditor'),
  generateBtn:      $('generateBtn'),
  statusLine:       $('statusLine'),
  resultsCard:      $('resultsCard'),
  usageLine:        $('usageLine'),
  outputText:       $('outputText'),
  copyBtn:          $('copyBtn'),
  copyResultBtn:    $('copyResultBtn'),
  swipeCard:          $('swipeCard'),
  swipeList:          $('swipeList'),
  round2Emphases:     $('round2Emphases'),
  instPref:           $('instPref'),
  popPref:            $('popPref'),
  tastePromptEditor:  $('tastePromptEditor'),
  tasteGenerateBtn:   $('tasteGenerateBtn'),
  tasteStatusLine:    $('tasteStatusLine'),
  tasteResultsCard:   $('tasteResultsCard'),
  tasteUsageLine:     $('tasteUsageLine'),
  tasteOutputText:    $('tasteOutputText'),
  copyTastePromptBtn: $('copyTastePromptBtn'),
  copyTasteResultBtn: $('copyTasteResultBtn'),
  playlistCard:          $('playlistCard'),
  playlistOptionSeg:     $('playlistOptionSeg'),
  playlistEditors:       { option1: $('energyPromptEditor'), option2: $('levelPromptEditor') },
  copyPlaylistPromptBtn: $('copyPlaylistPromptBtn'),
  playlistGenerateBtn:   $('playlistGenerateBtn'),
  playlistStatusLine:    $('playlistStatusLine'),
  playlistResultsCard:   $('playlistResultsCard'),
  playlistResultsTitle:  $('playlistResultsTitle'),
  playlistExplain:       $('playlistExplain'),
  playlistUsageLine:     $('playlistUsageLine'),
  playlistOutputText:    $('playlistOutputText'),
  copyPlaylistResultBtn: $('copyPlaylistResultBtn'),
  testPlaylistsHost:     $('testPlaylistsHost'),
};

// Last successful step-1 run: both decks' directions (energetic ranks 1–6,
// calm 7–12, each tagged with `deck`) plus the business inputs that produced them. The taste profile
// is built from this snapshot, so editing the inputs afterwards can't pair
// new inputs with directions generated from old ones.
let r1Run = null;
// Swipe simulation, keyed by rank. decisions: rank → 'like' | 'dislike'.
// superLiked: rank → Set of that direction's genres Ami super-liked.
const decisions  = new Map();
const superLiked = new Map();
// Last successful step-3 run: the normalized taste profile + the business
// inputs it came from. Step 4 builds directions from this.
let tasteRun = null;
// Step 4: the selected daily playlist type, and per option its last result
// ({ text, usage, elapsed, testsEl? } or null — testsEl = Option 1's test-
// playlist section, kept so builds in flight survive repaints), status line
// [text, kind] and in-flight flag.
let playlistOption = 'option1';
const playlistState = {
  option1: { result: null, status: ['', ''], busy: false },
  option2: { result: null, status: ['', ''], busy: false },
};

// Pre-fill the editors with the current defaults.
els.promptEditor.value      = DECK_EDITABLE_PROMPT_SECTION;
els.tastePromptEditor.value = DECK_TASTE_EDITABLE_PROMPT_SECTION;

// The decks are listed in the order the owner sees them (DECK_ORDER, from
// deck-directions.js: calm first since 2026-11-03).
const DECK_TITLES = {
  calm: `כיוונים רגועים (ראשונים) — שירים באנרגיה ${DECK_WINDOWS.calm.join('–')}`,
  energetic: `כיוונים אנרגטיים — שירים באנרגיה ${DECK_WINDOWS.energetic.join('–')}`,
};
const CATEGORY_HE = { 'food-drink': 'אוכל ושתייה', beauty: 'שיער, קוסמטיקה ויופי', clothing: 'חנות בגדים' };
const DECK_SHORT = { energetic: 'אנרגטיים', calm: 'רגועים' };
els.playlistEditors.option1.value = DEFAULT_EDITABLE.option1;
els.playlistEditors.option2.value = DEFAULT_EDITABLE.option2;

// ---------- Tabs (2026-10-21): אונבורדינג / צ'אט הטעם / צ'אט פלייליסטים מיוחדים ----------
// The special-playlists tab uses this tab's business name and taste profile
// (step 3); the taste chat tab loads real businesses (taste-chat-tab.js).
const chatSource = () => ({
  profile: tasteRun?.profile || null,
  inputs: tasteRun?.inputs || r1Run?.inputs || null,
  option1: playlistState.option1.result?.directions || [],
  option2: playlistState.option2.result?.directions || [],
});
mountTasteChatTab();
mountEventChatTab({ getSource: chatSource });
// The tabs themselves switch in an inline script in index.html, so they work
// before this module (and everything it imports) has loaded.
const onTab = (tab) => { if (tab === 'taste') onTasteTabShown(); };
window.addEventListener('ami-tab', (e) => onTab(e.detail));
onTab(window.amiTab);

// Load atmosphere checkboxes. As in v7 production, the checked names only
// become an "Atmospheres: ..." line in the user message, next to the
// description. They don't set a popularity range: that atmosphere-derived
// window was removed from production on 2026-09-02, and popularity is now
// narrowed only by the model's popularity_preference.
(async () => {
  try {
    const r = await fetch('/api/v5/databox-atmospheres?fresh=1');
    if (!r.ok) throw new Error(`databox-atmospheres ${r.status}`);
    const { rows } = await r.json();
    renderAtmosphereCheckboxes(Array.isArray(rows) ? rows : []);
  } catch (err) {
    els.atmoContainer.className = 'atmo-loading';
    els.atmoContainer.textContent = 'לא הצליח לטעון אווירות — ' + err.message;
  }
})();

function renderAtmosphereCheckboxes(rows) {
  els.atmoContainer.className = 'atmo-grid';
  els.atmoContainer.replaceChildren();
  for (const row of rows) {
    const name = row?.atmosphere;
    if (!name) continue;
    const id = `atmo-${row.row}`;
    const checkbox = document.createElement('input');
    checkbox.type    = 'checkbox';
    checkbox.className = 'atmo-checkbox';
    checkbox.id      = id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'atmo-name';
    nameSpan.textContent = name;

    const chip = document.createElement('label');
    chip.className = 'atmo-chip';
    chip.setAttribute('for', id);
    chip.dataset.name = name;
    chip.append(checkbox, nameSpan);

    els.atmoContainer.append(chip);
  }
}

function readCheckedAtmospheres() {
  return Array.from(els.atmoContainer.querySelectorAll('.atmo-chip'))
    .filter((chip) => chip.querySelector('.atmo-checkbox')?.checked)
    .map((chip) => chip.dataset.name)
    .filter(Boolean);
}

els.generateBtn.addEventListener('click', onGenerate);
els.tasteGenerateBtn.addEventListener('click', onGenerateTasteProfile);
els.playlistGenerateBtn.addEventListener('click', onGeneratePlaylistDirections);
for (const b of els.playlistOptionSeg.querySelectorAll('button[data-opt]')) {
  b.addEventListener('click', () => selectPlaylistOption(b.dataset.opt));
}

function wireCopyButton(btn, getText) {
  btn.addEventListener('click', async () => {
    const text = getText() || '';
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'הועתק ✓';
      setTimeout(() => { btn.textContent = original; }, 1400);
    } catch {
      btn.textContent = 'לא הצליח להעתיק';
      setTimeout(() => { btn.textContent = original; }, 1800);
    }
  });
}

wireCopyButton(els.copyBtn,       () => els.promptEditor.value);
wireCopyButton(els.copyResultBtn, () => els.outputText.textContent);
wireCopyButton(els.copyTastePromptBtn, () => els.tastePromptEditor.value);
wireCopyButton(els.copyTasteResultBtn, () => els.tasteOutputText.textContent);
wireCopyButton(els.copyPlaylistPromptBtn, () => els.playlistEditors[playlistOption].value);
wireCopyButton(els.copyPlaylistResultBtn, () =>
  [els.playlistResultsTitle.textContent, els.playlistExplain.innerText, els.playlistOutputText.textContent].join('\n\n'));

function setStatus(text, kind) {
  setStatusOn(els.statusLine, text, kind);
}

function setTasteStatus(text, kind) {
  setStatusOn(els.tasteStatusLine, text, kind);
}

function setStatusOn(el, text, kind) {
  el.textContent = text || '';
  el.className = 'status-line' + (kind ? ' ' + kind : '');
}

// Format one direction as a text block. Same format is what the copy button
// puts on the clipboard. v7 directions carry no BPM, so the second line shows
// the two preferences the taste profile carries through instead.
function formatDirection(d) {
  const title = d.title_en || '(no title)';
  const genres = d.genres.length ? d.genres.join(', ') : '—';
  const desc = d.description_he || '';
  return [
    `#${d.rank}  ${title}`,
    `   Genres: ${genres}`,
    `   Instrumental: ${d.instrumentalness_preference || 'none'} · Popularity: ${d.popularity_preference || 'none'}`,
    `   ${desc}`,
  ].join('\n');
}

function formatDirections(directions) {
  if (!Array.isArray(directions) || !directions.length) return '(no directions returned)';
  return directions.map(formatDirection).join('\n\n');
}

// One deck's section of the step-1 result: its directions, the genres the
// code dropped for being on the wrong side, or the deck's error.
function formatDeck(r) {
  const head = `===== ${DECK_TITLES[r.deck]} =====`;
  if (r.error) return `${head}\n${r.error}${r.raw ? `\n\n${r.raw}` : ''}`;
  const lines = [head, formatDirections(r.directions)];
  if (r.dropped.length) lines.push(`\nDROPPED — not on this deck's side (${r.dropped.length}): ${r.dropped.join(', ')}`);
  return lines.join('\n');
}

function formatError(parsed) {
  return `ERROR: ${parsed?.error || 'unknown'}\nReasoning: ${parsed?.reasoning_en || '(none)'}`;
}

async function onGenerate() {
  const bizName        = els.bizName.value.trim();
  const bizDesc        = els.bizDesc.value.trim();
  const atmos          = readCheckedAtmospheres();
  const musicalEmphases = els.musicalEmphases.value.trim();
  const edited         = els.promptEditor.value;

  if (bizDesc.length < 4) {
    setStatus('תיאור העסק קצר מדי — הוסף לפחות כמה מילים', 'err');
    els.bizDesc.focus();
    return;
  }
  if (!edited.trim()) {
    setStatus('הפרומפט ריק — לחץ "אפס לברירת המחדל" או הדבק תוכן', 'err');
    return;
  }

  // A new step-1 run replaces the directions the swipe simulation refers to.
  r1Run = null;
  els.swipeCard.style.display = 'none';

  const originalBtnHtml = els.generateBtn.innerHTML;
  els.generateBtn.disabled = true;
  els.generateBtn.innerHTML = '<span class="sb-spinner"></span>';
  setStatus(`שולח ל־${PROVIDER}...`, '');

  try {
    // normalizeForProdAssembly strips leftover Places sentinels and renames
    // renamed Processing-Rules heading variants so prod's strict anchor-based
    // Places injection still fires. Ami's textarea is not modified; only the
    // version submitted to Gemini is normalized.
    const system = assembleDeckSystemPrompt(normalizeForProdAssembly(edited.trimEnd()));
    const inputs = { bizName, bizDesc, atmospheres: atmos, musicalEmphases };

    // One call per deck, in parallel (they don't depend on each other).
    // No caching: Ami's edits change the prompt every call.
    const runDeck = async (deck) => {
      const { text, usage, elapsed } = await callModel({
        system, userMessage: buildDeckUserMessage({ deck, ...inputs }),
        maxTokens: MAX_TOKENS, cache: false, label: 'ami-decks',
      });
      let parsed;
      try {
        parsed = parseJSONFromText(text);
      } catch (e) {
        return { deck, usage, elapsed, raw: text, error: `התגובה לא הייתה JSON תקין: ${e.message}` };
      }
      if (parsed?.error) return { deck, usage, elapsed, raw: formatError(parsed), error: `המודל החזיר שגיאה: ${parsed.error}` };
      const norm = normalizeDeckDirections(parsed, deck);
      if (!norm?.directions.length) return { deck, usage, elapsed, raw: text, error: 'לא חזרו כיוונים תקינים' };
      return {
        deck, usage, elapsed, ...norm,
        phrase: normalizeVenuePhrase(parsed.venue_phrase_he),
        category: parsed.venue_category,
      };
    };
    const results = await Promise.all(DECK_ORDER.map((deck) =>
      runDeck(deck).catch((err) => ({ deck, error: `שגיאה: ${err.message || 'לא ידוע'}` }))));

    // The phrase the onboarding's "הכל מוכן!" screen shows (2026-10-21) and the
    // category that picks the picture before each deck (2026-11-03) — from the
    // deck the owner sees first, as in production.
    const phrase = results.find((r) => r.phrase)?.phrase;
    const rawCategory = results.find((r) => r.category !== undefined)?.category;
    const category = normalizeVenueCategory(rawCategory);
    const categoryNote = rawCategory === category ? '' : ` (המודל החזיר ${JSON.stringify(rawCategory ?? null)} — ברירת המחדל)`;
    els.outputText.textContent = [
      `משפט העסק (מסך "הכל מוכן!"): ${phrase || '(לא הוחזר)'}`,
      `סוג העסק (קובע את התמונה לפני הכיוונים הרגועים ולפני האנרגטיים): ${CATEGORY_HE[category]}${categoryNote}`,
      ...results.map(formatDeck),
    ].join('\n\n');
    els.resultsCard.style.display = '';
    els.usageLine.textContent = results
      .map((r) => `${DECK_SHORT[r.deck]}: ${r.elapsed ? formatUsage(r.usage, r.elapsed) : '—'}`)
      .join('   |   ');
    els.resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const failed = results.filter((r) => r.error);
    if (failed.length) {
      setStatus(`נכשל: ${failed.map((r) => `הכיוונים ה${DECK_SHORT[r.deck]}`).join(' + ')} — אפשר להריץ שוב`, 'err');
      return;
    }
    const directions = results.flatMap((r) => r.directions);
    const slowest = Math.max(...results.map((r) => r.elapsed || 0));
    setStatus(`הוחזרו ${directions.length} כיוונים (${results.map((r) => r.directions.length).join(' + ')}) בזמן ${(slowest / 1000).toFixed(1)} שניות`, 'ok');
    r1Run = { directions, inputs };
    renderSwipeSimulation();
  } catch (err) {
    setStatus(`שגיאה: ${err.message || 'לא ידוע'}`, 'err');
  } finally {
    els.generateBtn.disabled  = false;
    els.generateBtn.innerHTML = originalBtnHtml;
  }
}

function formatUsage(usage, elapsed) {
  const base = `[${PROVIDER}]  elapsed ${(elapsed / 1000).toFixed(1)}s`;
  if (!usage) return base;
  if (PROVIDER === 'gemini') {
    return `${base} · input ${usage.input || 0} · output ${usage.output || 0}` +
      (usage.thinking ? ` · thinking ${usage.thinking}` : '');
  }
  return `${base} · input ${usage.input_tokens || 0} · output ${usage.output_tokens || 0}` +
    (usage.cache_read_input_tokens     ? ` · cache_read ${usage.cache_read_input_tokens}`     : '') +
    (usage.cache_creation_input_tokens ? ` · cache_write ${usage.cache_creation_input_tokens}` : '');
}

// ---------- Step 2: swipe simulation ----------

// Fresh directions → fresh decisions. Everything starts as "לא בשבילי" (a
// swipe left), and the carried preferences reset to what these directions
// say — the same first-non-none rule as carryPref in v7/app.js.
function renderSwipeSimulation() {
  decisions.clear();
  superLiked.clear();
  for (const d of r1Run.directions) decisions.set(d.rank, 'dislike');
  els.instPref.value = carriedPref(r1Run.directions, 'instrumentalness_preference');
  els.popPref.value  = carriedPref(r1Run.directions, 'popularity_preference');

  const parts = [];
  for (const deck of DECK_ORDER) {
    const title = document.createElement('div');
    title.className = 'swipe-deck-title';
    title.textContent = DECK_TITLES[deck];
    const note = document.createElement('div');
    note.className = 'swipe-deck-note';
    note.dataset.deck = deck;
    parts.push(title, note, ...r1Run.directions.filter((d) => d.deck === deck).map(buildSwipeRow));
  }
  els.swipeList.replaceChildren(...parts);
  updateRound2Field();
  els.swipeCard.style.display = '';
}

// Round 2 per deck (agreed 2026-11-02): a deck with fewer than
// ROUND2_MIN_LIKES liked directions gets extra cards of its own energy. The
// extra cards aren't simulated here; the Round 2 emphases textarea is open
// while any deck would get them. Outside that, the field is disabled and its
// text isn't sent; it's kept in the box so it comes back if Ami un-likes a
// direction.
function round2Decks() {
  return DECK_ORDER.filter((deck) =>
    r1Run.directions.filter((d) => d.deck === deck && decisions.get(d.rank) === 'like').length < ROUND2_MIN_LIKES);
}

function round2Open() {
  return round2Decks().length > 0;
}

function updateRound2Field() {
  const open = round2Decks();
  els.round2Emphases.disabled = !open.length;
  for (const note of els.swipeList.querySelectorAll('.swipe-deck-note')) {
    note.textContent = open.includes(note.dataset.deck)
      ? `פחות מ-${ROUND2_MIN_LIKES} כיוונים אהובים — בפרודקשן יוצגו כאן בסבב 2 עוד 4 כיוונים באותה אנרגיה (לא מדומה כאן).`
      : '';
  }
}

function carriedPref(directions, field) {
  const v = directions.map((d) => d[field]).find((x) => x && x !== 'none');
  return ['soft', 'hard'].includes(v) ? v : 'none';
}

function buildSwipeRow(d) {
  const row = document.createElement('div');
  row.className = 'swipe-row';

  const title = document.createElement('span');
  title.className = 'swipe-title';
  title.dir = 'ltr';
  title.textContent = `#${d.rank}  ${d.title_en || '(no title)'}`;

  const seg = document.createElement('div');
  seg.className = 'seg';
  const segButtons = [['like', 'אהבתי'], ['dislike', 'לא בשבילי']].map(([v, text]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = v;
    b.textContent = text;
    b.addEventListener('click', () => {
      decisions.set(d.rank, v);
      // A disliked direction can't hold super-likes (in onboarding a
      // super-like is itself a like).
      if (v === 'dislike') superLiked.delete(d.rank);
      paint();
      updateRound2Field();
    });
    return b;
  });
  seg.append(...segButtons);

  const head = document.createElement('div');
  head.className = 'swipe-head';
  head.append(title, seg);

  const desc = document.createElement('div');
  desc.className = 'swipe-desc';
  desc.textContent = d.description_he || '';

  const chips = document.createElement('div');
  chips.className = 'genre-chips';
  const chipButtons = d.genres.map((genre) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'genre-chip';
    c.dir = 'ltr';
    c.addEventListener('click', () => {
      const set = superLiked.get(d.rank) || new Set();
      if (set.has(genre)) set.delete(genre);
      else set.add(genre);
      superLiked.set(d.rank, set);
      if (set.size) decisions.set(d.rank, 'like');
      paint();
      updateRound2Field();
    });
    return { c, genre };
  });
  chips.append(...chipButtons.map(({ c }) => c));

  function paint() {
    const liked = decisions.get(d.rank) === 'like';
    row.classList.toggle('liked', liked);
    for (const b of segButtons) b.classList.toggle('on', b.dataset.v === decisions.get(d.rank));
    const set = superLiked.get(d.rank);
    for (const { c, genre } of chipButtons) {
      const on = !!set?.has(genre);
      c.classList.toggle('super', on);
      c.textContent = (on ? '⭐ ' : '') + genre;
    }
  }
  paint();

  row.append(head, desc, chips);
  return row;
}

// ---------- Step 3: taste profile ----------

async function onGenerateTasteProfile() {
  const edited = els.tastePromptEditor.value;
  if (!r1Run) {
    setTasteStatus('קודם צריך ליצור כיוונים בשלב 1 ולסמן מה אהבתם בשלב 2', 'err');
    return;
  }
  if (!edited.trim()) {
    setTasteStatus('הפרומפט ריק — הדביקו תוכן או רעננו את הדף כדי לטעון את ברירת המחדל', 'err');
    return;
  }

  // Step 4 always reflects the profile on screen — a new run clears it.
  tasteRun = null;
  hidePlaylistStep();

  const { directions, inputs } = r1Run;
  const likedDirections    = directions.filter((d) => decisions.get(d.rank) === 'like');
  const dislikedDirections = directions.filter((d) => decisions.get(d.rank) !== 'like');
  const superLikedOn = (deck) => [...new Set(directions.filter((d) => d.deck === deck)
    .flatMap((d) => [...(superLiked.get(d.rank) || [])]))];
  const superLikedByDeck = { energetic: superLikedOn('energetic'), calm: superLikedOn('calm') };
  // A super-like also marks its direction liked, so this covers both.
  const decksLiked = {
    energetic: likedDirections.some((d) => d.deck === 'energetic'),
    calm: likedDirections.some((d) => d.deck === 'calm'),
  };

  const userMessage = buildDeckTasteUserMessage({
    ...inputs,
    round2Emphases:             round2Open() ? els.round2Emphases.value.trim() : '',
    directions,
    likedDirections,
    dislikedDirections,
    superLikedByDeck,
    instrumentalnessPreference: els.instPref.value,
    popularityPreference:       els.popPref.value,
  });

  const originalBtnHtml = els.tasteGenerateBtn.innerHTML;
  els.tasteGenerateBtn.disabled = true;
  els.tasteGenerateBtn.innerHTML = '<span class="sb-spinner"></span>';
  setTasteStatus(`שולח ל־${PROVIDER}...`, '');

  try {
    const { text, usage, elapsed } = await callModel({
      system: assembleDeckTasteSystemPrompt(edited.trimEnd()),
      userMessage,
      maxTokens: MAX_TOKENS,
      cache: false,
      label: 'ami-taste-profile',
    });

    let parsed;
    try {
      parsed = parseJSONFromText(text);
    } catch (e) {
      renderTasteResult(text, usage, elapsed);
      setTasteStatus(`התגובה לא הייתה JSON תקין: ${e.message}`, 'err');
      return;
    }

    if (parsed?.error) {
      renderTasteResult(formatError(parsed), usage, elapsed);
      setTasteStatus(`המודל החזיר שגיאה: ${parsed.error}`, 'err');
      return;
    }

    const profile = normalizeDeckTasteProfile(parsed, { superLikedByDeck, decksLiked });
    if (!profile) {
      renderTasteResult(text, usage, elapsed);
      setTasteStatus('חסר energy_levels_total תקין בתגובה — מוצגת התגובה הגולמית', 'err');
      return;
    }

    const sides = decksLiked.energetic && decksLiked.calm;
    renderTasteResult(formatTasteProfile(profile, droppedGenres(parsed, profile), sides), usage, elapsed);
    setTasteStatus(
      `${profile.approved_genres.length} approved · ${profile.conditional_genres.length} conditional · ` +
      `${profile.excluded_genres.length} excluded — בזמן ${(elapsed / 1000).toFixed(1)} שניות`,
      'ok',
    );
    if (profile.approved_genres.length) {
      tasteRun = { profile, inputs };
      els.playlistCard.style.display = '';
    }
  } catch (err) {
    setTasteStatus(`שגיאה: ${err.message || 'לא ידוע'}`, 'err');
  } finally {
    els.tasteGenerateBtn.disabled  = false;
    els.tasteGenerateBtn.innerHTML = originalBtnHtml;
  }
}

// Genres the model listed that production would silently drop — names not
// verbatim in the genre universe, or entries without a usable energy_level.
// Shown so prompt edits that make the model invent names are visible.
function droppedGenres(parsed, profile) {
  const kept = new Set(
    [...profile.approved_genres, ...profile.conditional_genres].map((e) => e.genre.toLowerCase()),
  );
  const listed = [
    ...(Array.isArray(parsed.approved_genres) ? parsed.approved_genres : []),
    ...(Array.isArray(parsed.conditional_genres) ? parsed.conditional_genres : []),
  ].map((e) => e?.genre).filter((g) => typeof g === 'string');
  return [...new Set(listed.filter((g) => !kept.has(g.trim().toLowerCase())))];
}

// sides = both decks had likes: the scale's lower half is the calm side, the
// upper half the energetic side, and a both-ways genre may be listed twice.
function formatTasteProfile(profile, dropped, sides) {
  const N = profile.energy_levels_total;
  const top = calmTop(N);
  const levels = [];
  for (let lvl = N; lvl >= 1; lvl--) levels.push(lvl);
  const levelsOf = (list, g) => list.filter((e) => e.genre === g).map((e) => e.energy_level);
  // Genres with an entry in each half (↕).
  const twice = new Set([...profile.approved_genres, ...profile.conditional_genres].map((e) => e.genre).filter((g) => {
    const ls = [...levelsOf(profile.approved_genres, g), ...levelsOf(profile.conditional_genres, g)];
    return ls.some((l) => l <= top) && ls.some((l) => l > top);
  }));
  const mark = (g) => (sides && twice.has(g) ? `${g} ↕` : g);
  const sideHead = (lvl) => {
    if (!sides) return [];
    if (lvl === N) return [`  ENERGETIC SIDE — levels ${top + 1}–${N}`];
    if (lvl === top) return [`  CALM SIDE — levels 1–${top}`];
    return [];
  };

  const lines = [
    `Energy levels: ${N}   (level ${N} = highest energy for this owner, 1 = lowest)`,
    sides
      ? `Sides: calm = levels 1–${top}, energetic = levels ${top + 1}–${N}   (↕ = listed on both sides)`
      : 'Sides: OFF — one deck had no likes, so the genres are placed across the whole scale, once each',
    `Instrumental: ${profile.instrumentalness_preference} · Popularity: ${profile.popularity_preference}`,
    '',
    `APPROVED (${profile.approved_genres.length} entries · ${new Set(profile.approved_genres.map((e) => e.genre)).size} genres)`,
  ];
  for (const lvl of levels) {
    lines.push(...sideHead(lvl));
    const genres = profile.approved_genres.filter((e) => e.energy_level === lvl).map((e) => mark(e.genre));
    if (genres.length) lines.push(`    Level ${lvl}: ${genres.join(', ')}`);
  }

  // Requested genres (2026-10-05): super-liked + named in the emphases. Always
  // approved; at least one of each day's playlists plays each of them.
  const requested = profile.requested_genres || [];
  lines.push('', `נתבקשו מפורשות ע"י סופר לייק או בדגשים המוזיקליים של הלקוח (${requested.length})`,
    `  ${requested.map((g) => `${g} (Level ${levelsOf(profile.approved_genres, g).join('/') || '?'})`).join(', ') || '—'}`);

  lines.push('', `CONDITIONAL (${profile.conditional_genres.length})`);
  for (const lvl of levels) {
    const entries = profile.conditional_genres.filter((e) => e.energy_level === lvl);
    if (!entries.length) continue;
    lines.push(`  Level ${lvl}${sides ? (lvl > top ? ' (energetic)' : ' (calm)') : ''}:`);
    for (const e of entries) lines.push(`    ${mark(e.genre)}${e.note_en ? ' — ' + e.note_en : ''}`);
  }

  lines.push('', `EXCLUDED (${profile.excluded_genres.length})`, `  ${profile.excluded_genres.join(', ') || '—'}`);

  if (dropped.length) {
    lines.push('', `DROPPED — listed by the model but not usable (${dropped.length})`, `  ${dropped.join(', ')}`);
  }

  lines.push('', 'Reasoning:', profile.reasoning_en || '(none)');
  return lines.join('\n');
}

function renderTasteResult(text, usage, elapsed) {
  els.tasteOutputText.textContent = text;
  els.tasteResultsCard.style.display = '';
  els.tasteUsageLine.textContent = formatUsage(usage, elapsed);
  els.tasteResultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Step 4: daily playlist type → directions ----------

const PLAYLIST_TITLES = {
  option1: 'אפשרות 1 — הכיוונים לפי אנרגיה גבוהה / רגועה',
  option2: 'אפשרות 2 — הכיוונים לפי רמת אנרגיה',
};

// A new taste profile makes both options' results stale: clear them (the
// edited prompts stay) and hide the step until the new profile lands.
function hidePlaylistStep() {
  els.playlistCard.style.display = 'none';
  for (const st of Object.values(playlistState)) {
    st.result = null;
    st.status = ['', ''];
  }
  paintPlaylistStep();
}

function selectPlaylistOption(option) {
  playlistOption = option;
  paintPlaylistStep();
}

function setPlaylistStatus(option, text, kind = '') {
  playlistState[option].status = [text, kind];
  if (option === playlistOption) setStatusOn(els.playlistStatusLine, text, kind);
}

// Show the selected option's editor, button state, status line and last result.
function paintPlaylistStep() {
  const st = playlistState[playlistOption];
  for (const b of els.playlistOptionSeg.querySelectorAll('button[data-opt]')) {
    b.classList.toggle('on', b.dataset.opt === playlistOption);
  }
  for (const [opt, ed] of Object.entries(els.playlistEditors)) ed.style.display = opt === playlistOption ? '' : 'none';
  els.playlistGenerateBtn.disabled = st.busy;
  els.playlistGenerateBtn.innerHTML = st.busy ? '<span class="sb-spinner"></span>' : 'צור כיוונים ←';
  setStatusOn(els.playlistStatusLine, ...st.status);

  if (!st.result) {
    els.playlistResultsCard.style.display = 'none';
    return;
  }
  els.playlistResultsTitle.textContent = PLAYLIST_TITLES[playlistOption];
  els.playlistExplain.replaceChildren(...EXPLANATION_HE[playlistOption].map((t) => {
    const p = document.createElement('p');
    p.textContent = t;
    return p;
  }));
  els.playlistOutputText.textContent = st.result.text;
  els.playlistUsageLine.textContent = formatUsage(st.result.usage, st.result.elapsed);
  els.testPlaylistsHost.replaceChildren(...(st.result.testsEl ? [st.result.testsEl] : []));
  els.playlistResultsCard.style.display = '';
}

async function onGeneratePlaylistDirections() {
  const option = playlistOption;
  const st = playlistState[option];
  if (!tasteRun) {
    setPlaylistStatus(option, 'קודם צריך ליצור פרופיל טעם בשלב 3', 'err');
    return;
  }
  const editable = els.playlistEditors[option].value;
  if (!editable.trim()) {
    setPlaylistStatus(option, 'הפרומפט ריק — הדביקו תוכן או רעננו את הדף כדי לטעון את ברירת המחדל', 'err');
    return;
  }
  const run = tasteRun;           // a newer taste profile makes this result stale
  st.busy = true;
  setPlaylistStatus(option, `שולח ל־${PROVIDER}...`);
  paintPlaylistStep();

  try {
    const r = await generateForOption(option, {
      profile: run.profile,
      inputs: run.inputs,
      editable,
      label: option === 'option1' ? 'ami-energy-directions' : 'ami-level-directions',
    });
    if (run !== tasteRun) return;
    if (!r.ok) {
      if (r.rawText) st.result = { text: r.rawText, usage: r.usage, elapsed: r.elapsed };
      setPlaylistStatus(option, r.error, 'err');
      return;
    }
    const text = option === 'option1' ? formatOption1(run.profile, r) : formatOption2(run.profile, r);
    st.result = { text, usage: r.usage, elapsed: r.elapsed, directions: r.directions };
    if (option === 'option1') st.result.testsEl = renderTestPlaylists({ directions: r.directions, profile: run.profile });
    setPlaylistStatus(option, `הוחזרו ${r.directions.length} כיוונים בזמן ${(r.elapsed / 1000).toFixed(1)} שניות`, 'ok');
  } catch (err) {
    if (run === tasteRun) setPlaylistStatus(option, `שגיאה: ${err.message || 'לא ידוע'}`, 'err');
  } finally {
    st.busy = false;
    paintPlaylistStep();
    if (option === playlistOption && st.result && run === tasteRun) {
      els.playlistResultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}
