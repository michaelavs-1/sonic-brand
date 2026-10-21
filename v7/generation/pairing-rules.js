// v7 pairing rules that code enforces on daily-playlist recipes (2026-10-21).
//
// Ami's isolation rules are in the recipe prompts (energy-directions.js §12–§13,
// level-directions.js §11–§12), but Gemini still broke them in about 1 recipe
// in 20 (the 2026-10-21 rebuild). Two of them are clear-cut lists, so the
// normalizers fix them after Gemini answers:
//   - Rule 0: Electronic R&B shares a recipe only with house genres, Nu Disco
//     or Indie Dance.
//   - Rule 0.2: DownTempo genres share a recipe only with each other; so do
//     LoFi genres.
// The pure-pop rule is left to the prompt: its "mainstream commercial
// siblings when the mood demands it" clause can't be checked in code.
//
// A recipe that breaks a rule keeps its larger side; the genres taken out form
// a recipe of their own when no other recipe of the tier / level plays them,
// so no genre loses its last recipe. Exempt genres (Option 1's requested
// genres, which go into every recipe of their tier) never count.
//
// Pure, no imports — browser + server.

const low = (g) => String(g).toLowerCase();
const lowSet = (list) => new Set(list.map(low));

export const ELECTRONIC_RNB = 'Electronic R&B';
const ELECTRONIC_RNB_PARTNERS = lowSet([
  'Afro House', 'Deep House', 'Soulful House', 'Tech House', 'Jazz House', 'Organic House', 'Nu Disco', 'Indie Dance',
]);
export const DOWNTEMPO_FAMILY = ['DownTempo', 'French DownTempo', 'Latin DownTempo'];
export const LOFI_FAMILY = ['LoFi Beats', 'Desi LoFi', 'LoFi Bossa'];
const FAMILIES = [
  { name: 'DownTempo', genres: lowSet(DOWNTEMPO_FAMILY) },
  { name: 'LoFi', genres: lowSet(LOFI_FAMILY) },
];

// One recipe's genres → { keep, out: [{ genres, why }] }. Rule 0.2 first (the
// smaller side leaves; on a tie the family leaves), then Rule 0 on what's left
// (Electronic R&B leaves when anything but its partners is there).
export function splitRecipe(genres, exempt = []) {
  const ex = lowSet(exempt);
  const free = (g) => !ex.has(low(g));
  let keep = [...genres];
  const out = [];
  for (const fam of FAMILIES) {
    const members = keep.filter((g) => free(g) && fam.genres.has(low(g)));
    const rest = keep.filter((g) => free(g) && !fam.genres.has(low(g)));
    if (!members.length || !rest.length) continue;
    const leaving = members.length > rest.length ? rest : members;
    keep = keep.filter((g) => !leaving.includes(g));
    out.push({ genres: leaving, why: `${fam.name} only with ${fam.name}` });
  }
  const e = keep.find((g) => free(g) && low(g) === low(ELECTRONIC_RNB));
  if (e && keep.some((g) => g !== e && free(g) && !ELECTRONIC_RNB_PARTNERS.has(low(g)))) {
    keep = keep.filter((g) => g !== e);
    out.push({ genres: [e], why: 'Electronic R&B only with house / Nu Disco / Indie Dance' });
  }
  return { keep, out };
}

// The recipes of ONE tier (Option 1) or level (Option 2), as [{ title_en,
// genres }]. Returns { recipes, added, notes }: `recipes` = the same recipes
// in the same order with their genres fixed, `added` = new recipes for genres
// that no longer had one, `notes` = what was changed (for a console.warn).
export function enforceIsolation(recipes, exempt = []) {
  const notes = [];
  const fixed = recipes.map((r) => {
    const { keep, out } = splitRecipe(r.genres, exempt);
    for (const o of out) notes.push(`"${r.title_en}": took out ${o.genres.join(', ')} (${o.why})`);
    return { recipe: { ...r, genres: keep }, out };
  });
  const result = fixed.map((f) => f.recipe);
  const added = [];
  const plays = (g) => [...result, ...added].some((r) => r.genres.some((x) => low(x) === low(g)));
  const queue = fixed.flatMap((f) => f.out.map((o) => ({ title_en: f.recipe.title_en, genres: o.genres })));
  while (queue.length) {
    const next = queue.shift();
    const homeless = next.genres.filter((g) => !plays(g));
    if (!homeless.length) continue;
    // The taken-out group may break a rule itself (e.g. Electronic R&B + Rnb).
    const { keep, out } = splitRecipe(homeless, exempt);
    if (keep.length) {
      added.push({ title_en: `${next.title_en} (${keep.join(' & ')})`, genres: keep });
      notes.push(`new recipe for ${keep.join(', ')}`);
    }
    for (const o of out) queue.push({ title_en: next.title_en, genres: o.genres });
  }
  return { recipes: result, added, notes };
}
