/* Auth for Ami's tool endpoints (/api/v4/ami-*), added 2026-10-24.

   Until then they had no check at all: any visitor could delete catalog
   playlists and tracks, edit genres or drive the scans. Now each one needs
   the admin key (INTERNAL_ADMIN_API_KEY) — Ami's dashboards send the key he
   enters once, kept in the browser's localStorage under 'ami-admin-key' —
   or the internal key, for server-to-server calls.

   Not an HTTP endpoint. Bare imports only. */

import { isInternal } from '../v6/origin-guard.js';
import { requireAdmin } from '../internal/_guard.js';

export function requireAmi(req, res) {
  if (isInternal(req)) return true;
  return requireAdmin(req, res);
}
