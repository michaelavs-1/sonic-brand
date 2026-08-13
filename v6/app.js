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

import { runAtmosphereSelection } from '/v6/atmosphere.js?v=02082026a';
import { runHoursSelection } from '/v6/hours-selector.js?v=03082026a';
import { generateMusicalDirections } from '/v6/generation/musical-directions.js?v=13082026b';
import { derivePopularityWindow } from '/v6/generation/popularity-window.js?v=02082026a';
import { runDirectionPreviewFlow, preparePreview } from '/v6/preview.js?v=13082026b';
import { buildDirectionPlaylists } from '/v6/generation/playlist-builder.js?v=13082026a';
import {
  initPlaylistResultsShell,
  updateOnePlaylistResult,
  finalizePlaylistResultsHeading,
  showRubinCTA,
  showSignupCard,
} from '/v6/result.js?v=13082026a';

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
    // confirmedPlace is NOT reset here — runBusinessStep's change-detection
    // block invalidates it only when name/description actually change, so
    // clicking back to step 1 without editing keeps the cached place and
    // skips a redundant Places lookup.
    state.selectedAtmos = [];
  }
  if (step <= 2) {
    state.directions = null;
    state.page2Promise = null;
    state.popularityWindow = null;
  }
  // Step 3 is the hours picker; it doesn't feed anything downstream that
  // needs invalidation. Hours themselves persist so re-entering pre-fills.
  if (step <= 4) {
    state.picked = null;
  }
  if (step <= 5) {
    state.results = null;
  }
}

// Fallback shape matching preparePreview's return type — used when the
// Claude call errors or preparePreview itself throws. Both pages resolve
// immediately as empty so runDirectionPreviewFlow's `await page1Ready`
// doesn't hang and just falls through to its "no previews" path.
function emptyPreparedPreview() {
  return {
    page1Ready: Promise.resolve({ previews: [], trackMeta: {} }),
    page2Ready: Promise.resolve({ previews: [], trackMeta: {} }),
  };
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
  getAtmosphereRows().catch(() => { });

  // If we've navigated away from step 1 and are now returning, the mainCard's
  // form was replaced by other screens — restore it from the snapshot.
  if (!card.querySelector('#bizName') && mainCardTemplateHtml) {
    card.innerHTML = mainCardTemplateHtml;
  }

  const bizNameEl = $('bizName');
  const bizDescEl = $('bizDesc');
  const bizNameHint = $('bizNameHint');
  const bizDescHint = $('bizDescHint');
  const btn = $('submitBtn');
  const dictateBtn = $('dictateBtn');

  if (state.bizName && !bizNameEl.value) bizNameEl.value = state.bizName;
  if (state.bizDesc && !bizDescEl.value) bizDescEl.value = state.bizDesc;

  const clearErr = (el, hint) => () => {
    if (!el.classList.contains('err')) return;
    el.classList.remove('err');
    if (hint) hint.textContent = '';
  };
  bizNameEl.addEventListener('input', clearErr(bizNameEl, bizNameHint));
  bizDescEl.addEventListener('input', clearErr(bizDescEl, bizDescHint));

  dictateBtn?.addEventListener('click', toggleDictation);

  return new Promise((resolve) => {
    const onSubmit = () => {
      const bizName = bizNameEl.value.trim();
      const bizDesc = bizDescEl.value.trim();

      let firstInvalid = null;
      if (!bizName) {
        bizNameEl.classList.add('err');
        if (bizNameHint) bizNameHint.textContent = 'הכניסו את שם העסק';
        firstInvalid = bizNameEl;
      }
      if (bizDesc.length < 4) {
        bizDescEl.classList.add('err');
        if (bizDescHint) bizDescHint.textContent = bizDesc.length === 0
          ? 'ספרו לנו קצת על העסק כדי שנוכל להמשיך'
          : 'תיאור קצר מדי — הוסיפו עוד כמה מילים';
        if (!firstInvalid) firstInvalid = bizDescEl;
      }
      if (firstInvalid) { firstInvalid.focus(); return; }

      btn.disabled = true;
      btn.innerHTML = '<span class="sb-spinner" aria-label="טוען"></span>';
      resolve({ bizName, bizDesc });
    };
    btn.addEventListener('click', onSubmit);
  });
}

// ---------- Google Places confirmation (optional) ----------
// Fires after the user submits step 1 (business name + description). Hits
// /api/v6/place-lookup and, if Google returned a match, renders a single
// "האם זה העסק שלך?" card inside the same step-1 .screen-card.
//
// Silent-skip contract: any failure path (no key, no match, fetch error,
// bad shape) returns null and logs the reason via console.info. The step-1
// runner then falls straight through to atmosphere selection — no error
// screen, no user-visible hiccup.
async function maybeConfirmPlace(bizName, bizDesc) {
  let data;
  try {
    const r = await fetch('/api/v6/place-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bizName, desc: bizDesc }),
    });
    data = await r.json().catch(() => ({}));
  } catch (err) {
    console.info('[v6 place-lookup] skipped: fetch failed', err);
    return null;
  }
  if (!data?.found || !data.place) {
    console.info('[v6 place-lookup] skipped:', data?.reason || 'unknown');
    return null;
  }

  const place = data.place;
  const card = document.querySelector('.screen-card');
  if (!card) return null;

  return new Promise((resolve) => {
    const h = document.createElement('h1');
    h.textContent = 'האם זה העסק שלך?';

    const info = document.createElement('div');
    info.style.margin = '16px 0';

    const nm = document.createElement('div');
    nm.style.cssText = 'font-weight:800;font-size:17px;margin-top:4px;text-align:center';
    nm.textContent = place.name || '';
    info.append(nm);

    if (place.address) {
      const ad = document.createElement('div');
      ad.className = 'subtitle';
      ad.style.cssText = 'margin:4px 0 0;text-align:center';
      ad.textContent = place.address;
      info.append(ad);
    }
    if (place.editorial_summary) {
      const es = document.createElement('div');
      es.className = 'subtitle';
      es.style.cssText = 'margin:10px 0 0;font-style:italic;text-align:center';
      es.textContent = place.editorial_summary;
      info.append(es);
    }

    const yes = document.createElement('button');
    yes.className = 'btn btn-primary btn-block';
    yes.textContent = 'כן, זה אנחנו ✓';
    yes.addEventListener('click', () => resolve(place));

    const no = document.createElement('button');
    no.className = 'btn btn-secondary btn-block';
    no.textContent = 'לא, זה לא העסק';
    no.addEventListener('click', () => resolve(null));

    card.replaceChildren(h, info, yes, no);
  });
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
  h.textContent = 'רובין חושב על העסק שלכם';
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

  // Cross-step promise handles: Claude directions + preview prep are kicked
  // off during the hours step (step 3) so they warm in the background while
  // the user picks hours, then get awaited during the preview step (step 4).
  // Declared here so they survive the s === 3 → s === 4 boundary inside the
  // while loop.
  let directionsPromise = null;
  let directionsSettled = state.directions != null;
  let preparedPromise = null;

  try {
    let s = start;
    while (s <= 5) {
      setStep(s);

      if (s === 1) {
        const { bizName, bizDesc } = await abortable(runBusinessStep(), signal);
        if (bizName !== state.bizName || bizDesc !== state.bizDesc) {
          // Description changed → Google Places lookup must re-run.
          state.confirmedPlace = undefined;
        }
        state.bizName = bizName;
        state.bizDesc = bizDesc;
        // Google Places confirm sub-step lives inside step 1: same
        // .screen-card, progress-bar dot stays on "מספרים על העסק". If
        // Google finds nothing (or the key is missing / call fails), the
        // sub-step is silently skipped and we fall through to step 2.
        if (state.confirmedPlace === undefined) {
          state.confirmedPlace = await abortable(maybeConfirmPlace(bizName, bizDesc), signal);
        }
        markReached(2);
      }

      else if (s === 2) {
        const atmosphereRows = await abortable(getAtmosphereRows(), signal);
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
        // know whether to show a loading screen after step 4 starts.
        //
        // As soon as Claude page 1 lands, we IMMEDIATELY chain preparePreview
        // onto it so anchor-tracks + Spotify get_track metadata also happen
        // in the background — that way when the swipe deck actually needs
        // to render (step 4), everything is warm and it appears instantly.
        if (!state.directions && !directionsPromise) {
          const rawDirections = generateMusicalDirections({
            bizName: state.bizName,
            bizDesc: state.bizDesc,
            atmospheres: state.selectedAtmos,
            place: state.confirmedPlace,
          });
          directionsPromise = rawDirections.then(
            (r) => { directionsSettled = true; return r; },
            (e) => { directionsSettled = true; throw e; },
          );
          // Kick off prep as soon as directions land (page 1 anchors fire
          // immediately; page 2 anchors chain onto Claude's second call).
          preparedPromise = rawDirections.then((r) => {
            if (r?.error) return emptyPreparedPreview();
            const popularityWindow = derivePopularityWindow(state.selectedAtmos, state.atmosphereRows);
            return preparePreview({
              directions: r.directions,
              page2Promise: r.page2Promise,
              popularityWindow,
            });
          }).catch((e) => {
            console.warn('preparePreview failed:', e);
            return emptyPreparedPreview();
          });
        } else if (state.directions && !preparedPromise) {
          // Cached directions from a prior run — start prep synchronously.
          preparedPromise = preparePreview({
            directions: state.directions,
            page2Promise: state.page2Promise,
            popularityWindow: state.popularityWindow,
          }).catch((e) => {
            console.warn('preparePreview failed:', e);
            return emptyPreparedPreview();
          });
        }

        // Opening hours picker. Runs in the foreground; the Claude call +
        // preview prep chug along behind it.
        const hoursResult = await abortable(
          runHoursSelection({ prechecked: state.hours ? { hours: state.hours } : null }),
          signal,
        );
        state.hours = hoursResult.hours;
        state.longestMinutes = hoursResult.longestMinutes;
        markReached(4);
      }

      else if (s === 4) {
        // Preview swipe. If we jumped straight here (e.g. via the progress
        // bar), the hours step didn't run — so directionsPromise may not
        // exist yet. Kick it off inline in that case.
        if (!state.directions && !directionsPromise) {
          const rawDirections = generateMusicalDirections({
            bizName: state.bizName,
            bizDesc: state.bizDesc,
            atmospheres: state.selectedAtmos,
            place: state.confirmedPlace,
          });
          directionsPromise = rawDirections.then(
            (r) => { directionsSettled = true; return r; },
            (e) => { directionsSettled = true; throw e; },
          );
          preparedPromise = rawDirections.then((r) => {
            if (r?.error) return emptyPreparedPreview();
            const popularityWindow = derivePopularityWindow(state.selectedAtmos, state.atmosphereRows);
            return preparePreview({
              directions: r.directions,
              page2Promise: r.page2Promise,
              popularityWindow,
            });
          }).catch((e) => {
            console.warn('preparePreview failed:', e);
            return emptyPreparedPreview();
          });
        } else if (state.directions && !preparedPromise) {
          preparedPromise = preparePreview({
            directions: state.directions,
            page2Promise: state.page2Promise,
            popularityWindow: state.popularityWindow,
          }).catch((e) => {
            console.warn('preparePreview failed:', e);
            return emptyPreparedPreview();
          });
        }

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
          state.directions = dResult.directions;
          state.page2Promise = dResult.page2Promise;
          state.popularityWindow = derivePopularityWindow(state.selectedAtmos, state.atmosphereRows);
        }

        const picked = await abortable(runDirectionPreviewFlow({
          directions: state.directions,
          page2Promise: state.page2Promise,
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
        markReached(5);
      }

      else if (s === 5) {
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
            name: state.bizName,
            atmospheres: state.selectedAtmos,
            place: state.confirmedPlace,
            hours: state.hours,
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

// ---------- welcome intro: splash → "have a Rubin account?" → /v6/account | onboarding ----------
// If a Supabase session already exists in localStorage, skip the intro card
// entirely and go straight to /v6/account. Expired-but-refreshable sessions
// (refresh_token present) also count — supabase-js will auto-refresh on
// dashboard boot. Only fully absent sessions get the "have an account?" card.
function hasSupabaseSession() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!/^sb-.*-auth-token$/.test(k)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      // supabase-js v2 stores the session object directly (or wrapped in an
      // array in some older builds). Accept either shape.
      const s = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!s) continue;
      const nowSec = Math.floor(Date.now() / 1000);
      const notExpired = typeof s.expires_at === 'number' && s.expires_at > nowSec;
      if (s.access_token && (notExpired || s.refresh_token)) return true;
    }
  } catch { /* fall through — treat as no session */ }
  return false;
}

function runIntro() {
  const splash = $('splash');
  const intro = $('introCard');
  const main = $('mainCard');
  const fp = $('flowProgress');
  if (!splash || !intro || !main) return;

  // ?intro=1 — arrived from an explicit logout on /v6/account. Force the
  // intro card: skip both the "logged-in? go to dashboard" auto-redirect
  // (Supabase's token clearing on signOut can race with our navigation, so
  // relying on hasSupabaseSession() here would risk bouncing the user right
  // back) and the splash + entrance animation.
  const skipSplash = new URLSearchParams(location.search).has('intro');

  if (!skipSplash && hasSupabaseSession()) {
    window.location.replace('/v6/account');
    return;
  }

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

  if (skipSplash) {
    splash.remove();
    intro.style.animation = 'none';
    intro.hidden = false;
  } else {
    setTimeout(() => {
      splash.classList.add('hide');
      intro.hidden = false;
      setTimeout(() => splash.remove(), 800);
    }, 2650);
  }

  $('rbNo')?.addEventListener('click', finish);
  $('rbYes')?.addEventListener('click', () => {
    window.location.href = '/v6/account';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireStepClicks();
  runIntro();
  prewarmSupabase();
});
