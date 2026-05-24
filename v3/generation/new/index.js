import { matchBusinessType } from './matcher.js';
import { assignEnergyRows } from './row-energy-assignment.js';
import { buildPlaylists } from './playlist-builder.js';

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
  rowEnergyAssignment: {
    assignEnergyRows,
  },
  playlistBuilder: {
    buildPlaylists,
  },
};
