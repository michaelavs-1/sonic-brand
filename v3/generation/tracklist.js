import { buildTrackPool } from './pool.js';
import { selectFromPool } from './selector.js';
import { generateCandidates, validateOnSpotify } from './fallback.js';
import { buildBrainContext, assembleBrainBlocks } from './brain/index.js';
import { dislikedArtistsFromFeedback, applyDiversityFilter, fillToTarget } from './diversity.js';

export async function generateTracklist(energyLevel, input, opts, deps) {
  const attempt = (opts && opts.attempt) || 0;
  const excludeIds = (opts && opts.excludeIds) || new Set();
  const onProgress = (opts && opts.onProgress) || (() => {});

  const label = energyLevel === 1 ? '🌙 רגוע' : '🔥 מקפיץ';
  const faders = input.faders;
  const moods = Array.from(input.selectedMoods || []);

  const l0Match = input.useDataBox && deps.matchDataBox
    ? deps.matchDataBox(input.bizDesc)
    : null;

  let pool = [];
  if (l0Match) {
    onProgress(`${label} — בונה בריכת שירים מהטבלה…`, '');
    pool = await buildTrackPool(l0Match, energyLevel);
  }

  if (excludeIds.size > 0) {
    pool = pool.filter(t => !excludeIds.has(t.id));
  }

  let tracks = [];
  if (pool.length >= 20) {
    onProgress(`${label} — GPT בוחר מ-${pool.length} שירים…`, '');
    tracks = await selectFromPool(pool, faders, moods, energyLevel, {
      bizDesc: input.bizDesc,
      bizType: input.bizType,
      generatedHistory: input.generatedHistory,
    }, { apiKey: deps.apiKey, model: deps.model });
    if (input.generatedHistory) {
      tracks.forEach(t => { if (t.id) input.generatedHistory.add(t.id); });
    }
  }

  if (tracks.filter(t => t.id).length < 20) {
    onProgress(`${label} — משלים עם ניתוח GPT…`, '');
    const brainCtx = await buildBrainContext({
      bizDesc: input.bizDesc,
      bizType: input.bizType,
      energyLevel,
      selectedMoods: input.selectedMoods,
      selectedUserPlaylists: input.selectedUserPlaylists,
      refPlaylist: input.refPlaylist,
      useDataBox: input.useDataBox,
    }, {
      sb: deps.sb,
      apiKey: deps.apiKey,
      model: deps.model,
      getSpotifyToken: deps.getSpotifyToken,
      matchDataBox: deps.matchDataBox,
    });
    const brainBlocks = assembleBrainBlocks(brainCtx, { bizType: input.bizType });

    const candidates = await generateCandidates(faders, moods, {
      bizDesc: input.bizDesc,
      bizType: input.bizType,
      energyLevel,
      hours: input.hours,
      refPlaylist: input.refPlaylist,
      feedback: input.feedback,
      brainBlocks,
      faderDescriptions: input.faderDescriptions,
      modelIsNew: deps.modelIsNew,
    }, {
      attempt,
      exclude: tracks.map(t => `${t.artist} — ${t.title}`),
    }, { apiKey: deps.apiKey, model: deps.model });

    onProgress(`${label} — מאמת ב-Spotify…`, `${candidates.length} מועמדים`);
    const validated = await validateOnSpotify(candidates, { onProgress }, { fallbackToken: deps.spotifyToken });
    const usedIds = new Set(tracks.map(t => t.id).filter(Boolean));
    tracks = [...tracks, ...validated.filter(t => t.id && !usedIds.has(t.id))].slice(0, 30);
  }

  const disliked = dislikedArtistsFromFeedback(input.feedback);
  const { tracks: diverse, artistCounts } = applyDiversityFilter(tracks, { disliked });
  if (diverse.length < 28 && pool.length > 0) {
    fillToTarget(diverse, pool, { disliked, artistCounts });
  }

  return diverse.slice(0, 30);
}
