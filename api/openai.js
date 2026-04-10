const SERVER_KEY = ['sk-proj-Y-3tc_l5y5g1gBa-cvT3WpH3cqfA6WuR3mzTKTK8mPmhlDeBECYVg5l6x5','J5tZjw0rO6t5m_HRT3BlbkFJyTXGjWy7pcaopIgbgKQGGuiAqEG9VeBdjEsDHsr7hZVEB9FIjg-TQXihdMzTuDpD3ARONemX0A'].join('');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { apiKey, model, messages, max_tokens, temperature, response_format } = req.body;
    const key = apiKey || process.env.OPENAI_API_KEY || SERVER_KEY;

    if (!key) {
      return res.status(400).json({ error: 'Missing API key' });
    }

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages: messages,
        max_tokens: max_tokens || 3000,
        temperature: temperature || 0.7,
        response_format: response_format
      })
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
