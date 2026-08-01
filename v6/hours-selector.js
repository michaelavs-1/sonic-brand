// v6 opening-hours selector.
//
// Follows the same contract as atmosphere.js / preview.js: renders into the
// current .screen-card and resolves with the picked hours when the user hits
// continue.
//
//   const { hours, longestMinutes } = await runHoursSelection({ prechecked });
//
// Data model
//   Each day tracks: { closed, override, open, close }.
//     - closed=true      → the row is disabled; day is a closed day.
//     - override=true    → day's hours are independent of the shared master.
//     - override=false   → hours mirror master; edits propagate to all other
//                          unlocked open days.
//   state.master keeps the shared open/close pair so unlocking a day snaps
//   it back to whatever the current master is.
//
// Defaults (when no `prechecked` supplied): everyone 10:00-22:00, Friday
// broken off to 10:00-14:00, Saturday closed.

const DAYS = [
  { idx: 0, long: 'ראשון' },
  { idx: 1, long: 'שני' },
  { idx: 2, long: 'שלישי' },
  { idx: 3, long: 'רביעי' },
  { idx: 4, long: 'חמישי' },
  { idx: 5, long: 'שישי' },
  { idx: 6, long: 'שבת' },
];

const el = (t, a = {}, ...c) => {
  const n = document.createElement(t);
  for (const k in a) {
    if (k === 'class') n.className = a[k];
    else if (k.startsWith('on') && typeof a[k] === 'function') n.addEventListener(k.slice(2), a[k]);
    else if (a[k] != null && a[k] !== false) n.setAttribute(k, a[k]);
  }
  for (const child of c) if (child != null) n.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return n;
};

function defaultState() {
  return {
    master: { open: '10:00', close: '22:00' },
    days: DAYS.map((info) => {
      if (info.idx === 5) return { closed: false, override: true,  open: '10:00', close: '14:00' };
      if (info.idx === 6) return { closed: true,  override: false, open: '10:00', close: '22:00' };
      return                    { closed: false, override: false, open: '10:00', close: '22:00' };
    }),
  };
}

// Custom HH:MM input pair. onChange gets 'HH:MM' string; only fires when the
// field carries a valid 2-digit value (or on blur after pad).
function buildTimeBlock(value, disabled, onChange) {
  const [initH, initM] = String(value || '10:00').split(':');
  const block = el('div', { class: 'time-block' });
  if (disabled) block.setAttribute('data-disabled', 'true');

  const hh = el('input', {
    type:      'text',
    class:     'time-part',
    inputmode: 'numeric',
    maxlength: '2',
    value:     initH,
    'aria-label': 'שעה',
  });
  const mm = el('input', {
    type:      'text',
    class:     'time-part',
    inputmode: 'numeric',
    maxlength: '2',
    value:     initM,
    'aria-label': 'דקה',
  });
  const colon = el('span', { class: 'colon' }, ':');

  const clampH = (v) => Math.max(0, Math.min(23, parseInt(v, 10) || 0));
  const clampM = (v) => Math.max(0, Math.min(59, parseInt(v, 10) || 0));
  const fire = () => {
    const h = String(clampH(hh.value)).padStart(2, '0');
    const m = String(clampM(mm.value)).padStart(2, '0');
    onChange(`${h}:${m}`);
  };

  // Select the current digits on focus so typing overwrites cleanly. This is
  // the fix for the "type 1 → becomes 01, next digit does nothing"
  // native-time-input quirk.
  for (const inp of [hh, mm]) {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('click', () => inp.select());
  }

  hh.addEventListener('input', () => {
    hh.value = hh.value.replace(/\D/g, '').slice(0, 2);
    // Auto-advance to minutes once two digits are in, or when the first
    // digit is >= 3 (can't be a valid start of an HH, so user meant a
    // single-digit hour).
    if (hh.value.length === 2) { mm.focus(); mm.select(); }
    else if (hh.value.length === 1 && parseInt(hh.value, 10) >= 3) { mm.focus(); mm.select(); }
  });
  mm.addEventListener('input', () => {
    mm.value = mm.value.replace(/\D/g, '').slice(0, 2);
  });

  // Commit on blur (pad + clamp + fire) and on Enter.
  hh.addEventListener('blur', () => { hh.value = String(clampH(hh.value)).padStart(2, '0'); fire(); });
  mm.addEventListener('blur', () => { mm.value = String(clampM(mm.value)).padStart(2, '0'); fire(); });
  for (const inp of [hh, mm]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  }

  block.append(hh, colon, mm);
  return block;
}

// Convert the internal state into the persisted shape used by
// user_metadata.sonic.b[bizId].hours plus a `longestMinutes` scalar for the
// eventual playlist-length calc.
function collectHours(state) {
  const hours = {};
  let longestMinutes = 0;
  for (const info of DAYS) {
    const d = state.days[info.idx];
    if (d.closed) { hours[info.idx] = { closed: true }; continue; }
    hours[info.idx] = { closed: false, open: d.open, close: d.close };
    const [oh, om] = d.open.split(':').map(Number);
    const [ch, cm] = d.close.split(':').map(Number);
    let mins = (ch * 60 + cm) - (oh * 60 + om);
    if (mins <= 0) mins += 24 * 60;
    if (mins > longestMinutes) longestMinutes = mins;
  }
  return { hours, longestMinutes };
}

// Reverse of collectHours — rebuild the internal state when re-entering the
// screen with a previously-saved payload.
function fromPersisted({ hours = {}, master }) {
  const days = DAYS.map((info) => {
    const h = hours[info.idx] || {};
    if (h.closed) return { closed: true, override: false, open: '10:00', close: '22:00' };
    return {
      closed:   false,
      override: false,
      open:     h.open  || '10:00',
      close:    h.close || '22:00',
    };
  });
  // Any day whose hours differ from the majority becomes an "override" so
  // toggling it back to unlocked returns it to the shared master.
  const openDays = days.filter((d) => !d.closed);
  const masterOpen  = master?.open  || (openDays[0]?.open  ?? '10:00');
  const masterClose = master?.close || (openDays[0]?.close ?? '22:00');
  for (const d of days) {
    if (d.closed) continue;
    if (d.open !== masterOpen || d.close !== masterClose) d.override = true;
  }
  return { master: { open: masterOpen, close: masterClose }, days };
}

export async function runHoursSelection({ prechecked = null } = {}) {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('hours-selector: .screen-card not found');

  const state = prechecked ? fromPersisted(prechecked) : defaultState();

  const heading = el('h1', {}, 'מתי העסק פתוח?');
  const subtitle = el('p', { class: 'subtitle' });
  subtitle.innerHTML = 'שינוי שעות ביום אחד מעדכן את כולם.<br>' +
    'רוצים ליום מסוים שעות שונות? סמנו "שעות שונות" לצידו.';

  const dayList = el('div', { class: 'day-list' });
  const closedSummary = el('div', { class: 'closed-summary' });
  const submitBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'המשך ←');

  card.replaceChildren(heading, subtitle, dayList, closedSummary, submitBtn);

  // When an unlocked day's hours change, master + all other unlocked open
  // days follow.
  function propagateMasterEdit(field, value) {
    state.master[field] = value;
    for (const d of state.days) {
      if (!d.closed && !d.override) d[field] = value;
    }
  }

  function render() {
    dayList.replaceChildren();

    DAYS.forEach((info, i) => {
      const d = state.days[i];
      const row = el('div', { class: 'day-row' + (d.closed ? ' closed' : '') });

      const dayCb = el('input', {
        type:    'checkbox',
        id:      'hours-day-' + i,
        checked: !d.closed,
        onchange: (e) => { d.closed = !e.target.checked; render(); },
      });
      const dayLbl = el('label', { for: 'hours-day-' + i }, info.long);
      const dayCell = el('div', { class: 'day-cell' }, dayCb, dayLbl);

      const overrideCb = el('input', {
        type:    'checkbox',
        id:      'hours-override-' + i,
        checked: d.override,
        onchange: (e) => {
          d.override = e.target.checked;
          if (!d.override) { d.open = state.master.open; d.close = state.master.close; }
          render();
        },
      });
      const overrideLbl = el('label', { for: 'hours-override-' + i }, 'שעות שונות');
      const overrideCell = el('div',
        { class: 'override-cell' + (d.override ? ' active' : '') },
        overrideCb, overrideLbl,
      );

      const openBlock = buildTimeBlock(d.open, d.closed, (v) => {
        if (d.override) d.open = v; else propagateMasterEdit('open', v);
        render();
      });
      const closeBlock = buildTimeBlock(d.close, d.closed, (v) => {
        if (d.override) d.close = v; else propagateMasterEdit('close', v);
        render();
      });
      const timesCell = el('div', { class: 'times-cell' },
        openBlock,
        el('span', { class: 'times-arrow' }, '→'),
        closeBlock,
      );

      row.append(dayCell, overrideCell, timesCell);
      if (d.override) row.classList.add('override-on');
      dayList.append(row);
    });

    renderClosedSummary();
    const allClosed = state.days.every((d) => d.closed);
    submitBtn.disabled = allClosed;
  }

  function renderClosedSummary() {
    const closedNames = DAYS.filter((info) => state.days[info.idx].closed).map((info) => info.long);
    closedSummary.classList.remove('warn');
    if (closedNames.length === 0) closedSummary.textContent = '';
    else if (closedNames.length === 7) {
      closedSummary.classList.add('warn');
      closedSummary.innerHTML = '<b>העסק סגור בכל ימות השבוע</b> — סמנו לפחות יום פתוח אחד';
    } else if (closedNames.length === 1) {
      closedSummary.innerHTML = `סגור ביום <b>${closedNames[0]}</b>`;
    } else {
      const last = closedNames.pop();
      closedSummary.innerHTML = `סגור בימי <b>${closedNames.join(', ')} ו${last}</b>`;
    }
  }

  render();

  return new Promise((resolve) => {
    submitBtn.addEventListener('click', () => {
      submitBtn.disabled = true;
      submitBtn.replaceChildren(
        el('span', { class: 'sb-spinner', 'aria-label': 'טוען' }),
      );
      resolve(collectHours(state));
    });
  });
}
