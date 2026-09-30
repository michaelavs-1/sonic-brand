// Step 4, Option 1: test playlists per direction, for Ami's look at the
// per-track energy value (track_analyses.energy, 0-100).
//   🎲 → 50 random tracks from the direction's genres, drawn like an
//        Option-1 daily playlist.
//   ⚡ → a modal with an energy range slider → 50 random tracks from the same
//        pool whose energy is in the range.
// Both are built on Rubin's Spotify account by /api/v7/ami/test-playlist and
// deleted by the expire cron after 3 days.
//
// Builds run one at a time (a queue), and never while one of the crons is
// writing to Spotify: the endpoint answers 'cron-running', the build moves to
// the back of the line and retries every WAIT_MS, with a message saying why.

const API = '/api/v7/ami/test-playlist';
const WAIT_MS = 20000;

const CRON_NAMES_HE = {
  'v7-daily': 'הבנייה היומית של הפלייליסטים ללקוחות',
  expire:     'ניקוי הפלייליסטים שפג תוקפם',
};

// Keeps "30–60" in order inside Hebrew (RTL) text.
const ltr = (s) => `\u2066${s}\u2069`;
const range = (a, b) => ltr(`${a}–${b}`);

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- queue + API ----------

let chain = Promise.resolve();
let active = 0;

// Runs job(report) after every earlier build. report(text, kind) updates the
// caller's status line.
function enqueue(job, report) {
  if (active > 0) report('ממתין בתור — פלייליסט אחר נבנה כרגע…', 'warn');
  active++;
  const run = chain.then(() => job(report)).finally(() => { active--; });
  chain = run.catch(() => {});
  return run;
}

async function cronsRunningNow() {
  try {
    const r = await fetch(API);
    const d = await r.json().catch(() => ({}));
    return Array.isArray(d.cronsRunning) ? d.cronsRunning : [];
  } catch { return []; }   // the POST checks again anyway
}

function cronMessage(crons) {
  const names = crons.map((c) => CRON_NAMES_HE[c] || c).join(' ו');
  return `כרגע רצה ב-Spotify משימה מתוזמנת של רובין (${names}). כדי לא להתנגש בה, הבקשה הועברה לסוף התור ` +
    `ותרוץ לבד כשהמשימה תסתיים (בודקים כל ${WAIT_MS / 1000} שניות).`;
}

// → { status, data }
async function build(payload, report) {
  for (;;) {
    const crons = await cronsRunningNow();
    if (crons.length) {
      report(cronMessage(crons), 'warn');
      await sleep(WAIT_MS);
      continue;
    }
    report('בונים את הפלייליסט…', '');
    let r, data;
    try {
      r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await r.json().catch(() => ({}));
    } catch (e) {
      return { status: 0, data: { error: e.message || 'network error' } };
    }
    if (r.status === 409 && data.code === 'cron-running') {
      report(cronMessage(data.cronsRunning || []), 'warn');
      await sleep(WAIT_MS);
      continue;
    }
    return { status: r.status, data };
  }
}

// → { text, kind: 'ok'|'warn'|'err', url?, label? }
function outcome(payload, { status, data }) {
  const energy = payload.kind === 'energy';
  const r = energy ? range(payload.energyMin, payload.energyMax) : null;
  if (data.ok) {
    const n = data.trackCount;
    const actual = data.energy
      ? ` אנרגיה בפועל: ${range(data.energy.min, data.energy.max)}, ממוצע ${data.energy.avg}.`
      : '';
    const label = `${energy ? `אנרגיה ${r}` : 'אקראי'} · ${n} שירים`;
    if (n < data.requested) {
      const text = energy
        ? `נמצאו רק ${n} שירים בטווח ${r} — נוצר פלייליסט עם ${n} שירים.${actual}`
        : `בז'אנרים של הכיוון יש רק ${n} שירים — נוצר פלייליסט עם ${n} שירים.${actual}`;
      return { text, kind: 'warn', url: data.url, label };
    }
    const text = energy
      ? `נוצר פלייליסט עם ${n} שירים (מתוך ${data.matches} שירים בטווח ${r}).${actual}`
      : `נוצר פלייליסט עם ${n} שירים.${actual}`;
    return { text, kind: 'ok', url: data.url, label };
  }
  if (data.code === 'no-tracks') {
    return {
      text: energy
        ? `אין אף שיר בטווח האנרגיה ${r} בז'אנרים של הכיוון — לא נוצר פלייליסט.`
        : `לא נמצאו שירים בז'אנרים של הכיוון — לא נוצר פלייליסט.`,
      kind: 'err',
    };
  }
  if (data.code === 'spotify-paused') {
    return { text: 'Spotify הגביל זמנית את הכתיבה לחשבון של רובין — לא נוצר פלייליסט. נסו שוב מאוחר יותר.', kind: 'err' };
  }
  if (data.code === 'needs-migration') {
    return {
      text: 'בחירת שירים לפי אנרגיה עוד לא הותקנה במסד הנתונים (המיגרציה 2026-09-30-v7-energy-tracks.sql) — לא נוצר פלייליסט.',
      kind: 'err',
    };
  }
  if (status === 429) return { text: 'יותר מדי פלייליסטים בשעה האחרונה — נסו שוב בעוד כמה דקות.', kind: 'err' };
  return { text: `שגיאה: ${data.error || `HTTP ${status}`} — לא נוצר פלייליסט.`, kind: 'err' };
}

// ---------- UI ----------

function setStatus(node, text, kind = '') {
  node.textContent = text;
  node.className = `status-line${kind ? ` ${kind}` : ''}`;
}

function spin(btn, on, label) {
  btn.disabled = on;
  if (on) btn.replaceChildren(el('span', { class: 'sb-spinner' }));
  else btn.textContent = label;
}

// One created playlist: its number in the list (1 = the first built), label
// and an open button. Newest on top.
function createdItem({ label, url }, n) {
  return el('div', { class: 'tp-created-item' },
    el('span', {}, `${ltr(`${n}.`)} ${label}`),
    el('a', { class: 'btn btn-secondary btn-sm', href: url, target: '_blank', rel: 'noopener' }, 'פתחו את הפלייליסט ↗'));
}

function payloadBase(direction, profile) {
  return {
    title:    direction.title_en,
    genres:   direction.genres,
    instPref: profile.instrumentalness_preference || 'none',
    popPref:  profile.popularity_preference || 'none',
  };
}

// 🎲 — 50 random tracks, straight from the row.
function plainControls(direction, profile) {
  const LABEL = '🎲 50 שירים אקראיים';
  const btn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, LABEL);
  const status = el('div', { class: 'status-line' });
  const created = el('div', { class: 'tp-created' });
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    spin(btn, true);
    const payload = { kind: 'plain', ...payloadBase(direction, profile) };
    const report = (t, k) => setStatus(status, t, k);
    try {
      const res = await enqueue((rep) => build(payload, rep), report);
      const o = outcome(payload, res);
      setStatus(status, o.text, o.kind);
      if (o.url) created.prepend(createdItem(o, created.children.length + 1));
    } finally {
      spin(btn, false, LABEL);
    }
  });
  return { btn, status, created };
}

// ⚡ — the modal body for one direction (kept, so its state survives closing).
function energyBody(direction, profile) {
  const LABEL = 'צור פלייליסט (50 שירים) ←';
  const lo = el('input', { type: 'range', min: '0', max: '100', step: '1', value: '30', class: 'lo', 'aria-label': 'אנרגיה מינימלית' });
  const hi = el('input', { type: 'range', min: '0', max: '100', step: '1', value: '70', class: 'hi', 'aria-label': 'אנרגיה מקסימלית' });
  const fill = el('div', { class: 'erange-fill' });
  const value = el('b');
  const paint = () => {
    const a = Number(lo.value), b = Number(hi.value);
    fill.style.left = `${a}%`;
    fill.style.width = `${b - a}%`;
    value.textContent = range(a, b);
  };
  lo.addEventListener('input', () => { if (Number(lo.value) > Number(hi.value)) lo.value = hi.value; paint(); });
  hi.addEventListener('input', () => { if (Number(hi.value) < Number(lo.value)) hi.value = lo.value; paint(); });
  paint();

  const btn = el('button', { class: 'btn btn-primary', type: 'button' }, LABEL);
  const status = el('div', { class: 'status-line' });
  const created = el('div', { class: 'tp-created' });

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    lo.disabled = hi.disabled = true;
    spin(btn, true);
    const payload = {
      kind: 'energy', ...payloadBase(direction, profile),
      energyMin: Number(lo.value), energyMax: Number(hi.value),
    };
    const report = (t, k) => setStatus(status, t, k);
    try {
      const res = await enqueue((rep) => build(payload, rep), report);
      const o = outcome(payload, res);
      setStatus(status, o.text, o.kind);
      if (o.url) created.prepend(createdItem(o, created.children.length + 1));
    } finally {
      lo.disabled = hi.disabled = false;
      spin(btn, false, LABEL);
    }
  });

  return el('div', {},
    el('div', { class: 'tp-range-label' }, 'טווח אנרגיה: ', value),
    el('div', { class: 'erange', dir: 'ltr' }, el('div', { class: 'erange-track' }), fill, lo, hi),
    el('div', { class: 'erange-scale', dir: 'ltr' }, el('span', {}, '0 רגוע'), el('span', {}, '50'), el('span', {}, 'אנרגטי 100')),
    el('div', { class: 'btn-row' }, btn),
    status,
    created,
  );
}

// The modal shell — one for the page; each direction brings its own body.
let modal = null;
function openModal(direction, body) {
  if (!modal) {
    const title = el('div', { class: 'card-title' });
    const genres = el('div', { class: 'tp-genres' });
    const slot = el('div');
    const close = () => { modal.root.hidden = true; };
    const root = el('div', { class: 'tp-backdrop', hidden: '' },
      el('div', { class: 'tp-modal', role: 'dialog', 'aria-modal': 'true' },
        el('button', { class: 'tp-close', type: 'button', 'aria-label': 'סגירה', onclick: close }, '✕'),
        title, genres, slot));
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });
    document.body.append(root);
    modal = { root, title, genres, slot };
  }
  modal.title.textContent = `⚡ פלייליסט לפי אנרגיה — ${direction.title_en}`;
  modal.genres.textContent = direction.genres.join(', ');
  modal.slot.replaceChildren(body);
  modal.root.hidden = false;
}

// The whole section for one Option-1 result; the caller keeps the element,
// so builds in flight keep updating it across repaints.
export function renderTestPlaylists({ directions, profile }) {
  const prefs = `אינסטרומנטלי: ${profile.instrumentalness_preference || 'none'}, פופולריות: ${profile.popularity_preference || 'none'}`;
  const list = el('div', { class: 'tp-list' });
  for (const tier of ['high', 'low']) {
    directions.filter((d) => d.energy_tier === tier).forEach((d, i) => {
      const plain = plainControls(d, profile);
      let body = null;
      const energyBtn = el('button', {
        class: 'btn btn-secondary btn-sm', type: 'button',
        onclick: () => { body = body || energyBody(d, profile); openModal(d, body); },
      }, '⚡ לפי אנרגיה');
      list.append(el('div', { class: 'tp-row' },
        el('div', { class: 'tp-head' },
          el('div', {},
            el('div', { class: 'tp-title' },
              el('span', { class: `tp-tier ${tier}` }, tier === 'high' ? 'גבוהה' : 'רגועה'),
              ' ',
              el('bdi', { dir: 'ltr' }, `${i + 1}. ${d.title_en}`)),
            el('div', { class: 'tp-genres' }, d.genres.join(', '))),
          el('div', { class: 'btn-row tp-actions' }, plain.btn, energyBtn)),
        plain.status,
        plain.created));
    });
  }
  return el('div', { class: 'tp-box' },
    el('div', { class: 'card-title' }, 'פלייליסטים לבדיקת אנרגיה'),
    el('div', { class: 'card-hint' },
      `לכל כיוון: 🎲 פלייליסט של 50 שירים אקראיים מהז'אנרים שלו, כמו בפלייליסט יומי; ⚡ אותו דבר, רק עם שירים שהאנרגיה ` +
      `שלהם (${range(0, 100)} בניתוח של כל שיר) בטווח שבוחרים. העדפות מפרופיל הטעם חלות על שניהם (${prefs}). ` +
      `הפלייליסטים נוצרים בחשבון ה-Spotify של רובין, אחד בכל פעם, ונמחקים אחרי 3 ימים.`),
    list);
}
