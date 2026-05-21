export async function fetchL2_Cohort(bizCategory, deps) {
  if (!bizCategory) return null;
  const sb = deps.sb;
  try {
    let { data, error } = await sb.from('analyses')
      .select('id,description,faders,tracks,track_count,brain_version')
      .eq('biz_category', bizCategory).gte('track_count', 10)
      .order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    let cohortSize = data ? data.length : 0;
    let usedFallback = false;
    if (cohortSize < 3) {
      const r2 = await sb.from('analyses')
        .select('id,description,faders,tracks,track_count,brain_version')
        .eq('biz_category', 'general').gte('track_count', 10)
        .order('created_at', { ascending: false }).limit(20);
      if (!r2.error && r2.data) {
        data = (data || []).concat(r2.data);
        cohortSize = data.length;
        usedFallback = true;
      }
    }
    if (!data || !data.length) return null;

    const trackFreq = {};
    const artistFreq = {};
    let totalTracks = 0;
    for (const row of data) {
      let tracks = row.tracks;
      try { if (typeof tracks === 'string') tracks = JSON.parse(tracks); } catch (e) {}
      if (!Array.isArray(tracks)) continue;
      for (const t of tracks) {
        if (!t || !t.artist || !t.title) continue;
        totalTracks++;
        const key = `${t.artist}|${t.title}`;
        if (!trackFreq[key]) trackFreq[key] = { count: 0, id: t.id || null, artist: t.artist, title: t.title, reason: t.reason || '' };
        trackFreq[key].count++;
        if (!trackFreq[key].id && t.id) trackFreq[key].id = t.id;
        artistFreq[t.artist] = (artistFreq[t.artist] || 0) + 1;
      }
    }
    const sortedTracks = Object.values(trackFreq).sort((a, b) => b.count - a.count);
    const topWithIds = sortedTracks.filter(t => t.id).slice(0, 10);
    const topArtists = Object.entries(artistFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => ({ name: n, count: c }));

    return {
      cohort_size: cohortSize,
      used_fallback: usedFallback,
      cohort_top_ids: topWithIds.map(t => t.id),
      cohort_top_tracks: topWithIds.map(t => ({ artist: t.artist, title: t.title, id: t.id, reason: t.reason, count: t.count })),
      cohort_top_artists: topArtists,
      total_tracks_seen: totalTracks,
    };
  } catch (e) {
    console.warn('[brain L2] failed:', e);
    return null;
  }
}
