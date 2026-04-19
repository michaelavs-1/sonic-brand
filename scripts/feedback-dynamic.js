#!/usr/bin/env node
/*
  SonicBrand — Feedback Dynamic Learning (V2) installer
  ─────────────────────────────────────────────────────────
  Pivots the V1 threshold-based blocker into a true global,
  context-aware self-improvement loop:

    1. Neutralizes the hard banlist filter (no more absolute blocks).
    2. Replaces the static reason-stats LLM context with a dynamic
       GPT-4o-mini reflection that:
         - reads the last 100 feedback rows + existing insights,
         - synthesizes/updates contextual IF-THEN rules,
         - stores them in `learned_insights` (Supabase),
         - injects only the rules whose scope matches the current
           business context, ranked by confidence × evidence.
    3. Replaces the drawer with an "insights mirror" — what the system
       has actually learned, ranked, with citations.

  Safe to re-run (idempotent). Run AFTER feedback-system.js.
  Prereq: run feedback-dynamic-schema.sql in Supabase SQL Editor.
*/
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'index.html');
const BACKUP_PATH = HTML_PATH + '.backup-fbdyn-' + Date.now();

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
  const before = src;
  src = replacer(src);
  if (src === before) {
    console.log('⚠️  [' + name + '] replacer לא שינה כלום — מדלג');
    skipped++;
    return;
  }
  if (marker && src.indexOf(marker) < 0) {
    console.log('⚠️  [' + name + '] נכשל — marker חסר אחרי patch');
    skipped++;
    return;
  }
  console.log('✅ [' + name + '] הוחל');
  applied++;
}

// ═══════════════════════════════════════════════════════════════════
// PATCH A — Neutralize the FB_FILTER_V1 hard filter
// Replaces the learned-banlist OR-injection with `false||` so the
// FAUX_NICHE_ARTISTS check (curated list) still works, but no global
// blocking from past feedback.
// ═══════════════════════════════════════════════════════════════════
const FB_FILTER_V1_INJECTION =
  "/*FB_FILTER_V1*/(window.__learnedBanlist&&window.__learnedBanlist.artists&&(window.__learnedBanlist.artists.has(t._artistId||t.artistId||'')||window.__learnedBanlist.tracks.has(t.id||'')))||";
const FB_DYN_NEUTRALIZED = "/*FB_DYN_V1_NEUTRALIZED*/false||";

patch(
  'fb-dyn-neutralize-filter',
  FB_FILTER_V1_INJECTION,
  function (s) { return s.split(FB_FILTER_V1_INJECTION).join(FB_DYN_NEUTRALIZED); },
  '/*FB_DYN_V1_NEUTRALIZED*/'
);

// Also handle the case where script was re-run before — make sure marker exists
if (src.indexOf('/*FB_DYN_V1_NEUTRALIZED*/') < 0 && src.indexOf(FB_FILTER_V1_INJECTION) < 0) {
  // Either V1 was never installed, or already neutralized; check by FAUX_NICHE_ARTISTS
  console.log('ℹ️  fb-dyn-neutralize-filter: nothing to neutralize (OK)');
}

// ═══════════════════════════════════════════════════════════════════
// PATCH B — Replace __fbEnrichMessages with dynamic version
// Also installs `generateAndStoreInsights` + scope helpers.
// ═══════════════════════════════════════════════════════════════════
const FB_LLM_V1_BLOCK_START = "/*FB_LLM_V1*/async function __fbEnrichMessages(messages){";
const FB_LLM_V1_BLOCK_END   = "}var __origCallOpenAI_fb=null;";

const FB_DYN_ENRICH_MARKER = '/*FB_DYN_V1_ENRICH*/';
const FB_DYN_ENRICH_BLOCK = FB_DYN_ENRICH_MARKER + `
/* ── Dynamic learning helpers ───────────────────────────────────── */
window.__dynInsightCache = { insights: [], loadedAt: 0, lastReflectAt: 0, lastFeedbackCountAtReflect: 0 };

function __dynBuildCurrentContext(){
  try{
    var w = (typeof wiz !== 'undefined') ? wiz : {};
    var f = (w.faders) || {};
    return {
      biz: w.bizCategory || '',
      bizDNA: (w.bizDNA && w.bizDNA.label) || '',
      energy: (typeof f.energy === 'number') ? Math.round(f.energy*100)/100 : null,
      mainstream: (typeof f.mainstream === 'number') ? Math.round(f.mainstream*100)/100 : null,
      hebrew: (typeof f.hebrewShare === 'number') ? Math.round(f.hebrewShare*100)/100 : (typeof f.hebrew==='number'?Math.round(f.hebrew*100)/100:null),
      era: (typeof f.eraTilt === 'number') ? Math.round(f.eraTilt*100)/100 : null,
      familiarity: (typeof f.familiarity === 'number') ? Math.round(f.familiarity*100)/100 : null
    };
  }catch(e){ return {}; }
}

/* Cosine-ish scope matching: returns 0..1 — how relevant an insight is to current ctx. */
function __dynScopeMatch(insightScope, ctx){
  if (!insightScope || typeof insightScope !== 'object') return 0.5; /* generic insight = mid relevance */
  var keys = Object.keys(insightScope);
  if (!keys.length) return 0.5;
  var hits = 0, total = 0;
  for (var i=0;i<keys.length;i++){
    var k = keys[i], v = insightScope[k], cv = ctx[k];
    total++;
    if (v === null || v === undefined) continue;
    if (cv === null || cv === undefined) continue;
    if (typeof v === 'string' && typeof cv === 'string'){
      if (v.toLowerCase() === cv.toLowerCase()) hits++;
    } else if (typeof v === 'number' && typeof cv === 'number'){
      if (Math.abs(v-cv) <= 0.25) hits++;
    } else if (Array.isArray(v)){
      if (v.indexOf(cv) >= 0) hits++;
    }
  }
  return total ? (hits/total) : 0.5;
}

async function __dynLoadInsights(force){
  try{
    var now = Date.now();
    if (!force && window.__dynInsightCache.loadedAt && (now - window.__dynInsightCache.loadedAt) < 30000){
      return window.__dynInsightCache.insights;
    }
    var res = await sb.from('active_insights').select('*').limit(200);
    var data = (res && res.data) || [];
    window.__dynInsightCache.insights = data;
    window.__dynInsightCache.loadedAt = now;
    return data;
  }catch(e){
    console.warn('[fb-dyn] load insights failed:', e && e.message);
    return window.__dynInsightCache.insights || [];
  }
}
window.__dynLoadInsights = __dynLoadInsights;

/* Decide whether to call the LLM reflector. Throttled to avoid spamming. */
async function __dynShouldReflect(){
  try{
    var now = Date.now();
    /* Skip if reflected in last 4 minutes */
    if (window.__dynInsightCache.lastReflectAt && (now - window.__dynInsightCache.lastReflectAt) < 240000){
      return false;
    }
    /* Count feedback */
    var cntRes = await sb.from('track_feedback').select('id', {count:'exact', head:true});
    var totalFB = (cntRes && cntRes.count) || 0;
    if (totalFB < 3) return false; /* not enough signal yet */
    /* Reflect if at least 3 new feedbacks since last reflection */
    var newSince = totalFB - (window.__dynInsightCache.lastFeedbackCountAtReflect || 0);
    if (window.__dynInsightCache.lastReflectAt === 0) return true; /* first time */
    return newSince >= 3;
  }catch(e){ return false; }
}

/* The reflector: ask GPT-4o-mini to synthesize/update insights. */
async function __dynReflect(currentCtx){
  try{
    if (typeof OPENAI_API_KEY === 'undefined' || !OPENAI_API_KEY){
      return null;
    }
    /* 1. Pull recent feedback (last 100 rows) */
    var fbRes = await sb.from('track_feedback')
      .select('feedback_type,reason_code,artist_name,track_name,context,created_at')
      .order('created_at', {ascending:false}).limit(100);
    var feedback = (fbRes && fbRes.data) || [];
    if (feedback.length < 3) return null;

    /* 2. Existing active insights */
    var existing = await __dynLoadInsights(true);

    /* 3. Build prompt */
    var fbCompact = feedback.map(function(r){
      var c = r.context || {};
      return {
        v: r.feedback_type === 'thumbs_up' ? '+' : (r.feedback_type === 'never_again' ? '--' : '-'),
        r: r.reason_code || null,
        a: r.artist_name || '',
        t: r.track_name || '',
        b: c.biz || '',
        f: c.faders || null
      };
    });
    var existingCompact = existing.slice(0, 50).map(function(i){
      return { id: i.id, rule: i.rule_text, scope: i.scope, conf: i.confidence, n: i.based_on_count, cat: i.category };
    });

    var systemMsg =
      'You are a meta-learner improving a Hebrew-business music recommender. ' +
      'Read user feedback (thumbs up = +, thumbs down = -, never_again = --) and existing insights. ' +
      'Output ONLY a JSON object: {"insights":[{"rule_text":"IF condition THEN action","scope":{...},"category":"artist_avoid|era|energy|language|mainstream|general","confidence":0.0-1.0,"based_on_count":int,"supersedes_id":null|"<id>"}]}. ' +
      'Rules:\\n' +
      '- Each insight must be a contextual rule, not a blanket ban. Use scope to tie it to biz/faders/etc.\\n' +
      '- Generic rules (e.g. "avoid 2010s pop in cafes with low-mainstream faders") are valuable.\\n' +
      '- Strengthen existing insights (set supersedes_id) only when new evidence reinforces or refines them.\\n' +
      '- Drop rules contradicted by recent positive feedback.\\n' +
      '- confidence reflects evidence quality (more rows + clearer pattern = higher).\\n' +
      '- Output 3-8 insights max. Prefer fewer, higher-quality, contextual rules over many generic ones.\\n' +
      '- rule_text should be in clear English, <=140 chars. The rule is consumed by GPT-4 inside a Hebrew music brief.\\n' +
      '- Never produce a rule that says "never play X" without a scope condition.';

    var userMsg =
      'CURRENT CONTEXT (the analysis being prepared):\\n' + JSON.stringify(currentCtx) +
      '\\n\\nRECENT FEEDBACK (' + feedback.length + ' rows, newest first):\\n' + JSON.stringify(fbCompact) +
      '\\n\\nEXISTING ACTIVE INSIGHTS:\\n' + JSON.stringify(existingCompact) +
      '\\n\\nProduce updated insights JSON now.';

    var resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_API_KEY},
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        response_format: {type:'json_object'},
        messages: [
          {role:'system', content: systemMsg},
          {role:'user',   content: userMsg}
        ]
      })
    });
    if (!resp.ok){
      console.warn('[fb-dyn] reflector HTTP', resp.status);
      return null;
    }
    var data = await resp.json();
    var raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch(e){ console.warn('[fb-dyn] JSON parse fail'); return null; }
    var newInsights = parsed && parsed.insights;
    if (!Array.isArray(newInsights) || !newInsights.length) return [];

    /* 4. Persist insights */
    for (var i=0;i<newInsights.length;i++){
      var ins = newInsights[i];
      if (!ins || !ins.rule_text) continue;
      var sig = (ins.rule_text || '').toLowerCase().replace(/\\s+/g,' ').trim().slice(0,200);
      var row = {
        rule_text: String(ins.rule_text).slice(0,500),
        scope: ins.scope || {},
        confidence: Math.max(0, Math.min(1, Number(ins.confidence) || 0.5)),
        based_on_count: Math.max(0, Number(ins.based_on_count) || 0),
        category: ins.category || 'general',
        signature: sig,
        active: true
      };
      try{
        var ins1 = await sb.from('learned_insights').upsert([row], {onConflict:'signature'});
        if (ins1 && ins1.error) console.warn('[fb-dyn] upsert err:', ins1.error.message);
        /* If supersedes — mark old as inactive */
        if (ins.supersedes_id){
          await sb.from('learned_insights').update({active:false, superseded_by:null}).eq('id', ins.supersedes_id);
        }
      }catch(e){ console.warn('[fb-dyn] persist err:', e && e.message); }
    }

    /* 5. Update cache trackers */
    window.__dynInsightCache.lastReflectAt = Date.now();
    var cnt2 = await sb.from('track_feedback').select('id', {count:'exact', head:true});
    window.__dynInsightCache.lastFeedbackCountAtReflect = (cnt2 && cnt2.count) || 0;

    /* 6. Reload */
    await __dynLoadInsights(true);

    if (typeof brainLog === 'function') brainLog('💡', 'תובנה', 'נוצרו/עודכנו ' + newInsights.length + ' תובנות');
    if (typeof renderFeedbackBadge === 'function') renderFeedbackBadge();
    return newInsights;
  }catch(e){
    console.warn('[fb-dyn] reflect failed:', e && e.message);
    return null;
  }
}
window.__dynReflect = __dynReflect;

async function __fbEnrichMessages(messages){
  try{
    if(!messages||!messages.length)return messages;
    var sys=messages[0];
    if(!sys||sys.role!=='system'||typeof sys.content!=='string')return messages;
    if(sys.content.length<400)return messages;

    var ctx = __dynBuildCurrentContext();

    /* Reflect (synthesize fresh insights) if conditions met. Awaited so the
       brief sees the freshest learning — but throttled internally. */
    if (await __dynShouldReflect()){
      try { await __dynReflect(ctx); } catch(e) {}
    }

    /* Load + score insights by scope match × strength. */
    var insights = await __dynLoadInsights(false);
    if (!insights || !insights.length) return messages;

    var scored = insights.map(function(i){
      var rel = __dynScopeMatch(i.scope, ctx);
      var strength = (Number(i.confidence)||0.5) * (Math.min(Number(i.based_on_count)||0, 20) / 20.0);
      return { i: i, score: rel * (0.4 + strength) };
    }).filter(function(x){ return x.score >= 0.25; })
      .sort(function(a,b){ return b.score - a.score; })
      .slice(0, 8);

    if (!scored.length) return messages;

    var lines = scored.map(function(x){
      var conf = Math.round(((Number(x.i.confidence)||0)*100));
      var n    = Number(x.i.based_on_count)||0;
      var rel  = Math.round(x.score*100);
      return '  • ' + x.i.rule_text + ' [conf ' + conf + '%, n=' + n + ', context-fit ' + rel + '%]';
    }).join('\\n');

    var block =
      '\\n\\n---\\nLEARNED INSIGHTS (synthesized from real user feedback, ranked by relevance to this brief):\\n' +
      lines +
      '\\n\\nApply these as soft priors. They are heuristics, not hard rules. ' +
      'When an insight conflicts with the explicit brief above, follow the brief.';

    /* Touch usage_count async */
    try{
      var ids = scored.map(function(x){ return x.i.id; }).filter(Boolean);
      if (ids.length){
        for (var k=0;k<ids.length;k++){
          /* fire-and-forget — non-awaited */
          sb.rpc && sb.rpc.bind && (function(id){
            sb.from('learned_insights').update({usage_count: (insights.find(function(z){return z.id===id})||{}).usage_count + 1 || 1, last_used_at: new Date().toISOString()}).eq('id', id).then(function(){}, function(){});
          })(ids[k]);
        }
      }
    }catch(e){}

    messages[0] = Object.assign({}, sys, {content: sys.content + block});
    return messages;
  }catch(e){
    console.warn('[fb-dyn] enrich failed:', e && e.message);
    return messages;
  }
}
var __origCallOpenAI_fb=null;`;

patch(
  'fb-dyn-enrich',
  FB_LLM_V1_BLOCK_START,
  function (s) {
    if (s.indexOf(FB_DYN_ENRICH_MARKER) >= 0) return s;
    var startIdx = s.indexOf(FB_LLM_V1_BLOCK_START);
    if (startIdx < 0) return s;
    var endIdx = s.indexOf(FB_LLM_V1_BLOCK_END, startIdx);
    if (endIdx < 0) return s;
    var before = s.substring(0, startIdx);
    var after  = s.substring(endIdx + FB_LLM_V1_BLOCK_END.length);
    return before + FB_DYN_ENRICH_BLOCK + after;
  },
  FB_DYN_ENRICH_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// PATCH C — Replace toggleFeedbackDrawer with insights-based mirror
// Anchor: the existing `async function toggleFeedbackDrawer() {`
// We rename it and inject the new one.
// ═══════════════════════════════════════════════════════════════════
const FB_DRAWER_OLD_ANCHOR = 'async function toggleFeedbackDrawer() {';
const FB_DYN_DRAWER_MARKER = '/*FB_DYN_V1_DRAWER*/';

const FB_DYN_DRAWER_FUNC =
  FB_DYN_DRAWER_MARKER + `
async function toggleFeedbackDrawer() {
  var d = document.getElementById('fbDrawer');
  if (!d) return;
  if (!(d.style.display === 'none' || !d.style.display)) { d.style.display = 'none'; return; }
  d.style.display = 'block';
  var c = document.getElementById('fbDrawerContent');
  c.innerHTML = 'טוען מראה מצטברת...';
  try {
    /* Load insights + summary in parallel */
    var insightsPromise = sb.from('active_insights').select('*').limit(200);
    var summaryPromise  = sb.from('insight_summary').select('*').limit(1);
    var fbPromise       = sb.from('track_feedback').select('feedback_type,reason_code,artist_name,track_name,created_at').order('created_at', {ascending:false}).limit(500);

    var iRes = await insightsPromise;
    var sRes = await summaryPromise;
    var fRes = await fbPromise;

    var insights = (iRes && iRes.data) || [];
    var summary  = (sRes && sRes.data && sRes.data[0]) || {};
    var fbRows   = (fRes && fRes.data) || [];

    var ctx = (typeof __dynBuildCurrentContext === 'function') ? __dynBuildCurrentContext() : {};

    /* Score each insight by relevance to current context */
    var scored = insights.map(function(i){
      var rel = (typeof __dynScopeMatch === 'function') ? __dynScopeMatch(i.scope, ctx) : 0.5;
      return { i: i, rel: rel };
    });

    /* Group by category */
    var byCat = {};
    scored.forEach(function(s){
      var k = s.i.category || 'general';
      if (!byCat[k]) byCat[k] = [];
      byCat[k].push(s);
    });

    var catLabels = {
      artist_avoid: '🎤 אמנים שיש להימנע מהם',
      era: '📅 תקופות',
      energy: '⚡ אנרגיה',
      language: '🗣️ שפה',
      mainstream: '📈 מיינסטרים',
      general: '💡 כללי'
    };

    /* ── Build HTML ────────────────────────────────────────── */
    var negFB = fbRows.filter(function(r){ return r.feedback_type === 'thumbs_down' || r.feedback_type === 'never_again'; });
    var posFB = fbRows.filter(function(r){ return r.feedback_type === 'thumbs_up'; });
    var firstAt = fbRows.length ? new Date(fbRows[fbRows.length-1].created_at) : null;
    var daysLearning = firstAt ? Math.max(1, Math.ceil((Date.now() - firstAt.getTime())/86400000)) : 0;

    var html = '';

    /* Top stats row */
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px">';
    html += '  <div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center">' +
            '    <div style="font-size:22px;font-weight:700;color:var(--accent)">' + (summary.active_count || insights.length) + '</div>' +
            '    <div style="font-size:10px;color:var(--muted)">תובנות פעילות</div>' +
            '  </div>';
    html += '  <div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center">' +
            '    <div style="font-size:22px;font-weight:700;color:var(--accent)">' + fbRows.length + '</div>' +
            '    <div style="font-size:10px;color:var(--muted)">פידבקים</div>' +
            '  </div>';
    var avgConf = summary.avg_confidence ? Math.round(Number(summary.avg_confidence)*100) : 0;
    html += '  <div style="background:var(--card-2);border-radius:8px;padding:10px;text-align:center">' +
            '    <div style="font-size:22px;font-weight:700;color:var(--accent)">' + avgConf + '%</div>' +
            '    <div style="font-size:10px;color:var(--muted)">ביטחון ממוצע</div>' +
            '  </div>';
    html += '</div>';

    html += '<div style="text-align:center;color:var(--muted);font-size:10px;margin-bottom:12px">' +
            '🗓️ ' + daysLearning + ' ימי למידה · 👍 ' + posFB.length + ' חיוביים · 👎 ' + negFB.length + ' שליליים' +
            '</div>';

    /* Refresh button */
    html += '<div style="text-align:center;margin-bottom:12px">' +
            '<button onclick="__dynManualReflect()" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:6px 14px;font-size:11px;font-weight:600;cursor:pointer">🔄 רענן תובנות עכשיו (GPT-4o-mini)</button>' +
            '</div>';

    /* No insights yet */
    if (!insights.length){
      html += '<div style="background:var(--card-2);border-radius:8px;padding:14px;text-align:center;color:var(--muted);font-size:11px">' +
              'עדיין לא נצברו תובנות. צריך לפחות 3 פידבקים — ואז GPT-4o-mini יסיק כללים מההקשר.' +
              '</div>';
      c.innerHTML = html;
      return;
    }

    /* List insights grouped by category, ranked by relevance × strength */
    var catOrder = ['artist_avoid','era','energy','language','mainstream','general'];
    catOrder.forEach(function(cat){
      var arr = byCat[cat];
      if (!arr || !arr.length) return;
      arr.sort(function(a,b){
        var sa = (Number(a.i.confidence)||0)*(Math.min(Number(a.i.based_on_count)||0,20)/20)*a.rel;
        var sb_ = (Number(b.i.confidence)||0)*(Math.min(Number(b.i.based_on_count)||0,20)/20)*b.rel;
        return sb_ - sa;
      });
      html += '<div style="font-weight:600;margin:12px 0 6px;color:var(--accent);font-size:12px">' + (catLabels[cat] || cat) + '</div>';
      arr.forEach(function(s){
        var i = s.i;
        var conf = Math.round((Number(i.confidence)||0)*100);
        var rel  = Math.round(s.rel*100);
        var n    = Number(i.based_on_count)||0;
        var bg = s.rel >= 0.66 ? 'rgba(29,185,84,0.08)' : (s.rel >= 0.33 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.015)');
        var br = s.rel >= 0.66 ? 'var(--accent)' : 'var(--border)';
        html += '<div style="background:' + bg + ';border-right:3px solid ' + br + ';border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:11px;line-height:1.5">' +
                '  <div style="color:var(--text)">' + (i.rule_text || '?') + '</div>' +
                '  <div style="color:var(--muted);font-size:10px;margin-top:4px;display:flex;gap:10px">' +
                '    <span>🎯 רלוונטיות עכשיו: <b style="color:var(--text)">' + rel + '%</b></span>' +
                '    <span>💪 ביטחון: <b style="color:var(--text)">' + conf + '%</b></span>' +
                '    <span>📊 n=' + n + '</span>' +
                '    <span>📞 ' + (Number(i.usage_count)||0) + '</span>' +
                '  </div>' +
                '</div>';
      });
    });

    /* Impact explanation */
    var topByRel = scored.slice().sort(function(a,b){
      var sa = (Number(a.i.confidence)||0)*a.rel;
      var sb_ = (Number(b.i.confidence)||0)*b.rel;
      return sb_ - sa;
    }).slice(0, 5);
    html += '<div style="margin-top:14px;padding:10px;background:linear-gradient(135deg,rgba(29,185,84,0.08),rgba(29,185,84,0.02));border-radius:8px;border-right:3px solid var(--accent)">' +
            '  <div style="font-weight:600;margin-bottom:6px;font-size:12px">🎯 ההשפעה על הניתוח הבא</div>' +
            '  <div style="font-size:11px;color:var(--muted);line-height:1.6">' +
            '    הקשר נוכחי: <b>' + (ctx.biz || '—') + '</b>' + (ctx.bizDNA ? ' · ' + ctx.bizDNA : '') + '.<br>' +
            '    הברפ ל-GPT-4 יכלול את <b>' + topByRel.length + '</b> התובנות הרלוונטיות ביותר כ-soft priors.' +
            (topByRel.length ? ' למשל: <i>"' + (topByRel[0].i.rule_text || '').slice(0, 100) + '..."</i>' : '') +
            '  </div>' +
            '</div>';

    c.innerHTML = html;
  } catch(e) {
    c.innerHTML = '<div style="color:#c66">שגיאה בטעינת המראה: ' + (e && e.message || e) + '</div>';
  }
}
async function __dynManualReflect(){
  var c = document.getElementById('fbDrawerContent');
  if (c) c.innerHTML = 'מסנכרן עם GPT-4o-mini...';
  try{
    var ctx = (typeof __dynBuildCurrentContext === 'function') ? __dynBuildCurrentContext() : {};
    if (typeof __dynReflect === 'function') await __dynReflect(ctx);
  }catch(e){}
  /* re-open to reload */
  var d = document.getElementById('fbDrawer');
  if (d){ d.style.display = 'none'; toggleFeedbackDrawer(); }
}
window.__dynManualReflect = __dynManualReflect;
async function __OLD_toggleFeedbackDrawer_v1() {`;

patch(
  'fb-dyn-drawer',
  FB_DRAWER_OLD_ANCHOR,
  function (s) {
    if (s.indexOf(FB_DYN_DRAWER_MARKER) >= 0) return s;
    return s.replace(FB_DRAWER_OLD_ANCHOR, FB_DYN_DRAWER_FUNC);
  },
  FB_DYN_DRAWER_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// PATCH D — Update badge text to count insights, not banlist
// Replace renderFeedbackBadge body to show insights count.
// ═══════════════════════════════════════════════════════════════════
const FB_BADGE_OLD = "function renderFeedbackBadge() {\n  var b = document.getElementById('fbDrawerBadge');\n  if (!b) return;\n  var bl = window.__learnedBanlist || {artists: new Set(), tracks: new Set()};\n  b.textContent = '🧠 ' + bl.artists.size + ' אמנים · ' + bl.tracks.size + ' שירים';\n}";
const FB_DYN_BADGE_MARKER = '/*FB_DYN_V1_BADGE*/';
const FB_BADGE_NEW = FB_DYN_BADGE_MARKER + `
function renderFeedbackBadge() {
  var b = document.getElementById('fbDrawerBadge');
  if (!b) return;
  var ins = (window.__dynInsightCache && window.__dynInsightCache.insights) || [];
  if (!ins.length){
    b.textContent = '🧠 מראה מצטברת';
  } else {
    b.textContent = '💡 ' + ins.length + ' תובנות פעילות';
  }
}`;

patch(
  'fb-dyn-badge',
  FB_BADGE_OLD,
  function (s) {
    if (s.indexOf(FB_DYN_BADGE_MARKER) >= 0) return s;
    return s.replace(FB_BADGE_OLD, FB_BADGE_NEW);
  },
  FB_DYN_BADGE_MARKER
);

// ═══════════════════════════════════════════════════════════════════
// PATCH E — Boot-time insight load (so the badge counts on page load)
// Hook: replace the existing DOMContentLoaded block that calls loadLearnedBanlist
// to also call __dynLoadInsights.
// ═══════════════════════════════════════════════════════════════════
const FB_BOOT_MARKER = '/*FB_DYN_V1_BOOT*/';
const FB_BOOT_OLD = "ensureFeedbackDrawer(); loadLearnedBanlist(true).then(renderFeedbackBadge);\n}";
const FB_BOOT_NEW = FB_BOOT_MARKER + "ensureFeedbackDrawer(); Promise.all([loadLearnedBanlist(true), (typeof __dynLoadInsights==='function' ? __dynLoadInsights(true) : Promise.resolve())]).then(function(){ if(typeof renderFeedbackBadge==='function') renderFeedbackBadge(); });\n}";

patch(
  'fb-dyn-boot',
  FB_BOOT_OLD,
  function (s) {
    if (s.indexOf(FB_BOOT_MARKER) >= 0) return s;
    /* Replace BOTH occurrences (the if-branch and the else-branch each call it) */
    return s.split(FB_BOOT_OLD).join(FB_BOOT_NEW);
  },
  FB_BOOT_MARKER
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
console.log('     scripts/feedback-dynamic-schema.sql');
console.log('');
console.log('  2) בדיקת syntax (אופציונלי):');
console.log('     פתח את index.html בדפדפן ובדוק שאין שגיאות בקונסול');
console.log('');
console.log('  3) git commit:');
console.log('     git add index.html scripts/feedback-dynamic-schema.sql scripts/feedback-dynamic.js');
console.log('     git commit -m "feat(feedback): dynamic GPT-4o reflection — replace hard banlist with contextual learned_insights"');
console.log('     git push');
console.log('');
console.log('  # אם משהו נשבר:');
console.log('  cp "' + BACKUP_PATH + '" index.html');
