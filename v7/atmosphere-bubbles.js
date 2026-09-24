// Physics-driven bubble picker for the atmosphere selection screen.
//
// Same contract as the grid renderer in atmosphere.js:
//   const selected = await runAtmosphereBubbles({ atmosphereRows, prechecked });
//   selected: string[]  // array of chosen atmosphere.name values
//
// Approach:
//   - Matter.js engine + custom canvas render (Matter's built-in renderer is
//     for its default shapes; we draw filled circles with labels manually).
//   - Zero gravity + weak center-attract force per frame → bubbles cluster
//     but stay reachable at the edges.
//   - Real <input type="checkbox"> elements exist per option, visually
//     hidden but keyboard-focusable, wired bi-directionally to the canvas
//     selection state. Screen readers/keyboard users get real semantics;
//     the canvas is aria-hidden decoration.
//   - Tap-vs-drag distinguished by a 6px move threshold between
//     pointerdown and pointerup so shoving a bubble doesn't toggle it.
//   - Selected bubbles animate to 1.28× via Matter.Body.scale each frame
//     (lerp factor 0.16), which also pushes neighbours in the simulation.
//
// Matter.js is loaded lazily from cdnjs on first use; preloadBubblesDeps()
// is exported so the caller can warm the HTTP cache during an earlier step.
// If the CDN load fails, the returned promise rejects — the orchestrator in
// atmosphere.js catches and falls back to the checkbox grid.

const HEADING       = 'אילו תיאורים נכונים לאווירה של העסק?';
const MATTER_SRC    = 'https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js';
const CENTER_FORCE  = 0.0000042;   // per brief; higher clumps harder
const SCALE_TARGET  = 1.28;        // selected bubble scale
const SCALE_LERP    = 0.16;        // per-frame approach factor
const TAP_THRESHOLD = 6;           // px; larger movement = drag, not tap
const DPR_CAP       = 2;

let _matterPromise = null;
export function preloadBubblesDeps() {
  if (_matterPromise) return _matterPromise;
  _matterPromise = new Promise((resolve, reject) => {
    if (window.Matter) return resolve(window.Matter);
    const s = document.createElement('script');
    s.src = MATTER_SRC;
    s.async = true;
    s.onload = () => window.Matter ? resolve(window.Matter) : reject(new Error('Matter.js loaded but no global'));
    s.onerror = () => { _matterPromise = null; reject(new Error('Matter.js failed to load')); };
    document.head.append(s);
  });
  return _matterPromise;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function readTheme() {
  // CSS custom properties are declared on :root, but font-family lives on
  // <body> in this app — read each from wherever it's actually set.
  const rootCs = getComputedStyle(document.documentElement);
  const bodyCs = getComputedStyle(document.body);
  const read = (name, fallback) => (rootCs.getPropertyValue(name).trim() || fallback);
  return {
    card:    read('--card-2', '#17303f'),
    border:  read('--border-2', 'rgba(255,255,255,.14)'),
    text:    read('--text', '#f5f7f8'),
    accent:  read('--accent', '#f0a73f'),
    accent2: read('--accent-2', '#d98a1f'),
    // Text color on the orange accent — matches .btn-primary's color: #1b1508.
    onAccent: '#1b1508',
    fontFamily: bodyCs.fontFamily || "'Heebo', -apple-system, sans-serif",
  };
}

async function ensureFont(family) {
  if (!document.fonts?.load) return;
  try {
    // Try the two weights we actually render at
    await Promise.all([
      document.fonts.load(`600 16px ${family}`),
      document.fonts.load(`700 14px ${family}`),
    ]);
  } catch { /* fall through; canvas will use fallback */ }
}

// Distribute bodies in a loose ring around the canvas center so the physics
// engine has non-overlapping starting positions and settles quickly.
function seedPosition(i, total, cx, cy) {
  const angle = (i / total) * Math.PI * 2;
  const ring  = 40 + (i % 4) * 26;
  return {
    x: cx + Math.cos(angle) * ring + (Math.random() - 0.5) * 14,
    y: cy + Math.sin(angle) * ring + (Math.random() - 0.5) * 14,
  };
}

export async function runAtmosphereBubbles({ atmosphereRows, prechecked = [] } = {}) {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('atmosphere-bubbles: .screen-card not found');
  if (!Array.isArray(atmosphereRows) || !atmosphereRows.length) {
    throw new Error('atmosphere-bubbles: atmosphereRows required');
  }

  const Matter = await preloadBubblesDeps();
  const theme  = readTheme();
  await ensureFont(theme.fontFamily);

  // ---- DOM scaffold ------------------------------------------------------
  const heading = el('h1', {}, HEADING);
  const canvas  = el('canvas', { class: 'bp-canvas', 'aria-hidden': 'true' });
  const a11yLayer = el('div', { class: 'bp-a11y', role: 'group', 'aria-label': HEADING });
  const stage   = el('div', { class: 'bp-stage' }, canvas, a11yLayer);

  const submitBtn = el('button', {
    class: 'btn btn-primary btn-block',
    type: 'button',
  }, 'המשך ←');

  card.replaceChildren(heading, stage, submitBtn);

  // ---- selection state + hidden a11y checkboxes ------------------------
  const selection = new Set(prechecked || []);
  const inputByName = new Map();
  const nameByInput = new WeakMap();
  const bodyByName  = new Map();
  atmosphereRows.forEach((row) => {
    const name = row.atmosphere;
    const id = `bp-cb-${row.row}`;
    const input = el('input', {
      type: 'checkbox',
      class: 'bp-cb',
      id,
      value: name,
    });
    input.checked = selection.has(name);
    const label = el('label', { for: id, class: 'bp-cb-label' }, name);
    a11yLayer.append(input, label);
    inputByName.set(name, input);
    nameByInput.set(input, name);
    input.addEventListener('change', () => {
      if (input.checked) selection.add(name); else selection.delete(name);
    });
    input.addEventListener('focus', () => { focusedName = name; });
    input.addEventListener('blur',  () => { if (focusedName === name) focusedName = null; });
  });
  let focusedName = null;

  // ---- canvas sizing + DPR handling ------------------------------------
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  function resize() {
    const rect = stage.getBoundingClientRect();
    W = Math.max(280, Math.floor(rect.width));
    H = Math.max(360, Math.floor(rect.height));
    dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }
  resize();

  const isMobile = W < 400;

  // ---- Matter world ----------------------------------------------------
  const engine = Matter.Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 0;

  // Bubble bodies
  const bubbles = atmosphereRows.map((row, i) => {
    const name = row.atmosphere;
    let radius = 24 + name.length * 3.4;
    if (isMobile) radius *= 0.85;
    const { x, y } = seedPosition(i, atmosphereRows.length, W / 2, H / 2);
    const body = Matter.Bodies.circle(x, y, radius, {
      restitution: 0.55,
      frictionAir: 0.045,
      friction:    0,
    });
    body.__bp = {
      name,
      baseRadius:  radius,
      visualScale: 1,
      fontSize:    Math.min(16, Math.max(11, radius / 2.7)),
    };
    bodyByName.set(name, body);
    return body;
  });

  // Walls just outside the canvas
  const wallOpts = { isStatic: true };
  let walls = [];
  function rebuildWalls() {
    if (walls.length) Matter.Composite.remove(engine.world, walls);
    walls = [
      Matter.Bodies.rectangle(W / 2, -50,      W + 200, 100, wallOpts),
      Matter.Bodies.rectangle(W / 2, H + 50,   W + 200, 100, wallOpts),
      Matter.Bodies.rectangle(-50,     H / 2,  100, H + 200, wallOpts),
      Matter.Bodies.rectangle(W + 50,  H / 2,  100, H + 200, wallOpts),
    ];
    Matter.Composite.add(engine.world, walls);
  }
  rebuildWalls();
  Matter.Composite.add(engine.world, bubbles);

  // Mouse constraint for drag
  const mouse = Matter.Mouse.create(canvas);
  mouse.pixelRatio = dpr;
  const mouseConstraint = Matter.MouseConstraint.create(engine, {
    mouse,
    constraint: { stiffness: 0.2, render: { visible: false } },
  });
  Matter.Composite.add(engine.world, mouseConstraint);

  // Tap vs drag: track pointerdown/up positions on the canvas element itself.
  // MouseConstraint doesn't stopPropagation, so both handlers fire.
  let downXY = null;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    downXY = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!downXY) return;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left) - downXY.x;
    const dy = (e.clientY - rect.top)  - downXY.y;
    downXY = null;
    if (Math.hypot(dx, dy) > TAP_THRESHOLD) return;
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const hits = Matter.Query.point(bubbles, point);
    if (!hits.length) return;
    toggle(hits[0].__bp.name);
  });
  canvas.addEventListener('pointercancel', () => { downXY = null; });

  function toggle(name) {
    if (selection.has(name)) selection.delete(name);
    else selection.add(name);
    const cb = inputByName.get(name);
    if (cb) cb.checked = selection.has(name);
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
  }

  // ---- physics + render loop -------------------------------------------
  let raf = 0;
  let alive = true;

  function tick() {
    if (!alive) return;
    const cx = W / 2, cy = H / 2;
    for (const body of bubbles) {
      const meta = body.__bp;
      // Center-attract force
      Matter.Body.applyForce(body, body.position, {
        x: (cx - body.position.x) * body.mass * CENTER_FORCE,
        y: (cy - body.position.y) * body.mass * CENTER_FORCE,
      });
      // Selected-scale animation (drives simulation size too, so pushed
      // neighbours re-cluster naturally).
      const target = selection.has(meta.name) ? SCALE_TARGET : 1;
      const next   = meta.visualScale + (target - meta.visualScale) * SCALE_LERP;
      if (Math.abs(next - meta.visualScale) > 0.002) {
        const factor = next / meta.visualScale;
        Matter.Body.scale(body, factor, factor);
        meta.visualScale = next;
      }
    }
    Matter.Engine.update(engine, 1000 / 60);
    draw();
    raf = requestAnimationFrame(tick);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const body of bubbles) {
      const meta = body.__bp;
      const selected = selection.has(meta.name);
      const focused  = focusedName === meta.name;
      const r = body.circleRadius;
      const { x, y } = body.position;

      // Fill
      if (selected) {
        const g = ctx.createLinearGradient(x, y - r, x, y + r);
        g.addColorStop(0, theme.accent);
        g.addColorStop(1, theme.accent2);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = theme.card;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = selected ? theme.accent : theme.border;
      ctx.lineWidth   = selected ? 1.8 : 1.2;
      ctx.stroke();

      // Focus ring
      if (focused) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(240,167,63,.8)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Label
      ctx.font         = `${selected ? 700 : 600} ${meta.fontSize}px ${theme.fontFamily}`;
      ctx.fillStyle    = selected ? theme.onAccent : theme.text;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(meta.name, x, y);
    }
  }

  // Kick off physics
  raf = requestAnimationFrame(tick);

  // Resize handler
  function onResize() {
    resize();
    rebuildWalls();
    mouse.pixelRatio = dpr;
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // Safety net: if the card's contents get replaced (aborted step / user
  // navigates back), tear down the physics loop even though we never resolve.
  const observer = new MutationObserver(() => {
    if (!card.contains(stage)) cleanup();
  });
  observer.observe(card, { childList: true });

  function cleanup() {
    if (!alive) return;
    alive = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    observer.disconnect();
    // Matter has no explicit engine.destroy, but clearing composites lets
    // the GC reclaim the bodies once external refs (bubbles, walls) drop.
    Matter.World.clear(engine.world, false);
    Matter.Engine.clear(engine);
  }

  // ---- submit ----------------------------------------------------------
  return new Promise((resolve) => {
    submitBtn.addEventListener('click', () => {
      submitBtn.disabled = true;
      submitBtn.replaceChildren(el('span', { class: 'sb-spinner', 'aria-label': 'טוען' }));
      const picked = atmosphereRows
        .map((r) => r.atmosphere)
        .filter((name) => selection.has(name));
      cleanup();
      resolve(picked);
    });
  });
}
