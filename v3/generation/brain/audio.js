export function analyzeAudioStats(features, tracks) {
  const mean = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
  const energy = mean(features.map(f => f.energy || 0));
  const valence = mean(features.map(f => f.valence || 0));
  const dance = mean(features.map(f => f.danceability || 0));
  const tempo = mean(features.map(f => f.tempo || 0));
  const instr = mean(features.map(f => f.instrumentalness || 0));
  const acoust = mean(features.map(f => f.acousticness || 0));
  const popularity = mean(tracks.map(t => t.popularity || 0));

  const hebRe = /[֐-׿]/;
  const hebrewTracks = tracks.filter(t => hebRe.test(t.name || '') || (t.artists || []).some(a => hebRe.test(a.name || ''))).length;
  const hebrewRatio = tracks.length ? hebrewTracks / tracks.length : 0;

  const years = tracks.map(t => {
    const d = (t.album && t.album.release_date) || '';
    return Number(d.slice(0, 4)) || 0;
  }).filter(y => y > 1950);
  const yearMean = mean(years);
  const currentYear = new Date().getFullYear();
  let eraScore = 50;
  if (yearMean) {
    const age = currentYear - yearMean;
    if (age <= 3) eraScore = 90;
    else if (age <= 8) eraScore = 70;
    else if (age <= 15) eraScore = 50;
    else if (age <= 25) eraScore = 25;
    else eraScore = 10;
  }

  return { energy, valence, dance, tempo, instr, acoust, popularity, hebrewRatio, yearMean, eraScore };
}
