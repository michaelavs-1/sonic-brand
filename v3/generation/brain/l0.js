import { getPlaylistTracks, getAudioFeatures, getRecommendations } from '../api.js';
import { analyzeAudioStats } from './audio.js';

export async function fetchL0_DNA(entry, selectedMoods, energyLevel) {
  let playlistIds = [];

  const liveEnergy = entry.liveEnergy || entry.energy || {};
  const lvData = liveEnergy[energyLevel] || liveEnergy[1] || liveEnergy[2] || null;
  if (lvData && Array.isArray(lvData.playlists) && lvData.playlists.length) {
    playlistIds = lvData.playlists;
  } else {
    let pool = Array.isArray(entry.playlists) ? entry.playlists : [];
    if (selectedMoods && selectedMoods.size > 0) {
      const matched = pool.filter(p => Array.isArray(p.moods) && p.moods.some(m => selectedMoods.has(m)));
      if (matched.length >= 2) pool = matched;
    }
    playlistIds = pool.map(p => p.id || p).filter(Boolean);
  }
  if (!playlistIds.length) return null;

  const shuffledPids = playlistIds.slice().sort(() => Math.random() - 0.5);
  const samplePids = shuffledPids.slice(0, Math.min(4, shuffledPids.length));

  const rawTracks = [];
  await Promise.allSettled(samplePids.map(async pid => {
    try {
      const j = await getPlaylistTracks(pid, {
        fields: 'items(track(id,name,artists(id,name),popularity,album(release_date,images)))',
        limit: 50,
        neutral: true,
      });
      const tracks = (j.items || []).map(it => it.track).filter(t => t && t.id);
      rawTracks.push(...tracks.sort(() => Math.random() - 0.5).slice(0, 20));
    } catch (e) {}
  }));

  if (rawTracks.length < 3) return null;

  const seen = new Set();
  const unique = rawTracks.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

  const ids100 = unique.slice(0, 100).map(t => t.id);
  let featureMap = {};
  try {
    const afJson = await getAudioFeatures(ids100, { neutral: true });
    (afJson.audio_features || []).filter(f => f).forEach(f => { featureMap[f.id] = f; });
  } catch (e) {}

  const energyPass = (t) => {
    const f = featureMap[t.id];
    if (!f) return true;
    if (energyLevel === 1) return f.energy < 0.70 && f.tempo < 135;
    if (energyLevel === 2) return f.energy > 0.38 && f.tempo > 88;
    return true;
  };
  const filtered = unique.filter(energyPass);
  const pool = filtered.length >= 5 ? filtered : unique;

  const artistCount = {};
  pool.forEach(t => (t.artists || []).forEach(a => {
    artistCount[a.name] = (artistCount[a.name] || 0) + 1;
  }));
  const sorted = Object.entries(artistCount).sort((a, b) => b[1] - a[1]);
  const topArtists = sorted.slice(0, 6).map(([n]) => n);
  const nicheArtists = sorted.filter(([, c]) => c === 1)
    .sort(() => Math.random() - 0.5).slice(0, 12).map(([n]) => n);

  const features = Object.values(featureMap).filter(f => f);
  const audioStats = features.length ? analyzeAudioStats(features, pool) : null;

  const rnd = pool.slice().sort(() => Math.random() - 0.5);
  const diverseSeeds = [
    ...rnd.filter(t => (t.popularity || 0) >= 60).slice(0, 1).map(t => t.id),
    ...rnd.filter(t => (t.popularity || 0) >= 30 && (t.popularity || 0) < 60).slice(0, 2).map(t => t.id),
    ...rnd.filter(t => (t.popularity || 0) < 30).slice(0, 2).map(t => t.id),
  ].filter(Boolean).slice(0, 5);

  const allTrackIds = pool.slice().sort(() => Math.random() - 0.5).map(t => t.id).filter(Boolean);

  let recTracks = [];
  if (diverseSeeds.length >= 2) {
    try {
      const recParams = new URLSearchParams({ seed_tracks: diverseSeeds.join(','), limit: '60', market: 'IL' });
      if (energyLevel === 1) { recParams.set('max_energy', '0.68'); recParams.set('target_energy', '0.40'); recParams.set('max_tempo', '130'); recParams.set('target_tempo', '90'); }
      if (energyLevel === 2) { recParams.set('min_energy', '0.45'); recParams.set('target_energy', '0.72'); recParams.set('min_tempo', '95'); recParams.set('target_tempo', '120'); }
      const kl = entry.knownLevel || 3;
      if (kl <= 2) { recParams.set('max_popularity', '55'); recParams.set('target_popularity', '35'); }
      else if (kl >= 4) { recParams.set('min_popularity', '50'); recParams.set('target_popularity', '70'); }

      const recJson = await getRecommendations(recParams, { neutral: true });
      recTracks = (recJson.tracks || []).filter(t => t && t.id && energyPass(t));
    } catch (e) {}
  }

  const directPool = pool
    .filter(t => t.id && (t.popularity || 0) >= 15 && (t.popularity || 0) <= 75)
    .sort(() => Math.random() - 0.5);
  const anchorTracks = directPool.slice(0, 9);

  const anchorSet = new Set(anchorTracks.map(t => t.id));
  const recUnique = recTracks.filter(t => !anchorSet.has(t.id)).slice(0, 20);

  const directTracks = [...anchorTracks, ...recUnique].slice(0, 20).map(t => ({
    artist: (t.artists || []).map(a => a.name).join(', '),
    title: t.name || '',
    id: t.id,
    cover: (t.album?.images?.length) ? t.album.images[t.album.images.length - 1].url : '',
    popularity: t.popularity || 0,
    duration: t.duration_ms || 0,
    preview: '', url: '',
    reason: anchorSet.has(t.id) ? 'data-box' : 'inspired',
  }));

  return {
    topTrackIds: diverseSeeds,
    allTrackIds: [...allTrackIds, ...recUnique.map(t => t.id)],
    topArtists,
    nicheArtists,
    audioStats,
    trackCount: pool.length + recTracks.length,
    playlistCount: samplePids.length,
    directTracks,
    energyLevel,
    genres: lvData?.genres || entry.genres || '',
  };
}
