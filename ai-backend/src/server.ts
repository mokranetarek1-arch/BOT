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
import {
  MAX_MESSAGE_LENGTH,
  LEAD_GENERATION_CONFIG,
  buildLeadPrompt,
  getPromptVersion,
  normalizeLeadAnalysis,
  parseModelJson,
  GeminiSafeParseError,
} from './analyzeLead';

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
// POST /ai/analyze-lead — lead analysis for the CRM smart pipeline.
//
// Body: { message_text, contact_id, organization_id }
// contact_id / organization_id are validated and echoed back for correlation
// but never sent to Gemini (only message_text is analyzed).
// Returns: { success, model, prompt_version, contact_id, organization_id, data }
// where data = { client_name, phone_number, intent, product_or_service,
//                lead_score, summary, suggested_reply } (JSON only).
// ---------------------------------------------------------------------------
app.post('/ai/analyze-lead', async (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'GEMINI_API_KEY is not configured on the server.',
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const messageText = typeof body.message_text === 'string' ? body.message_text.trim() : '';
  const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
  const organizationId =
    typeof body.organization_id === 'string' ? body.organization_id.trim() : '';

  if (!messageText || !contactId || !organizationId) {
    return res.status(400).json({
      success: false,
      error: 'message_text, contact_id and organization_id are required strings.',
    });
  }
  if (messageText.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `message_text exceeds the maximum length of ${MAX_MESSAGE_LENGTH} characters.`,
    });
  }

  try {
    const text = await callGemini({
      apiKey,
      model: GEMINI_MODEL,
      prompt: buildLeadPrompt(messageText),
      generationConfig: LEAD_GENERATION_CONFIG,
    });

    // Invalid/unexpected model output => 502 upstream error.
    const data = normalizeLeadAnalysis(parseModelJson(text));

    return res.status(200).json({
      success: true,
      model: GEMINI_MODEL,
      prompt_version: getPromptVersion(),
      contact_id: contactId,
      organization_id: organizationId,
      data,
    });
  } catch (err) {
    if (err instanceof GeminiSafeParseError) {
      return res.status(502).json({ success: false, error: err.message });
    }
    if (err instanceof GeminiError) {
      const status = err.status ?? 502;
      return res.status(status).json({ success: false, error: err.safeMessage });
    }
    return res.status(500).json({
      success: false,
      error: 'Unexpected server error while analyzing the lead.',
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
