import { callOpenAI } from './api.js';
import { safeJSON } from './utils.js';

export async function selectFromPool(pool, faders, moods, energyLevel, input, deps) {
  if (!pool.length) return [];

  const fl = faders.familiarity;
  let candidates = pool;
  if (fl < 25) candidates = pool.filter(t => (t.popularity || 0) <= 55);
  else if (fl > 75) candidates = pool.filter(t => (t.popularity || 0) >= 35);
  if (candidates.length < 30) candidates = pool;

  const sessionExclude = input.generatedHistory || new Set();
  const finalPool = candidates.filter(t => !sessionExclude.has(t.id));

  const popular = finalPool.filter(t => (t.popularity || 0) >= 60).sort(() => Math.random() - 0.5);
  const mid = finalPool.filter(t => (t.popularity || 0) >= 25 && (t.popularity || 0) < 60).sort(() => Math.random() - 0.5);
  const niche = finalPool.filter(t => (t.popularity || 0) < 25).sort(() => Math.random() - 0.5);

  const MAX = 200;
  const stratified = [
    ...popular.slice(0, Math.round(MAX * 0.35)),
    ...mid.slice(0, Math.round(MAX * 0.45)),
    ...niche.slice(0, MAX - Math.round(MAX * 0.35) - Math.round(MAX * 0.45)),
  ].sort(() => Math.random() - 0.5);

  const sample = stratified.length >= 30 ? stratified : finalPool.slice().sort(() => Math.random() - 0.5).slice(0, MAX);

  const trackList = sample.map((t, i) => {
    const artist = (t.artists || []).map(a => a.name).join(', ');
    return `${i + 1}. ${artist} — ${t.name}`;
  }).join('\n');

  const energyDesc = energyLevel === 1
    ? 'רגועה ושקטה (BPM נמוך, אנרגיה מרוסנת — מתאים לשיחות, ישיבה, רקע)'
    : 'מקפיצה ואנרגטית (BPM גבוה, אנרגיה גבוהה — מתאים לשיא הערב, ריקוד, פעילות)';
  const heDesc = faders.hebrew > 65 ? 'העדפה לעברית' : faders.hebrew < 35 ? 'העדפה ללועזית' : 'תערובת עברית/לועזית';

  const sys = `אתה אוצר מוזיקה לעסקים.
תפקידך: לבחור שירים מהרשימה — לא להמציא שירים חדשים.
כלל ברזל: כל שיר שתבחר חייב להופיע ברשימה שקיבלת. שירים שלא ברשימה — אסורים לחלוטין.
חוקי גיוון חובה:
- אסור לבחור יותר מ-2 שירים מאותו אמן.
- חייב לפזר בחירות על פני הרשימה כולה — לא רק מהחלק הראשון.
- שלב שירים מוכרים עם שירים פחות מוכרים — לא רק את השמות הגדולים.
- כל בחירה צריכה להתאים לאווירה ולעסק, לא להיות "ברירת מחדל" של הז'אנר.
החזר JSON בלבד: {"tracks":[{"n":1},{"n":5},...]} כאשר n הוא מספר השיר ברשימה.`;

  const usr = `עסק: "${input.bizDesc || ''}"
סוג עסק: ${input.bizType || 'עסק'}
אווירות: ${moods.join(', ') || 'כללי'}
אנרגיה: ${energyDesc}
שפה: ${heDesc}

הרשימה (${sample.length} שירים) — בחר 30 מספרים:
${trackList}

החזר JSON עם 30 מספרים מהרשימה: {"tracks":[{"n":X},{"n":Y},...]}`;

  const raw = await callOpenAI(
    [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    { apiKey: deps.apiKey, model: deps.model, max_tokens: 800, temperature: 0.82 }
  );

  const parsed = safeJSON(raw);
  const picks = (parsed.tracks || []).map(p => p.n).filter(n => Number.isInteger(n) && n >= 1 && n <= sample.length);

  const result = [];
  const usedIds = new Set();
  for (const n of picks) {
    const t = sample[n - 1];
    if (!t || usedIds.has(t.id)) continue;
    usedIds.add(t.id);
    result.push({
      artist: (t.artists || []).map(a => a.name).join(', '),
      title: t.name,
      id: t.id,
      url: t.external_urls?.spotify || '',
      cover: (t.album?.images?.length) ? t.album.images[t.album.images.length - 1].url : '',
      popularity: t.popularity || 0,
      duration: t.duration_ms || 0,
      preview: '', reason: 'data-box',
    });
  }

  if (result.length < 30) {
    for (const t of sample) {
      if (result.length >= 30) break;
      if (usedIds.has(t.id)) continue;
      usedIds.add(t.id);
      result.push({
        artist: (t.artists || []).map(a => a.name).join(', '),
        title: t.name, id: t.id, url: t.external_urls?.spotify || '',
        cover: (t.album?.images?.length) ? t.album.images[t.album.images.length - 1].url : '',
        popularity: t.popularity || 0, duration: t.duration_ms || 0,
        preview: '', reason: 'data-box-fill',
      });
    }
  }

  return result.slice(0, 30);
}
