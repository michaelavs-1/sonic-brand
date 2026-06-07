// v4 atmosphere selection screen.
// Renders one checkbox per atmosphere from /api/v4/databox-atmospheres, pre-
// checking the ones that appear in the matched Tab 1 row's column D
// (row.atmospheres). On submit, resolves with the array of selected names.

const HEADING = 'בחרו את האווירות המתאימות לעסק';

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

export async function runAtmosphereSelection({ atmosphereRows, prechecked }) {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('atmosphere: .screen-card not found');

  const presetSet = new Set(
    Array.isArray(prechecked) ? prechecked.map((s) => String(s).trim()) : []
  );

  const grid = el('div', { class: 'atmo-grid' });

  for (const row of atmosphereRows) {
    const name = row.atmosphere;
    const id   = `atmo-${row.row}`;
    const isChecked = presetSet.has(name);

    const checkbox = el('input', {
      type: 'checkbox',
      class: 'atmo-checkbox',
      id,
    });
    if (isChecked) checkbox.checked = true;

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

  card.replaceChildren(
    el('h1', {}, HEADING),
    grid,
    submitBtn,
  );

  return new Promise((resolve) => {
    submitBtn.addEventListener('click', () => {
      const selected = [];
      grid.querySelectorAll('.atmo-chip').forEach((chip) => {
        const cb = chip.querySelector('.atmo-checkbox');
        if (cb && cb.checked) selected.push(chip.dataset.name);
      });
      resolve(selected);
    });
  });
}
