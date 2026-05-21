import { generatePlaylists } from './pipeline.js';
import * as tracklist from './tracklist.js';
import * as pool from './pool.js';
import * as selector from './selector.js';
import * as diversity from './diversity.js';
import * as fallback from './fallback.js';
import * as brain from './brain/index.js';
import * as api from './api.js';

window.SB_GEN = {
  generatePlaylists,
  tracklist,
  pool,
  selector,
  diversity,
  fallback,
  brain,
  api,
};

console.log('[SB_GEN] generation module loaded');
