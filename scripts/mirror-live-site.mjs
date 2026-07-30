#!/usr/bin/env node
// Mirror the reachable frontend files from Michael's live v4 into a local
// snapshot. Starts from a known seed list, then follows every import / script /
// link / img reference discovered inside the fetched HTML, JS, and CSS.
//
// Usage:  node scripts/mirror-live-site.mjs
// Output: michael-v4-snapshot/  (mirrors the URL path structure)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';

const HOST    = 'https://robin-music.com';
const OUT_DIR = 'michael-v4-snapshot';

const SEEDS = [
  '/v4/index.html',
  '/v4/app.js',
  '/v4/atmosphere.js',
  '/v4/preview.js',
  '/v4/result.js',
  '/v4/generation/preview-builder.js',
  '/v4/generation/playlist-builder.js',
  '/v4/generation/matcher.js',
  '/v4/generation/fallback.js',
  '/v4/generation/atmosphere-params.js',
  '/v4/account/index.html',
  '/v4/account/app.js',
  '/v4/track-analysis/index.html',
  '/v4/track-analysis/app.js',
  '/v4/og.png',
  '/favicon.ico',
  '/robots.txt',
];

const TEXT_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md']);

const REF_PATTERNS = [
  /import\s+[\w{}\s,*$]+\s+from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\s+['"]([^'"]+)['"]/g,
  /export\s+[\w{}\s,*$]+\s+from\s+['"]([^'"]+)['"]/g,
  /<script\b[^>]*\ssrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\shref=["']([^"']+)["']/gi,
  /<img\b[^>]*\ssrc=["']([^"']+)["']/gi,
  /<source\b[^>]*\ssrc=["']([^"']+)["']/gi,
  /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  /@import\s+["']([^"']+)["']/g,
];

const SKIP_HOST_PREFIXES = ['/api/']; // server endpoints, not files

async function tryFetch(url) {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    return r;
  } catch (e) {
    return { ok: false, status: 0, statusText: e.message, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
  }
}

function extractRefs(text, fromPathname) {
  const base = new URL(HOST + fromPathname);
  const found = new Set();
  for (const p of REF_PATTERNS) {
    p.lastIndex = 0;
    let m;
    while ((m = p.exec(text))) {
      let ref = m[1];
      if (!ref) continue;
      if (ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('tel:')) continue;
      if (ref.startsWith('//')) ref = 'https:' + ref;
      let u;
      try { u = new URL(ref, base); } catch { continue; }
      if (u.hostname !== new URL(HOST).hostname) continue;
      let path = u.pathname;
      if (!path || path === '/') continue;
      if (SKIP_HOST_PREFIXES.some(pref => path.startsWith(pref))) continue;
      found.add(path);
    }
  }
  return [...found];
}

async function main() {
  const queue = [...SEEDS];
  const seen = new Set();
  const results = { ok: 0, miss: 0, fail: 0 };

  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);

    const url = HOST + path;
    const r = await tryFetch(url);
    if (!r.ok) {
      console.log(`  MISS ${r.status || 'ERR'}  ${path}`);
      results.miss++;
      continue;
    }

    const buf = Buffer.from(await r.arrayBuffer());
    const outPath = join(OUT_DIR, path.replace(/^\//, ''));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);
    results.ok++;
    console.log(`  OK   ${String(buf.length).padStart(7)}b  ${path}`);

    const ext = extname(path).toLowerCase();
    const looksTextual = TEXT_EXTS.has(ext) ||
      (r.headers.get('content-type') || '').match(/text|javascript|json|xml/i);
    if (looksTextual) {
      const text = buf.toString('utf8');
      const refs = extractRefs(text, path);
      for (const d of refs) {
        if (!seen.has(d)) queue.push(d);
      }
    }
  }

  console.log(`\nDone. ${results.ok} files written, ${results.miss} missing.`);
  console.log(`Output: ${OUT_DIR}/`);
}

main().catch(e => { console.error('\nFailed:', e); process.exit(1); });
