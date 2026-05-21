const notImplemented = (name) => async () => {
  throw new Error(`SB_GEN_NEW.${name}: not implemented`);
};

window.SB_GEN_NEW = {
  generatePlaylists: notImplemented('generatePlaylists'),
  tracklist: {
    generateTracklist: notImplemented('tracklist.generateTracklist'),
  },
  brain: {
    buildBrainContext: async () => ({ l0: null, l1: null, l2: null, l3: null, l4: null }),
  },
};
