#!/usr/bin/env node
/*
  SonicBrand — Feedback Learning System installer
  -------------------------------------------------
  Patches index.html with:
    1. Feedback capture UI (👎 button + reason picker on every track card)
    2. Global Supabase feedback writer (track_feedback table)
    3. Learning loader (fetches learned_artist_banlist + learned_track_banlist before each gen)
    4. Hard filter injection into post-filter & Final Sweep
    5. Soft context injection into OpenAI brief (via callOpenAI wrapper)
    6. Compact drawer UI (bottom-right floating badge)

  Run AFTER niche-fix.js, recovery-fix.js, count-fix.js have been applied.
  Idempotent — safe to re-run.

  Prereq: run feedback-schema.sql in Supabase SQL Editor first.
*/
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'index.html');
const BACKUP_PATH = HTML_PATH + '.backup-feedback-' + Date.now();

if (!fs.existsSync(HTML_PATH)) {
  console.error('❌ index.html לא נמצא:', HTML_PATH);
  process.exit(1);
}

let src = fs.readFileSync(HTML_PATH, 'utf8');
const origLen = src.length;
fs.writeFileSync(BACKUP_PATH, src);
console.log('💾 גיבוי נשמר:', BACKUP_PATH);

let applied = 0;
let skipped = 0;

function patch(name, finder, replacer, marker) {
  if (marker && src.indexOf(marker) >= 0) {
    console.log('⏭️  [' + name + '] כבר הוחל — מדלג');
    skipped++;
    return;
  }
  const idx = typeof finder === 'string' ? src.indexOf(finder) : src.search(finder);
  if (idx < 0) {
    console.log('⚠️  [' + name + '] לא נמצא anchor — מדלג');
    skipped++;
    return;
  }
  src = replacer(src);
  if (marker && src.indexOf(marker) < 0) {
    console.log('⚠️  [' + name + '] נכשל — marker חסר אחרי patch');
    skipped++;
    return;
  }
  console.log('✅ [' + name + '] הוחל');
  applied++;
}

// ═══════════════════════════════════════════════════════════════════
// PATCH 1 — Core feedback functions (insert after FEEDBACK_LOG_KEY)
// ═══════════════════════════════════════════════════════════════════
const FB_CORE_MARKER = 'FB_CORE_V1_MARKER_ID';
const FB_CORE_CODE = `
// ═════════════════════════════════════════════════════════════════
// FEEDBACK LEARNING SYSTEM v1 — Global threshold-based
// ${FB_CORE_MARKER}
// ═════════════════════════════════════════════════════════════════

/* Session cache: banlists loaded once per page load, refreshed on gen start */
window.__learnedBanlist = {
  artists: new Set(),
  tracks: new Set(),
  artistMeta: {},
  reasonStats: [],
  loadedAt: 0
};

/* Fetch current global banlists from Supabase views */
async function loadLearnedBanlist(force) {
  try {
    var now = Date.now();
    if (!force && window.__learnedBanlist.loadedAt && (now - window.__learnedBanlist.loadedAt) < 60000) {
      return window.__learnedBanlist;
    }
    var artistRes = await sb.from('learned_artist_banlist').select('*');
    var trackRes  = await sb.from('learned_track_banlist').select('*');
    var reasonRes = await sb.from('learned_reason_stats').select('*');
    var bl = {artists: new Set(), tracks: new Set(), artistMeta: {}, reasonStats: [], loadedAt: now};
    if (artistRes && artistRes.data) {
      artistRes.data.forEach(function(r){
        if (r.artist_spotify_id) {
          bl.artists.add(r.artist_spotify_id);
          bl.artistMeta[r.artist_spotify_id] = {name: r.artist_name, votes: r.total_downvotes, reasons: r.reasons};
        }
      });
    }
    if (trackRes && trackRes.data) {
      trackRes.data.forEach(function(r){ if (r.track_spotify_id) bl.tracks.add(r.track_spotify_id); });
    }
    if (reasonRes && reasonRes.data) {
      bl.reasonStats = reasonRes.data;
    }
    window.__learnedBanlist = bl;
    if (typeof brainLog === 'function') {
      brainLog('🧠', 'למידה', bl.artists.size + ' אמנים + ' + bl.tracks.size + ' שירים בבנליסט גלובלי');
    }
    return bl;
  } catch (e) {
    console.warn('[feedback] loadLearnedBanlist failed:', e && e.message);
    return window.__learnedBanlist;
  }
}
window.loadLearnedBanlist = loadLearnedBanlist;

/* Write a feedback row to Supabase */
async function recordTrackFeedback(trackObj, feedbackType, reasonCode) {
  try {
    if (!trackObj || (!trackObj.id && !trackObj.spotifyId)) return;
    var analysisId = (window.currentPlaylist && window.currentPlaylist.analysisId) || null;
    var ctx = {
      biz:        (typeof wiz !== 'undefined' && wiz.bizCategory) || '',
      bizDNA:     (typeof wiz !== 'undefined' && wiz.bizDNA && wiz.bizDNA.label) || '',
      faders:     (typeof wiz !== 'undefined' && wiz.faders) || {},
      targetDist: trackObj._targetDistance || null
    };
    var row = {
      analysis_id:       analysisId,
      track_spotify_id:  trackObj.id || trackObj.spotifyId || '',
      track_name:        trackObj.title || trackObj.name || '',
      artist_spotify_id: trackObj.artistId || trackObj._artistId || '',
      artist_name:       trackObj.artist || '',
      feedback_type:     feedbackType,
      reason_code:       reasonCode || null,
      context:           ctx,
      user_name:         (typeof wiz !== 'undefined' && wiz.userName) || null
    };
    var res = await sb.from('track_feedback').insert([row]);
    if (res && res.error) {
      console.warn('[feedback] insert err:', res.error.message);
      if (typeof brainLog === 'function') brainLog('⚠️', 'פידבק', 'שגיאת שמירה: ' + res.error.message);
      return;
    }
    if (typeof brainLog === 'function') {
      var label = feedbackType === 'never_again' ? '❌ חסימה' : feedbackType === 'thumbs_up' ? '👍' : '👎';
      brainLog(label, 'פידבק נשמר', (trackObj.artist || '') + ' — ' + (trackObj.title || '') + (reasonCode ? ' (' + reasonCode + ')' : ''));
    }
    /* Optimistic local update so next filter pass sees it */
    if (feedbackType !== 'thumbs_up') {
      if (row.track_spotify_id) window.__learnedBanlist.tracks.add(row.track_spotify_id);
    }
    renderFeedbackBadge();
  } catch (e) {
    console.warn('[feedback] record failed:', e && e.message);
  }
}
window.recordTrackFeedback = recordTrackFeedback;

/* Reason codes (used for dropdown + stats) */
var FB_REASONS = [
  {code: 'too_mainstream',  label: 'ראשי מדי'},
  {code: 'wrong_era',       label: 'תקופה לא מתאימה'},
  {code: 'wrong_energy',    label: 'אנרגיה לא מתאימה'},
  {code: 'wrong_language',  label: 'שפה לא מתאימה'},
  {code: 'artist_ban',      label: 'האמן לא מתאים לעולם'}
];

/* Open reason picker near a track row. Resolves with {type, code} or null if cancelled. */
function openFeedbackPicker(anchorEl, trackObj) {
  return new Promise(function(resolve){
    var old = document.getElementById('fbPickerPopup');
    if (old) old.remove();
    var pop = document.createElement('div');
    pop.id = 'fbPickerPopup';
    pop.style.cssText = 'position:absolute;z-index:9999;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:200px;font-size:12px;direction:rtl';
    var html = '<div style="color:var(--muted);margin-bottom:8px;font-size:11px">למה השיר לא מתאים?</div>';
    FB_REASONS.forEach(function(r){
      html += '<button data-code="' + r.code + '" style="display:block;width:100%;text-align:right;background:var(--card-2);border:1px solid var(--border);color:var(--text);padding:6px 10px;margin-bottom:4px;border-radius:8px;cursor:pointer;font-size:12px">' + r.label + '</button>';
    });
    html += '<button data-code="__ban" style="display:block;width:100%;text-align:right;background:#7a1f1f;border:1px solid #a33;color:#fff;padding:6px 10px;margin-top:6px;border-radius:8px;cursor:pointer;font-size:12px">❌ אף פעם לא שוב (חסום אמן)</button>';
    html += '<button data-code="__cancel" style="display:block;width:100%;text-align:center;background:transparent;border:none;color:var(--muted);padding:4px;margin-top:4px;cursor:pointer;font-size:11px">ביטול</button>';
    pop.innerHTML = html;
    document.body.appendChild(pop);
    var rect = anchorEl.getBoundingClientRect();
    pop.style.top  = (window.scrollY + rect.bottom + 4) + 'px';
    pop.style.left = (window.scrollX + rect.left - 180) + 'px';
    function cleanup(){ pop.remove(); document.removeEventListener('click', outside, true); }
    function outside(e){ if (!pop.contains(e.target) && e.target !== anchorEl) { cleanup(); resolve(null); } }
    setTimeout(function(){ document.addEventListener('click', outside, true); }, 0);
    pop.querySelectorAll('button').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        var code = btn.getAttribute('data-code');
        cleanup();
        if (code === '__cancel') { resolve(null); return; }
        if (code === '__ban')    { resolve({type: 'never_again', code: 'artist_ban'}); return; }
        resolve({type: 'thumbs_down', code: code});
      });
    });
  });
}
window.openFeedbackPicker = openFeedbackPicker;

/* Click handler on track 👎 — opens picker, writes feedback */
async function onTrackThumbsDown(idx, btnEl) {
  if (!window.currentPlaylist || !window.currentPlaylist.tracks[idx]) return;
  var t = window.currentPlaylist.tracks[idx];
  var choice = await openFeedbackPicker(btnEl, t);
  if (!choice) return;
  t._feedbackType = choice.type;
  t._feedbackReason = choice.code;
  btnEl.style.background = choice.type === 'never_again' ? '#7a1f1f' : '#3a3a1f';
  btnEl.style.color = '#fff';
  btnEl.textContent = choice.type === 'never_again' ? '❌' : '👎';
  btnEl.disabled = true;
  await recordTrackFeedback(t, choice.type, choice.code);
}
window.onTrackThumbsDown = onTrackThumbsDown;

/* Thumbs up — quick positive signal, no reason needed */
async function onTrackThumbsUp(idx, btnEl) {
  if (!window.currentPlaylist || !window.currentPlaylist.tracks[idx]) return;
  var t = window.currentPlaylist.tracks[idx];
  btnEl.style.background = '#1f4a1f';
  btnEl.style.color = '#fff';
  btnEl.disabled = true;
  await recordTrackFeedback(t, 'thumbs_up', null);
}
window.onTrackThumbsUp = onTrackThumbsUp;

/* Badge + drawer (compact) ────────────────────────────────────── */
function ensureFeedbackDrawer() {
  if (document.getElementById('fbDrawerBadge')) return;
  var badge = document.createElement('button');
  badge.id = 'fbDrawerBadge';
  badge.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9998;background:var(--accent);color:#000;border:none;border-radius:24px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);direction:rtl';
  badge.textContent = '🧠 מראה מצטברת';
  badge.onclick = toggleFeedbackDrawer;
  document.body.appendChild(badge);

  var drawer = document.createElement('div');
  drawer.id = 'fbDrawer';
  drawer.style.cssText = 'position:fixed;bottom:0;left:0;width:340px;max-height:70vh;background:var(--card);border:1px solid var(--border);border-radius:12px 12px 0 0;box-shadow:0 -8px 24px rgba(0,0,0,0.4);z-index:9997;padding:16px;direction:rtl;display:none;overflow-y:auto;font-size:12px';
  drawer.style.cssText = 'position:fixed;bottom:0;left:0;width:380px;max-height:80vh;background:var(--card);border:1px solid var(--border);border-radius:12px 12px 0 0;box-shadow:0 -8px 24px rgba(0,0,0,0.4);z-index:9997;padding:16px;direction:rtl;display:none;overflow-y:auto;font-size:12px';
  drawer.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h3 style="margin:0;color:var(--accent);font-size:14px">🪞 מראה מצטברת — מה המערכת למדה</h3><button onclick="toggleFeedbackDrawer()" style="background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer">✕</button></div><div id="fbDrawerContent">טוען...</div>';
  document.body.appendChild(drawer);
}
window.ensureFeedbackDrawer = ensureFeedbackDrawer;

function renderFeedbackBadge() {
  var b = document.getElementById('fbDrawerBadge');
  if (!b) return;
  var bl = window.__learnedBanlist || {artists: new Set(), tracks: new Set()};
  b.textContent = '🧠 ' + bl.artists.size + ' אמנים · ' + bl.tracks.size + ' שירים';
}
window.renderFeedbackBadge = renderFeedbackBadge;

async function toggleFeedbackDrawer() {
  var d = document.getElementById('fbDrawer');
  if (!d) return;
  if (!(d.style.display === 'none' || !d.style.display)) { d.style.display = 'none'; return; }
  d.style.display = 'block';
  var c = document.getElementById('fbDrawerContent');
  c.innerHTML = 'טוען מראה מצטברת...';
  await loadLearnedBanlist(true);
  var bl = window.__learnedBanlist;
  try {
    /* Pull all feedback rows for aggregation (cap at 5000 for safety) */
    var allRes = await sb.from('track_feedback').select('artist_spotify_id,artist_name,track_spotify_id,track_name,feedback_type,reason_code,created_at').order('created_at', {ascending: false}).limit(5000);
    var rows = (allRes && allRes.data) || [];

    /* ── Compute aggregates ────────────────────────────────────── */
    var totalFB = rows.length;
    var firstAt = rows.length ? new Date(rows[rows.length-1].created_at) : null;
    var daysLearning = firstAt ? Math.max(1, Math.ceil((Date.now() - firstAt.getTime()) / 86400000)) : 0;
    var negRows = rows.filter(function(r){ return r.feedback_type === 'thumbs_down' || r.feedback_type === 'never_again'; });
    var posRows = rows.filter(function(r){ return r.feedback_type === 'thumbs_up'; });

    /* Group by artist for "on the brink" + ranked banned list */
    var artistMap = {};
    negRows.forEach(function(r){
      if (!r.artist_spotify_id) return;
      var k = r.artist_spotify_id;
      if (!artistMap[k]) artistMap[k] = {id: k, name: r.artist_name || '?', votes: 0, reasons: {}, lastAt: r.created_at};
      artistMap[k].votes++;
      if (r.reason_code) artistMap[k].reasons[r.reason_code] = (artistMap[k].reasons[r.reason_code] || 0) + 1;
    });
    var artistArr = Object.keys(artistMap).map(function(k){ return artistMap[k]; });
    var bannedArtists = artistArr.filter(function(a){ return a.votes >= 3; }).sort(function(a,b){ return b.votes - a.votes; });
    var brinkArtists = artistArr.filter(function(a){ return a.votes >= 1 && a.votes < 3; }).sort(function(a,b){ return b.votes - a.votes; });

    /* Reason distribution (negative only) */
    var reasonCounts = {};
    negRows.forEach(function(r){ if (r.reason_code) reasonCounts[r.reason_code] = (reasonCounts[r.reason_code] || 0) + 1; });
    var totalNeg = negRows.length || 1;
    var reasonRanked = Object.keys(reasonCounts).map(function(k){
      return {code: k, count: reasonCounts[k], pct: Math.round(100 * reasonCounts[k] / totalNeg)};
    }).sort(function(a,b){ return b.count - a.count; });

    /* ── Build HTML ────────────────────────────────────────────── */
    var html = '';

    /* Big stats row */
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:14px">';
    html += '  <div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center">' +
            '    <div style="font-size:22px;font-weight:700;color:var(--accent)">' + bl.artists.size + '</div>' +
            '    <div style="font-size:10px;color:var(--muted)">אמנים חסומים</div>' +
            '  </div>';
    html += '  <div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center">' +
            '    <div style="font-size:22px;font-weight:700;color:var(--accent)">' + bl.tracks.size + '</div>' +
            '    <div style="font-size:10px;color:var(--muted)">שירים חסומים</div>' +
            '  </div>';
    html += '  <div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center">' +
            '    <div style="font-size:22px;font-weight:700;color:var(--accent)">' + totalFB + '</div>' +
            '    <div style="font-size:10px;color:var(--muted)">פידבקים</div>' +
            '  </div>';
    html += '</div>';

    /* Sub-stats line */
    html += '<div style="text-align:center;color:var(--muted);font-size:10px;margin-bottom:14px">' +
            '🗓️ ' + daysLearning + ' ימי למידה · 👍 ' + posRows.length + ' חיוביים · 👎 ' + negRows.length + ' שליליים' +
            '</div>';

    /* Section: Top banned artists */
    html += '<div style="font-weight:600;margin-bottom:6px;color:var(--accent)">🚫 אמנים חסומים גלובלית</div>';
    if (!bannedArtists.length) {
      html += '<div style="color:var(--muted);font-size:11px;padding:8px;background:var(--card-2);border-radius:6px;margin-bottom:14px">אף אמן עדיין לא חצה את סף החסימה (≥3 דחיות מהקשרים שונים).</div>';
    } else {
      html += '<div style="margin-bottom:14px">';
      bannedArtists.slice(0, 12).forEach(function(a, i){
        var topReasons = Object.keys(a.reasons).sort(function(x,y){return a.reasons[y]-a.reasons[x]}).slice(0,2)
          .map(function(rc){ var rl = FB_REASONS.find(function(x){return x.code===rc}); return (rl?rl.label:rc); }).join(', ');
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-bottom:1px solid var(--border);font-size:11px">' +
                '  <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"><b>' + (i+1) + '.</b> ' + a.name + (topReasons ? ' <span style="color:var(--muted)">(' + topReasons + ')</span>' : '') + '</div>' +
                '  <div style="background:#7a1f1f;color:#fff;border-radius:10px;padding:1px 8px;font-size:10px;font-weight:600;margin-right:6px">' + a.votes + '</div>' +
                '</div>';
      });
      if (bannedArtists.length > 12) {
        html += '<div style="text-align:center;color:var(--muted);font-size:10px;margin-top:4px">+' + (bannedArtists.length - 12) + ' נוספים</div>';
      }
      html += '</div>';
    }

    /* Section: Reason distribution (visual bars) */
    html += '<div style="font-weight:600;margin-bottom:6px;color:var(--accent)">📊 התפלגות סיבות דחייה</div>';
    if (!reasonRanked.length) {
      html += '<div style="color:var(--muted);font-size:11px;padding:8px;background:var(--card-2);border-radius:6px;margin-bottom:14px">עדיין אין דחיות עם סיבה.</div>';
    } else {
      html += '<div style="margin-bottom:14px">';
      reasonRanked.forEach(function(r){
        var rl = FB_REASONS.find(function(x){return x.code===r.code});
        var label = rl ? rl.label : r.code;
        html += '<div style="margin-bottom:6px;font-size:11px">' +
                '  <div style="display:flex;justify-content:space-between;margin-bottom:2px">' +
                '    <span>' + label + '</span>' +
                '    <span style="color:var(--muted)">' + r.count + ' (' + r.pct + '%)</span>' +
                '  </div>' +
                '  <div style="height:6px;background:var(--card-2);border-radius:3px;overflow:hidden">' +
                '    <div style="height:100%;width:' + r.pct + '%;background:linear-gradient(90deg,var(--accent),#a33)"></div>' +
                '  </div>' +
                '</div>';
      });
      html += '</div>';
    }

    /* Section: On the brink (artists 1-2 votes) */
    if (brinkArtists.length) {
      html += '<div style="font-weight:600;margin-bottom:6px;color:var(--accent)">⚠️ על סף חסימה</div>';
      html += '<div style="margin-bottom:14px;font-size:11px;color:var(--muted)">דחייה אחת או שתיים נוספות יחסמו את האמנים האלה גלובלית:</div>';
      html += '<div style="margin-bottom:14px">';
      brinkArtists.slice(0, 8).forEach(function(a){
        var dots = '●'.repeat(a.votes) + '○'.repeat(3 - a.votes);
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:11px">' +
                '  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + a.name + '</span>' +
                '  <span style="color:#c69;letter-spacing:2px;font-size:10px;margin-right:6px" title="' + a.votes + '/3 לחסימה">' + dots + '</span>' +
                '</div>';
      });
      html += '</div>';
    }

    /* Section: Active impact on next analysis */
    html += '<div style="margin-top:14px;padding:10px;background:linear-gradient(135deg,rgba(29,185,84,0.08),rgba(29,185,84,0.02));border-radius:8px;border-right:3px solid var(--accent)">' +
            '  <div style="font-weight:600;margin-bottom:4px;font-size:12px">🎯 השפעה על הניתוח הבא</div>' +
            '  <div style="font-size:11px;color:var(--muted);line-height:1.5">' +
            '    הפילטר הקשיח יסנן <b>' + bl.artists.size + '</b> אמנים ו-<b>' + bl.tracks.size + '</b> שירים.' +
            (reasonRanked.length ? '<br>הקשר ל-LLM יזהיר במיוחד נגד: <b>' + reasonRanked.slice(0,3).map(function(r){var rl=FB_REASONS.find(function(x){return x.code===r.code});return rl?rl.label:r.code}).join(' · ') + '</b>.' : '') +
            '  </div>' +
            '</div>';

    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<div style="color:#c66">שגיאה בטעינת המראה: ' + (e && e.message || e) + '</div>';
  }
}
window.toggleFeedbackDrawer = toggleFeedbackDrawer;

/* Inject drawer + badge on DOMContentLoaded */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ ensureFeedbackDrawer(); loadLearnedBanlist(true).then(renderFeedbackBadge); });
} else {
  ensureFeedbackDrawer(); loadLearnedBanlist(true).then(renderFeedbackBadge);
}
`;

patch(
  'fb-core',
  "const FEEDBACK_LOG_KEY='sb_feedback_log_v1';",
  function(s){ return s.replace("const FEEDBACK_LOG_KEY='sb_feedback_log_v1';", "const FEEDBACK_LOG_KEY='sb_feedback_log_v1';" + FB_CORE_CODE); },
  FB_CORE_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// PATCH 2 — Feedback buttons injected into renderTrack output
// Replace the existing rating dropdown block to add 👎/👍 before it.
// ═══════════════════════════════════════════════════════════════════
const FB_BUTTONS_MARKER = 'FB_BTN_V1_MK';
const OLD_RATING_ANCHOR = '<div class="track-rating"';

patch(
  'fb-buttons',
  OLD_RATING_ANCHOR,
  function(s){
    /* The anchor lives inside a JS single-quoted string that builds HTML.
       We prepend HTML that references numeric idx via '+(num-1)+' interpolation. */
    if (s.indexOf(FB_BUTTONS_MARKER) >= 0) return s;
    var inject =
      '<button data-fb="' + FB_BUTTONS_MARKER + '" onclick="onTrackThumbsUp(\'+(num-1)+\',this)" title="שיר מעולה" style="background:var(--card-2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:2px 6px;font-size:11px;cursor:pointer;margin-left:2px">👍</button>' +
      '<button onclick="onTrackThumbsDown(\'+(num-1)+\',this)" title="לא מתאים" style="background:var(--card-2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:2px 6px;font-size:11px;cursor:pointer;margin-left:2px">👎</button>';
    return s.replace(OLD_RATING_ANCHOR, inject + OLD_RATING_ANCHOR);
  },
  FB_BUTTONS_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// PATCH 3 — Hard filter: drop learned-banned artists/tracks in post-filter
// Inject into the niche-fix systemic post-filter block
// ═══════════════════════════════════════════════════════════════════
const FB_FILTER_MARKER = '/*FB_FILTER_V1*/';
const FILTER_ANCHOR = 'FAUX_NICHE_ARTISTS.has(';

patch(
  'fb-filter-postfilter',
  FILTER_ANCHOR,
  function(s){
    if (s.indexOf(FB_FILTER_MARKER) >= 0) return s;
    /* Prepend a learned-banlist check before each FAUX_NICHE_ARTISTS check.
       Replace the first occurrence only (post-filter); Final Sweep has its own patch. */
    var idx = s.indexOf(FILTER_ANCHOR);
    if (idx < 0) return s;
    /* Find start of the if-statement boundary before idx */
    var pre = s.substring(0, idx);
    var post = s.substring(idx);
    /* Insert a wrapper: `(window.__learnedBanlist&&(window.__learnedBanlist.artists.has(aid)||window.__learnedBanlist.tracks.has(tid)))||` */
    var injected = FB_FILTER_MARKER + "(window.__learnedBanlist&&window.__learnedBanlist.artists&&(window.__learnedBanlist.artists.has(t._artistId||t.artistId||'')||window.__learnedBanlist.tracks.has(t.id||'')))||";
    return pre + injected + post;
  },
  FB_FILTER_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// PATCH 4 — Refresh banlist at start of generation + inject soft context into OpenAI calls
// Hook callOpenAI to append learned reason stats to system prompt on the main brief.
// ═══════════════════════════════════════════════════════════════════
const FB_LLM_MARKER = '/*FB_LLM_V1*/';
const CALLOPENAI_ANCHOR = 'async function callOpenAI(';

patch(
  'fb-llm-wrapper',
  CALLOPENAI_ANCHOR,
  function(s){
    if (s.indexOf(FB_LLM_MARKER) >= 0) return s;
    var wrap =
      FB_LLM_MARKER +
      "async function __fbEnrichMessages(messages){" +
        "try{" +
          "if(!messages||!messages.length)return messages;" +
          "var sys=messages[0];" +
          "if(!sys||sys.role!=='system'||typeof sys.content!=='string')return messages;" +
          "if(sys.content.length<400)return messages;" +
          "var bl=window.__learnedBanlist||{};" +
          "var learned='';" +
          "if(bl.artists&&bl.artists.size){learned+='\\nLEARNED FROM PAST FEEDBACK: '+bl.artists.size+' artists globally banned. '}" +
          "if(bl.reasonStats&&bl.reasonStats.length){" +
            "var topR=bl.reasonStats.slice(0,3).map(function(r){return r.reason_code+'('+r.total+')'}).join(', ');" +
            "learned+='\\nTop reasons users reject tracks: '+topR+'. Be extra careful to avoid these issues.';" +
          "}" +
          "if(learned){messages[0]=Object.assign({},sys,{content:sys.content+'\\n\\n---\\nLEARNING CONTEXT:'+learned});}" +
          "return messages;" +
        "}catch(e){return messages}" +
      "}" +
      "var __origCallOpenAI_fb=null;";
    /* Inject wrapper helper BEFORE the function definition,
       then rename original by inserting a wrapper that calls __fbEnrichMessages. */
    var idx = s.indexOf(CALLOPENAI_ANCHOR);
    if (idx < 0) return s;
    /* Strategy: rename `async function callOpenAI(` → `async function __fbOrig_callOpenAI(`
       and add a wrapper under the name `callOpenAI` that enriches then delegates. */
    var renamed = s.replace('async function callOpenAI(', wrap + '\nasync function callOpenAI(messages,opts){try{messages=await __fbEnrichMessages(messages)}catch(e){};return __fbOrig_callOpenAI(messages,opts);}\nasync function __fbOrig_callOpenAI(');
    return renamed;
  },
  FB_LLM_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// PATCH 5 — Refresh banlist cache at start of generation
// Hook into the moment the playlist generation kicks off.
// We piggyback on the FAUX_NICHE_ARTISTS constant declaration: add a call right after.
// ═══════════════════════════════════════════════════════════════════
const FB_REFRESH_MARKER = '/*FB_REFRESH_V1*/';
const REFRESH_ANCHOR = 'const FAUX_NICHE_ARTISTS = new Set([';

patch(
  'fb-refresh-hook',
  REFRESH_ANCHOR,
  function(s){
    if (s.indexOf(FB_REFRESH_MARKER) >= 0) return s;
    /* Find the closing `]);` that ends the Set definition */
    var i = s.indexOf(REFRESH_ANCHOR);
    if (i < 0) return s;
    var closeIdx = s.indexOf(']);', i);
    if (closeIdx < 0) return s;
    /* Insert a call after the closing to refresh banlist on load */
    var insertPt = closeIdx + 3;
    var hook = '\n' + FB_REFRESH_MARKER + ' if(typeof loadLearnedBanlist==="function"){setTimeout(function(){loadLearnedBanlist(true).then(function(){if(typeof renderFeedbackBadge==="function")renderFeedbackBadge()})},1000);}\n';
    return s.substring(0, insertPt) + hook + s.substring(insertPt);
  },
  FB_REFRESH_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// Write result
// ═══════════════════════════════════════════════════════════════════
fs.writeFileSync(HTML_PATH, src);
const newLen = src.length;
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('✅ ' + applied + ' פאצ\'ים הוחלו | ' + skipped + ' דולגו');
console.log('📏 גודל קובץ: ' + origLen + ' → ' + newLen + ' בתים (Δ ' + (newLen - origLen) + ')');
console.log('💾 גיבוי: ' + BACKUP_PATH);
console.log('\nהשלבים הבאים:\n');
console.log('  1) הרץ את ה-SQL ב-Supabase SQL Editor:');
console.log('     scripts/feedback-schema.sql');
console.log('');
console.log('  2) git commit:');
console.log('     git add index.html');
console.log('     git commit -m "feat(feedback): global threshold-based learning — feedback buttons, banlist views, LLM context injection"');
console.log('     git push');
console.log('');
console.log('  # אם משהו נשבר:');
console.log('  cp "' + BACKUP_PATH + '" index.html');
