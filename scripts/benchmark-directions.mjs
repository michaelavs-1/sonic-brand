#!/usr/bin/env node
/**
 * Side-by-side speed + quality test of Anthropic vs OpenAI on the v6
 * musical-directions prompt.
 *
 * Reads the exact system prompt v6 uses (EDITABLE + FIXED sections from
 * v6/generation/musical-directions.js), fires both providers in parallel
 * with the same input, and prints timing + parsed output for each.
 *
 * Usage (PowerShell, from repo root):
 *   $env:OPENAI_API_KEY = "sk-..."
 *   $env:ANTHROPIC_KEY  = "sk-ant-..."   # or ANTHROPIC_API_KEY
 *   # Optional overrides:
 *   #   $env:OPENAI_MODEL    = "gpt-5-mini"      (default: gpt-5)
 *   #   $env:ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"  (default: claude-sonnet-4-6)
 *   #   $env:BIZ_DESC        = "..."
 *   #   $env:ATMOSPHERES     = "אלגנטי,קליל"     (comma-separated)
 *   node scripts/benchmark-directions.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  EDITABLE_PROMPT_SECTION,
  FIXED_PROMPT_SECTION,
} from '../v6/generation/musical-directions.js';

// --out=path.json → save the full result (config + raw responses + parsed
// output + timing) to a JSON file. Console output is unchanged.
const OUT_PATH = (() => {
  const arg = process.argv.find((a) => a.startsWith('--out='));
  return arg ? arg.slice('--out='.length) : null;
})();

const SYSTEM_PROMPT = EDITABLE_PROMPT_SECTION + '\n\n' + FIXED_PROMPT_SECTION;

const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;

const OPENAI_MODEL    = process.env.OPENAI_MODEL    || 'gpt-5';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const BIZ_DESC    = process.env.BIZ_DESC    || 'בר יין שכונתי בלב תל אביב';
const ATMOSPHERES = (process.env.ATMOSPHERES || 'אלגנטי,קליל')
  .split(',').map((s) => s.trim()).filter(Boolean);

const USER_MESSAGE =
  `Description: ${BIZ_DESC}\n` +
  `Business name: none\n` +
  `Atmospheres: ${ATMOSPHERES.join(', ')}\n\n` +
  `TASK VARIANT: Return only the top 4 directions — the strongest, safest fits for this business. ` +
  `Follow the same schema, but with exactly 4 items in "directions" instead of 8.`;

const MAX_OUTPUT = 4000;

function nowMs() { return Date.now(); }

function isGpt5Family(model) {
  // GPT-5 family and newer use `max_completion_tokens` and don't accept
  // `temperature: <non-default>`. Keep in sync with Michael's proxy behaviour.
  return /^gpt-(5|o1|o3)/i.test(model);
}

async function callOpenAI() {
  const t0 = nowMs();
  const body = {
    model:           OPENAI_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: USER_MESSAGE },
    ],
  };
  if (isGpt5Family(OPENAI_MODEL)) {
    body.max_completion_tokens = MAX_OUTPUT;
  } else {
    body.max_tokens  = MAX_OUTPUT;
    body.temperature = 0.7;
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const elapsed = nowMs() - t0;
  const data = await r.json().catch(() => ({}));
  return { elapsed, status: r.status, data };
}

async function callAnthropic() {
  const t0 = nowMs();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT,
      // Match production: cache_control on the system prompt.
      system: [
        {
          type:          'text',
          text:          SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: USER_MESSAGE },
      ],
    }),
  });
  const elapsed = nowMs() - t0;
  const data = await r.json().catch(() => ({}));
  return { elapsed, status: r.status, data };
}

function extractText(data, provider) {
  if (provider === 'openai')    return data?.choices?.[0]?.message?.content || '';
  if (provider === 'anthropic') return data?.content?.[0]?.text || '';
  return '';
}

function tryParseJson(text) {
  const trimmed = String(text || '').trim();
  const fenced  = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  try { return JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { return null; }
}

function usageSummary(provider, data) {
  if (provider === 'openai') {
    const u = data?.usage || {};
    return `tokens: in=${u.prompt_tokens ?? '?'}, out=${u.completion_tokens ?? '?'}, total=${u.total_tokens ?? '?'}`;
  }
  const u = data?.usage || {};
  const cacheRead   = u.cache_read_input_tokens   ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const cacheNote = (cacheRead || cacheCreate)
    ? `, cache_read=${cacheRead}, cache_create=${cacheCreate}`
    : '';
  return `tokens: in=${u.input_tokens ?? '?'}, out=${u.output_tokens ?? '?'}${cacheNote}`;
}

function printResult(label, r, provider) {
  console.log(`\n=== ${label} ===`);
  console.log(`Status:  ${r.status}`);
  console.log(`Elapsed: ${r.elapsed} ms`);
  console.log(`Usage:   ${usageSummary(provider, r.data)}`);
  if (r.status !== 200) {
    console.log('Error body:');
    console.log(JSON.stringify(r.data, null, 2).slice(0, 2000));
    return;
  }
  const text = extractText(r.data, provider);
  const json = tryParseJson(text);
  if (json) {
    console.log('Parsed JSON:');
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log('Raw text (JSON parse failed):');
    console.log(text.slice(0, 4000));
  }
}

async function main() {
  if (!OPENAI_KEY)    { console.error('Missing OPENAI_API_KEY');    process.exit(1); }
  if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_KEY (or ANTHROPIC_API_KEY)'); process.exit(1); }

  console.log('==============================================');
  console.log('Musical Directions — OpenAI vs Anthropic');
  console.log('==============================================');
  console.log(`Business:    ${BIZ_DESC}`);
  console.log(`Atmospheres: ${ATMOSPHERES.join(', ')}`);
  console.log(`OpenAI:      ${OPENAI_MODEL}`);
  console.log(`Anthropic:   ${ANTHROPIC_MODEL}`);
  console.log(`Prompt:      ${SYSTEM_PROMPT.length} chars (~${Math.round(SYSTEM_PROMPT.length / 4)} tokens)`);
  console.log('----------------------------------------------');
  console.log('Firing both in parallel...\n');

  const [openai, anthropic] = await Promise.all([
    callOpenAI().catch((e) => ({ elapsed: -1, status: 0, data: { error: e.message } })),
    callAnthropic().catch((e) => ({ elapsed: -1, status: 0, data: { error: e.message } })),
  ]);

  printResult('OpenAI',    openai,    'openai');
  printResult('Anthropic', anthropic, 'anthropic');

  console.log('\n=== Timing summary ===');
  console.log(`OpenAI:    ${openai.elapsed} ms`);
  console.log(`Anthropic: ${anthropic.elapsed} ms`);
  if (openai.elapsed > 0 && anthropic.elapsed > 0) {
    const diff = Math.abs(openai.elapsed - anthropic.elapsed);
    const winner = openai.elapsed < anthropic.elapsed ? 'OpenAI' : 'Anthropic';
    const pct = Math.round((diff / Math.max(openai.elapsed, anthropic.elapsed)) * 100);
    console.log(`${winner} was faster by ${diff} ms (${pct}%).`);
  }
  console.log('\nNote: first run pays cold-start penalties on both sides.');
  console.log('Run twice back-to-back for a warmer comparison.');

  if (OUT_PATH) {
    const record = {
      timestamp: new Date().toISOString(),
      config: {
        bizDesc:        BIZ_DESC,
        atmospheres:    ATMOSPHERES,
        openaiModel:    OPENAI_MODEL,
        anthropicModel: ANTHROPIC_MODEL,
        systemPromptChars: SYSTEM_PROMPT.length,
      },
      openai: {
        elapsed_ms: openai.elapsed,
        status:     openai.status,
        usage:      openai.data?.usage || null,
        text:       extractText(openai.data, 'openai'),
        parsed:     tryParseJson(extractText(openai.data, 'openai')),
        error:      openai.data?.error || null,
      },
      anthropic: {
        elapsed_ms: anthropic.elapsed,
        status:     anthropic.status,
        usage:      anthropic.data?.usage || null,
        text:       extractText(anthropic.data, 'anthropic'),
        parsed:     tryParseJson(extractText(anthropic.data, 'anthropic')),
        error:      anthropic.data?.error || null,
      },
    };
    await mkdir(dirname(OUT_PATH), { recursive: true }).catch(() => {});
    await writeFile(OUT_PATH, JSON.stringify(record, null, 2), 'utf8');
    console.log(`\nSaved to ${OUT_PATH}`);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
