// v5 Ami prompt dashboard.
// Lets Ami tweak the editable half of the musical-directions system prompt,
// fire one model call against real business inputs, and see the returned
// directions in a readable text block with a copy button.
//
// Which model runs (Anthropic vs Gemini) is controlled by v6/generation/ai-provider.js.
// One switch there governs both this dashboard and the v6 production flow.
//
// Flow:
//   1. Import EDITABLE_PROMPT_SECTION + FIXED_PROMPT_SECTION from the
//      musical-directions module (single source of truth).
//   2. Pre-fill the textarea with EDITABLE_PROMPT_SECTION.
//   3. On generate: assemble system = editedEditable + '\n\n' + FIXED,
//      user message = business inputs, call the shared ai-provider.
//   4. Parse response JSON, format each direction as text, display.
//   5. Copy button dumps the formatted text to clipboard.

import {
  EDITABLE_PROMPT_SECTION,
  assembleSystemPrompt,
} from '/v5/generation/musical-directions.js?v=29082026a';
import { derivePopularityWindow } from '/v5/generation/popularity-window.js?v=29072026e';
import { callModel, parseJSONFromText, PROVIDER } from '/v6/generation/ai-provider.js?v=04082026a';

// Match v6 production. Gemini 3.6-flash's hard output-token cap is 65536;
// values above that are silently clamped by Google. Under thinkingLevel
// 'high' the model burns a big chunk of the budget on thinking tokens, so
// a smaller cap here truncates the visible JSON mid-object (parse error
// "Expected double-quoted property name"). Only failing calls are
// affected — you only pay for tokens actually generated.
const MAX_TOKENS = 65536;

const $ = (id) => document.getElementById(id);

const els = {
  bizName:          $('bizName'),
  bizDesc:          $('bizDesc'),
  atmoContainer:    $('atmoContainer'),
  popWindowLine:    $('popWindowLine'),
  musicalEmphases:  $('musicalEmphases'),
  promptEditor:     $('promptEditor'),
  generateBtn:      $('generateBtn'),
  statusLine:       $('statusLine'),
  resultsCard:      $('resultsCard'),
  usageLine:        $('usageLine'),
  outputText:       $('outputText'),
  copyBtn:          $('copyBtn'),
  copyResultBtn:    $('copyResultBtn'),
};

// Full atmosphere rows fetched from /api/v5/databox-atmospheres, kept at
// module scope so the popularity-window computation can look up ranges by
// name whenever a checkbox toggles.
let atmosphereRows = [];

// Pre-fill the editor with the current default.
els.promptEditor.value = EDITABLE_PROMPT_SECTION;

// Load atmosphere checkboxes. `?fresh=1` bypasses the endpoint's 30-min
// in-memory cache so every hard-refresh pulls the latest from Supabase.
(async () => {
  try {
    const r = await fetch('/api/v5/databox-atmospheres?fresh=1');
    if (!r.ok) throw new Error(`databox-atmospheres ${r.status}`);
    const { rows } = await r.json();
    atmosphereRows = Array.isArray(rows) ? rows : [];
    renderAtmosphereCheckboxes(atmosphereRows);
    updatePopWindow();
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
    checkbox.addEventListener('change', updatePopWindow);

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

function updatePopWindow() {
  const checked = readCheckedAtmospheres();
  const window = derivePopularityWindow(checked, atmosphereRows);
  if (window) {
    els.popWindowLine.textContent = `Popularity window: ${window[0]} – ${window[1]}`;
    els.popWindowLine.classList.add('active');
  } else {
    els.popWindowLine.textContent = 'Popularity window: — (no atmosphere selected — no filter applied)';
    els.popWindowLine.classList.remove('active');
  }
}

function readCheckedAtmospheres() {
  return Array.from(els.atmoContainer.querySelectorAll('.atmo-chip'))
    .filter((chip) => chip.querySelector('.atmo-checkbox')?.checked)
    .map((chip) => chip.dataset.name)
    .filter(Boolean);
}

els.generateBtn.addEventListener('click', onGenerate);

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

function setStatus(text, kind) {
  els.statusLine.textContent = text || '';
  els.statusLine.className = 'status-line' + (kind ? ' ' + kind : '');
}

function buildUserMessage({ bizName, bizDesc, atmospheres, musicalEmphases }) {
  const nameLine = (bizName && String(bizName).trim()) ? String(bizName).trim() : 'none';
  const atmLine  = Array.isArray(atmospheres) && atmospheres.length ? atmospheres.join(', ') : 'none';
  let msg = `Description: ${bizDesc}\nBusiness name: ${nameLine}\nAtmospheres: ${atmLine}`;
  if (typeof musicalEmphases === 'string' && musicalEmphases.trim().length) {
    msg += `\nMusical emphases: ${musicalEmphases.trim()}`;
  }
  return msg;
}

// Format one direction as a text block. Same format is what the copy button
// puts on the clipboard.
function formatDirection(d, idx) {
  const rank = Number(d.rank) || (idx + 1);
  const title = d.title_en || '(no title)';
  // New schema is a flat `genres` list; older responses may still return
  // anchor + secondaries — fold both into one line if that happens.
  const genresList = Array.isArray(d.genres) && d.genres.length
    ? d.genres
    : [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])].filter(Boolean);
  const genres = genresList.length ? genresList.join(', ') : '—';
  const bpm = d.bpm_range && Number.isFinite(d.bpm_range.min) && Number.isFinite(d.bpm_range.max)
    ? `${d.bpm_range.min}-${d.bpm_range.max}`
    : '—';
  const desc = d.description_he || '';
  return [
    `#${rank}  ${title}`,
    `   Genres: ${genres}`,
    `   BPM:    ${bpm}`,
    `   ${desc}`,
  ].join('\n');
}

function formatDirections(directions) {
  if (!Array.isArray(directions) || !directions.length) return '(no directions returned)';
  return directions.map(formatDirection).join('\n\n');
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

  const originalBtnHtml = els.generateBtn.innerHTML;
  els.generateBtn.disabled = true;
  els.generateBtn.innerHTML = '<span class="sb-spinner"></span>';
  setStatus(`שולח ל־${PROVIDER}...`, '');

  try {
    // Substitutes {{PLACES_*}} sentinels in Ami's edited text with the
    // real Google Places docs, then concatenates FIXED_PROMPT_SECTION.
    const system      = assembleSystemPrompt(edited.trimEnd());
    const userMessage = buildUserMessage({ bizName, bizDesc, atmospheres: atmos, musicalEmphases });

    // No caching: Ami's edits change the prompt every call, so Anthropic
    // caching would just add write premium with no hit. No-op on Gemini.
    const { text, usage, elapsed } = await callModel({
      system, userMessage, maxTokens: MAX_TOKENS, cache: false, label: 'ami',
    });

    let parsed;
    try {
      parsed = parseJSONFromText(text);
    } catch (e) {
      // Show raw text if JSON parse fails so Ami can see what came back.
      renderResult(text, usage, elapsed);
      setStatus(`התגובה לא הייתה JSON תקין: ${e.message}`, 'err');
      return;
    }

    if (parsed?.error) {
      renderResult(formatError(parsed), usage, elapsed);
      setStatus(`המודל החזיר שגיאה: ${parsed.error}`, 'err');
      return;
    }

    const formatted = formatDirections(parsed.directions);
    renderResult(formatted, usage, elapsed);
    setStatus(`הוחזרו ${parsed?.directions?.length || 0} כיוונים בזמן ${(elapsed / 1000).toFixed(1)} שניות`, 'ok');
  } catch (err) {
    setStatus(`שגיאה: ${err.message || 'לא ידוע'}`, 'err');
  } finally {
    els.generateBtn.disabled  = false;
    els.generateBtn.innerHTML = originalBtnHtml;
  }
}

function renderResult(text, usage, elapsed) {
  els.outputText.textContent = text;
  els.resultsCard.style.display = '';
  const base = `[${PROVIDER}]  elapsed ${(elapsed / 1000).toFixed(1)}s`;
  if (!usage) {
    els.usageLine.textContent = base;
  } else if (PROVIDER === 'gemini') {
    els.usageLine.textContent =
      `${base} · input ${usage.input || 0} · output ${usage.output || 0}` +
      (usage.thinking ? ` · thinking ${usage.thinking}` : '');
  } else {
    els.usageLine.textContent =
      `${base} · input ${usage.input_tokens || 0} · output ${usage.output_tokens || 0}` +
      (usage.cache_read_input_tokens     ? ` · cache_read ${usage.cache_read_input_tokens}`     : '') +
      (usage.cache_creation_input_tokens ? ` · cache_write ${usage.cache_creation_input_tokens}` : '');
  }
  els.resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
