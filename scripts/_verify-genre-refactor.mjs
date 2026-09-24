// Sanity check for the 2026-09-23 shared/genre-universe.js extraction.
// Compares the current in-tree GENRE_UNIVERSE_SECTION against git HEAD's
// version (which had the string inlined) to catch any accidental drift.
//
// Only checks the genre-universe string itself. The composed EDITABLE +
// FIXED prompts are guaranteed byte-identical if GENRE_UNIVERSE_SECTION
// is byte-identical AND no other sub-constant changed — the composition
// is a simple .join('\n\n').
import { execSync } from 'child_process';
import { GENRE_UNIVERSE_SECTION as fromShared, GENRES } from '../shared/genre-universe.js';

// Extract the inlined string literal from git HEAD's v6 file.
const raw = execSync('git show HEAD:v6/generation/musical-directions.js', { encoding: 'utf8' });
const m = raw.match(/export const GENRE_UNIVERSE_SECTION = `([\s\S]+?)`;/);
if (!m) { console.error('could not find pre-refactor GENRE_UNIVERSE_SECTION in git HEAD'); process.exit(1); }
const fromHead = m[1];

const rawV5 = execSync('git show HEAD:v5/generation/musical-directions.js', { encoding: 'utf8' });
const m5 = rawV5.match(/export const GENRE_UNIVERSE_SECTION = `([\s\S]+?)`;/);
if (!m5) { console.error('could not find pre-refactor GENRE_UNIVERSE_SECTION in v5 HEAD'); process.exit(1); }
const fromHeadV5 = m5[1];

const okV6 = fromShared === fromHead;
const okV5V6 = fromHead === fromHeadV5;

console.log('shared === v6@HEAD (byte-identical):', okV6);
console.log('v5@HEAD === v6@HEAD (mirror check):', okV5V6);
console.log('GENRES count:', GENRES.length);

process.exit(okV6 && okV5V6 ? 0 : 1);
