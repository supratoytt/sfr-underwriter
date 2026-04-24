// ─────────────────────────────────────────────────────────────────────────────
// pages/api/underwrite.js
//
// This file runs on the SERVER (Vercel), not in the browser.
// Your Anthropic API key stays here — users never see it.
// ──────────────────────────────────────────────────────────────────────────────

export const config = {
  api: {
    // Allow large payloads (web search results can be verbose)
    bodyParser: {
      sizeLimit: '4mb',
    },
    // Extend timeout to 90 seconds for web search analyses
    responseLimit: false,
  },
  // Tell Vercel this function can run up to 60 seconds
  maxDuration: 60,
};

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Make sure the API key is configured
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return res.status(500).json({
      error: 'Server configuration error: API key not set. Please add ANTHROPIC_API_KEY in your Vercel environment variables.',
    });
  }

  try {
    const { messages, system, model, max_tokens, tools } = req.body;

    // Forward the request to Anthropic
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 4000,
        system,
        messages,
        tools,
      }),
    });

    if (!anthropicResponse.ok) {
      const errorBody = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, errorBody);
      return res.status(anthropicResponse.status).json({
        error: `Anthropic API error: ${anthropicResponse.status}`,
        detail: errorBody,
      });
    }

    const data = await anthropicResponse.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
