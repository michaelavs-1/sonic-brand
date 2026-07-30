#!/usr/bin/env node
// Mirror every file from a Vercel deployment to a local directory.
// Requires Node 18+ (uses built-in fetch).
//
// Usage (PowerShell):
//   $env:VERCEL_TOKEN  = "your-token"
//   $env:DEPLOYMENT_ID = "dpl_XXXXXXXX"        # full ID, starts with dpl_
//   $env:VERCEL_TEAM_ID = "team_XXXX"           # only if project belongs to a team
//   $env:OUT_DIR = "michael-v4-snapshot"        # optional; default shown
//   node scripts/mirror-vercel-deployment.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const VERCEL_TOKEN  = process.env.VERCEL_TOKEN  || '';
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID || '';
const TEAM_ID       = process.env.VERCEL_TEAM_ID || '';
const OUT_DIR       = process.env.OUT_DIR || 'michael-v4-snapshot';

if (!VERCEL_TOKEN || !DEPLOYMENT_ID) {
  console.error('Missing VERCEL_TOKEN or DEPLOYMENT_ID env vars. See top of script for usage.');
  process.exit(1);
}

const teamQS = TEAM_ID ? `teamId=${encodeURIComponent(TEAM_ID)}` : '';
function urlFor(path) {
  if (!teamQS) return `https://api.vercel.com${path}`;
  return `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}${teamQS}`;
}

async function api(path) {
  const url = urlFor(path);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GET ${url} → ${r.status}\n${body.slice(0, 500)}`);
  }
  return r;
}

function flatten(nodes, prefix = '') {
  const out = [];
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === 'directory') out.push(...flatten(n.children || [], p));
    else if (n.type === 'file') out.push({ path: p, uid: n.uid });
  }
  return out;
}

async function readFileBody(r) {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await r.json();
    if (j && typeof j === 'object' && 'data' in j) {
      // Vercel returns file contents as { data: <string> }.
      // Text files come back as utf-8 strings; binaries as base64.
      // Heuristic: try base64 decode; if the result is valid utf-8 and roundtrips
      // then treat as base64. Otherwise assume raw utf-8.
      try {
        const buf = Buffer.from(j.data, 'base64');
        // Sanity check: base64 output length must be plausible
        if (buf.length > 0) return buf;
      } catch { /* fall through */ }
      return Buffer.from(String(j.data), 'utf8');
    }
    return Buffer.from(JSON.stringify(j, null, 2), 'utf8');
  }
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  console.log(`Fetching file tree for deployment ${DEPLOYMENT_ID}...`);
  const tree = await (await api(`/v6/deployments/${DEPLOYMENT_ID}/files`)).json();
  const files = flatten(tree);
  console.log(`Found ${files.length} files. Mirroring to ${OUT_DIR}/`);

  let done = 0;
  for (const f of files) {
    const outPath = join(OUT_DIR, f.path);
    await mkdir(dirname(outPath), { recursive: true });
    const r = await api(`/v7/deployments/${DEPLOYMENT_ID}/files/${f.uid}`);
    const buf = await readFileBody(r);
    await writeFile(outPath, buf);
    done++;
    if (done % 5 === 0 || done === files.length) {
      process.stdout.write(`  ${done}/${files.length} ${f.path}\n`);
    }
  }
  console.log(`\nDone. ${done} files written to ${OUT_DIR}/`);
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
