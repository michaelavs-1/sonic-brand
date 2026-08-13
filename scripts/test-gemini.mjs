#!/usr/bin/env node
// Basic wiring test for the Gemini integration.
//
// Verifies:
//   1. GEMINI_API_KEY is valid and Gemini returns JSON when asked.
//   2. Full production musical-directions system prompt works (page 1).
//   3. Same prompt with page-2 variant works (references page 1 output).
//   4. Repeated call shows implicit prompt-cache activity.
//
// Extracts EDITABLE + FIXED prompt sections from the source file via regex
// (they're template literals) rather than importing musical-directions.js —
// that module uses browser-only import paths that don't resolve in Node.
//
// Run:
//   node --env-file=.env.local scripts/test-gemini.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('GEMINI_API_KEY missing — run with: node --env-file=.env.local scripts/test-gemini.mjs');
  process.exit(1);
}

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low'; // low|medium|high
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function loadProductionPrompt() {
  const src = await readFile(resolve(REPO_ROOT, 'v6/generation/musical-directions.js'), 'utf8');
  const editMatch  = src.match(/export const EDITABLE_PROMPT_SECTION = `([\s\S]*?)`;/);
  const fixedMatch = src.match(/export const FIXED_PROMPT_SECTION = `([\s\S]*?)`;/);
  if (!editMatch || !fixedMatch) throw new Error('Could not extract prompt sections from source');
  return editMatch[1] + '\n\n' + fixedMatch[1];
}

async function callGemini({ system, user, maxTokens = 4096, thinkingLevel = THINKING_LEVEL }) {
  const t0 = Date.now();
  const payload = {
    contents:          [{ role: 'user', parts: [{ text: user }] }],
    generationConfig:  {
      maxOutputTokens:  maxTokens,
      responseMimeType: 'application/json',
      thinkingConfig:   { thinkingLevel },
    },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(GEMINI_URL, {
    method:  'POST',
    headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const elapsed = Date.now() - t0;
  const data = await r.json();
  return { status: r.status, elapsed, data };
}

function directionGenres(d) {
  if (Array.isArray(d.genres) && d.genres.length) return d.genres;
  return [d.anchor_genre, ...(Array.isArray(d.secondary_genres) ? d.secondary_genres : [])]
    .filter((g) => typeof g === 'string' && g.length);
}

function summarizeDirection(d, idx) {
  const genres = directionGenres(d);
  return `${idx + 1}. "${d.title_en}" — ${genres.join(', ')}`;
}

function validateDirection(d) {
  const errs = [];
  if (typeof d.title_en !== 'string' || !d.title_en.length)             errs.push('title_en');
  if (typeof d.description_he !== 'string' || !d.description_he.length) errs.push('description_he');
  if (!directionGenres(d).length)                                       errs.push('genres (or legacy anchor_genre)');
  const bpm = d.bpm_range;
  if (!bpm || !Number.isFinite(bpm.min) || !Number.isFinite(bpm.max))   errs.push('bpm_range');
  return errs;
}

function extractText(data) {
  const cand = data?.candidates?.[0];
  return {
    text:         cand?.content?.parts?.find(p => typeof p?.text === 'string')?.text,
    finishReason: cand?.finishReason,
  };
}

function reportUsage(data) {
  const u = data?.usageMetadata;
  if (!u) return;
  console.log(`   tokens: input=${u.promptTokenCount} output=${u.candidatesTokenCount} thoughts=${u.thoughtsTokenCount || 0} total=${u.totalTokenCount}`);
  console.log(`   cachedContentTokenCount: ${u.cachedContentTokenCount || 0}${u.cachedContentTokenCount ? '  <- CACHE HIT' : ''}`);
}

function reportDirections(parsed) {
  if (!Array.isArray(parsed?.directions)) {
    console.log(`   UNEXPECTED SHAPE: ${JSON.stringify(parsed).slice(0, 200)}`);
    return { valid: false };
  }
  console.log(`   directions: ${parsed.directions.length}`);
  let allValid = true;
  parsed.directions.forEach((d, i) => {
    const errs = validateDirection(d);
    if (errs.length) {
      allValid = false;
      console.log(`     #${i+1} INVALID (missing/bad: ${errs.join(', ')})`);
      console.log(`         raw: ${JSON.stringify(d).slice(0, 200)}`);
    } else {
      console.log(`     ${summarizeDirection(d, i)}`);
      console.log(`        desc: ${d.description_he}`);
      console.log(`        bpm:  ${d.bpm_range.min}-${d.bpm_range.max}`);
    }
  });
  return { valid: allValid, parsed };
}

// ---- test 1: minimal ping ------------------------------------------------
console.log('=== test 1: minimal ping (verify API key + JSON output) ===');
{
  const { status, elapsed, data } = await callGemini({
    system: null,
    user:   'Return this JSON exactly and nothing else: {"ok": true, "greeting": "shalom"}',
    maxTokens: 2000,
  });
  console.log(`   status=${status}  elapsed=${elapsed}ms`);
  if (status !== 200) {
    console.log('   ERROR:', JSON.stringify(data, null, 2));
    process.exit(1);
  }
  reportUsage(data);
  const { text, finishReason } = extractText(data);
  console.log(`   finishReason: ${finishReason}`);
  console.log(`   text: ${text}`);
  try {
    const parsed = JSON.parse(text);
    console.log(`   parsed: ${JSON.stringify(parsed)}  ${parsed.ok ? 'OK' : 'unexpected shape'}`);
  } catch (e) {
    console.log(`   JSON parse FAILED: ${e.message}`);
    process.exit(1);
  }
}

// ---- tests 2/3/4: production prompt --------------------------------------
const SYSTEM_PROMPT = await loadProductionPrompt();
console.log(`\nSYSTEM_PROMPT length: ${SYSTEM_PROMPT.length} chars (~${Math.round(SYSTEM_PROMPT.length / 4)} tokens estimated)`);

const BIZ_DESC = 'בר יין שכונתי בלב תל אביב';
const ATMOS    = ['אלגנטי', 'קליל'];
const baseUser =
  `Description: ${BIZ_DESC}\n` +
  `Business name: none\n` +
  `Atmospheres: ${ATMOS.join(', ')}`;

const page1User = baseUser +
  `\n\nTASK VARIANT: Return only the top 4 directions — the strongest, safest fits for this business. ` +
  `Follow the same schema, but with exactly 4 items in "directions" instead of 8.`;

console.log('\n=== test 2: page 1 (subset=top) ===');
let page1Parsed = null;
{
  const { status, elapsed, data } = await callGemini({ system: SYSTEM_PROMPT, user: page1User });
  console.log(`   status=${status}  elapsed=${elapsed}ms`);
  if (status !== 200) {
    console.log('   ERROR:', JSON.stringify(data, null, 2));
    process.exit(1);
  }
  reportUsage(data);
  const { text, finishReason } = extractText(data);
  console.log(`   finishReason: ${finishReason}`);
  try {
    const parsed = JSON.parse(text);
    if (parsed.error) {
      console.log(`   MODEL RETURNED ERROR: ${parsed.error} — ${parsed.reasoning_en || '(no reason)'}`);
    } else {
      const r = reportDirections(parsed);
      if (r.valid) page1Parsed = parsed;
    }
  } catch (e) {
    console.log(`   JSON parse FAILED: ${e.message}`);
    console.log(`   raw text head: ${(text || '').slice(0, 300)}`);
  }
}

// ---- test 3: page 2 referencing page 1's output --------------------------
if (page1Parsed) {
  console.log('\n=== test 3: page 2 (subset=next, references page 1 output) ===');
  const priorSummary = page1Parsed.directions.map(summarizeDirection).join('\n');
  const page2User = baseUser +
    `\n\nALREADY CHOSEN — do not duplicate these 4 directions:\n${priorSummary}` +
    `\n\nTASK VARIANT: Return 4 additional directions that meaningfully broaden the range beyond the 4 above. ` +
    `Use different genre combinations and different sonic territories. They should complement, not overlap. ` +
    `Follow the same schema, but with exactly 4 items in "directions" instead of 8.`;
  const { status, elapsed, data } = await callGemini({ system: SYSTEM_PROMPT, user: page2User });
  console.log(`   status=${status}  elapsed=${elapsed}ms`);
  if (status !== 200) {
    console.log('   ERROR:', JSON.stringify(data, null, 2));
  } else {
    reportUsage(data);
    const { text, finishReason } = extractText(data);
    console.log(`   finishReason: ${finishReason}`);
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) {
        console.log(`   MODEL RETURNED ERROR: ${parsed.error} — ${parsed.reasoning_en || '(no reason)'}`);
      } else {
        reportDirections(parsed);
        console.log('\n   pair-overlap check (spec: no two directions share >1 genre):');
        const allDirs = [...(page1Parsed.directions || []), ...(parsed.directions || [])];
        let maxOverlap = 0;
        let worstPair = null;
        for (let i = 0; i < allDirs.length; i++) {
          for (let j = i + 1; j < allDirs.length; j++) {
            const gi = new Set(directionGenres(allDirs[i]).map(g => g.toLowerCase()));
            const gj = directionGenres(allDirs[j]).map(g => g.toLowerCase());
            const shared = gj.filter(g => gi.has(g));
            if (shared.length > maxOverlap) {
              maxOverlap = shared.length;
              worstPair = { i, j, shared };
            }
          }
        }
        console.log(`     max shared-genre count between any two directions: ${maxOverlap} ${maxOverlap <= 1 ? 'OK' : '<- WARNING (spec says <=1)'}`);
        if (maxOverlap > 1 && worstPair) {
          console.log(`     worst: "${allDirs[worstPair.i].title_en}" vs "${allDirs[worstPair.j].title_en}" → shared: ${worstPair.shared.join(', ')}`);
        }
      }
    } catch (e) {
      console.log(`   JSON parse FAILED: ${e.message}`);
    }
  }
}

// ---- test 4: repeat page 1 to check for implicit cache activity ----------
console.log('\n=== test 4: repeat page 1 immediately — expect cachedContentTokenCount > 0 ===');
{
  const { status, elapsed, data } = await callGemini({ system: SYSTEM_PROMPT, user: page1User });
  console.log(`   status=${status}  elapsed=${elapsed}ms`);
  reportUsage(data);
  if (!data?.usageMetadata?.cachedContentTokenCount) {
    console.log('   NOTE: no cached tokens reported. Implicit caching is LRU on Google\'s side —');
    console.log('   may take multiple identical calls or higher volume before it activates.');
  }
}

console.log('\n=== done ===');
