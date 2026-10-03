/* scripts/_v7-special-playlists-walkthrough.mjs
 *
 * Live E2E for v7's special playlists (2026-10-03) against `vercel dev` →
 * prod Supabase + Rubin's Spotify. Self-cleaning: one throwaway
 * @example.invalid user + v7 business (taste profile included), deleted at
 * the end with everything it created; any playlist still on Spotify is
 * unfollowed and its ledger row marked deleted.
 *
 * Checks:
 *   - chat: a future event gets no "confirming"; a mood-only request is asked
 *     about the daily styles (logged — the model's wording varies);
 *   - save-event + event-playlist (genre_source 'daily' → genres ⊆ approved);
 *   - a second playlist shares no track with the first (today's live tracks
 *     are excluded);
 *   - the 2-per-day cap (409 daily_cap), freed by a delete;
 *   - delete with no cron running → Spotify deleted now; with the
 *     cron:running:expire flag set → handed to the expire cron;
 *   - an event from before the last 04:00 → 410.
 * Creates ~2 Spotify playlists and makes ~6 Gemini calls. Avoid running it at
 * :00 / :30 (the crons). Takes ~2–3 minutes.
 *
 * Usage (PowerShell, env loaded from .env.local as in CLAUDE.md):
 *   node scripts/_v7-special-playlists-walkthrough.mjs
 */

import { randomUUID } from 'node:crypto';

const DEV_BASE     = `http://127.0.0.1:${process.env.DEV_PORT || '3000'}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const REDIS_URL    = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
const RUBIN_ID     = process.env.RUBIN_SPOTIFY_CLIENT_ID;
const RUBIN_SECRET = process.env.RUBIN_SPOTIFY_CLIENT_SECRET;
const RUBIN_TOKEN  = process.env.RUBIN_REFRESH_TOKEN;
for (const [k, v] of Object.entries({ SUPABASE_URL, SERVICE_KEY, ANON_KEY, INTERNAL_KEY })) {
  if (!v) { console.error(`Missing ${k} — load .env.local first.`); process.exit(1); }
}

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}

const HDR = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function pgr(method, path, { body, query, prefer } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (query) url += `?${new URLSearchParams(query)}`;
  const r = await fetch(url, { method, headers: prefer ? { ...HDR, Prefer: prefer } : HDR, body: body == null ? undefined : JSON.stringify(body) });
  const txt = await r.text(); let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
async function redis(cmds) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(`${REDIS_URL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  return r.ok ? r.json() : null;
}

let token = null;
let businessId = null;
async function api(path, body) {
  const r = await fetch(`${DEV_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: DEV_BASE, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// Singular forms the chat must not use (it speaks to the owner in the plural).
const SINGULAR_RE = /(^|[\s,.!?"'(])(אתה|הגעת|תרצה|חזור|תחזור|לחץ|תוכל|תכתוב|ספר לי)(?=$|[\s,.!?"')])/;
const singularReplies = [];
const labelReplies = [];     // the chat never calls it "פלייליסט מיוחד" / "ספיישל"
async function chat(message, sessionStartAt) {
  const { status, data } = await api('/api/v7/account/event-chat', { businessId, message, sessionStartAt });
  if (status !== 200) throw new Error(`event-chat ${status}: ${JSON.stringify(data)}`);
  const p = data.assistantMessage?.parsed || {};
  console.log(`    > ${message}\n    < [${p.state}] ${p.reply_he}${p.proposed ? `  ${JSON.stringify(p.proposed)}` : ''}`);
  if (SINGULAR_RE.test(p.reply_he || '')) singularReplies.push(p.reply_he);
  if (/מיוחד|ספיישל/.test(p.reply_he || '')) labelReplies.push(p.reply_he);
  return p;
}

const APPROVED = [
  { genre: 'Modern Pop', energy_level: 3 }, { genre: '80s Pop', energy_level: 3 },
  { genre: 'Funk', energy_level: 4 },       { genre: 'Disco', energy_level: 4 },
  { genre: 'Neo Soul', energy_level: 2 },   { genre: 'Bossa Nova', energy_level: 1 },
  { genre: 'Jazz (Standards)', energy_level: 1 },
];
const stamp = Date.now();
const email = `test-v7sp-${stamp}@example.invalid`;
let userId = null;
const spotifyIds = new Set();

try {
  // --- setup: throwaway v7 business + owner session ---
  console.log('\n[setup] signup + session');
  const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { closed: false, open: '08:00', close: '23:00' }]));
  const su = await fetch(`${DEV_BASE}/api/v7/account/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_KEY, Origin: DEV_BASE },
    body: JSON.stringify({
      email, name: 'בר בדיקה (special playlists)', description: 'בר שכונתי קטן', musicalEmphases: '',
      atmospheres: [], place: null, hours, longestMinutes: 900, superLikedTracks: [],
      onboardingSessionId: `v7sp-${stamp}`, skipEmail: true,
      tasteProfile: { energy_levels_total: 4, approved_genres: APPROVED, conditional_genres: [], instrumentalness_preference: 'none', popularity_preference: 'none', reasoning_en: 'test' },
    }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  if (!su.data.business_id) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.data)}`);
  businessId = su.data.business_id;
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: HDR, body: JSON.stringify({ type: 'magiclink', email }) }).then((r) => r.json());
  const ver = await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: gen?.hashed_token || gen?.properties?.hashed_token }) }).then((r) => r.json());
  token = ver.access_token; userId = ver.user?.id;
  ok(!!token, 'owner session minted');

  let hasGenreSource = true;
  try { await pgr('GET', 'business_events', { query: { select: 'genre_source', limit: '1' } }); }
  catch { hasGenreSource = false; }
  console.log(`  (business_events.genre_source ${hasGenreSource ? 'exists' : 'MISSING — migration not run; daily-genre checks skipped'})`);

  // --- chat ---
  console.log('\n[chat] future event');
  const fut = await chat('מחר בערב יש לנו ערב סטנדאפ, משהו קליל ברקע', new Date().toISOString());
  ok(fut.state !== 'confirming', 'a future event never reaches "confirming"');

  console.log('\n[chat] mood only → daily styles question');
  const s2 = new Date().toISOString();
  const m1 = await chat('הערב יש לנו מסיבת יום הולדת, אווירה שמחה', s2);
  ok(m1.state !== 'confirming', 'mood-only request is not confirmed straight away');
  let last = await chat('כן, אותם סגנונות כמו בפלייליסטים היומיים. שמח ורקיד', s2);
  if (last.state !== 'confirming') last = await chat('כן, תכין', s2);
  ok(last.state === 'confirming' && last.proposed?.genre_source === 'daily', 'agreeing to the daily styles → confirming with genre_source "daily"', JSON.stringify(last.proposed));

  // --- save + build #1 (daily) ---
  console.log('\n[build] #1 (daily styles)');
  const p1 = last.proposed || {};
  const save1 = await api('/api/v7/account/save-event', {
    businessId, sessionStartAt: s2,
    event: {
      name:         p1.name_he || 'מסיבת יום הולדת',
      description:  p1.description_he || 'מסיבת יום הולדת שמחה ורקידה בסגנונות הרגילים של העסק',
      genre_source: 'daily',
    },
  });
  const ev1 = save1.data.event;
  ok(!!ev1?.id, 'event #1 saved', JSON.stringify(save1.data));
  if (hasGenreSource) ok(ev1?.genre_source === 'daily', 'genre_source stored as "daily"');
  const t0 = Date.now();
  const b1 = await api('/api/v7/account/event-playlist', { businessId, eventId: ev1.id });
  console.log(`    built in ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(b1.data.playlist || b1.data)}`);
  ok(b1.status === 200 && b1.data.playlist?.id, 'playlist #1 built');
  if (b1.data.playlist?.id) spotifyIds.add(b1.data.playlist.id);
  if (hasGenreSource && b1.data.playlist) {
    const allowed = new Set(APPROVED.map((g) => g.genre));
    ok(b1.data.playlist.genres.every((g) => allowed.has(g)), 'daily → genres ⊆ approved', b1.data.playlist.genres.join(', '));
  }
  const again = await api('/api/v7/account/event-playlist', { businessId, eventId: ev1.id });
  ok(again.data.already === true && again.data.playlist?.id === b1.data.playlist?.id, 'building again returns the live playlist');

  // --- save + build #2 (named styles) — no shared tracks with #1 ---
  console.log('\n[build] #2 (named styles)');
  const save2 = await api('/api/v7/account/save-event', { businessId, sessionStartAt: new Date().toISOString(), event: { name: 'ערב פופ', description: 'ערב פופ שמח וקליל, פופ מודרני ופופ של שנות ה-80', genre_source: 'event' } });
  const ev2 = save2.data.event;
  ok(!!ev2?.id, 'event #2 saved');
  const b2 = await api('/api/v7/account/event-playlist', { businessId, eventId: ev2.id });
  ok(b2.status === 200 && b2.data.playlist?.id, 'playlist #2 built', JSON.stringify(b2.data).slice(0, 200));
  if (b2.data.playlist?.id) spotifyIds.add(b2.data.playlist.id);
  const rows = await pgr('GET', 'business_playlists', { query: { business_id: `eq.${businessId}`, select: 'spotify_id,track_ids,event_id' } });
  const t1 = new Set(rows.find((r) => r.event_id === ev1.id)?.track_ids || []);
  const t2 = rows.find((r) => r.event_id === ev2.id)?.track_ids || [];
  ok(t2.length > 0 && t2.every((id) => !t1.has(id)), `#2 shares no track with #1 (${t2.filter((id) => t1.has(id)).length} shared of ${t2.length})`);

  // --- cap ---
  console.log('\n[cap]');
  const cap = await chat('ועוד אחד: ערב ג\'אז רגוע עכשיו', new Date().toISOString());
  ok(cap.state !== 'confirming', 'chat refuses a third one today');
  const save3 = await api('/api/v7/account/save-event', { businessId, event: { name: 'שלישי', description: 'ערב ג\'אז רגוע ושקט', genre_source: 'event' } });
  ok(save3.status === 409 && save3.data.code === 'daily_cap', 'save-event → 409 daily_cap', JSON.stringify(save3.data));
  ok(singularReplies.length === 0, 'every chat reply addresses the owner in the plural', singularReplies.join(' | '));
  ok(labelReplies.length === 0, 'no chat reply says "מיוחד" / "ספיישל"', labelReplies.join(' | '));

  // --- delete #1, no cron running → Spotify deleted now ---
  console.log('\n[delete] #1 with no cron running');
  const running = await redis([['EXISTS', 'cron:running:v7-daily'], ['EXISTS', 'cron:running:expire']]);
  if (running && running.some((x) => x.result === 1)) console.log('    (a real cron is running right now — expect "queued")');
  const d1 = await api('/api/v7/account/delete-event', { businessId, eventId: ev1.id });
  ok(d1.status === 200 && d1.data.spotify === 'deleted', 'delete #1 → spotify "deleted"', JSON.stringify(d1.data));
  const led1 = await pgr('GET', 'created_playlists', { query: { spotify_id: `eq.${b1.data.playlist?.id}`, select: 'deleted_at' } });
  ok(!!led1?.[0]?.deleted_at, 'ledger row #1 marked deleted');
  if (led1?.[0]?.deleted_at) spotifyIds.delete(b1.data.playlist.id);
  const evGone = await pgr('GET', 'business_events', { query: { id: `eq.${ev1.id}`, select: 'id' } });
  ok(evGone.length === 0, 'event #1 row deleted');

  // --- cap freed ---
  const save4 = await api('/api/v7/account/save-event', { businessId, event: { name: 'שלישי', description: 'ערב ג\'אז רגוע ושקט', genre_source: 'event' } });
  ok(save4.status === 200 && save4.data.event?.id, 'after a delete, a new one can be saved');
  if (save4.data.event?.id) await api('/api/v7/account/delete-event', { businessId, eventId: save4.data.event.id });

  // --- delete #2 while a cron is "running" → handed to the expire cron ---
  console.log('\n[delete] #2 while the expire cron is running');
  if (!REDIS_URL) console.log('    (no Redis env — skipped)');
  else {
    const flag = randomUUID();
    await redis([['SET', 'cron:running:expire', flag, 'NX', 'EX', '60']]);
    try {
      const d2 = await api('/api/v7/account/delete-event', { businessId, eventId: ev2.id });
      ok(d2.status === 200 && d2.data.spotify === 'queued', 'delete #2 → spotify "queued"', JSON.stringify(d2.data));
      const led2 = await pgr('GET', 'created_playlists', { query: { spotify_id: `eq.${b2.data.playlist?.id}`, select: 'deleted_at,expires_at' } });
      ok(led2?.[0] && !led2[0].deleted_at && Date.parse(led2[0].expires_at) <= Date.now(), 'ledger row #2 due now, not yet deleted');
    } finally {
      const cur = await redis([['GET', 'cron:running:expire']]);
      if (cur?.[0]?.result === flag) await redis([['DEL', 'cron:running:expire']]);
    }
  }

  // --- yesterday's event → 410 ---
  console.log('\n[expired]');
  const old = await pgr('POST', 'business_events', { body: { business_id: businessId, name: 'אתמול', description: 'אירוע של אתמול בערב', created_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() }, prefer: 'return=representation' });
  const b5 = await api('/api/v7/account/event-playlist', { businessId, eventId: old[0].id });
  ok(b5.status === 410 && b5.data.code === 'expired', 'an event from before the last 04:00 → 410');
} catch (e) {
  console.error('\nABORTED:', e.message);
  failed++;
} finally {
  console.log('\n[teardown]');
  if (spotifyIds.size && RUBIN_ID && RUBIN_SECRET && RUBIN_TOKEN) {
    try {
      const basic = Buffer.from(`${RUBIN_ID}:${RUBIN_SECRET}`).toString('base64');
      const tk = (await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RUBIN_TOKEN }) }).then((r) => r.json())).access_token;
      for (const id of spotifyIds) {
        const r = await fetch(`https://api.spotify.com/v1/playlists/${id}/followers`, { method: 'DELETE', headers: { Authorization: `Bearer ${tk}` } });
        await pgr('PATCH', 'created_playlists', { query: { spotify_id: `eq.${id}` }, body: { deleted_at: new Date().toISOString(), error: null }, prefer: 'return=minimal' }).catch(() => {});
        console.log(`  playlist ${id} unfollowed (${r.status})`);
      }
    } catch (e) { console.warn('  Spotify teardown failed:', e.message); }
  } else if (spotifyIds.size) console.warn(`  ${spotifyIds.size} playlist(s) left for the expire cron (no Rubin env)`);
  if (businessId) { await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } }).catch((e) => console.warn('  business delete:', e.message)); console.log(`  business ${businessId} deleted`); }
  if (userId) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: HDR }).catch(() => {});
    console.log(`  user ${userId} deleted`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
