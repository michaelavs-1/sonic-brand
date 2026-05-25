// GPT fallback flow for businesses that the matcher can't pair with a usable
// Data Box row. Two trigger conditions (see shouldFallback below):
//   - matcher returned matched: false (hard no-match)
//   - matcher returned matched: true but every matched row has no playlists
//
// Flow:
//   classifier GPT → public-facing? → song-gen GPT (120 candidates) →
//   Spotify search per candidate → track-analysis API per Spotify ID →
//   split at energy 60 → shuffle + slice 30 from each pool → create 2 playlists.

const CLASSIFIER_MODEL       = 'gpt-5.4';
const GENERATOR_MODEL        = 'gpt-5.4';
// GPT proposes two explicitly-labeled groups (bimodal). Energy split is enforced
// upstream by the prompt, then refined downstream by API energy ranking.
const TARGET_PER_GROUP       = 40;
const TARGET_PER_PL          = 30;   // ceiling on final playlist size; we ship fewer if fewer survive
const SPOTIFY_CONCURRENCY    = 8;
const ANALYSIS_CONCURRENCY   = 4;
const ANALYSIS_RATE_PER_SEC  = 4;

const CLASSIFIER_MAX_TOKENS  = 200;
const GENERATOR_MAX_TOKENS   = 6000;

// ---------- public ----------

export function shouldFallback(matchResult) {
  if (!matchResult || matchResult.matched === false) return true;
  const rows = Array.isArray(matchResult.rows) ? matchResult.rows : [];
  if (!rows.length) return true;
  return rows.every(r => !Array.isArray(r?.playlists) || r.playlists.length === 0);
}

export async function generateFromGPT(userInput, dataBoxRows, bizName = null) {
  const input = typeof userInput === 'string' ? userInput.trim() : '';
  if (!input) return { matched: false, reason: 'empty_input' };

  // Step 1 — public-facing classifier
  let classifier;
  try {
    classifier = await classifyIsPublicFacingVenue(input);
  } catch (e) {
    return { matched: false, reason: 'error', error: `classifier: ${e.message}` };
  }
  if (!classifier.isPublicFacingMusicVenue) {
    return { matched: false, reason: 'not_public_facing', reasoning: classifier.reasoning };
  }

  // Step 2 — atmosphere + bimodal candidate tracks
  const mixGuideline = buildMixGuideline(dataBoxRows);
  let generated;
  try {
    generated = await generateAtmosphereAndTracks(input, mixGuideline);
  } catch (e) {
    return { matched: false, reason: 'error', error: `generator: ${e.message}` };
  }
  const atmosphere = String(generated?.atmosphere || '').trim();
  const { calm: calmCandidates, energetic: energCandidates } = dedupeBimodal(
    Array.isArray(generated?.calm_tracks)      ? generated.calm_tracks      : [],
    Array.isArray(generated?.energetic_tracks) ? generated.energetic_tracks : [],
  );

  // Step 3 — Spotify search (combined for efficiency; group tag carried through)
  const allCandidates = [...calmCandidates, ...energCandidates];
  const searchTasks = allCandidates.map(t => () =>
    resolveSpotifyId(t).then(r => r ? { ...r, group: t.group } : null).catch(() => null)
  );
  const searched = await runWithConcurrency(searchTasks, SPOTIFY_CONCURRENCY);
  const resolved = searched.filter(Boolean);

  // Step 4 — track-analysis per Spotify ID (rate-limited; group tag preserved)
  const analysisTasks = resolved.map(s => () =>
    analyzeEnergy(s.id).then(a => (a && typeof a.energy === 'number') ? { ref: s, energy: a.energy } : null).catch(() => null)
  );
  const analyzed = await runWithRateLimit(analysisTasks, {
    concurrency: ANALYSIS_CONCURRENCY,
    perSecond:   ANALYSIS_RATE_PER_SEC,
  });

  const calmAnalyzed = []; const energAnalyzed = [];
  for (const a of analyzed) {
    if (!a) continue;
    const entry = { id: a.ref.id, name: a.ref.name, energy: a.energy };
    if      (a.ref.group === 'calm')      calmAnalyzed.push(entry);
    else if (a.ref.group === 'energetic') energAnalyzed.push(entry);
  }
  calmAnalyzed.sort((x, y) => x.energy - y.energy);   // ascending — lowest energy first
  energAnalyzed.sort((x, y) => y.energy - x.energy);  // descending — highest energy first

  const calmFinal = calmAnalyzed.slice(0, TARGET_PER_PL);
  const energFinal = energAnalyzed.slice(0, TARGET_PER_PL);

  const stats = {
    proposedCalm:             calmCandidates.length,
    proposedEnergetic:        energCandidates.length,
    spotifyResolvedCalm:      resolved.filter(r => r.group === 'calm').length,
    spotifyResolvedEnergetic: resolved.filter(r => r.group === 'energetic').length,
    energyResolvedCalm:       calmAnalyzed.length,
    energyResolvedEnergetic:  energAnalyzed.length,
    finalCalm:                calmFinal.length,
    finalEnergetic:           energFinal.length,
    calmEnergyRange:          calmFinal.length  ? [calmFinal[0].energy,  calmFinal[calmFinal.length - 1].energy]   : null,
    energeticEnergyRange:     energFinal.length ? [energFinal[energFinal.length - 1].energy, energFinal[0].energy] : null,
  };

  if (!calmFinal.length && !energFinal.length) {
    return {
      matched: false,
      reason: 'no_tracks_resolved',
      atmosphere,
      reasoning: classifier.reasoning,
      stats,
    };
  }

  // Step 5 — create the playlists. Either side may be empty; buildPlaylistsFromTrackIds
  // skips that side and returns null for it.
  const displayName = (typeof bizName === 'string' && bizName.trim()) ? bizName.trim() : atmosphere;

  try {
    const { calm: calmPl, energetic: energPl } = await buildPlaylistsFromTrackIds(
      calmFinal.map(t => t.id),
      energFinal.map(t => t.id),
      displayName,
    );
    return {
      matched: true,
      atmosphere,
      reasoning: classifier.reasoning,
      calm:      calmPl,
      energetic: energPl,
      stats,
    };
  } catch (e) {
    return { matched: false, reason: 'error', error: `playlist_build: ${e.message}`, stats };
  }
}

export async function buildPlaylistsFromTrackIds(calmIds, energeticIds, displayName) {
  const ds = dateSuffix();
  const calmHas = Array.isArray(calmIds) && calmIds.length;
  const energHas = Array.isArray(energeticIds) && energeticIds.length;
  if (!calmHas && !energHas) throw new Error('both calmIds and energeticIds are empty');
  const calm      = calmHas  ? await createAndFillPlaylist(`${displayName} · רגוע · ${ds}`,    displayName, calmIds)      : null;
  const energetic = energHas ? await createAndFillPlaylist(`${displayName} · אנרגטי · ${ds}`, displayName, energeticIds) : null;
  return { calm, energetic };
}

// ---------- GPT calls ----------

async function classifyIsPublicFacingVenue(userInput) {
  const system = `You are a strict classifier. The user describes a business they are opening. Decide whether it is a PUBLIC-FACING PHYSICAL VENUE WHERE CUSTOMERS HEAR CURATED BACKGROUND MUSIC.

REQUIREMENTS for "yes" — ALL must hold:
(1) Customers are physically present at a fixed location.
(2) The business plays music in the background for those customers.
(3) The music shapes the customer experience (it is not incidental noise).

YES examples: bars, cafés, restaurants, hair salons, clothing stores, gyms, hotel lobbies, boutique retail, bookshops, ice-cream parlors, dental waiting areas, bike shops, pet grooming salons.

NO examples: tech startups, software companies, B2B agencies, online-only businesses, factories, warehouses, logistics, construction sites, accounting firms, law offices without customer-facing waiting rooms, residential homes, yoga or meditation studios (their music is functional, not background — explicitly excluded to stay consistent with the matcher).

If unsure, prefer "no". A "no" returns gracefully; a wrong "yes" wastes a 120-track GPT call.

Respond with STRICT JSON: {"isPublicFacingMusicVenue": <true|false>, "reasoning": "<one short Hebrew sentence>"}`;

  const user = `תיאור העסק: "${userInput}"\n\nהחזר JSON מחמיר.`;

  const parsed = await callOpenAI({
    model: CLASSIFIER_MODEL,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  return {
    isPublicFacingMusicVenue: parsed?.isPublicFacingMusicVenue === true,
    reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : '',
  };
}

async function generateAtmosphereAndTracks(userInput, mixGuideline) {
  const system = `You are a Hebrew music-curation expert. The user describes a public-facing physical venue (bar, café, shop, salon, restaurant, clinic — somewhere customers spend time and hear background music). The venue is NOT in our curated catalog, so you must propose tracks from scratch.

STEP 1 — Infer the atmosphere. In one short Hebrew phrase, describe the musical atmosphere this venue needs. Use the same vocabulary our curated catalog uses ("צעיר", "אינטימי", "מודרני", "אלגנטי", "שמח", "רגוע", "תוסס", "יוקרתי", "שכונתי", "בוטיק", "משפחתי", "אקלקטי", etc., combined as needed — e.g., "אינטימי וסקסי לערב", "צעיר ותוסס ביום שישי").

STEP 2 — Propose tracks in TWO clearly distinct energy groups, both fitting the SAME atmosphere:

  - calm_tracks: EXACTLY ${TARGET_PER_GROUP} tracks with LOW energy. Mellow, intimate, lower BPM, often acoustic or stripped-back. Music that fades into the background of a quiet conversation. Aim for a Spotify-style "energy" score in the rough range of 0-50.

  - energetic_tracks: EXACTLY ${TARGET_PER_GROUP} tracks with HIGH energy. Upbeat, danceable, higher BPM, fuller instrumentation, more drive. Music that lifts the mood and energizes the space. Aim for a Spotify-style "energy" score in the rough range of 70-100.

Both groups belong to the SAME venue at different moments — its calm hours vs. its energetic hours. A wine bar's calm group is smooth jazz; its energetic group is upbeat bossa nova or vintage soul, NOT heavy metal. A children's clothing store's calm group is acoustic indie folk; its energetic group is upbeat Disney-style pop, NOT EDM. The two groups must feel cohesive when listened to back-to-back.

RULES:
- Real tracks only. No invented titles. No remixes / covers you are not confident exist.
- Prefer recognizable, established tracks over obscure ones — but include some niche tracks to avoid a generic feel.
- Mix Hebrew and foreign tracks to roughly match this distribution observed across our curated catalog: ${mixGuideline}.
- Avoid duplicates within a group AND across groups (no track in both).
- Do NOT include track IDs, URLs, or commentary per track — just title + artist.

Respond with STRICT JSON:
{
  "atmosphere": "<one short Hebrew phrase>",
  "calm_tracks":      [{"title": "<exact track title>", "artist": "<primary artist name>"}, ... exactly ${TARGET_PER_GROUP} items],
  "energetic_tracks": [{"title": "<exact track title>", "artist": "<primary artist name>"}, ... exactly ${TARGET_PER_GROUP} items]
}`;

  const user = `תיאור העסק: "${userInput}"\n\nהחזר JSON מחמיר עם בדיוק ${TARGET_PER_GROUP} שירים רגועים ו-${TARGET_PER_GROUP} שירים אנרגטיים.`;

  return await callOpenAI({
    model: GENERATOR_MODEL,
    max_tokens: GENERATOR_MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
}

async function callOpenAI({ model, messages, max_tokens }) {
  const r = await fetch('/api/new/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, max_tokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`openai ${r.status}: ${err.error?.message || err.error || r.statusText}`);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('openai: empty completion');
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('gpt_invalid_json');
  }
}

// ---------- track resolution ----------

async function resolveSpotifyId({ title, artist }) {
  const r = await fetch('/api/new/spotify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'search_track', title, artist }),
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  if (!data?.found || !data.id) return null;
  return { id: data.id, name: data.name, artists: data.artists };
}

async function analyzeEnergy(spotifyId) {
  const r = await fetch('/api/new/track-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'analyze_track', spotify_id: spotifyId }),
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  if (!data?.found || typeof data.energy !== 'number') return null;
  return data;
}

// ---------- helpers ----------

function buildMixGuideline(dataBoxRows) {
  const counts = { hebrew: 0, foreign: 0, mixed: 0, other: 0 };
  const rows = Array.isArray(dataBoxRows) ? dataBoxRows : [];
  for (const row of rows) {
    const lvl = String(row?.hebrewLevel || '').trim().toLowerCase();
    if (!lvl)                            continue;
    if (lvl.includes('hebrew') && lvl.includes('foreign')) counts.mixed++;
    else if (lvl.includes('hebrew'))     counts.hebrew++;
    else if (lvl.includes('foreign'))    counts.foreign++;
    else if (lvl.includes('עברית') && lvl.includes('לועזית')) counts.mixed++;
    else if (lvl.includes('עברית'))      counts.hebrew++;
    else if (lvl.includes('לועזית'))     counts.foreign++;
    else                                  counts.other++;
  }
  const parts = [];
  if (counts.hebrew)  parts.push(`hebrew=${counts.hebrew}x`);
  if (counts.foreign) parts.push(`foreign=${counts.foreign}x`);
  if (counts.mixed)   parts.push(`mixed=${counts.mixed}x`);
  if (!parts.length) return 'roughly half Hebrew, half foreign';
  return parts.join(', ');
}

// Dedupes within each group AND across groups. If a track appears in both groups
// (GPT slip-up), the calm-group occurrence wins and it's dropped from energetic.
function dedupeBimodal(calmList, energeticList) {
  const seen = new Set();
  const calm = []; const energetic = [];
  const addTo = (bucket, group, list) => {
    for (const t of list) {
      const title  = String(t?.title  || '').trim();
      const artist = String(t?.artist || '').trim();
      if (!title || !artist) continue;
      const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.push({ title, artist, group });
    }
  };
  addTo(calm,      'calm',      calmList);
  addTo(energetic, 'energetic', energeticList);
  return { calm, energetic };
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickFinal(pool, n) {
  if (pool.length <= n) return pool.slice();
  return shuffle(pool).slice(0, n);
}

async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  const n = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function runWithRateLimit(tasks, { concurrency, perSecond }) {
  const results = new Array(tasks.length);
  const intervalMs = 1000 / perSecond;
  let nextIdx = 0;
  let nextLaunchAt = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= tasks.length) return;
      const wait = Math.max(0, nextLaunchAt - Date.now());
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      nextLaunchAt = Math.max(Date.now(), nextLaunchAt) + intervalMs;
      results[i] = await tasks[i]();
    }
  }
  const n = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ---------- playlist creation ----------

async function postSpotify(action, body) {
  const r = await fetch('/api/new/spotify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || r.statusText;
    throw new Error(`spotify ${action} ${r.status}: ${msg}`);
  }
  return data;
}

function dateSuffix() {
  const d = new Date();
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

async function createAndFillPlaylist(name, description, trackIds) {
  if (!trackIds.length) throw new Error(`No tracks to add for playlist "${name}"`);
  const playlist = await postSpotify('create_playlist', { name, description });
  if (!playlist?.id) throw new Error(`create_playlist returned no id (${name})`);
  await postSpotify('add_tracks', {
    playlist_id: playlist.id,
    uris: trackIds.map(id => `spotify:track:${id}`),
  });
  return {
    id: playlist.id,
    url: playlist.external_urls?.spotify || '',
    trackCount: trackIds.length,
  };
}
