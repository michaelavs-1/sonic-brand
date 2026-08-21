// Test harness for the atmosphere bubble picker.
//
// Not shipped to end users. Lets us:
//   - Load either a real Databox fetch or a hardcoded set of 17.
//   - Toggle prechecked (first 3 seeded) to simulate step-2 re-entry.
//   - Toggle "force fallback grid" to preview the reduced-motion path.
//   - Watch the resolved array in the panel below when submit fires.

import { runAtmosphereBubbles, preloadBubblesDeps } from '/v6/atmosphere-bubbles.js?v=1';

const $ = (id) => document.getElementById(id);
const card   = $('card');
const status = $('status');
const out    = $('resultPre');

// Hardcoded set — mirrors what the Databox atmospheres endpoint returns:
// { row: <sheet row>, atmosphere: <name>, ranges: <string> }
const HARDCODED = [
  'אלגנטי','קליל','אינטימי','אנרגטי','שכונתי','משפחתי',
  'רומנטי','נוסטלגי','חגיגי','מודרני','כפרי','מסתורי',
  'ילדותי','חוצפני','שקט','אקזוטי','טרנדי',
].map((name, i) => ({ row: i + 1, atmosphere: name, ranges: '' }));

let currentRows = null;

// Preload Matter.js as soon as this test page opens — mimics what production
// will do from an earlier onboarding step.
preloadBubblesDeps().catch((e) => setStatus(`Matter.js preload failed: ${e.message}`, true));

function setStatus(text, isErr = false) {
  status.textContent = text;
  status.classList.toggle('err', isErr);
}

function renderGridFallback(rows, prechecked) {
  card.replaceChildren();
  const h = document.createElement('h1');
  h.textContent = 'אילו תיאורים נכונים לאווירה של העסק?';
  const sub = document.createElement('p');
  sub.className = 'subtitle';
  sub.textContent = '(fallback grid — reduced-motion / Matter fail path)';
  const grid = document.createElement('div');
  grid.className = 'atmo-grid';
  const pre = new Set(prechecked);
  for (const row of rows) {
    const id = `atmo-${row.row}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'atmo-checkbox';
    cb.id = id;
    cb.checked = pre.has(row.atmosphere);
    const label = document.createElement('label');
    label.className = 'atmo-chip';
    label.setAttribute('for', id);
    label.dataset.name = row.atmosphere;
    const nameEl = document.createElement('span');
    nameEl.className = 'atmo-name';
    nameEl.textContent = row.atmosphere;
    label.append(cb, nameEl);
    grid.append(label);
  }
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-block';
  btn.textContent = 'המשך ←';
  card.append(h, sub, grid, btn);
  return new Promise((resolve) => {
    btn.addEventListener('click', () => {
      const picked = [];
      grid.querySelectorAll('.atmo-chip').forEach((chip) => {
        const cb = chip.querySelector('.atmo-checkbox');
        if (cb?.checked) picked.push(chip.dataset.name);
      });
      btn.disabled = true;
      resolve(picked);
    });
  });
}

async function mount() {
  if (!currentRows) { setStatus('load a set first', true); return; }
  const prechecked = $('usePrechecked').checked
    ? currentRows.slice(0, 3).map((r) => r.atmosphere)
    : [];
  setStatus(`mounted ${currentRows.length} rows` + (prechecked.length ? ` (prechecked: ${prechecked.join(', ')})` : ''));
  out.textContent = '(waiting for submit…)';
  try {
    const useFallback = $('forceGrid').checked;
    const picked = useFallback
      ? await renderGridFallback(currentRows, prechecked)
      : await runAtmosphereBubbles({ atmosphereRows: currentRows, prechecked });
    out.textContent = JSON.stringify(picked, null, 2);
    setStatus(`resolved with ${picked.length} selections`);
  } catch (e) {
    console.error(e);
    setStatus(`picker error: ${e.message}`, true);
    out.textContent = `Error: ${e.message}`;
  }
}

$('loadHardcoded').addEventListener('click', () => {
  currentRows = HARDCODED;
  setStatus(`loaded ${HARDCODED.length} hardcoded rows`);
});

$('loadSupabase').addEventListener('click', async () => {
  setStatus('fetching /api/v5/databox-atmospheres…');
  try {
    const r = await fetch('/api/v5/databox-atmospheres');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    currentRows = data.rows;
    setStatus(`loaded ${currentRows.length} rows from Supabase`);
  } catch (e) {
    setStatus(`fetch failed: ${e.message}`, true);
  }
});

$('mount').addEventListener('click', mount);
