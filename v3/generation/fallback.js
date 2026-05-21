import { callOpenAI, searchTrack } from './api.js';
import { safeJSON } from './utils.js';

export async function generateCandidates(faders, moods, input, opts, deps) {
  const attempt = (opts && opts.attempt) || 0;
  const exclude = (opts && opts.exclude) || [];

  const fd = input.faderDescriptions || {};
  const fmDesc = fd.familiarity || '';
  const heDesc = fd.hebrew || '';
  const voDesc = fd.vocal || '';
  const enDesc = fd.energy || '';
  const erDesc = fd.era || '';

  const isNewModel = input.modelIsNew !== undefined
    ? input.modelIsNew
    : /^gpt-5/.test(deps.model || '');
  const candidateCount = isNewModel ? 40 : 60;

  const regenNote = attempt > 0
    ? `\n⚠️ זוהי יצירה מחדש מספר ${attempt}. חובה להציג בחירה שונה לחלוטין מהפעם הקודמת — אמנים שונים, שירים שונים, זוויות שונות של הסגנון. אל תחזור על אף שיר מהרשימה הבאה.`
    : '';

  const energyNote = input.energyLevel === 1
    ? '🎵 אנרגיית הפלייליסט: רגועה ושקטה — BPM נמוך (60-110), אנרגיה מרוסנת. מתאים לשעות שקטות, שיחות, רקע נינוח.'
    : input.energyLevel === 2
    ? '🎵 אנרגיית הפלייליסט: מקפיצה ואנרגטית — BPM גבוה (100-170), Spotify energy > 0.5. מתאים לשעות עמוסות, ריקוד, עומס.'
    : '';

  const feedback = input.feedback || {};
  const likedKeys = Object.entries(feedback).filter(([, v]) => v === 'up').map(([k]) => k);
  const dislikedKeys = Object.entries(feedback).filter(([, v]) => v === 'down').map(([k]) => k);
  const sessionFeedback = [
    likedKeys.length ? `\n✅ אהב סגנון אלו — חפש דומים:\n${likedKeys.slice(0, 8).map(k => k.replace('|', ' — ')).join('\n')}` : '',
    dislikedKeys.length ? `\n❌ לא אהב אלו — הימנע לחלוטין:\n${dislikedKeys.slice(0, 8).map(k => k.replace('|', ' — ')).join('\n')}` : '',
  ].join('');

  const brainBlocks = input.brainBlocks || '';

  const excludeBlock = exclude.length
    ? `\nשירים שכבר הוצגו — אסור לכלול אף אחד מהם:\n${exclude.slice(0, 40).join('\n')}`
    : '';

  const sys = `אתה רובין, מומחה ליצירת פלייליסטים מותאמי-עסק.
המטרה: לייצר ${candidateCount} מועמדים אמיתיים מ-Spotify לפלייליסט עסקי.
חוקים קשיחים:
- כל שיר חייב להיות קיים באמת ב-Spotify, אמן ושם מדויקים.
- אל תמציא שירים. אם אתה לא בטוח — אל תכלול.
- שמור על הסגנונות והאווירות שביקש העסק.
- גיוון חובה: ~40% מוכרים, ~40% פחות מוכרים, ~20% נישה. אמנים פחות מוכרים אבל איכותיים הם נכס.
- אל תחזור על אמן יותר מ-2 פעמים.${regenNote}${energyNote}${sessionFeedback}
${fmDesc}
${heDesc}
${voDesc}
${enDesc}
${erDesc}
החזר JSON: {"tracks":[{"artist":"...","title":"...","reason":"5 מילים בעברית"}]}`;

  const hoursOpen = input.hours?.open || '';
  const hoursClose = input.hours?.close || '';
  const usr = `תיאור העסק: "${input.bizDesc || ''}"
סוג: ${input.bizType || 'עסק'}
אווירות נבחרות: ${moods.join(', ') || '(ברירת מחדל)'}
שעות פעילות: ${hoursOpen}-${hoursClose}
${input.refPlaylist ? 'פלייליסט ייחוס URL: ' + input.refPlaylist : ''}

${brainBlocks}
${excludeBlock}

צור ${candidateCount} מועמדים מגוונים שמתאימים לכל החוקים והמידע למעלה.
אם ניתנו DNA / קוהורט / ארכיון — שלב את כולם לאיזון מדויק שמתאים לעסק הזה.`;

  const temperature = Math.min(0.97, 0.85 + attempt * 0.04);

  const raw = await callOpenAI(
    [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    { apiKey: deps.apiKey, model: deps.model, max_tokens: isNewModel ? 4000 : 6000, temperature }
  );
  const parsed = safeJSON(raw);
  const tracks = (parsed.tracks || []).filter(t => t.artist && t.title);
  return tracks.slice(0, candidateCount);
}

export async function validateOnSpotify(candidates, opts, deps) {
  const out = [];
  const onProgress = (opts && opts.onProgress) || (() => {});
  const fallbackToken = (deps && deps.fallbackToken) || null;
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i + 8);
    onProgress('מאמת ב-Spotify…', `${i + batch.length}/${candidates.length}`);
    const results = await Promise.allSettled(
      batch.map(t => searchTrack(t.artist, t.title, { fallbackToken }))
    );
    results.forEach((r, ri) => {
      const orig = batch[ri];
      if (r.status === 'fulfilled' && r.value) {
        const sp = r.value;
        out.push({
          artist: sp.artists.map(a => a.name).join(', '),
          title: sp.name,
          id: sp.id,
          url: sp.external_urls && sp.external_urls.spotify,
          cover: sp.album && sp.album.images && sp.album.images.length ? sp.album.images[sp.album.images.length - 1].url : '',
          preview: sp.preview_url || '',
          popularity: sp.popularity || 0,
          duration: sp.duration_ms || 0,
          reason: orig.reason || '',
        });
      } else {
        out.push({ artist: orig.artist, title: orig.title, reason: orig.reason || '' });
      }
    });
  }
  return out;
}
