#!/usr/bin/env node
// Compare the genres in the current EDITABLE_PROMPT_SECTION against the
// distinct genres present in playlist_genres. Reports which genres from the
// prompt are missing from the DB (would silently return zero tracks).
//
// Run: node --env-file=.env.local scripts/check-prompt-genres.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY.');
  process.exit(1);
}

async function fetchAllGenres() {
  // Paginate. PostgREST default page size is 1000; use Range headers for more.
  const seen = new Set();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/playlist_genres?select=genre&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) {
      console.error(`Supabase ${r.status}:`, await r.text());
      process.exit(1);
    }
    const rows = await r.json();
    if (!rows.length) break;
    for (const row of rows) if (row.genre) seen.add(row.genre);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return seen;
}

function extractPromptGenres() {
  return readFile(resolve(REPO_ROOT, 'v6/generation/musical-directions.js'), 'utf8')
    .then((src) => {
      // Grab the genre-list paragraph AFTER the "## Genre Universe" heading —
      // not the JS comment above the export that also mentions "Heavy Rock+Metal".
      const afterHeading = src.split(/^## Genre Universe\s*$/m)[1];
      if (!afterHeading) throw new Error('Could not find "## Genre Universe" heading in prompt');
      // The genre list is the first non-empty paragraph that starts with "Heavy Rock+Metal".
      const match = afterHeading.match(/(Heavy Rock\+Metal[^\n]*)/);
      if (!match) throw new Error('Could not find genre list after heading');
      return match[1].trim().split(',').map((g) => g.trim()).filter(Boolean);
    });
}

const [dbGenres, promptGenres] = await Promise.all([fetchAllGenres(), extractPromptGenres()]);

const dbLower = new Set([...dbGenres].map((g) => g.toLowerCase()));

console.log(`Genres in playlist_genres:  ${dbGenres.size}`);
console.log(`Genres in current prompt:   ${promptGenres.length}\n`);

const missing = promptGenres.filter((g) => !dbLower.has(g.toLowerCase()));
const present = promptGenres.filter((g) =>  dbLower.has(g.toLowerCase()));

console.log(`=== prompt genres MISSING from DB (${missing.length}) ===`);
if (missing.length) {
  missing.forEach((g) => console.log(`  ✗ ${g}`));
} else {
  console.log('  (none — every prompt genre is in the DB)');
}

console.log(`\n=== prompt genres present in DB (${present.length}) ===`);
present.forEach((g) => console.log(`  ✓ ${g}`));

// Also flag DB genres NOT in the prompt — these are unreachable via
// the AI's picks, informational only.
const promptLower = new Set(promptGenres.map((g) => g.toLowerCase()));
const orphaned = [...dbGenres].filter((g) => !promptLower.has(g.toLowerCase())).sort();
console.log(`\n=== DB genres NOT in prompt (${orphaned.length}) — unreachable via AI picks ===`);
if (orphaned.length) {
  orphaned.forEach((g) => console.log(`  ~ ${g}`));
} else {
  console.log('  (none)');
}
