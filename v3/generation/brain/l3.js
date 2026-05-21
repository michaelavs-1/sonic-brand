export async function fetchL3_GenreArchive(moods, deps) {
  if (!moods || !moods.length) return null;
  const sb = deps.sb;
  try {
    const moodLowers = moods.map(m => String(m).toLowerCase().trim()).filter(Boolean);
    const { data, error } = await sb.from('analyses')
      .select('id,description,genres,tracks,track_count')
      .gte('track_count', 5).limit(50);
    if (error || !data) return null;

    const matching = [];
    for (const row of data) {
      let genres = row.genres;
      try { if (typeof genres === 'string') genres = JSON.parse(genres); } catch (e) {}
      if (!Array.isArray(genres) || !genres.length) continue;
      const genreLowers = genres.map(g => String(g).toLowerCase());
      const hit = moodLowers.some(m => genreLowers.some(g => g === m || g.includes(m) || m.includes(g)));
      if (hit) matching.push(row);
    }
    if (!matching.length) return null;

    const trackFreq = {};
    for (const row of matching) {
      let tracks = row.tracks;
      try { if (typeof tracks === 'string') tracks = JSON.parse(tracks); } catch (e) {}
      if (!Array.isArray(tracks)) continue;
      for (const t of tracks) {
        if (!t || !t.artist || !t.title) continue;
        const key = `${t.artist}|${t.title}`;
        if (!trackFreq[key]) trackFreq[key] = { count: 0, id: t.id || null, artist: t.artist, title: t.title };
        trackFreq[key].count++;
        if (!trackFreq[key].id && t.id) trackFreq[key].id = t.id;
      }
    }
    const top = Object.values(trackFreq).filter(t => t.id).sort((a, b) => b.count - a.count).slice(0, 10);
    return {
      archive_size: matching.length,
      genre_top_ids: top.map(t => t.id),
      genre_top_tracks: top.map(t => ({ artist: t.artist, title: t.title, count: t.count })),
    };
  } catch (e) {
    console.warn('[brain L3] failed:', e);
    return null;
  }
}
