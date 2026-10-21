/* scripts/_admin-api-walkthrough.mjs
 *
 * Live check of the admin console API (/api/internal/*, 2026-10-13) against
 * `vercel dev` → prod Supabase. Self-cleaning: one throwaway
 * @example.invalid user + v7 business (fixed taste profile + libraries) and
 * one throwaway coupon, all deleted at the end. Builds NO playlists (nothing
 * on Spotify) and makes no Gemini calls; the Option 2 check runs the track-
 * pool RPC read-only.
 *
 * Checks:
 *   1. signup keeps the onboarding swipe cards (onboarding_probes);
 *   2. GET users / business / directions / gemini-spend answer, with the
 *      v7 sections;
 *   3. direction edits: add a genre the profile lacks (→ approved too), a
 *      genre of the other tier (refused, then moved with move:true), replace,
 *      remove, new + delete a direction, admin undo; each logged with
 *      source 'admin';
 *   4. daily picks: set tomorrow's "אנרגיה גבוהה #1" → the Option 1 planner
 *      plays it (and its partner is another direction); clear;
 *      Option 2: set tomorrow's Daily Mix #1 at one level → the Option 2
 *      planner plays it at that level (and Mix #2 another direction there);
 *      refusals (wrong tier, past date);
 *      rebuild_today on a closed day → refused;
 *   5. coupons: create, list with usage, switch off, refusals.
 *
 * Usage (PowerShell, env loaded from .env.local as in CLAUDE.md, vercel dev running):
 *   node scripts/_admin-api-walkthrough.mjs
 * Needs migration v5/precompute/migrations/2026-10-13-admin-console.sql for
 * checks 1, 3's source='admin' and 4 (they're reported as SKIP before it runs).
 */

const DEV_BASE     = `http://127.0.0.1:${process.env.DEV_PORT || '3000'}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const ADMIN_KEY    = process.env.INTERNAL_ADMIN_API_KEY;
for (const [k, v] of Object.entries({ SUPABASE_URL, SERVICE_KEY, INTERNAL_KEY, ADMIN_KEY })) {
  if (!v) { console.error(`Missing ${k} — load .env.local first.`); process.exit(1); }
}

let passed = 0, failed = 0, skipped = 0;
function ok(cond, name, extra) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else      { console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); failed++; }
}
const skip = (name, why) => { console.log(`  SKIP  ${name} — ${why}`); skipped++; };

const HDR = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function pgr(method, path, { body, query, prefer } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (query) url += `?${new URLSearchParams(query)}`;
  const r = await fetch(url, { method, headers: prefer ? { ...HDR, Prefer: prefer } : HDR, body: body == null ? undefined : JSON.stringify(body) });
  const txt = await r.text(); let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
const hasTable = (t) => pgr('GET', t, { query: { select: '*', limit: '1' } }).then(() => true, () => false);
const hasColumn = (t, c) => pgr('GET', t, { query: { select: c, limit: '1' } }).then(() => true, () => false);

async function admin(method, path, body) {
  const r = await fetch(`${DEV_BASE}/api/internal/${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// Israel date k days from today.
const ilDate = (k = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(Date.now() + k * 86400e3));
// A Date at 10:00 Israel time on an Israel date (DST-safe enough for a test: tries +2 / +3).
const ilTen = (iso) => {
  for (const off of [3, 2]) {
    const d = new Date(`${iso}T${String(10 - off).padStart(2, '0')}:00:00Z`);
    if (new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(d) === '10') return d;
  }
  return new Date(`${iso}T07:00:00Z`);
};

const APPROVED = [
  { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Jazz (Standards)', energy_level: 1 }, { genre: 'DownTempo', energy_level: 1 },
  { genre: 'Neo Soul', energy_level: 2 }, { genre: 'Rnb', energy_level: 2 },
  { genre: 'Funk', energy_level: 3 }, { genre: 'Acid Jazz', energy_level: 3 }, { genre: 'Afro Funk', energy_level: 3 },
  { genre: 'Disco', energy_level: 4 }, { genre: 'Latin Funk', energy_level: 4 },
];
const OPTION1 = [
  { energy_tier: 'high', title_en: 'Global Funk', genres: ['Funk', 'Afro Funk', 'Latin Funk'] },
  { energy_tier: 'high', title_en: 'Disco Funk', genres: ['Disco', 'Funk'] },
  { energy_tier: 'high', title_en: 'Acid Jazz', genres: ['Acid Jazz'] },
  { energy_tier: 'low', title_en: 'Jazz & Bossa', genres: ['Jazz (Standards)', 'Bossa Nova'] },
  { energy_tier: 'low', title_en: 'Soul', genres: ['Neo Soul', 'Rnb'] },
];
const OPTION2 = [
  { energy_level: 1, title_en: 'Bossa', genres: ['Bossa Nova'] }, { energy_level: 1, title_en: 'Jazz', genres: ['Jazz (Standards)', 'DownTempo'] },
  { energy_level: 2, title_en: 'Soul', genres: ['Neo Soul'] }, { energy_level: 2, title_en: 'Rnb', genres: ['Rnb'] },
  { energy_level: 3, title_en: 'Funk', genres: ['Funk', 'Afro Funk'] }, { energy_level: 3, title_en: 'Acid', genres: ['Acid Jazz'] },
  { energy_level: 4, title_en: 'Disco', genres: ['Disco'] }, { energy_level: 4, title_en: 'Latin', genres: ['Latin Funk'] },
];
const PROBES = [
  { round: 1, rank: 1, title_en: 'Funk probe', description_he: 'פאנק. בודק…', genres: ['Funk', 'Afro Funk'], verdict: 'liked' },
  { round: 1, rank: 2, title_en: 'Metal probe', description_he: 'מטאל. בודק…', genres: ['Heavy Rock+Metal'], verdict: 'disliked' },
];

const stamp = Date.now();
const email = `test-admin-api-${stamp}@example.invalid`;
const coupon = `ZZTEST${String(stamp).slice(-6)}`;
let businessId = null;
let userId = null;
let couponMade = false;

try {
  const migrated = await hasTable('business_v7_daily_picks');
  if (!migrated) console.log('\n(migration 2026-10-13-admin-console.sql not run yet — its checks are skipped)');

  // --- 1. signup keeps the swipe cards ---
  console.log('\n[1] signup (internal) + swipe cards');
  const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { closed: false, open: '08:00', close: '23:00' }]));
  hours[ilTen(ilDate(0)).getUTCDay()] = { closed: true };   // closed TODAY → rebuild_today must refuse
  const su = await fetch(`${DEV_BASE}/api/v7/account/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_KEY, Origin: DEV_BASE },
    body: JSON.stringify({
      email, name: 'עסק בדיקה (admin API)', description: 'בית קפה לבדיקה', musicalEmphases: 'פאנק',
      atmospheres: ['קליל'], place: null, hours, longestMinutes: 900, superLikedTracks: [],
      onboardingSessionId: `admin-api-${stamp}`, skipEmail: true, onboardingProbes: PROBES,
      genreTally: [{ genre: 'Funk', like: 1, dislike: 0 }],
      tasteProfile: { energy_levels_total: 4, approved_genres: APPROVED, conditional_genres: [], instrumentalness_preference: 'none', popularity_preference: 'none', reasoning_en: 'test' },
    }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  if (!su.data.business_id) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.data)}`);
  businessId = su.data.business_id;
  userId = (await pgr('GET', 'businesses', { query: { id: `eq.${businessId}`, select: 'owner_id' } }))[0]?.owner_id;
  const tp = (await pgr('GET', 'business_taste_profiles', { query: { business_id: `eq.${businessId}`, select: '*' } }))[0];
  ok(!!tp, 'taste profile saved');
  if (await hasColumn('business_taste_profiles', 'onboarding_probes')) {
    ok(Array.isArray(tp.onboarding_probes) && tp.onboarding_probes.length === 2 && tp.onboarding_probes[1].verdict === 'disliked',
      'onboarding_probes saved', JSON.stringify(tp.onboarding_probes));
  } else skip('onboarding_probes saved', 'column missing');

  // Option 1 + a library (as the energy-directions step would).
  await pgr('POST', 'business_v7_settings', { body: { business_id: businessId, delivery_mode: 'option1', updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates' });
  const rank = { high: 0, low: 0 };
  await pgr('POST', 'business_v7_directions', { body: OPTION1.map((d) => ({ ...d, business_id: businessId, rank: ++rank[d.energy_tier], active: true })) });

  // --- 2. reads ---
  console.log('\n[2] reads');
  const users = await admin('GET', 'users');
  ok(users.status === 200 && users.data.businesses?.some((b) => b.business_id === businessId && b.delivery_mode === 'option1'), 'users lists the business with its mode');
  const biz = await admin('GET', `business?id=${businessId}`);
  ok(biz.status === 200, 'business 200', JSON.stringify(biz.data).slice(0, 200));
  const b = biz.data;
  ok(b.business?.version === 'v7' && b.onboarding?.atmospheres?.[0] === 'קליל', 'business + onboarding sections');
  ok(b.taste_profile?.approved_by_level?.length === 4 && b.directions?.in_use === 'option1' && b.directions.option1.length === 5, 'taste profile + directions');
  ok(b.payment?.status === 'no-payment' && Array.isArray(b.clicks?.by_day) && Array.isArray(b.special_requests?.requests), 'payment / clicks / special requests');
  if (migrated) ok(b.onboarding?.swipe?.cards?.length === 2, 'swipe cards in the business view');
  const dirs = await admin('GET', `directions?id=${businessId}`);
  ok(dirs.status === 200 && dirs.data.directions.map((d) => d.key).join(',') === 'H1,H2,H3,C1,C2', 'directions keys H1..H3, C1..C2', JSON.stringify(dirs.data.directions?.map((d) => d.key)));
  const gs = await admin('GET', 'gemini-spend?from=2026-10-01&to=2026-10-31');
  ok(gs.status === 200 && gs.data.range?.calls >= 0 && Array.isArray(gs.data.by_month_google), 'gemini-spend');
  const unauth = await fetch(`${DEV_BASE}/api/internal/users`).then((r) => r.status);
  ok(unauth === 401, 'no key → 401');

  // --- 3. direction edits ---
  console.log('\n[3] direction edits');
  const lib = async () => (await admin('GET', `directions?id=${businessId}`)).data;
  const approvedLevel = async (g) => (await pgr('GET', 'business_taste_profiles', { query: { business_id: `eq.${businessId}`, select: 'approved_genres' } }))[0]
    .approved_genres.find((a) => a.genre === g)?.energy_level ?? null;

  let r = await admin('POST', 'directions', { business_id: businessId, action: 'add_genre', direction: 'H1', genre: 'Brazilian Funk' });
  ok(r.status === 200 && r.data.directions.find((d) => d.key === 'H1').genres.includes('Brazilian Funk'), 'add a new genre to H1', JSON.stringify(r.data).slice(0, 300));
  ok([3, 4].includes(await approvedLevel('Brazilian Funk')), 'the added genre is approved in the high tier');

  r = await admin('POST', 'directions', { business_id: businessId, action: 'add_genre', direction: 'H2', genre: 'Bossa Nova' });
  ok(r.status === 400 && /move:true/.test(r.data.error || ''), 'a calm genre into a high direction → refused without move', JSON.stringify(r.data));
  r = await admin('POST', 'directions', { business_id: businessId, action: 'add_genre', direction: 'H2', genre: 'Bossa Nova', move: true });
  ok(r.status === 200 && (await approvedLevel('Bossa Nova')) >= 3, 'with move:true it moves to the high tier', JSON.stringify(r.data).slice(0, 300));
  ok(!r.data.directions.find((d) => d.key === 'C1').genres.includes('Bossa Nova'), '…and leaves the calm direction');

  r = await admin('POST', 'directions', { business_id: businessId, action: 'replace_genre', direction: 'H2', genre: 'Disco', with: 'Latin Funk' });
  const h2 = r.data.directions?.find((d) => d.key === 'H2');
  ok(r.status === 200 && h2 && !h2.genres.includes('Disco') && h2.genres.includes('Latin Funk'), 'replace Disco → Latin Funk in H2', JSON.stringify(h2));

  r = await admin('POST', 'directions', { business_id: businessId, action: 'remove_genre', direction: 'H1', genre: 'Afro Funk' });
  ok(r.status === 200 && !r.data.directions.find((d) => d.key === 'H1').genres.includes('Afro Funk'), 'remove Afro Funk from H1');

  // Ami's pairing rules (2026-10-21): DownTempo goes only with DownTempo.
  r = await admin('POST', 'directions', { business_id: businessId, action: 'new_direction', tier: 'low', genres: ['Rnb', 'DownTempo'], title_en: 'Test low' });
  ok(r.status === 400 && /DownTempo only with DownTempo/.test(JSON.stringify(r.data.dropped)), 'a direction that breaks a pairing rule → 400 with the rule', JSON.stringify(r.data));
  r = await admin('POST', 'directions', { business_id: businessId, action: 'new_direction', tier: 'low', genres: ['Rnb'], title_en: 'Test low' });
  ok(r.status === 200 && r.data.directions.some((d) => d.title_en === 'Test low' && d.energy_tier === 'low'), 'new calm direction');
  const newKey = r.data.directions?.find((d) => d.title_en === 'Test low')?.key;
  r = await admin('POST', 'directions', { business_id: businessId, action: 'delete_direction', direction: newKey });
  ok(r.status === 200 && !r.data.directions.some((d) => d.title_en === 'Test low'), `delete ${newKey}`);

  const beforeUndo = (await lib()).directions.find((d) => d.title_en === 'Test low');
  r = await admin('POST', 'directions', { business_id: businessId, action: 'undo' });
  const changes = await pgr('GET', 'business_taste_changes', { query: { business_id: `eq.${businessId}`, select: '*', order: 'applied_at.asc' } });
  if (migrated) {
    ok(r.status === 200 && r.data.directions.some((d) => d.title_en === 'Test low') && !beforeUndo, 'undo brings the deleted direction back', JSON.stringify(r.data).slice(0, 200));
    ok(changes.length === 6 && changes[5].undone_at && !changes[4].undone_at, `6 changes logged, the last one undone (got ${changes.length})`);
    ok(changes.every((c) => c.source === 'admin'), 'all logged with source admin');
  } else {
    // Without the `source` column an admin change can't be told from the
    // owner's, so admin undo refuses (it would never undo an owner's change).
    ok(r.status === 409, 'undo refused before the migration (changes not marked admin)', JSON.stringify(r.data));
    ok(changes.length === 6, `6 changes logged (got ${changes.length})`);
    skip('undo + source admin', 'migration not run');
  }
  r = await admin('POST', 'directions', { business_id: businessId, action: 'remove_genre', direction: 'H9', genre: 'Funk' });
  ok(r.status === 400, 'unknown direction key → 400');

  // --- 3b. Ami's taste chat bench (2026-10-21): load a business, save a change ---
  console.log('\n[3b] taste bench');
  r = await admin('GET', `taste-bench?id=${businessId}`);
  ok(r.status === 200 && r.data.mode === 'option1' && r.data.ctx?.state?.approved?.length > 0 && Array.isArray(r.data.ctx?.changes),
    'context loaded (the chat\'s own context for this business)', JSON.stringify(r.data).slice(0, 200));
  r = await admin('POST', 'taste-bench', { business_id: businessId, ops: [{ op: 'undo' }] });
  ok(r.status === 400, 'undo is not saved from the bench');
  r = await admin('POST', 'taste-bench', { business_id: businessId, ops: [{ op: 'set_weight', genre: 'Not A Genre', weight: 2 }] });
  ok(r.status === 409 && r.data.dropped?.length === 1, 'a change that can\'t apply → 409 with the reason');
  r = await admin('POST', 'taste-bench', { business_id: businessId, ops: [{ op: 'set_weight', genre: 'Funk', weight: 1.5 }], summary_he: 'בדיקה' });
  ok(r.status === 200 && r.data.applied?.length === 1, 'saved to the profile', JSON.stringify(r.data));
  const weights = (await pgr('GET', 'business_taste_profiles', { query: { business_id: `eq.${businessId}`, select: 'genre_weights' } }))[0]?.genre_weights;
  ok(weights?.Funk === 1.5, `the weight is in the real profile (${JSON.stringify(weights)})`);
  const benchLog = await pgr('GET', 'business_taste_changes', { query: { business_id: `eq.${businessId}`, select: 'summary_he,source', order: 'applied_at.desc', limit: '1' } });
  ok(/Ami's bench/.test(benchLog[0]?.summary_he || '') && (!migrated || benchLog[0]?.source === 'admin'), 'logged as an admin change');

  // --- 4a. the owner's build endpoint after the move to _run-daily-build.js ---
  // (no Spotify: today is closed, so "replace today" is refused before
  // anything is built; a second call proves the build lock was released)
  console.log('\n[4a] owner generate-daily (refusals only)');
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: HDR, body: JSON.stringify({ type: 'magiclink', email }) }).then((x) => x.json());
  const ver = await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: gen?.hashed_token || gen?.properties?.hashed_token }) }).then((x) => x.json());
  const owner = (body, auth = true) => fetch(`${DEV_BASE}/api/v7/account/generate-daily`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: DEV_BASE, ...(auth ? { Authorization: `Bearer ${ver.access_token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => ({})) }));
  ok(!!ver.access_token, 'owner session minted');
  const g1 = await owner({ businessId, replaceToday: true });
  ok(g1.status === 409 && g1.data.code === 'closed-today', 'replace today on a closed day → 409 closed-today', JSON.stringify(g1));
  const g2 = await owner({ businessId, replaceToday: true });
  ok(g2.status === 409 && g2.data.code === 'closed-today', '…again (the build lock was released)', JSON.stringify(g2));
  ok((await owner({ businessId }, false)).status === 401, 'no session → 401');

  // --- 4. daily picks ---
  console.log('\n[4] daily picks');
  const tomorrow = ilDate(1);
  const { planOption1 } = await import('../api/v7/account/_daily-builder.js');
  const { planOption2Timeline } = await import('../api/v7/account/_option2-builder.js');
  if (!migrated) {
    r = await admin('POST', 'daily-picks', { business_id: businessId, action: 'set', date: tomorrow, slot: 'high-1', direction: 'H3' });
    ok(r.status === 501, 'set before the migration → 501', JSON.stringify(r.data));
    skip('daily picks', 'migration not run');
  } else {
    const H3 = (await lib()).directions.find((d) => d.key === 'H3');
    r = await admin('POST', 'daily-picks', { business_id: businessId, action: 'set', date: tomorrow, slot: 'high-1', direction: 'H3' });
    ok(r.status === 200 && r.data.days?.[0]?.planned?.['high-1']?.source === 'pick', 'set tomorrow high-1 = H3', JSON.stringify(r.data).slice(0, 300));
    const plan = await planOption1({ businessId, hours, now: ilTen(tomorrow) });
    const p1 = plan.directions.find((d) => d.title_en === 'אנרגיה גבוהה #1');
    const p2 = plan.directions.find((d) => d.title_en === 'אנרגיה גבוהה #2');
    ok(p1?.v7_source?.admin_pick && H3.genres.every((g) => p1.genres.includes(g)), 'the Option 1 planner plays the pick in #1', JSON.stringify(p1));
    ok(p2 && !p2.v7_source?.admin_pick && p2.v7_source?.title_en !== H3.title_en, '…and another direction in #2', JSON.stringify(p2?.v7_source));
    r = await admin('POST', 'daily-picks', { business_id: businessId, action: 'set', date: tomorrow, slot: 'low-1', direction: 'H1' });
    ok(r.status === 400, 'a high direction in a calm slot → 400');
    r = await admin('POST', 'daily-picks', { business_id: businessId, action: 'set', date: ilDate(-1), slot: 'high-1', direction: 'H1' });
    ok(r.status === 400, 'a past date → 400');
    r = await admin('POST', 'daily-picks', { business_id: businessId, action: 'clear', date: tomorrow });
    ok(r.status === 200 && !r.data.days?.[0]?.picks?.length, 'clear tomorrow');
    r = await admin('POST', 'daily-picks', { business_id: businessId, action: 'rebuild_today' });
    ok(r.status === 409 && r.data.code === 'closed-today', 'rebuild_today on a closed day → refused', JSON.stringify(r.data));

    // Option 2.
    await pgr('PATCH', 'business_v7_settings', { query: { business_id: `eq.${businessId}` }, body: { delivery_mode: 'option2' } });
    const rk = new Map();
    await pgr('POST', 'business_v7_level_directions', { body: OPTION2.map((d) => { rk.set(d.energy_level, (rk.get(d.energy_level) || 0) + 1); return { ...d, business_id: businessId, rank: rk.get(d.energy_level), active: true }; }) });
    const lib2 = (await lib()).directions;
    const dp = await admin('GET', `daily-picks?id=${businessId}&from=${tomorrow}&days=1`);
    const rotated = dp.data.days?.[0]?.planned?.['mix-1']?.find((x) => x.level === 3);
    const want = rotated?.key === 'L3-2' ? 'L3-1' : 'L3-2';
    r = await admin('POST', 'daily-picks', { business_id: businessId, action: 'set', date: tomorrow, mix: 1, direction: want });
    ok(r.status === 200 && r.data.slot === 'mix-1:L3', `set tomorrow Daily Mix #1 level 3 = ${want}`, JSON.stringify(r.data).slice(0, 300));
    const planned = r.data.days?.[0]?.planned?.['mix-1']?.find((x) => x.level === 3);
    ok(planned?.source === 'pick' && planned?.key === want, 'the view shows the pick', JSON.stringify(planned));
    const other = r.data.days?.[0]?.planned?.['mix-2']?.find((x) => x.level === 3);
    ok(other && other.key !== want, 'mix 2 plays a different direction at level 3', JSON.stringify(other));
    try {
      const plan2 = await planOption2Timeline({ businessId, hours, now: ilTen(tomorrow) });
      if (plan2.fallback) skip('Option 2 planner plays the pick', 'pool RPC missing');
      else {
        const d3 = plan2.slots?.[0]?.meta?.directions?.[3];
        const wantGenres = lib2.find((d) => d.key === want)?.genres || [];
        ok(d3?.admin_pick && wantGenres.every((g) => d3.genres.includes(g)), 'the Option 2 planner plays the pick at level 3 of mix 1', JSON.stringify(d3));
        const o3 = plan2.slots?.[1]?.meta?.directions?.[3];
        ok(o3 && o3.title_en !== d3?.title_en, '…and mix 2 a different one', JSON.stringify(o3));
      }
    } catch (e) { ok(false, 'Option 2 planner', e.message); }
    await admin('POST', 'daily-picks', { business_id: businessId, action: 'clear', date: tomorrow });
  }

  // --- 5. coupons ---
  console.log('\n[5] coupons');
  r = await admin('POST', 'coupons', { code: coupon.toLowerCase(), percent_off: 15, note: 'admin API walkthrough' });
  couponMade = r.status === 201;
  ok(r.status === 201 && r.data.coupon?.code === coupon && r.data.coupon.first_month_ils === 170, `create ${coupon} (15% → ₪170 first month)`, JSON.stringify(r.data));
  r = await admin('POST', 'coupons', { code: coupon, percent_off: 15 });
  ok(r.status === 409, 'same code again → 409');
  r = await admin('POST', 'coupons', { code: `${coupon}X`, percent_off: 100 });
  ok(r.status === 400, '100% → 400');
  r = await admin('GET', 'coupons');
  const listed = r.data.coupons?.find((c) => c.code === coupon);
  ok(r.status === 200 && listed?.active === true && listed.uses_paid === 0 && typeof r.data.coupons_enabled === 'boolean', 'listed with usage counts');
  r = await admin('PATCH', 'coupons', { code: coupon, active: false });
  ok(r.status === 200 && r.data.coupon?.active === false, 'switched off');

  // --- 6. Ami's taste bench: save a playlist-type switch (last: it changes the business's type) ---
  console.log('\n[6] taste bench: type switch');
  r = await admin('GET', `taste-bench?id=${businessId}`);
  const fromMode = r.data?.mode;
  const toMode = fromMode === 'option2' ? 'option1' : 'option2';
  const N = r.data?.ctx?.state?.N || 4;
  const appr = r.data?.ctx?.state?.approved || [];
  const library = toMode === 'option2'
    ? [...new Set(appr.map((a) => a.energy_level))].map((L) => ({ energy_level: L, title_en: `Level ${L}`, genres: appr.filter((a) => a.energy_level === L).map((a) => a.genre).slice(0, 3) }))
    : ['high', 'low'].map((tier) => ({ energy_tier: tier, title_en: tier, genres: appr.filter((a) => (a.energy_level > N / 2 ? 'high' : 'low') === tier).map((a) => a.genre).slice(0, 4) }));
  r = await admin('POST', 'taste-bench', { business_id: businessId, ops: [], switch: { mode: toMode, library } });
  ok(r.status === 200 && r.data.switched === toMode, `switch ${fromMode} → ${toMode} saved`, JSON.stringify(r.data).slice(0, 200));
  const st = (await pgr('GET', 'business_v7_settings', { query: { business_id: `eq.${businessId}`, select: 'delivery_mode,timeline' } }))[0];
  ok(st?.delivery_mode === toMode && (toMode === 'option1' || st?.timeline?.groups?.length > 0), `the business is on ${toMode}${toMode === 'option2' ? ', with an energy timeline' : ''}`);
  const libRows = toMode === 'option2'
    ? await pgr('GET', 'business_v7_level_directions', { query: { business_id: `eq.${businessId}`, active: 'is.true', select: 'energy_level,genres,profile_key' } })
    : await pgr('GET', 'business_v7_directions', { query: { business_id: `eq.${businessId}`, active: 'is.true', select: 'energy_tier,genres' } });
  ok(libRows.length > 0 && libRows.every((x) => toMode === 'option1' || x.profile_key), `its ${toMode} library is written (${libRows.length} recipes)`);
  const audit = await pgr('GET', 'business_settings_changes', { query: { business_id: `eq.${businessId}`, field: 'eq.delivery_mode', select: 'before,after' } });
  ok(audit.some((a) => a.before === fromMode && a.after === toMode), "the switch is audited like the owner's own");
  // And back to Option 2 (the path that writes an energy timeline).
  if (toMode === 'option1') {
    const back = [...new Set(appr.map((a) => a.energy_level))]
      .map((L) => ({ energy_level: L, title_en: `Level ${L}`, genres: appr.filter((a) => a.energy_level === L).map((a) => a.genre).slice(0, 3) }));
    r = await admin('POST', 'taste-bench', { business_id: businessId, ops: [], switch: { mode: 'option2', library: back } });
    const st2 = (await pgr('GET', 'business_v7_settings', { query: { business_id: `eq.${businessId}`, select: 'delivery_mode,timeline' } }))[0];
    const lv2 = await pgr('GET', 'business_v7_level_directions', { query: { business_id: `eq.${businessId}`, active: 'is.true', select: 'profile_key' } });
    ok(r.status === 200 && st2?.delivery_mode === 'option2' && st2?.timeline?.groups?.length > 0 && lv2.length > 0 && lv2.every((x) => x.profile_key),
      `back to option2: timeline (${st2?.timeline?.groups?.length} groups) + level library (${lv2.length} recipes)`);
  }
} catch (e) {
  console.error('\nERROR', e.message);
  failed++;
} finally {
  console.log('\n[cleanup]');
  try {
    if (businessId) {
      await pgr('DELETE', 'admin_actions', { query: { business_id: `eq.${businessId}` } }).catch(() => {});
      await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } });
    }
    if (couponMade) {
      await pgr('DELETE', 'admin_actions', { query: { action: 'like.coupon:*', 'detail->>code': `eq.${coupon}` } }).catch(() => {});
      await pgr('DELETE', 'payment_coupons', { query: { code: `eq.${coupon}` } });
    }
    if (userId) await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: HDR });
    console.log('  throwaway business, user and coupon deleted');
  } catch (e) { console.error('  cleanup failed:', e.message); }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
}
