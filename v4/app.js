// v4 frontend wiring.
// Form submit → matcher (+ atmosphere fallback) → on match: atmosphere screen
// → derive screenParams → preview/selection flow → console.log the
// desired-genres array.

import { matchBusinessType }       from '/v4/generation/matcher.js?v=04062026f';
import { matchByAtmosphere }       from '/v4/generation/fallback.js?v=04062026f';
import { runAtmosphereSelection }  from '/v4/atmosphere.js?v=04062026f';
import { deriveScreenParams }      from '/v4/generation/atmosphere-params.js?v=04062026f';
import { runPreviewFlow }          from '/v4/preview.js?v=04062026f';

const $ = (id) => document.getElementById(id);

let cachedRows  = null;
let cachedTab2  = null;
let cachedAtmos = null;

// Pass ?fresh=1 on the first hit per page load so every hard-refresh of /v4
// pulls live sheet data. Subsequent matches in the same session reuse the
// in-memory caches below.
async function getRows() {
  if (cachedRows) return cachedRows;
  const r = await fetch('/api/v4/databox?fresh=1');
  if (!r.ok) throw new Error(`databox ${r.status}: ${r.statusText}`);
  const { rows } = await r.json();
  cachedRows = rows;
  return rows;
}

async function getTab2Rows() {
  if (cachedTab2) return cachedTab2;
  const r = await fetch('/api/v4/databox-genres?fresh=1');
  if (!r.ok) throw new Error(`databox-genres ${r.status}: ${r.statusText}`);
  const { rows } = await r.json();
  cachedTab2 = rows;
  return rows;
}

async function getAtmosphereRows() {
  if (cachedAtmos) return cachedAtmos;
  const r = await fetch('/api/v4/databox-atmospheres?fresh=1');
  if (!r.ok) throw new Error(`databox-atmospheres ${r.status}: ${r.statusText}`);
  const { rows } = await r.json();
  cachedAtmos = rows;
  return rows;
}

async function onSubmit() {
  const bizNameEl = $('bizName');
  const bizDescEl = $('bizDesc');
  const btn       = $('submitBtn');

  const bizName = bizNameEl.value.trim();
  const bizDesc = bizDescEl.value.trim();

  if (bizDesc.length < 4) {
    console.warn('v4: bizDesc too short — type a few words about the business.');
    return;
  }

  console.log('v4 submit — running matcher…', { bizName, bizDesc });
  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="sb-spinner" aria-label="טוען"></span>';
  const t0 = Date.now();
  try {
    const rows = await getRows();
    let result = await matchBusinessType(bizDesc, rows);
    if (!result.matched) {
      result = await matchByAtmosphere(bizDesc, rows);
    }
    console.log('v4 match', {
      bizName,
      bizDesc,
      elapsedMs: Date.now() - t0,
      ...result,
    });

    if (!result.matched) {
      bizNameEl.value = '';
      bizDescEl.value = '';
      return;
    }

    // Atmosphere step: pre-check whatever the matched row's column-D atmospheres
    // happen to overlap with the 17 in the atmosphere sheet.
    const atmosphereRows = await getAtmosphereRows();
    const selectedAtmos  = await runAtmosphereSelection({
      atmosphereRows,
      prechecked: result.row?.atmospheres || [],
    });
    const screenParams = deriveScreenParams(selectedAtmos, atmosphereRows);
    console.log('v4 selected atmospheres:', selectedAtmos);
    console.log('v4 screenParams:', screenParams);

    const tab2Rows = await getTab2Rows();
    const desiredGenres = await runPreviewFlow({
      genres1: result.genres1,
      genres2: result.genres2,
      tab2Rows,
      screenParams,
    });
    console.log('v4 desired genres:', desiredGenres);
  } catch (err) {
    console.error('v4 error:', err);
  } finally {
    // On success the screen-card has already been replaced; these are no-ops
    // there and only matter for the no-match / error paths where the user can
    // resubmit from the original form.
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('submitBtn').addEventListener('click', onSubmit);
});
