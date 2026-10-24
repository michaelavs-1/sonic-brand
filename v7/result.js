// v7 checkout screens: registration (email + password) → payment (Hyp) →
// taste-profile bar → "check your email". Replaces v6's step-6 example-playlist
// build entirely: v7 directions are diagnostic PROBES that dissolve into a
// flat, full-catalog taste profile (via generateTasteProfile), so there are no
// per-direction example playlists to show here.
//
// Flow (all render into .screen-card and resolve when the owner advances):
//   runReadyStep({ bizName, venuePhrase }) -> Promise<void>              ("הכל מוכן!", 2026-10-21)
//   runRegistrationStep({ initialValue, initialPassword }) -> Promise<{ email, password }> (A4)
//   runPaymentStep({ email, businessName, onboardingSessionId, paidCheckoutId })
//                                                          -> Promise<checkoutId> (A5)
//   runTasteProfileBar({ tasteProfilePromise, signupPayload, genreTally, retry })  (A7)
//
// Auth (decided 2026-09-24 — email verification REQUIRED, same as v6): nothing
// here ever logs the owner in. Registration CAPTURES the email + password
// (held in memory only) and stops an already-registered email before payment.
// After the payment, the bar waits for the taste profile, then the v7 signup
// endpoint creates the account (with the password), saves the profile and
// emails a one-time magic link; this screen then shows "בדקו את המייל ✉️".
// Clicking the link is the verification step and lands the owner on
// /v7/account, logged in. Later logins use the password. No account exists
// for anyone who abandons before paying ("no non-paying clients").

import { waitNodes, setWaitText } from '/v7/wait-dots.js?v=28092026a';
import { PASSWORD_RULES_TEXT, passwordProblem } from '/shared/password-rules.js?v=28092026a';
import { mountHypPayment, checkoutStatus } from '/v7/hyp-payment.js?v=06102026a';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_BAR_MS = 2000; // let the "dissolving" bar breathe even when the call is already resolved

// The brand logo (the mascot), copied from the first screen at load, before the
// steps replace that screen's content. The "הכל מוכן!" screen shows it big.
const LOGO = document.querySelector('.brand-logo-orbit')?.cloneNode(true) || null;

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
   A3.5 — "הכל מוכן!" (Ami, 2026-10-21): right after the last swipe, before
   registration. "רובין בנה ל<name>, <phrase> שלכם, פרופיל מוזיקה." — the
   phrase is Round 1's venue_phrase_he (e.g. "המסעדה הסקסית"); without it
   the sentence skips it. The taste profile is still being built behind this
   screen; the bar after payment waits for it.
   Resolves when the owner clicks "סיימו את ההרשמה".
   ========================================================================= */
export function runReadyStep({ bizName = '', venuePhrase = null } = {}) {
  return new Promise((resolve) => {
    const card = getCard();
    const name = String(bizName || '').trim();
    const gold = (t) => el('span', { class: 'ready-gold' }, t);
    // "לפרא", but "ל־Cafe Louise" for a name that doesn't start in Hebrew.
    const to = /^[\u0590-\u05FF]/.test(name) ? 'ל' : 'ל־';
    const built = el('span', {});
    if (name && venuePhrase) built.append('רובין בנה ', to, gold(name), ', ', gold(venuePhrase), ' ', el('b', {}, 'שלכם'), ', פרופיל מוזיקה.');
    else if (name) built.append('רובין בנה ', to, gold(name), ' פרופיל מוזיקה.');
    else built.append('רובין בנה לכם פרופיל מוזיקה.');

    const goBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'סיימו את ההרשמה');
    goBtn.addEventListener('click', () => resolve(), { once: true });

    const logo = LOGO ? LOGO.cloneNode(true) : null;
    card.replaceChildren(
      el('h1', { class: 'ready-title' }, 'הכל מוכן!'),
      logo ? el('div', { class: 'ready-logo' }, logo) : null,
      el('p', { class: 'ready-text' },
        built,
        el('br'),
        'כדי להתחיל לקבל כל יום פלייליסטים מותאמים אישית - סיימו את ההרשמה',
      ),
      goBtn,
    );
    goBtn.focus();
  });
}

/* =========================================================================
   A4 — Registration: email + password. No account is created here (signup
   runs after payment). Before resolving, the email is checked against
   /api/v7/account/check-email — an already-registered owner is stopped here,
   before paying, and offered a link to log in instead.
   Resolves with { email (lowercased), password }.
   ========================================================================= */
export function runRegistrationStep({ initialValue = '', initialPassword = '' } = {}) {
  return new Promise((resolve) => {
    const card = getCard();

    const emailInput = el('input', {
      class: 'input-text',
      type: 'email',
      name: 'email',
      autocomplete: 'username',
      inputmode: 'email',
      placeholder: 'you@business.co.il',
    });
    emailInput.value = initialValue || existingSessionEmail() || '';

    const pwInput = el('input', {
      class: 'input-text',
      type: 'password',
      name: 'password',
      autocomplete: 'new-password',
    });
    pwInput.value = initialPassword || '';
    const pwToggle = passwordToggle(pwInput);

    const msg = el('p', { class: 'hint', style: 'color:#ff9b8a;font-size:13px;min-height:18px' }, '');
    const exists = el('div', { class: 'reg-exists' });
    exists.hidden = true;
    const goBtn = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'המשך ←');

    const setError = (text, input) => {
      msg.textContent = text;
      exists.hidden = true;
      if (input) { input.classList.add('err'); input.focus(); }
    };

    const showExists = (email) => {
      msg.textContent = '';
      exists.replaceChildren(
        el('p', {}, 'האימייל הזה כבר רשום אצלנו.'),
        el('a', {
          class: 'btn btn-secondary btn-block',
          href: `/v7/account?email=${encodeURIComponent(email)}`,
        }, 'להתחברות'),
      );
      exists.hidden = false;
    };

    let busy = false;
    const submit = async () => {
      if (busy) return;
      const email = emailInput.value.trim().toLowerCase();
      const password = pwInput.value;
      if (!EMAIL_RE.test(email)) return setError('הזינו כתובת אימייל תקינה', emailInput);
      const pwProblem = passwordProblem(password);
      if (pwProblem) return setError(pwProblem, pwInput);

      busy = true;
      goBtn.disabled = true;
      setWaitText(goBtn, 'בודקים…');
      msg.textContent = '';
      let registered = false;
      try {
        const r = await fetch('/api/v7/account/check-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        if (r.status === 429) {
          setError('יותר מדי ניסיונות — נסו שוב בעוד כמה דקות');
          return;
        }
        // Any other failure lets the owner continue — signup enforces the
        // same rule server-side.
        if (r.ok) registered = !!(await r.json().catch(() => ({}))).registered;
      } catch { /* network — continue, see above */ }
      finally {
        busy = false;
        goBtn.disabled = false;
        goBtn.textContent = 'המשך ←';
      }
      if (registered) { showExists(email); return; }
      busy = true;   // resolved — ignore further submits
      resolve({ email, password });
    };

    const form = el('form', { novalidate: '' },
      el('div', { class: 'input-wrap' },
        el('label', { class: 'input-label' }, 'אימייל'),
        emailInput,
      ),
      el('div', { class: 'input-wrap' },
        el('label', { class: 'input-label' }, 'בחרו סיסמה'),
        el('div', { class: 'pw-wrap' }, pwInput, pwToggle),
        el('p', { class: 'pw-hint' }, PASSWORD_RULES_TEXT),
      ),
      goBtn,
      msg,
      exists,
    );
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    for (const input of [emailInput, pwInput]) {
      input.addEventListener('input', () => {
        input.classList.remove('err');
        exists.hidden = true;
      });
    }

    card.replaceChildren(
      el('h1', {}, 'הרשמה'),
      el('p', { class: 'subtitle', style: 'margin-bottom:12px' },
        'שמרו את הפרופיל המוזיקלי שלכם והתחילו לקבל פלייליסטים יומיים'),
      form,
    );
    emailInput.focus();
  });
}

// Eye icon that flips a password input's visibility: open eye while hidden,
// crossed-out eye while shown.
const EYE_ICONS = '<svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
function passwordToggle(input) {
  const btn = el('button', { class: 'pw-toggle', type: 'button', 'aria-label': 'הצגת הסיסמה' });
  btn.innerHTML = EYE_ICONS;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('showing', show);
    btn.setAttribute('aria-label', show ? 'הסתרת הסיסמה' : 'הצגת הסיסמה');
  });
  return btn;
}

/* =========================================================================
   A5 — Payment. The screen itself (details form + Hyp's card form) lives in
   v7/hyp-payment.js, shared with the account page's subscription renewal.
   Resolves with the PAID checkout id, which signup requires.

   A paid checkout that no signup has used yet is remembered in localStorage,
   so a refresh mid-funnel never charges the owner twice. Cleared after a
   successful signup.
   ========================================================================= */
const PAID_CHECKOUT_KEY = 'rubin-v7-paid-checkout';

function rememberPaidCheckout(id) { try { localStorage.setItem(PAID_CHECKOUT_KEY, id); } catch { /* private mode */ } }
function forgetPaidCheckout() { try { localStorage.removeItem(PAID_CHECKOUT_KEY); } catch { /* private mode */ } }
function storedPaidCheckout() { try { return localStorage.getItem(PAID_CHECKOUT_KEY) || ''; } catch { return ''; } }

// Real payments can be switched off server-side (PAYMENTS_ENABLED in
// api/v7/payment/_hyp.js — off since 2026-09-28 until invoicing is connected
// to the company's own system). Off → the placeholder screen, resolving with
// '' (signup then doesn't require a checkout). If the switch can't be read,
// the Hyp screen is shown — the server stays the authority either way.
export async function runPaymentStep(opts) {
  const config = await fetch('/api/v7/payment/checkout').then((r) => r.json()).catch(() => null);
  if (config?.paymentsEnabled === false) return runPlaceholderPaymentStep(opts);
  return runHypPaymentStep(opts);
}

// The pre-Hyp placeholder: all fields optional, submitting just advances.
function runPlaceholderPaymentStep({ email }) {
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
      resolve('');
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

function runHypPaymentStep({ email, businessName, onboardingSessionId, paidCheckoutId }) {
  const pay = mountHypPayment(getCard(), {
    heading: 'כמעט שם — מנוי רובין', email, businessName, onboardingSessionId,
  });

  // Already paid (this tab, or before a refresh) and not used by a signup
  // yet → skip straight on.
  const reuse = paidCheckoutId || storedPaidCheckout();
  if (reuse) {
    checkoutStatus(reuse).then((s) => {
      if (s?.status === 'paid' && !s.claimed) pay.finish(reuse);
      else if (s?.claimed || s?.status === 'failed') forgetPaidCheckout();
    }).catch(() => {});
  }

  return pay.promise.then((id) => {
    rememberPaidCheckout(id);
    return id;
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
    err.code = data?.code || null;              // 'already_registered' | 'weak_password' | 'bad_password'
    err.businessId = data?.business_id || null; // set once the business exists
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

    // Once the first attempt has created the business, every later post
    // (retry after an error, "שלחו שוב") carries its id as resendFor — the
    // server only lets a not-yet-verified account with a business be
    // re-posted by the signup that created it.
    let resendFor = '';
    // Replaces the registration password when Supabase refused it.
    let passwordOverride = null;

    const signUp = async (profile) => {
      const payload = payloadFor(profile);
      if (passwordOverride) payload.password = passwordOverride;
      if (resendFor) payload.resendFor = resendFor;
      let data;
      try {
        [data] = await Promise.all([postV7Signup(payload), sleep(MIN_BAR_MS)]);
      } catch (err) {
        if (err.businessId) resendFor = err.businessId;
        showSignupError(err, profile);
        return;
      }
      forgetPaidCheckout();   // the payment now belongs to this account
      const resendPayload = { ...payload, resendFor: data.business_id };
      showCheckEmail({ email: payload.email, resend: () => postV7Signup(resendPayload) });
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
      if (err?.code === 'weak_password' || err?.code === 'bad_password') {
        showNewPassword(err, profile);
        return;
      }
      if (err?.code === 'already_registered') {
        showAlreadyRegistered(payloadFor(profile).email);
        return;
      }
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

    // Supabase refused the password (weak / leaked). Ask for another one and
    // retry the signup with it.
    const showNewPassword = (err, profile) => {
      const card = getCard();
      const pwInput = el('input', {
        class: 'input-text',
        type: 'password',
        name: 'password',
        autocomplete: 'new-password',
      });
      const msg = el('p', { class: 'hint', style: 'color:#ff9b8a;font-size:13px;min-height:18px' },
        String(err?.message || ''));
      const btn = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'המשך ←');
      const form = el('form', { novalidate: '' },
        el('div', { class: 'input-wrap' },
          el('label', { class: 'input-label' }, 'סיסמה חדשה'),
          el('div', { class: 'pw-wrap' }, pwInput, passwordToggle(pwInput)),
          el('p', { class: 'pw-hint' }, PASSWORD_RULES_TEXT),
        ),
        btn,
        msg,
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        const pwProblem = passwordProblem(pwInput.value);
        if (pwProblem) {
          msg.textContent = pwProblem;
          pwInput.classList.add('err');
          pwInput.focus();
          return;
        }
        btn.disabled = true;
        passwordOverride = pwInput.value;
        renderBar();
        signUp(profile);
      });
      pwInput.addEventListener('input', () => pwInput.classList.remove('err'));
      card.replaceChildren(
        el('h1', {}, 'בחרו סיסמה אחרת'),
        el('p', { class: 'subtitle', style: 'margin-bottom:14px' },
          'הפרופיל המוזיקלי מוכן — רק צריך סיסמה אחרת כדי להשלים את ההרשמה.'),
        form,
      );
      pwInput.focus();
    };

    // Registered in the meantime (e.g. another tab finished first). Nothing
    // to retry — send the owner to log in.
    const showAlreadyRegistered = (email) => {
      const card = getCard();
      card.replaceChildren(
        el('h1', {}, 'כבר יש לכם חשבון'),
        el('p', { class: 'subtitle', style: 'margin-bottom:14px' },
          `האימייל ${email} כבר רשום אצלנו. היכנסו לחשבון עם הסיסמה שלכם.`),
        el('a', {
          class: 'btn btn-primary btn-block',
          href: `/v7/account?email=${encodeURIComponent(email)}`,
          style: 'display:block;text-align:center;text-decoration:none',
        }, 'להתחברות'),
      );
    };

    run(tasteProfilePromise);
  });
}

// "Check your email" — mirror of v6's showCheckEmailState. The magic link
// verifies the email and logs the owner in (later visits use the password);
// resend re-posts the same signup payload + resendFor (idempotent
// server-side).
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
    setWaitText(resendBtn, 'שולחים…');
    msg.style.color = '';
    msg.textContent = '';
    try {
      await resend();
      msg.style.color = 'var(--teal-soft)';
      msg.textContent = 'שלחנו שוב ✓';
      startCooldown();
    } catch (err) {
      msg.style.color = '#ff9b8a';
      // The server's messages are Hebrew; a raw technical error isn't shown.
      const m = String(err?.message || '');
      msg.textContent = /[\u0590-\u05FF]/.test(m) ? m : 'שליחה נכשלה — נסו עוד רגע';
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
      'הפרופיל המוזיקלי שלכם כבר שמור בחשבון — לחצו על הקישור במייל כדי לאשר את האימייל ולהיכנס. בפעמים הבאות תיכנסו עם הסיסמה שבחרתם.'),
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
        ...waitNodes('מנתחים את כל הבחירות שלכם והופכים אותן לפרופיל טעם מלא…')),
      el('div', { class: 'preview-load-progress' },
        // taste-profile-fill: this bar fills over 35s (the swipe-deck loaders
        // keep the shared 25s) — see v7/index.html.
        el('div', { class: 'preview-load-progress-fill taste-profile-fill' }),
      ),
    ),
  );
}
