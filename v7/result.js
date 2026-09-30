// v7 checkout screens: registration (email + password) → payment (Hyp) →
// taste-profile bar → "check your email". Replaces v6's step-6 example-playlist
// build entirely: v7 directions are diagnostic PROBES that dissolve into a
// flat, full-catalog taste profile (via generateTasteProfile), so there are no
// per-direction example playlists to show here.
//
// Flow (all render into .screen-card and resolve when the owner advances):
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
import { invoiceEmailFor } from '/shared/invoice-email.js?v=29092026a';

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
      el('h1', {}, 'הכל מוכן! הירשמו עכשיו'),
      el('p', { class: 'subtitle', style: 'margin-bottom:12px' },
        'השאירו אימייל ובחרו סיסמה כדי לשמור את הפרופיל המוזיקלי שלכם ולהתחיל לקבל פלייליסטים יומיים.'),
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
   A5 — Payment, all on one page: our details form on top, Hyp's card form
   (hosted page, template 6 — card fields only) in an iframe right under it.
   An automatic monthly charge (Hyp-managed recurring agreement). Resolves
   with the PAID checkout id, which signup requires.

   Hyp needs the details inside the signed request, so the card form loads
   a moment after the name is typed (its collapsible "פרטי תשלום" section,
   closed until then, opens by itself), and is re-signed + reloaded whenever
   a detail changes (one checkout row per page — the server updates it).
   Owners fill top-down, so a reload normally happens before any card digits
   are typed.

   Server side lives in api/v7/payment/: checkout (sign) → Hyp → return
   (verify + mark paid, then postMessage here) → status (polled here too, so a
   lost message never strands the owner).

   A paid checkout that no signup has used yet is remembered in localStorage,
   so a refresh mid-funnel never charges the owner twice. Cleared after a
   successful signup.
   ========================================================================= */
const PAID_CHECKOUT_KEY = 'rubin-v7-paid-checkout';
const STATUS_POLL_MS = 3000;

function rememberPaidCheckout(id) { try { localStorage.setItem(PAID_CHECKOUT_KEY, id); } catch { /* private mode */ } }
function forgetPaidCheckout() { try { localStorage.removeItem(PAID_CHECKOUT_KEY); } catch { /* private mode */ } }
function storedPaidCheckout() { try { return localStorage.getItem(PAID_CHECKOUT_KEY) || ''; } catch { return ''; } }

async function checkoutStatus(id) {
  const r = await fetch(`/api/v7/payment/status?id=${encodeURIComponent(id)}`);
  return r.ok ? r.json().catch(() => null) : null;
}

const ils = (n) => `₪${Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;
const HEBREW_RE = /[\u0590-\u05FF]/;
const PRICE_TAIL = 'חיוב חודשי אוטומטי · חשבונית מס נשלחת למייל';
const IS_LOCALHOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const NAME_SETTLE_MS = 700;   // pause after typing the name before loading the card form

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
  return new Promise((resolve) => {
    const card = getCard();
    let finished = false;
    let checkoutId = '';   // this page's checkout — the server keeps it across re-signs
    let signedKey = '';    // the details the card form on screen was signed with
    let signSeq = 0;       // drops responses from sign requests an edit superseded

    const finish = (id) => {
      if (finished) return;
      finished = true;
      clearInterval(pollTimer);
      window.removeEventListener('message', onMessage);
      rememberPaidCheckout(id);
      resolve(id);
    };

    // ---- the page ----
    const priceEl = el('p', { class: 'subtitle', style: 'margin-bottom:6px' }, PRICE_TAIL);
    const envEl = el('p', { class: 'hint', style: 'margin:0 0 10px;color:var(--accent)' }, 'מסוף בדיקות · אין חיוב אמיתי');
    envEl.hidden = true;
    // Where Hyp sends the invoice — the account email without any "+tag"
    // (Hyp mangles "+"; see shared/invoice-email.js).
    const invoiceEl = el('p', { class: 'hint', style: 'margin:0 0 12px' },
      'החשבונית תישלח אל ', el('span', { dir: 'ltr' }, invoiceEmailFor(email)));

    const field = (label, attrs, hint = null) => {
      const input = el('input', { class: 'input-text', type: 'text', ...attrs });
      const wrap = el('div', { class: 'input-wrap' }, el('label', { class: 'input-label' }, label), input, hint);
      return { input, wrap };
    };
    const name = field('שם מלא (בעל/ת הכרטיס)', { autocomplete: 'cc-name' });
    const address = field('כתובת (לא חובה)', { autocomplete: 'street-address' });
    const bizName = field('שם העסק (לא חובה)', { autocomplete: 'organization' },
      el('p', { class: 'hint', style: 'margin:6px 0 0;text-align:start' }, 'אם תמלאו, החשבונית תונפק על שם העסק'));
    const taxId = field('ח.פ / ע.מ (לא חובה)', { inputmode: 'numeric', autocomplete: 'off' });
    const couponStatus = el('p', { class: 'hint', style: 'margin:6px 0 0;text-align:start;min-height:16px' }, '');
    const coupon = field('קוד קופון (לא חובה)', { autocomplete: 'off' }, couponStatus);
    coupon.wrap.hidden = true;   // shown only while coupons are on (server switch)
    const fields = [name, address, bizName, taxId, coupon];

    const msg = el('p', { class: 'hint', style: 'color:#ff9b8a;font-size:13px;min-height:18px' }, '');
    const frameBox = el('div', {
      style: 'margin-top:10px;border-radius:14px;overflow:hidden;background:#fff;transition:opacity .2s',
    });

    // The card form sits in a collapsible "פרטי תשלום" section: closed until
    // it can load, then it opens by itself — once; after that it stays where
    // the owner leaves it.
    const payChev = el('span', { class: 'pay-chev', 'aria-hidden': 'true' });
    payChev.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"'
      + ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    const payToggle = el('button', { class: 'pay-toggle', type: 'button', 'aria-expanded': 'false' },
      el('span', {}, 'פרטי תשלום'), payChev);
    const setPayOpen = (open) => {
      payToggle.setAttribute('aria-expanded', String(open));
      frameBox.hidden = !open;
    };
    payToggle.addEventListener('click', () => setPayOpen(payToggle.getAttribute('aria-expanded') !== 'true'));
    let autoOpened = false;
    const autoOpen = () => {
      if (autoOpened) return;
      autoOpened = true;
      setPayOpen(true);
    };
    setPayOpen(false);

    fetch('/api/v7/payment/checkout').then((r) => r.json()).then((d) => {
      if (d?.amountMonthly && !signedKey) priceEl.textContent = `${ils(d.amountMonthly)} לחודש · ${PRICE_TAIL}`;
      envEl.hidden = d?.env !== 'test';
      if (d?.couponsEnabled) coupon.wrap.hidden = false;
    }).catch(() => {});

    // In place of the card form: why it isn't showing, optionally with a retry.
    const showPlaceholder = (text, retry = false) => {
      signedKey = '';
      frameBox.style.opacity = '';
      const note = el('p', { class: 'hint', style: 'margin:0;color:#5b6b75' }, text);
      const children = [note];
      if (retry) {
        const btn = el('button', { class: 'btn-ghost', type: 'button', style: 'color:#1b2a33;margin-top:8px' }, 'נסו שוב');
        btn.addEventListener('click', () => sign({ force: true }));
        children.push(btn);
      }
      frameBox.replaceChildren(el('div', { style: 'padding:36px 16px;text-align:center' }, ...children));
    };

    const readForm = () => ({
      name:                name.input.value.trim(),
      address:             address.input.value.trim(),
      invoiceBusinessName: bizName.input.value.trim(),
      taxId:               taxId.input.value.trim(),
      coupon:              coupon.wrap.hidden ? '' : coupon.input.value.trim(),
    });

    // Coupon feedback under the field: animated dots while it's checked, then
    // ✓ (with the first-month price) or ✗. Checked a moment after typing
    // stops, and again when the field is left.
    let couponSeq = 0;
    let couponChecked = '';
    const showCoupon = (text, color = '') => {
      couponStatus.style.color = color;
      setWaitText(couponStatus, text);
    };
    const couponInvalid = () => showCoupon('✗ קוד הקופון לא תקף', '#ff9b8a');
    const checkCoupon = async () => {
      const code = coupon.input.value.trim().toUpperCase();
      if (code === couponChecked) return;
      couponChecked = code;
      const seq = ++couponSeq;
      if (!code) { showCoupon(''); return; }
      showCoupon('בודקים את הקופון…');
      let d = null;
      try {
        const r = await fetch(`/api/v7/payment/checkout?coupon=${encodeURIComponent(code)}`);
        d = r.ok ? await r.json() : null;
      } catch { d = null; }
      if (seq !== couponSeq) return;
      if (d?.couponValid) {
        showCoupon(`✓ הקופון הופעל: ${d.percentOff}% הנחה בחודש הראשון (${ils(d.amountFirst)} במקום ${ils(d.amountMonthly)})`,
          'var(--teal-soft)');
      } else if (d) {
        couponInvalid();
      } else {
        couponChecked = '';   // let the next attempt re-check
        showCoupon('לא הצלחנו לבדוק את הקופון', '#ff9b8a');
      }
    };
    let couponTimer = null;
    coupon.input.addEventListener('input', () => {
      clearTimeout(couponTimer);
      couponTimer = setTimeout(checkCoupon, NAME_SETTLE_MS);
    });
    coupon.input.addEventListener('change', () => {
      clearTimeout(couponTimer);
      checkCoupon();
    });

    // One sign at a time: a request fired before the previous one answered
    // wouldn't know this page's checkoutId yet and would open a second
    // checkout row. Queued calls re-read the form, so a burst collapses.
    let signChain = Promise.resolve();
    const sign = (opts) => (signChain = signChain.then(() => signNow(opts)).catch(() => {}));

    // (Re)sign with the current details and load Hyp's card form under them.
    const signNow = async ({ force = false, note = '' } = {}) => {
      if (finished) return;
      const form = readForm();
      if (!form.name) { showPlaceholder('מלאו שם מלא כדי להמשיך לפרטי הכרטיס'); return; }
      const key = JSON.stringify(form);
      if (!force && key === signedKey) return;
      const seq = ++signSeq;
      msg.textContent = note;
      frameBox.style.opacity = '.45';
      const { coupon: couponCode, ...billing } = form;
      let status = 0;
      let data = {};
      try {
        const r = await fetch('/api/v7/payment/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, businessName, onboardingSessionId, checkoutId, coupon: couponCode, billing }),
        });
        status = r.status;
        data = await r.json().catch(() => ({}));
      } catch { /* network — status stays 0 */ }
      if (seq !== signSeq || finished) return;

      if (!(status === 200 && data.paymentUrl)) {
        // Never leave a card form signed with stale details on screen.
        if (status === 400) {
          showPlaceholder('תקנו את הפרטים למעלה כדי להמשיך');
          msg.textContent = HEBREW_RE.test(data.error || '') ? data.error : 'בדקו את הפרטים';
        } else {
          showPlaceholder('לא הצלחנו לטעון את טופס התשלום', true);
          msg.textContent = HEBREW_RE.test(data.error || '') ? data.error
            : status ? 'משהו השתבש — נסו שוב' : 'אין חיבור — נסו שוב';
        }
        autoOpen();
        return;
      }

      checkoutId = data.checkoutId;
      signedKey = key;
      // An unknown coupon doesn't block anything — the page is signed at full
      // price; keep the ✗ under the field in sync.
      if (data.couponRejected) couponInvalid();
      priceEl.textContent = data.coupon
        ? `חודש ראשון ${ils(data.amountFirst)} (קופון ${data.coupon.code}, ${data.coupon.percentOff}% הנחה), ואחר כך ${ils(data.amountMonthly)} לחודש`
        : `${ils(data.amountMonthly)} לחודש · ${PRICE_TAIL}`;
      frameBox.style.opacity = '';
      frameBox.replaceChildren(el('iframe', {
        src: data.paymentUrl,
        title: 'פרטי כרטיס — דף תשלום מאובטח',
        // Local test runs only: Chrome blocks Hyp's (public) page from
        // redirecting the frame to our localhost return URL unless the frame
        // may request local-network access. Never needed on the real site.
        allow: IS_LOCALHOST ? 'payment; local-network-access' : 'payment',
        allowpaymentrequest: '',
        style: 'display:block;width:100%;height:540px;border:0;background:#fff',
      }));
      autoOpen();
    };

    for (const f of fields) {
      f.input.addEventListener('change', () => sign());
      f.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sign(); }
      });
    }
    // The name alone is enough to load the card form, so don't wait for the
    // owner to leave the field: sign as soon as they stop typing it.
    let nameTimer = null;
    name.input.addEventListener('input', () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => sign(), NAME_SETTLE_MS);
    });

    // Paid? The return page (inside the frame, same origin) posts a message;
    // the poll catches it too if the message is lost.
    const check = async () => {
      if (!frameBox.isConnected) { clearInterval(pollTimer); window.removeEventListener('message', onMessage); return; }
      if (!checkoutId) return;
      const s = await checkoutStatus(checkoutId).catch(() => null);
      if (s?.status === 'paid') finish(checkoutId);
    };
    function onMessage(e) {
      if (e.origin !== location.origin || e.data?.source !== 'rubin-hyp') return;
      if (!checkoutId || e.data.checkoutId !== checkoutId) return;
      if (e.data.status === 'paid') check();
      // A failed checkout can't be re-signed — this starts a fresh one.
      else if (e.data.status === 'failed') sign({ force: true, note: 'התשלום לא אושר. אפשר לנסות שוב.' });
    }
    window.addEventListener('message', onMessage);
    const pollTimer = setInterval(check, STATUS_POLL_MS);

    showPlaceholder('מלאו שם מלא כדי להמשיך לפרטי הכרטיס');
    card.replaceChildren(
      el('h1', {}, 'כמעט שם — מנוי רובין'),
      priceEl,
      envEl,
      invoiceEl,
      name.wrap,
      address.wrap,
      bizName.wrap,
      taxId.wrap,
      coupon.wrap,
      payToggle,
      frameBox,
      msg,
    );
    name.input.focus();

    // Already paid (this tab, or before a refresh) and not used by a signup
    // yet → skip straight on.
    const reuse = paidCheckoutId || storedPaidCheckout();
    if (reuse) {
      checkoutStatus(reuse).then((s) => {
        if (s?.status === 'paid' && !s.claimed) finish(reuse);
        else if (s?.claimed || s?.status === 'failed') forgetPaidCheckout();
      }).catch(() => {});
    }
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
