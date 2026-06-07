// v4 Stage 1 fallback: atmosphere-based match (column D).
// Called by the app only when matcher.js returned matched:false.
// Same return shape as the matcher, plus `fallback: 'atmosphere'` on success.

const MODEL = 'gpt-5.4';
const MAX_TOKENS = 200;
const NO_MATCH_MSG = 'לא נמצאה התאמה לתיאור.';

function groupRowsByBizType(rows) {
  const groups = new Map();
  for (const row of rows) {
    const bizType = row?.bizType ? String(row.bizType).trim() : '';
    if (!bizType) continue;
    let g = groups.get(bizType);
    if (!g) {
      g = { rows: [], atmospheres: new Set() };
      groups.set(bizType, g);
    }
    g.rows.push(row);
    for (const at of (row.atmospheres || [])) g.atmospheres.add(at);
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

function pickRow(rows) {
  return rows.find(r => Array.isArray(r.genres2) && r.genres2.length > 0) || rows[0];
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
  const r = await fetch('/api/v4/openai', {
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

export async function matchByAtmosphere(userInput, rows) {
  if (!userInput || !Array.isArray(rows) || !rows.length) {
    return { matched: false, reasoning: NO_MATCH_MSG };
  }

  const groups = filterGroupsWithAtmospheres(groupRowsByBizType(rows));
  if (!groups.size) return { matched: false, reasoning: NO_MATCH_MSG };

  let parsed;
  try {
    parsed = await callOpenAI(buildAtmosphereMessages(userInput, groups));
  } catch (e) {
    return { matched: false, reasoning: `fallback_error: ${e.message}` };
  }

  const chosen = parsed?.bizType;
  const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning : '';
  if (!chosen || typeof chosen !== 'string') return { matched: false, reasoning };

  const group = groups.get(chosen);
  if (!group) {
    return { matched: false, reasoning: `fallback_error: GPT returned unknown bizType "${chosen}"` };
  }

  const row = pickRow(group.rows);
  return {
    matched: true,
    bizType: chosen,
    row,
    genres1: row.genres1 || [],
    genres2: row.genres2 || [],
    reasoning,
    fallback: 'atmosphere',
  };
}
