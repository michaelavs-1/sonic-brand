export async function fetchL4_Feedback(bizCategory, deps) {
  if (!bizCategory) return null;
  const sb = deps.sb;
  try {
    const { data, error } = await sb.from('track_feedback')
      .select('track_artist,track_title,feedback_type')
      .eq('biz_category', bizCategory).limit(500);
    if (error || !data || !data.length) return null;
    const score = {};
    for (const row of data) {
      const key = `${row.track_artist}|${row.track_title}`;
      if (!score[key]) score[key] = { artist: row.track_artist, title: row.track_title, up: 0, down: 0 };
      if (row.feedback_type === 'up') score[key].up++;
      else if (row.feedback_type === 'down') score[key].down++;
    }
    const arr = Object.values(score).map(s => ({ ...s, score: s.up - s.down }));
    const boost = arr.filter(s => s.score >= 2).map(s => `${s.artist} — ${s.title}`);
    const block = arr.filter(s => s.score <= -2).map(s => `${s.artist} — ${s.title}`);
    return {
      feedback_count: data.length,
      boost_list: boost.slice(0, 10),
      block_list: block.slice(0, 10),
    };
  } catch (e) {
    console.warn('[brain L4] failed:', e);
    return null;
  }
}
