#!/usr/bin/env node
/*
  SonicBrand — Feedback Mirror upgrade
  -------------------------------------
  Upgrades the existing feedback drawer (from feedback-system.js) into a
  cumulative reflection mirror. Shows:
    • 3 big-number stats (artists banned, tracks banned, total feedbacks)
    • Ranked list of globally banned artists (with reasons + vote counts)
    • Reason distribution bars (% per rejection reason)
    • "On the brink" — artists with 1-2 votes (close to threshold)
    • Active impact summary for the next analysis

  Run AFTER feedback-system.js has been applied. Idempotent.
*/
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'index.html');
const BACKUP_PATH = HTML_PATH + '.backup-mirror-' + Date.now();

if (!fs.existsSync(HTML_PATH)) {
  console.error('❌ index.html לא נמצא:', HTML_PATH);
  process.exit(1);
}

let src = fs.readFileSync(HTML_PATH, 'utf8');
const origLen = src.length;

if (src.indexOf('FB_CORE_V1_MARKER_ID') < 0) {
  console.error('❌ feedback-system.js עדיין לא הוחל. הרץ אותו קודם.');
  process.exit(1);
}

fs.writeFileSync(BACKUP_PATH, src);
console.log('💾 גיבוי נשמר:', BACKUP_PATH);

const MIRROR_MARKER = 'FB_MIRROR_V1_MARKER_ID';

if (src.indexOf(MIRROR_MARKER) >= 0) {
  console.log('⏭️  המראה כבר הוחלה — מדלג');
  console.log('📏 גודל קובץ ללא שינוי:', origLen, 'בתים');
  process.exit(0);
}

let applied = 0;
let skipped = 0;

function patch(name, fn) {
  try {
    const before = src;
    src = fn(src);
    if (src === before) { console.log('⏭️  [' + name + '] anchor לא נמצא — מדלג'); skipped++; return; }
    console.log('✅ [' + name + '] הוחל');
    applied++;
  } catch (e) {
    console.log('⚠️  [' + name + '] שגיאה:', e.message);
    skipped++;
  }
}

// ═══════════════════════════════════════════════════════════════════
// PATCH A — Badge text: "יומן פידבק" → "מראה מצטברת"
// ═══════════════════════════════════════════════════════════════════
patch('mirror-badge-text', function(s){
  return s.replace("badge.textContent = '🧠 יומן פידבק';",
                   "badge.textContent = '🧠 מראה מצטברת'; // " + MIRROR_MARKER);
});

// ═══════════════════════════════════════════════════════════════════
// PATCH B — Drawer header: "יומן למידה" → "🪞 מראה מצטברת", widen drawer
// ═══════════════════════════════════════════════════════════════════
patch('mirror-drawer-header', function(s){
  const OLD_HEADER = '<h3 style="margin:0;color:var(--accent);font-size:14px">יומן למידה</h3>';
  const NEW_HEADER = '<h3 style="margin:0;color:var(--accent);font-size:14px">🪞 מראה מצטברת — מה המערכת למדה</h3>';
  if (s.indexOf(OLD_HEADER) < 0) return s;
  s = s.replace(OLD_HEADER, NEW_HEADER);
  /* Widen drawer from 340px to 380px, max-height 70vh → 80vh */
  s = s.replace(
    "drawer.style.cssText = 'position:fixed;bottom:0;left:0;width:340px;max-height:70vh;",
    "drawer.style.cssText = 'position:fixed;bottom:0;left:0;width:380px;max-height:80vh;"
  );
  return s;
});

// ═══════════════════════════════════════════════════════════════════
// PATCH C — Replace toggleFeedbackDrawer body with cumulative mirror renderer
// ═══════════════════════════════════════════════════════════════════
patch('mirror-drawer-body', function(s){
  /* Locate the existing function and replace through `window.toggleFeedbackDrawer = toggleFeedbackDrawer;` */
  const START = 'async function toggleFeedbackDrawer() {';
  const END   = 'window.toggleFeedbackDrawer = toggleFeedbackDrawer;';
  const iStart = s.indexOf(START);
  if (iStart < 0) throw new Error('toggleFeedbackDrawer לא נמצא');
  const iEnd = s.indexOf(END, iStart);
  if (iEnd < 0) throw new Error('סוף toggleFeedbackDrawer לא נמצא');
  const replaceUpTo = iEnd + END.length;

  const NEW_FN =
`async function toggleFeedbackDrawer() { // ${MIRROR_MARKER}
  var d = document.getElementById('fbDrawer');
  if (!d) return;
  if (!(d.style.display === 'none' || !d.style.display)) { d.style.display = 'none'; return; }
  d.style.display = 'block';
  var c = document.getElementById('fbDrawerContent');
  c.innerHTML = 'טוען מראה מצטברת...';
  await loadLearnedBanlist(true);
  var bl = window.__learnedBanlist;
  try {
    var allRes = await sb.from('track_feedback').select('artist_spotify_id,artist_name,track_spotify_id,track_name,feedback_type,reason_code,created_at').order('created_at', {ascending: false}).limit(5000);
    var rows = (allRes && allRes.data) || [];
    var totalFB = rows.length;
    var firstAt = rows.length ? new Date(rows[rows.length-1].created_at) : null;
    var daysLearning = firstAt ? Math.max(1, Math.ceil((Date.now() - firstAt.getTime()) / 86400000)) : 0;
    var negRows = rows.filter(function(r){ return r.feedback_type === 'thumbs_down' || r.feedback_type === 'never_again'; });
    var posRows = rows.filter(function(r){ return r.feedback_type === 'thumbs_up'; });

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

    var reasonCounts = {};
    negRows.forEach(function(r){ if (r.reason_code) reasonCounts[r.reason_code] = (reasonCounts[r.reason_code] || 0) + 1; });
    var totalNeg = negRows.length || 1;
    var reasonRanked = Object.keys(reasonCounts).map(function(k){
      return {code: k, count: reasonCounts[k], pct: Math.round(100 * reasonCounts[k] / totalNeg)};
    }).sort(function(a,b){ return b.count - a.count; });

    var html = '';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:14px">';
    html += '<div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:var(--accent)">' + bl.artists.size + '</div><div style="font-size:10px;color:var(--muted)">אמנים חסומים</div></div>';
    html += '<div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:var(--accent)">' + bl.tracks.size + '</div><div style="font-size:10px;color:var(--muted)">שירים חסומים</div></div>';
    html += '<div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:var(--accent)">' + totalFB + '</div><div style="font-size:10px;color:var(--muted)">פידבקים</div></div>';
    html += '</div>';
    html += '<div style="text-align:center;color:var(--muted);font-size:10px;margin-bottom:14px">🗓️ ' + daysLearning + ' ימי למידה · 👍 ' + posRows.length + ' חיוביים · 👎 ' + negRows.length + ' שליליים</div>';

    html += '<div style="font-weight:600;margin-bottom:6px;color:var(--accent)">🚫 אמנים חסומים גלובלית</div>';
    if (!bannedArtists.length) {
      html += '<div style="color:var(--muted);font-size:11px;padding:8px;background:var(--card-2);border-radius:6px;margin-bottom:14px">אף אמן עדיין לא חצה את סף החסימה (≥3 דחיות מהקשרים שונים).</div>';
    } else {
      html += '<div style="margin-bottom:14px">';
      bannedArtists.slice(0, 12).forEach(function(a, i){
        var topReasons = Object.keys(a.reasons).sort(function(x,y){return a.reasons[y]-a.reasons[x]}).slice(0,2).map(function(rc){ var rl = FB_REASONS.find(function(x){return x.code===rc}); return (rl?rl.label:rc); }).join(', ');
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-bottom:1px solid var(--border);font-size:11px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"><b>' + (i+1) + '.</b> ' + a.name + (topReasons ? ' <span style="color:var(--muted)">(' + topReasons + ')</span>' : '') + '</div><div style="background:#7a1f1f;color:#fff;border-radius:10px;padding:1px 8px;font-size:10px;font-weight:600;margin-right:6px">' + a.votes + '</div></div>';
      });
      if (bannedArtists.length > 12) html += '<div style="text-align:center;color:var(--muted);font-size:10px;margin-top:4px">+' + (bannedArtists.length - 12) + ' נוספים</div>';
      html += '</div>';
    }

    html += '<div style="font-weight:600;margin-bottom:6px;color:var(--accent)">📊 התפלגות סיבות דחייה</div>';
    if (!reasonRanked.length) {
      html += '<div style="color:var(--muted);font-size:11px;padding:8px;background:var(--card-2);border-radius:6px;margin-bottom:14px">עדיין אין דחיות עם סיבה.</div>';
    } else {
      html += '<div style="margin-bottom:14px">';
      reasonRanked.forEach(function(r){
        var rl = FB_REASONS.find(function(x){return x.code===r.code});
        var label = rl ? rl.label : r.code;
        html += '<div style="margin-bottom:6px;font-size:11px"><div style="display:flex;justify-content:space-between;margin-bottom:2px"><span>' + label + '</span><span style="color:var(--muted)">' + r.count + ' (' + r.pct + '%)</span></div><div style="height:6px;background:var(--card-2);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + r.pct + '%;background:linear-gradient(90deg,var(--accent),#a33)"></div></div></div>';
      });
      html += '</div>';
    }

    if (brinkArtists.length) {
      html += '<div style="font-weight:600;margin-bottom:6px;color:var(--accent)">⚠️ על סף חסימה</div>';
      html += '<div style="margin-bottom:8px;font-size:11px;color:var(--muted)">דחייה אחת או שתיים נוספות יחסמו את האמנים האלה גלובלית:</div>';
      html += '<div style="margin-bottom:14px">';
      brinkArtists.slice(0, 8).forEach(function(a){
        var dots = '\u25CF'.repeat(a.votes) + '\u25CB'.repeat(3 - a.votes);
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:11px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + a.name + '</span><span style="color:#c69;letter-spacing:2px;font-size:10px;margin-right:6px" title="' + a.votes + '/3 לחסימה">' + dots + '</span></div>';
      });
      html += '</div>';
    }

    html += '<div style="margin-top:14px;padding:10px;background:linear-gradient(135deg,rgba(29,185,84,0.08),rgba(29,185,84,0.02));border-radius:8px;border-right:3px solid var(--accent)"><div style="font-weight:600;margin-bottom:4px;font-size:12px">🎯 השפעה על הניתוח הבא</div><div style="font-size:11px;color:var(--muted);line-height:1.5">הפילטר הקשיח יסנן <b>' + bl.artists.size + '</b> אמנים ו-<b>' + bl.tracks.size + '</b> שירים.' + (reasonRanked.length ? '<br>הקשר ל-LLM יזהיר במיוחד נגד: <b>' + reasonRanked.slice(0,3).map(function(r){var rl=FB_REASONS.find(function(x){return x.code===r.code});return rl?rl.label:r.code}).join(' · ') + '</b>.' : '') + '</div></div>';

    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<div style="color:#c66">שגיאה בטעינת המראה: ' + (e && e.message || e) + '</div>';
  }
}
window.toggleFeedbackDrawer = toggleFeedbackDrawer;`;

  return s.substring(0, iStart) + NEW_FN + s.substring(replaceUpTo);
});

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
console.log('  git add index.html');
console.log('  git commit -m "feat(feedback): upgrade drawer to cumulative reflection mirror"');
console.log('  git push');
console.log('');
console.log('  # אם משהו נשבר:');
console.log('  cp "' + BACKUP_PATH + '" index.html');
