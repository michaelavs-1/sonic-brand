// v7 checkout screens: registration (email only) → payment (placeholder) →
// taste-profile bar → "check your email". Replaces v6's step-6 example-playlist
// build entirely: v7 directions are diagnostic PROBES that dissolve into a
// flat, full-catalog taste profile (via generateTasteProfile), so there are no
// per-direction example playlists to show here.
//
// Flow (all render into .screen-card and resolve when the owner advances):
//   runRegistrationStep({ initialValue })                  -> Promise<email>  (A4)
//   runPaymentStep({ email })                              -> Promise<void>   (A5)
//   runTasteProfileBar({ tasteProfilePromise, signupPayload, genreTally, retry })  (A7)
//
// Auth (decided 2026-09-24 — email verification REQUIRED, same as v6): nothing
// here ever logs the owner in. Registration only CAPTURES the email. After the
// (placeholder) payment, the bar waits for the taste profile, then the v7
// signup endpoint creates the account, saves the profile and emails a one-time
// magic link; this screen then shows "בדקו את המייל ✉️". Clicking the link is
// the verification step and lands the owner on /v7/account. No account exists
// for anyone who abandons before paying ("no non-paying clients").

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_BAR_MS = 2000; // let the "dissolving" bar breathe even when the call is already resolved

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function getCard() {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('result: .screen-card not found');
  return card;
}

// Best-effort read of an already-present Supabase session email, used only to
// pre-fill the registration field (a returning owner who reached onboarding
// again). Never blocks the flow.
function existingSessionEmail() {
  try {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.includes('auth-token'));
    if (!k) return null;
    const s = JSON.parse(localStorage.getItem(k));
    return s?.user?.email
      || (s?.access_token ? (JSON.parse(atob(s.access_token.split('.')[1])).email || null) : null);
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================================
   A4 — Registration. Email capture ONLY. No account is created here.
   Resolves with the lowercased, validated email string.
   ========================================================================= */
export function runRegistrationStep({ initialValue = '' } = {}) {
  return new Promise((resolve) => {
    const card = getCard();

    const emailInput = el('input', {
      class: 'input-text',
      type: 'email',
      autocomplete: 'email',
      inputmode: 'email',
      placeholder: 'you@business.co.il',
    });
    emailInput.value = initialValue || existingSessionEmail() || '';

    const msg = el('p', { class: 'hint', style: 'color:#ff9b8a;font-size:13px;min-height:18px' }, '');
    const goBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'המשך ←');

    let done = false;
    const submit = () => {
      if (done) return;
      const email = emailInput.value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        msg.textContent = 'הזינו כתובת אימייל תקינה';
        emailInput.classList.add('err');
        emailInput.focus();
        return;
      }
      done = true;
      resolve(email);
    };

    goBtn.addEventListener('click', submit);
    emailInput.addEventListener('input', () => emailInput.classList.remove('err'));
    emailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    card.replaceChildren(
      el('h1', {}, 'הכל מוכן! הירשמו עכשיו'),
      el('p', { class: 'subtitle', style: 'margin-bottom:12px' },
        'השאירו אימייל כדי לשמור את הפרופיל המוזיקלי שלכם ולהתחיל לקבל פלייליסטים יומיים.'),
      el('div', { class: 'input-wrap' },
        el('label', { class: 'input-label' }, 'אימייל'),
        emailInput,
      ),
      goBtn,
      msg,
    );
    emailInput.focus();
  });
}

/* =========================================================================
   A5 — Payment (placeholder). All fields optional; submitting just advances.
   No account is created here — signup runs after the taste-profile bar (A7),
   once the profile it saves is ready.
   ========================================================================= */
export function runPaymentStep({ email }) {
  return new Promise((resolve) => {
    const card = getCard();

    const field = (labelText, attrs) => el('div', { class: 'input-wrap' },
      el('label', { class: 'input-label' }, labelText),
      el('input', { class: 'input-text', ...attrs }),
    );

    const cardName = field('שם בעל/ת הכרטיס', { type: 'text', autocomplete: 'cc-name', placeholder: 'ישראל ישראלי' });
    const cardNum = field('מספר כרטיס', { type: 'text', inputmode: 'numeric', autocomplete: 'cc-number', placeholder: '4580 0000 0000 0000' });
    const cardExp = field('תוקף', { type: 'text', inputmode: 'numeric', autocomplete: 'cc-exp', placeholder: 'MM/YY' });
    const cardCvc = field('CVC', { type: 'text', inputmode: 'numeric', autocomplete: 'cc-csc', placeholder: '123' });

    const payBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'שלמו והמשיכו ←');
    let done = false;
    payBtn.addEventListener('click', () => {
      if (done) return;
      done = true;
      resolve();
    });

    card.replaceChildren(
      el('h1', {}, 'כמעט שם — פרטי תשלום'),
      el('p', { class: 'subtitle', style: 'margin-bottom:14px' },
        `מנוי רובין ל־${email || 'העסק שלכם'}. זהו שלב זמני — אין צורך בפרטי תשלום אמיתיים בשלב הזה.`),
      cardName,
      cardNum,
      el('div', { style: 'display:flex;gap:12px' },
        el('div', { style: 'flex:1' }, cardExp),
        el('div', { style: 'flex:1' }, cardCvc),
      ),
      payBtn,
    );
  });
}

// POST the onboarding payload (incl. the taste profile) to the v7 signup
// endpoint. It creates/updates the account, saves the profile and emails the
// magic link. Never returns a session. Throws with the server's (Hebrew)
// message on failure — including the friendly 429 when a link was sent < ~60s
// ago.
async function postV7Signup(payload) {
  const r = await fetch('/api/v7/account/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const err = new Error(data?.error || r.statusText || 'signup failed');
    err.status = r.status;   // 429 = Supabase's ~60s per-user email interval
    throw err;
  }
  return data;
}

/* =========================================================================
   A7 — taste-profile bar → signup → "check your email". Awaits the background
   generateTasteProfile promise (usually already resolved), then signs up with
   the profile + audit tally, then shows the check-email screen. On a
   taste-profile error, a retry screen re-fires the Gemini call; on a signup
   error, a retry screen re-posts signup only (the profile is kept).
   Resolves once the check-email screen is showing.
   ========================================================================= */
export function runTasteProfileBar({ tasteProfilePromise, signupPayload, genreTally, retry }) {
  return new Promise((resolve) => {
    const payloadFor = (profile) => ({
      ...(signupPayload || {}),
      tasteProfile: profile,
      genreTally: Array.isArray(genreTally) ? genreTally : [],
    });

    const signUp = async (profile) => {
      const payload = payloadFor(profile);
      try {
        await Promise.all([postV7Signup(payload), sleep(MIN_BAR_MS)]);
      } catch (err) {
        showSignupError(err, profile);
        return;
      }
      showCheckEmail({ email: payload.email, resend: () => postV7Signup(payload) });
      resolve();
    };

    const run = async (promise) => {
      renderBar();
      let result;
      try {
        const [r] = await Promise.all([
          Promise.resolve(promise).catch((e) => ({ error: 'matcher_error', reasoning_en: e?.message || String(e) })),
          sleep(MIN_BAR_MS),
        ]);
        result = r;
      } catch (e) {
        result = { error: 'matcher_error', reasoning_en: e?.message || String(e) };
      }

      if (!result || result.error) {
        showRetry(result);
        return;
      }
      await signUp(result.profile || result);
    };

    const showRetry = (result) => {
      const card = getCard();
      const insufficient = result?.error === 'insufficient_signal';
      const body = insufficient
        ? 'לא הצלחנו ללמוד מספיק מהבחירות שלכם, אבל אפשר לנסות שוב.'
        : 'משהו השתבש בהתאמת הטעם המוזיקלי. בואו ננסה שוב.';
      const btn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'נסו שוב');
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        btn.disabled = true;
        run(Promise.resolve().then(() => retry()));
      });
      card.replaceChildren(
        el('h1', {}, 'רגע אחד…'),
        el('p', { class: 'subtitle', style: 'margin-bottom:14px' }, body),
        btn,
      );
    };

    // Profile computed fine, but signup failed (network / server / email send).
    // Retry the SIGNUP only — no need to re-run the expensive Gemini call.
    const showSignupError = (err, profile) => {
      const card = getCard();
      const btn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'נסו שוב');
      const msg = el('p', { class: 'hint', style: 'color:#ff9b8a;font-size:13px;min-height:18px' },
        String(err?.message || ''));
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        btn.disabled = true;
        renderBar();
        signUp(profile);
      });
      card.replaceChildren(
        el('h1', {}, 'כמעט מוכן…'),
        el('p', { class: 'subtitle', style: 'margin-bottom:14px' },
          'הפרופיל המוזיקלי מוכן, אבל לא הצלחנו להשלים את ההרשמה. ננסה שוב.'),
        btn,
        msg,
      );
    };

    run(tasteProfilePromise);
  });
}

// "Check your email" — mirror of v6's showCheckEmailState. The magic link is
// the only way into the account; resend re-posts the same signup payload
// (idempotent server-side).
//
// Resend waits out a 60-second countdown — Supabase sends at most one login
// email per user per ~60s, so an earlier click could only fail. The countdown
// starts when this screen appears (the email just went out) and restarts
// after every resend, including a 429 from the server.
const RESEND_COOLDOWN_S = 60;
function showCheckEmail({ email, resend }) {
  const card = getCard();
  const msg = el('p', { class: 'hint', style: 'margin-top:10px' }, '');
  const READY_LABEL = 'לא הגיע? שלחו שוב';
  const resendBtn = el('button', { class: 'btn-ghost', type: 'button', style: 'display:block;margin-inline:auto' }, READY_LABEL);

  let timer = null;
  const setWaiting = (waiting) => {
    resendBtn.disabled = waiting;
    resendBtn.style.opacity = waiting ? '.6' : '';
    resendBtn.style.cursor = waiting ? 'default' : '';
  };
  const startCooldown = () => {
    clearInterval(timer);
    const until = Date.now() + RESEND_COOLDOWN_S * 1000;
    const tick = () => {
      // The card may have been replaced — stop quietly.
      if (!resendBtn.isConnected) { clearInterval(timer); return; }
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(timer);
        setWaiting(false);
        resendBtn.textContent = READY_LABEL;
        return;
      }
      setWaiting(true);
      resendBtn.textContent = `לא הגיע? אפשר לשלוח שוב בעוד ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    };
    tick();
    timer = setInterval(tick, 250);
  };

  resendBtn.addEventListener('click', async () => {
    if (resendBtn.disabled) return;
    setWaiting(true);
    resendBtn.textContent = 'שולחים…';
    msg.style.color = '';
    msg.textContent = '';
    try {
      await resend();
      msg.style.color = 'var(--teal-soft)';
      msg.textContent = 'שלחנו שוב ✓';
      startCooldown();
    } catch (err) {
      msg.style.color = '#ff9b8a';
      msg.textContent = String(err?.message || 'שליחה נכשלה — נסו עוד רגע');
      if (err?.status === 429) startCooldown();
      else { setWaiting(false); resendBtn.textContent = READY_LABEL; }
    }
  });
  startCooldown();

  card.replaceChildren(
    el('h1', {}, 'בדקו את המייל ✉️'),
    el('p', { class: 'subtitle', style: 'margin-bottom:8px' },
      `שלחנו קישור כניסה חד־פעמי אל ${email}`),
    el('p', { class: 'hint', style: 'margin-top:14px' },
      'הפרופיל המוזיקלי שלכם כבר שמור בחשבון — לחצו על הקישור במייל כדי להיכנס.'),
    resendBtn,
    msg,
  );
}

function renderBar() {
  const card = getCard();
  card.replaceChildren(
    el('h1', {}, 'בונים את הפרופיל המוזיקלי שלכם'),
    el('div', { class: 'preview-load-column' },
      el('p', { class: 'preview-load-label' },
        'מנתחים את כל הבחירות שלכם והופכים אותן לפרופיל טעם מלא…'),
      el('div', { class: 'preview-load-progress' },
        // taste-profile-fill: this bar fills over 35s (the swipe-deck loaders
        // keep the shared 25s) — see v7/index.html.
        el('div', { class: 'preview-load-progress-fill taste-profile-fill' }),
      ),
    ),
  );
}
