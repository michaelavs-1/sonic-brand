// v4/random-song-from-db-genre — populates the genre dropdown from the
// playlist_genres table and renders a Spotify embed for a random cached
// track in the chosen genre on each button click.

const $ = (id) => document.getElementById(id);

async function api(action, extra = {}) {
  const r = await fetch('/api/v4/random-song-from-db-genre', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError && !!msg);
}

function setBusy(busy, idleLabel = 'Random song') {
  const btn = $('randomBtn');
  btn.disabled = busy;
  if (busy) {
    btn.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'sb-spinner' }),
      document.createTextNode('Loading…'),
    );
  } else {
    btn.textContent = idleLabel;
  }
}

function renderEmbed(spotifyId) {
  const wrap = $('embed');
  const iframe = document.createElement('iframe');
  iframe.src = `https://open.spotify.com/embed/track/${spotifyId}?utm_source=generator`;
  iframe.width = '100%';
  iframe.height = '152';
  iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  iframe.loading = 'lazy';
  wrap.replaceChildren(iframe);
}

async function loadGenres() {
  const select = $('genreSelect');
  try {
    const { genres } = await api('list_genres');
    if (!Array.isArray(genres) || !genres.length) {
      select.replaceChildren(new Option('No genres found', ''));
      setStatus('No genres found in the database.', true);
      return;
    }
    const options = [new Option('Select a genre…', '')];
    for (const g of genres) options.push(new Option(g, g));
    select.replaceChildren(...options);
    select.disabled = false;
    setStatus(`${genres.length} genres loaded.`);
  } catch (e) {
    console.error('[random-song-from-db-genre] failed to load genres', e);
    select.replaceChildren(new Option('Failed to load', ''));
    setStatus(`Failed to load genres: ${e.message}`, true);
  }
}

async function handleRandom() {
  const genre = $('genreSelect').value;
  if (!genre) {
    setStatus('Pick a genre first.', true);
    return;
  }
  setBusy(true);
  setStatus(`Picking a random track from "${genre}"…`);
  try {
    const { spotify_id } = await api('random_track', { genre });
    renderEmbed(spotify_id);
    setStatus(`Track id: ${spotify_id}`);
  } catch (e) {
    console.error('[random-song-from-db-genre] random failed', e);
    setStatus(`Failed: ${e.message}`, true);
  } finally {
    setBusy(false);
  }
}

$('randomBtn').addEventListener('click', handleRandom);
$('genreSelect').addEventListener('change', () => {
  $('randomBtn').disabled = !$('genreSelect').value;
});

loadGenres();
