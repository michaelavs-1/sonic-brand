// Atmosphere selection screen (step 2 of v6 onboarding).
//
// Orchestrator: picks between the physics-driven bubble picker and the
// original checkbox grid based on the user's motion preference and whether
// the bubble module (Matter.js CDN) actually loads. Both renderers share the
// same contract:
//
//   const selected = await runAtmosphereSelection({ atmosphereRows, prechecked });
//   // selected: string[] — array of chosen atmosphere.name values
//
// `prechecked` restores prior selection when the user navigates back to
// step 2 from a later step.

const HEADING = 'אילו תיאורים נכונים לאווירה של העסק?';
const BUBBLE_MODULE = '/v6/atmosphere-bubbles.js?v=21082026a';

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

// Reduced-motion is a strong opt-out: skip the physics path entirely and
// render the plain grid.
const REDUCED_MOTION = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function renderGridFallback({ atmosphereRows, prechecked = [] }) {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('atmosphere: .screen-card not found');

  const pre = new Set(prechecked);
  const grid = el('div', { class: 'atmo-grid' });

  for (const row of atmosphereRows) {
    const name = row.atmosphere;
    const id = `atmo-${row.row}`;

    const checkbox = el('input', { type: 'checkbox', class: 'atmo-checkbox', id });
    if (pre.has(name)) checkbox.checked = true;

    const label = el('label', { class: 'atmo-chip', for: id, 'data-name': name },
      checkbox,
      el('span', { class: 'atmo-name' }, name),
    );
    grid.append(label);
  }

  const submitBtn = el('button',
    { class: 'btn btn-primary btn-block', type: 'button' },
    'המשך ←',
  );

  card.replaceChildren(el('h1', {}, HEADING), grid, submitBtn);

  return new Promise((resolve) => {
    submitBtn.addEventListener('click', () => {
      const selected = [];
      grid.querySelectorAll('.atmo-chip').forEach((chip) => {
        const cb = chip.querySelector('.atmo-checkbox');
        if (cb && cb.checked) selected.push(chip.dataset.name);
      });
      submitBtn.disabled = true;
      submitBtn.replaceChildren(el('span', { class: 'sb-spinner', 'aria-label': 'טוען' }));
      resolve(selected);
    });
  });
}

export async function runAtmosphereSelection({ atmosphereRows, prechecked = [] } = {}) {
  if (!REDUCED_MOTION) {
    try {
      const mod = await import(BUBBLE_MODULE);
      return await mod.runAtmosphereBubbles({ atmosphereRows, prechecked });
    } catch (err) {
      // CDN failure, older browser without needed APIs, etc. Fall back to
      // the grid rather than blocking the user.
      console.warn('atmosphere-bubbles unavailable, falling back to grid:', err);
    }
  }
  return renderGridFallback({ atmosphereRows, prechecked });
}

// Fire-and-forget preload used by earlier onboarding steps to warm the
// Matter.js CDN response + the bubble module in the HTTP cache while the
// user is still typing their business description. Safe to call multiple
// times; the underlying loader dedupes.
export async function preloadAtmosphereBubbles() {
  if (REDUCED_MOTION) return;
  try {
    const mod = await import(BUBBLE_MODULE);
    await mod.preloadBubblesDeps();
  } catch {
    /* ignored — real load attempt on step 2 will surface the error */
  }
}
