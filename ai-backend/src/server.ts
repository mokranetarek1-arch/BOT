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
import { processInboundMessage } from './pipeline';
import { AiProviderError, runExtraction } from './provider';
import {
  buildCrmSchema,
  buildExtractionPrompt,
  EXTRACTION_GENERATION_CONFIG,
  getPromptVersion,
  normalizeCrmFieldUpdates,
  parseModelJson,
  sanitizeCrmFields,
  sanitizeMessages,
  CrmSchemaError,
  CrmExtractionError,
} from './extractCrmFields';

const app = express();

// ---------------------------------------------------------------------------
// CORS — the frontend (Vercel or localhost) calls this API from a DIFFERENT
// origin, so the browser first sends an OPTIONS preflight and refuses the
// whole request with a bare "Failed to fetch" unless this API answers with the
// Access-Control-* headers. Implemented by hand to keep the dependency list
// minimal.
//
// ALLOWED_ORIGINS (comma separated) restricts browsers when set; when unset any
// origin is allowed — this API is public and carries no browser credentials.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req: Request, res: Response, next: () => void) => {
  const origin = req.header('origin');
  const allowOrigin =
    ALLOWED_ORIGINS.length === 0
      ? '*'
      : origin && ALLOWED_ORIGINS.includes(origin)
        ? origin
        : null;

  if (allowOrigin) {
    res.header('Access-Control-Allow-Origin', allowOrigin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');
    res.header('Access-Control-Max-Age', '86400');
  }
  res.header('Vary', 'Origin');

  // Preflight: answer immediately, never reach the routes.
  if (req.method === 'OPTIONS') {
    res.status(allowOrigin ? 204 : 403).end();
    return;
  }
  next();
});

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
// POST /ai/extract-crm-fields — manual CRM field extraction (fallback/debug).
//
// Body: {
//   organization_id, contact_id,
//   crm_fields: [ { field_name, field_label, field_type, options?,
//                   description_for_ai?, target?: 'contact'|'custom' } ],
//   messages:   [ { id, direction: 'inbound'|'outbound', text } ]
// }
//
// Pure extraction: this route never touches the database. The caller (the CRM
// frontend, or bright-worker for a re-run) owns persistence through RLS.
//
// Returns: { success, provider, model, prompt_version, contact_id,
//            organization_id, crm_fields_used, updates: [ { field, value,
//            confidence, evidence_message_id } ] }
// `provider` is additive metadata: 'gemini' | 'openrouter' — which model actually
// answered. Every previously returned field is unchanged.
// ---------------------------------------------------------------------------
app.post('/ai/extract-crm-fields', async (req: Request, res: Response) => {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  // Dev/test only: AI_TEST_PROVIDER=openrouter exercises the fallback provider
  // directly without needing a real Gemini outage. Server-side env only —
  // a client request can never set it (no production security hole).
  const forcesOpenRouter = (process.env.AI_TEST_PROVIDER ?? '').trim().toLowerCase() === 'openrouter';
  if (forcesOpenRouter ? !openrouterApiKey : !geminiApiKey) {
    return res.status(500).json({
      success: false,
      error: forcesOpenRouter
        ? 'OPENROUTER_API_KEY is not configured on the server.'
        : 'GEMINI_API_KEY is not configured on the server.',
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
  const organizationId =
    typeof body.organization_id === 'string' ? body.organization_id.trim() : '';

  if (!contactId || !organizationId) {
    return res.status(400).json({
      success: false,
      error: 'contact_id and organization_id are required strings.',
    });
  }

  // CRM schema + conversation messages are validated, sent through the AI
  // provider chain and normalized inside one block so every failure keeps its
  // own HTTP status. Sequential fallback: Gemini (primary, one transient
  // retry) → OpenRouter free-model chain (same prompt) — never in parallel.
  try {
    const fields = buildCrmSchema(sanitizeCrmFields(body.crm_fields));
    const messages = sanitizeMessages(body.messages);

    const extraction = await runExtraction({
      geminiApiKey,
      openrouterApiKey,
      prompt: buildExtractionPrompt(fields, messages),
      generationConfig: EXTRACTION_GENERATION_CONFIG,
    });

    // Invalid/unexpected model output => 502 upstream error. Unsupported
    // updates are simply dropped by the validator (the CRM field stays as-is).
    // Provider-agnostic: this validation is IDENTICAL for Gemini and OpenRouter.
    const updates = normalizeCrmFieldUpdates(parseModelJson(extraction.text), fields, messages);

    return res.status(200).json({
      success: true,
      // Additive metadata — which provider/model actually answered. All
      // previously returned fields are unchanged (frontend contract intact).
      provider: extraction.provider,
      model: extraction.model,
      prompt_version: getPromptVersion(),
      contact_id: contactId,
      organization_id: organizationId,
      crm_fields_used: fields.length,
      updates,
    });
  } catch (err) {
    if (err instanceof CrmSchemaError) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof CrmExtractionError) {
      return res.status(502).json({ success: false, error: err.message });
    }
    if (err instanceof AiProviderError) {
      // Clean, secret-free provider failure (Gemini exhausted its retry and
      // the OpenRouter fallback failed, or a single non-transient provider error).
      const status = err.status ?? 502;
      return res.status(status).json({ success: false, error: err.safeMessage });
    }
    return res.status(500).json({
      success: false,
      error: 'Unexpected server error while extracting CRM fields.',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/webhook/message — AUTOMATIC background pipeline trigger.
//
// Called by bright-worker (Supabase Edge Function) on every inbound message.
// The pipeline loads the conversation transcript + the organization's CRM
// schema, extracts the CRM values through the AI provider chain (Gemini
// primary → one transient retry → sequential OpenRouter fallback) and writes
// everything server-side: contact_custom_values + the conservative contacts
// update. (No contact_ai_insights write path — the AI fills CRM fields only.)
//
// Auth: optional shared secret — when WEBHOOK_SECRET is set, callers must
// send it in the `x-webhook-secret` header (bright-worker does).
// Body: { organization_id, contact_id, conversation_id, message_id? }
// ---------------------------------------------------------------------------
app.post('/ai/webhook/message', async (req: Request, res: Response) => {
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret) {
    const provided = req.header('x-webhook-secret');
    if (provided !== expectedSecret) {
      return res.status(401).json({ success: false, error: 'Invalid webhook secret.' });
    }
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  // Same dev/test override as /ai/extract-crm-fields (server-side env only).
  const forcesOpenRouter =
    (process.env.AI_TEST_PROVIDER ?? '').trim().toLowerCase() === 'openrouter';
  if (forcesOpenRouter ? !openrouterApiKey : !geminiApiKey) {
    return res.status(500).json({
      success: false,
      error: forcesOpenRouter
        ? 'OPENROUTER_API_KEY is not configured on the server.'
        : 'GEMINI_API_KEY is not configured on the server.',
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const organizationId = typeof body.organization_id === 'string' ? body.organization_id.trim() : '';
  const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';

  if (!organizationId || !contactId || !conversationId) {
    return res.status(400).json({
      success: false,
      error: 'organization_id, contact_id and conversation_id are required strings.',
    });
  }

  try {
    const result = await processInboundMessage(
      { geminiApiKey, openrouterApiKey },
      { organizationId, contactId, conversationId },
    );
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    if (err instanceof CrmExtractionError) {
      return res.status(502).json({ success: false, error: err.message });
    }
    if (err instanceof AiProviderError) {
      // Clean, secret-free provider failure — status is already safe to show.
      const status = err.status ?? 502;
      return res.status(status).json({ success: false, error: err.safeMessage });
    }
    // Pipeline errors are safe messages built server-side (no secrets inside).
    const message = err instanceof Error ? err.message : 'Automatic extraction failed.';
    const status = message.includes('not found') ? 404 : 500;
    return res.status(status).json({ success: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// Fallbacks — keep error payloads free of secrets and stack traces.
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Not found.' });
});

app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
  // Malformed JSON bodies are client errors, not server failures.
  if (err instanceof SyntaxError) {
    res.status(400).json({ success: false, error: 'Invalid JSON body.' });
    return;
  }
  // never echo raw error details (may contain env/request data)
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
