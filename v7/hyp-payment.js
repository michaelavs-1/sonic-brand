// v7 Hyp payment screen, shared by onboarding (v7/result.js → runPaymentStep)
// and the account page's subscription renewal (v7/account/app.js, 2026-10-06).
//
// All on one page: our details form on top, Hyp's card form (hosted page,
// template 6 — card fields only) in an iframe right under it. An automatic
// monthly charge (Hyp-managed recurring agreement).
//
// Hyp needs the details inside the signed request, so the card form loads
// a moment after the name is typed (its collapsible "פרטי תשלום" section,
// closed until then, opens by itself), and is re-signed + reloaded whenever
// a detail changes (one checkout row per page — the server updates it).
// Owners fill top-down, so a reload normally happens before any card digits
// are typed.
//
// Server side lives in api/v7/payment/: checkout (sign) → Hyp → return
// (verify + mark paid, then postMessage here) → status (polled here too, so a
// lost message never strands the owner).
//
//   mountHypPayment(container, {
//     heading, email, businessName,
//     onboardingSessionId?,            // onboarding
//     renewal?: { businessId, getToken },  // account renewal: the checkout is
//                                      // tied to the business (owner JWT)
//     prefill?: { name, address, invoiceBusinessName, taxId },
//   }) → { promise: Promise<paid checkoutId>, finish(id), destroy() }
//
// Its markup uses onboarding's classes (input-wrap, input-text, hint,
// pay-toggle, …), styled by v7/index.html. Other pages call
// ensureHypPaymentStyles() and mount inside a .hyp-pay element.

import { setWaitText } from '/v7/wait-dots.js?v=28092026a';
import { invoiceEmailFor } from '/shared/invoice-email.js?v=29092026a';

const STATUS_POLL_MS = 3000;
const NAME_SETTLE_MS = 700;   // pause after typing the name before loading the card form
const HEBREW_RE = /[֐-׿]/;
const PRICE_TAIL = 'חיוב חודשי אוטומטי · חשבונית מס נשלחת למייל';
const IS_LOCALHOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

const ils = (n) => `₪${Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;

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

export async function checkoutStatus(id) {
  const r = await fetch(`/api/v7/payment/status?id=${encodeURIComponent(id)}`);
  return r.ok ? r.json().catch(() => null) : null;
}

export function mountHypPayment(container, {
  heading, email, businessName, onboardingSessionId = null, renewal = null, prefill = null,
}) {
  let resolvePaid;
  const promise = new Promise((resolve) => { resolvePaid = resolve; });
  let finished = false;
  let checkoutId = '';   // this page's checkout — the server keeps it across re-signs
  let signedKey = '';    // the details the card form on screen was signed with
  let signSeq = 0;       // drops responses from sign requests an edit superseded
  let pollTimer = null;

  const stop = () => {
    clearInterval(pollTimer);
    window.removeEventListener('message', onMessage);
  };
  const finish = (id) => {
    if (finished) return;
    finished = true;
    stop();
    resolvePaid(id);
  };
  const destroy = () => {
    finished = true;
    stop();
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

  if (prefill) {
    name.input.value = prefill.name || '';
    address.input.value = prefill.address || '';
    bizName.input.value = prefill.invoiceBusinessName || '';
    taxId.input.value = prefill.taxId || '';
  }

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
      const headers = { 'Content-Type': 'application/json' };
      const body = { email, businessName, onboardingSessionId, checkoutId, coupon: couponCode, billing };
      if (renewal) {
        const token = await renewal.getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        body.renewBusinessId = renewal.businessId;
      }
      const r = await fetch('/api/v7/payment/checkout', { method: 'POST', headers, body: JSON.stringify(body) });
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
    if (!frameBox.isConnected) { stop(); return; }
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
  pollTimer = setInterval(check, STATUS_POLL_MS);

  showPlaceholder('מלאו שם מלא כדי להמשיך לפרטי הכרטיס');
  container.replaceChildren(
    el('h1', {}, heading),
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
  // Details filled in from last time → load the card form right away.
  if (prefill?.name) sign();

  return { promise, finish, destroy };
}

// The form's styles for pages other than onboarding (which has them in
// v7/index.html): the same rules, scoped to a .hyp-pay container. Injected once.
export function ensureHypPaymentStyles() {
  if (document.getElementById('hyp-pay-styles')) return;
  const style = document.createElement('style');
  style.id = 'hyp-pay-styles';
  style.textContent = `
    .hyp-pay h1 { font-size: 24px; font-weight: 900; margin: 0 0 6px; text-align: center; letter-spacing: .2px }
    .hyp-pay .subtitle { color: var(--muted); font-size: 14.5px; margin: 0 0 22px; text-align: center; line-height: 1.6 }
    .hyp-pay .input-wrap { margin-bottom: 8px }
    .hyp-pay .input-label { display: block; color: var(--muted); font-size: 12.5px; font-weight: 700; margin-bottom: 8px; letter-spacing: .3px }
    .hyp-pay .input-text { width: 100%; background: #0d1822; border: 1.5px solid var(--border-2); border-radius: 14px;
      padding: 15px 16px; font-family: inherit; font-size: 16px; color: var(--text); outline: none;
      transition: border-color .25s, box-shadow .25s, background .25s }
    .hyp-pay .input-text::placeholder { color: #5d707c }
    .hyp-pay .input-text:focus { border-color: var(--accent); background: #0e1a25; box-shadow: 0 0 0 4px rgba(240, 167, 63, .12) }
    .hyp-pay .input-text:-webkit-autofill, .hyp-pay .input-text:-webkit-autofill:hover {
      -webkit-text-fill-color: var(--text); caret-color: var(--text); box-shadow: 0 0 0 1000px #0d1822 inset }
    .hyp-pay .input-text:-webkit-autofill:focus {
      -webkit-text-fill-color: var(--text); box-shadow: 0 0 0 1000px #0e1a25 inset, 0 0 0 4px rgba(240, 167, 63, .12) }
    .hyp-pay .hint { color: var(--muted); font-size: 12px; margin-top: 14px; text-align: center }
    .hyp-pay .btn-ghost { background: none; border: none; color: var(--muted); font-size: 13px; cursor: pointer;
      margin-top: 14px; font-family: inherit; transition: color .2s }
    .hyp-pay .btn-ghost:hover { color: var(--text) }
    .hyp-pay .pay-toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
      margin-top: 10px; padding: 14px 0 4px; background: none; border: none; border-top: 1px solid var(--border);
      color: var(--text); font-family: inherit; font-size: 16px; font-weight: 800; text-align: right; cursor: pointer;
      transition: color .15s }
    .hyp-pay .pay-toggle:hover { color: var(--accent) }
    .hyp-pay .pay-chev { display: inline-flex; color: var(--muted); transition: transform .2s ease, color .15s }
    .hyp-pay .pay-toggle:hover .pay-chev { color: var(--accent) }
    .hyp-pay .pay-toggle[aria-expanded="true"] .pay-chev { transform: rotate(180deg) }
  `;
  document.head.append(style);
}
