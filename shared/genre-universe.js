// Single source of truth for the canonical genre list used across v5, v6, v7.
//
// Consumers:
//   - v6/generation/musical-directions.js  (v6 R1 prompt — imports GENRE_UNIVERSE_SECTION)
//   - v6/generation/refined-directions.js  (v6 R2 prompt — transitively via musical-directions.js)
//   - v5/generation/musical-directions.js  (byte-identical mirror; Ami's prompt-tuning dashboard reads it)
//   - v6/generation/genre-list.js          (event-playlist Haiku prompt — re-exports GENRES / GENRE_SET)
//   - v6/account/direction-chat prompt     (transitively via musical-directions.js)
//   - v7/generation/musical-directions.js  (v7 R1 prompt)
//   - v7/generation/refined-directions.js  (v7 R2 prompt — transitively via v7 musical-directions.js)
//
// DB matches are case-insensitive but spelling must match verbatim. If a genre
// is renamed, added, or removed here, the change flows to every consumer above
// automatically — no more three-place manual-sync invariant.
//
// Notable non-obvious entries (see also the notes in v6/generation/genre-list.js):
//   - "Heavy Rock+Metal" is intentionally ONE entry — the DB combines them
//   - "Nu Metal" is a separate DB entry — kept on its own line
//   - "Medieval Music" (sheet spells it correctly; was "Medievil music" pre-2026-07-28)
//   - "Peruvian Cumbia" (not Cumbria — Cumbia is the music, Cumbria is a UK county)
//   - "Downtempo" is one word, "Easy Listening" has no "(50s)"
//
// GENRES is ordered to match the pre-refactor GENRE_UNIVERSE_SECTION string in
// v6/generation/musical-directions.js so that `GENRES.join(', ')` reproduces
// the exact string that shipped, byte-for-byte. If you reorder this list, the
// prompt cache prefix will invalidate. Verify byte-identity before merging.
export const GENRES = [
  'Alternative pop',
  'Alternative R&B',
  '80s Pop',
  "90's pop party",
  'Acid Jazz',
  'African Highlife',
  'Afro Funk',
  'Afro House',
  'AfroBeats',
  'Algerian Rai',
  'Amapiano',
  'Anatolian Psychedelic Rock',
  'Arab Classic',
  'Arabic Funk',
  'Argentine Tango',
  'Baroque',
  'Bedroom Pop',
  'Blues',
  'Bolero',
  'Bossa Nova',
  'Britpop',
  'Cantopop',
  'Cha Cha Cha',
  'Chamber music',
  'Chinese City Pop',
  'Country',
  'Dabke',
  'Dancehall',
  'Deep House',
  'Desi LoFi',
  'Disco',
  'DownTempo',
  'Easy Listening',
  'Electro Pop',
  'Electro Swing',
  'Ethio-Jazz',
  'Fado',
  'Female Pop',
  'Flamenco',
  'Folk',
  'French DownTempo',
  'French Funk',
  'French Hip Hop',
  'French Jazz',
  'French RnB',
  'French Ye Ye',
  'Funk',
  'German Hip Hop',
  'Greek Funk',
  'Grunge',
  'Gypsy jazz',
  'Hawaii ukulele music',
  'Heavy Rock+Metal',
  'Hip Hop',
  'Icelandic Hip Hop',
  'Indie Dance',
  'Indie Folk',
  'Indie Rock',
  'IndieTronica',
  'Italian Funk',
  'Italo Disco',
  'Japanese City Pop',
  'Japanese Folk',
  'Japanese RnB',
  'Jazz (Standards)',
  'Jazz House',
  'JazzHop',
  'K-Pop',
  'Korean RnB',
  'Laiko',
  'Latin Boogaloo',
  'Latin Funk',
  'Late Night jazz',
  'LoFi Beats',
  'LoFi Bossa',
  'Lovers Rock',
  'Medieval Music',
  'Modern Pop',
  'Musica Tropical',
  'Neo Exotica',
  'Neo Soul',
  'Nu Disco',
  'Nu Metal',
  'Organic House',
  'Peruvian Chicha',
  'Peruvian Cumbia',
  'Piano Impressionism',
  'Post Punk',
  'Progressive & Psy Trance',
  'Punk',
  'Rebetiko',
  'Reggae',
  'Reggaeton',
  'Rnb',
  'Rock',
  'Salsa',
  'Samba',
  'Samba-Choro',
  'Smooth Jazz',
  'Soulful House',
  'Swing Jazz',
  'Tech House',
  'Thai Molam',
  'Tishoumaren',
  'Trap',
  'Turk Arabesk',
  'UKG',
  'Uplifting & Vocal Trance',
  'Dubstep',
  'Grime & Drill',
  'בלדות ישראליות',
  'פופ מזרחית',
  'מזרחית ישנה',
  'רוק ישראלי',
  'שירי ארץ ישראל',
  'שירי יום הזיכרון והשואה',
];

export const GENRE_SET = new Set(GENRES);

// Formatted section for prompt inclusion. Byte-identical to the pre-refactor
// v6 GENRE_UNIVERSE_SECTION string — the composed EDITABLE_PROMPT_SECTION in
// v5/v6 stays exactly what it was, so the Anthropic prompt cache prefix
// remains valid and Ami's dashboard textarea contents don't shift.
export const GENRE_UNIVERSE_SECTION = `## Genre Universe

The ONLY genres you may use are the ones in this list. Do not invent, rename, translate, or combine genres. If a musical style is not in the list, it does not exist for the purposes of this task.

${GENRES.join(', ')}`;
