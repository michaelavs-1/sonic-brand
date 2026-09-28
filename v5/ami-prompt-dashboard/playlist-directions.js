// Step 4 of Ami's prompt dashboard: from the taste profile to the directions
// the daily playlists are built from. Ami edits each option's EDITABLE prompt
// section (prefilled with production's, DEFAULT_EDITABLE); it's assembled
// with production's FIXED section, user-message format and normalizer —
// exactly what runs when an owner picks a daily playlist type, apart from
// the edits and the gemini_call_log label ('ami-…'):
//   Option 1 → v7/generation/energy-directions.js (high / low tiers)
//   Option 2 → v7/generation/level-directions.js  (a library per energy level)
// and formats the result as text, with a short Hebrew explanation of how the
// playlists are built from those directions (the rules live in
// api/v7/account/_daily-builder.js planOption1 and _option2-builder.js).
//
// No DOM here, and relative imports without ?v= (the /v5/* pages are served
// no-cache), so a Node script can import it too.

import { callModel, parseJSONFromText } from '../../v7/generation/ai-provider.js';
import {
  EDITABLE_PROMPT_SECTION as ENERGY_EDITABLE,
  assembleSystemPrompt as assembleEnergySystemPrompt,
  buildUserMessage as buildEnergyUserMessage,
  normalizeEnergyDirections,
} from '../../v7/generation/energy-directions.js';
import {
  EDITABLE_PROMPT_SECTION as LEVEL_EDITABLE,
  assembleSystemPrompt as assembleLevelSystemPrompt,
  buildUserMessage as buildLevelUserMessage,
  normalizeLevelDirections,
  approvedByLevel,
} from '../../v7/generation/level-directions.js';
import { pickLevelDirections } from '../../v7/generation/timeline-assembler.js';

const MAX_TOKENS = 65536;
const ROTATION_DAYS = 4;

export const EXPLANATION_HE = {
  option1: [
    'אפשרות 1 — 4 פלייליסטים ביום: 2 באנרגיה גבוהה ו־2 באנרגיה רגועה.',
    'הז\'אנרים המאושרים בפרופיל הטעם מתחלקים לשתי קבוצות לפי אמצע סולם האנרגיה של בעל העסק: הרמות בחצי העליון = "גבוהה", השאר = "רגועה". המודל בונה מכל קבוצה ספרייה של כיוונים (עד 30 בסך הכול).',
    'בכל יום נבחרים באקראי 2 כיוונים מכל קבוצה, וכל פלייליסט בנוי מכיוון אחד בלבד: שירים אקראיים מהז\'אנרים של הכיוון; שירים שהעסק שמע ב־7 הימים האחרונים נכנסים רק כשאין מספיק חדשים. אורך כל פלייליסט: חצי משעות הפתיחה של אותו יום + שעה וחצי.',
    'שמות הכיוונים באנגלית פנימיים בלבד.',
  ],
  option2: [
    'אפשרות 2 — 2 מיקסים ביום ("Daily Mix #1/#2") שהאנרגיה שלהם עוקבת אחרי ציר האנרגיה שבעל העסק מצייר: למעלה = אנרגטי, למטה = רגוע. גובה הציר בכל רגע קובע רמת אנרגיה בסולם של בעל העסק (1 = הכי רגוע).',
    'לכל רמת אנרגיה המודל בונה ספרייה של כיוונים רק מהז\'אנרים של אותה רמה. ביום נתון כל מיקס מנגן בכל רמה מכיוון אחד בלבד. כשלרמה יש 2 כיוונים או יותר, שני המיקסים מקבלים כיוונים שונים.',
    'למחרת כל רמה עוברת לכיוון הבא שלה, עד שכל הכיוונים שלה נוגנו, ואז מתחילים מחדש (למטה: תצוגה של הימים הקרובים). השירים מסודרים לפי האורך האמיתי שלהם כך שהאנרגיה מתאימה לשעה, מהפתיחה (או מרגע הבנייה) ועד חצי שעה אחרי הסגירה; רמה בלי ז\'אנרים משתמשת ברמה הקרובה אליה. שירים שהעסק שמע ב־7 הימים האחרונים נכנסים רק כשאין מספיק חדשים.',
  ],
};

// Production's editable prompt per option — what Ami's editors start from.
export const DEFAULT_EDITABLE = { option1: ENERGY_EDITABLE, option2: LEVEL_EDITABLE };

const tierOfLevel = (level, n) => (level > n / 2 ? 'high' : 'low');

// editable = the option's EDITABLE prompt section (Ami's edited text);
// defaults to production's.
// → { ok:true, directions, dropped, usage, elapsed }
// | { ok:false, error, rawText?, usage?, elapsed? }
export async function generateForOption(option, { profile, inputs, label, editable = DEFAULT_EDITABLE[option] }) {
  const N = profile.energy_levels_total;
  const approved = profile.approved_genres;
  const common = {
    bizName: inputs.bizName, bizDesc: inputs.bizDesc, atmospheres: inputs.atmospheres,
    musicalEmphases: inputs.musicalEmphases, place: null,
  };
  const system = option === 'option1'
    ? assembleEnergySystemPrompt(editable.trimEnd())
    : assembleLevelSystemPrompt(editable.trimEnd());
  const userMessage = option === 'option1'
    ? buildEnergyUserMessage({ ...common, approvedGenres: approved, energyLevelsTotal: N })
    : buildLevelUserMessage({ ...common, approved: approvedByLevel(approved, N), energyLevelsTotal: N });

  const { text, usage, elapsed } = await callModel({ system, userMessage, maxTokens: MAX_TOKENS, cache: false, label });
  let parsed;
  try {
    parsed = parseJSONFromText(text);
  } catch (e) {
    return { ok: false, error: `התגובה לא הייתה JSON תקין: ${e.message}`, rawText: text, usage, elapsed };
  }
  if (parsed?.error) {
    return { ok: false, error: `המודל החזיר שגיאה: ${parsed.error}`, rawText: `ERROR: ${parsed.error}\nReasoning: ${parsed.reasoning_en || '(none)'}`, usage, elapsed };
  }
  const normalized = option === 'option1'
    ? normalizeEnergyDirections(parsed, approved, N)
    : normalizeLevelDirections(parsed, approved, N);
  const directions = normalized?.directions || [];
  if (!directions.length) return { ok: false, error: 'לא חזרו כיוונים תקינים', rawText: text, usage, elapsed };
  return { ok: true, directions, dropped: droppedPairs(option, parsed, directions), usage, elapsed };
}

// Genres the model placed that production drops (not approved, or in the
// wrong tier / level) — "genre → where the model put it".
function droppedPairs(option, parsed, kept) {
  const where = (d) => (option === 'option1' ? String(d?.energy_tier || '').trim().toLowerCase() : `L${Number(d?.energy_level)}`);
  const keptKeys = new Set(kept.flatMap((d) => d.genres.map((g) => `${where(d)}|${g.toLowerCase()}`)));
  const out = new Set();
  for (const d of Array.isArray(parsed?.directions) ? parsed.directions : []) {
    for (const g of Array.isArray(d?.genres) ? d.genres : []) {
      if (typeof g === 'string' && !keptKeys.has(`${where(d)}|${g.trim().toLowerCase()}`)) out.add(`${g} → ${where(d)}`);
    }
  }
  return [...out];
}

const levelOfGenre = (profile) => new Map(profile.approved_genres.map((e) => [e.genre, e.energy_level]));

// ---------- Option 1 ----------

export function formatOption1(profile, { directions, dropped }) {
  const N = profile.energy_levels_total;
  const lvl = levelOfGenre(profile);
  const lines = [];
  for (const tier of ['high', 'low']) {
    const tierGenres = profile.approved_genres.filter((e) => tierOfLevel(e.energy_level, N) === tier);
    const levels = [...new Set(tierGenres.map((e) => e.energy_level))].sort((a, b) => b - a);
    const dirs = directions.filter((d) => d.energy_tier === tier);
    lines.push(`${tier === 'high' ? 'HIGH' : 'LOW'} tier (${tier === 'high' ? 'אנרגיה גבוהה' : 'אנרגיה רגועה'}) — levels ${levels.join(', ') || '—'} of ${N}, ${tierGenres.length} approved genres → ${dirs.length} directions`);
    dirs.forEach((d, i) => {
      lines.push(`  ${i + 1}. ${d.title_en}`);
      lines.push(`     ${d.genres.map((g) => `${g} (L${lvl.get(g) ?? '?'})`).join(', ')}`);
    });
    const used = new Set(dirs.flatMap((d) => d.genres));
    const unused = tierGenres.map((e) => e.genre).filter((g) => !used.has(g));
    if (unused.length) lines.push(`  Approved but in no direction: ${unused.join(', ')}`);
    lines.push('');
  }
  if (dropped.length) lines.push(`DROPPED — not approved for that tier (${dropped.length}): ${dropped.join(', ')}`, '');

  // One example day, drawn the way planOption1's pickTwo draws.
  const pickTwo = (pool) => {
    if (pool.length <= 1) return [pool[0], pool[0]].filter(Boolean);
    const a = Math.floor(Math.random() * pool.length);
    let b = Math.floor(Math.random() * (pool.length - 1));
    if (b >= a) b += 1;
    return [pool[a], pool[b]];
  };
  lines.push('Example day (a random draw — a new one every day):');
  for (const tier of ['high', 'low']) {
    pickTwo(directions.filter((d) => d.energy_tier === tier)).forEach((d, i) => {
      lines.push(`  ${tier === 'high' ? 'אנרגיה גבוהה' : 'אנרגיה רגועה'} #${i + 1} → ${d.title_en}`);
    });
  }
  return lines.join('\n');
}

// ---------- Option 2 ----------

// Today in Israel as YYYY-MM-DD, plus n days.
function ilDate(offsetDays = 0) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}
const shortDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

export function formatOption2(profile, { directions, dropped }) {
  const N = profile.energy_levels_total;
  const lines = [];
  const lib = new Map();
  for (let L = N; L >= 1; L--) {
    const genres = profile.approved_genres.filter((e) => e.energy_level === L).map((e) => e.genre);
    const dirs = directions.filter((d) => d.energy_level === L);
    const tag = L === N ? ' (most energetic)' : L === 1 ? ' (calmest)' : '';
    if (!genres.length) { lines.push(`Level ${L}${tag} — no approved genres (the mix uses the nearest level)`, ''); continue; }
    lines.push(`Level ${L}${tag} — ${genres.length} genres → ${dirs.length} directions`);
    dirs.forEach((d, i) => lines.push(`  ${i + 1}. ${d.title_en}: ${d.genres.join(', ')}`));
    const used = new Set(dirs.flatMap((d) => d.genres));
    const unused = genres.filter((g) => !used.has(g));
    if (unused.length) lines.push(`  Approved but in no direction: ${unused.join(', ')}`);
    lines.push('');
    if (dirs.length) lib.set(L, dirs);
  }
  if (dropped.length) lines.push(`DROPPED — not approved at that level (${dropped.length}): ${dropped.join(', ')}`, '');

  // The daily rotation production uses (pickLevelDirections), for the next days.
  lines.push(`Rotation — which direction each mix plays per level, next ${ROTATION_DAYS} days:`);
  for (let i = 0; i < ROTATION_DAYS; i++) {
    const iso = ilDate(i);
    const picks = pickLevelDirections(lib, iso);
    lines.push(`  ${shortDate(iso)}${i === 0 ? ' (today)' : ''}`);
    picks.forEach((m, k) => {
      const parts = [...m].sort((a, b) => b[0] - a[0]).map(([L, d]) => `L${L} ${d.title_en}`);
      lines.push(`    Daily Mix #${k + 1}: ${parts.join(' · ')}`);
    });
  }
  return lines.join('\n');
}
