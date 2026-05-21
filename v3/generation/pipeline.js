import { generateTracklist } from './tracklist.js';

export async function generatePlaylists(input, options) {
  options = options || {};
  const onProgress = options.onProgress || (() => {});
  const deps = {
    apiKey: options.apiKey,
    model: options.model,
    modelIsNew: options.modelIsNew,
    sb: options.sb,
    spotifyToken: options.spotifyToken,
    getSpotifyToken: options.getSpotifyToken,
    matchDataBox: options.matchDataBox,
  };

  const attempt = input.regenCount || 0;

  const playlist1 = await generateTracklist(1, input, {
    attempt,
    excludeIds: new Set(),
    onProgress,
  }, deps);

  const p1ids = new Set(playlist1.map(t => t.id).filter(Boolean));

  let playlist2 = await generateTracklist(2, input, {
    attempt,
    excludeIds: p1ids,
    onProgress,
  }, deps);

  playlist2 = playlist2.filter(t => !t.id || !p1ids.has(t.id));

  return { playlist1, playlist2 };
}
