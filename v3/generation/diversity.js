export function dislikedArtistsFromFeedback(feedback) {
  return new Set(
    Object.entries(feedback || {})
      .filter(([, v]) => v === 'down')
      .map(([k]) => k.split('|')[0].toLowerCase().trim())
  );
}

export function applyDiversityFilter(tracks, { disliked, maxPerArtist = 2 } = {}) {
  const dis = disliked || new Set();
  const artistCounts = {};
  const filtered = tracks.filter(t => {
    const a = (t.artist || '').toLowerCase().trim();
    if (dis.has(a)) return false;
    artistCounts[a] = (artistCounts[a] || 0) + 1;
    return artistCounts[a] <= maxPerArtist;
  });
  return { tracks: filtered, artistCounts };
}

export function fillToTarget(diverse, pool, { disliked, artistCounts, target = 30, maxPerArtist = 2 } = {}) {
  const dis = disliked || new Set();
  const cnt = artistCounts || {};
  const usedIds = new Set(diverse.map(t => t.id).filter(Boolean));
  for (const t of pool.slice().sort(() => Math.random() - 0.5)) {
    if (diverse.length >= target) break;
    if (usedIds.has(t.id)) continue;
    const artist = (t.artists || []).map(a => a.name).join(', ');
    const an = artist.toLowerCase().trim();
    cnt[an] = (cnt[an] || 0) + 1;
    if (cnt[an] <= maxPerArtist && !dis.has(an)) {
      usedIds.add(t.id);
      diverse.push({
        artist, title: t.name, id: t.id,
        url: t.external_urls?.spotify || '',
        cover: (t.album?.images?.length) ? t.album.images[t.album.images.length - 1].url : '',
        popularity: t.popularity || 0, duration: t.duration_ms || 0, preview: '', reason: 'fill',
      });
    }
  }
  return diverse;
}
