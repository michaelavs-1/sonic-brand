// Extract the payment requests from a Chrome net-export log (chrome://net-export)
// into a small readable file, so the huge log never has to be shared.
//
//   node scripts/_netlog-extract.mjs <path-to-netlog.json> [--match=text] [--all]
//
// Keeps every request whose URL contains "hyp.co.il", "yaad", or
// "/api/v7/payment" (or --match=… instead), plus ANY request that got a 5xx.
// For each: time, method, URL (redirect chain), status, request + response
// headers, network errors, and the response body when the log has it.
// Bodies are only in logs recorded with "Include raw bytes"; the default
// "Strip private information" mode has no bodies (and no cookies).
// --all also prints a one-line list of every request in the log.
//
// Writes <log>.extract.txt next to the log and prints the 5xx ones.
// Reads the log line by line (Chrome writes one event per line), so size and
// a log cut off without "Stop Logging" are both fine.

import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/_netlog-extract.mjs <netlog.json> [--match=text] [--all]');
  process.exit(1);
}
const matchArg = args.find((a) => a.startsWith('--match='))?.slice('--match='.length);
const MATCHES = matchArg ? [matchArg.toLowerCase()] : ['hyp.co.il', 'yaad', '/api/v7/payment'];
const LIST_ALL = args.includes('--all');
const BODY_LIMIT = 20000;   // chars per response body

let constants = null;
let evName = new Map();     // event type id → name
let urlRequestType = null;  // source type id of URL_REQUEST
let tickOffset = 0;
const requests = new Map(); // source id → record
let parsedEvents = 0, badLines = 0;

function initConstants(c) {
  constants = c;
  evName = new Map(Object.entries(c.logEventTypes || {}).map(([k, v]) => [v, k]));
  urlRequestType = c.logSourceType?.URL_REQUEST ?? null;
  tickOffset = Number(c.timeTickOffset || 0);
}

function rec(id) {
  if (!requests.has(id)) {
    requests.set(id, { id, urls: [], method: null, reqLine: null, reqHeaders: null,
      status: null, respHeaders: [], bodyChunks: [], bodyBytes: 0, errors: [], start: null });
  }
  return requests.get(id);
}

function onEvent(e) {
  parsedEvents++;
  if (!constants || e?.source?.type !== urlRequestType) return;
  const name = evName.get(e.type) || String(e.type);
  const p = e.params || {};
  const r = rec(e.source.id);
  if (r.start == null && e.time != null) r.start = Number(e.time) + tickOffset;

  if (p.url && (name === 'URL_REQUEST_START_JOB' || name === 'REQUEST_ALIVE' || name === 'URL_REQUEST_REDIRECTED')) {
    const u = p.url || p.location;
    if (u && r.urls[r.urls.length - 1] !== u) r.urls.push(u);
  }
  if (name === 'URL_REQUEST_REDIRECTED' && p.location && r.urls[r.urls.length - 1] !== p.location) r.urls.push(p.location);
  if (p.method && !r.method) r.method = p.method;

  if (/SEND_REQUEST_HEADERS$/.test(name) && Array.isArray(p.headers)) {
    r.reqLine = (p.line || '').trim() || r.reqLine;
    r.reqHeaders = p.headers;
  }
  if (name === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS' && Array.isArray(p.headers)) {
    r.respHeaders.push(p.headers);
    const m = /\s(\d{3})\b/.exec(String(p.headers[0] || ''));
    if (m) r.status = Number(m[1]);
  }
  if (name === 'URL_REQUEST_JOB_FILTERED_BYTES_READ' && p.bytes && r.bodyBytes < BODY_LIMIT * 4) {
    const buf = Buffer.from(p.bytes, 'base64');
    r.bodyChunks.push(buf);
    r.bodyBytes += buf.length;
  }
  if (p.net_error != null && p.net_error !== 0) r.errors.push(`${name}: net_error ${p.net_error}`);
}

function parseLine(raw) {
  let line = raw.trim();
  if (!line || line === ']' || line === '],' || line === '}' || line.startsWith('"events"')) return;
  if (line.startsWith('{"constants":')) {
    line = line.slice('{"constants":'.length).replace(/,\s*$/, '');
    // Some writers put '"events": [' on the same line.
    line = line.replace(/,\s*"events"\s*:\s*\[\s*$/, '');
    try { initConstants(JSON.parse(line)); } catch { badLines++; }
    return;
  }
  if (line.startsWith('"polledData"')) return;
  line = line.replace(/,\s*$/, '');
  if (line.startsWith('"events": [')) line = line.slice('"events": ['.length).trim();
  if (!line.startsWith('{')) return;
  try { onEvent(JSON.parse(line)); } catch { badLines++; }
}

const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) parseLine(line);

if (!constants) {
  // Not the one-event-per-line layout (e.g. re-saved pretty-printed). Fall back
  // to a full parse — fine up to a few hundred MB.
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  initConstants(data.constants);
  for (const e of data.events || []) onEvent(e);
}

const hdr = (h) => (h || []).map((x) => `    ${x}`).join('\n');
function charsetOf(headers) {
  const ct = (headers || []).find((x) => /^content-type:/i.test(x)) || '';
  return (/charset=([\w-]+)/i.exec(ct)?.[1] || 'utf-8').toLowerCase();
}
function bodyText(r) {
  if (!r.bodyChunks.length) return null;
  const buf = Buffer.concat(r.bodyChunks);
  let text;
  try { text = new TextDecoder(charsetOf(r.respHeaders.at(-1))).decode(buf); }
  catch { text = buf.toString('utf8'); }
  return text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) + `\n    … (${text.length - BODY_LIMIT} more chars)` : text;
}

const all = [...requests.values()].filter((r) => r.urls.length).sort((a, b) => a.start - b.start);
const wanted = all.filter((r) => r.urls.some((u) => MATCHES.some((m) => u.toLowerCase().includes(m))) || r.status >= 500);

const out = [];
out.push(`net-export: ${file}`);
out.push(`events parsed: ${parsedEvents}, unreadable lines: ${badLines}, requests: ${all.length}, kept: ${wanted.length}`);
out.push(`match: ${MATCHES.join(', ')} + any 5xx`);
out.push(`bodies in log: ${all.some((r) => r.bodyChunks.length) ? 'yes' : 'NO (recorded without "Include raw bytes")'}`);
out.push('');
for (const r of wanted) {
  out.push('='.repeat(100));
  out.push(`#${r.id}  ${new Date(r.start).toISOString()}  ${r.method || '?'}  status ${r.status ?? '—'}${r.status >= 500 ? '   <<<<< 5xx' : ''}`);
  r.urls.forEach((u, i) => out.push(`  ${i ? 'redirect → ' : 'url: '}${u}`));
  if (r.errors.length) out.push(`  errors:\n${hdr(r.errors)}`);
  if (r.reqHeaders) out.push(`  request${r.reqLine ? ` (${r.reqLine})` : ''}:\n${hdr(r.reqHeaders)}`);
  r.respHeaders.forEach((h, i) => out.push(`  response headers${r.respHeaders.length > 1 ? ` #${i + 1}` : ''}:\n${hdr(h)}`));
  const body = bodyText(r);
  if (body != null) out.push(`  response body:\n${body.split('\n').map((l) => `    ${l}`).join('\n')}`);
  out.push('');
}
if (LIST_ALL) {
  out.push('='.repeat(100), 'ALL REQUESTS:');
  for (const r of all) out.push(`  ${new Date(r.start).toISOString()}  ${String(r.status ?? '—').padEnd(3)}  ${r.method || '?'}  ${r.urls.at(-1)}`);
}

const outFile = file.replace(/\.json$/i, '') + '.extract.txt';
fs.writeFileSync(outFile, out.join('\n'));
console.log(out.slice(0, 5).join('\n'));
for (const r of wanted.filter((x) => x.status >= 500)) console.log(`5xx: #${r.id} ${r.method} ${r.status} ${r.urls.at(-1)}`);
console.log(`\nwritten: ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
