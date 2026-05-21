import { callOpenAI } from '../api.js';
import { safeJSON } from '../utils.js';
import { analyzeAudioStats } from './audio.js';

export function parsePlaylistId(url) {
  if (!url) return null;
  const m = String(url).match(/playlist\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

export function mapDNAToFaders(stats) {
  return {
    familiarity: Math.round(Math.min(100, stats.popularity)),
    hebrew: Math.round(stats.hebrewRatio * 100),
    vocal: Math.round((1 - stats.instr) * 100),
    energy: Math.round(stats.energy * 100),
    era: Math.round(stats.eraScore),
  };
}

async function narrateDNA(stats, tracks, deps) {
  const sample = tracks.slice(0, 8).map(t => `${t.artists.map(a => a.name).join(', ')} — ${t.name}`).join('\n');
  const sys = 'אתה מנתח DNA של פלייליסט. החזר JSON: {"summary":"משפט אחד 12-20 מילים בעברית","vibe_keywords":["3-5 מילות מפתח אווירה בעברית"]}';
  const usr = `סטטיסטיקות:
energy=${stats.energy.toFixed(2)} valence=${stats.valence.toFixed(2)} dance=${stats.dance.toFixed(2)}
instrumentalness=${stats.instr.toFixed(2)} acoustic=${stats.acoust.toFixed(2)}
popularity_avg=${stats.popularity.toFixed(0)} hebrew=${(stats.hebrewRatio * 100).toFixed(0)}% year_avg=${stats.yearMean.toFixed(0)}

8 דוגמיות:
${sample}

נתח: סגנון/ז'אנר עיקרי, אווירה דומיננטית, טווח עידן.`;
  const raw = await callOpenAI(
    [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    { apiKey: deps.apiKey, model: deps.model, max_tokens: 300, temperature: 0.5 }
  );
  return safeJSON(raw);
}

export async function fetchL1_DNA(url, deps) {
  const id = parsePlaylistId(url);
  if (!id) return null;
  const tok = deps.spotifyToken || (deps.getSpotifyToken ? await deps.getSpotifyToken() : null);
  if (!tok) return null;
  try {
    const tr = await fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?fields=items(track(id,name,artists(id,name),album(release_date,images),popularity,duration_ms))&limit=100`, {
      headers: { 'Authorization': 'Bearer ' + tok },
    });
    if (!tr.ok) return null;
    const trJson = await tr.json();
    const tracks = (trJson.items || []).map(it => it.track).filter(t => t && t.id);
    if (tracks.length < 5) return null;
    const ids = tracks.map(t => t.id);
    const af = await fetch(`https://api.spotify.com/v1/audio-features?ids=${ids.slice(0, 100).join(',')}`, {
      headers: { 'Authorization': 'Bearer ' + tok },
    });
    const afJson = af.ok ? await af.json() : { audio_features: [] };
    const features = (afJson.audio_features || []).filter(f => f);

    const stats = analyzeAudioStats(features, tracks);
    const faderHints = mapDNAToFaders(stats);
    const narration = await narrateDNA(stats, tracks, deps).catch(() => ({ summary: '', vibe_keywords: [] }));

    const topByPop = tracks.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 5);
    const artistCount = {};
    tracks.forEach(t => (t.artists || []).forEach(a => { artistCount[a.name] = (artistCount[a.name] || 0) + 1; }));
    const topArtists = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);

    return {
      summary: narration.summary || '',
      vibeKeywords: Array.isArray(narration.vibe_keywords) ? narration.vibe_keywords : [],
      faderHints,
      topTrackIds: topByPop.map(t => t.id),
      topTracksDisplay: topByPop.map(t => `${t.artists.map(a => a.name).join(', ')} — ${t.name}`),
      topArtists,
      audioStats: stats,
      trackCount: tracks.length,
    };
  } catch (e) {
    console.warn('[brain L1] failed:', e);
    return null;
  }
}

export async function fetchMultiL1_DNA(playlistIds, deps) {
  if (!playlistIds.length) return null;
  const results = await Promise.allSettled(
    playlistIds.map(id => fetchL1_DNA('https://open.spotify.com/playlist/' + id, deps))
  );
  const dnas = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (!dnas.length) return null;
  if (dnas.length === 1) return dnas[0];

  const topArtists = [...new Set(dnas.flatMap(d => d.topArtists || []))].slice(0, 8);
  const topTrackIds = [...new Set(dnas.flatMap(d => d.topTrackIds || []))].slice(0, 5);
  const vibeKeywords = [...new Set(dnas.flatMap(d => d.vibeKeywords || []))].slice(0, 6);
  const topTracksDisplay = dnas.flatMap(d => d.topTracksDisplay || []).slice(0, 5);

  const statsKeys = ['energy', 'valence', 'dance', 'tempo', 'instr', 'hebrewRatio'];
  const audioStats = {};
  statsKeys.forEach(k => {
    const vals = dnas.map(d => d.audioStats?.[k]).filter(v => v != null);
    if (vals.length) audioStats[k] = vals.reduce((s, v) => s + v, 0) / vals.length;
  });

  return {
    summary: `${dnas.length} פלייליסטים נבחרו`,
    topArtists, topTrackIds, vibeKeywords, topTracksDisplay,
    audioStats: Object.keys(audioStats).length ? audioStats : null,
    faderHints: dnas[0].faderHints,
    trackCount: dnas.reduce((s, d) => s + (d.trackCount || 0), 0),
  };
}
