/**
 * botd-ai-backend — minimal Gemini connectivity test server.
 *
 * This is an independent Node.js backend, fully self-contained inside
 * ai-backend/. It has its own package.json / tsconfig and does NOT
 * interfere with the frontend Vite configuration at the repository root.
 */
import 'dotenv/config';
import express, { type Request, type Response } from 'express';

import { GEMINI_MODEL } from './config';
import { callGemini, GeminiError } from './gemini';

const app = express();
app.use(express.json({ limit: '64kb' }));

// ---------------------------------------------------------------------------
// GET /health — liveness probe. Never calls Gemini.
// ---------------------------------------------------------------------------
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'botd-ai-backend' });
});

// ---------------------------------------------------------------------------
// POST /ai/test — minimal Gemini connectivity test.
// Reads GEMINI_API_KEY from env, calls generateContent with a fixed prompt,
// and returns { success, model, text }. Never returns or logs the key.
// ---------------------------------------------------------------------------
app.post('/ai/test', async (_req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'GEMINI_API_KEY is not configured on the server.',
    });
  }

  const prompt = 'Reply with a short confirmation that the BOTD AI backend is connected.';

  try {
    const text = await callGemini({ apiKey, model: GEMINI_MODEL, prompt });
    return res.status(200).json({ success: true, model: GEMINI_MODEL, text });
  } catch (err) {
    if (err instanceof GeminiError) {
      // err.status is already the status Gemini returned (4xx/5xx).
      // Invalid/unexpected Gemini responses are surfaced as 502 upstream
      // errors; API errors are passed through with a safe message.
      const status = err.status ?? 502;
      return res.status(status).json({
        success: false,
        error: err.safeMessage,
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Unexpected server error while contacting Gemini.',
    });
  }
});

// ---------------------------------------------------------------------------
// Fallbacks — keep error payloads free of secrets and stack traces.
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Not found.' });
});

app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
  void err; // never echo raw error details (may contain env/request data)
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ---------------------------------------------------------------------------
// Render-compatible listener: 0.0.0.0 and dynamic PORT.
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(Number(PORT), HOST, () => {
  console.log(`botd-ai-backend listening on ${HOST}:${PORT} (model: ${GEMINI_MODEL})`);
});
