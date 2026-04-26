/* SonicBrand v2 — Robin
   Clean 6-screen flow with MC-based fader inputs.
   Pipeline: GPT-4o picks 60 → Spotify validation → Fill-up if <45 → Render.
   Includes the Phase-3 fix (no validator that drops tracks) and Spotify token check. */

const SUPABASE_URL = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SPOTIFY_CLIENT_ID = 'b6404b5ae1684143b79d9a86bb4b6cba';
const SPOTIFY_SCOPES = 'playlist-modify-public playlist-modify-private user-read-private user-read-email';
const SPOTIFY_REDIRECT = location.origin + location.pathname; // /v2 path
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

/* ─────────── State ─────────── */
const state = {
  step: 1,
  totalSteps: 6,
  bizDesc: '',
  refPlaylist: '',
  bizType: null,        // detected
  bizJoke: '',
  bizFunc: '',
  recommendedMoods: [], // pre-marked
  selectedMoods: new Set(),
  mc: { familiarity: 3, hebrew: 3, vocal: 3, energy: 3, era: 3 },
  hours: { open: '09:00', close: '23:00' },
  refreshDays: 3,
  spotifyToken: null,
  spotifyUser: null,
  generatedTracks: [],
  feedback: {}, // trackKey -> 'up' | 'down'
  brainContext: {
    l1: null, // Reference Playlist DNA
    l2: null, // Historical Cohort Memory
    l3: null, // Genre-Tag Priors
    l4: null, // Feedback Reranker
    assembled: false,
  },
};

/* ─────────── Helpers ─────────── */
function $(id){ return document.getElementById(id); }
function showToast(msg, isError){
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(()=>{ t.className = 'toast'; }, 3500);
}
function genRandomString(len){
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr=new Uint8Array(len);crypto.getRandomValues(arr);
  return Array.from(arr).map(b=>chars[b%chars.length]).join('');
}
async function sha256(s){
  const buf=new TextEncoder().encode(s);
  const h=await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(h);
}
function base64url(arr){
  return btoa(String.fromCharCode.apply(null, arr))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

/* ─────────── Navigation ─────────── */
function setStep(n){
  state.step = n;
  document.querySelectorAll('.screen').forEach(el=>{
    el.classList.toggle('active', Number(el.dataset.screen) === n);
  });
  const dots = document.querySelectorAll('#progress .dot');
  dots.forEach((d,i)=>{
    d.classList.toggle('active', i+1 === n);
    d.classList.toggle('done', i+1 < n);
  });
  window.scrollTo({top:0,behavior:'smooth'});
}
function goNext(){ if(state.step < state.totalSteps) setStep(state.step+1); }
function goBack(){ if(state.step > 1) setStep(state.step-1); }

/* ─────────── Info tooltip ─────────── */
function toggleInfoTip(e){
  e.stopPropagation();
  $('infoTip').classList.toggle('show');
}
document.addEventListener('click', ()=>$('infoTip').classList.remove('show'));

/* ─────────── Screen 2: Spotify auth ─────────── */
async function spotifyLogin(){
  // PKCE flow
  localStorage.setItem('spotify_id', SPOTIFY_CLIENT_ID);
  const verifier = genRandomString(64);
  localStorage.setItem('sp_verifier', verifier);
  localStorage.setItem('sb_v2_state', JSON.stringify({step: state.step}));
  const challenge = base64url(await sha256(verifier));
  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: genRandomString(16),
  }).toString();
  window.location.href = url;
}

async function handleSpotifyCallback(){
  const code = new URLSearchParams(window.location.search).get('code');
  if(!code) return false;
  history.replaceState(null,'',location.pathname);
  const verifier = localStorage.getItem('sp_verifier');
  if(!verifier) return false;
  try{
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type:'authorization_code', code,
        redirect_uri: SPOTIFY_REDIRECT,
        client_id: SPOTIFY_CLIENT_ID,
        code_verifier: verifier,
      })
    });
    const j = await r.json();
    if(j.error) throw new Error(j.error_description||j.error);
    localStorage.setItem('sp_access', j.access_token);
    localStorage.setItem('sp_refresh', j.refresh_token);
    localStorage.setItem('sp_expiry', String(Date.now()+j.expires_in*1000));
    state.spotifyToken = j.access_token;
    await loadSpotifyUser();
    showToast('התחברת ל-Spotify ✓');
    setStep(3); // skip directly to business info
    return true;
  } catch(e){
    showToast('שגיאת Spotify: '+e.message, true);
    return false;
  }
}

async function refreshSpotifyTokenIfNeeded(){
  const exp = Number(localStorage.getItem('sp_expiry')||0);
  if(exp > Date.now()+30000){
    state.spotifyToken = localStorage.getItem('sp_access');
    return state.spotifyToken;
  }
  const rt = localStorage.getItem('sp_refresh');
  if(!rt) return null;
  try{
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type:'refresh_token', refresh_token:rt,
        client_id: SPOTIFY_CLIENT_ID,
      })
    });
    const j = await r.json();
    if(j.error) throw new Error(j.error);
    localStorage.setItem('sp_access', j.access_token);
    if(j.refresh_token) localStorage.setItem('sp_refresh', j.refresh_token);
    localStorage.setItem('sp_expiry', String(Date.now()+j.expires_in*1000));
    state.spotifyToken = j.access_token;
    return j.access_token;
  } catch(e){
    return null;
  }
}

async function loadSpotifyUser(){
  if(!state.spotifyToken) return;
  try{
    const r = await fetch('https://api.spotify.com/v1/me', {
      headers:{'Authorization':'Bearer '+state.spotifyToken}
    });
    if(r.ok){
      state.spotifyUser = await r.json();
    }
  } catch(e){}
}

/* ═══════════════════════════════════════════════════════════════
   ROBIN BRAIN — Layered Context (L1-L4)
   L1: Reference Playlist DNA (single URL)
   L2: Historical Cohort Memory (analyses by biz_category)
   L3: Genre-Tag Priors (analyses with matching genres)
   L4: Feedback Reranker (track_feedback by biz_category)
   ═══════════════════════════════════════════════════════════════ */

async function buildBrainContext(){
  state.brainContext.assembled = false;
  const [l1Res, l2Res, l3Res, l4Res] = await Promise.allSettled([
    state.refPlaylist ? fetchL1_DNA(state.refPlaylist) : Promise.resolve(null),
    fetchL2_Cohort(state.bizType),
    fetchL3_GenreArchive(Array.from(state.selectedMoods)),
    fetchL4_Feedback(state.bizType),
  ]);
  state.brainContext.l1 = l1Res.status==='fulfilled' ? l1Res.value : null;
  state.brainContext.l2 = l2Res.status==='fulfilled' ? l2Res.value : null;
  state.brainContext.l3 = l3Res.status==='fulfilled' ? l3Res.value : null;
  state.brainContext.l4 = l4Res.status==='fulfilled' ? l4Res.value : null;
  state.brainContext.assembled = true;
  console.log('[brain]', {
    l1: state.brainContext.l1 ? 'DNA('+state.brainContext.l1.trackCount+')' : '-',
    l2: state.brainContext.l2 ? 'cohort('+state.brainContext.l2.cohort_size+')' : '-',
    l3: state.brainContext.l3 ? 'archive('+state.brainContext.l3.archive_size+')' : '-',
    l4: state.brainContext.l4 ? 'feedback('+state.brainContext.l4.feedback_count+')' : '-',
  });
}

/* ─── L1: Reference Playlist DNA ─── */
function parsePlaylistId(url){
  if(!url) return null;
  const m = String(url).match(/playlist\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

async function fetchL1_DNA(url){
  const id = parsePlaylistId(url);
  if(!id) return null;
  const tok = await refreshSpotifyTokenIfNeeded();
  if(!tok) return null;
  try{
    const tr = await fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?fields=items(track(id,name,artists(id,name),album(release_date,images),popularity,duration_ms))&limit=100`, {
      headers:{'Authorization':'Bearer '+tok}
    });
    if(!tr.ok) return null;
    const trJson = await tr.json();
    const tracks = (trJson.items||[]).map(it=>it.track).filter(t=>t && t.id);
    if(tracks.length < 5) return null;
    const ids = tracks.map(t=>t.id);
    const af = await fetch(`https://api.spotify.com/v1/audio-features?ids=${ids.slice(0,100).join(',')}`, {
      headers:{'Authorization':'Bearer '+tok}
    });
    const afJson = af.ok ? await af.json() : {audio_features:[]};
    const features = (afJson.audio_features||[]).filter(f=>f);

    const stats = analyzeAudioStats(features, tracks);
    const faderHints = mapDNAToFaders(stats);
    const narration = await narrateDNA(stats, tracks).catch(()=>({summary:'', vibe_keywords:[]}));

    const topByPop = tracks.slice().sort((a,b)=>(b.popularity||0)-(a.popularity||0)).slice(0,5);
    const artistCount = {};
    tracks.forEach(t=>(t.artists||[]).forEach(a=>{ artistCount[a.name]=(artistCount[a.name]||0)+1; }));
    const topArtists = Object.entries(artistCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n])=>n);

    return {
      summary: narration.summary || '',
      vibeKeywords: Array.isArray(narration.vibe_keywords) ? narration.vibe_keywords : [],
      faderHints,
      topTrackIds: topByPop.map(t=>t.id),
      topTracksDisplay: topByPop.map(t=>`${t.artists.map(a=>a.name).join(', ')} — ${t.name}`),
      topArtists,
      audioStats: stats,
      trackCount: tracks.length,
    };
  } catch(e){
    console.warn('[brain L1] failed:', e);
    return null;
  }
}

function analyzeAudioStats(features, tracks){
  const mean = arr => arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : 0;
  const energy = mean(features.map(f=>f.energy||0));
  const valence = mean(features.map(f=>f.valence||0));
  const dance = mean(features.map(f=>f.danceability||0));
  const tempo = mean(features.map(f=>f.tempo||0));
  const instr = mean(features.map(f=>f.instrumentalness||0));
  const acoust = mean(features.map(f=>f.acousticness||0));
  const popularity = mean(tracks.map(t=>t.popularity||0));

  const hebRe = /[\u0590-\u05FF]/;
  const hebrewTracks = tracks.filter(t=>hebRe.test(t.name||'') || (t.artists||[]).some(a=>hebRe.test(a.name||''))).length;
  const hebrewRatio = tracks.length ? hebrewTracks/tracks.length : 0;

  const years = tracks.map(t=>{
    const d = (t.album && t.album.release_date) || '';
    return Number(d.slice(0,4)) || 0;
  }).filter(y=>y > 1950);
  const yearMean = mean(years);
  const currentYear = new Date().getFullYear();
  let eraScore = 50;
  if(yearMean){
    const age = currentYear - yearMean;
    if(age <= 3) eraScore = 90;
    else if(age <= 8) eraScore = 70;
    else if(age <= 15) eraScore = 50;
    else if(age <= 25) eraScore = 25;
    else eraScore = 10;
  }

  return {energy, valence, dance, tempo, instr, acoust, popularity, hebrewRatio, yearMean, eraScore};
}

function mapDNAToFaders(stats){
  return {
    familiarity: Math.round(Math.min(100, stats.popularity)),
    hebrew: Math.round(stats.hebrewRatio * 100),
    vocal: Math.round((1 - stats.instr) * 100),
    energy: Math.round(stats.energy * 100),
    era: Math.round(stats.eraScore),
  };
}

async function narrateDNA(stats, tracks){
  const sample = tracks.slice(0,8).map(t=>`${t.artists.map(a=>a.name).join(', ')} — ${t.name}`).join('\n');
  const sys = 'אתה מנתח DNA של פלייליסט. החזר JSON: {"summary":"משפט אחד 12-20 מילים בעברית","vibe_keywords":["3-5 מילות מפתח אווירה בעברית"]}';
  const usr = `סטטיסטיקות:
energy=${stats.energy.toFixed(2)} valence=${stats.valence.toFixed(2)} dance=${stats.dance.toFixed(2)}
instrumentalness=${stats.instr.toFixed(2)} acoustic=${stats.acoust.toFixed(2)}
popularity_avg=${stats.popularity.toFixed(0)} hebrew=${(stats.hebrewRatio*100).toFixed(0)}% year_avg=${stats.yearMean.toFixed(0)}

8 דוגמיות:
${sample}

נתח: סגנון/ז'אנר עיקרי, אווירה דומיננטית, טווח עידן.`;
  const raw = await callOpenAI([{role:'system',content:sys},{role:'user',content:usr}], {model:'gpt-4o-mini', max_tokens:300, temperature:0.5});
  return safeJSON(raw);
}

/* ─── L2: Historical Cohort Memory ─── */
async function fetchL2_Cohort(bizCategory){
  if(!bizCategory) return null;
  try{
    let { data, error } = await sb.from('analyses').select('id,description,faders,tracks,track_count,brain_version').eq('biz_category', bizCategory).gte('track_count', 10).order('created_at', {ascending:false}).limit(20);
    if(error) throw error;
    let cohortSize = data ? data.length : 0;
    let usedFallback = false;
    if(cohortSize < 3){
      const r2 = await sb.from('analyses').select('id,description,faders,tracks,track_count,brain_version').eq('biz_category', 'general').gte('track_count', 10).order('created_at', {ascending:false}).limit(20);
      if(!r2.error && r2.data){
        data = (data||[]).concat(r2.data);
        cohortSize = data.length;
        usedFallback = true;
      }
    }
    if(!data || !data.length) return null;

    const trackFreq = {};
    const artistFreq = {};
    let totalTracks = 0;
    for(const row of data){
      let tracks = row.tracks;
      try { if(typeof tracks === 'string') tracks = JSON.parse(tracks); } catch(e){}
      if(!Array.isArray(tracks)) continue;
      for(const t of tracks){
        if(!t || !t.artist || !t.title) continue;
        totalTracks++;
        const key = `${t.artist}|${t.title}`;
        if(!trackFreq[key]) trackFreq[key] = {count:0, id:t.id||null, artist:t.artist, title:t.title, reason:t.reason||''};
        trackFreq[key].count++;
        if(!trackFreq[key].id && t.id) trackFreq[key].id = t.id;
        artistFreq[t.artist] = (artistFreq[t.artist]||0) + 1;
      }
    }
    const sortedTracks = Object.values(trackFreq).sort((a,b)=>b.count-a.count);
    const topWithIds = sortedTracks.filter(t=>t.id).slice(0,10);
    const topArtists = Object.entries(artistFreq).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,c])=>({name:n,count:c}));

    return {
      cohort_size: cohortSize,
      used_fallback: usedFallback,
      cohort_top_ids: topWithIds.map(t=>t.id),
      cohort_top_tracks: topWithIds.map(t=>({artist:t.artist, title:t.title, id:t.id, reason:t.reason, count:t.count})),
      cohort_top_artists: topArtists,
      total_tracks_seen: totalTracks,
    };
  } catch(e){
    console.warn('[brain L2] failed:', e);
    return null;
  }
}

/* ─── L3: Genre-Tag Priors ─── */
async function fetchL3_GenreArchive(moods){
  if(!moods || !moods.length) return null;
  try{
    const moodLowers = moods.map(m=>String(m).toLowerCase().trim()).filter(Boolean);
    const { data, error } = await sb.from('analyses').select('id,description,genres,tracks,track_count').gte('track_count', 5).limit(50);
    if(error || !data) return null;

    const matching = [];
    for(const row of data){
      let genres = row.genres;
      try { if(typeof genres === 'string') genres = JSON.parse(genres); } catch(e){}
      if(!Array.isArray(genres) || !genres.length) continue;
      const genreLowers = genres.map(g=>String(g).toLowerCase());
      const hit = moodLowers.some(m=>genreLowers.some(g=>g===m || g.includes(m) || m.includes(g)));
      if(hit) matching.push(row);
    }
    if(!matching.length) return null;

    const trackFreq = {};
    for(const row of matching){
      let tracks = row.tracks;
      try { if(typeof tracks === 'string') tracks = JSON.parse(tracks); } catch(e){}
      if(!Array.isArray(tracks)) continue;
      for(const t of tracks){
        if(!t || !t.artist || !t.title) continue;
        const key = `${t.artist}|${t.title}`;
        if(!trackFreq[key]) trackFreq[key] = {count:0, id:t.id||null, artist:t.artist, title:t.title};
        trackFreq[key].count++;
        if(!trackFreq[key].id && t.id) trackFreq[key].id = t.id;
      }
    }
    const top = Object.values(trackFreq).filter(t=>t.id).sort((a,b)=>b.count-a.count).slice(0,10);
    return {
      archive_size: matching.length,
      genre_top_ids: top.map(t=>t.id),
      genre_top_tracks: top.map(t=>({artist:t.artist, title:t.title, count:t.count})),
    };
  } catch(e){
    console.warn('[brain L3] failed:', e);
    return null;
  }
}

/* ─── L4: Feedback Reranker (placeholder, ready for future) ─── */
async function fetchL4_Feedback(bizCategory){
  if(!bizCategory) return null;
  try{
    const { data, error } = await sb.from('track_feedback').select('track_artist,track_title,feedback_type').eq('biz_category', bizCategory).limit(500);
    if(error || !data || !data.length) return null;
    const score = {};
    for(const row of data){
      const key = `${row.track_artist}|${row.track_title}`;
      if(!score[key]) score[key] = {artist:row.track_artist, title:row.track_title, up:0, down:0};
      if(row.feedback_type === 'up') score[key].up++;
      else if(row.feedback_type === 'down') score[key].down++;
    }
    const arr = Object.values(score).map(s=>({...s, score: s.up - s.down}));
    const boost = arr.filter(s=>s.score >= 2).map(s=>`${s.artist} — ${s.title}`);
    const block = arr.filter(s=>s.score <= -2).map(s=>`${s.artist} — ${s.title}`);
    return {
      feedback_count: data.length,
      boost_list: boost.slice(0,10),
      block_list: block.slice(0,10),
    };
  } catch(e){
    console.warn('[brain L4] failed:', e);
    return null;
  }
}

/* ─── Prompt block assembly ─── */
function assembleBrainBlocks(){
  const ctx = state.brainContext;
  const blocks = [];
  if(ctx.l1){
    const lines = ['[L1 — REFERENCE PLAYLIST DNA]'];
    if(ctx.l1.summary) lines.push(`DNA: ${ctx.l1.summary}`);
    if(ctx.l1.topTracksDisplay && ctx.l1.topTracksDisplay.length) lines.push(`שירי דגל: ${ctx.l1.topTracksDisplay.slice(0,5).join(' | ')}`);
    if(ctx.l1.topArtists && ctx.l1.topArtists.length) lines.push(`אמנים מרכזיים: ${ctx.l1.topArtists.join(', ')}`);
    blocks.push(lines.join('\n'));
  }
  if(ctx.l2 && ctx.l2.cohort_top_tracks && ctx.l2.cohort_top_tracks.length >= 3){
    const lines = ['[L2 — COHORT MEMORY (Robin זוכרת מעסקים דומים)]'];
    lines.push(`מעבודות קודמות עם "${state.bizType}"${ctx.l2.used_fallback?' (כולל general)':''}, ${ctx.l2.cohort_size} פלייליסטים:`);
    ctx.l2.cohort_top_tracks.slice(0,8).forEach(t=>{
      lines.push(`- ${t.artist} — ${t.title}${t.reason?` (${String(t.reason).slice(0,50)})`:''}`);
    });
    lines.push('שאף לרוח דומה — לא חזרה מילולית.');
    blocks.push(lines.join('\n'));
  }
  if(ctx.l3 && ctx.l3.genre_top_tracks && ctx.l3.genre_top_tracks.length >= 3){
    const lines = ['[L3 — GENRE ARCHIVE]'];
    lines.push("מארכיון לפי-ז'אנרים שמתאים לאווירות שבחרת:");
    ctx.l3.genre_top_tracks.slice(0,6).forEach(t=>lines.push(`- ${t.artist} — ${t.title}`));
    blocks.push(lines.join('\n'));
  }
  if(ctx.l4 && (ctx.l4.boost_list.length || ctx.l4.block_list.length)){
    const lines = ['[L4 — FEEDBACK SIGNALS]'];
    if(ctx.l4.boost_list.length) lines.push(`חובה לכלול אם זמין: ${ctx.l4.boost_list.slice(0,5).join(', ')}`);
    if(ctx.l4.block_list.length) lines.push(`הימנע מ: ${ctx.l4.block_list.slice(0,5).join(', ')}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/* ─── Apply L1 fader hints to MC state ─── */
function applyFaderHints(faderHints){
  if(!window.SB_V2_MC || !faderHints) return;
  const findClosest = (val, options)=>{
    let bestId = 3, bestDiff = Infinity;
    for(const opt of options){
      const diff = Math.abs(val - opt.value);
      if(diff < bestDiff){ bestDiff = diff; bestId = opt.id; }
    }
    return bestId;
  };
  for(const key of ['familiarity','hebrew','vocal','energy','era']){
    const val = faderHints[key];
    if(val == null) continue;
    const q = window.SB_V2_MC[key];
    if(!q || !q.options) continue;
    state.mc[key] = findClosest(val, q.options);
  }
}

/* ─── Banner rendering on Screen 4 ─── */
function renderBrainBanner(){
  const ctx = state.brainContext;
  const el = document.getElementById('brainBanner');
  if(!el) return;
  if(!ctx.l1 && !ctx.l2 && !ctx.l3 && !ctx.l4) {
    el.style.display = 'none';
    return;
  }
  const parts = [];
  if(ctx.l1 && ctx.l1.summary) parts.push(`🧬 <strong>פלייליסט שלך:</strong> ${escapeHtml(ctx.l1.summary)}`);
  if(ctx.l2 && ctx.l2.cohort_size >= 3) parts.push(`📚 <strong>Robin זוכרת:</strong> ${ctx.l2.cohort_size} פלייליסטים${ctx.l2.used_fallback?' (כולל general)':''}`);
  if(ctx.l3 && ctx.l3.archive_size >= 1) parts.push(`🏷️ <strong>ארכיון ז'אנרים:</strong> ${ctx.l3.archive_size} רשומות תואמות`);
  if(ctx.l4 && ctx.l4.feedback_count > 0) parts.push(`👍 <strong>משוב:</strong> ${ctx.l4.feedback_count} הצבעות`);
  if(!parts.length){ el.style.display = 'none'; return; }
  el.innerHTML = parts.join(' · ');
  el.style.display = 'block';
}

/* ─────────── Screen 3: Business info → 4 transition ─────────── */
async function submitBizInfo(){
  const desc = $('bizDesc').value.trim();
  if(desc.length < 8){
    showToast('כתבו לפחות כמה מילים על העסק', true);
    return;
  }
  state.bizDesc = desc;
  state.refPlaylist = $('refPlaylist').value.trim();

  setStep(4);
  await detectBusinessType();
  renderMoods();
  renderMC();

  // Build brain context (L1-L4) — depends on bizType + selectedMoods
  await buildBrainContext();

  // Apply L1 hints to UI (fader pre-selection + vibe keywords as moods)
  if(state.brainContext.l1){
    if(state.brainContext.l1.faderHints) applyFaderHints(state.brainContext.l1.faderHints);
    if(state.brainContext.l1.vibeKeywords) state.brainContext.l1.vibeKeywords.forEach(k=>state.selectedMoods.add(k));
  }
  renderMoods();
  renderMC();
  renderBrainBanner();
}

async function detectBusinessType(){
  $('bizTypeName').textContent = 'מנתח...';
  $('bizJoke').textContent = '— מזהה את הסוג…';
  $('bizFunc').textContent = '— טוען המלצות…';

  try{
    const sys = 'אתה רובין, מומחה אווירה מוזיקלית לעסקים. בהינתן תיאור עסק, החזר JSON: {"biz_type":"מילה אחת/שתיים בעברית, סוג העסק","joke":"בדיחה קצרה ומחממת לב על סוג העסק (8-15 מילים)","music_function":"תיאור של 1-2 משפטים על איך מוזיקה ממלאת תפקיד בעסק כזה","recommended_moods":["3-7 אווירות בעברית בקצרה"]}';
    const usr = 'תיאור עסק: ' + state.bizDesc;
    const j = await callOpenAI([
      {role:'system', content: sys},
      {role:'user', content: usr},
    ], {model:'gpt-4o-mini', max_tokens:600, temperature:0.65});
    const parsed = safeJSON(j);
    state.bizType = parsed.biz_type || 'עסק';
    state.bizJoke = parsed.joke || '';
    state.bizFunc = parsed.music_function || '';
    state.recommendedMoods = Array.isArray(parsed.recommended_moods) ? parsed.recommended_moods.slice(0,7) : [];
    parsed.recommended_moods && parsed.recommended_moods.forEach(m=>state.selectedMoods.add(m));

    $('bizTypeName').textContent = state.bizType;
    $('bizJoke').textContent = state.bizJoke;
    $('bizFunc').textContent = 'מניסיוני, סוגי עסקים כאלה צריכים: ' + state.bizFunc;
  } catch(e){
    $('bizTypeName').textContent = 'עסק';
    $('bizJoke').textContent = 'נחמד שהצטרפת. בואו נמשיך.';
    $('bizFunc').textContent = 'מוזיקה תעצב את האווירה ואת חוויית הקהל.';
    state.recommendedMoods = ['חמים','מאוזן','אינטימי','לא רעשני'];
    state.recommendedMoods.forEach(m=>state.selectedMoods.add(m));
    console.warn('Business detect failed:', e);
  }
}

/* ─────────── Screen 4: Moods + MC ─────────── */
const MOOD_LIBRARY = [
  'אנרגטי','רגוע','אינטימי','חברותי','קליל','אלגנטי','אקלקטי',
  'נוסטלגי','עכשווי','מסיבתי','מינימליסטי','חמים','קר ומגניב',
  'משפחתי','צעיר','בוגר','עירוני','כפרי','מסתורי','שמשי','חורפי',
  'אופטימי','מהורהר','קצבי','רומנטי','אנרגיה גבוהה','שקט','דחוס',
];

function renderMoods(){
  const grid = $('moodsGrid');
  // Combine recommended + library, dedup
  const all = Array.from(new Set([...state.recommendedMoods, ...MOOD_LIBRARY]));
  grid.innerHTML = all.map(m=>{
    const sel = state.selectedMoods.has(m);
    return `<div class="mood-chip${sel?' selected':''}" data-mood="${m}" onclick="toggleMood('${m.replace(/'/g,"\\'")}',this)">${m}</div>`;
  }).join('');
}

function toggleMood(m, el){
  if(state.selectedMoods.has(m)) state.selectedMoods.delete(m);
  else state.selectedMoods.add(m);
  el.classList.toggle('selected');
}

function renderMC(){
  const c = $('mcContainer');
  const order = ['familiarity','hebrew','vocal','energy','era'];
  c.innerHTML = order.map(key=>{
    const q = window.SB_V2_MC[key];
    const opts = q.options.map(o=>{
      const sel = state.mc[key] === o.id;
      return `<div class="mc-option${sel?' selected':''}" data-key="${key}" data-id="${o.id}" onclick="selectMC('${key}',${o.id})">
        <div class="mc-checkbox"></div>
        <div class="mc-content">
          <div class="mc-label">${o.label}</div>
          <div class="mc-sub">${o.subtitle}</div>
        </div>
      </div>`;
    }).join('');
    return `<div class="mc-block">
      <h3>${q.icon} ${q.label}</h3>
      <div class="mc-options">${opts}</div>
    </div>`;
  }).join('');
}

function selectMC(key, id){
  state.mc[key] = id;
  document.querySelectorAll(`.mc-option[data-key="${key}"]`).forEach(el=>{
    el.classList.toggle('selected', Number(el.dataset.id) === id);
  });
}

/* ─────────── Screen 5: Refresh days ─────────── */
document.addEventListener('click', (e)=>{
  if(e.target.classList && e.target.classList.contains('refresh-pill')){
    document.querySelectorAll('.refresh-pill').forEach(p=>p.classList.remove('selected'));
    e.target.classList.add('selected');
    state.refreshDays = Number(e.target.dataset.days);
  }
});

/* ─────────── Screen 6: Generation pipeline ─────────── */
async function startGeneration(){
  state.hours.open = $('openTime').value || '09:00';
  state.hours.close = $('closeTime').value || '23:00';
  setStep(6);
  $('playlistLoading').style.display = 'block';
  $('playlistResult').style.display = 'none';

  // CRITICAL: Verify Spotify token before starting
  setLoadingStatus('בודק חיבור Spotify…','');
  const tok = await refreshSpotifyTokenIfNeeded();
  if(!tok){
    setLoadingStatus('Spotify לא מחובר','חזור למסך 2 ולחץ "התחברות עם Spotify"');
    showToast('נדרש חיבור Spotify לפני יצירת פלייליסט', true);
    setTimeout(()=>setStep(2), 1500);
    return;
  }

  try{
    const faders = window.SB_V2_mcToFaders(state.mc);
    const moods = Array.from(state.selectedMoods);

    setLoadingStatus('בונה פרופיל מוזיקלי…','');
    const candidates = await generateCandidates(faders, moods);

    setLoadingStatus('מאמת ב-Spotify…',`${candidates.length} שירים`);
    const validated = await validateOnSpotify(candidates);

    let final = validated.filter(t=>t.id);
    if(final.length < 45){
      setLoadingStatus('משלים ל-50 שירים…',`כרגע ${final.length}`);
      const filled = await fillUp(final, faders);
      final = filled;
    }

    if(final.length < 8){
      // Fallback: render whatever we have rather than failing
      setLoadingStatus('בעיה ביצירת פלייליסט','מעט שירים. נסה שוב או בדוק חיבור.');
      showToast('נמצאו רק '+final.length+' שירים. נסה שוב.', true);
    }

    state.generatedTracks = final.slice(0, 50);
    await saveAnalysis();
    renderPlaylist();
  } catch(e){
    console.error(e);
    setLoadingStatus('שגיאה',e.message||'נסה שוב');
    showToast('שגיאה: '+(e.message||'unknown'), true);
  }
}

function setLoadingStatus(step, detail){
  $('loadingStep').textContent = step;
  $('loadingDetail').textContent = detail || '';
}

async function generateCandidates(faders, moods){
  const fmDesc = describeFamiliarity(faders.familiarity);
  const heDesc = describeHebrew(faders.hebrew);
  const voDesc = describeVocal(faders.vocal);
  const enDesc = describeEnergy(faders.energy);
  const erDesc = describeEra(faders.era);

  const sys = `אתה רובין, מומחה ליצירת פלייליסטים מותאמי-עסק.
המטרה: לייצר 60 מועמדים אמיתיים מ-Spotify לפלייליסט עסקי.
חוקים קשיחים:
- כל שיר חייב להיות קיים באמת ב-Spotify, אמן ושם מדויקים.
- אל תמציא שירים. אם אתה לא בטוח באמן או בשם — אל תכלול אותו.
- שמור על הסגנונות והאווירות שביקש העסק.
${fmDesc}
${heDesc}
${voDesc}
${enDesc}
${erDesc}
החזר JSON: {"tracks":[{"artist":"...","title":"...","reason":"5 מילים בעברית"}]}`;

  const brainBlocks = state.brainContext.assembled ? assembleBrainBlocks() : '';

  const usr = `תיאור העסק: "${state.bizDesc}"
סוג: ${state.bizType||'עסק'}
אווירות נבחרות: ${moods.join(', ')||'(ברירת מחדל)'}
שעות פעילות: ${state.hours.open}-${state.hours.close}
${state.refPlaylist?'פלייליסט ייחוס URL: '+state.refPlaylist:''}

${brainBlocks}

צור 60 מועמדים מגוונים שמתאימים לכל החוקים והמידע למעלה.
אם ניתנו DNA / קוהורט / ארכיון — שלב את כולם לאיזון מדויק שמתאים לעסק הזה.`;

  const raw = await callOpenAI([
    {role:'system', content:sys},
    {role:'user', content:usr},
  ], {model:'gpt-4o', max_tokens:6000, temperature:0.7});
  const parsed = safeJSON(raw);
  const tracks = (parsed.tracks||[]).filter(t=>t.artist && t.title);
  return tracks.slice(0, 60);
}

async function validateOnSpotify(candidates){
  const out = [];
  for(let i=0; i<candidates.length; i+=8){
    const batch = candidates.slice(i, i+8);
    setLoadingStatus('מאמת ב-Spotify…',`${i+batch.length}/${candidates.length}`);
    const results = await Promise.allSettled(
      batch.map(t=>spotifySearch(t.artist, t.title))
    );
    results.forEach((r, ri)=>{
      const orig = batch[ri];
      if(r.status==='fulfilled' && r.value){
        const sp = r.value;
        out.push({
          artist: sp.artists.map(a=>a.name).join(', '),
          title: sp.name,
          id: sp.id,
          url: sp.external_urls && sp.external_urls.spotify,
          cover: sp.album && sp.album.images && sp.album.images.length ? sp.album.images[sp.album.images.length-1].url : '',
          preview: sp.preview_url||'',
          popularity: sp.popularity||0,
          duration: sp.duration_ms||0,
          reason: orig.reason||'',
        });
      } else {
        out.push({ artist: orig.artist, title: orig.title, reason: orig.reason||'' });
      }
    });
  }
  return out;
}

async function spotifySearch(artist, title){
  // Try /api/spotify proxy first (uses CC token, doesn't need user auth)
  try{
    const r = await fetch('/api/spotify', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({action:'search', query:`${artist} ${title}`, neutral:true})
    });
    if(r.ok){
      const j = await r.json();
      if(j.tracks && j.tracks.items && j.tracks.items.length){
        return j.tracks.items[0];
      }
    }
  } catch(e){}
  // Fallback to direct
  if(state.spotifyToken){
    try{
      const r = await fetch('https://api.spotify.com/v1/search?'+new URLSearchParams({
        q:`${artist} ${title}`, type:'track', limit:'1', market:'IL'
      }), {headers:{'Authorization':'Bearer '+state.spotifyToken}});
      if(r.ok){
        const j = await r.json();
        if(j.tracks && j.tracks.items && j.tracks.items.length) return j.tracks.items[0];
      }
    } catch(e){}
  }
  return null;
}

async function fillUp(existing, faders){
  // Mixed seeds: prefer L1 DNA top + L2 cohort top, fill remainder from existing
  const ctx = state.brainContext || {};
  let seeds = [];
  if(ctx.l1 && Array.isArray(ctx.l1.topTrackIds)) seeds.push(...ctx.l1.topTrackIds.slice(0,2));
  if(ctx.l2 && Array.isArray(ctx.l2.cohort_top_ids)) seeds.push(...ctx.l2.cohort_top_ids.slice(0,2));
  // Dedupe and fill from existing validated tracks
  seeds = Array.from(new Set(seeds.filter(Boolean)));
  const existingIds = existing.filter(t=>t.id).map(t=>t.id);
  for(const id of existingIds){
    if(seeds.length >= 5) break;
    if(!seeds.includes(id)) seeds.push(id);
  }
  seeds = seeds.slice(0, 5);
  if(!seeds.length) return existing;
  const need = 50 - existing.length;
  const params = {
    seed_tracks: seeds.join(','),
    limit: Math.min(100, need*4),
    market: 'IL',
  };
  // Apply MC-derived audio features
  if(faders.energy < 30){ params.target_energy = 0.25; params.max_energy = 0.45; }
  else if(faders.energy > 70){ params.target_energy = 0.8; params.min_energy = 0.6; }
  else { params.target_energy = faders.energy/100; }

  if(faders.vocal < 25){ params.min_instrumentalness = 0.5; }
  else if(faders.vocal > 75){ params.max_instrumentalness = 0.3; }

  if(faders.familiarity < 30){ params.max_popularity = 35; }
  else if(faders.familiarity > 70){ params.min_popularity = 55; }

  try{
    const qs = new URLSearchParams();
    Object.keys(params).forEach(k=>{
      if(params[k] !== undefined && params[k] !== null) qs.set(k, String(params[k]));
    });
    const recsUrl = 'https://api.spotify.com/v1/recommendations?' + qs.toString();
    const r = await fetch('/api/spotify', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({action:'fetch', url:recsUrl, neutral:true})
    });
    if(!r.ok) return existing;
    const j = await r.json();
    if(!j.tracks || !j.tracks.length) return existing;

    const known = new Set(existing.filter(t=>t.id).map(t=>t.id));
    const blockHebrew = faders.hebrew < 20;
    const blockIntl = faders.hebrew > 80;
    const out = existing.slice();
    for(const t of j.tracks){
      if(known.has(t.id)) continue;
      if(out.filter(x=>x.id).length >= 50) break;
      const isHe = /[\u0590-\u05FF]/.test(t.name + ' ' + t.artists.map(a=>a.name).join(' '));
      if(blockHebrew && isHe) continue;
      if(blockIntl && !isHe) continue;
      out.push({
        artist: t.artists.map(a=>a.name).join(', '),
        title: t.name,
        id: t.id,
        url: t.external_urls && t.external_urls.spotify,
        cover: t.album && t.album.images && t.album.images.length ? t.album.images[t.album.images.length-1].url : '',
        preview: t.preview_url||'',
        popularity: t.popularity||0,
        duration: t.duration_ms||0,
        reason: 'fill-up',
      });
      known.add(t.id);
    }
    return out;
  } catch(e){
    return existing;
  }
}

/* ─────────── OpenAI key management ─────────── */

// Fetch key from Supabase (cross-device), fallback to localStorage
async function getOpenAIKey(){
  try {
    const { data } = await sb.from('app_settings').select('value').eq('key','openai_key').single();
    if(data?.value) return data.value;
  } catch(e){}
  try { return localStorage.getItem('openai_key') || ''; } catch(e){ return ''; }
}

// Save key to Supabase (cross-device) + localStorage backup
async function saveOpenAIKey(value){
  try {
    const { error } = await sb.from('app_settings')
      .upsert({ key:'openai_key', value, updated_at:new Date().toISOString() }, { onConflict:'key' });
    if(error) throw error;
    try{ localStorage.setItem('openai_key', value); }catch(e){}
    return true;
  } catch(e){
    console.warn('saveOpenAIKey failed:', e);
    return false;
  }
}

/* ─────────── Settings modal ─────────── */
async function openSettingsModal(){
  const key = await getOpenAIKey();
  const inp = $('apiKeyInput'), st = $('keyStatus');
  if(key){
    inp.value = key;
    st.textContent = '✓ מפתח שמור';
    st.className = 'key-status ok';
  } else {
    inp.value = '';
    st.textContent = '';
    st.className = 'key-status';
  }
  $('settingsOverlay').classList.add('open');
  setTimeout(()=> inp.focus(), 120);
}

function closeSettingsModal(){
  $('settingsOverlay').classList.remove('open');
}

function overlayClick(e){
  if(e.target === $('settingsOverlay')) closeSettingsModal();
}

async function saveKeyAndClose(){
  const value = $('apiKeyInput').value.trim();
  const st = $('keyStatus'), btn = $('saveKeyBtn');
  if(!value){
    st.textContent = 'אנא הכנס מפתח תקין';
    st.className = 'key-status err';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'שומר…';
  const ok = await saveOpenAIKey(value);
  if(ok){
    st.textContent = '✓ נשמר בהצלחה!';
    st.className = 'key-status ok';
    setTimeout(()=>{ closeSettingsModal(); btn.disabled=false; btn.textContent='שמור מפתח'; }, 1200);
  } else {
    st.textContent = '⚠️ שגיאה בשמירה — בדוק חיבור';
    st.className = 'key-status err';
    btn.disabled = false;
    btn.textContent = 'שמור מפתח';
  }
}

/* ─────────── OpenAI proxy ─────────── */
async function callOpenAI(messages, opts){
  opts = opts || {};
  const body = {
    apiKey: await getOpenAIKey(), // Supabase → localStorage → server fallback
    model: opts.model || 'gpt-4o-mini',
    temperature: opts.temperature || 0.6,
    messages,
    max_tokens: opts.max_tokens || 2500,
    response_format: opts.noJson ? undefined : {type:'json_object'},
  };
  // Ensure JSON keyword
  const hasJ = messages.some(m=>(m.content||'').toLowerCase().includes('json'));
  if(!hasJ){
    messages.push({role:'system', content:'Return JSON only.'});
  }
  const r = await fetch('/api/openai', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  if(!r.ok){
    const txt = await r.text();
    throw new Error('OpenAI HTTP '+r.status+': '+txt.slice(0,200));
  }
  const j = await r.json();
  if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
  return j.choices[0].message.content;
}

function safeJSON(str){
  if(!str) return {};
  try { return JSON.parse(str); } catch {}
  // Try to extract JSON block
  const m = str.match(/\{[\s\S]*\}/);
  if(m){
    try { return JSON.parse(m[0]); } catch {}
  }
  return {};
}

/* ─────────── Fader description helpers ─────────── */
function describeFamiliarity(v){
  if(v >= 80) return '🎯 פופולריות: מיינסטרים — להיטים ידועים שכולם מזהים מהרדיו ומשמיעות גבוהות.';
  if(v >= 60) return '🎯 פופולריות: בעיקר ידוע, עם נגיעות פחות מוכרות.';
  if(v >= 40) return '🎯 פופולריות: מעורב — חצי ידוע חצי גילוי.';
  if(v >= 20) return '🎯 פופולריות: בעיקר נישה — מבחר עם טעם, פחות רדיו.';
  return '🎯 פופולריות: נישה עמוקה — אמני אנדרגראונד עם פחות מ-100K מאזינים חודשיים. ללא להיטים. גילויים בלבד.';
}
function describeHebrew(v){
  if(v >= 90) return '🇮🇱 שפה: עברית בלבד.';
  if(v >= 60) return '🇮🇱 שפה: רוב השירים בעברית, מעט בינלאומי.';
  if(v >= 40) return '🇮🇱 שפה: מאוזן עברית/אנגלית.';
  if(v >= 10) return '🇮🇱 שפה: בעיקר בינלאומי, מעט ישראלי.';
  return '🇮🇱 שפה: בינלאומי בלבד. ללא שירים בעברית.';
}
function describeVocal(v){
  if(v >= 80) return '🎙️ ווקאל: שירה דומיננטית — כל שיר עם שירה.';
  if(v >= 60) return '🎙️ ווקאל: בעיקר עם שירה.';
  if(v >= 40) return '🎙️ ווקאל: ערבוב בין שירה לאינסטרומנטלי.';
  if(v >= 20) return '🎙️ ווקאל: בעיקר אינסטרומנטלי, נגיעות ווקאליות.';
  return '🎙️ ווקאל: אינסטרומנטלי בלבד / אווירה — אסור שירה דומיננטית.';
}
function describeEnergy(v){
  if(v >= 80) return '⚡ אנרגיה: מסיבתי — קצב גבוה, אנרגיה רבה (energy 0.8+).';
  if(v >= 60) return '⚡ אנרגיה: תוסס — מלא חיים, עם קצב (energy 0.6-0.75).';
  if(v >= 40) return '⚡ אנרגיה: מאוזן (energy 0.45-0.6).';
  if(v >= 20) return '⚡ אנרגיה: נינוח (energy 0.3-0.45).';
  return '⚡ אנרגיה: רגוע ועדין — צ׳יל, אווירה (energy 0.15-0.3).';
}
function describeEra(v){
  if(v >= 80) return '📅 שנים: 3 שנים אחרונות בלבד.';
  if(v >= 60) return '📅 שנים: עכשווי, 2010 והלאה.';
  if(v >= 40) return '📅 שנים: מקלאסי לעכשווי, מגוון.';
  if(v >= 20) return '📅 שנים: שנות ה-90 ושנות ה-2000.';
  return '📅 שנים: רטרו וקלאסי — לפני 2000.';
}

/* ─────────── Render playlist ─────────── */
function renderPlaylist(){
  $('playlistLoading').style.display = 'none';
  $('playlistResult').style.display = 'block';
  $('playlistTitle').textContent = (state.bizType || 'הפלייליסט שלכם') + ' — Robin Mix';
  const validCount = state.generatedTracks.filter(t=>t.id).length;
  const totalDur = state.generatedTracks.reduce((s,t)=>s+(t.duration||0),0);
  const min = Math.round(totalDur/60000);
  $('playlistMeta').textContent = `${state.generatedTracks.length} שירים · ${validCount} מאומתים ב-Spotify · ${min} דקות`;

  const list = $('tracksList');
  list.innerHTML = state.generatedTracks.map((t,i)=>{
    const key = `${t.artist}|${t.title}`;
    const fb = state.feedback[key];
    const cover = t.cover ? `style="background-image:url('${t.cover}')"` : '';
    return `<div class="track-item">
      <div class="track-num">${i+1}</div>
      <div class="track-cover" ${cover}></div>
      <div class="track-meta">
        <div class="track-title">${escapeHtml(t.title)}</div>
        <div class="track-artist">${escapeHtml(t.artist)}</div>
      </div>
      <div class="track-vote">
        <button class="vote-btn up${fb==='up'?' active':''}" onclick="voteTrack('${escapeAttr(key)}','up',this)">👍</button>
        <button class="vote-btn down${fb==='down'?' active':''}" onclick="voteTrack('${escapeAttr(key)}','down',this)">👎</button>
      </div>
    </div>`;
  }).join('');
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function escapeAttr(s){
  return String(s||'').replace(/[\\'"<>&]/g, c=>'&#'+c.charCodeAt(0)+';');
}

async function voteTrack(key, vote, btn){
  state.feedback[key] = vote;
  // Update UI
  const parent = btn.parentElement;
  parent.querySelectorAll('.vote-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  // Persist to track_feedback (best effort)
  const [artist, title] = key.split('|');
  try{
    await sb.from('track_feedback').insert({
      track_artist: artist,
      track_title: title,
      feedback_type: vote,
      reason: 'v2-' + vote,
      biz_category: state.bizType || 'unknown',
      brain_version: 'v2-robin',
      faders: window.SB_V2_mcToFaders(state.mc),
      created_at: new Date().toISOString(),
    });
  } catch(e){ console.warn('Feedback save failed:', e); }
}

/* ─────────── Save to Spotify ─────────── */
async function saveToSpotify(){
  const tok = await refreshSpotifyTokenIfNeeded();
  if(!tok){
    showToast('נדרש חיבור Spotify', true);
    return;
  }
  if(!state.spotifyUser) await loadSpotifyUser();
  if(!state.spotifyUser){
    showToast('שגיאה בטעינת משתמש Spotify', true);
    return;
  }
  $('saveSpotifyBtn').disabled = true;
  $('saveSpotifyBtn').textContent = 'יוצר…';
  try{
    const trackIds = state.generatedTracks.filter(t=>t.id).map(t=>'spotify:track:'+t.id);
    if(!trackIds.length) throw new Error('אין שירים מאומתים');

    const playlistName = (state.bizType||'Robin Mix') + ' · Robin';
    const cr = await fetch(`https://api.spotify.com/v1/users/${state.spotifyUser.id}/playlists`, {
      method:'POST',
      headers:{'Authorization':'Bearer '+tok, 'Content-Type':'application/json'},
      body: JSON.stringify({name: playlistName, public:false, description:'Created by Robin · SonicBrands'}),
    });
    if(!cr.ok) throw new Error('יצירה נכשלה: ' + cr.status);
    const pl = await cr.json();
    // Add in chunks of 100
    for(let i=0; i<trackIds.length; i+=100){
      const chunk = trackIds.slice(i, i+100);
      await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/tracks`, {
        method:'POST',
        headers:{'Authorization':'Bearer '+tok, 'Content-Type':'application/json'},
        body: JSON.stringify({uris: chunk}),
      });
    }
    showToast('נשמר ב-Spotify ✓');
    if(pl.external_urls && pl.external_urls.spotify){
      window.open(pl.external_urls.spotify, '_blank');
    }
  } catch(e){
    showToast('שגיאה: '+e.message, true);
  } finally {
    $('saveSpotifyBtn').disabled = false;
    $('saveSpotifyBtn').textContent = '💾 שמור ב-Spotify';
  }
}

/* ─────────── Save analysis ─────────── */
async function saveAnalysis(){
  try{
    await sb.from('analyses').insert({
      user_name: state.spotifyUser ? state.spotifyUser.id : 'guest',
      description: state.bizDesc.slice(0,500),
      biz_category: state.bizType || 'general',
      brain_version: 'v2-robin',
      faders: JSON.stringify(window.SB_V2_mcToFaders(state.mc)),
      genres: JSON.stringify(Array.from(state.selectedMoods)),
      refs: JSON.stringify(state.refPlaylist ? [state.refPlaylist] : []),
      energy_curve: JSON.stringify({}),
      track_count: state.generatedTracks.length,
      tracks: JSON.stringify(state.generatedTracks.slice(0,60).map(t=>({
        artist:(t.artist||'').slice(0,100),
        title:(t.title||'').slice(0,100),
        id:t.id||'',
        reason:(t.reason||'').slice(0,200),
      }))),
      business_name: state.bizType || 'Robin User',
      brain_logs: JSON.stringify([
        {e:'🤖',t:'v2',d:'Robin v2 generation',time:new Date().toLocaleTimeString('he-IL')},
        {e:'🧬',t:'L1',d: state.brainContext.l1 ? ('DNA: '+(state.brainContext.l1.summary||'').slice(0,80)+' tracks='+state.brainContext.l1.trackCount) : 'no ref playlist'},
        {e:'📚',t:'L2',d: state.brainContext.l2 ? ('cohort='+state.brainContext.l2.cohort_size+(state.brainContext.l2.used_fallback?' (fallback general)':'')) : 'no cohort'},
        {e:'🏷️',t:'L3',d: state.brainContext.l3 ? ('archive='+state.brainContext.l3.archive_size) : 'no genre archive'},
        {e:'👍',t:'L4',d: state.brainContext.l4 ? ('feedback='+state.brainContext.l4.feedback_count) : 'no feedback'},
      ]),
      created_at: new Date().toISOString(),
    });
  } catch(e){ console.warn('saveAnalysis failed:', e); }
}

/* ─────────── Regenerate ─────────── */
async function regenerate(){
  await startGeneration();
}

/* ─────────── Boot ─────────── */
(async function boot(){
  // Try to recover Spotify session
  await refreshSpotifyTokenIfNeeded();
  if(state.spotifyToken){
    await loadSpotifyUser();
  }
  // Handle Spotify callback if present
  if(new URLSearchParams(location.search).get('code')){
    await handleSpotifyCallback();
  }
})();
