import { getPlaylistTracks, getAudioFeatures } from './api.js';

export async function buildTrackPool(entry, energyLevel) {
  const liveEnergy = entry.liveEnergy || entry.energy || {};
  const lvData = liveEnergy[energyLevel] || liveEnergy[1] || liveEnergy[2] || null;
  let playlistIds = lvData?.playlists || [];

  if (!playlistIds.length && Array.isArray(entry.playlists)) {
    playlistIds = entry.playlists.map(p => p.id || p).filter(Boolean);
  }
  if (!playlistIds.length) return [];

  const shuffled = playlistIds.slice().sort(() => Math.random() - 0.5);

  const rawTracks = [];
  await Promise.allSettled(shuffled.map(async pid => {
    const offset = Math.floor(Math.random() * 80);
    try {
      const j = await getPlaylistTracks(pid, {
        fields: 'items(track(id,name,artists(name),popularity,duration_ms,album(images,release_date)))',
        limit: 50,
        offset,
        neutral: true,
      });
      const tracks = (j.items || []).map(it => it.track).filter(t => t && t.id)
        .map(t => ({ ...t, _src: 'databox', _pid: pid }));
      rawTracks.push(...tracks);
    } catch (e) {}
  }));

  const seen = new Set();
  const unique = rawTracks.filter(t => {
    if (seen.has(t.id)) return false; seen.add(t.id); return true;
  });

  const idBatch = unique.slice(0, 100).map(t => t.id);
  let featureMap = {};
  if (idBatch.length) {
    try {
      const j = await getAudioFeatures(idBatch, { neutral: true });
      (j.audio_features || []).filter(f => f).forEach(f => { featureMap[f.id] = f; });
    } catch (e) {}
  }

  const energyPass = t => {
    const f = featureMap[t.id]; if (!f) return true;
    if (energyLevel === 1) return f.energy < 0.72 && f.tempo < 138;
    if (energyLevel === 2) return f.energy > 0.35 && f.tempo > 85;
    return true;
  };

  const pool = unique.filter(energyPass);
  return pool.length >= 20 ? pool : unique;
}
