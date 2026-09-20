// Re-export of the canonical genre list from the shared/genre-universe.js
// source of truth. Consumed by the event-playlist Haiku prompt
// (api/v6/account/event-playlist.js).
//
// This file used to hold its own copy of the array in a thematic order (rock
// → funk → jazz → …). Since 2026-09-20 the array lives in
// shared/genre-universe.js and the ordering there matches the prompt-facing
// GENRE_UNIVERSE_SECTION string (roughly alphabetical). The Haiku prompt's
// `${GENRES.join(', ')}` render will therefore emit alphabetical order —
// no functional difference (GENRE_SET is what validates), just a cosmetic
// re-order in the model's system prompt.
//
// See shared/genre-universe.js for the full list and the sync notes.
export { GENRES, GENRE_SET } from '../../shared/genre-universe.js';
