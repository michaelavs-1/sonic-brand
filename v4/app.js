// v4 frontend wiring.
// Form submit → matcher (+ atmosphere fallback) → on match: atmosphere screen
// → derive screenParams → preview/selection flow → console.log the
// desired-genres array.

import { matchBusinessType }       from '/v4/generation/matcher.js?v=16062026b';
import { matchByAtmosphere }       from '/v4/generation/fallback.js?v=16062026b';
import { runAtmosphereSelection }  from '/v4/atmosphere.js?v=16062026b';
import { deriveScreenParams }      from '/v4/generation/atmosphere-params.js?v=16062026b';
import { runPreviewFlow }          from '/v4/preview.js?v=16062026b';
import { buildFinalPlaylist }      from '/v4/generation/playlist-builder.js?v=16062026b';
import { showBuildingPlaylist, showPlaylistResult } from '/v4/result.js?v=16062026b';

const $ = (id) => document.getElementById(id);

let cachedRows  = null;
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
  const ts = (label) => console.log(`v4 timing [${Date.now() - t0}ms] ${label}`);
  try {
    // Pre-fetch atmosphere rows in parallel with the matcher's GPT call. The
    // matcher takes ~5-10s; the fetch is ~300-500ms. By the time the matcher
    // returns, atmosphere rows are ready. (Tab 2 is no longer needed at the
    // frontend — the cached-preview endpoint reads it server-side.)
    const atmospheresPromise = getAtmosphereRows();

    const rows = await getRows();
    ts('Tab 1 fetched (matcher about to call GPT)');
    let result = await matchBusinessType(bizDesc, rows);
    if (!result.matched) {
      result = await matchByAtmosphere(bizDesc, rows);
    }
    ts(`matcher done (matched=${result.matched}${result.matched ? `, bizType="${result.bizType}"` : ''})`);
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
    const atmosphereRows = await atmospheresPromise;
    ts('atmosphere rows ready');
    const selectedAtmos  = await runAtmosphereSelection({
      atmosphereRows,
      prechecked: result.row?.atmospheres || [],
    });
    ts(`atmosphere submit clicked (selected ${selectedAtmos.length})`);
    const screenParams = deriveScreenParams(selectedAtmos, atmosphereRows);
    console.log('v4 selected atmospheres:', selectedAtmos);
    console.log('v4 screenParams:', screenParams);

    ts('preview flow starting');
    const { strictGenres, relaxedGenres } = await runPreviewFlow({
      bizType: result.bizType,
      screenParams,
    });
    ts('preview flow complete');
    console.log('v4 strict genres: ', strictGenres);
    console.log('v4 relaxed genres:', relaxedGenres);
    console.log('v4 screen params: ', screenParams);

    showBuildingPlaylist();
    ts('playlist build starting');
    const built = await buildFinalPlaylist({
      bizType:       result.bizType,
      bizName,
      strictGenres,
      relaxedGenres,
      screenParams,
    });
    ts(`playlist build done (skipped=${!!built.skipped}, tracks=${built.trackCount || 0})`);
    console.log('v4 built playlist:', built);

    await showPlaylistResult(built);
    ts('full flow complete');
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
