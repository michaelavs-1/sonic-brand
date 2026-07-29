// v5 frontend orchestration.
//
// Flow: form → atmospheres → GPT musical-directions → console.log the full
// GPT output (only log kept) → two pages of anchor-track previews → build a
// playlist per selected direction (10 tracks, BPM+popularity screen only) →
// show a result accordion per playlist.

import { generateMusicalDirections } from '/v5/generation/musical-directions.js?v=28072026o';
import { runAtmosphereSelection }    from '/v5/atmosphere.js?v=28072026o';
import { derivePopularityWindow }    from '/v5/generation/popularity-window.js?v=28072026o';
import { runDirectionPreviewFlow }   from '/v5/preview.js?v=28072026o';
import { buildDirectionPlaylists }   from '/v5/generation/playlist-builder.js?v=28072026o';
import { initPlaylistResultsShell, updateOnePlaylistResult, finalizePlaylistResultsHeading } from '/v5/result.js?v=28072026o';

const $ = (id) => document.getElementById(id);

let cachedAtmos = null;

async function getAtmosphereRows() {
  if (cachedAtmos) return cachedAtmos;
  const r = await fetch('/api/v5/databox-atmospheres?fresh=1');
  if (!r.ok) throw new Error(`databox-atmospheres ${r.status}: ${r.statusText}`);
  const { rows } = await r.json();
  cachedAtmos = rows;
  return rows;
}

function showError(message) {
  const card = document.querySelector('.screen-card');
  if (!card) return;
  const h = document.createElement('h1');
  h.textContent = 'לא הצלחנו להתאים כיוונים מוזיקליים';
  const p = document.createElement('p');
  p.className = 'preview-empty';
  p.textContent = message || 'נסו לתאר את העסק בצורה שונה.';
  card.replaceChildren(h, p);
}

async function onSubmit() {
  const bizNameEl = $('bizName');
  const bizDescEl = $('bizDesc');
  const btn       = $('submitBtn');

  const bizName = bizNameEl.value.trim();
  const bizDesc = bizDescEl.value.trim();

  if (bizDesc.length < 4) return;

  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="sb-spinner" aria-label="טוען"></span>';

  // Re-warm Supabase now. Runs in parallel with atmospheres + Anthropic, so
  // by the time anchor-tracks needs Postgres, the plan cache is warm on the
  // connection PgBouncer just handed us. Fire-and-forget.
  prewarmSupabase();

  try {
    const atmospheresPromise = getAtmosphereRows();
    const atmosphereRows     = await atmospheresPromise;

    const selectedAtmos = await runAtmosphereSelection({ atmosphereRows });

    const directionsResult = await generateMusicalDirections({
      bizName,
      bizDesc,
      atmospheres: selectedAtmos,
    });

    // Log page 1. Page 2 arrives in the background and is logged inside
    // musical-directions.js via callAnthropic.
    console.log('v5 musical directions (page 1):', {
      directions: directionsResult.directions,
      error:      directionsResult.error,
    });

    if (directionsResult.error) {
      showError(directionsResult.reasoning_en
        ? `סיבה: ${directionsResult.reasoning_en}`
        : undefined);
      return;
    }

    const popularityWindow = derivePopularityWindow(selectedAtmos, atmosphereRows);

    const picked = await runDirectionPreviewFlow({
      directions:   directionsResult.directions,
      page2Promise: directionsResult.page2Promise,
      popularityWindow,
    });

    if (!picked.length) {
      const card = document.querySelector('.screen-card');
      if (card) {
        const h = document.createElement('h1');
        h.textContent = 'לא נבחרו כיוונים';
        const p = document.createElement('p');
        p.className = 'preview-empty';
        p.textContent = 'נסו שוב וסמנו לפחות שיר אחד.';
        card.replaceChildren(h, p);
      }
      return;
    }

    // Render placeholder cards up front, one per direction. Playlist builds
    // fire in parallel and each finished result swaps into its own placeholder
    // as it arrives — so the user sees the fastest ones immediately instead of
    // waiting for the slowest.
    initPlaylistResultsShell(picked);

    const results = await buildDirectionPlaylists({
      selectedDirections: picked,
      bizName,
      popularityWindow,
      onProgress: (index, result) => updateOnePlaylistResult(index, result),
    });

    finalizePlaylistResultsHeading(results);
  } catch (err) {
    showError(err?.message || 'תקלה לא צפויה.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
  }
}

// Fire-and-forget prewarm. Postgres query plans are session-scoped; the very
// first call to each RPC has to compile the plan, which can push past
// Supabase's 3s statement_timeout on a cold connection. The /prewarm endpoint
// fires both RPCs and always returns 200, so any cold-start timeouts stay on
// the server and don't clutter the browser console.
function prewarmSupabase() {
  fetch('/api/v5/prewarm').catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  $('submitBtn').addEventListener('click', onSubmit);
  prewarmSupabase();
});
