// Offline tests for the two-deck onboarding (Ami, 2026-11-02): the genre sides
// table, the deck normalizer, the two-sided taste profile, and the recipe code
// accepting a genre on both sides.
// Run: node --test scripts/test-genre-sides.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENRES } from '../shared/genre-universe.js';
import {
  GENRE_SIDE_ROWS, EXCEPTION_WINDOWS, DECK_WINDOWS, UNCLASSIFIED,
  genreSide, allowedOnDeck, deckWindow, genreSidesList,
} from '../shared/genre-sides.js';
import {
  normalizeDeckDirections, assembleDeckSystemPrompt, buildDeckUserMessage, DECK_EDITABLE_PROMPT_SECTION,
  DECK_ORDER, VENUE_CATEGORIES, DEFAULT_VENUE_CATEGORY, normalizeVenueCategory,
} from '../v7/generation/deck-directions.js';
import {
  normalizeDeckTasteProfile, buildDeckTasteUserMessage, assembleDeckTasteSystemPrompt, DECK_TASTE_EDITABLE_PROMPT_SECTION,
} from '../v7/generation/taste-profile-decks.js';
import { normalizeEnergyDirections } from '../v7/generation/energy-directions.js';
import { normalizeLevelDirections, approvedByLevel } from '../v7/generation/level-directions.js';
import { requestedByTier } from '../v7/generation/option1-draw.js';

// ---------- the table ----------

test('every genre in the list has exactly one row, spelled as in the list', () => {
  const names = GENRE_SIDE_ROWS.map((r) => r.genre);
  assert.equal(new Set(names).size, names.length, 'no genre twice');
  assert.deepEqual([...names].sort(), [...GENRES].sort());
});

test('side counts: Ami\'s sheet with the 4 thin-energetic genres moved to calm, 4 unclassified as both', () => {
  const count = (side) => GENRE_SIDE_ROWS.filter((r) => r.side === side).length;
  assert.equal(count('energetic'), 31);
  assert.equal(count('calm'), 41);
  assert.equal(count('both'), 70);
  assert.deepEqual([...UNCLASSIFIED].sort(), ['Country', 'IndieTronica', 'Jazz House', 'Swing Jazz']);
  for (const g of ['Jazz (Standards)', 'Gypsy jazz', 'Argentine Tango', 'Acoustic Blues']) assert.equal(genreSide(g), 'calm', g);
  assert.equal(genreSide('Organic House'), 'both');
});

test('exception ranges sit on a side the genre has', () => {
  for (const [g, w] of Object.entries(EXCEPTION_WINDOWS)) {
    assert.ok(GENRES.includes(g), g);
    for (const deck of Object.keys(w)) assert.ok(allowedOnDeck(g, deck), `${g} → ${deck}`);
  }
  assert.deepEqual(deckWindow('Chamber music', 'calm'), [0, 20]);
  assert.deepEqual(deckWindow('dubstep', 'energetic'), [80, 100]);
  assert.deepEqual(deckWindow('Rnb', 'calm'), DECK_WINDOWS.calm);
  assert.deepEqual(deckWindow('Deep House', 'energetic'), DECK_WINDOWS.energetic);
});

test('allowedOnDeck follows the side, case-insensitively', () => {
  assert.ok(allowedOnDeck('rnb', 'calm') && allowedOnDeck('Rnb', 'energetic'));
  assert.ok(allowedOnDeck('Bossa Nova', 'calm') && !allowedOnDeck('Bossa Nova', 'energetic'));
  assert.ok(allowedOnDeck('Tech House', 'energetic') && !allowedOnDeck('Tech House', 'calm'));
});

test('the prompt list names every genre once', () => {
  const text = genreSidesList();
  for (const g of GENRES) assert.equal(text.split(`\`${g}\``).length - 1, 1, g);
});

// ---------- deck directions ----------

const dir = (rank, genres, title = `T${rank}`) => ({ rank, title_en: title, genres, description_he: 'תיאור. בודק משהו.' });

test('deck normalizer drops wrong-side and unknown genres, ranks from the deck start, house last, max 6', () => {
  const parsed = { directions: [
    dir(1, ['Deep House', 'Tech House']),
    dir(2, ['rnb', 'Korean RnB', 'Bossa Nova']),
    dir(3, ['Slow Funk']),
    dir(4, ['Hip Hop']), dir(5, ['Trap']), dir(6, ['Funk']), dir(7, ['Disco']), dir(8, ['Salsa']),
  ] };
  const { directions, dropped } = normalizeDeckDirections(parsed, 'energetic');
  assert.equal(directions.length, 6);
  assert.deepEqual(directions.map((d) => d.rank), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(directions[0].genres, ['Rnb', 'Korean RnB']);
  assert.ok(directions.every((d) => d.deck === 'energetic'));
  assert.ok(dropped.includes('Bossa Nova → energetic') && dropped.includes('Slow Funk → energetic'));
  assert.ok(!directions.some((d) => d.genres.includes('Deep House')), 'house went last and fell past 6');

  const calm = normalizeDeckDirections({ directions: [dir(1, ['Bossa Nova', 'Hip Hop'])] }, 'calm');
  assert.equal(calm.directions[0].rank, 7);
  assert.deepEqual(calm.directions[0].genres, ['Bossa Nova']);
});

test('deck prompts assemble with Places injected and no undefined', () => {
  const sys = assembleDeckSystemPrompt(DECK_EDITABLE_PROMPT_SECTION);
  assert.ok(sys.includes('Google Places Context'));
  assert.ok(sys.includes('## Deck Rules') && sys.includes('produce the deck'));
  assert.ok(!/undefined/.test(sys));
  assert.ok(buildDeckUserMessage({ deck: 'calm', bizDesc: 'בית קפה' }).includes('DECK: CALM'));
  const tsys = assembleDeckTasteSystemPrompt(DECK_TASTE_EDITABLE_PROMPT_SECTION);
  assert.ok(tsys.includes('## Sides') && tsys.includes('except `Organic House`') && !/undefined/.test(tsys));
});

test('calm deck first (2026-11-03); the prompt says so and asks for the venue category', () => {
  assert.deepEqual(DECK_ORDER, ['calm', 'energetic']);
  const sys = assembleDeckSystemPrompt(DECK_EDITABLE_PROMPT_SECTION);
  assert.ok(sys.includes('a CALM deck first, then an ENERGETIC deck'));
  assert.ok(sys.includes('## Rules for the Venue Category') && sys.includes('"venue_category": "food-drink"'));
});

test('venue category: the three categories pass, anything else is food-drink', () => {
  assert.deepEqual(VENUE_CATEGORIES, ['food-drink', 'beauty', 'clothing']);
  assert.equal(normalizeVenueCategory('beauty'), 'beauty');
  assert.equal(normalizeVenueCategory(' Clothing '), 'clothing');
  assert.equal(normalizeVenueCategory('food-drink'), 'food-drink');
  for (const v of [undefined, null, '', 'gym', 'clothes', 42]) assert.equal(normalizeVenueCategory(v), DEFAULT_VENUE_CATEGORY, String(v));
  assert.equal(DEFAULT_VENUE_CATEGORY, 'food-drink');
});

test('taste-profile user message lists both decks and the super-likes per deck', () => {
  const m = buildDeckTasteUserMessage({
    bizDesc: 'בר', directions: [{ ...dir(1, ['Rnb']), deck: 'energetic' }, { ...dir(7, ['Rnb']), deck: 'calm' }],
    likedDirections: [{ rank: 7 }], dislikedDirections: [{ rank: 1 }],
    superLikedByDeck: { energetic: [], calm: ['Rnb'] },
  });
  assert.ok(m.includes('Energetic deck directions') && m.includes('Calm deck directions'));
  assert.ok(m.includes('SUPER-LIKED GENRES on the calm deck: Rnb'));
  assert.ok(m.includes('LIKED (ranks): 7'));
});

// ---------- two-sided taste profile ----------

const both = { energetic: true, calm: true };

test('sides on: a both-ways genre keeps one entry per side; single-side genres move to their half', () => {
  const p = normalizeDeckTasteProfile({
    energy_levels_total: 4,
    approved_genres: [
      { genre: 'Rnb', energy_level: 3 }, { genre: 'Rnb', energy_level: 1 }, { genre: 'Rnb', energy_level: 4 },
      { genre: 'Bossa Nova', energy_level: 4 }, { genre: 'Hip Hop', energy_level: 1 },
    ],
    conditional_genres: [{ genre: 'Rnb', energy_level: 2, note_en: 'dup on the calm side' }],
  }, { decksLiked: both });
  const lv = (g) => p.approved_genres.filter((e) => e.genre === g).map((e) => e.energy_level).sort();
  assert.deepEqual(lv('Rnb'), [1, 3]);
  assert.deepEqual(lv('Bossa Nova'), [2]);
  assert.deepEqual(lv('Hip Hop'), [3]);
  assert.equal(p.conditional_genres.length, 0, 'the calm-side conditional Rnb loses to the approved one');
  assert.equal(p.energy_levels_total, 4);
});

test('sides on: super-likes land on their deck\'s side; calm side shifts down to level 1', () => {
  const p = normalizeDeckTasteProfile({
    energy_levels_total: 6,
    approved_genres: [{ genre: 'Rnb', energy_level: 5 }, { genre: 'Fado', energy_level: 3 }],
    conditional_genres: [{ genre: 'Neo Soul', energy_level: 2, note_en: '' }],
  }, { decksLiked: both, superLikedByDeck: { calm: ['Rnb', 'Neo Soul'], energetic: [] } });
  const lv = (g) => p.approved_genres.filter((e) => e.genre === g).map((e) => e.energy_level).sort();
  assert.deepEqual(lv('Rnb'), [1, 5], 'calm Rnb added at the middle of the calm half (2), then shifted with it');
  assert.deepEqual(lv('Neo Soul'), [1], 'moved out of conditional on the calm side, shifted 2 → 1');
  assert.deepEqual(lv('Fado'), [2]);
  assert.ok(p.requested_genres.includes('Rnb') && p.requested_genres.includes('Neo Soul'));
});

test('sides off (one deck without likes): one entry per genre, as before', () => {
  const p = normalizeDeckTasteProfile({
    energy_levels_total: 4,
    approved_genres: [{ genre: 'Rnb', energy_level: 3 }, { genre: 'Rnb', energy_level: 2 }, { genre: 'Bossa Nova', energy_level: 4 }],
  }, { decksLiked: { energetic: false, calm: true } });
  assert.equal(p.approved_genres.filter((e) => e.genre === 'Rnb').length, 1);
  // Not moved to the calm half; the lowest approved level (3) shifts to 1, N 4 → 2.
  assert.equal(p.approved_genres.find((e) => e.genre === 'Rnb').energy_level, 1);
  assert.equal(p.approved_genres.find((e) => e.genre === 'Bossa Nova').energy_level, 2);
  assert.equal(p.energy_levels_total, 2);
});

// ---------- recipe code with a genre on both sides ----------

const approved = [
  { genre: 'Rnb', energy_level: 4 }, { genre: 'Korean RnB', energy_level: 4 },
  { genre: 'Rnb', energy_level: 1 }, { genre: 'Neo Soul', energy_level: 1 },
];

test('requestedByTier puts a both-sides requested genre in both tiers', () => {
  assert.deepEqual(requestedByTier(['Rnb'], approved, 4), { high: ['Rnb'], low: ['Rnb'] });
});

test('Option 1 normalizer keeps a both-sides genre in both tiers', () => {
  const r = normalizeEnergyDirections({ directions: [
    { energy_tier: 'high', title_en: 'Up', genres: ['Rnb', 'Korean RnB'] },
    { energy_tier: 'low', title_en: 'Calm', genres: ['Rnb', 'Neo Soul'] },
    { energy_tier: 'low', title_en: 'Wrong', genres: ['Korean RnB'] },
  ] }, approved, 4);
  assert.deepEqual(r.directions.map((d) => `${d.energy_tier}:${d.genres.join('+')}`), ['high:Rnb+Korean RnB', 'low:Rnb+Neo Soul']);
});

test('Option 2 normalizer keeps a both-sides genre at both levels', () => {
  assert.equal(approvedByLevel(approved, 4).length, 4);
  const r = normalizeLevelDirections({ directions: [
    { energy_level: 4, title_en: 'Up', genres: ['Rnb', 'Korean RnB'] },
    { energy_level: 1, title_en: 'Calm', genres: ['Rnb', 'Neo Soul'] },
    { energy_level: 1, title_en: 'Wrong', genres: ['Korean RnB'] },
  ] }, approved, 4);
  assert.deepEqual(r.directions.map((d) => `${d.energy_level}:${d.genres.join('+')}`), ['4:Rnb+Korean RnB', '1:Rnb+Neo Soul']);
});

// ---------- onboarding (stage 2) ----------

test('Round 2 per deck: the deck normalizer takes Round 2 ranks and keeps 4', () => {
  const parsed = { directions: [1, 2, 3, 4, 5].map((i) => dir(i, ['Funk', 'Bossa Nova'])) };
  const { directions, dropped } = normalizeDeckDirections(parsed, 'energetic', { rankStart: 13, max: 4 });
  assert.deepEqual(directions.map((d) => d.rank), [13, 14, 15, 16]);
  assert.ok(directions.every((d) => d.genres.join() === 'Funk'));
  assert.equal(dropped.length, 5);
});

// ---------- taste chat on a two-sided profile (2026-11-02) ----------

import { stateFromRows, applyOps, stateToRows } from '../v7/generation/taste-ops.js';
import { formatTasteContext, buildTasteChatSystemPrompt } from '../v7/generation/taste-chat-prompt.js';

const twoSidedProfile = (extra = {}) => ({
  energy_levels_total: 4,
  approved_genres: [
    { genre: 'Rnb', energy_level: 4 }, { genre: 'Korean RnB', energy_level: 4 }, { genre: 'Hip Hop', energy_level: 3 },
    { genre: 'Rnb', energy_level: 1 }, { genre: 'Neo Soul', energy_level: 1 }, { genre: 'Bossa Nova', energy_level: 2 },
  ],
  conditional_genres: [], two_sided: true, ...extra,
});
const o1Rows = [
  { energy_tier: 'high', rank: 1, title_en: 'Up', genres: ['Rnb', 'Korean RnB'] },
  { energy_tier: 'high', rank: 2, title_en: 'Rap', genres: ['Hip Hop'] },
  { energy_tier: 'low', rank: 1, title_en: 'Calm', genres: ['Rnb', 'Neo Soul'] },
  { energy_tier: 'low', rank: 2, title_en: 'Bossa', genres: ['Bossa Nova'] },
];
const load = (profile) => stateFromRows({ mode: 'option1', profile, option1Rows: o1Rows });
const rnbLevels = (s) => s.approved.filter((a) => a.genre === 'Rnb').map((a) => a.energy_level).sort();

test('a two-sided profile keeps both sides of a genre through an unrelated change (and in the saved rows)', () => {
  const s = load(twoSidedProfile());
  assert.equal(s.twoSided, true);
  assert.deepEqual(rnbLevels(s), [1, 4]);
  const r = applyOps(s, [{ op: 'set_weight', genre: 'Bossa Nova', weight: 0.5 }]);
  assert.deepEqual(rnbLevels(r.state), [1, 4]);
  assert.ok(r.state.option1Dirs.find((d) => d.key === 'H1').genres.includes('Rnb'));
  assert.ok(r.state.option1Dirs.find((d) => d.key === 'C1').genres.includes('Rnb'));
  const rows = stateToRows(r.state, 'b');
  assert.equal(rows.profile.approved_genres.filter((a) => a.genre === 'Rnb').length, 2);
});

test('the flag missing but a genre in both halves → still two-sided', () => {
  assert.equal(load(twoSidedProfile({ two_sided: undefined })).twoSided, true);
});

test('remove_genre with a tier takes one side only; without, both — and turned down', () => {
  const s = load(twoSidedProfile());
  const one = applyOps(s, [{ op: 'remove_genre', genre: 'Rnb', tier: 'low' }]).state;
  assert.deepEqual(rnbLevels(one), [4]);
  assert.ok(!one.option1Dirs.some((d) => d.energy_tier === 'low' && d.genres.includes('Rnb')));
  assert.ok(one.option1Dirs.some((d) => d.energy_tier === 'high' && d.genres.includes('Rnb')));
  assert.ok(!one.rejected.includes('Rnb'));
  const all = applyOps(s, [{ op: 'remove_genre', genre: 'Rnb' }]).state;
  assert.deepEqual(rnbLevels(all), []);
  assert.ok(all.rejected.includes('Rnb'));
});

test('sides: calm-only stays calm, energetic-only stays energetic, both-ways can gain its other side', () => {
  const s = load(twoSidedProfile());
  const r = applyOps(s, [
    { op: 'move_genre', genre: 'Bossa Nova', energy_level: 3 },
    { op: 'add_genre', genre: 'Trap', energy_level: 1 },
    { op: 'add_genre', genre: 'Neo Soul', energy_level: 3 },
    { op: 'move_genre', genre: 'Rnb', energy_level: 2, tier: 'low' },
    { op: 'move_genre', genre: 'Rnb', energy_level: 3, tier: 'low' },
  ]);
  assert.deepEqual(r.dropped.map((d) => d.op.genre + ':' + d.reason.split(' —')[0]), [
    'Bossa Nova:calm-only genre', 'Trap:energetic-only genre', 'Rnb:already approved on that side',
  ]);
  assert.deepEqual(r.state.approved.filter((a) => a.genre === 'Neo Soul').map((a) => a.energy_level).sort(), [1, 3]);
  assert.deepEqual(rnbLevels(r.state), [2, 4]);
});

test('an older profile (no sides) behaves as before: a calm-only genre may still move up a tier', () => {
  const old = { energy_levels_total: 4, approved_genres: [{ genre: 'Bossa Nova', energy_level: 2 }, { genre: 'Fado', energy_level: 1 }] };
  const s = stateFromRows({ mode: 'option1', profile: old, option1Rows: [{ energy_tier: 'low', rank: 1, genres: ['Bossa Nova', 'Fado'] }] });
  assert.equal(s.twoSided, false);
  const r = applyOps(s, [{ op: 'move_genre', genre: 'Bossa Nova', energy_level: 3 }]);
  assert.equal(r.dropped.length, 0);
});

test('the chat sees the sides: profile line, ↕ marks, the curator list', () => {
  const ctx = formatTasteContext({ state: load(twoSidedProfile()), business: {}, now: {} });
  assert.ok(ctx.includes('This profile has sides: calm = levels 1–2, energetic = levels 3–4'));
  assert.ok(ctx.includes('Rnb [↕ both sides]'));
  const old = formatTasteContext({ state: stateFromRows({ mode: 'option1', profile: { energy_levels_total: 2, approved_genres: [{ genre: 'Rnb', energy_level: 2 }] } }), business: {}, now: {} });
  assert.ok(!old.includes('has sides') && !old.includes('↕'));
  const sys = buildTasteChatSystemPrompt('option1');
  assert.ok(sys.includes('## Calm side and energetic side') && sys.includes('## Genre sides'));
});
