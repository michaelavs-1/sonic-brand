/* SonicBrand v3 — Robin
   Clean 6-screen flow with MC-based fader inputs.
   Pipeline: GPT-4o picks 60 → Spotify validation → Fill-up if <45 → Render.
   v3 Auth: Bulletproof SSO with automatic scope re-auth, no fake users. */

const SUPABASE_URL = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';
const SPOTIFY_CLIENT_ID = 'b6404b5ae1684143b79d9a86bb4b6cba';
const SPOTIFY_SCOPES = 'playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative user-read-private user-read-email';
const SPOTIFY_REDIRECT = location.origin + location.pathname; // /v3 path
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

/* ─────────── State ─────────── */
const state = {
  step: 1,
  totalSteps: 6,
  energyLevel: null,  // 1=low, 2=high
  useDataBox: true,   // toggle L0 Data Box on/off for A/B testing
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
  selectedModel: 'gpt-5.4', // fixed model
  spotifyToken: null,
  spotifyUser: null,
  generatedTracks: [],
  regenCount: 0,
  userPlaylists: [],          // loaded from /v1/me/playlists
  selectedUserPlaylists: [],  // IDs the user picked (max 3)       // how many times "צרו שוב" was pressed
  feedback: {}, // trackKey -> 'up' | 'down'
  brainContext: {
    l0: null, // Data Box — SonicBrands knowledge base (Michael's spreadsheet)
    l1: null, // Reference Playlist DNA
    l2: null, // Historical Cohort Memory
    l3: null, // Genre-Tag Priors
    l4: null, // Feedback Reranker
    assembled: false,
  },
  _scopeFixed: false,
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
/* ─── Hard refresh — bypasses all browser cache ─── */
function hardRefresh(){
  // Remove ?v= or ?refresh= params from current URL, add fresh timestamp
  const base = window.location.origin + window.location.pathname;
  window.location.replace(base + '?refresh=' + Date.now());
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

/* ─────────── Spotify playlist picker (screen 3) ─────────── */
async function fetchUserPlaylists(){
  const tok = await refreshSpotifyTokenIfNeeded();
  if(!tok) return [];
  try{
    const r = await fetch('https://api.spotify.com/v1/me/playlists?limit=50&offset=0', {
      headers:{'Authorization':'Bearer '+tok}
    });
    if(r.status === 403 || r.status === 401){
      return 'needs-reauth';
    }
    if(!r.ok) return [];
    const j = await r.json();
    return (j.items||[]).filter(p=>p&&p.id&&p.name);
  }catch(e){
    console.warn('[playlists]', e);
    return [];
  }
}

function renderPlaylistPicker(playlists){
  const grid = $('playlistPickerGrid');
  if(!grid) return;
  if(!playlists.length){
    grid.innerHTML = `<div class="pl-loading">
      אין פלייליסטים בחשבון — אפשר להמשיך ללא בחירה 👍
    </div>`;
    return;
  }
  grid.innerHTML = playlists.map(p=>{
    const img = p.images&&p.images[0] ? p.images[0].url : '';
    const sel = state.selectedUserPlaylists.includes(p.id);
    return `<div class="pl-card${sel?' selected':''}" onclick="toggleUserPlaylist('${escapeAttr(p.id)}')" data-id="${escapeAttr(p.id)}">
      <div class="pl-cover"${img?` style="background-image:url('${img}')"`:''}></div>
      <div class="pl-name">${escapeHtml(p.name)}</div>
      ${sel?'<div class="pl-check">✓</div>':''}
    </div>`;
  }).join('');
}

function toggleUserPlaylist(id){
  const idx = state.selectedUserPlaylists.indexOf(id);
  if(idx >= 0){
    state.selectedUserPlaylists.splice(idx,1);
  } else {
    if(state.selectedUserPlaylists.length >= 3){
      showToast('ניתן לבחור עד 3 פלייליסטים', true);
      return;
    }
    state.selectedUserPlaylists.push(id);
  }
  // Refresh only the clicked card + counter (avoid full re-render)
  document.querySelectorAll('.pl-card').forEach(card=>{
    const isSel = state.selectedUserPlaylists.includes(card.dataset.id);
    card.classList.toggle('selected', isSel);
    let chk = card.querySelector('.pl-check');
    if(isSel && !chk){
      chk = document.createElement('div');
      chk.className='pl-check'; chk.textContent='✓';
      card.appendChild(chk);
    } else if(!isSel && chk){
      chk.remove();
    }
  });
  const cnt = $('plPickerCount');
  if(cnt) cnt.textContent = state.selectedUserPlaylists.length
    ? `${state.selectedUserPlaylists.length}/3 נבחרו`
    : '';
}

/* ─────────── Multi-playlist L1 DNA ─────────── */
async function fetchMultiL1_DNA(playlistIds){
  if(!playlistIds.length) return null;
  const results = await Promise.allSettled(
    playlistIds.map(id=>fetchL1_DNA('https://open.spotify.com/playlist/'+id))
  );
  const dnas = results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
  if(!dnas.length) return null;
  if(dnas.length===1) return dnas[0];

  // Merge: combine artists, track IDs, vibe keywords; average audio stats
  const topArtists = [...new Set(dnas.flatMap(d=>d.topArtists||[]))].slice(0,8);
  const topTrackIds = [...new Set(dnas.flatMap(d=>d.topTrackIds||[]))].slice(0,5);
  const vibeKeywords = [...new Set(dnas.flatMap(d=>d.vibeKeywords||[]))].slice(0,6);
  const topTracksDisplay = dnas.flatMap(d=>d.topTracksDisplay||[]).slice(0,5);

  // Average audio stats across all playlists
  const statsKeys = ['energy','valence','dance','tempo','instr','hebrewRatio'];
  const audioStats = {};
  statsKeys.forEach(k=>{
    const vals = dnas.map(d=>d.audioStats?.[k]).filter(v=>v!=null);
    if(vals.length) audioStats[k] = vals.reduce((s,v)=>s+v,0)/vals.length;
  });

  return {
    summary: `${dnas.length} פלייליסטים נבחרו`,
    topArtists, topTrackIds, vibeKeywords, topTracksDisplay,
    audioStats: Object.keys(audioStats).length ? audioStats : null,
    faderHints: dnas[0].faderHints,
    trackCount: dnas.reduce((s,d)=>s+(d.trackCount||0),0),
  };
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
  if(n === 5) renderEnergyScreen();
  if(n === 2) updateScreen2UI();
  // Load user playlists when entering screen 3
  if(n === 3){
    // Use localStorage as fallback if state.spotifyToken not yet set by background refresh
    const hasAccess = state.spotifyToken || localStorage.getItem('sp3_access');
    if(!hasAccess){
      const grid = $('playlistPickerGrid');
      if(grid) grid.innerHTML = '<div class="pl-loading">יש להתחבר לSpotify כדי לבחור פלייליסטים</div>';
    } else if(state.userPlaylists.length){
      renderPlaylistPicker(state.userPlaylists);
    } else {
      const grid = $('playlistPickerGrid');
      if(grid) grid.innerHTML = '<div class="pl-loading">טוען פלייליסטים…</div>';
      fetchUserPlaylists().then(result=>{
        // Never re-auth from here — would cause infinite loop
        state.userPlaylists = Array.isArray(result) ? result : [];
        renderPlaylistPicker(state.userPlaylists);
      });
    }
  }
}
function goNext(){ if(state.step < state.totalSteps) setStep(state.step+1); }
function goBack(){ if(state.step > 1) setStep(state.step-1); }

/* ─────────── Info tooltip ─────────── */
function toggleInfoTip(e){
  e.stopPropagation();
  $('infoTip').classList.toggle('show');
}
document.addEventListener('click', ()=>$('infoTip').classList.remove('show'));

/* ═══════════════════════════════════════════
   SPOTIFY SSO v3 — BULLETPROOF IMPLEMENTATION

   Principles:
   1. show_dialog:true ALWAYS → user always picks their own account
   2. Verifier stored in 3 places → survives cross-browser auth
   3. After token exchange → validate scopes via /v1/me
   4. If 403 on /v1/me → auto re-auth once (loop prevention via flag)
   5. No fake fallback users
   6. Single spotifyShowUser() for all UI
═══════════════════════════════════════════ */

const SP_KEYS = ['sp3_access','sp3_refresh','sp3_expiry','sp3_verifier','sp3_user','sb_v3_state','spotify_id'];

function spotifyClearAll(){
  SP_KEYS.forEach(k=>{
    localStorage.removeItem(k);
    try{ sessionStorage.removeItem(k); }catch(e){}
  });
  document.cookie = 'sp_verifier=; path=/; max-age=0; SameSite=Lax';
  state.spotifyToken = null;
  state.spotifyUser  = null;
  state.userPlaylists = [];
  state.selectedUserPlaylists = [];
  state._scopeFixed = false;
}

function spotifyShowUser(user){
  const name = (user && (user.display_name || user.id)) || null;
  const img  = user?.images?.[0]?.url || '';
  ['spotifyBadgeName','spotifyStripName','s3AccountName'].forEach(id=>{
    const el=$(id); if(el) el.textContent = name||'';
  });
  ['spotifyBadgeImg','spotifyStripImg','s3AccountImg'].forEach(id=>{
    const el=$(id); if(!el) return;
    if(img){ el.src=img; el.style.display='block'; }
    else { el.style.display='none'; }
  });
  const show = !!name;
  const elMap = {spotifyBadge:'block', spotifyStrip:'flex', s3AccountLine:'flex'};
  Object.entries(elMap).forEach(([id,d])=>{ const el=$(id); if(el) el.style.display = show?d:'none'; });
  if(state.step===2) updateScreen2UI();
}

function updateScreen2UI(){
  const has=$('s2HasSession'), no=$('s2NoSession');
  if(!has||!no) return;
  const user=state.spotifyUser;
  if(user){
    const name=user.display_name||user.id||'';
    const img=user.images?.[0]?.url||'';
    const n=$('s2Name'),av=$('s2Avatar');
    if(n) n.textContent=name;
    if(av){ if(img){av.src=img;av.style.display='block';}else{av.style.display='none';} }
    has.style.display='block'; no.style.display='none';
  } else {
    has.style.display='none'; no.style.display='block';
  }
}

function continueWithSession(){ setStep(3); }

function switchSpotifyAccount(){
  spotifyClearAll(); spotifyShowUser(null); updateScreen2UI();
  spotifyLogin();
}

function disconnectSpotify(){
  spotifyClearAll(); spotifyShowUser(null); updateScreen2UI();
  closeSettingsModal(); setStep(2); showToast('Spotify נותק');
}

// Legacy aliases
function _clearAll(){ spotifyClearAll(); }
function renderSpotifyBadge(){ spotifyShowUser(state.spotifyUser); }
function clearSpotifyBadge(){ spotifyShowUser(null); }

/* ─── Connect: PKCE with 3-storage verifier ─── */
async function spotifyLogin(){
  const verifier = genRandomString(64);
  const challenge = base64url(await sha256(verifier));
  // 3-storage: localStorage + sessionStorage + cookie
  localStorage.setItem('sp3_verifier', verifier);
  try{ sessionStorage.setItem('sp_verifier', verifier); }catch(e){}
  document.cookie = `sp_verifier=${verifier}; path=/; max-age=600; SameSite=Lax`;

  window.location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: genRandomString(16),
    show_dialog: 'true', // SSO: always show account picker
  }).toString();
}

/* ─── Callback: exchange + validate ─── */
async function handleSpotifyCallback(){
  const code = new URLSearchParams(window.location.search).get('code');
  if(!code) return false;
  history.replaceState(null,'',location.pathname);

  const verifier =
    localStorage.getItem('sp3_verifier') ||
    (()=>{ try{return sessionStorage.getItem('sp_verifier');}catch(e){return null;} })() ||
    (document.cookie.match(/(?:^|;\s*)sp_verifier=([^;]*)/) || [])[1] || null;

  // Clean up verifier
  ['sp_verifier'].forEach(k=>{ localStorage.removeItem(k); try{sessionStorage.removeItem(k);}catch(e){} });
  document.cookie = 'sp_verifier=; path=/; max-age=0; SameSite=Lax';

  if(!verifier){
    showToast('שגיאת חיבור — נסה שוב', true); setStep(2); return false;
  }

  try{
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ grant_type:'authorization_code', code,
        redirect_uri:SPOTIFY_REDIRECT, client_id:SPOTIFY_CLIENT_ID, code_verifier:verifier })
    });
    const tokens = await r.json();
    if(tokens.error) throw new Error(tokens.error_description||tokens.error);

    localStorage.setItem('sp3_access', tokens.access_token);
    localStorage.setItem('sp3_refresh', tokens.refresh_token);
    localStorage.setItem('sp3_expiry', String(Date.now()+tokens.expires_in*1000));
    state.spotifyToken = tokens.access_token;

    // Check granted scopes — iOS Spotify app sometimes auto-approves with old scopes
    const grantedScope = tokens.scope || '';
    const missingScopes = [
      'user-read-private',
      'playlist-read-private',
      'playlist-modify-public',
      'playlist-modify-private'
    ].filter(s => !grantedScope.includes(s));

    if(missingScopes.length > 0){
      // iOS Spotify native app bypasses show_dialog and returns old scopes.
      // Auto-retry doesn't work — must show user explicit instructions to revoke access.
      spotifyClearAll();
      showScopeFixScreen();
      return false;
    }

    // Load user profile — wait for it
    await loadSpotifyUser();
    // Ensure badge shows something even if profile load failed
    if(!state.spotifyUser || state.spotifyUser._pending){
      state.spotifyUser = { display_name: null, id: null, images: [] };
      spotifyShowUser({ display_name: '✓ Spotify', id: null, images: [] });
    }

    const name = state.spotifyUser?.display_name || state.spotifyUser?.id || '';
    showToast(name ? `✓ מחובר כ: ${name}` : '✓ מחובר ל-Spotify');
    setStep(3);
    return true;
  } catch(err){
    showToast('שגיאת Spotify: '+(err.message||'נסה שוב'), true);
    setStep(2); return false;
  }
}

/* ─── Refresh token ─── */
async function refreshSpotifyTokenIfNeeded(){
  const exp=Number(localStorage.getItem('sp3_expiry')||0);
  if(exp>Date.now()+30000){ state.spotifyToken=localStorage.getItem('sp3_access'); return state.spotifyToken; }
  const rt=localStorage.getItem('sp3_refresh');
  if(!rt) return null;
  try{
    const r=await fetch('https://accounts.spotify.com/api/token',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:SPOTIFY_CLIENT_ID})
    });
    const j=await r.json();
    if(j.error) throw new Error(j.error);
    localStorage.setItem('sp3_access',j.access_token);
    if(j.refresh_token) localStorage.setItem('sp3_refresh',j.refresh_token);
    localStorage.setItem('sp3_expiry',String(Date.now()+j.expires_in*1000));
    state.spotifyToken=j.access_token;
    return j.access_token;
  }catch(e){ return null; }
}

/* ─── Load user profile from Spotify ─── */
async function loadSpotifyUser(){
  if(!state.spotifyToken) return;
  try{
    const r=await fetch('https://api.spotify.com/v1/me',{
      headers:{'Authorization':'Bearer '+state.spotifyToken}
    });
    if(r.ok){
      const user = await r.json();
      state.spotifyUser = user; // clear _pending flag
      try{localStorage.setItem('sp3_user',JSON.stringify(user));}catch(e){}
      spotifyShowUser(user);
    }
    // On any error: badge stays with "✓ Spotify" fallback already shown
  }catch(e){}
}

/* ─── Scope fix screen — shown when iOS bypasses show_dialog ─── */
function showScopeFixScreen(){
  // Show screen 2 with clear revoke instructions
  const has = $('s2HasSession'), no = $('s2NoSession');
  if(has) has.style.display = 'none';
  if(no)  no.style.display  = 'none';

  let fix = $('s2ScopeFix');
  if(!fix){
    fix = document.createElement('div');
    fix.id = 's2ScopeFix';
    const card = document.querySelector('[data-screen="2"] .screen-card');
    if(card) card.insertBefore(fix, card.firstChild);
  }
  fix.innerHTML = `
    <div style="text-align:center;padding:10px 0 20px">
      <div style="font-size:36px;margin-bottom:14px">⚠️</div>
      <h3 style="margin-bottom:8px;font-size:18px">צריך לחבר מחדש ל-Spotify</h3>
      <p style="color:var(--muted);font-size:14px;margin-bottom:22px;line-height:1.65">
        אפליקציית Spotify שמרה הרשאות ישנות.<br>
        יש להסיר אותן ולחבר מחדש — פעם אחת בלבד.
      </p>
      <div style="background:var(--bg-2);border-radius:12px;padding:16px 18px;text-align:right;margin-bottom:22px;border:1px solid var(--border-2)">
        <p style="font-weight:800;margin-bottom:10px;font-size:14px">🔧 שלבים (נדרשת פעולה אחת):</p>
        <p style="color:var(--muted);font-size:13px;line-height:2">
          1️⃣ פתח <strong>Spotify</strong> באייפון<br>
          2️⃣ הגדרות (⚙️) ← <strong>פרטיות ואבטחה</strong> ← <strong>אפליקציות</strong><br>
          3️⃣ מצא <strong>sonic-brand</strong> ← <strong>הסר גישה</strong><br>
          4️⃣ חזור לכאן ← לחץ "התחבר מחדש"
        </p>
        <p style="color:var(--muted);font-size:12px;margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
          לחלופין: <a href="https://www.spotify.com/account/apps" target="_blank" style="color:var(--accent)">spotify.com/account/apps →</a>
        </p>
      </div>
      <button onclick="spotifyClearAll();spotifyLogin()" class="btn btn-primary btn-block" style="margin-bottom:10px">
        ✅ הסרתי גישה — התחבר מחדש
      </button>
    </div>`;
  fix.style.display = 'block';
  setStep(2);
}

/* ─── Account menu ─── */
function toggleAccountMenu(e){
  e.stopPropagation();
  const m=$('accountMenu');
  if(m) m.style.display=m.style.display!=='none'?'none':'block';
}
function closeAccountMenu(){ const m=$('accountMenu');if(m)m.style.display='none'; }
document.addEventListener('click',closeAccountMenu);

/* ═══════════════════════════════════════════════════════════════
   ROBIN BRAIN — Layered Context (L1-L4)
   L1: Reference Playlist DNA (single URL)
   L2: Historical Cohort Memory (analyses by biz_category)
   L3: Genre-Tag Priors (analyses with matching genres)
   L4: Feedback Reranker (track_feedback by biz_category)
   ═══════════════════════════════════════════════════════════════ */

async function buildBrainContext(){
  state.brainContext.assembled = false;

  // L0 — match Data Box entry (synchronous keyword match)
  // L0 can be disabled for A/B testing — toggle via the 📋 button in brand bar
  const l0Match = state.useDataBox
    ? ((window.SB_matchDataBox && window.SB_matchDataBox(state.bizDesc)) || null)
    : null;

  // Pure AI mode: skip L0/L2/L3/L4 — only L1 (user's own ref playlist) may run
  const pureAI = !state.useDataBox;

  const [l0Res, l1Res, l2Res, l3Res, l4Res] = await Promise.allSettled([
    l0Match ? fetchL0_DNA(l0Match, state.selectedMoods) : Promise.resolve(null),
    // L1: user-picked playlists (visual picker) → multi-DNA merge
    //     fallback: manual ref playlist URL → single DNA
    state.selectedUserPlaylists.length > 0
      ? fetchMultiL1_DNA(state.selectedUserPlaylists)
      : (state.refPlaylist ? fetchL1_DNA(state.refPlaylist) : Promise.resolve(null)),
    pureAI ? Promise.resolve(null) : fetchL2_Cohort(state.bizType),
    pureAI ? Promise.resolve(null) : fetchL3_GenreArchive(Array.from(state.selectedMoods)),
    pureAI ? Promise.resolve(null) : fetchL4_Feedback(state.bizType),
  ]);

  const l0DNA = l0Res.status==='fulfilled' ? l0Res.value : null;
  state.brainContext.l0 = l0Match ? { ...l0Match, dna: l0DNA } : null;
  state.brainContext.l1 = l1Res.status==='fulfilled' ? l1Res.value : null;
  state.brainContext.l2 = l2Res.status==='fulfilled' ? l2Res.value : null;
  state.brainContext.l3 = l3Res.status==='fulfilled' ? l3Res.value : null;
  state.brainContext.l4 = l4Res.status==='fulfilled' ? l4Res.value : null;
  state.brainContext.assembled = true;
  console.log('[brain]', {
    l0: state.brainContext.l0 ? `databox(${state.brainContext.l0.label}, artists=${l0DNA ? l0DNA.topArtists.length : 0})` : '-',
    l1: state.brainContext.l1 ? 'DNA('+state.brainContext.l1.trackCount+')' : '-',
    l2: state.brainContext.l2 ? 'cohort('+state.brainContext.l2.cohort_size+')' : '-',
    l3: state.brainContext.l3 ? 'archive('+state.brainContext.l3.archive_size+')' : '-',
    l4: state.brainContext.l4 ? 'feedback('+state.brainContext.l4.feedback_count+')' : '-',
  });
}

/* ─── L0: Data Box Playlist DNA — mood-filtered playlists, extracts artists + seeds ─── */
async function fetchL0_DNA(entry, selectedMoods){
  // Get playlists from entry — new format {playlists:[{id,moods}]} or legacy {playlistIds:[]}
  let allPlaylists = [];
  if(Array.isArray(entry.playlists)){
    allPlaylists = entry.playlists;
  } else if(Array.isArray(entry.playlistIds)){
    allPlaylists = entry.playlistIds.map(id=>({id, moods:[]}));
  }
  if(!allPlaylists.length) return null;

  // Filter by selected moods if available (use playlists that match ANY selected mood)
  let chosen = allPlaylists;
  if(selectedMoods && selectedMoods.size > 0){
    const matched = allPlaylists.filter(p=>Array.isArray(p.moods) && p.moods.some(m=>selectedMoods.has(m)));
    if(matched.length >= 2) chosen = matched;  // only filter if we have enough
  }
  const playlistIds = chosen.map(p=>p.id || p).filter(Boolean);
  if(!playlistIds.length) return null;

  const tok = await refreshSpotifyTokenIfNeeded();
  if(!tok) return null;

  // Sample up to 3 playlists from the Data Box entry
  // Shuffle playlist order every run → different playlists sampled → different DNA
  const shuffledPids = playlistIds.slice().sort(()=>Math.random()-0.5);
  const samplePids = shuffledPids.slice(0, 3);
  const allTracks = [];

  await Promise.allSettled(samplePids.map(async pid => {
    try{
      const r = await fetch(
        `https://api.spotify.com/v1/playlists/${pid}/tracks?fields=items(track(id,name,artists(id,name),popularity,album(release_date)))&limit=30`,
        {headers:{'Authorization':'Bearer '+tok}}
      );
      if(!r.ok) return;
      const j = await r.json();
      const tracks = (j.items||[]).map(it=>it.track).filter(t=>t&&t.id);
      allTracks.push(...tracks);
    } catch(e){}
  }));

  if(allTracks.length < 5) return null;

  // Deduplicate by track ID
  const seen = new Set();
  const unique = allTracks.filter(t=>{ if(seen.has(t.id)) return false; seen.add(t.id); return true; });

  // Sort by popularity, take top 50
  const top50 = unique.sort((a,b)=>(b.popularity||0)-(a.popularity||0)).slice(0,50);

  // Fetch audio features for DNA analysis
  let audioStats = null;
  try{
    const afRes = await fetch(
      `https://api.spotify.com/v1/audio-features?ids=${top50.slice(0,50).map(t=>t.id).join(',')}`,
      {headers:{'Authorization':'Bearer '+tok}}
    );
    if(afRes.ok){
      const afJson = await afRes.json();
      const features = (afJson.audio_features||[]).filter(f=>f);
      if(features.length) audioStats = analyzeAudioStats(features, top50);
    }
  } catch(e){}

  // Count artist appearances across playlists
  const artistCount = {};
  unique.forEach(t=>(t.artists||[]).forEach(a=>{
    artistCount[a.name] = (artistCount[a.name]||0) + 1;
  }));
  const sorted = Object.entries(artistCount).sort((a,b)=>b[1]-a[1]);
  // topArtists: the mega-famous ones — define the STYLE but GPT must NOT copy them
  const topArtists = sorted.slice(0,6).map(([name])=>name);
  // nicheArtists: appear only 1x — less obvious, what GPT SHOULD pick from
  const nicheArtists = sorted.filter(([,c])=>c===1)
    .sort(()=>Math.random()-0.5).slice(0,12).map(([name])=>name);

  // Random seeds per run: shuffle full pool, pick diverse tiers
  const rnd = unique.slice().sort(()=>Math.random()-0.5);
  const diverseSeeds = [
    ...rnd.filter(t=>(t.popularity||0)>=60).slice(0,1).map(t=>t.id),
    ...rnd.filter(t=>(t.popularity||0)>=30&&(t.popularity||0)<60).slice(0,2).map(t=>t.id),
    ...rnd.filter(t=>(t.popularity||0)<30).slice(0,2).map(t=>t.id),
  ].filter(Boolean).slice(0,5);

  // Full shuffled pool — fillUp picks random seeds each regen
  const allTrackIds = unique.slice().sort(()=>Math.random()-0.5).map(t=>t.id).filter(Boolean);

  // Direct inclusions: up to 9 actual tracks from the Data Box playlists (30% of 30)
  // Pick randomly from mid+niche popularity to avoid always same mega-hits
  const directPool = unique
    .filter(t=>t.id && (t.popularity||0) >= 15 && (t.popularity||0) <= 72)
    .sort(()=>Math.random()-0.5);
  const directTracks = directPool.slice(0, 9).map(t=>({
    artist: (t.artists||[]).map(a=>a.name).join(', '),
    title:  t.name||'',
    id:     t.id,
    cover:  (t.album&&t.album.images&&t.album.images.length) ? t.album.images[t.album.images.length-1].url : '',
    popularity: t.popularity||0,
    duration: t.duration_ms||0,
    preview: '',
    url: '',
    reason: 'data-box',
  }));

  return { topTrackIds: diverseSeeds, allTrackIds, topArtists, nicheArtists, audioStats,
           trackCount: unique.length, playlistCount: samplePids.length, directTracks };
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
  const raw = await callOpenAI([{role:'system',content:sys},{role:'user',content:usr}], {model:getMiniModel(), max_tokens:300, temperature:0.5});
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

  // L0 — Data Box: HARD GENRE RULES — mandatory, overrides all other suggestions
  if(ctx.l0){
    const lines = ['[L0 — DATA BOX: כלל ברזל — חובה לציית]'];
    lines.push(`סוג עסק: ${ctx.l0.label}`);
    lines.push(`✅ ז'אנרים מותרים בלבד: ${ctx.l0.genres}`);
    lines.push(`❌ אסור לחלוטין: פופ ישראלי מיינסטרים, מזרחית, שירים ידועים מהרדיו הישראלי, Hip Hop מסחרי, EDM — אלא אם הם מופיעים מפורשות ברשימת המותרים לעיל`);
    if(ctx.l0.dna){
      if(ctx.l0.dna.topArtists && ctx.l0.dna.topArtists.length){
        lines.push(`🚫 אמנים שמופיעים יתר על המידה בז'אנר (אסור לבחור אותם — כבר ידועים מדי): ${ctx.l0.dna.topArtists.join(', ')}`);
      }
      if(ctx.l0.dna.nicheArtists && ctx.l0.dna.nicheArtists.length){
        lines.push(`✨ אמנים פחות ידועים מאותו עולם (העדיפו לבחור מתוך אלו ודומים להם): ${ctx.l0.dna.nicheArtists.join(', ')}`);
      } else {
        lines.push(`→ מצא אמנים פחות ידועים מאותו עולם מוזיקלי — לא הכוכבים הגדולים.`);
      }
    }
    if(ctx.l0.dna && ctx.l0.dna.audioStats){
      const st = ctx.l0.dna.audioStats;
      lines.push(`🎚️ אנרגיה=${st.energy.toFixed(2)}, טמפו≈${Math.round(st.tempo)} BPM`);
    }
    lines.push(`🎯 מטרת המוזיקה: ${ctx.l0.purpose}`);
    lines.push(`⚠️ L0 הוא הכלל העליון — שאר השכבות (L1-L4) משלימות ומדייקות, לא עוקפות.`);
    blocks.push(lines.join('\n'));
  }

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

/* ─── Banner rendering on Screen 4 — L0-L4 ─── */
function renderBrainBanner(){
  const ctx = state.brainContext;
  const el = document.getElementById('brainBanner');
  if(!el) return;
  if(!ctx.l0 && !ctx.l1 && !ctx.l2 && !ctx.l3 && !ctx.l4) {
    el.style.display = 'none';
    return;
  }
  const parts = [];
  if(ctx.l0){
    const dnaInfo = ctx.l0.dna
      ? ` · נותח ${ctx.l0.dna.trackCount} שירים · אמנים: ${ctx.l0.dna.topArtists.slice(0,4).map(escapeHtml).join(', ')}`
      : '';
    parts.push(`📋 <strong>Data Box:</strong> ${escapeHtml(ctx.l0.label)}${dnaInfo}`);
  }
  if(ctx.l1 && ctx.l1.summary){
    const l1Label = state.selectedUserPlaylists.length > 1
      ? `${state.selectedUserPlaylists.length} פלייליסטים שנבחרו`
      : 'פלייליסט שלך';
    parts.push(`🧬 <strong>${l1Label}:</strong> ${escapeHtml(ctx.l1.summary)}`);
  }
  if(ctx.l2 && ctx.l2.cohort_size >= 3) parts.push(`📚 <strong>Robin זוכרת:</strong> ${ctx.l2.cohort_size} פלייליסטים${ctx.l2.used_fallback?' (כולל general)':''}`);
  if(ctx.l3 && ctx.l3.archive_size >= 1) parts.push(`🏷️ <strong>ארכיון ז'אנרים:</strong> ${ctx.l3.archive_size} רשומות`);
  if(ctx.l4 && ctx.l4.feedback_count > 0) parts.push(`👍 <strong>משוב:</strong> ${ctx.l4.feedback_count} הצבעות`);
  if(!parts.length){ el.style.display = 'none'; return; }
  el.innerHTML = parts.join(' · ');
  el.style.display = 'block';
}

/* ─────────── Screen 3: Business info — analyze in background, then jump to 4 ─────────── */
async function submitBizInfo(){
  const desc = $('bizDesc').value.trim();
  if(desc.length < 8){
    showToast('כתבו לפחות כמה מילים על העסק', true);
    return;
  }
  state.bizDesc = desc;
  state.refPlaylist = $('refPlaylist').value.trim();

  // Show loading state on the button — stay on screen 3 while analyzing
  const btn = document.querySelector('[data-screen="3"] .btn-primary');
  if(btn){ btn.disabled = true; btn.textContent = 'מנתח את העסק…'; }

  try{
    // Run detection + brain context in parallel, completely in the background
    await detectBusinessType();
    await buildBrainContext();

    // Apply L0/L1 hints before rendering
    if(state.brainContext.l1){
      if(state.brainContext.l1.faderHints) applyFaderHints(state.brainContext.l1.faderHints);
      if(state.brainContext.l1.vibeKeywords) state.brainContext.l1.vibeKeywords.forEach(k=>state.selectedMoods.add(k));
    }

    // Everything ready — now transition
    renderMoods();
    renderMC();
    renderBrainBanner();
    setStep(4);
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = 'המשך ←'; }
  }
}

async function detectBusinessType(){
  $('bizTypeName').textContent = 'מנתח...';
  $('bizFunc').textContent = '— טוען המלצות…';

  try{
    const sys = 'אתה רובין, מומחה אווירה מוזיקלית לעסקים. בהינתן תיאור עסק, החזר JSON: {"biz_type":"סוג העסק — 1-3 מילים בעברית (לדוגמה: בר יין, מסעדת שף, בית קפה שכונתי)","music_function":"משפט אחד, חכם וישיר (עד 18 מילים), שמסביר מה תפקיד המוזיקה בעסק הזה ספציפית. ללא פתיח כמו מניסיוני או סוגי עסקים. רק משפט אחד שנוגע בלב העסק.","recommended_moods":["3-6 אווירות בעברית קצרות המתאימות לעסק"]}';
    const usr = 'תיאור עסק: ' + state.bizDesc;
    const j = await callOpenAI([
      {role:'system', content: sys},
      {role:'user', content: usr},
    ], {model:getMiniModel(), max_tokens:600, temperature:0.65});
    const parsed = safeJSON(j);
    state.bizType = parsed.biz_type || 'עסק';
    state.bizFunc = parsed.music_function || '';
    state.recommendedMoods = Array.isArray(parsed.recommended_moods) ? parsed.recommended_moods.slice(0,7) : [];
    parsed.recommended_moods && parsed.recommended_moods.forEach(m=>state.selectedMoods.add(m));

    $('bizTypeName').textContent = state.bizType;
    $('bizFunc').textContent = state.bizFunc;
  } catch(e){
    $('bizTypeName').textContent = 'עסק';
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

/* ─────────── Screen 5: Generation pipeline ─────────── */
/* ─────────── Screen 5: Energy choice ─────────── */
function renderEnergyScreen(){
  const el = $('energyOptions');
  if(!el) return;
  const entry = state.brainContext && state.brainContext.l0;
  const low  = (entry && entry.energyLow)  || { label:'רגוע וקליל',       description:'פלייליסט לשעות השקטות — מוזיקה שמאפשרת שיחה ואווירה נינוחה.' };
  const high = (entry && entry.energyHigh) || { label:'קצבי ואנרגטי',     description:'פלייליסט לשעות הסוערות — קצב שמרים ומניע.' };

  el.innerHTML = `
    <button class="energy-card low" onclick="chooseEnergy(1)">
      <div class="energy-card-label">
        🎵 ${escapeHtml(low.label)}
        <span class="energy-card-badge">אנרגיה נמוכה</span>
      </div>
      <div class="energy-card-desc">${escapeHtml(low.description)}</div>
    </button>
    <button class="energy-card high" onclick="chooseEnergy(2)">
      <div class="energy-card-label">
        🔥 ${escapeHtml(high.label)}
        <span class="energy-card-badge">אנרגיה גבוהה</span>
      </div>
      <div class="energy-card-desc">${escapeHtml(high.description)}</div>
    </button>`;
}

function chooseEnergy(level){
  state.energyLevel = level;
  startGeneration();
}

// Override setStep to render energy screen when entering step 5
const _origSetStep = setStep;
// Patch goNext on screen 4 → show energy screen
document.addEventListener('DOMContentLoaded', ()=>{});  // no-op, handled in goNext override

async function startGeneration(){
  state.hours.open = '09:00';
  state.hours.close = '23:00';
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

    // ── Data Box direct tracks (30%) ──────────────────────────────
    const directTracks = (state.brainContext.l0?.dna?.directTracks || []);
    const directIds = new Set(directTracks.map(t=>t.id).filter(Boolean));

    // GPT generates the remaining 70% — tell it to avoid the direct tracks
    const excludeTracks = [
      ...state.generatedTracks.map(t=>`${t.artist} — ${t.title}`),
      ...directTracks.map(t=>`${t.artist} — ${t.title}`),
    ];
    const candidates = await generateCandidates(faders, moods, {
      attempt: state.regenCount,
      exclude: excludeTracks
    });

    setLoadingStatus('מאמת ב-Spotify…',`${candidates.length} שירים`);
    const validated = await validateOnSpotify(candidates);

    const PLAYLIST_SIZE = 30; // ברזל — 30 שירים מדויקים
    const directCount = Math.min(directTracks.length, Math.round(PLAYLIST_SIZE * 0.30)); // up to 9

    // Merge: validated GPT tracks (deduped against direct) + direct tracks
    const gptTracks = validated.filter(t=>t.id && !directIds.has(t.id));
    const gptSlot   = PLAYLIST_SIZE - directCount;

    // Shuffle direct tracks each time so order varies
    const chosenDirect = directTracks.slice().sort(()=>Math.random()-0.5).slice(0,directCount);

    // Interleave: spread direct tracks across the playlist (not all at start)
    let merged = [...gptTracks.slice(0, gptSlot)];
    chosenDirect.forEach((dt,i)=>{
      const pos = Math.floor((i+1) * merged.length / (directCount+1));
      merged.splice(pos, 0, dt);
    });

    let final = merged;
    if(final.filter(t=>t.id).length < PLAYLIST_SIZE - 5){
      setLoadingStatus(`משלים ל-${PLAYLIST_SIZE} שירים…`,`כרגע ${final.length}`);
      const filled = await fillUp(final, faders);
      final = filled;
    }

    if(final.length < 8){
      setLoadingStatus('בעיה ביצירת פלייליסט','מעט שירים. נסה שוב או בדוק חיבור.');
      showToast('נמצאו רק '+final.length+' שירים. נסה שוב.', true);
    }

    // Diversity filter: max 2 per artist, skip disliked artists
    // Applied BEFORE slicing to ensure we always aim for PLAYLIST_SIZE
    const dislikedArtistSet = new Set(
      Object.entries(state.feedback).filter(([,v])=>v==='down')
        .map(([k])=>k.split('|')[0].toLowerCase().trim())
    );
    const artistCount = {};
    const diverse = final.filter(t=>{
      const a = (t.artist||'').toLowerCase().trim();
      if(dislikedArtistSet.has(a)) return false;
      artistCount[a] = (artistCount[a]||0) + 1;
      return artistCount[a] <= 2;
    });

    // Always produce exactly PLAYLIST_SIZE — if diversity filter reduced count, run fillUp again
    if(diverse.filter(t=>t.id).length < PLAYLIST_SIZE - 4 && state.brainContext.assembled){
      setLoadingStatus('משלים שירים…','');
      const topped = await fillUp(diverse, faders);
      state.generatedTracks = topped.slice(0, PLAYLIST_SIZE);
    } else {
      state.generatedTracks = diverse.slice(0, PLAYLIST_SIZE);
    }
    // No longer need enrichPreviews — we use Spotify embed iframes instead
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

async function generateCandidates(faders, moods, opts){
  opts = opts || {};
  const attempt  = opts.attempt || 0;            // 0 = first time, 1+ = regen
  const exclude  = opts.exclude || [];            // "artist — title" strings to avoid

  const fmDesc = describeFamiliarity(faders.familiarity);
  const heDesc = describeHebrew(faders.hebrew);
  const voDesc = describeVocal(faders.vocal);
  const enDesc = describeEnergy(faders.energy);
  const erDesc = describeEra(faders.era);

  // Newer models are slower — request fewer candidates to stay within timeout
  const isNewModel = /^gpt-5/.test(getMainModel());
  const candidateCount = isNewModel ? 40 : 60;

  const regenNote = attempt > 0
    ? `\n⚠️ זוהי יצירה מחדש מספר ${attempt}. חובה להציג בחירה שונה לחלוטין מהפעם הקודמת — אמנים שונים, שירים שונים, זוויות שונות של הסגנון. אל תחזור על אף שיר מהרשימה הבאה.`
    : '';

  const energyNote = state.energyLevel === 1
    ? '\n🎵 אנרגיה נמוכה: שירים נינוחים, טמפו 70-95 BPM, energy Spotify 0.2-0.5. מוזיקה שמאפשרת שיחה ואווירה.'
    : state.energyLevel === 2
    ? '\n🔥 אנרגיה גבוהה: שירים קצביים, טמפו 100-145 BPM, energy Spotify 0.6-0.9. מוזיקה שמרימה ומניעה.'
    : '';

  // In-session feedback — immediate effect on next generation
  const likedKeys   = Object.entries(state.feedback).filter(([,v])=>v==='up').map(([k])=>k);
  const dislikedKeys= Object.entries(state.feedback).filter(([,v])=>v==='down').map(([k])=>k);
  const sessionFeedback = [
    likedKeys.length
      ? `\n✅ המשתמש אהב את הסגנון של השירים הבאים — חפש אמנים ושירים דומים להם:\n${likedKeys.slice(0,8).map(k=>k.replace('|',' — ')).join('\n')}`
      : '',
    dislikedKeys.length
      ? `\n❌ המשתמש לא אהב את הסגנון של השירים הבאים — הימנע לחלוטין מאמנים דומים:\n${dislikedKeys.slice(0,8).map(k=>k.replace('|',' — ')).join('\n')}`
      : '',
  ].join('');

  const sys = `אתה רובין, מומחה ליצירת פלייליסטים מותאמי-עסק.
המטרה: לייצר ${candidateCount} מועמדים אמיתיים מ-Spotify לפלייליסט עסקי.
חוקים קשיחים:
- כל שיר חייב להיות קיים באמת ב-Spotify, אמן ושם מדויקים.
- אל תמציא שירים. אם אתה לא בטוח באמן או בשם — אל תכלול אותו.
- שמור על הסגנונות והאווירות שביקש העסק.
- גיוון חובה: אל תבחר רק את השירים הכי ברורים/מפורסמים של כל ז'אנר. בחר מגוון — ~40% שירים מוכרים, ~40% פחות מוכרים, ~20% נישה/גילויים. אמנים פחות מוכרים אבל איכותיים הם נכס.
- אל תחזור על אותם אמנים יותר מ-2 פעמים ברשימה כולה. פזר בין אמנים רבים ומגוונים.${regenNote}${energyNote}${sessionFeedback}
${fmDesc}
${heDesc}
${voDesc}
${enDesc}
${erDesc}
החזר JSON: {"tracks":[{"artist":"...","title":"...","reason":"5 מילים בעברית"}]}`;

  const brainBlocks = state.brainContext.assembled ? assembleBrainBlocks() : '';

  // Build exclusion block (cap at 40 to keep prompt lean)
  const excludeBlock = exclude.length
    ? `\nשירים שכבר הוצגו — אסור לכלול אף אחד מהם:\n${exclude.slice(0, 40).join('\n')}`
    : '';

  const usr = `תיאור העסק: "${state.bizDesc}"
סוג: ${state.bizType||'עסק'}
אווירות נבחרות: ${moods.join(', ')||'(ברירת מחדל)'}
שעות פעילות: ${state.hours.open}-${state.hours.close}
${state.refPlaylist?'פלייליסט ייחוס URL: '+state.refPlaylist:''}

${brainBlocks}
${excludeBlock}

צור ${candidateCount} מועמדים מגוונים שמתאימים לכל החוקים והמידע למעלה.
אם ניתנו DNA / קוהורט / ארכיון — שלב את כולם לאיזון מדויק שמתאים לעסק הזה.`;

  // Base temperature 0.85 → more creative from the first run. Higher on each regen.
  const temperature = Math.min(0.97, 0.85 + attempt * 0.04);

  const raw = await callOpenAI([
    {role:'system', content:sys},
    {role:'user', content:usr},
  ], {model: getMainModel(), max_tokens: isNewModel ? 4000 : 6000, temperature});
  const parsed = safeJSON(raw);
  const tracks = (parsed.tracks||[]).filter(t=>t.artist && t.title);
  return tracks.slice(0, candidateCount);
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

/* ─── Approach G: resolve artist names → Spotify IDs ─── */
const _artistIdCache = {}; // session-level cache: name → spotifyId

async function resolveArtistIds(artistNames, tok){
  const ids = [];
  await Promise.allSettled(artistNames.slice(0,4).map(async name=>{
    // Return from cache if available (avoids repeated Spotify searches)
    if(_artistIdCache[name]){ ids.push(_artistIdCache[name]); return; }
    try{
      const r = await fetch('https://api.spotify.com/v1/search?'+new URLSearchParams({
        q:name, type:'artist', limit:'1'
      }), {headers:{'Authorization':'Bearer '+tok}});
      if(!r.ok) return;
      const j = await r.json();
      const a = j.artists?.items?.[0];
      if(a?.id){ _artistIdCache[name] = a.id; ids.push(a.id); }
    }catch(e){}
  }));
  return ids;
}

/* ─── Approach G: get top tracks directly from artists ─── */
async function fetchArtistTopTracks(artistIds, tok, market='IL'){
  const tracks = [];
  await Promise.allSettled(artistIds.map(async id=>{
    try{
      const r = await fetch(`https://api.spotify.com/v1/artists/${id}/top-tracks?market=${market}`,
        {headers:{'Authorization':'Bearer '+tok}});
      if(!r.ok) return;
      const j = await r.json();
      // Shuffle + pick 3 per artist to vary results
      const picked = (j.tracks||[]).sort(()=>Math.random()-0.5).slice(0,3);
      tracks.push(...picked);
    }catch(e){}
  }));
  return tracks;
}

async function fillUp(existing, faders){
  const ctx = state.brainContext || {};
  const tok = await refreshSpotifyTokenIfNeeded();
  if(!tok) return existing;

  const known = new Set(existing.filter(t=>t.id).map(t=>t.id));
  const blockHebrew = faders.hebrew < 20;
  const blockIntl   = faders.hebrew > 80;
  const need = 30 - existing.filter(t=>t.id).length;
  if(need <= 0) return existing;

  const out = existing.slice();

  // Skip artists the user explicitly disliked in this session
  const dislikedFillArtists = new Set(
    Object.entries(state.feedback).filter(([,v])=>v==='down')
      .map(([k])=>k.split('|')[0].toLowerCase().trim())
  );

  const addTrack = (t, reason='fill-up') => {
    if(known.has(t.id) || out.filter(x=>x.id).length >= 30) return;
    const artistName = (t.artists||[]).map(a=>a.name).join(', ').toLowerCase().trim();
    if(dislikedFillArtists.has(artistName)) return;  // skip disliked artists
    const isHe = /[\u0590-\u05FF]/.test(t.name+' '+(t.artists||[]).map(a=>a.name).join(' '));
    if(blockHebrew && isHe) return;
    if(blockIntl && !isHe) return;
    out.push({
      artist:(t.artists||[]).map(a=>a.name).join(', '), title:t.name, id:t.id,
      url:t.external_urls?.spotify||'', cover:(t.album?.images||[]).at(-1)?.url||'',
      preview:t.preview_url||'', popularity:t.popularity||0, duration:t.duration_ms||0, reason,
    });
    known.add(t.id);
  };

  /* ── Path G: Artist-based (breaks Spotify recommendations determinism) ── */
  const nicheArtists = ctx.l0?.dna?.nicheArtists || [];
  if(nicheArtists.length >= 2){
    // Shuffle niche artists → different IDs every run
    const shuffled = nicheArtists.slice().sort(()=>Math.random()-0.5);
    const artistIds = await resolveArtistIds(shuffled, tok);

    if(artistIds.length >= 1){
      // 1. Direct top tracks from niche artists (always fresh)
      const topTracks = await fetchArtistTopTracks(artistIds, tok);
      topTracks.sort(()=>Math.random()-0.5).forEach(t=>addTrack(t,'artist-top'));

      // 2. Spotify recommendations with artist seeds (varied vs track seeds)
      if(out.filter(x=>x.id).length < 30){
        const trackSeeds = [];
        if(ctx.l1?.topTrackIds?.length) trackSeeds.push(...ctx.l1.topTrackIds.slice(0,1));

        const params = {
          seed_artists: artistIds.slice(0,Math.min(3,5-trackSeeds.length)).join(','),
          limit: Math.min(100, need*3),
          market: 'IL',
        };
        if(trackSeeds.length) params.seed_tracks = trackSeeds.join(',');

        // Energy params
        const el = state.energyLevel;
        if(el===1){ params.target_energy=0.28+Math.random()*0.12; params.max_energy=0.50; params.target_tempo=75+Math.floor(Math.random()*20); }
        else if(el===2){ params.target_energy=0.68+Math.random()*0.15; params.min_energy=0.55; params.target_tempo=110+Math.floor(Math.random()*30); }
        params.max_popularity = 60 + Math.floor(Math.random()*20);
        params.min_popularity = 15 + Math.floor(Math.random()*20);

        try{
          const qs = new URLSearchParams();
          Object.entries(params).forEach(([k,v])=>{ if(v!=null) qs.set(k,String(v)); });
          const r = await fetch('/api/spotify',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({action:'fetch',url:'https://api.spotify.com/v1/recommendations?'+qs,neutral:true})});
          if(r.ok){ const j=await r.json(); (j.tracks||[]).forEach(t=>addTrack(t,'artist-rec')); }
        }catch(e){}
      }
      return out;
    }
  }

  /* ── Fallback: original track-seed recommendations ── */
  let seeds = [];
  if(ctx.l1?.topTrackIds?.length) seeds.push(...ctx.l1.topTrackIds.slice(0,2));
  if(ctx.l2?.cohort_top_ids?.length) seeds.push(...ctx.l2.cohort_top_ids.slice(0,2));
  if(seeds.length < 3 && ctx.l0?.dna?.allTrackIds?.length){
    seeds.push(...ctx.l0.dna.allTrackIds.slice().sort(()=>Math.random()-0.5).slice(0,3));
  }
  seeds = Array.from(new Set(seeds.filter(Boolean))).slice(0,5);
  if(!seeds.length) return out.length > existing.length ? out : existing;
  const needFallback = 30 - out.filter(t=>t.id).length;
  if(needFallback <= 0) return out;

  const params2 = {
    seed_tracks: seeds.join(','),
    limit: Math.min(100, needFallback*4),
    market: 'IL',
  };
  const el2 = state.energyLevel;
  if(el2===1){ params2.target_energy=0.28+Math.random()*0.12; params2.max_energy=0.50; }
  else if(el2===2){ params2.target_energy=0.68+Math.random()*0.15; params2.min_energy=0.55; }
  else if(faders.energy<30){ params2.target_energy=0.25; params2.max_energy=0.45; }
  else if(faders.energy>70){ params2.target_energy=0.8; params2.min_energy=0.6; }
  else { params2.target_energy=faders.energy/100; }
  params2.max_popularity = 60+Math.floor(Math.random()*20);
  params2.min_popularity = 20+Math.floor(Math.random()*20);

  try{
    const qs = new URLSearchParams();
    Object.entries(params2).forEach(([k,v])=>{ if(v!=null) qs.set(k,String(v)); });
    const r = await fetch('/api/spotify',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'fetch',url:'https://api.spotify.com/v1/recommendations?'+qs,neutral:true})});
    if(r.ok){ const j=await r.json(); (j.tracks||[]).forEach(t=>addTrack(t,'fallback-rec')); }
  }catch(e){}
  return out;
}

/* ─────────── Data Box toggle ─────────── */
function toggleDataBox(){
  state.useDataBox = !state.useDataBox;
  const btn = $('dataBoxToggle');
  if(btn){
    btn.textContent = state.useDataBox ? '📋' : '🚫';
    btn.title = state.useDataBox
      ? 'Data Box פעיל — לחץ לכיבוי (מצב AI טהור)'
      : 'Data Box כבוי (AI טהור) — לחץ להפעלה';
    btn.style.opacity = state.useDataBox ? '1' : '0.45';
  }

  // When switching to Pure AI — wipe ALL brain layers immediately
  // (banner shows stale data from previous build otherwise)
  if(!state.useDataBox){
    state.brainContext.l0 = null;
    state.brainContext.l2 = null;
    state.brainContext.l3 = null;
    state.brainContext.l4 = null;
    renderBrainBanner(); // refresh banner → goes blank
    showToast('🚫 Pure AI — כל השכבות כבויות. רק הבינה מלאכותית.');
  } else {
    showToast('📋 Data Box פעיל');
  }
}

/* ─────────── Model selector ─────────── */
const MODELS = [
  { id:'gpt-4o',   label:'4o',   title:'GPT-4o — יציב, מהיר' },
  { id:'gpt-5.4',  label:'5.4',  title:'GPT-5.4 — חכם יותר, קצת איטי יותר' },
  { id:'gpt-5.5',  label:'5.5',  title:'GPT-5.5 — הכי חזק, הכי איטי' },
];

function selectModel(id){
  state.selectedModel = id;
  localStorage.setItem('sb_model', id);
  document.querySelectorAll('.model-pill').forEach(el=>{
    el.classList.toggle('active', el.dataset.model === id);
  });
}

// Main model: whichever the user selected
function getMainModel(){ return state.selectedModel || 'gpt-4o'; }

// Mini model: auto-mapped based on selected main model
function getMiniModel(){
  const m = getMainModel();
  if(m === 'gpt-5.5' || m === 'gpt-5.4') return 'gpt-5.4-mini';
  return 'gpt-4o-mini';
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

  // Show Spotify connection status
  const info = $('spotifySessionInfo');
  if(info){
    if(state.spotifyUser){
      const name = state.spotifyUser.display_name || state.spotifyUser.id || 'לא ידוע';
      info.innerHTML = `מחובר כ: <strong style="color:var(--accent)">${escapeHtml(name)}</strong>`;
    } else if(localStorage.getItem('sp3_access')){
      info.textContent = 'מחובר (טוקן שמור)';
    } else {
      info.textContent = 'לא מחובר';
      $('disconnectSpotifyBtn') && ($('disconnectSpotifyBtn').style.display = 'none');
    }
  }

  $('settingsOverlay').classList.add('open');
  setTimeout(()=> inp.focus(), 120);
}

// disconnectSpotify defined earlier in auth section

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
    model: opts.model || getMiniModel(),
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

/* ─────────── Fetch preview URLs for tracks that are missing them ─────────── */
async function enrichPreviews(tracks){
  const tok = await refreshSpotifyTokenIfNeeded();
  if(!tok) return tracks;
  const missing = tracks.filter(t=>t.id && !t.preview);
  if(!missing.length) return tracks;
  // Batch: up to 50 IDs per call
  for(let i=0; i<missing.length; i+=50){
    const batch = missing.slice(i,i+50);
    try{
      // No market param — previews are less restricted without market filter
      const r = await fetch(
        `https://api.spotify.com/v1/tracks?ids=${batch.map(t=>t.id).join(',')}`,
        {headers:{'Authorization':'Bearer '+tok}}
      );
      if(!r.ok) continue;
      const j = await r.json();
      (j.tracks||[]).forEach((sp,idx)=>{
        if(sp && sp.preview_url) batch[idx].preview = sp.preview_url;
      });
    } catch(e){}
  }
  return tracks;
}

/* ─────────── Audio preview player ─────────── */
let _previewAudio = null;
let _previewBtn   = null;

/* ─── Spotify iframe embed preview (replaces deprecated preview_url) ─── */
let _currentEmbedId = null;

function toggleEmbed(trackId, btn){
  const wrap = btn.closest('.track-wrap');
  const embedEl = wrap ? wrap.querySelector('.track-embed') : null;
  const trackItem = wrap ? wrap.querySelector('.track-item') : null;
  if(!embedEl) return;

  // Same track → close
  if(_currentEmbedId === trackId){
    embedEl.classList.remove('open');
    embedEl.innerHTML = '';
    trackItem && trackItem.classList.remove('embed-open');
    btn.classList.remove('playing');
    btn.innerHTML = '▶';
    _currentEmbedId = null;
    return;
  }

  // Close previous
  if(_currentEmbedId){
    document.querySelectorAll('.track-embed.open').forEach(el=>{
      el.classList.remove('open'); el.innerHTML = '';
    });
    document.querySelectorAll('.track-item.embed-open').forEach(el=>el.classList.remove('embed-open'));
    document.querySelectorAll('.play-btn.playing').forEach(b=>{ b.classList.remove('playing'); b.innerHTML='▶'; });
  }

  // Open new embed
  _currentEmbedId = trackId;
  btn.classList.add('playing');
  btn.innerHTML = '⏸';
  trackItem && trackItem.classList.add('embed-open');
  embedEl.classList.add('open');
  // Dark theme Spotify embed — works for ALL tracks, no preview_url needed
  embedEl.innerHTML = `<iframe
    src="https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0"
    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
    loading="lazy"></iframe>`;
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
    const fb  = state.feedback[key];
    const cover = t.cover ? `style="background-image:url('${t.cover}')"` : '';
    // Every validated track has an ID → always show play button (Spotify embed works for all)
    const canPlay = !!t.id;
    return `<div class="track-wrap">
      <div class="track-item">
        <div class="track-num">${i+1}</div>
        <div class="track-cover" ${cover}></div>
        <div class="track-meta">
          <div class="track-title">${escapeHtml(t.title)}</div>
          <div class="track-artist">${escapeHtml(t.artist)}</div>
        </div>
        <div class="track-vote">
          <button class="play-btn${canPlay?'':' no-preview'}" ${canPlay?`onclick="toggleEmbed('${escapeAttr(t.id)}',this)"`:''}  title="${canPlay?'השמע תצוגה מקדימה':'אין זיהוי Spotify'}">▶</button>
          <button class="vote-btn up${fb==='up'?' active':''}" onclick="voteTrack('${escapeAttr(key)}','up',this)">👍</button>
          <button class="vote-btn down${fb==='down'?' active':''}" onclick="voteTrack('${escapeAttr(key)}','down',this)">👎</button>
        </div>
      </div>
      <div class="track-embed"></div>
    </div>`;
  }).join('');
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function escapeAttr(s){
  return String(s||'').replace(/[\\'"<>&]/g, c=>'&#'+c.charCodeAt(0)+';');
}

function updateRegenBtn(){
  const btn = $('regenBtn');
  if(!btn) return;
  const likes    = Object.values(state.feedback).filter(v=>v==='up').length;
  const dislikes = Object.values(state.feedback).filter(v=>v==='down').length;
  if(likes > 0 || dislikes > 0){
    const parts = [];
    if(likes)    parts.push(`${likes} ✅`);
    if(dislikes) parts.push(`${dislikes} ❌`);
    btn.textContent = `🔄 צרו שוב (${parts.join(' · ')})`;
    btn.title = 'הפלייליסט הבא יתחשב בלייקים ודיסלייקים שלך';
  } else {
    btn.textContent = '🔄 צרו שוב';
    btn.title = '';
  }
}

async function voteTrack(key, vote, btn){
  state.feedback[key] = vote;
  // Update UI
  const parent = btn.parentElement;
  parent.querySelectorAll('.vote-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  updateRegenBtn(); // show liked/disliked count on regen button
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
        {e:'📋',t:'L0',d: state.brainContext.l0 ? ('data-box: '+state.brainContext.l0.label+' | '+state.brainContext.l0.genres.slice(0,60)) : 'no data-box match'},
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
  state.regenCount = (state.regenCount || 0) + 1;
  await startGeneration();
}

(async function boot(){
  selectModel(state.selectedModel);

  // 1. OAuth callback — highest priority
  if(new URLSearchParams(location.search).get('code')){
    await handleSpotifyCallback(); return;
  }

  // 2. Restore from cache instantly (sync)
  const cachedUser=(()=>{try{return JSON.parse(localStorage.getItem('sp3_user')||'null');}catch(e){return null;}})();
  if(cachedUser && localStorage.getItem('sp3_access')){
    state.spotifyUser=cachedUser; spotifyShowUser(cachedUser);
  }

  // 3. Verify token in background
  if(localStorage.getItem('sp3_access')){
    refreshSpotifyTokenIfNeeded().then(tok=>{
      if(!tok){ spotifyClearAll(); spotifyShowUser(null); updateScreen2UI(); }
      else { loadSpotifyUser(); }
    }).catch(()=>{});
  }
})();
