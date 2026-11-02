// Each genre's energy side + family — Ami's classification (2026-11-02), the
// source of truth for the split onboarding decks (energetic first, then calm).
//
//   both      — a real calm side AND a real energetic side (calm R&B and
//               upbeat R&B are different listening experiences). May appear on
//               either deck, or on both, and may sit in the taste profile
//               twice (once per side).
//   calm      — calm deck / calm playlists only.
//   energetic — energetic deck / energetic playlists only.
//
// Changes to Ami's sheet, agreed with him on 2026-11-02:
//   - Jazz (Standards), Gypsy jazz, Argentine Tango, Acoustic Blues moved from
//     "both" to calm-only: almost none of their songs reach energy 60–80.
//   - The "both" genres with few calm songs (Rock, Indie Dance, Salsa…) stay
//     "both"; Ami adds playlists if they run short.
// Missing from Ami's sheet: Country, IndieTronica, Jazz House, Swing Jazz —
// both ways (Roni, 2026-11-02), with no family. His sheet also listed
// "Turkish Funk", which is not in shared/genre-universe.js (to ask him).
//
// Card / playlist energy ranges (track_analyses.energy, 0–100): Ami's deck
// ranges, plus per-genre exceptions for genres whose songs sit almost entirely
// below 30 or above 80 (measured on the catalog 2026-11-02 — e.g. Chamber
// music: 2% of its songs at 30–50, 94% at 0–20). Borderline genres (Deep
// House, UKG, Dabke, Samba, Hip House, Bhangra Hip Hop…) stay on 60–80 (Roni).
//
// Pure, no imports beyond the genre list — browser + server.
import { GENRES } from './genre-universe.js';

export const DECKS = ['energetic', 'calm'];

export const DECK_WINDOWS = { energetic: [60, 80], calm: [30, 50] };

export const FAMILIES = {
  'rock-indie-pop':    { en: 'Rock, Indie & Pop',                   he: 'רוק, אינדי ופופ' },
  'blues-soul-rnb':    { en: 'Blues, Soul & R&B',                   he: 'בלוז, סול ו-R&B' },
  'jazz-world-fusion': { en: 'Jazz & World Fusion',                 he: "ג'אז ופיוז'ן עולמי" },
  'latin-world-mizrahi': { en: 'Latin, World & Mizrahi',            he: 'לטיני, עולם ומזרחית' },
  'electronic-chill-afro': { en: 'Electronic, Chillout & Afro',     he: "אלקטרוני, צ'ילאאוט ואפרו" },
  'electronic-club':   { en: 'Electronic, Club & Party',            he: 'אלקטרוני, קלאב ומסיבות' },
  'rhythmic-latin-folk': { en: 'Rhythmic Latin & Folk',             he: 'קצביים, לטיני ועממי' },
  'heavy-rock':        { en: 'Heavy Rock, Metal & Punk',            he: 'רוק כבד, מטאל ופאנק' },
  'hip-hop':           { en: 'Hip Hop, Trap & Grime',               he: 'היפ הופ, טראפ וגריים' },
  'folk-acoustic':     { en: 'Folk, Acoustic & Singer-Songwriters', he: 'פולק, אקוסטי וסונגרייטרס' },
  'ambient-lofi':      { en: 'Ambient & LoFi',                      he: 'אמביאנט ולו-פיי' },
  'quiet-jazz-classical': { en: 'Quiet Jazz & Classical',           he: "ג'אז וקלאסי שקט" },
  'city-pop-folk-israeli': { en: 'City Pop, Folk & Quiet Israeli',  he: 'סיטי פופ, עממי וישראלי שקט' },
  'unclassified':      { en: 'No family',                           he: 'בלי משפחה' },
};

// [genre, family, side]. Order = Ami's sheet.
const ROWS = [
  ['Rock', 'rock-indie-pop', 'both'],
  ['Britpop', 'rock-indie-pop', 'both'],
  ['Indie Rock', 'rock-indie-pop', 'both'],
  ['Jangle pop', 'rock-indie-pop', 'both'],
  ['Surf Rock', 'rock-indie-pop', 'both'],
  ['רוק ישראלי', 'rock-indie-pop', 'both'],
  ['אינדי ישראלי', 'rock-indie-pop', 'both'],
  ['Modern Pop', 'rock-indie-pop', 'both'],
  ['Female Pop', 'rock-indie-pop', 'both'],
  ['Alternative pop', 'rock-indie-pop', 'both'],
  ['K-Pop', 'rock-indie-pop', 'both'],
  ['80s Pop', 'rock-indie-pop', 'both'],
  ["90's pop party", 'rock-indie-pop', 'both'],
  ['Japanese City Pop', 'rock-indie-pop', 'both'],
  ['פופ ישראלי', 'rock-indie-pop', 'both'],
  ['פופ מזרחית', 'rock-indie-pop', 'both'],
  ['פופ אמוני ישראלי', 'rock-indie-pop', 'both'],

  ['Acoustic Blues', 'blues-soul-rnb', 'calm'],
  ['Blues', 'blues-soul-rnb', 'both'],
  ['Funk', 'blues-soul-rnb', 'both'],
  ['Mo Town', 'blues-soul-rnb', 'both'],
  ['Neo Soul', 'blues-soul-rnb', 'both'],
  ['Rnb', 'blues-soul-rnb', 'both'],
  ['French RnB', 'blues-soul-rnb', 'both'],
  ['Latin RnB', 'blues-soul-rnb', 'both'],
  ['Japanese RnB', 'blues-soul-rnb', 'both'],
  ['Korean RnB', 'blues-soul-rnb', 'both'],
  ['Alternative R&B', 'blues-soul-rnb', 'both'],

  ['Jazz (Standards)', 'jazz-world-fusion', 'calm'],
  ['Afro Cuban Jazz', 'jazz-world-fusion', 'both'],
  ['Gypsy jazz', 'jazz-world-fusion', 'calm'],
  ['Ethio-Jazz', 'jazz-world-fusion', 'both'],
  ['Afro Funk', 'jazz-world-fusion', 'both'],
  ['Latin Funk', 'jazz-world-fusion', 'both'],
  ['Arabic Funk', 'jazz-world-fusion', 'both'],
  ['Greek Funk', 'jazz-world-fusion', 'both'],
  ['Italian Funk', 'jazz-world-fusion', 'both'],
  ['French Funk', 'jazz-world-fusion', 'both'],
  ['Acid Jazz', 'jazz-world-fusion', 'both'],

  ['Salsa', 'latin-world-mizrahi', 'both'],
  ['Reggae', 'latin-world-mizrahi', 'both'],
  ['Reggaeton', 'latin-world-mizrahi', 'both'],
  ['Musica Tropical', 'latin-world-mizrahi', 'both'],
  ['Flamenco', 'latin-world-mizrahi', 'both'],
  ['Bolero', 'latin-world-mizrahi', 'both'],
  ['Argentine Tango', 'latin-world-mizrahi', 'calm'],
  ['Peruvian Cumbia', 'latin-world-mizrahi', 'both'],
  ['Peruvian Chicha', 'latin-world-mizrahi', 'both'],
  ['Samba-Choro', 'latin-world-mizrahi', 'both'],
  ['Tishoumaren', 'latin-world-mizrahi', 'both'],
  ['Cha Cha Cha', 'latin-world-mizrahi', 'both'],
  ['Latin Boogaloo', 'latin-world-mizrahi', 'both'],
  ['Anatolian Psychedelic Rock', 'latin-world-mizrahi', 'both'],
  ['African Highlife', 'latin-world-mizrahi', 'both'],
  ['Algerian Rai', 'latin-world-mizrahi', 'both'],
  ['Laiko', 'latin-world-mizrahi', 'both'],
  ['Thai Molam', 'latin-world-mizrahi', 'both'],
  ['Italian Folk', 'latin-world-mizrahi', 'both'],
  ['Dancehall', 'latin-world-mizrahi', 'both'],
  ['מזרחית ישנה', 'latin-world-mizrahi', 'both'],

  ['Indie Dance', 'electronic-chill-afro', 'both'],
  ['Organic House', 'electronic-chill-afro', 'both'],
  ['Amapiano', 'electronic-chill-afro', 'both'],
  ['AfroBeats', 'electronic-chill-afro', 'both'],
  ['Brazilian Funk', 'electronic-chill-afro', 'both'],
  ['Disco', 'electronic-chill-afro', 'both'],
  ['DownTempo', 'electronic-chill-afro', 'both'],
  ['French DownTempo', 'electronic-chill-afro', 'both'],
  ['Latin DownTempo', 'electronic-chill-afro', 'both'],
  ['Andean Chill', 'electronic-chill-afro', 'both'],

  ['Deep House', 'electronic-club', 'energetic'],
  ['Soulful House', 'electronic-club', 'energetic'],
  ['French Touch', 'electronic-club', 'energetic'],
  ['Electro Pop', 'electronic-club', 'energetic'],
  ['Electronic R&B', 'electronic-club', 'energetic'],
  ['Tech House', 'electronic-club', 'energetic'],
  ['UKG', 'electronic-club', 'energetic'],
  ['Dubstep', 'electronic-club', 'energetic'],
  ['Uplifting & Vocal Trance', 'electronic-club', 'energetic'],
  ['Progressive & Psy Trance', 'electronic-club', 'energetic'],
  ['Hip House', 'electronic-club', 'energetic'],
  ['Afro House', 'electronic-club', 'energetic'],
  ['Nu Disco', 'electronic-club', 'energetic'],
  ['Italo Disco', 'electronic-club', 'energetic'],
  ['Future Funk', 'electronic-club', 'energetic'],
  ['Electro Swing', 'electronic-club', 'energetic'],

  ['Samba', 'rhythmic-latin-folk', 'energetic'],
  ['Dabke', 'rhythmic-latin-folk', 'energetic'],

  ['Heavy Rock+Metal', 'heavy-rock', 'energetic'],
  ['Nu Metal', 'heavy-rock', 'energetic'],
  ['Grunge', 'heavy-rock', 'energetic'],
  ['Punk', 'heavy-rock', 'energetic'],
  ['Post Punk', 'heavy-rock', 'energetic'],

  ['Hip Hop', 'hip-hop', 'energetic'],
  ['French Hip Hop', 'hip-hop', 'energetic'],
  ['Icelandic Hip Hop', 'hip-hop', 'energetic'],
  ['German Hip Hop', 'hip-hop', 'energetic'],
  ['Trap', 'hip-hop', 'energetic'],
  ['Grime & Drill', 'hip-hop', 'energetic'],
  ['Bhangra Hip Hop', 'hip-hop', 'energetic'],
  ['היפ הופ ישראלי', 'hip-hop', 'energetic'],

  ['Folk', 'folk-acoustic', 'calm'],
  ['Indie Folk', 'folk-acoustic', 'calm'],
  ['Bossa Nova', 'folk-acoustic', 'calm'],
  ['Fado', 'folk-acoustic', 'calm'],
  ['French Musette', 'folk-acoustic', 'calm'],
  ['French Ye Ye', 'folk-acoustic', 'calm'],
  ['Neo Exotica', 'folk-acoustic', 'calm'],
  ['Morna', 'folk-acoustic', 'calm'],
  ['Lovers Rock', 'folk-acoustic', 'calm'],
  ['Bedroom Pop', 'folk-acoustic', 'calm'],
  ['Soft Pop Hits', 'folk-acoustic', 'calm'],
  ['Doo-Wop', 'folk-acoustic', 'calm'],
  ['Japanese Folk', 'folk-acoustic', 'calm'],
  ['Hawaii ukulele music', 'folk-acoustic', 'calm'],

  ['Meditative Ambient', 'ambient-lofi', 'calm'],
  ['LoFi Bossa', 'ambient-lofi', 'calm'],
  ['LoFi Beats', 'ambient-lofi', 'calm'],
  ['Desi LoFi', 'ambient-lofi', 'calm'],
  ['JazzHop', 'ambient-lofi', 'calm'],
  ['Trip Hop', 'ambient-lofi', 'calm'],
  ['Electronic Chillout', 'ambient-lofi', 'calm'],

  ['Smooth Jazz', 'quiet-jazz-classical', 'calm'],
  ['Late Night jazz', 'quiet-jazz-classical', 'calm'],
  ['Easy Listening', 'quiet-jazz-classical', 'calm'],
  ['French Jazz', 'quiet-jazz-classical', 'calm'],
  ['Chamber music', 'quiet-jazz-classical', 'calm'],
  ['Piano Impressionism', 'quiet-jazz-classical', 'calm'],
  ['Baroque', 'quiet-jazz-classical', 'calm'],
  ['Medieval Music', 'quiet-jazz-classical', 'calm'],

  ['Arab Classic', 'city-pop-folk-israeli', 'calm'],
  ['Rebetiko', 'city-pop-folk-israeli', 'calm'],
  ['Turk Arabesk', 'city-pop-folk-israeli', 'calm'],
  ['Chinese City Pop', 'city-pop-folk-israeli', 'calm'],
  ['Cantopop', 'city-pop-folk-israeli', 'calm'],
  ['שירי ארץ ישראל', 'city-pop-folk-israeli', 'calm'],
  ['בלדות ישראליות', 'city-pop-folk-israeli', 'calm'],
  ['שירי יום הזיכרון והשואה', 'city-pop-folk-israeli', 'calm'],

  ['Country', 'unclassified', 'both'],
  ['IndieTronica', 'unclassified', 'both'],
  ['Jazz House', 'unclassified', 'both'],
  ['Swing Jazz', 'unclassified', 'both'],
];

// Per-genre card / playlist range when the deck's range misses most of the
// genre's songs. Share of the genre's songs in the deck range → in this one.
export const EXCEPTION_WINDOWS = {
  'Chamber music':            { calm: [0, 20] },      //  2% → 94%
  'Piano Impressionism':      { calm: [0, 20] },      //  2% → 93%
  'Meditative Ambient':       { calm: [0, 20] },      //  1% → 95%
  'Baroque':                  { calm: [0, 20] },      // 12% → 70%
  'Late Night jazz':          { calm: [0, 20] },      // 13% → 67%
  'Japanese Folk':            { calm: [0, 20] },      // 17% → 62%
  'LoFi Beats':               { calm: [10, 30] },     // 22% → 51%
  'Jazz (Standards)':         { calm: [10, 30] },     // 25% → 52%
  'Uplifting & Vocal Trance': { energetic: [80, 100] }, //  7% → 92%
  'Punk':                     { energetic: [80, 100] }, // 13% → 85%
  'Nu Metal':                 { energetic: [80, 100] }, // 16% → 80%
  'Tech House':               { energetic: [80, 100] }, // 22% → 75%
  'Progressive & Psy Trance': { energetic: [80, 100] }, // 23% → 75%
  'Dubstep':                  { energetic: [80, 100] }, // 25% → 71%
};

const CANON = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
const BY_GENRE = new Map(ROWS.map(([genre, family, side]) => [genre, { genre, family, side }]));

export const GENRE_SIDE_ROWS = ROWS.map(([genre, family, side]) => ({ genre, family, side }));
export const UNCLASSIFIED = new Set(ROWS.filter((r) => r[1] === 'unclassified').map((r) => r[0]));

const canonical = (g) => (typeof g === 'string' ? CANON.get(g.trim().toLowerCase()) || null : null);

// 'both' | 'calm' | 'energetic' — 'both' for a genre not in the table.
export function genreSide(g) {
  return BY_GENRE.get(canonical(g))?.side || 'both';
}

export function genreFamily(g) {
  return BY_GENRE.get(canonical(g))?.family || 'unclassified';
}

// deck: 'energetic' | 'calm'.
export function allowedOnDeck(g, deck) {
  const side = genreSide(g);
  return side === 'both' || side === deck;
}

// [min, max] — the genre's exception for that deck / side, else the deck's.
export function deckWindow(g, deck) {
  return EXCEPTION_WINDOWS[canonical(g)]?.[deck] || DECK_WINDOWS[deck];
}

// The prompt block: every genre by side, then by family.
export function genreSidesList() {
  const order = [['both', 'Both ways (a calm side AND an energetic side)'], ['energetic', 'Energetic only'], ['calm', 'Calm only']];
  const out = [];
  for (const [side, title] of order) {
    out.push(`**${title}**`);
    const families = [...new Set(ROWS.filter((r) => r[2] === side).map((r) => r[1]))];
    for (const f of families) {
      const genres = ROWS.filter((r) => r[2] === side && r[1] === f).map((r) => `\`${r[0]}\``);
      const name = f === 'unclassified' ? 'Other' : FAMILIES[f].en;
      out.push(`- ${name}: ${genres.join(', ')}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}
