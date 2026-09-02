/* /api/v6/account/preview-direction.js
   One-track preview source for the direction-edit modal.

   Given a direction spec (either an existing direction resolved by
   direction_id, or an inline spec proposed by the chat's edit/add flow),
   returns ONE random Spotify track that matches — round-robin across the
   direction's genres over successive calls so the "שמעו שיר אחר מהכיוון
   הזה" button gives the owner one track per genre before repeating.

   The client passes:
     - directionId + (optional) updates    → server merges updates into the
                                              stored direction spec.
     - inlineSpec                          → server uses it as-is (add flow).
   Plus an optional excludeSpotifyIds list (tracks already shown on this
   card) so successive picks don't repeat.

   Response:
     { ok: true, spotifyId, genre, mergedSpec }
       spotifyId  = the picked track's Spotify id
       genre      = which genre from the spec produced the track
       mergedSpec = the spec after applying any updates — useful for the
                    client to display the "if you like this, we'll rebuild
                    with this spec" summary in the modal.
     { ok: false, error }
       (Usually: no track in the entire pool matched. Owner is told and
       falls back to the chat.)

   Auth: JWT + business ownership. Rate-limited under a shared bucket
   ('anchor-tracks', 60/min) with the underlying RPC.
*/

import { pgrRpc, pgrSelect } from '../../v5/supabase-client.js';
import { requireBusinessOwner } from './_require-business-owner.js';
import { setCors } from '../origin-guard.js';
import { guard } from '../ratelimit.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;

// How many tracks to fetch per genre pass — small so the query stays snappy
// (the RPC's ORDER BY random() gets more expensive with LIMIT).
const POOL_SIZE_PER_GENRE = 20;

async function verifyUser(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? user : null;
}

// Apply an edit-proposal `updates` blob to an existing direction row,
// producing the spec the preview should be built from. Mutations mirror
// what apply-direction-change will eventually persist — genres get
// spliced by exclude/add, bpm+inst+title+description overwrite.
function mergeUpdates(dir, updates) {
  const merged = {
    id:                          dir.id,
    title_en:                    dir.title_en,
    description_he:              dir.description_he,
    genres:                      Array.isArray(dir.genres) ? [...dir.genres] : [],
    bpm_range:                   dir.bpm_range,
    instrumentalness_preference: dir.instrumentalness_preference || 'none',
    popularity_preference:       dir.popularity_preference       || 'none',
  };
  if (!updates) return merged;
  if (Array.isArray(updates.exclude_genres) && updates.exclude_genres.length) {
    const drop = new Set(updates.exclude_genres.map((g) => String(g).toLowerCase()));
    merged.genres = merged.genres.filter((g) => !drop.has(String(g).toLowerCase()));
  }
  if (Array.isArray(updates.add_genres) && updates.add_genres.length) {
    const seen = new Set(merged.genres.map((g) => String(g).toLowerCase()));
    for (const g of updates.add_genres) {
      if (typeof g === 'string' && g.length && !seen.has(g.toLowerCase())) {
        merged.genres.push(g);
        seen.add(g.toLowerCase());
      }
    }
  }
  if (updates.bpm_range && Number.isFinite(updates.bpm_range.min) && Number.isFinite(updates.bpm_range.max)) {
    merged.bpm_range = { min: Math.round(updates.bpm_range.min), max: Math.round(updates.bpm_range.max) };
  }
  if (updates.instrumentalness_preference === 'none'
      || updates.instrumentalness_preference === 'soft'
      || updates.instrumentalness_preference === 'hard') {
    merged.instrumentalness_preference = updates.instrumentalness_preference;
  }
  if (updates.popularity_preference === 'none'
      || updates.popularity_preference === 'soft'
      || updates.popularity_preference === 'hard') {
    merged.popularity_preference = updates.popularity_preference;
  }
  if (typeof updates.title_en === 'string' && updates.title_en.trim().length) {
    merged.title_en = updates.title_en.trim();
  }
  if (typeof updates.description_he === 'string' && updates.description_he.trim().length) {
    merged.description_he = updates.description_he.trim();
  }
  return merged;
}

function specFromInline(spec) {
  return {
    id:                          null,
    title_en:                    typeof spec.title_en === 'string' ? spec.title_en.trim() : '',
    description_he:              typeof spec.description_he === 'string' ? spec.description_he.trim() : '',
    genres:                      Array.isArray(spec.genres) ? spec.genres.filter((g) => typeof g === 'string' && g.length) : [],
    bpm_range:                   spec.bpm_range || null,
    instrumentalness_preference: (spec.instrumentalness_preference === 'soft' || spec.instrumentalness_preference === 'hard')
                                   ? spec.instrumentalness_preference : 'none',
    popularity_preference:       (spec.popularity_preference       === 'soft' || spec.popularity_preference       === 'hard')
                                   ? spec.popularity_preference       : 'none',
  };
}

// Walk the genres in a rotating cycle starting at `startIdx`, fetching a
// small pool per genre and returning the first track not in `excludeSet`.
// If nothing new lands with the direction's BPM, retry with a wide window
// ([0..300] BPM) — same "widen fallback" the client swap button uses in
// onboarding. Popularity is controlled per-spec via pop_pref (no more
// atmosphere-derived window — removed 2026-09-02); base pool is [0,100].
async function pickTrackRoundRobin({ spec, excludeSet, startIdx }) {
  const genres = spec.genres || [];
  if (!genres.length) return null;

  const inst = (spec.instrumentalness_preference === 'hard' || spec.instrumentalness_preference === 'soft')
    ? spec.instrumentalness_preference : 'none';
  const popPref = (spec.popularity_preference === 'hard' || spec.popularity_preference === 'soft')
    ? spec.popularity_preference : 'none';

  async function tryGenre(genre, bpmLo, bpmHi) {
    // Popularity window fixed at [0, 100] — the atmosphere-derived window
    // was removed 2026-09-02. pop_pref='hard' narrows to [60, 100] inside
    // the RPC; 'soft' biases hits via ORDER BY.
    const rows = await pgrRpc('v5_anchor_tracks', {
      p_specs: [{ rank: 1, genre, bpm_lo: bpmLo, bpm_hi: bpmHi, inst_pref: inst, pop_pref: popPref }],
      p_pop_lo: 0,
      p_pop_hi: 100,
    }, { useService: true });
    const id = rows?.[0]?.spotify_id;
    if (id && !excludeSet.has(id)) return id;
    // Rare: RPC returned an already-seen id. Try the wider direction-tracks
    // RPC to draw from more of the pool.
    const bulk = await pgrRpc('v5_direction_tracks', {
      p_genres: [genre],
      p_bpm_lo: bpmLo, p_bpm_hi: bpmHi,
      p_pop_lo: 0, p_pop_hi: 100,
      p_limit:  POOL_SIZE_PER_GENRE,
      p_inst_pref: inst,
      p_pop_pref:  popPref,
    }, { useService: true });
    for (const r of bulk || []) {
      if (r?.spotify_id && !excludeSet.has(r.spotify_id)) return r.spotify_id;
    }
    return null;
  }

  const bpmLo = spec.bpm_range && Number.isFinite(spec.bpm_range.min) ? Math.floor(spec.bpm_range.min) : 0;
  const bpmHi = spec.bpm_range && Number.isFinite(spec.bpm_range.max) ? Math.ceil(spec.bpm_range.max)  : 300;

  // Tight pass — respect the direction's BPM.
  for (let step = 0; step < genres.length; step++) {
    const idx = (startIdx + step) % genres.length;
    const g = genres[idx];
    try {
      const id = await tryGenre(g, bpmLo, bpmHi);
      if (id) return { spotifyId: id, genre: g, nextIdx: (idx + 1) % genres.length };
    } catch (e) {
      console.warn(`[preview-direction] tight tryGenre "${g}" failed:`, e.message);
    }
  }

  // Wide pass — drop BPM constraint. Keeps the owner swapping even after
  // the tight pool is exhausted. Popularity is unaffected here — pop_pref
  // still applies via inst/popPref passed to tryGenre.
  for (let step = 0; step < genres.length; step++) {
    const idx = (startIdx + step) % genres.length;
    const g = genres[idx];
    try {
      const id = await tryGenre(g, 0, 300);
      if (id) return { spotifyId: id, genre: g, nextIdx: (idx + 1) % genres.length };
    } catch (e) {
      console.warn(`[preview-direction] wide tryGenre "${g}" failed:`, e.message);
    }
  }

  return null;
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  // Same bucket as the onboarding anchor-tracks endpoint — same RPC, same
  // spend profile, and the client only ever calls one at a time.
  if (!await guard(req, res, 'anchor-tracks', 60, 60)) return;

  try {
    if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { businessId, directionId, updates, inlineSpec, excludeSpotifyIds, cycleIndex } = req.body || {};
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    try { await requireBusinessOwner(businessId, user.id); }
    catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

    // Build the merged spec.
    let mergedSpec;
    if (inlineSpec && typeof inlineSpec === 'object') {
      mergedSpec = specFromInline(inlineSpec);
      if (!mergedSpec.genres.length || !mergedSpec.bpm_range) {
        return res.status(400).json({ error: 'inlineSpec must include genres and bpm_range' });
      }
    } else if (directionId) {
      const rows = await pgrSelect('business_directions',
        { id: `eq.${directionId}`, business_id: `eq.${businessId}` },
        { select: 'id,title_en,description_he,genres,bpm_range,instrumentalness_preference,popularity_preference',
          limit: 1, useService: true });
      const dir = rows?.[0];
      if (!dir) return res.status(404).json({ error: 'direction not found' });
      mergedSpec = mergeUpdates(dir, updates);
      if (!mergedSpec.genres.length) {
        return res.status(400).json({ error: 'no genres left after applying updates' });
      }
    } else {
      return res.status(400).json({ error: 'directionId or inlineSpec required' });
    }

    // Pick a track.
    const excludeSet = new Set(Array.isArray(excludeSpotifyIds) ? excludeSpotifyIds : []);
    const startIdx = Number.isFinite(cycleIndex) ? Math.max(0, Math.floor(cycleIndex)) % Math.max(mergedSpec.genres.length, 1) : 0;
    const pick = await pickTrackRoundRobin({ spec: mergedSpec, excludeSet, startIdx });
    if (!pick) {
      return res.status(200).json({ ok: false, error: 'no track matched', mergedSpec });
    }

    return res.status(200).json({
      ok:         true,
      spotifyId:  pick.spotifyId,
      genre:      pick.genre,
      nextCycleIndex: pick.nextIdx,
      mergedSpec,
    });
  } catch (err) {
    console.error('[preview-direction] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
