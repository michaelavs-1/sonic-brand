// Why 0 cleanups on 23 and 24? Two possibilities: (a) their playlists' expires_at
// was later than the day, so cleanup rolled forward (b) expire cron wasn't running
// or was failing. Check by looking at what expires_at values existed for
// playlists built on those days.
import fs from 'node:fs';
const env = fs.readFileSync('.env.local', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) process.env[m[1]] = m[2];
}
const URL = process.env.SUPABASE_URL, SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function q(p) {
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: { apikey: SRV, authorization: `Bearer ${SRV}` } });
  return r.json();
}

// Playlists that expired ON the 23rd or 24th (regardless of when they were built).
// If expire cron was working, deleted_at would be near expires_at.
for (const day of ['2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25']) {
  const nextDay = new Date(day + 'T00:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const dayEnd = nextDay.toISOString().slice(0, 10);
  const rows = await q(`created_playlists?expires_at=gte.${day}T00:00:00&expires_at=lt.${dayEnd}T00:00:00&select=expires_at,deleted_at,spotify_id&order=expires_at.asc`);
  const cleaned = rows.filter((r) => r.deleted_at);
  const uncleaned = rows.filter((r) => !r.deleted_at);
  const laterCleanup = cleaned.filter((r) => r.deleted_at.slice(0,10) !== r.expires_at.slice(0,10));
  console.log(`\n== playlists that EXPIRED on ${day} UTC (n=${rows.length}) ==`);
  console.log(`  cleaned same day (or within):     ${cleaned.length - laterCleanup.length}`);
  console.log(`  cleaned on a later day:           ${laterCleanup.length}`);
  console.log(`  never cleaned (deleted_at null):  ${uncleaned.length}`);
  if (laterCleanup.length) {
    // Show delay distribution
    const delays = {};
    for (const r of laterCleanup) {
      const delayDays = Math.floor((Date.parse(r.deleted_at) - Date.parse(r.expires_at)) / 86400000);
      delays[delayDays] = (delays[delayDays] || 0) + 1;
    }
    console.log('  delay distribution (days late):');
    for (const [d, n] of Object.entries(delays).sort((a,b) => Number(a[0]) - Number(b[0]))) console.log(`    +${d}d × ${n}`);
  }
}
