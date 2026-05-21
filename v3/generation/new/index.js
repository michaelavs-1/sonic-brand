import { matchBusinessType } from './matcher.js';

const notImplemented = (name) => async () => {
  throw new Error(`SB_GEN_NEW.${name}: not implemented`);
};

window.SB_GEN_NEW = {
  generatePlaylists: notImplemented('generatePlaylists'),
  tracklist: {
    generateTracklist: notImplemented('tracklist.generateTracklist'),
  },
  matcher: {
    matchBusinessType,
  },
};
