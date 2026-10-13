/* /api/internal/daily-picks — which direction each daily playlist plays, day
   by day (item 11 of Michael's list, 2026-10-13).

   Normally the builders choose: Option 1 draws each tier's two directions at
   random (the second the least like the first); Option 2 rotates each level's
   directions by date. A PICK overrides that for one slot on one business day
   (v7/generation/daily-picks.js, table business_v7_daily_picks).

   GET ?id=<business_uuid>[&from=YYYY-MM-DD][&days=N]
     Default: 7 days back → 14 days ahead (max 60 days).
     → { business_id, mode, today, phase, slots, library, days: [{
           il_date, is_today, is_past, open,
           built:   [daily playlists of that day — name, slot, played, opens, live, replaced],
           picks:   [pick rows of that day],
           planned: Option 1 { 'high-1': { source:'pick'|'random', ... }, ... }
                    Option 2 { 'mix-1': [{ level, source:'pick'|'rotation', key, title_en, genres }], 'mix-2': [...] }
                    (for today until it's built, and future days; Option 2's
                    rotation is exact as long as the library doesn't change)
         }] }

   POST { business_id, action, ... }
     set           { date, slot, direction }   Option 1: slot 'high-1'|'high-2'|'low-1'|'low-2',
                                               direction a key of that tier ("H3" / "C2")
                   { date, mix, direction }    Option 2: mix 1|2, direction a level key ("L3-2");
                                               slot = mix-<mix>:L<its level>
                   The direction's genres are copied into the pick.
     clear         { date, slot? }             one slot, or the whole day
     rebuild_today {}                          rebuilds TODAY's playlists now with today's picks
                                               (replaces a live set; builds one if there is none).
                                               Not counted toward the owner's 2 replacements a
                                               day. Takes ~30–90s (Spotify). The owner sees the
                                               new playlists on their next dashboard load.
   Picks may be set for today (business day, Israel) up to 60 days ahead. A
   pick for today changes nothing until today's set is (re)built — the
   response says so.

   Auth: bearer INTERNAL_ADMIN_API_KEY (./_guard.js). */

import { pgrSelect, pgrUpsert, pgrDelete } from '../v5/supabase-client.js';
import { requireAdmin, setAdminCors } from './_guard.js';
import {
  UUID_RE, ISO_DATE_RE, hasServiceKey, loadBusiness, logAdminAction, addDays, selfOrigin, selectOrEmpty,
} from './_admin.js';
import { readLibrary } from './_library.js';
import { dailyByDay } from './_daily-view.js';
import { runDailyBuild } from '../v7/account/_run-daily-build.js';
import { liveDailyRows, businessDaySinceIso } from '../v7/account/_replace-status.js';
import { levelLibrary } from '../v7/account/_option2-builder.js';
import { businessWindowAt, normLevels } from '../../v7/generation/energy-timeline.js';
import { pickLevelDirections, dayNumber } from '../../v7/generation/timeline-assembler.js';
import {
  OPTION1_SLOTS, OPTION1_SLOT_NAMES, OPTION2_MIXES, option2Slot, parseSlot, applyOption2Picks,
} from '../../v7/generation/daily-picks.js';

const MAX_DAYS = 60;
const MIGRATION_HINT = 'run migration v5/precompute/migrations/2026-10-13-admin-console.sql';

// Is the venue open on that date (Israel weekday)? null = no hours.
function openOn(hours, isoDate) {
  if (!hours) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dayIdx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sunday, same as the hours map
  const h = hours[dayIdx] || hours[String(dayIdx)];
  return !!h && !h.closed && !!h.open && !!h.close;
}

// Option 2's plan for a day: the rotation + that day's picks.
function option2Plan(lib, isoDate, dayPicks, genresByLevel, keyById) {
  if (!lib) return null;
  const rotated = pickLevelDirections(lib, isoDate, OPTION2_MIXES);
  const withPicks = applyOption2Picks(rotated, dayPicks, genresByLevel, lib);
  const out = {};
  withPicks.forEach((m, k) => {
    out[`mix-${k + 1}`] = [...m].sort((a, b) => a[0] - b[0]).map(([level, d]) => ({
      level,
      source: d.admin_pick ? 'pick' : 'rotation',
      key: (d.id && keyById.get(d.id)) || null,
      title_en: d.title_en, genres: d.genres,
    }));
  });
  return out;
}

async function getView(biz, query) {
  const lib = await readLibrary(biz.id);
  const hoursRows = await selectOrEmpty('business_hours', { business_id: `eq.${biz.id}` }, { select: 'hours', limit: 1 });
  const hours = hoursRows[0]?.hours || null;
  const w = businessWindowAt(hours || {}, new Date());
  const today = w.isoDate;
  const from = ISO_DATE_RE.test(String(query.from || '')) ? query.from : addDays(today, -7);
  const days = Math.min(MAX_DAYS, Math.max(1, Number(query.days) || 22));
  const to = addDays(from, days - 1);

  const [rows, picks, opens] = await Promise.all([
    selectOrEmpty('business_playlists',
      { business_id: `eq.${biz.id}`, event_id: 'is.null', created_at: `gte.${new Date(Date.parse(`${from}T00:00:00Z`) - 36 * 3600e3).toISOString()}` },
      { select: 'spotify_id,url,label,track_count,genres,expansion,event_id,created_at,expires_at', order: 'created_at.asc' }),
    selectOrEmpty('business_v7_daily_picks',
      { business_id: `eq.${biz.id}`, il_date: `gte.${from}`, and: `(il_date.lte.${to})` },
      { select: '*', order: 'il_date.asc,slot.asc' }),
    selectOrEmpty('business_playlist_opens',
      { business_id: `eq.${biz.id}`, opened_at: `gte.${new Date(Date.parse(`${from}T00:00:00Z`) - 36 * 3600e3).toISOString()}` },
      { select: 'spotify_id,opened_at', order: 'opened_at.desc', limit: 5000 }),
  ]);
  const builtByDay = new Map(dailyByDay(rows, opens).map((d) => [d.il_date, d.playlists]));

  // Option 2: the library the builder would use, keyed back to the view's keys.
  const N = lib.N || 2;
  const genresByLevel = new Map();
  for (const lv of lib.approved_by_level) genresByLevel.set(lv.level, lv.genres.map((g) => g.genre));
  const levelRows = lib.option2.map((d) => ({ id: d.id, energy_level: d.energy_level, rank: d.rank, title_en: d.title_en, genres: d.genres, energy_range: d.custom_range ? d.energy_range : null }));
  const o2lib = lib.mode === 'option2' ? levelLibrary(levelRows, genresByLevel) : null;
  const keyById = new Map(lib.option2.map((d) => [d.id, d.key]));

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const dayPicks = picks.filter((p) => p.il_date === d);
    const built = builtByDay.get(d) || [];
    const isPast = d < today;
    const liveBuilt = built.filter((p) => !p.replaced);
    let planned = null;
    if (!isPast && !(d === today && liveBuilt.length)) {
      if (lib.mode === 'option1') {
        planned = Object.fromEntries(OPTION1_SLOTS.map((slot) => {
          const p = dayPicks.find((x) => x.mode === 'option1' && x.slot === slot);
          return [slot, p
            ? { name: OPTION1_SLOT_NAMES[slot], source: 'pick', title_en: p.title_en, genres: p.genres }
            : { name: OPTION1_SLOT_NAMES[slot], source: 'random', note: 'drawn at build time' }];
        }));
      } else if (lib.mode === 'option2') {
        planned = option2Plan(o2lib, d, dayPicks.filter((p) => p.mode === 'option2'), genresByLevel, keyById)
          || { note: 'no level library: each level plays all its genres together' };
      }
    }
    out.push({
      il_date: d, is_today: d === today, is_past: isPast, open: openOn(hours, d),
      built, picks: dayPicks, planned,
    });
  }

  const slots = lib.mode === 'option1'
    ? OPTION1_SLOTS.map((slot) => ({ slot, name: OPTION1_SLOT_NAMES[slot], tier: slot.split('-')[0] }))
    : lib.mode === 'option2'
      ? [1, 2].flatMap((mix) => Array.from({ length: N }, (_, j) => ({ slot: option2Slot(mix, j + 1), name: `Daily Mix #${mix} · level ${j + 1}`, mix, level: j + 1 })))
      : [];
  return {
    business_id: biz.id,
    mode: lib.mode,
    today,
    phase: w.phase,
    day_number_today: dayNumber(today),
    slots,
    library: lib.mode === 'option2' ? lib.option2 : lib.mode === 'option1' ? lib.option1 : [],
    days: out,
  };
}

export default async function handler(req, res) {
  setAdminCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!hasServiceKey()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const id = String(req.method === 'GET' ? req.query?.id || '' : body.business_id || '').trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ error: '`id` (GET) / `business_id` (POST) must be a business uuid' });
    const biz = await loadBusiness(id);
    if (!biz) return res.status(404).json({ error: 'business not found' });

    if (req.method === 'GET') return res.status(200).json(await getView(biz, req.query || {}));

    // ---- rebuild today ----
    if (body.action === 'rebuild_today') {
      const hoursRows = await selectOrEmpty('business_hours', { business_id: `eq.${id}` }, { select: 'hours', limit: 1 });
      const w = businessWindowAt(hoursRows[0]?.hours || {}, new Date());
      // Only while today's set is still in use — a rebuild after closing (or
      // on a closed day) would make the owner a closed-day set they didn't ask for.
      if (w.phase !== 'before-open' && w.phase !== 'open') {
        return res.status(409).json({
          error: w.phase === 'closed' ? 'the venue is closed today — nothing to rebuild' : 'the venue has closed for today — picks apply from the next build',
          code: w.phase === 'closed' ? 'closed-today' : 'past-close',
        });
      }
      const live = await liveDailyRows(id, businessDaySinceIso(w));
      const events = [];
      const result = await runDailyBuild({
        businessId: id, ownerId: biz.owner_id, bizName: biz.name || '',
        replaceToday: live.length > 0, origin: selfOrigin(req), admin: true,
      }, { send: (e) => events.push(e) });
      await logAdminAction(id, 'daily:rebuild_today', { replaced: live.length, result: result.done || result.body });
      if (result.status) return res.status(result.status).json(result.body);
      return res.status(200).json({
        ok: true, replaced: live.length > 0, ...result.done,
        playlists: events.filter((e) => e.type === 'built').map((e) => ({ spotify_id: e.row.spotify_id, label: e.row.label, url: e.row.url, track_count: e.row.track_count })),
        failures: events.filter((e) => e.type === 'failed').map((e) => e.error),
      });
    }

    if (body.action !== 'set' && body.action !== 'clear') {
      return res.status(400).json({ error: 'action must be set, clear or rebuild_today' });
    }

    const lib = await readLibrary(id);
    if (!lib.mode) return res.status(409).json({ error: 'the owner hasn\'t picked a playlist type yet', code: 'not-ready' });
    const hoursRows = await selectOrEmpty('business_hours', { business_id: `eq.${id}` }, { select: 'hours', limit: 1 });
    const hours = hoursRows[0]?.hours || null;
    const w = businessWindowAt(hours || {}, new Date());
    const date = String(body.date || '').trim();
    if (!ISO_DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD (the business day, Israel)' });
    if (date < w.isoDate) return res.status(400).json({ error: `${date} has passed (today is ${w.isoDate})` });
    if (date > addDays(w.isoDate, MAX_DAYS)) return res.status(400).json({ error: `at most ${MAX_DAYS} days ahead` });

    // ---- clear ----
    if (body.action === 'clear') {
      const filters = { business_id: `eq.${id}`, il_date: `eq.${date}` };
      if (body.slot) {
        const s = parseSlot(body.slot);
        if (!s) return res.status(400).json({ error: `unknown slot "${body.slot}"` });
        filters.slot = `eq.${s.slot}`;
      }
      try { await pgrDelete('business_v7_daily_picks', filters); }
      catch (e) { return res.status(501).json({ error: `${MIGRATION_HINT} (${e.message.slice(0, 120)})` }); }
      await logAdminAction(id, 'daily_pick:clear', { date, slot: body.slot || null });
      return res.status(200).json({ ok: true, ...(await getView(biz, { from: date, days: 1 })) });
    }

    // ---- set ----
    const key = String(body.direction || '').trim().toUpperCase();
    let slot;
    let dir;
    if (lib.mode === 'option1') {
      const s = parseSlot(body.slot);
      if (!s || s.mode !== 'option1') return res.status(400).json({ error: `slot must be one of ${OPTION1_SLOTS.join(', ')} (this business is on Option 1)` });
      dir = lib.option1.find((d) => d.key === key);
      if (!dir) return res.status(400).json({ error: `no direction "${body.direction}" — keys: ${lib.option1.map((d) => d.key).join(', ')}` });
      if (dir.energy_tier !== s.tier) return res.status(400).json({ error: `${dir.key} is a ${dir.energy_tier}-energy direction; ${s.slot} needs a ${s.tier} one` });
      slot = s.slot;
    } else {
      const mix = Number(body.mix ?? parseSlot(body.slot)?.mix);
      if (mix !== 1 && mix !== 2) return res.status(400).json({ error: 'mix must be 1 or 2 (this business is on Option 2)' });
      dir = lib.option2.find((d) => d.key === key);
      if (!dir) return res.status(400).json({ error: `no direction "${body.direction}" — keys: ${lib.option2.map((d) => d.key).join(', ')}` });
      slot = option2Slot(mix, dir.energy_level);
    }
    try {
      await pgrUpsert('business_v7_daily_picks', {
        business_id: id, il_date: date, mode: lib.mode, slot,
        title_en: dir.title_en || null, genres: dir.genres,
        energy_range: lib.mode === 'option2' && dir.custom_range ? dir.energy_range : null,
        source_direction_id: dir.id || null, created_at: new Date().toISOString(),
      }, { onConflict: 'business_id,il_date,slot' });
    } catch (e) {
      return res.status(501).json({ error: `${MIGRATION_HINT} (${e.message.slice(0, 120)})` });
    }
    await logAdminAction(id, 'daily_pick:set', { date, slot, direction: dir.key, title_en: dir.title_en, genres: dir.genres });

    const warnings = [];
    if (date === w.isoDate) {
      const live = await liveDailyRows(id, businessDaySinceIso(w));
      if (live.length) warnings.push('today\'s playlists are already built — call action "rebuild_today" to apply the pick now');
    }
    if (openOn(hours, date) === false) warnings.push(`the venue is closed on ${date}: nothing is built that day unless the owner asks for playlists`);
    return res.status(200).json({ ok: true, slot, warnings, ...(await getView(biz, { from: date, days: 1 })) });
  } catch (err) {
    console.error('[internal daily-picks] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
