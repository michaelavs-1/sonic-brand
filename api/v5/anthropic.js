/* /api/v5/anthropic.js
   Anthropic Messages API proxy for the v5 pipeline.
   Key source: process.env.ANTHROPIC_KEY. No body-supplied keys.

   Auth: requireSiteOrInternal — browsers on our site OR server-to-server
   callers carrying `x-sonic-internal: INTERNAL_API_KEY`. Anonymous internet
   traffic hits 403, so ANTHROPIC_KEY spend can only be caused by our own code.

   Model + max_tokens are locked down server-side to prevent a compromised
   browser from asking for gpt-scale outputs on our dime.
*/

import { requireSiteOrInternal, setCors } from '../v6/origin-guard.js';
import { guard } from '../v6/ratelimit.js';

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const MAX_TOKENS_CAP = 4096;

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sonic-internal');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSiteOrInternal(req, res)) return;
  if (!await guard(req, res, 'anthropic', 10, 60)) return;

  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

  const { model, system, messages, max_tokens } = req.body || {};
  if (!model || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'model and non-empty messages are required' });
  }
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: `model "${model}" not in allowlist` });
  }

  const payload = {
    model,
    max_tokens: Math.min(Number(max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
    messages,
  };
  if (system) payload.system = system;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upstream fetch failed' });
  }
}
