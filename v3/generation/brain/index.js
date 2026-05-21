import { fetchL0_DNA } from './l0.js';
import { fetchL1_DNA, fetchMultiL1_DNA, parsePlaylistId, mapDNAToFaders } from './l1.js';
import { fetchL2_Cohort } from './l2.js';
import { fetchL3_GenreArchive } from './l3.js';
import { fetchL4_Feedback } from './l4.js';
import { analyzeAudioStats } from './audio.js';

export {
  fetchL0_DNA,
  fetchL1_DNA,
  fetchMultiL1_DNA,
  parsePlaylistId,
  mapDNAToFaders,
  fetchL2_Cohort,
  fetchL3_GenreArchive,
  fetchL4_Feedback,
  analyzeAudioStats,
};

export async function buildBrainContext(input, deps) {
  const l0Match = input.useDataBox
    ? ((deps.matchDataBox && deps.matchDataBox(input.bizDesc)) || null)
    : null;
  const pureAI = !input.useDataBox;

  const l1Deps = {
    apiKey: deps.apiKey,
    model: deps.model,
    spotifyToken: deps.spotifyToken,
    getSpotifyToken: deps.getSpotifyToken,
  };

  const [l0Res, l1Res, l2Res, l3Res, l4Res] = await Promise.allSettled([
    l0Match ? fetchL0_DNA(l0Match, input.selectedMoods, input.energyLevel || 1) : Promise.resolve(null),
    input.selectedUserPlaylists && input.selectedUserPlaylists.length > 0
      ? fetchMultiL1_DNA(input.selectedUserPlaylists, l1Deps)
      : (input.refPlaylist ? fetchL1_DNA(input.refPlaylist, l1Deps) : Promise.resolve(null)),
    pureAI ? Promise.resolve(null) : fetchL2_Cohort(input.bizType, { sb: deps.sb }),
    pureAI ? Promise.resolve(null) : fetchL3_GenreArchive(Array.from(input.selectedMoods || []), { sb: deps.sb }),
    pureAI ? Promise.resolve(null) : fetchL4_Feedback(input.bizType, { sb: deps.sb }),
  ]);

  const l0DNA = l0Res.status === 'fulfilled' ? l0Res.value : null;
  return {
    l0: l0Match ? { ...l0Match, dna: l0DNA } : null,
    l1: l1Res.status === 'fulfilled' ? l1Res.value : null,
    l2: l2Res.status === 'fulfilled' ? l2Res.value : null,
    l3: l3Res.status === 'fulfilled' ? l3Res.value : null,
    l4: l4Res.status === 'fulfilled' ? l4Res.value : null,
  };
}

export function assembleBrainBlocks(ctx, input) {
  const blocks = [];
  const bizType = (input && input.bizType) || '';

  if (ctx.l0) {
    const lines = ['[L0 — DATA BOX: כלל ברזל — חובה לציית]'];
    lines.push(`סוג עסק: ${ctx.l0.label}`);
    lines.push(`✅ ז'אנרים מותרים בלבד: ${ctx.l0.genres}`);
    lines.push(`❌ אסור לחלוטין: פופ ישראלי מיינסטרים, מזרחית, שירים ידועים מהרדיו הישראלי, Hip Hop מסחרי, EDM — אלא אם הם מופיעים מפורשות ברשימת המותרים לעיל`);
    if (ctx.l0.dna) {
      if (ctx.l0.dna.topArtists && ctx.l0.dna.topArtists.length) {
        lines.push(`🚫 אמנים שמופיעים יתר על המידה בז'אנר (אסור לבחור אותם — כבר ידועים מדי): ${ctx.l0.dna.topArtists.join(', ')}`);
      }
      if (ctx.l0.dna.nicheArtists && ctx.l0.dna.nicheArtists.length) {
        lines.push(`✨ אמנים פחות ידועים מאותו עולם (העדיפו לבחור מתוך אלו ודומים להם): ${ctx.l0.dna.nicheArtists.join(', ')}`);
      } else {
        lines.push(`→ מצא אמנים פחות ידועים מאותו עולם מוזיקלי — לא הכוכבים הגדולים.`);
      }
    }
    if (ctx.l0.dna && ctx.l0.dna.audioStats) {
      const st = ctx.l0.dna.audioStats;
      lines.push(`🎚️ אנרגיה=${st.energy.toFixed(2)}, טמפו≈${Math.round(st.tempo)} BPM`);
    }
    lines.push(`🎯 מטרת המוזיקה: ${ctx.l0.purpose}`);
    lines.push(`⚠️ L0 הוא הכלל העליון — שאר השכבות (L1-L4) משלימות ומדייקות, לא עוקפות.`);
    blocks.push(lines.join('\n'));
  }

  if (ctx.l1) {
    const lines = ['[L1 — REFERENCE PLAYLIST DNA]'];
    if (ctx.l1.summary) lines.push(`DNA: ${ctx.l1.summary}`);
    if (ctx.l1.topTracksDisplay && ctx.l1.topTracksDisplay.length) lines.push(`שירי דגל: ${ctx.l1.topTracksDisplay.slice(0, 5).join(' | ')}`);
    if (ctx.l1.topArtists && ctx.l1.topArtists.length) lines.push(`אמנים מרכזיים: ${ctx.l1.topArtists.join(', ')}`);
    blocks.push(lines.join('\n'));
  }
  if (ctx.l2 && ctx.l2.cohort_top_tracks && ctx.l2.cohort_top_tracks.length >= 3) {
    const lines = ['[L2 — COHORT MEMORY (Robin זוכרת מעסקים דומים)]'];
    lines.push(`מעבודות קודמות עם "${bizType}"${ctx.l2.used_fallback ? ' (כולל general)' : ''}, ${ctx.l2.cohort_size} פלייליסטים:`);
    ctx.l2.cohort_top_tracks.slice(0, 8).forEach(t => {
      lines.push(`- ${t.artist} — ${t.title}${t.reason ? ` (${String(t.reason).slice(0, 50)})` : ''}`);
    });
    lines.push('שאף לרוח דומה — לא חזרה מילולית.');
    blocks.push(lines.join('\n'));
  }
  if (ctx.l3 && ctx.l3.genre_top_tracks && ctx.l3.genre_top_tracks.length >= 3) {
    const lines = ['[L3 — GENRE ARCHIVE]'];
    lines.push("מארכיון לפי-ז'אנרים שמתאים לאווירות שבחרת:");
    ctx.l3.genre_top_tracks.slice(0, 6).forEach(t => lines.push(`- ${t.artist} — ${t.title}`));
    blocks.push(lines.join('\n'));
  }
  if (ctx.l4 && (ctx.l4.boost_list.length || ctx.l4.block_list.length)) {
    const lines = ['[L4 — FEEDBACK SIGNALS]'];
    if (ctx.l4.boost_list.length) lines.push(`חובה לכלול אם זמין: ${ctx.l4.boost_list.slice(0, 5).join(', ')}`);
    if (ctx.l4.block_list.length) lines.push(`הימנע מ: ${ctx.l4.block_list.slice(0, 5).join(', ')}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
