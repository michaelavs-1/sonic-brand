// Diagnostic script — exercises track-analysis in two ways:
//
//   PART A: direct call to RapidAPI (bypasses our proxy and vercel dev).
//           Confirms the API key works and the API is reachable.
//           Pass your key as the first CLI arg or via env var.
//
//   PART B: call through /api/new/track-analysis on localhost:3000.
//           Confirms vercel dev is reading .env.local and our proxy is wired right.
//
// Usage (PowerShell):
//   node .test-track-analysis-diagnose.mjs PASTE_YOUR_KEY_HERE
//
// Or set env first then run:
//   $env:TRACK_ANALYSIS_RAPIDAPI_KEY = "your_key"
//   node .test-track-analysis-diagnose.mjs

const SPOTIFY_ID = '3z8h0TU7ReDPLIbEnYhWZb';  // Welcome to the Jungle — Guns N' Roses
const HOST       = 'track-analysis.p.rapidapi.com';
const DEV_BASE   = 'http://localhost:3000';

const key = process.argv[2] || process.env.TRACK_ANALYSIS_RAPIDAPI_KEY;

if (!key) {
  console.error('No key provided. Pass as CLI arg or set $env:TRACK_ANALYSIS_RAPIDAPI_KEY first.');
  process.exit(1);
}

console.log(`key length: ${key.length}, starts with: "${key.slice(0, 8)}...", ends with: "...${key.slice(-4)}"`);
if (/\s/.test(key)) console.warn('!! key contains whitespace — that may be the problem');
if (key.startsWith('"') || key.startsWith("'")) console.warn('!! key starts with a quote — remove quotes from .env.local');

// ---------- PART A: direct to RapidAPI ----------
console.log('\n=== PART A: direct call to RapidAPI ===');
console.log(`URL: https://${HOST}/pktx/spotify/${SPOTIFY_ID}`);
const tA0 = Date.now();
try {
  const r = await fetch(`https://${HOST}/pktx/spotify/${SPOTIFY_ID}`, {
    method: 'GET',
    headers: {
      'x-rapidapi-key':  key,
      'x-rapidapi-host': HOST,
    },
  });
  const ms = Date.now() - tA0;
  console.log(`status: ${r.status} ${r.statusText}  (${ms}ms)`);
  console.log(`headers.content-type: ${r.headers.get('content-type')}`);
  const text = await r.text();
  console.log(`raw body:\n${text}`);
  if (r.ok) {
    try {
      const data = JSON.parse(text);
      console.log(`\nparsed energy field: ${data.energy} (type: ${typeof data.energy})`);
      console.log(`parsed tempo field:  ${data.tempo}  (type: ${typeof data.tempo})`);
      console.log(`parsed name field:   ${data.name}`);
    } catch (e) {
      console.log(`(could not parse body as JSON: ${e.message})`);
    }
  }
} catch (err) {
  console.error(`fetch threw: ${err.message}`);
}

// ---------- PART B: through our proxy ----------
console.log('\n=== PART B: through /api/new/track-analysis on localhost:3000 ===');
const tB0 = Date.now();
try {
  const r = await fetch(`${DEV_BASE}/api/new/track-analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'analyze_track', spotify_id: SPOTIFY_ID }),
  });
  const ms = Date.now() - tB0;
  console.log(`status: ${r.status} ${r.statusText}  (${ms}ms)`);
  const text = await r.text();
  console.log(`raw body:\n${text}`);
  if (r.ok) {
    try {
      const data = JSON.parse(text);
      console.log(`\nparsed found field:  ${data.found}`);
      console.log(`parsed energy field: ${data.energy} (type: ${typeof data.energy})`);
    } catch (e) {
      console.log(`(could not parse body as JSON: ${e.message})`);
    }
  }
} catch (err) {
  console.error(`fetch threw (is vercel dev running on localhost:3000?): ${err.message}`);
}

console.log('\n=== diagnosis ===');
console.log('Part A success + Part B success → everything is good; bug is in our client code.');
console.log('Part A success + Part B failure → vercel dev is not loading .env.local. Check the file location and restart.');
console.log('Part A failure + Part B failure → key is wrong, not subscribed, or RapidAPI is down. Re-check the key on rapidapi.com/developer/apps.');
