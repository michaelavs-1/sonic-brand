// Read-only check (prod Supabase) that the onboarding cards take songs inside
// their deck's energy range — run after migration
// v5/precompute/migrations/2026-11-02-v7-anchor-tracks-energy.sql.
//
// Calls v7_anchor_tracks with the anon key (as /api/v7/anchor-tracks does, so
// the 3s anon timeout applies), then reads the picked songs' energy with the
// service key. Each genre is drawn on each deck it can appear on, several times.
//
// Run: node scripts/test-anchor-tracks-energy.mjs
import fs from 'node:fs';
import { deckWindow, allowedOnDeck } from '../shared/genre-sides.js';

for (const line of fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}
const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GENRES = ['Rnb', 'Flamenco', 'Bossa Nova', 'Hip Hop', 'Chamber music', 'Dubstep', 'Funk', 'Indie Dance', 'Meditative Ambient', 'Tech House'];
const ROUNDS = 3;

const specs = [];
for (const g of GENRES) {
  for (const deck of ['energetic', 'calm']) {
    if (!allowedOnDeck(g, deck)) continue;
    const [lo, hi] = deckWindow(g, deck);
    specs.push({ genre: g, deck, lo, hi });
  }
}

let inside = 0, near = 0, missing = 0;
const rows = [];
for (let round = 0; round < ROUNDS; round++) {
  const payload = specs.map((s, i) => ({ rank: i + 1, genre: s.genre, inst_pref: 'none', pop_pref: 'none', lo: s.lo, hi: s.hi }));
  // 6 cards per call, like a deck.
  const picks = [];
  const times = [];
  for (let k = 0; k < payload.length; k += 6) {
    const t0 = Date.now();
    const r = await fetch(`${SB}/rest/v1/rpc/v7_anchor_tracks`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_specs: payload.slice(k, k + 6) }),
    });
    times.push(Date.now() - t0);
    if (!r.ok) { console.log(`round ${round + 1}, cards ${k + 1}–${k + 6}: ${r.status} ${await r.text()}`); process.exitCode = 1; continue; }
    picks.push(...await r.json());
  }
  const ms = times.join(' / ');
  const ids = picks.map((p) => p.spotify_id);
  const er = await fetch(`${SB}/rest/v1/track_analyses?select=spotify_id,energy&spotify_id=in.(${ids.map((x) => `"${x}"`).join(',')})`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  const energy = new Map((await er.json()).map((x) => [x.spotify_id, x.energy]));
  console.log(`round ${round + 1}: ${picks.length}/${specs.length} cards in ${ms}ms`);
  specs.forEach((s, i) => {
    const pick = picks.find((p) => p.rank === i + 1);
    if (!pick) { missing++; rows.push(`  ${s.genre} [${s.deck} ${s.lo}–${s.hi}]: no card`); return; }
    const e = Number(energy.get(pick.spotify_id));
    const ok = e >= s.lo && e <= s.hi;
    if (ok) inside++; else near++;
    rows.push(`  ${s.genre} [${s.deck} ${s.lo}–${s.hi}]: ${e}${ok ? '' : '  (outside — nearest available)'}`);
  });
}
console.log(rows.join('\n'));
console.log(`\ninside the range: ${inside} · outside (nearest): ${near} · no card: ${missing}`);
if (inside === 0) {
  console.log('No card inside its range — has the 2026-11-02 migration been run?');
  process.exitCode = 1;
}
