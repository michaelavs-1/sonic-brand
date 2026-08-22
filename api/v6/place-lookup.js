/* /api/v6/place-lookup.js
   "האם זה העסק שלך?" — matches the user's typed business name + description
   against Google's Business Profile catalog. On confirm, the returned place
   is stored per-business and its structured metadata (category, editorial
   summary, price level, vibe booleans) is fed into the Gemini musical-
   directions prompt as external factual grounding.

   No photo, no hours, no branch/chain handling — the flow uses only the
   top hit and asks a single "is this you?" question in the confirm step.

   A server-side name-similarity post-filter rejects Google's occasional
   garbage matches (fake business name → some unrelated venue in the area).
   See nameMatchesConfidently() for the algorithm + known limitations.

   Requires GOOGLE_PLACES_API_KEY in Vercel env. Without it the endpoint
   returns { found:false, reason:'no_key' } and the flow silently skips.

   POST { name: "בר הכפר", desc: "בר יין בתל אביב ..." }
   → { found: true,
       place: { place_id, name, address,
                primary_type, types,
                editorial_summary, price_level, website_uri,
                vibe: { liveMusic, servesBeer, servesWine,
                        servesBreakfast, servesLunch, servesDinner,
                        servesBrunch } } }
     | { found: false, reason: 'no_key'|'no_match'|'low_confidence'|'search_failed'|'error' }
*/

import { requireSite, setCors } from './origin-guard.js';
import { guard } from './ratelimit.js';

const KEY = process.env.GOOGLE_PLACES_API_KEY;

// Post-filter threshold — a match is rejected as "low_confidence" if
// fewer than this fraction of the user's distinctive name tokens appear
// in Google's returned displayName. See nameMatchesConfidently() below
// for the full contract + limitations.
const MIN_NAME_OVERLAP = 0.5;

// Business-type and stop words stripped before comparison — they carry
// no disambiguation signal (every restaurant contains "restaurant").
const GENERIC_TOKENS = new Set([
  'מסעדה', 'מסעדת', 'בית', 'קפה', 'בר', 'פאב', 'מלון', 'חנות', 'סניף',
  'restaurant', 'bar', 'cafe', 'café', 'coffee', 'pub', 'hotel', 'shop', 'store',
  'the', 'a', 'an', 'and', 'of', 'של', 'את', 'ו',
]);

function normalizeName(s) {
  return String(s || '')
    // Strip Latin diacritics ("CROÛTE" → "CROUTE") for cross-form matching.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/["'.,!?;:/()[\]{}\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  return normalizeName(s).split(' ').filter(Boolean);
}

// Prefer generic-stripped tokens, but if stripping empties the set (rare
// case where the user typed only a business-type word) fall back to raw
// tokens so the comparison isn't a division-by-zero.
function distinctiveTokens(tokens) {
  const distinct = tokens.filter((t) => !GENERIC_TOKENS.has(t) && t.length > 1);
  return distinct.length ? distinct : tokens;
}

function detectScript(s) {
  if (/[֐-׿]/.test(s)) return 'he';   // Hebrew block
  if (/[a-zA-Z]/.test(s)) return 'en';
  return 'other';
}

// Rejects weak matches from Google's "always return something" behavior:
// - Made-up names (user invents a business) → the returned displayName
//   shares no tokens with what they typed → rejected.
// - Google-picked-wrong-neighbor cases where a completely unrelated
//   venue in the same area comes back → same result.
//
// Cross-script inputs bypass the filter — comparing Hebrew tokens to
// Latin tokens is meaningless, so we defer to Google's ranking. (This
// means a user who typed English but got back a Hebrew canonical name
// won't be filtered even if wrong — the confirm card is the safety net.)
//
// KNOWN LIMITATION: this filter cannot resolve sub-string ambiguity.
// If the user types "בסטה" and Google returns "פסטה בסטה", the user's
// single distinctive token "בסטה" is fully contained in Google's name,
// so overlap = 100% and we accept. Two different businesses can share
// the same identifying token; only the user can tell them apart via
// the confirm card. The filter's job is to catch the obvious garbage
// matches, not to fully disambiguate every possible collision.
function nameMatchesConfidently(userName, placeName) {
  if (!userName || !placeName) return false;
  if (detectScript(userName) !== detectScript(placeName)) return true;
  const userTokens  = new Set(distinctiveTokens(tokenize(userName)));
  const placeTokens = new Set(distinctiveTokens(tokenize(placeName)));
  if (!userTokens.size || !placeTokens.size) return false;
  let matched = 0;
  for (const t of userTokens) if (placeTokens.has(t)) matched++;
  return (matched / userTokens.size) >= MIN_NAME_OVERLAP;
}

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.primaryType',
  'places.types',
  'places.editorialSummary',
  'places.priceLevel',
  'places.websiteUri',
  'places.liveMusic',
  'places.servesBeer',
  'places.servesWine',
  'places.servesBreakfast',
  'places.servesLunch',
  'places.servesDinner',
  'places.servesBrunch',
].join(',');

function mapPlace(p) {
  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    primary_type: p.primaryType || null,
    types: Array.isArray(p.types) ? p.types : [],
    editorial_summary: p.editorialSummary?.text || null,
    price_level: p.priceLevel || null,
    website_uri: p.websiteUri || null,
    vibe: {
      liveMusic:        p.liveMusic        ?? null,
      servesBeer:       p.servesBeer       ?? null,
      servesWine:       p.servesWine       ?? null,
      servesBreakfast:  p.servesBreakfast  ?? null,
      servesLunch:      p.servesLunch      ?? null,
      servesDinner:     p.servesDinner     ?? null,
      servesBrunch:     p.servesBrunch     ?? null,
    },
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return;
  if (!await guard(req, res, 'place-lookup', 20, 60)) return;

  try {
    if (!KEY) return res.status(200).json({ found: false, reason: 'no_key' });

    const { name, desc } = req.body || {};
    const q = [String(name || '').trim(), String(desc || '').trim().slice(0, 120)].filter(Boolean).join(' ');
    if (!q) return res.status(400).json({ error: 'name/desc required' });

    const sr = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: q, languageCode: 'he', regionCode: 'IL', maxResultCount: 5 }),
    });
    const data = await sr.json().catch(() => ({}));
    if (!sr.ok) {
      console.error('[v6 place-lookup] search failed:', JSON.stringify(data).slice(0, 300));
      return res.status(200).json({ found: false, reason: 'search_failed' });
    }

    const top = (data.places || [])[0];
    if (!top) return res.status(200).json({ found: false, reason: 'no_match' });

    const googleName = top.displayName?.text || '';
    if (!nameMatchesConfidently(name, googleName)) {
      console.info(`[v6 place-lookup] low-confidence match rejected: "${name}" vs "${googleName}"`);
      return res.status(200).json({ found: false, reason: 'low_confidence' });
    }

    return res.status(200).json({ found: true, place: mapPlace(top) });
  } catch (err) {
    console.error('[v6 place-lookup] failed:', err.message);
    return res.status(200).json({ found: false, reason: 'error' });
  }
}
