// v4/precompute/check-bdika-cleanup.mjs
//
// Diagnostic to inspect a specific biz type across all v4 Supabase tables.
// Useful for verifying that a scan actually persisted (or fully cleaned up)
// the changes shown in the dashboard UI.
//
// Default: checks "בדיקה של רוני" (Roni's test biz type).
// Override with the first CLI arg:
//   node v4/precompute/check-bdika-cleanup.mjs "פיצריה"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

(function loadDotEnv() {
    const p = path.join(REPO_ROOT, '.env.local');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
})();

const { pgrSelect, pgrCount } = await import('../../api/v4/supabase-client.js');

const NEEDLE = process.argv[2] || 'בדיקה של רוני';

async function main() {
    console.log(`Inspecting Supabase state for biz type: "${NEEDLE}"\n`);

    // 1. biztype_genres — filter in-memory to avoid PostgREST URL-encoding
    //    quirks with non-ASCII (Hebrew) values in `?business_type=eq.<value>`.
    const allBizGenreRows = await pgrSelect('biztype_genres', {},
        { select: 'business_type,genre,column_letter,position_in_column' });
    const bizRows = allBizGenreRows.filter((r) => r.business_type === NEEDLE);
    console.log(`biztype_genres rows for "${NEEDLE}": ${bizRows.length}`);
    for (const r of bizRows) console.log(`  ${JSON.stringify(r)}`);

    // 2. scan_jobs — is there a row that mentions this biz type?
    const jobRows = await pgrSelect('scan_jobs',
        {},
        { select: 'playlist_id,playlist_title,genre,business_types,status,updated_at' },
    );
    const jobsForBiz = jobRows.filter((j) => (j.business_types || []).includes(NEEDLE));
    console.log(`\nscan_jobs rows whose business_types include "${NEEDLE}": ${jobsForBiz.length}`);
    for (const r of jobsForBiz) console.log(`  ${JSON.stringify(r)}`);

    // 3. Recent scan_logs mentioning this biz type or Roni test
    const logRows = await pgrSelect('scan_logs',
        {},
        { select: 'id,level,kind,message,created_at', order: 'id.desc', limit: 200 },
    );
    const matchingLogs = logRows.filter((l) => l.message && l.message.includes(NEEDLE));
    console.log(`\nscan_logs (last 200) mentioning "${NEEDLE}": ${matchingLogs.length}`);
    for (const r of matchingLogs.slice(0, 20)) console.log(`  [${r.id}] ${r.message}`);

    // 4. Aggregate table counts so the user can eyeball whether prod data
    //    looks sane after the test cycle.
    const [
        biztypeCount,
        playlistGenresCount,
        playlistTracksCount,
        trackAnalysesCount,
        scanJobsCount,
    ] = await Promise.all([
        pgrCount('biztype_genres'),
        pgrCount('playlist_genres'),
        pgrCount('playlist_tracks'),
        pgrCount('track_analyses'),
        pgrCount('scan_jobs'),
    ]);
    console.log(`\nOverall table counts:`);
    console.log(`  biztype_genres:  ${biztypeCount}`);
    console.log(`  playlist_genres: ${playlistGenresCount}`);
    console.log(`  playlist_tracks: ${playlistTracksCount}`);
    console.log(`  track_analyses:  ${trackAnalysesCount}`);
    console.log(`  scan_jobs:       ${scanJobsCount}`);

    // 5. Distinct biz types currently in biztype_genres.
    const allBizTypes = new Set(allBizGenreRows.map((r) => r.business_type));
    console.log(`\nDistinct biz types in biztype_genres (${allBizTypes.size}):`);
    for (const b of [...allBizTypes].sort()) console.log(`  ${b}`);
    const isPresent = allBizTypes.has(NEEDLE);
    console.log(`\n"${NEEDLE}" present in biztype_genres? → ${isPresent ? 'YES' : 'NO'}`);
    console.log(`(interpret: after ADD scan you want YES; after REMOVE scan you want NO)`);
}

main().catch((err) => {
    console.error('CHECK FAILED:', err);
    process.exit(1);
});
