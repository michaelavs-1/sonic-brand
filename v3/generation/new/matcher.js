// Stage 1: match user input to a business type via GPT.
// Two-pass:
//   Pass 1 — direct match by type name + keywords (column A + column B).
//   Pass 2 — fallback match by atmosphere/vibe (column D) when Pass 1 returns null.
//
// Input rows must carry a bizType (or label) string. Optional fields:
//   keywords    — comma-separated string or array (column B)
//   atmospheres — comma-separated string or array (column D)
// All other fields pass through into the output `rows` array unchanged.
//
// Network: POST /api/new/openai with the full list of business types every call.

const MODEL = 'gpt-5.4';
const MAX_TOKENS = 200;
const NO_MATCH_MSG = 'לא נמצאה התאמה לתיאור.';

function parseCSV(raw) {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  if (typeof raw !== 'string' || !raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function groupRowsByBizType(rows) {
  const groups = new Map();
  for (const row of rows) {
    const bizType = row && (row.bizType || row.label)
      ? String(row.bizType || row.label).trim()
      : '';
    if (!bizType) continue;
    let g = groups.get(bizType);
    if (!g) {
      g = { rows: [], keywords: new Set(), atmospheres: new Set() };
      groups.set(bizType, g);
    }
    g.rows.push(row);
    for (const kw of parseCSV(row.keywords))    g.keywords.add(kw);
    for (const at of parseCSV(row.atmospheres)) g.atmospheres.add(at);
  }
  return groups;
}

function filterGroupsWithAtmospheres(groups) {
  const out = new Map();
  for (const [bizType, g] of groups) {
    if (g.atmospheres.size > 0) out.set(bizType, g);
  }
  return out;
}

function buildTypeMessages(userInput, groups) {
  let i = 1;
  const list = [...groups].map(([bizType, g]) => {
    const kws = [...g.keywords].join(', ');
    return kws ? `${i++}. ${bizType} — ${kws}` : `${i++}. ${bizType}`;
  }).join('\n');

  const system = `You are a Hebrew business-type classifier. The user describes a business they are opening. Pick the SINGLE best matching type from the list, OR return null if the user's business isn't in the list's categories.

RULE: A "match" means the user's business belongs to the SAME CATEGORY as a listed type — not merely that it shares a broad domain (retail / food / services) or an atmosphere with one. When in doubt, prefer null over a stretch. Null is not failure; a separate pass will then try vibe-based matching.

GOOD matches (return the type):
- "אני אופה עוגות לחתונות" → קונדיטוריה / מאפייה (the business IS a bakery, just phrased differently)
- "מקום של יין צרפתי" → בר יין (same category, paraphrased)
- "בר יייין" → בר יין (typo of the same category)

BAD matches (return null instead — do NOT force):
- "חנות גרביים" → NOT חנות הלבשה תחתונה (sock retail ≠ underwear retail; different specialty)
- "מרפאת שיניים" → NOT קליניקת בוטוקס (dental ≠ cosmetic injectables; different specialty)
- "חנות אופניים" → NOT חנות בגדי ספורט (bikes and sportswear are different specialty retail)
- "אני בונה רקטה" → null (entirely unrelated)

If the user's business is in a specialty (retail, service, medical, food) that does NOT appear as its own entry in the list, return null. Do NOT pick the "closest" listed specialty; the next pass is designed to handle those cases by atmosphere/vibe.

Respond with STRICT JSON: {"bizType":"<exact-string-from-list-or-null>","reasoning":"<one short sentence in Hebrew>"}. The bizType MUST be either null or exactly one of the strings that appear after the number in the list (do not invent, paraphrase, or translate).`;

  const user = `תיאור העסק: "${userInput}"\n\nסוגי עסקים אפשריים:\n${list}\n\nהחזר JSON מחמיר.`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ];
}

function buildAtmosphereMessages(userInput, groups) {
  let i = 1;
  const list = [...groups].map(([bizType, g]) => {
    const atms = [...g.atmospheres].join(', ');
    return `${i++}. ${bizType} — ${atms}`;
  }).join('\n');

  const system = `You are a Hebrew business-type matcher operating in FALLBACK mode. The user described a business that didn't match any type by name or keyword. Try to match by VIBE / ATMOSPHERE — but with discipline.

FRAMING: Every type in the list is a public physical venue where customers hear curated background music (bars, restaurants, cafés, salons, retail shops). A valid atmosphere match requires BOTH:
(1) The user's business is itself a music-playing public venue — customers physically present, music playing in the background.
(2) One listed type's actual playlist (its specific musical character, not just abstract vibe words) would plausibly serve as background music for the user's business too.

If the user's business is fundamentally NOT a music-playing public venue — an office / startup, a factory, an online or B2B business, an industrial site — return null regardless of vibe-word overlap.

Sharing vibe words like "צעיר", "מודרני", "אלגנטי", "רגוע" is NOT sufficient on its own. The music itself has to fit.

GOOD fallback matches (return the type):
- "חנות גרביים צבעוניים וכיפיים" → חנות בגדי ים / גלישה (both are upbeat fun retail; surf-shop playlist plausibly works as music for a sock shop)
- "חנות נעליים יוקרתית" → חנות בגדי יוקרה (same luxury-fashion tier and customer demographic; their music needs interchange)
- "מקום אינטימי וסקסי לדייט בערב" → בר קוקטיילים (cocktail-bar music actually fits an intimate evening date venue)

BAD matches (return null instead — do NOT force):
- "חברת סטארטאפ לטכנולוגיה" → null (no customers in physical space hearing music — vibe overlap is irrelevant)
- "סטודיו ליוגה ומיינדפולנס" → null (yoga needs focused meditation music; a café or bar playlist wouldn't actually fit, even though "רגוע" overlaps)
- "חנות צעצועי ילדים" → NOT חנות הלבשה תחתונה (entirely different customer / music needs; superficial "retail" overlap is not enough)
- "מפעל לייצור פלסטיק" → null (industrial site, not customer-facing)

If unsure, prefer null. FALLBACK mode is meant to catch genuine vibe-based music matches, not to give every input a "closest available" answer.

Respond with STRICT JSON: {"bizType":"<exact-string-from-list-or-null>","reasoning":"<one short Hebrew sentence describing the vibe you inferred and why this type matches it (or why nothing fits)>"}. The bizType MUST be either null or exactly one of the strings that appear after the number in the list.`;

  const user = `תיאור העסק: "${userInput}"\n\nסוגי עסקים לפי אווירה:\n${list}\n\nהחזר JSON מחמיר.`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ];
}

async function callOpenAI(messages) {
  const r = await fetch('/api/new/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    throw new Error(`openai ${r.status}: ${errBody.error?.message || errBody.error || r.statusText}`);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('openai: empty completion');
  return JSON.parse(content);
}

async function tryMatch(messages, groups) {
  let parsed;
  try {
    parsed = await callOpenAI(messages);
  } catch (e) {
    return { matched: false, reasoning: `matcher_error: ${e.message}` };
  }
  const chosen = parsed?.bizType;
  const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning : '';
  if (!chosen || typeof chosen !== 'string') return { matched: false, reasoning };
  const group = groups.get(chosen);
  if (!group) return { matched: false, reasoning: `matcher_error: GPT returned unknown bizType "${chosen}"` };
  return { matched: true, bizType: chosen, rows: group.rows, reasoning };
}

export async function matchBusinessType(userInput, rows) {
  if (!userInput || !Array.isArray(rows) || !rows.length) {
    return { matched: false, reasoning: NO_MATCH_MSG };
  }

  const groups = groupRowsByBizType(rows);
  if (!groups.size) return { matched: false, reasoning: NO_MATCH_MSG };

  // Pass 1 — direct match by type/keywords.
  const direct = await tryMatch(buildTypeMessages(userInput, groups), groups);
  if (direct.matched) return direct;

  // Pass 2 — atmosphere fallback. Only consider types that actually have atmospheres listed.
  const groupsWithAtm = filterGroupsWithAtmospheres(groups);
  if (groupsWithAtm.size === 0) {
    return { matched: false, reasoning: direct.reasoning || NO_MATCH_MSG };
  }
  const atm = await tryMatch(buildAtmosphereMessages(userInput, groupsWithAtm), groupsWithAtm);
  if (atm.matched) return { ...atm, fallback: 'atmosphere' };

  return { matched: false, reasoning: atm.reasoning || direct.reasoning || NO_MATCH_MSG };
}
