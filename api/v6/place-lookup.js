/* /api/v4/place-lookup.js
   "האם זה אתה?" — finds the closest Google Business Profile for the business
   name + description the user typed, so the flow can confirm identity, pull
   the place photo into the personal area, and prefill opening hours.

   Requires GOOGLE_PLACES_API_KEY in Vercel env. Without it the endpoint
   returns { found:false, reason:'no_key' } and the flow silently skips.

   POST { name: "בר הכפר", desc: "בר יין בתל אביב ..." }
   → { found: true,
       place: { place_id, name, address, photo_url,
                hours: { "0".."6": { closed, from, to } } } }
*/

const KEY = process.env.GOOGLE_PLACES_API_KEY;

// Convert Places API regularOpeningHours periods → our per-weekday shape.
function hoursFromPeriods(periods) {
  if (!Array.isArray(periods) || !periods.length) return null;
  const out = {};
  for (let d = 0; d < 7; d++) out[d] = { closed: true, from: '08:00', to: '23:00', tag: 'רגיל' };
  for (const p of periods) {
    const day = p?.open?.day;
    if (day == null) continue;
    const f = `${String(p.open.hour ?? 8).padStart(2, '0')}:${String(p.open.minute ?? 0).padStart(2, '0')}`;
    const t = p.close ? `${String(p.close.hour ?? 23).padStart(2, '0')}:${String(p.close.minute ?? 0).padStart(2, '0')}` : '23:59';
    out[day] = { closed: false, from: f, to: t, tag: 'רגיל' };
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!KEY) return res.status(200).json({ found: false, reason: 'no_key' });

    const { name, desc } = req.body || {};
    const q = [String(name || '').trim(), String(desc || '').trim().slice(0, 120)].filter(Boolean).join(' ');
    if (!q) return res.status(400).json({ error: 'name/desc required' });

    // Places API (New) — Text Search
    const sr = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.photos,places.regularOpeningHours',
      },
      body: JSON.stringify({ textQuery: q, languageCode: 'he', regionCode: 'IL', maxResultCount: 5 }),
    });
    const data = await sr.json().catch(() => ({}));
    if (!sr.ok) {
      console.error('[place-lookup] search failed:', JSON.stringify(data).slice(0, 300));
      return res.status(200).json({ found: false, reason: 'search_failed' });
    }
    const mapPlace = (p) => ({
      place_id: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      photo_url: p.photos?.[0]?.name
        ? `https://places.googleapis.com/v1/${p.photos[0].name}/media?maxWidthPx=800&key=${KEY}`
        : null,
      hours: hoursFromPeriods(p.regularOpeningHours?.periods),
    });

    const places = (data.places || []).map(mapPlace);
    if (!places.length) return res.status(200).json({ found: false, reason: 'no_match' });

    // "Branch/chain" detection: same (or containing) name at several
    // addresses → the client asks whether this is a chain and which branch.
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const top = norm(places[0].name);
    const sameName = places.filter((p) => {
      const n = norm(p.name);
      return n === top || n.includes(top) || top.includes(n);
    });

    return res.status(200).json({
      found: true,
      place: places[0],
      candidates: sameName.length > 1 ? sameName : [places[0]],
    });
  } catch (err) {
    console.error('[place-lookup] failed:', err.message);
    return res.status(200).json({ found: false, reason: 'error' });
  }
}
