/* scripts/_v7-taste-chat-walkthrough.mjs
 *
 * Live E2E for the v7 taste chat ("הטעם המוזיקלי שלכם", 2026-10-13) against
 * `vercel dev` → prod Supabase + Gemini. Self-cleaning: one throwaway
 * @example.invalid user + v7 business (Option 1, a fixed taste profile and
 * recipe library), deleted at the end with everything it created. Builds NO
 * playlists (nothing on Spotify).
 *
 * Checks (the model's wording varies — replies are printed; the checks look
 * at what was proposed and what got written):
 *   1. "too much funk" → a proposal lowering Funk (weight or recipes) → apply
 *      → the profile / library changed, a change-log row exists;
 *   2. "the energetic playlists are too energetic" → shift_window high -10 →
 *      apply → energy_windows.high = [40, 70];
 *   3. "undo" → the windows are back to the defaults;
 *   4. "something new" → suggestions; the deck's results ("[תוצאות ההאזנה]
 *      אהבתי: …") → a proposal adding the liked genre → apply → approved and
 *      placed in a recipe; the deck's dislike (action "reject") → turned down;
 *   5. a Spotify link of a catalog song + "add it" → allow_track → a
 *      business_allowed_tracks row (an analysed song — no email to Roni);
 *   6. Option 2 (a fake "today's mix" row, nothing on Spotify; only while the
 *      test venue is open, 08:00–23:00 IL): a song "playing now" that was
 *      planned 2 hours ago → the chat asks about shuffle / the late start; a
 *      song playing on time but too energetic → a fix (the recipe's range,
 *      the genre's level, or the curve);
 *   every reply: plural only, never "כיוון" / "direction".
 * ~11 Gemini calls. Takes ~3–6 minutes.
 *
 * Usage (PowerShell, env loaded from .env.local as in CLAUDE.md):
 *   node scripts/_v7-taste-chat-walkthrough.mjs
 * Needs migration v5/precompute/migrations/2026-10-13-v7-taste-chat.sql.
 */

const DEV_BASE     = `http://127.0.0.1:${process.env.DEV_PORT || '3000'}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
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

const SINGULAR_RE = /(^|[\s,.!?"'(])(אתה|הגעת|תרצה|חזור|תחזור|לחץ|תוכל|תכתוב|ספר לי|תשלח|שלח לי)(?=$|[\s,.!?"')])/;
const badLanguage = [];
let session = new Date().toISOString();
async function chat(message) {
  const { status, data } = await api('/api/v7/account/taste-chat', { businessId, message, sessionStartAt: session });
  if (status !== 200) throw new Error(`taste-chat ${status}: ${JSON.stringify(data)}`);
  const p = data.assistantMessage?.parsed || {};
  console.log(`    > ${message}\n    < [${p.state}] ${p.reply_he}`);
  if (p.proposal) console.log(`      ops: ${JSON.stringify(p.proposal.ops)}`);
  if (p.suggestions) console.log(`      suggestions: ${JSON.stringify(p.suggestions)}`);
  if (SINGULAR_RE.test(p.reply_he || '') || /כיוון|כיוונים|שילוב|מיקס|direction/i.test(p.reply_he || '')) badLanguage.push(p.reply_he);
  return { id: data.assistantMessage?.id, ...p };
}
// Ask, and nudge once toward a proposal if the model asked a question first.
async function untilConfirming(message, followUp = 'כן, בדיוק. תכינו את השינוי') {
  let r = await chat(message);
  if (r.state !== 'confirming') r = await chat(followUp);
  return r;
}
const apply = (messageId) => api('/api/v7/account/taste-apply', { businessId, action: 'apply', messageId });
const profile = async () => (await pgr('GET', 'business_taste_profiles', { query: { business_id: `eq.${businessId}`, select: '*' } }))[0];
const settings = async () => (await pgr('GET', 'business_v7_settings', { query: { business_id: `eq.${businessId}`, select: '*' } }))[0];
const library = () => pgr('GET', 'business_v7_directions', { query: { business_id: `eq.${businessId}`, active: 'is.true', select: 'energy_tier,genres' } });

const APPROVED = [
  { genre: 'Funk', energy_level: 4 }, { genre: 'Afro Funk', energy_level: 4 }, { genre: 'Disco', energy_level: 4 },
  { genre: 'Latin Funk', energy_level: 3 }, { genre: 'Acid Jazz', energy_level: 3 },
  { genre: 'Neo Soul', energy_level: 2 }, { genre: 'Bossa Nova', energy_level: 1 }, { genre: 'Jazz (Standards)', energy_level: 1 },
];
const CONDITIONAL = [
  { genre: 'Samba', energy_level: 3, note_en: 'test' }, { genre: 'Cha Cha Cha', energy_level: 3, note_en: 'test' },
  { genre: 'Fado', energy_level: 1, note_en: 'test' }, { genre: 'Italian Funk', energy_level: 4, note_en: 'test' },
];
const LIBRARY = [
  { energy_tier: 'high', title_en: 'Global Funk', genres: ['Funk', 'Afro Funk', 'Latin Funk'] },
  { energy_tier: 'high', title_en: 'Disco Funk', genres: ['Disco', 'Funk'] },
  { energy_tier: 'high', title_en: 'Funk & Acid Jazz', genres: ['Funk', 'Acid Jazz', 'Latin Funk'] },
  { energy_tier: 'low', title_en: 'Jazz & Bossa', genres: ['Jazz (Standards)', 'Bossa Nova'] },
  { energy_tier: 'low', title_en: 'Soul', genres: ['Neo Soul'] },
];
const stamp = Date.now();
const email = `test-v7taste-${stamp}@example.invalid`;
let userId = null;

try {
  // --- setup ---
  console.log('\n[setup] signup + session + Option 1');
  const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { closed: false, open: '08:00', close: '23:00' }]));
  const su = await fetch(`${DEV_BASE}/api/v7/account/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sonic-internal': INTERNAL_KEY, Origin: DEV_BASE },
    body: JSON.stringify({
      email, name: 'קפה בדיקה (taste chat)', description: 'בית קפה שכונתי עם אווירה חמה', musicalEmphases: 'פאנק וסול',
      atmospheres: [], place: null, hours, longestMinutes: 900, superLikedTracks: [],
      onboardingSessionId: `v7taste-${stamp}`, skipEmail: true,
      tasteProfile: { energy_levels_total: 4, approved_genres: APPROVED, conditional_genres: CONDITIONAL, instrumentalness_preference: 'none', popularity_preference: 'none', reasoning_en: 'test' },
    }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  if (!su.data.business_id) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.data)}`);
  businessId = su.data.business_id;
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: HDR, body: JSON.stringify({ type: 'magiclink', email }) }).then((r) => r.json());
  const ver = await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: gen?.hashed_token || gen?.properties?.hashed_token }) }).then((r) => r.json());
  token = ver.access_token; userId = ver.user?.id;
  ok(!!token, 'owner session minted');
  const mode = await api('/api/v7/account/set-delivery-mode', { business_id: businessId, delivery_mode: 'option1' });
  ok(mode.status === 200, 'delivery mode option1', JSON.stringify(mode.data));
  const rank = { high: 0, low: 0 };
  await pgr('POST', 'business_v7_directions', { body: LIBRARY.map((d) => ({ ...d, business_id: businessId, rank: ++rank[d.energy_tier], active: true })) });

  try { await pgr('GET', 'business_taste_changes', { query: { select: 'id', limit: '1' } }); }
  catch { throw new Error('business_taste_changes missing — run migration 2026-10-13-v7-taste-chat.sql first'); }

  // --- 1. less funk ---
  console.log('\n[1] too much funk');
  const before1 = await profile();
  const lib1 = await library();
  const p1 = await untilConfirming('יש לי יותר מדי פאנק בפלייליסטים');
  ok(p1.state === 'confirming' && p1.proposal?.ops?.some((o) => /Funk/.test(o.genre || '')), 'a proposal touching Funk', JSON.stringify(p1.proposal));
  if (p1.state === 'confirming') {
    const a1 = await apply(p1.id);
    ok(a1.status === 200, 'applied', JSON.stringify(a1.data));
    const after1 = await profile();
    const lib1b = await library();
    const funkIn = (lib) => lib.filter((d) => d.genres.includes('Funk')).length;
    ok((after1.genre_weights?.Funk ?? 1) < 1 || funkIn(lib1b) < funkIn(lib1) || !after1.approved_genres.some((a) => a.genre === 'Funk'),
      'Funk plays less (weight down, fewer recipes, or removed)', JSON.stringify({ w: after1.genre_weights, lib: lib1b }));
    const changes = await pgr('GET', 'business_taste_changes', { query: { business_id: `eq.${businessId}`, select: 'id,summary_he,ops' } });
    ok(changes.length === 1, `change logged: ${changes[0]?.summary_he}`);
    const again = await apply(p1.id);
    ok(again.status === 409, 'applying the same proposal twice → 409');
    void before1;
  }

  // --- 2. energetic playlists too energetic ---
  console.log('\n[2] the energetic playlists are too energetic');
  const p2 = await untilConfirming('הפלייליסטים האנרגטיים אנרגטיים מדי בשבילנו');
  const shift = p2.proposal?.ops?.find((o) => o.op === 'shift_window');
  ok(shift?.tier === 'high' && shift?.delta === -10, 'shift_window high -10', JSON.stringify(p2.proposal));
  if (p2.state === 'confirming') {
    const a2 = await apply(p2.id);
    ok(a2.status === 200, 'applied');
    const st = await settings();
    ok(JSON.stringify(st.energy_windows?.high) === '[40,70]', `energy_windows.high = ${JSON.stringify(st.energy_windows?.high)}`);
  }

  // --- 3. undo ---
  console.log('\n[3] undo');
  const p3 = await untilConfirming('תחזירו את זה כמו שהיה');
  ok(p3.proposal?.ops?.length === 1 && p3.proposal.ops[0].op === 'undo', 'an undo proposal', JSON.stringify(p3.proposal));
  if (p3.state === 'confirming') {
    const a3 = await apply(p3.id);
    ok(a3.status === 200 && a3.data.undone, 'undone');
    const st = await settings();
    ok(!st.energy_windows || JSON.stringify(st.energy_windows.high) === '[50,80]', `windows back to default (${JSON.stringify(st.energy_windows)})`);
  }

  // --- 4. something new → deck → add ---
  console.log('\n[4] something new');
  let p4 = await chat('בא לי לשמוע משהו חדש, תפתיעו אותי');
  if (p4.state !== 'suggesting') p4 = await chat('תציעו לי כמה סגנונות חדשים לשמוע');
  ok(p4.state === 'suggesting' && p4.suggestions?.length >= 2, 'suggestions', JSON.stringify(p4.suggestions));
  if (p4.suggestions?.length >= 2) {
    const approvedNow = new Set((await profile()).approved_genres.map((a) => a.genre));
    ok(p4.suggestions.every((s) => !approvedNow.has(s.genre)), 'none of them already approved');
    const [like, dislike] = p4.suggestions;
    const rej = await api('/api/v7/account/taste-apply', { businessId, action: 'reject', genres: [dislike.genre] });
    ok(rej.status === 200 && (await profile()).rejected_genres?.includes(dislike.genre), `"${dislike.genre}" turned down`);
    const p4b = await chat(`[תוצאות ההאזנה] אהבתי: ${like.label_he} (${like.genre}). לא בשבילי: ${dislike.label_he} (${dislike.genre}).`);
    const add = p4b.proposal?.ops?.find((o) => o.op === 'add_genre' && o.genre === like.genre);
    ok(p4b.state === 'confirming' && add, `a proposal adding ${like.genre}`, JSON.stringify(p4b.proposal));
    ok(p4b.new_genres?.includes(like.genre), 'flagged as a new genre (the dashboard plays a sample first)');
    if (add) {
      const a4 = await apply(p4b.id);
      ok(a4.status === 200, 'applied');
      ok((await profile()).approved_genres.some((a) => a.genre === like.genre), `${like.genre} approved`);
      ok((await library()).some((d) => d.genres.includes(like.genre)), `${like.genre} in a recipe`);
    }
  }

  // --- 5. a song link ---
  console.log('\n[5] a song the owner loves');
  const pl = await pgr('GET', 'playlist_genres', { query: { genre: 'eq.bossa nova', select: 'playlist_id', limit: '3' } });
  const tracks = await pgr('GET', 'playlist_tracks', { query: { playlist_id: `eq.${pl[0].playlist_id}`, select: 'spotify_id', limit: '20' } });
  const analysed = await pgr('GET', 'track_analyses', { query: { spotify_id: `in.(${tracks.map((t) => `"${t.spotify_id}"`).join(',')})`, status: 'eq.ok', select: 'spotify_id', limit: '1' } });
  const songId = analysed[0]?.spotify_id;
  ok(!!songId, `catalog song ${songId}`);
  if (songId) {
    let p5 = await chat(`אנחנו מאוד אוהבים את השיר הזה https://open.spotify.com/track/${songId}?si=test תוסיפו אותו`);
    if (p5.state !== 'confirming') p5 = await chat('כן, תוסיפו אותו לפלייליסטים שלנו');
    const allow = p5.proposal?.ops?.find((o) => o.op === 'allow_track');
    ok(!!allow, 'allow_track proposed', JSON.stringify(p5.proposal));
    if (allow) {
      const a5 = await apply(p5.id);
      ok(a5.status === 200, 'applied');
      const own = await pgr('GET', 'business_allowed_tracks', { query: { business_id: `eq.${businessId}`, select: 'spotify_id,genre,title' } });
      ok(own.length === 1 && own[0].title, `allowed: "${own[0]?.title}" under ${own[0]?.genre}`);
    }
  }

  // --- 6. Option 2: a song that feels wrong right now ---
  console.log('\n[6] Option 2');
  const il = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const nowMin = Number(il.slice(0, 2)) * 60 + Number(il.slice(3, 5));
  if (nowMin < 8 * 60 + 250 || nowMin > 22 * 60 + 50) {
    console.log(`  (skipped — the test venue opens 08:00–23:00 and the fake mix needs 4 hours behind now; it's ${il} IL)`);
  } else {
    session = new Date().toISOString();
    await pgr('PATCH', 'business_v7_settings', { query: { business_id: `eq.${businessId}` }, body: { delivery_mode: 'option2' } });
    const lvl = { 4: ['Funk', 'Afro Funk', 'Disco', 'Italian Funk'], 3: ['Latin Funk', 'Acid Jazz'], 2: ['Neo Soul'], 1: ['Bossa Nova', 'Jazz (Standards)'] };
    await pgr('POST', 'business_v7_level_directions', { body: Object.entries(lvl).map(([L, genres]) => ({ business_id: businessId, energy_level: Number(L), rank: 1, title_en: `L${L}`, genres, active: true })) });
    // 70 analysed Neo Soul songs, 4 minutes apart, started 4 hours ago.
    const nsPl = await pgr('GET', 'playlist_genres', { query: { genre: 'eq.neo soul', select: 'playlist_id', limit: '6' } });
    const nsTr = await pgr('GET', 'playlist_tracks', { query: { playlist_id: `in.(${nsPl.map((x) => `"${x.playlist_id}"`).join(',')})`, select: 'spotify_id', limit: '400' } });
    const an = await pgr('GET', 'track_analyses', { query: { spotify_id: `in.(${[...new Set(nsTr.map((t) => t.spotify_id))].slice(0, 300).map((x) => `"${x}"`).join(',')})`, status: 'eq.ok', select: 'spotify_id,energy', limit: '300' } });
    const hot = an.filter((t) => t.energy >= 66);
    const rest = an.filter((t) => t.energy < 66);
    if (hot.length < 1 || rest.length < 69) { console.log('  (skipped — not enough Neo Soul songs)'); }
    else {
      const ids = rest.slice(0, 70).map((t) => t.spotify_id);
      const energies = rest.slice(0, 70).map((t) => t.energy);
      ids[60] = hot[0].spotify_id; energies[60] = hot[0].energy;   // planned for right now
      const offId = ids[20];                                          // planned 2 hours ago
      const start0 = nowMin - 240;
      const starts = ids.map((_, i) => start0 + 4 * i);
      const fakeId = `walkthrough${stamp}`;
      await pgr('POST', 'business_playlists', { body: {
        spotify_id: fakeId, business_id: businessId, url: '', label: 'Daily Mix #1', ico: '🎵', track_count: ids.length, genres: ['Neo Soul'],
        expansion: { v7_timeline: { v: 2, window: [start0, start0 + 4 * ids.length], starts, levels: ids.map(() => 2), run_genres: ids.map(() => 'Neo Soul'), energies,
          directions: { 2: { id: null, title_en: 'L2', genres: ['Neo Soul'], energy_range: null } }, energy_windows: { 2: [30, 60] } } },
        event_id: null, direction_id: null, track_ids: ids, expanded_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(),
      } });
      const ask = await chat('השיר שמתנגן לנו כרגע רגוע מדי');
      ok(/קישור/.test(ask.reply_he || '') && !/כדי שנוכל|כדי לבדוק|נבדוק/.test(ask.reply_he || ''), 'asks for the link plainly, no "so we can check"', ask.reply_he);
      session = new Date().toISOString();
      const off = await chat(`השיר הזה מתנגן אצלנו עכשיו ומרגיש אנרגטי מדי https://open.spotify.com/track/${offId}`);
      ok(/ערבוב|shuffle|מאוחר|דלגו|לדלג|השיר הראשון|שעת הפתיחה/i.test(off.reply_he || '') && off.state !== 'confirming',
        'a song 2 hours off the clock → shuffle / late start, no change proposed', off.reply_he);
      session = new Date().toISOString();
      let onTime = await chat(`עכשיו מתנגן אצלנו השיר הזה והוא אנרגטי מדי בשבילנו https://open.spotify.com/track/${hot[0].spotify_id}`);
      if (onTime.state !== 'confirming' && !onTime.timeline_hint) onTime = await chat('כן, אנחנו מנגנים לפי הסדר ובלי ערבוב. מה אפשר לעשות?');
      const fix = onTime.proposal?.ops?.find((o) => ['set_range', 'move_genre', 'dir_remove'].includes(o.op));
      ok(!!fix || !!onTime.timeline_hint, `a song on time but too energetic → a fix (${fix?.op || (onTime.timeline_hint ? 'curve' : 'none')})`, JSON.stringify(onTime));
      if (fix?.op === 'set_range') {
        const a6 = await apply(onTime.id);
        const rows = await pgr('GET', 'business_v7_level_directions', { query: { business_id: `eq.${businessId}`, energy_level: 'eq.2', select: 'energy_range' } });
        ok(a6.status === 200 && rows.some((r) => Array.isArray(r.energy_range)), `range set: ${JSON.stringify(rows.map((r) => r.energy_range))}`);
      }
      await pgr('DELETE', 'business_playlists', { query: { spotify_id: `eq.${fakeId}` } });
    }
  }

  ok(!badLanguage.length, 'replies in the plural, never mentioning "directions" / "combinations"', badLanguage.join(' | '));
} catch (e) {
  console.error('\nABORTED:', e.message);
  failed++;
} finally {
  console.log('\n[cleanup]');
  try {
    if (businessId) await pgr('DELETE', 'businesses', { query: { id: `eq.${businessId}` } });
    if (userId) await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: HDR });
    console.log('  throwaway business + user deleted');
  } catch (e) { console.error('  cleanup failed:', e.message); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
