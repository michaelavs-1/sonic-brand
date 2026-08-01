// v6 onboarding orchestrator.
//
// Michael's v4 shell (splash → login | onboarding → business input with voice
// dictation → Google Places confirmation → atmosphere → preview → build →
// signup) driven by v5's pipeline (Claude musical directions → per-direction
// preview swipe → one Spotify playlist per picked direction).
//
// The four flow steps are driven by a state machine so users can click any
// reached step in the progress bar to jump back and edit. State (bizName,
// bizDesc, place, atmospheres, directions, picks) is preserved across
// navigation; downstream state is invalidated when an earlier step is
// re-entered.

import { runAtmosphereSelection } from '/v6/atmosphere.js?v=01082026c';
import { runHoursSelection } from '/v6/hours-selector.js?v=01082026c';
import { generateMusicalDirections } from '/v6/generation/musical-directions.js?v=01082026c';
import { derivePopularityWindow } from '/v6/generation/popularity-window.js?v=01082026c';
import { runDirectionPreviewFlow, preparePreview } from '/v6/preview.js?v=01082026c';
import { buildDirectionPlaylists } from '/v6/generation/playlist-builder.js?v=01082026c';
import {
  initPlaylistResultsShell,
  updateOnePlaylistResult,
  finalizePlaylistResultsHeading,
  showRubinCTA,
  showSignupCard,
} from '/v6/result.js?v=01082026c';

// ?reset=1 — wipe any saved Rubin session (and local flow state) so the whole
// experience starts truly from zero.
if (new URLSearchParams(location.search).has('reset')) {
  Object.keys(localStorage).filter((k) => k.startsWith('sb-')).forEach((k) => localStorage.removeItem(k));
  console.log('v6: session reset — starting fresh');
}

const $ = (id) => document.getElementById(id);

// ---------- flow state ----------
// Preserved across step navigation. Downstream fields are invalidated by
// invalidateFrom() when the user goes back to an earlier step.
const state = {
  bizName: '',
  bizDesc: '',
  confirmedPlace: undefined,  // undefined = never looked up; null = looked up, none found
  atmosphereRows: null,       // cached once per session
  selectedAtmos: [],
  // Opening hours are collected in step 3 alongside the Claude call. Kept
  // across step re-entry so users don't re-enter them just for changing
  // atmospheres.
  hours: null,                // { 0: { closed: true } | { open, close }, ..., 6: ... }
  longestMinutes: 0,          // longest open window across days — feeds daily-playlist target
  directions: null,
  page2Promise: null,
  popularityWindow: null,
  picked: null,
  results: null,
};

// Highest step index the user has reached — determines which steps in the
// progress bar are clickable.
let highestStep = 1;
let currentStep = 1;

// Snapshot of #mainCard's original HTML, taken on first render so we can
// restore the business form when the user navigates back to step 1.
let mainCardTemplateHtml = null;

// AbortController for whichever step is currently awaiting user input; a new
// goToStep() aborts the previous one so the promise chain unwinds cleanly.
let flowAborter = null;

function setStep(n) {
  currentStep = n;
  document.querySelectorAll('#flowProgress .fp-step').forEach((s) => {
    const step = Number(s.dataset.step);
    s.classList.toggle('done', step < n);
    s.classList.toggle('active', step === n);
    s.classList.toggle('clickable', step <= highestStep && step !== n);
  });
}

function markReached(step) {
  if (step > highestStep) highestStep = step;
  // Re-run setStep to update .clickable on newly-reached steps.
  setStep(currentStep);
}

function invalidateFrom(step) {
  if (step <= 1) {
    state.confirmedPlace = undefined;
    state.selectedAtmos = [];
  }
  if (step <= 2) {
    state.directions = null;
    state.page2Promise = null;
    state.popularityWindow = null;
  }
  if (step <= 3) {
    state.picked = null;
  }
  if (step <= 4) {
    state.results = null;
  }
}

// Wrap a promise so it rejects with AbortError if `signal` fires. The underlying
// operation keeps running; we just stop caring about its result.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// ---------- voice dictation (record → Whisper transcription) ----------
let dictRec = null;
let dictTimer = null;

async function toggleDictation() {
  const btn = $('dictateBtn');
  if (dictRec) {
    clearTimeout(dictTimer);
    if (dictRec.state !== 'inactive') dictRec.stop();
    return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $('dictLbl').textContent = 'לא ניתן לגשת למיקרופון'; return; }

  const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = preferred.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) || '';
  dictRec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  dictRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  dictRec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: dictRec.mimeType || mimeType || 'audio/webm' });
    dictRec = null;
    btn.classList.remove('rec');
    if (blob.size < 3000) {
      $('dictIco').textContent = '🎤';
      $('dictLbl').textContent = 'או פשוט ספרו לנו בקול — אנחנו נתמלל';
      return;
    }
    btn.classList.add('busy');
    $('dictIco').innerHTML = '<span class="sb-spinner" style="width:14px;height:14px"></span>';
    $('dictLbl').textContent = 'מתמללים את מה שסיפרתם…';
    try {
      const b64 = await new Promise((resolve) => {
        const r = new FileReader();
        r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
        r.readAsDataURL(blob);
      });
      const resp = await fetch('/api/v6/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: b64, mime: blob.type }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.text) throw new Error(data?.error || 'transcribe failed');
      const ta = $('bizDesc');
      ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + data.text;
      ta.focus();
      $('dictLbl').textContent = 'תומלל ✓ אפשר לערוך או להקליט עוד';
    } catch (err) {
      console.error('dictation failed:', err);
      $('dictLbl').textContent = 'התמלול נכשל — נסו שוב';
    } finally {
      btn.classList.remove('busy');
      $('dictIco').textContent = '🎤';
    }
  };
  dictRec.start(1000);
  btn.classList.add('rec');
  $('dictIco').textContent = '⏺';
  $('dictLbl').textContent = 'מקליטים… לחצו לסיום';
  dictTimer = setTimeout(() => { if (dictRec && dictRec.state !== 'inactive') dictRec.stop(); }, 60000);
}

// ---------- atmosphere rows (cached once) ----------
// The endpoint keeps a 30-min server-side cache; we DON'T pass `fresh=1` any
// more so warm hits return in ~50ms. We also dedupe in-flight requests via
// atmosphereRowsPromise so kick-off from multiple call sites (e.g. background
// prefetch + step 2's await) doesn't fire two fetches.
let atmosphereRowsPromise = null;
async function getAtmosphereRows() {
  if (state.atmosphereRows) return state.atmosphereRows;
  if (atmosphereRowsPromise) return atmosphereRowsPromise;
  atmosphereRowsPromise = fetch('/api/v5/databox-atmospheres')
    .then(async (r) => {
      if (!r.ok) throw new Error(`databox-atmospheres ${r.status}: ${r.statusText}`);
      const { rows } = await r.json();
      state.atmosphereRows = rows;
      return rows;
    })
    .catch((e) => {
      atmosphereRowsPromise = null;  // let a later call retry after a failure
      throw e;
    });
  return atmosphereRowsPromise;
}

function prewarmSupabase() { fetch('/api/v5/prewarm').catch(() => { }); }

// ---------- narrator: "AI thinking" hint while Claude runs ----------
function startNarrator() {
  const cardEl = document.querySelector('.screen-card');
  if (!cardEl) return { stop() { } };
  const steps = [
    'קוראים את התיאור של העסק…',
    'מזהים את האופי והקהל…',
    'מתאימים כיוונים מוזיקליים…',
    'עוד רגע, מסדרים הכל…',
  ];
  const box = document.createElement('div');
  box.className = 'ai-explain';
  const tag = document.createElement('span');
  tag.className = 'ai-tag';
  tag.textContent = '🤖 רובין חושב';
  box.append(tag);
  const lines = steps.map((s) => {
    const d = document.createElement('div');
    d.className = 'nar-step';
    const ico = document.createElement('span'); ico.className = 'nar-ico';
    const txt = document.createElement('span'); txt.textContent = s;
    d.append(ico, txt); box.append(d); return d;
  });
  let i = -1;
  const advance = () => {
    if (i >= 0 && lines[i]) {
      lines[i].classList.add('done');
      lines[i].querySelector('.nar-ico').textContent = '✓';
    }
    i += 1;
    if (lines[i]) {
      lines[i].querySelector('.nar-ico').innerHTML =
        '<span class="sb-spinner" style="width:11px;height:11px"></span>';
    }
  };
  advance();
  const timer = setInterval(() => {
    if (i < lines.length - 1) advance();
    else clearInterval(timer);
  }, 2400);
  cardEl.append(box);
  return { stop() { clearInterval(timer); box.remove(); } };
}

// ---------- step 1: business input ----------
async function runBusinessStep() {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('runBusinessStep: no .screen-card');

  // Fire the atmosphere-rows fetch NOW, in the background, while the user
  // is still typing their business description. By the time they hit submit
  // and step 2 needs the rows, the fetch has usually landed. Fire-and-forget:
  // if the network fails here, step 2's own await will surface the error.
  getAtmosphereRows().catch(() => {});

  // If we've navigated away from step 1 and are now returning, the mainCard's
  // form was replaced by other screens — restore it from the snapshot.
  if (!card.querySelector('#bizName') && mainCardTemplateHtml) {
    card.innerHTML = mainCardTemplateHtml;
  }

  const bizNameEl = $('bizName');
  const bizDescEl = $('bizDesc');
  const btn = $('submitBtn');
  const dictateBtn = $('dictateBtn');

  if (state.bizName && !bizNameEl.value) bizNameEl.value = state.bizName;
  if (state.bizDesc && !bizDescEl.value) bizDescEl.value = state.bizDesc;

  dictateBtn?.addEventListener('click', toggleDictation);

  return new Promise((resolve) => {
    const onSubmit = () => {
      const bizName = bizNameEl.value.trim();
      const bizDesc = bizDescEl.value.trim();
      if (bizDesc.length < 4) return;
      btn.disabled = true;
      btn.innerHTML = '<span class="sb-spinner" aria-label="טוען"></span>';
      resolve({ bizName, bizDesc });
    };
    btn.addEventListener('click', onSubmit);
  });
}

// ---------- Google Business confirmation (optional) ----------
async function maybeConfirmPlace(bizName, bizDesc) {
  try {
    const r = await fetch('/api/v6/place-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bizName, desc: bizDesc }),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.found || !data.place) return null;
    const place = data.place;
    const candidates = Array.isArray(data.candidates) ? data.candidates : [place];

    const card = document.querySelector('.screen-card');
    if (!card) return null;

    const confirmOne = (p) => new Promise((resolve) => {
      const img = p.photo_url
        ? `<img src="${p.photo_url}" alt="" style="width:100%;max-height:190px;object-fit:cover;border-radius:14px;border:1px solid var(--border-2)">`
        : '';
      const wrap = document.createElement('div');
      wrap.innerHTML =
        `<h1>האם זה העסק שלך?</h1>` +
        `<div style="margin:16px 0">${img}` +
        `<div style="font-weight:800;font-size:17px;margin-top:12px">${p.name || ''}</div>` +
        `<div class="subtitle" style="margin:4px 0 0">${p.address || ''}</div></div>`;
      const yes = document.createElement('button');
      yes.className = 'btn btn-primary btn-block';
      yes.textContent = 'כן, זה אנחנו ✓';
      const no = document.createElement('button');
      no.className = 'btn btn-secondary btn-block';
      no.textContent = 'לא, זה לא העסק';
      yes.addEventListener('click', () => resolve(p));
      no.addEventListener('click', () => resolve(null));
      card.replaceChildren(...wrap.childNodes, yes, no);
    });

    if (candidates.length > 1) {
      const wantsBranches = await new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.innerHTML =
          `<h1>מצאנו כמה מקומות כאלה</h1>` +
          `<p class="subtitle">האם יש לעסק כמה סניפים, או שזו רשת?</p>`;
        const yes = document.createElement('button');
        yes.className = 'btn btn-primary btn-block';
        yes.textContent = 'כן, יש כמה סניפים / זו רשת';
        const no = document.createElement('button');
        no.className = 'btn btn-secondary btn-block';
        no.textContent = 'לא, זה עסק אחד';
        yes.addEventListener('click', () => resolve(true));
        no.addEventListener('click', () => resolve(false));
        card.replaceChildren(...wrap.childNodes, yes, no);
      });

      if (wantsBranches) {
        return await new Promise((resolve) => {
          const wrap = document.createElement('div');
          wrap.innerHTML =
            `<h1>לאיזה סניף נבנה את המוזיקה?</h1>` +
            `<p class="subtitle">אפשר להוסיף סניפים נוספים אחר כך באזור האישי</p>`;
          const list = document.createElement('div');
          for (const c of candidates) {
            const b = document.createElement('button');
            b.className = 'btn btn-secondary btn-block';
            b.style.textAlign = 'right';
            b.innerHTML = `<div style="font-weight:800">${c.name || ''}</div>` +
              `<div style="font-size:12px;color:var(--muted);margin-top:2px">${c.address || ''}</div>`;
            b.addEventListener('click', () => resolve(c));
            list.append(b);
          }
          const skip = document.createElement('button');
          skip.className = 'btn-ghost';
          skip.textContent = 'דלגו — נמשיך בלי לקשר סניף';
          skip.addEventListener('click', () => resolve(null));
          card.replaceChildren(...wrap.childNodes, list, skip);
        });
      }
      return await confirmOne(place);
    }

    return await confirmOne(place);
  } catch {
    return null;
  }
}

// ---------- error display ----------
function showError(message) {
  const card = document.querySelector('.screen-card');
  if (!card) return;
  const h = document.createElement('h1');
  h.textContent = 'לא הצלחנו להמשיך';
  const p = document.createElement('p');
  p.className = 'preview-empty';
  p.textContent = message || 'נסו לתאר את העסק בצורה שונה.';
  card.replaceChildren(h, p);
}

// Renders the "waiting for Claude" screen shown after the hours picker if
// the directions call hasn't returned yet. Uses the same 25s progress-bar
// CSS the preview screen uses so the visual language stays consistent.
function showDirectionsLoading() {
  const card = document.querySelector('.screen-card');
  if (!card) return;
  const h = document.createElement('h1');
  h.textContent = 'רובין חושבת על העסק שלכם';
  const wrap = document.createElement('div');
  wrap.className = 'preview-load-column';
  wrap.innerHTML =
    '<div class="preview-load-label">מתאימים כיוונים מוזיקליים…</div>' +
    '<div class="preview-load-progress"><div class="preview-load-progress-fill"></div></div>';
  card.replaceChildren(h, wrap);
}

// ---------- step orchestrator ----------
async function goToStep(start) {
  if (start > highestStep) return;

  // Abort any in-flight step. The underlying operations keep running but
  // we stop awaiting them, and the new step takes over the .screen-card.
  if (flowAborter) flowAborter.abort();
  flowAborter = new AbortController();
  const signal = flowAborter.signal;

  invalidateFrom(start);

  try {
    let s = start;
    while (s <= 4) {
      setStep(s);

      if (s === 1) {
        const { bizName, bizDesc } = await abortable(runBusinessStep(), signal);
        if (bizName !== state.bizName || bizDesc !== state.bizDesc) {
          // Description changed → Google Places lookup must re-run.
          state.confirmedPlace = undefined;
        }
        state.bizName = bizName;
        state.bizDesc = bizDesc;
        markReached(2);
      }

      else if (s === 2) {
        const atmosphereRows = await abortable(getAtmosphereRows(), signal);
        if (state.confirmedPlace === undefined) {
          state.confirmedPlace = await abortable(maybeConfirmPlace(state.bizName, state.bizDesc), signal);
        }
        const selectedAtmos = await abortable(
          runAtmosphereSelection({ atmosphereRows }),
          signal,
        );
        // If atmospheres changed, invalidate directions.
        const sameAtmos = selectedAtmos.length === state.selectedAtmos.length
          && selectedAtmos.every((a) => state.selectedAtmos.includes(a));
        if (!sameAtmos) {
          state.directions = null;
          state.page2Promise = null;
          state.popularityWindow = null;
          state.picked = null;
          state.results = null;
        }
        state.selectedAtmos = selectedAtmos;
        markReached(3);
      }

      else if (s === 3) {
        // Fire Claude in the background — don't await yet. The hours picker
        // runs while it thinks. Track resolution via a settled flag so we
        // know whether to show a loading screen after the hours picker.
        //
        // As soon as Claude page 1 lands, we IMMEDIATELY chain preparePreview
        // onto it so anchor-tracks + Spotify get_track metadata also happen
        // in the background — that way when the swipe deck actually needs
        // to render (after the hours picker), everything is warm and it
        // appears instantly.
        let directionsPromise = null;
        let directionsSettled = state.directions != null;
        let preparedPromise   = null;

        if (!state.directions) {
          const rawDirections = generateMusicalDirections({
            bizName:     state.bizName,
            bizDesc:     state.bizDesc,
            atmospheres: state.selectedAtmos,
          });
          directionsPromise = rawDirections.then(
            (r) => { directionsSettled = true; return r; },
            (e) => { directionsSettled = true; throw e; },
          );
          // Kick off prep as soon as directions land (page 1 anchors fire
          // immediately; page 2 anchors chain onto Claude's second call).
          preparedPromise = rawDirections.then((r) => {
            if (r?.error) return { previews: [], trackMeta: {} };
            const popularityWindow = derivePopularityWindow(state.selectedAtmos, state.atmosphereRows);
            return preparePreview({
              directions:       r.directions,
              page2Promise:     r.page2Promise,
              popularityWindow,
            });
          }).catch((e) => {
            console.warn('preparePreview failed:', e);
            return { previews: [], trackMeta: {} };
          });
        } else {
          // Cached directions from a prior run — start prep synchronously.
          preparedPromise = preparePreview({
            directions:       state.directions,
            page2Promise:     state.page2Promise,
            popularityWindow: state.popularityWindow,
          }).catch((e) => {
            console.warn('preparePreview failed:', e);
            return { previews: [], trackMeta: {} };
          });
        }

        // Opening hours picker. Runs in the foreground; the Claude call +
        // preview prep chug along behind it.
        const hoursResult = await abortable(
          runHoursSelection({ prechecked: state.hours ? { hours: state.hours } : null }),
          signal,
        );
        state.hours          = hoursResult.hours;
        state.longestMinutes = hoursResult.longestMinutes;

        // If Claude hasn't returned yet, show a progress bar until it does.
        // Usually already resolved by now if the user spent any real time
        // on the hours picker.
        if (!state.directions && directionsPromise) {
          if (!directionsSettled) showDirectionsLoading();
          const dResult = await abortable(directionsPromise, signal);
          if (dResult.error) {
            showError(dResult.reasoning_en ? `סיבה: ${dResult.reasoning_en}` : undefined);
            return;
          }
          state.directions       = dResult.directions;
          state.page2Promise     = dResult.page2Promise;
          state.popularityWindow = derivePopularityWindow(state.selectedAtmos, state.atmosphereRows);
        }

        const picked = await abortable(runDirectionPreviewFlow({
          directions:       state.directions,
          page2Promise:     state.page2Promise,
          popularityWindow: state.popularityWindow,
          preparedPromise,
        }), signal);
        if (!picked.length) {
          const card = document.querySelector('.screen-card');
          if (card) {
            card.replaceChildren(
              Object.assign(document.createElement('h1'), { textContent: 'לא נבחרו כיוונים' }),
              Object.assign(document.createElement('p'), { className: 'preview-empty', textContent: 'נסו שוב וסמנו לפחות שיר אחד.' }),
            );
          }
          return;
        }
        state.picked = picked;
        state.results = null;   // any new picks → fresh build
        markReached(4);
      }

      else if (s === 4) {
        initPlaylistResultsShell(state.picked);
        const results = await abortable(buildDirectionPlaylists({
          selectedDirections: state.picked,
          bizName: state.bizName,
          popularityWindow: state.popularityWindow,
          onProgress: (index, r) => updateOnePlaylistResult(index, r),
        }), signal);
        finalizePlaylistResultsHeading(results);
        state.results = results;
        showRubinCTA(() => {
          if (signal.aborted) return;
          showSignupCard(results, {
            name:        state.bizName,
            atmospheres: state.selectedAtmos,
            place:       state.confirmedPlace,
            hours:       state.hours,
            longestMinutes: state.longestMinutes,
          });
        });
        return;
      }

      s += 1;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('v6 error:', err);
    showError(err?.message || 'תקלה לא צפויה.');
  }
}

function wireStepClicks() {
  document.querySelectorAll('#flowProgress .fp-step').forEach((s) => {
    s.addEventListener('click', () => {
      const step = Number(s.dataset.step);
      if (!s.classList.contains('clickable')) return;
      goToStep(step);
    });
  });
}

// ---------- welcome intro: splash → "have a Rubin account?" → login | onboarding ----------
const SB_URL = 'https://xhkqrxljncazvbgkmqex.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhoa3FyeGxqbmNhenZiZ2ttcWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDQ5NjgsImV4cCI6MjA5MTMyMDk2OH0.OQjdrnAUUCuuPjsAtt2gJDaCL3O9rRJ2XumtBNIxqC8';

async function rubinPasswordLogin(email, password) {
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || 'login failed');
  if (!j.expires_at && j.expires_in) j.expires_at = Math.floor(Date.now() / 1000) + j.expires_in;
  localStorage.setItem('sb-xhkqrxljncazvbgkmqex-auth-token', JSON.stringify(j));
}

function runIntro() {
  const splash = $('splash');
  const intro = $('introCard');
  const main = $('mainCard');
  const fp = $('flowProgress');
  if (!splash || !intro || !main) return;

  const finish = () => {
    intro.remove();
    main.hidden = false;
    if (fp) fp.hidden = false;
    // Snapshot the mainCard's original HTML so we can restore the business
    // form when the user navigates back to step 1.
    mainCardTemplateHtml = main.innerHTML;
    // Start the flow.
    goToStep(1);
  };

  setTimeout(() => {
    splash.classList.add('hide');
    intro.hidden = false;
    setTimeout(() => splash.remove(), 800);
  }, 2650);

  $('rbNo')?.addEventListener('click', finish);
  $('rbYes')?.addEventListener('click', () => {
    $('introChoice').hidden = true;
    $('rbLoginBox').hidden = false;
    $('rbEmail')?.focus();
  });
  $('rbBack')?.addEventListener('click', () => {
    $('rbLoginBox').hidden = true;
    $('introChoice').hidden = false;
  });
  $('rbForgot')?.addEventListener('click', async () => {
    const msg = $('rbLoginMsg');
    const email = $('rbEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg.textContent = 'הזינו את האימייל למעלה ואז לחצו "שכחתי סיסמה"';
      return;
    }
    try {
      await fetch(`${SB_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, redirect_to: `${location.origin}/v6/account` }),
      });
      msg.style.color = 'var(--teal-soft)';
      msg.textContent = 'שלחנו קישור איפוס לאימייל — היכנסו דרכו ותוכלו להגדיר סיסמה חדשה';
    } catch {
      msg.textContent = 'לא הצלחנו לשלוח כרגע — נסו שוב';
    }
  });

  $('rbLogin')?.addEventListener('click', async () => {
    const btn = $('rbLogin');
    const msg = $('rbLoginMsg');
    const email = $('rbEmail').value.trim().toLowerCase();
    const pass = $('rbPass').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !pass) {
      msg.textContent = 'הזינו אימייל וסיסמה';
      return;
    }
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="sb-spinner" style="width:15px;height:15px"></span>';
    msg.textContent = '';
    try {
      await rubinPasswordLogin(email, pass);
      btn.innerHTML = 'מחוברים ✓ עוברים לאזור האישי…';
      setTimeout(() => { window.location.href = '/v6/account'; }, 600);
    } catch (err) {
      console.warn('rubin login failed:', err);
      btn.disabled = false;
      btn.innerHTML = orig;
      msg.textContent = 'האימייל או הסיסמה לא נכונים — נסו שוב';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireStepClicks();
  runIntro();
  prewarmSupabase();
});
