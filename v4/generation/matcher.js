// v4 Stage 1: match user input to a business type via GPT.
// Pass 1 only — direct match by type name + keywords (column A + column B).
// On no-match here, the app should call fallback.js next.
//
// Input rows must carry: bizType, keywords (array), genres1 (array), genres2 (array).
// Network: POST /api/v4/openai with the full list of business types.

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
      g = { rows: [], keywords: new Set() };
      groups.set(bizType, g);
    }
    g.rows.push(row);
    for (const kw of (row.keywords || [])) g.keywords.add(kw);
  }
  return groups;
}

// Pick the row whose column H (genres2) has content; otherwise the first row.
function pickRow(rows) {
  return rows.find(r => Array.isArray(r.genres2) && r.genres2.length > 0) || rows[0];
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

export async function matchBusinessType(userInput, rows) {
  if (!userInput || !Array.isArray(rows) || !rows.length) {
    return { matched: false, reasoning: NO_MATCH_MSG };
  }

  const groups = groupRowsByBizType(rows);
  if (!groups.size) return { matched: false, reasoning: NO_MATCH_MSG };

  let parsed;
  try {
    parsed = await callOpenAI(buildTypeMessages(userInput, groups));
  } catch (e) {
    return { matched: false, reasoning: `matcher_error: ${e.message}` };
  }

  const chosen = parsed?.bizType;
  const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning : '';
  if (!chosen || typeof chosen !== 'string') return { matched: false, reasoning };

  const group = groups.get(chosen);
  if (!group) {
    return { matched: false, reasoning: `matcher_error: GPT returned unknown bizType "${chosen}"` };
  }

  const row = pickRow(group.rows);
  return {
    matched: true,
    bizType: chosen,
    row,
    genres1: row.genres1 || [],
    genres2: row.genres2 || [],
    reasoning,
  };
}
