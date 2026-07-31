import { requireSite } from './origin-guard.js';
/* /api/v4/transcribe.js
   Voice-to-text for the business-description field (and anywhere else).
   Takes a short audio clip, returns Hebrew transcription via OpenAI Whisper.

   POST { audio_base64, mime }  →  { text }
   Requires OPENAI_API_KEY; returns 503 without it.
*/

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function extFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSite(req, res)) return; // pilot: block off-site abuse

  try {
    if (!OPENAI_API_KEY) return res.status(503).json({ error: 'transcription not configured' });

    const { audio_base64, mime } = req.body || {};
    if (!audio_base64) return res.status(400).json({ error: 'audio_base64 required' });

    const buf = Buffer.from(audio_base64, 'base64');
    if (buf.length < 2000) return res.status(400).json({ error: 'audio too short' });

    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), `clip.${extFor(mime)}`);
    fd.append('model', 'whisper-1');
    fd.append('language', 'he');
    fd.append('temperature', '0');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: fd,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[transcribe] whisper failed:', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: data?.error?.message || 'transcription failed' });
    }

    return res.status(200).json({ text: (data.text || '').trim() });
  } catch (err) {
    console.error('[transcribe] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
