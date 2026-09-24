// v7 Option-2 energy-timeline editor — the UI Roni approved in the sandbox
// (v7/test-timeline, 2026-09-24), extracted so the account (first-login gate,
// Profile tab) and the sandbox run the SAME code and styles.
//
// A curve through draggable dots over one opening-hours window:
//   - dots move freely: energy continuous, time snaps to the clock's :00/:30
//     plus the exact opening/closing (two dots never share a time — an
//     occupied half-hour is skipped while dragging)
//   - "+" adds a dot on the free half-hour farthest from every dot, right on
//     the curve (the shape doesn't change until it's moved)
//   - dragging a dot onto the trash deletes it; the trash only appears while a
//     dot is held (in place of "+"); dragging below the chart = delete mode
//     (released anywhere but the trash → the dot stays where it started)
//   - 2..12 dots; hour labels under the chart follow the dots, opening/closing
//     always shown
//   - background grid = N rows (the taste profile's energy levels). N is never
//     shown to the owner.
//
// Points are clock minutes ({ m, e }, see v7/generation/energy-timeline.js).
// Client-only (DOM). Styles are injected once from here.

import {
  windowOf, slotMinutes, snapMinute, curveThrough, sanitizePoints, defaultPoints,
  normLevels, fmtHM, MIN_POINTS, MAX_POINTS,
} from '../generation/energy-timeline.js?v=24092026a';

const NS = 'http://www.w3.org/2000/svg';
const LABEL_ROW_H = 17;
const CALM = [74, 155, 187], MID = [154, 143, 214], HOT = [240, 167, 63];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round2 = (v) => Math.round(v * 100) / 100;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = (rgb) => `rgb(${rgb.join(',')})`;
export const energyRGB = (e) => { e = clamp01(e); return e < .5 ? mix(CALM, MID, e * 2) : mix(MID, HOT, (e - .5) * 2); };
export const energyColor = (e) => css(energyRGB(e));

const TRASH_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

// Styles — verbatim from the approved sandbox, prefixed "etl-". `--etl-fill`
// is the "+" button's inner fill; set it to the surface the editor sits on.
const STYLES = `
.etl { --etl-fill: #112430; --etl-fill-hover: #17303f }
.etl-row { display: flex; gap: 6px; align-items: stretch }
.etl-ylab {
  width: 38px; flex: 0 0 38px;
  display: flex; flex-direction: column; justify-content: space-between;
  font-size: 11px; color: var(--muted, #96a7b0); text-align: center;
  padding: 6px 0;
}
.etl-stage { position: relative; flex: 1; min-width: 0 }
.etl-svg {
  display: block; width: 100%; height: 190px;
  touch-action: none;
  border: 1px solid var(--border, rgba(255,255,255,.08));
  border-radius: 12px;
  user-select: none; -webkit-user-select: none;
}
.etl-svg.grabbing, .etl-svg.grabbing .etl-handle { cursor: grabbing }
.etl-handle { cursor: grab; outline: none }
.etl-handle .etl-hit { fill: transparent }
.etl-handle .etl-dot { stroke: #fff; stroke-width: 2.5 }
.etl-handle.on .etl-dot, .etl-handle:focus-visible .etl-dot { stroke: var(--accent, #f0a73f); stroke-width: 3.5 }
.etl-handle.doomed .etl-dot { opacity: .3 }
.etl-handle.pending .etl-dot { opacity: .65 }
.etl-handle .etl-ring { fill: none; stroke: var(--accent, #f0a73f); stroke-width: 2; opacity: 0; transform-box: fill-box; transform-origin: center }
.etl-handle.fresh .etl-ring { animation: etl-ring .9s ease-out 2 }
@keyframes etl-ring { from { opacity: .9; transform: scale(1) } to { opacity: 0; transform: scale(2.6) } }
.etl-times { position: relative; margin: 6px 0 0; margin-inline: 58px 14px; height: 34px; font-size: 11.5px }
.etl-times span { position: absolute; top: 0; white-space: nowrap; color: var(--teal-soft, #57a3bd) }
.etl-times span.edge { color: var(--text, #f5f7f8); font-weight: 700 }
.etl-times span.active { color: var(--accent, #f0a73f); font-weight: 700 }
.etl-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; height: 46px }
.etl-add {
  display: inline-flex; align-items: center; gap: 6px;
  height: 38px; padding: 0 15px;
  border-radius: 999px;
  border: 1.5px solid transparent;
  background:
    linear-gradient(var(--etl-fill), var(--etl-fill)) padding-box,
    linear-gradient(90deg, rgb(74, 155, 187), rgb(154, 143, 214), rgb(240, 167, 63)) border-box;
  color: #c3bdf0;
  font-family: inherit; font-size: 14px; font-weight: 600;
  cursor: pointer;
}
.etl-add:hover:not(:disabled) {
  background:
    linear-gradient(var(--etl-fill-hover), var(--etl-fill-hover)) padding-box,
    linear-gradient(90deg, rgb(74, 155, 187), rgb(154, 143, 214), rgb(240, 167, 63)) border-box;
}
.etl-add .etl-plus { font-size: 20px; line-height: 1; font-weight: 400 }
.etl-add:disabled { opacity: .35; cursor: default }
.etl-trash {
  display: none;
  flex: 1;
  height: 46px; padding: 0 12px;
  align-items: center; justify-content: center; gap: 8px;
  border-radius: 12px;
  border: 1.5px dashed rgba(255, 255, 255, .28);
  color: var(--text, #f5f7f8);
  font-size: 13px;
  transition: background-color .15s, border-color .15s, color .15s;
}
.etl-trash svg { transition: transform .15s }
.etl-actions.dragging .etl-add { display: none }
.etl-actions.dragging .etl-trash { display: flex }
.etl-actions.dragging .etl-trash.hot { border-color: var(--danger, #e07a6a); background: rgba(224, 122, 106, .16); color: #ffb4a6 }
.etl-actions.dragging .etl-trash.hot svg { transform: scale(1.25) }
.etl-actions.dragging .etl-trash.blocked { opacity: .5 }
`;

function ensureStyles() {
  if (document.getElementById('etl-styles')) return;
  const s = document.createElement('style');
  s.id = 'etl-styles';
  s.textContent = STYLES;
  document.head.appendChild(s);
}

let instanceSeq = 0;

export class TimelineEditor {
  // opts: { group:{open,close}, N, points:[{m,e}]|null, openRight=false, onChange }
  constructor(root, { group, N, points = null, openRight = false, onChange } = {}) {
    ensureStyles();
    this.onChange = onChange;
    this.nextId = 1;
    this.drag = null;
    this.dotEls = new Map();
    this.gradId = `etlGrad${++instanceSeq}`;

    root.classList.add('etl');
    root.innerHTML = `
      <div class="etl-row">
        <div class="etl-ylab"><span>אנרגטי</span><span>רגוע</span></div>
        <div class="etl-stage"><svg class="etl-svg" role="group" aria-label="ציר האנרגיה לאורך היום"></svg></div>
      </div>
      <div class="etl-times" aria-hidden="true"></div>
      <div class="etl-actions">
        <button type="button" class="etl-add"><span class="etl-plus" aria-hidden="true">+</span> הוספת נקודה</button>
        <div class="etl-trash" aria-label="פח — גררו נקודה לכאן כדי למחוק">${TRASH_SVG}<span class="etl-trash-hint"></span></div>
      </div>`;
    this.stage = root.querySelector('.etl-stage');
    this.svg = root.querySelector('svg');
    this.times = root.querySelector('.etl-times');
    this.actions = root.querySelector('.etl-actions');
    this.addBtn = root.querySelector('.etl-add');
    this.trash = root.querySelector('.etl-trash');
    this.trashHint = root.querySelector('.etl-trash-hint');

    const mk = (tag, attrs = {}, parent = this.svg) => {
      const el = document.createElementNS(NS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    };
    this.mk = mk;
    const defs = mk('defs');
    // userSpaceOnUse: an objectBoundingBox gradient vanishes on a perfectly
    // flat line (zero-height bbox). Unique id per instance: two editors in
    // one document must not resolve url(#…) to each other's gradient.
    this.grad = mk('linearGradient', { id: this.gradId, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0 }, defs);
    mk('stop', { offset: '0%', 'stop-color': css(HOT) }, this.grad);
    mk('stop', { offset: '50%', 'stop-color': css(MID) }, this.grad);
    mk('stop', { offset: '100%', 'stop-color': css(CALM) }, this.grad);
    this.bands = mk('g');
    this.area = mk('path', { fill: `url(#${this.gradId})`, 'fill-opacity': '.26' });
    this.line = mk('path', { fill: 'none', stroke: `url(#${this.gradId})`, 'stroke-width': 3, 'stroke-linecap': 'round' });
    this.dotLayer = mk('g');

    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onMove(e));
    this.svg.addEventListener('pointerup', () => this.onUp(true));
    this.svg.addEventListener('pointercancel', () => this.onUp(false));
    this.svg.addEventListener('lostpointercapture', () => this.onUp(false));
    this.addBtn.addEventListener('click', () => this.addDot());

    this.load({ group, N, points, openRight }, { silent: true });
    new ResizeObserver(() => this.relayout()).observe(this.stage);
  }

  // Swap the window / levels / dots / direction (e.g. switching group tabs).
  load({ group, N, points, openRight } = {}, { silent = false } = {}) {
    if (group) {
      this.group = { open: group.open, close: group.close };
      this.win = windowOf(this.group);
      this.slots = slotMinutes(this.group);
    }
    if (N !== undefined) this.N = normLevels(N);
    if (openRight !== undefined) this.openRight = !!openRight;
    if (points !== undefined || group) {
      const pts = points ? sanitizePoints(points, this.group) : defaultPoints(this.group);
      this.points = pts.map((p) => ({ m: p.m, e: p.e, id: this.nextId++ }));
    }
    this.drag = null;
    this.relayout();
    if (!silent) this.onChange?.();
  }

  reset() { this.load({ points: null }); }

  getPoints() { return this.sorted().map((p) => ({ m: p.m, e: round2(p.e) })); }

  // ----- geometry -----
  tOf(m) { return (m - this.win.openMin) / this.win.total; }
  xFrac(t) { return this.openRight ? 1 - t : t; }
  xOf(m) { return this.x0 + this.xFrac(this.tOf(m)) * (this.x1 - this.x0); }
  yOf(e) { return this.y1 - e * (this.y1 - this.y0); }
  mOfX(x) {
    const f = clamp01((x - this.x0) / (this.x1 - this.x0));
    return this.win.openMin + (this.openRight ? 1 - f : f) * this.win.total;
  }
  eOfY(y) { return clamp01((this.y1 - y) / (this.y1 - this.y0)); }
  sorted(excludeId = null) { return this.points.filter((p) => p.id !== excludeId).sort((a, b) => a.m - b.m); }
  energyAt(m) { return curveThrough(this.sorted())(m); }
  canDelete() { return this.points.length > MIN_POINTS; }
  occupied(m, exceptId = null) { return this.points.some((q) => q.id !== exceptId && q.m === m); }

  relayout() {
    this.W = this.stage.clientWidth || 300;
    this.H = 190;
    this.x0 = 14; this.x1 = this.W - 14; this.y0 = 12; this.y1 = this.H - 12;
    this.svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    this.grad.setAttribute('y1', this.y0);
    this.grad.setAttribute('y2', this.y1);
    this.render();
  }

  // ----- drawing -----
  render() {
    if (!this.W || !this.win) return;
    this.drawGrid();
    this.drawCurve();
    this.drawDots();
    this.drawTimes();
    this.addBtn.disabled = this.freestSlot() == null;
  }

  // One row per energy level in the profile — no numbers, just rows.
  drawGrid() {
    this.bands.innerHTML = '';
    for (let k = 0; k < this.N; k++) {
      const top = this.yOf((k + 1) / this.N), bottom = this.yOf(k / this.N);
      const r = document.createElementNS(NS, 'rect');
      Object.entries({ x: 0, y: top, width: this.W, height: bottom - top, fill: k % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.012)' })
        .forEach(([a, v]) => r.setAttribute(a, v));
      this.bands.appendChild(r);
      if (k > 0) {
        const ln = document.createElementNS(NS, 'line');
        Object.entries({ x1: 0, x2: this.W, y1: bottom, y2: bottom, stroke: 'rgba(255,255,255,.09)' })
          .forEach(([a, v]) => ln.setAttribute(a, v));
        this.bands.appendChild(ln);
      }
    }
  }

  drawCurve() {
    // While a dot hovers over the trash, preview the curve without it.
    const f = curveThrough(this.sorted(this.drag?.overTrash && this.canDelete() ? this.drag.id : null));
    const { openMin, total } = this.win;
    let d = '';
    const SAMPLES = 120;
    for (let k = 0; k <= SAMPLES; k++) {
      const m = openMin + (k / SAMPLES) * total;
      d += `${k ? 'L' : 'M'}${this.xOf(m).toFixed(1)},${this.yOf(f(m)).toFixed(1)}`;
    }
    this.line.setAttribute('d', d);
    this.area.setAttribute('d', `${d}L${this.xOf(this.win.closeMin)},${this.y1}L${this.xOf(openMin)},${this.y1}Z`);
  }

  drawDots() {
    const alive = new Set(this.points.map((p) => p.id));
    for (const [id, g] of this.dotEls) if (!alive.has(id)) { g.remove(); this.dotEls.delete(id); }
    for (const p of this.points) {
      let g = this.dotEls.get(p.id);
      if (!g) {
        g = this.mk('g', { class: 'etl-handle', tabindex: 0, role: 'button' }, this.dotLayer);
        g.dataset.id = p.id;
        this.mk('circle', { r: 24, class: 'etl-hit' }, g);
        this.mk('circle', { r: 9, class: 'etl-ring' }, g);
        this.mk('circle', { r: 9, class: 'etl-dot' }, g);
        g.addEventListener('keydown', (e) => this.onKey(e, p.id));
        this.dotEls.set(p.id, g);
      }
      const on = this.drag?.id === p.id;
      g.setAttribute('transform', `translate(${this.xOf(p.m)},${this.yOf(p.e)})`);
      g.classList.toggle('on', on);
      g.classList.toggle('doomed', on && this.drag.overTrash && this.canDelete());
      g.classList.toggle('pending', on && this.drag.deleting && !this.drag.overTrash);
      g.classList.toggle('fresh', !!p.fresh);
      g.querySelector('.etl-dot').setAttribute('fill', energyColor(p.e));
      g.querySelector('.etl-dot').setAttribute('r', on ? 11 : 9);
      g.setAttribute('aria-label', `נקודה בשעה ${fmtHM(p.m)}. חצים למעלה ולמטה משנים אנרגיה, ימינה ושמאלה משנים שעה, Delete מוחק.`);
    }
    if (this.drag) this.dotLayer.appendChild(this.dotEls.get(this.drag.id));   // dragged dot on top
  }

  // Hour labels under the plot: opening + closing always, plus one per dot
  // that moves with it. Labels that would overlap drop to another row.
  drawTimes() {
    const cw = this.times.clientWidth || 1;
    const dragId = this.drag?.id;
    const hidden = this.drag?.overTrash && this.canDelete() ? dragId : null;
    const { openMin, closeMin } = this.win;
    const edges = [
      { m: openMin, text: fmtHM(openMin), cls: 'edge' },
      { m: closeMin, text: fmtHM(closeMin), cls: 'edge' },
    ];
    const labels = [];
    for (const p of this.sorted(hidden)) {
      const atEdge = p.m === openMin ? edges[0] : p.m === closeMin ? edges[1] : null;
      if (atEdge) { if (p.id === dragId) atEdge.cls = 'edge active'; continue; }   // same time as opening/closing → one label
      labels.push({ m: p.m, text: fmtHM(p.m), cls: p.id === dragId ? 'active' : '' });
    }
    this.times.innerHTML = '';
    const place = (lb) => {
      const s = document.createElement('span');
      s.className = lb.cls;
      s.textContent = lb.text;
      this.times.appendChild(s);
      lb.el = s;
      lb.w = s.offsetWidth;
      const x = this.xFrac(this.tOf(lb.m)) * cw;
      lb.left = Math.max(0, Math.min(cw - lb.w, x - lb.w / 2));
    };
    edges.forEach(place);
    labels.forEach(place);
    const rows = [[...edges]];
    const fits = (row, lb) => row.every((o) => lb.left + lb.w + 4 <= o.left || o.left + o.w + 4 <= lb.left);
    for (const lb of labels.sort((a, b) => a.left - b.left)) {
      let r = rows.findIndex((row) => fits(row, lb));
      if (r < 0) { rows.push([]); r = rows.length - 1; }
      rows[r].push(lb);
      lb.row = r;
    }
    for (const lb of [...edges, ...labels]) {
      lb.el.style.left = `${lb.left}px`;
      lb.el.style.top = `${(lb.row || 0) * LABEL_ROW_H}px`;
    }
    this.times.style.height = `${Math.max(2, rows.length) * LABEL_ROW_H}px`;
  }

  // ----- dragging -----
  localXY(e) { const r = this.svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  onDown(e) {
    if (e.button > 0) return;
    const g = e.target.closest('.etl-handle');
    if (!g) return;
    const p = this.points.find((q) => q.id === Number(g.dataset.id));
    const { x, y } = this.localXY(e);
    this.drag = { id: p.id, offX: this.xOf(p.m) - x, offY: this.yOf(p.e) - y, startM: p.m, startE: p.e, overTrash: false, deleting: false };
    this.svg.setPointerCapture(e.pointerId);
    this.svg.classList.add('grabbing');
    this.actions.classList.add('dragging');
    this.updateTrash();
    this.render();
    e.preventDefault();
  }

  onMove(e) {
    if (!this.drag) return;
    const p = this.points.find((q) => q.id === this.drag.id);
    const tr = this.trash.getBoundingClientRect();
    const PAD = 10;
    this.drag.overTrash = e.clientX >= tr.left - PAD && e.clientX <= tr.right + PAD && e.clientY >= tr.top - PAD && e.clientY <= tr.bottom + PAD;
    const { x, y } = this.localXY(e);
    // Below the plot (past a small overshoot margin) = heading for the trash:
    // the dot goes back to where the drag started and waits there, so letting
    // go anywhere except the trash leaves it unchanged.
    this.drag.deleting = this.drag.overTrash || y > this.H + 22;
    if (this.drag.deleting) {
      p.m = this.drag.startM;
      p.e = this.drag.startE;
    } else {
      // A half-hour another dot already sits on is skipped: the dot keeps its
      // previous time until the finger reaches a free slot.
      const m = snapMinute(this.group, this.mOfX(x + this.drag.offX), this.slots);
      if (!this.occupied(m, p.id)) p.m = m;
      p.e = round2(this.eOfY(y + this.drag.offY));
    }
    this.updateTrash();
    this.render();
    this.onChange?.();
  }

  onUp(commit) {
    if (!this.drag) return;
    const { id, overTrash } = this.drag;
    this.drag = null;
    if (commit && overTrash && this.canDelete()) this.points = this.points.filter((q) => q.id !== id);
    this.svg.classList.remove('grabbing');
    this.actions.classList.remove('dragging');
    this.trash.classList.remove('hot', 'blocked');
    this.render();
    this.onChange?.();
  }

  updateTrash() {
    const blocked = !this.canDelete();
    const hot = !!this.drag?.overTrash && !blocked;
    this.trash.classList.toggle('hot', hot);
    this.trash.classList.toggle('blocked', blocked);
    this.trashHint.textContent = blocked ? `צריך לפחות ${MIN_POINTS} נקודות` : hot ? 'שחררו כדי למחוק' : 'גררו לכאן כדי למחוק';
  }

  // ----- add / keyboard -----
  // The new dot goes on the free half-hour farthest from every dot (= the
  // middle of the widest empty stretch), right on the current curve.
  freestSlot() {
    if (this.points.length >= MAX_POINTS) return null;
    let best = null, bestDist = -1;
    for (const s of this.slots) {
      if (this.occupied(s)) continue;
      const dist = Math.min(...this.points.map((p) => Math.abs(p.m - s)));
      if (dist > bestDist) { best = s; bestDist = dist; }
    }
    return best;
  }

  addDot() {
    const m = this.freestSlot();
    if (m == null) return;
    const p = { id: this.nextId++, m, e: round2(this.energyAt(m)), fresh: true };
    this.points.push(p);
    this.render();
    this.onChange?.();
    setTimeout(() => { p.fresh = false; this.render(); }, 1900);
  }

  onKey(e, id) {
    const p = this.points.find((q) => q.id === id);
    if (!p) return;
    if (e.key === 'ArrowUp') p.e = round2(clamp01(p.e + .05));
    else if (e.key === 'ArrowDown') p.e = round2(clamp01(p.e - .05));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Next free half-hour in the arrow's on-screen direction.
      const towardClose = (e.key === 'ArrowLeft') === this.openRight;
      let i = this.slots.indexOf(p.m);
      if (i < 0) i = this.slots.indexOf(snapMinute(this.group, p.m, this.slots));
      do i += towardClose ? 1 : -1; while (i >= 0 && i < this.slots.length && this.occupied(this.slots[i], p.id));
      if (i >= 0 && i < this.slots.length) p.m = this.slots[i];
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.canDelete()) {
      this.points = this.points.filter((q) => q.id !== id);
    } else return;
    e.preventDefault();
    this.render();
    this.onChange?.();
  }
}
