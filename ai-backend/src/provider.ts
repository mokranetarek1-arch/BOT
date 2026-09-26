/**
 * Sequential AI provider orchestration for conversation analysis (CRM field
 * extraction).
 *
 * Flow — strictly sequential, never parallel:
 *   1. Gemini (primary) — one attempt.
 *   2. On a TEMPORARY provider problem only (HTTP 429/500/502/503/504,
 *      network error, timeout): retry Gemini ONCE with a short exponential
 *      backoff.
 *   3. If Gemini still fails transiently, walk the FREE OpenRouter models one
 *      model at a time (resolveModelChain → first success wins).
 *   4. If every free model fails: throw AiProviderError — a clean, secret-free
 *      message (HTTP 503) the routes forward to the caller. Never swallowed.
 *
 * The prompt and the downstream validation layer are untouched: whichever
 * provider/model answers, its raw text goes through parseModelJson +
 * normalizeCrmFieldUpdates exactly as before, so the extraction contract and
 * the stored data shape stay identical. Additionally validateModelText runs
 * INSIDE the chain per OpenRouter model, so an invalid/foreign response fails
 * that model attempt and the chain moves to the next free model.
 *
 * Logging is server-side and safe by construction: provider, model, HTTP
 * status, attempt/fallback decisions and durations only — never API keys,
 * prompts, messages, authorization headers, customer data or model responses.
 */
import { callGemini, GeminiError } from './gemini';
import { callOpenRouter, OpenRouterError, resolveModelChain } from './openrouter';
import { GEMINI_MODEL, GEMINI_RETRY_BASE_DELAY_MS, TRANSIENT_AI_STATUSES } from './config';

export type AiProvider = 'gemini' | 'openrouter';

/** Server-side API keys — read from the environment, never from a client. */
export interface AiKeys {
  geminiApiKey?: string;
  openrouterApiKey?: string;
}

/** Clean error surfaced by the routes when no provider could answer. */
export class AiProviderError extends Error {
  status?: number;
  safeMessage: string;

  constructor(safeMessage: string, status?: number) {
    super(safeMessage);
    this.name = 'AiProviderError';
    this.status = status;
    this.safeMessage = safeMessage;
  }
}

export interface RunExtractionParams extends AiKeys {
  /** The exact prompt string — identical for every provider/model. */
  prompt: string;
  /** Gemini-only generationConfig (ignored by OpenRouter). */
  generationConfig?: Record<string, unknown>;
  /**
   * Runs on EACH OpenRouter model attempt before the chain accepts its text
   * (callers pass parseModelJson + normalizeCrmFieldUpdates). A throwing
   * validator fails that model and the chain moves to the next free model.
   * Gemini text is still validated OUTSIDE runExtraction, exactly as before.
   */
  validateModelText?: (text: string) => void;
}

export interface RunExtractionResult {
  /** Which provider actually produced the text. */
  provider: AiProvider;
  /** Model that produced the text (depends on the provider used). */
  model: string;
  text: string;
  /** Total wall-clock duration across retries/fallback, in milliseconds. */
  duration_ms: number;
}

/**
 * Dev/test-only override (AI_TEST_PROVIDER env var, server-side only):
 *   'openrouter' → skip Gemini and walk the OpenRouter chain directly
 *                  (exercises the fallback path without a real Gemini outage);
 *   'gemini'     → Gemini only, never retries or falls back (exercises the
 *                  primary path in isolation);
 *   unset        → production behavior (Gemini → one retry → OpenRouter).
 * No client request can set it, so it cannot open a production security hole.
 * Test mode NEVER bypasses validation.
 */
function resolveTestOverride(): AiProvider | null {
  const raw = (process.env.AI_TEST_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'gemini' || raw === 'openrouter') return raw;
  if (raw) logAiEvent('warn', { reason: 'unknown_ai_test_provider', value: raw });
  return null;
}

/** Whitelisted metadata only — never keys, prompts, messages or headers. */
function logAiEvent(event: string, fields: Record<string, unknown>): void {
  console.log(`[ai-provider] ${event} ${JSON.stringify(fields)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps any provider error onto its status + safe (secret-free) message. */
function toStatusAndMessage(err: unknown): { status: number; safeMessage: string } {
  if (err instanceof GeminiError || err instanceof OpenRouterError) {
    return { status: err.status ?? 502, safeMessage: err.safeMessage };
  }
  return { status: 502, safeMessage: 'AI provider request failed.' };
}

function isTransient(status: number): boolean {
  return TRANSIENT_AI_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// OPENROUTER FREE-MODEL CHAIN — sequential, first success wins.
// ---------------------------------------------------------------------------

/**
 * Tries ONE free OpenRouter model: request → (optional per-model validation).
 * A transport error, transient status, timeout, unexpected shape OR a
 * validator throw (invalid JSON / schema mismatch) fails this model attempt
 * and returns null so the chain moves to the next free model. Logged safely:
 * model, status and duration only — never the response body (it can contain
 * customer data).
 */
async function tryOpenRouterModel(params: {
  openrouterApiKey: string;
  model: string;
  prompt: string;
  validateModelText?: (text: string) => void;
}): Promise<RunExtractionResult | null> {
  const started = Date.now();
  try {
    const text = await callOpenRouter({
      apiKey: params.openrouterApiKey,
      model: params.model,
      prompt: params.prompt,
    });
    try {
      params.validateModelText?.(text);
    } catch (err) {
      // Error NAME only — messages can embed schema/input details.
      const reason = err instanceof Error && err.name ? err.name : 'validation_failed';
      logAiEvent('model_failed', {
        provider: 'openrouter',
        model: params.model,
        status: 'validation_failed',
        reason,
        duration_ms: Date.now() - started,
      });
      return null;
    }
    const duration = Date.now() - started;
    logAiEvent('success', {
      provider: 'openrouter',
      model: params.model,
      fallback: true,
      duration_ms: duration,
    });
    return { provider: 'openrouter', model: params.model, text, duration_ms: duration };
  } catch (err) {
    const { status } = toStatusAndMessage(err);
    logAiEvent('model_failed', {
      provider: 'openrouter',
      model: params.model,
      status,
      duration_ms: Date.now() - started,
    });
    return null;
  }
}

/**
 * Resolves the free-model list (discovery or env pin) and walks it one model
 * at a time until one succeeds and passes validation. Returns null when every
 * tried model failed; discovery failures throw (a missing/unreachable
 * models-list endpoint is a provider-level error, not a model failure).
 */
async function runOpenRouterChain(
  openrouterApiKey: string,
  prompt: string,
  validateModelText: ((text: string) => void) | undefined,
): Promise<{ result: RunExtractionResult | null; tried: number }> {
  const models = await resolveModelChain();
  let tried = 0;

  for (const model of models) {
    tried += 1;
    const result = await tryOpenRouterModel({
      openrouterApiKey,
      model,
      prompt,
      validateModelText,
    });
    if (result) return { result, tried };
  }

  return { result: null, tried };
}

// ---------------------------------------------------------------------------
// ORCHESTRATION — Gemini → one transient retry → sequential OpenRouter chain.
// ---------------------------------------------------------------------------

/**
 * Runs one conversation-analysis request through the provider chain and
 * returns the raw model text plus which provider/model produced it.
 *
 * The caller still runs the SAME parse/validate layer on the returned text;
 * `validateModelText` is only an EXTRA per-attempt gate for OpenRouter models
 * so an invalid response fails that model instead of being accepted blindly.
 */
export async function runExtraction(params: RunExtractionParams): Promise<RunExtractionResult> {
  const started = Date.now();
  const override = resolveTestOverride();
  if (override) logAiEvent('test_override', { provider: override });
  const { prompt } = params;

  const openrouterApiKey = params.openrouterApiKey;

  // Dev/test: OpenRouter only — Gemini is never invoked, validation still runs.
  if (override === 'openrouter') {
    if (!openrouterApiKey) {
      throw new AiProviderError('OPENROUTER_API_KEY is not configured on the server.', 500);
    }
    const { result, tried } = await runOpenRouterChain(
      openrouterApiKey,
      prompt,
      params.validateModelText,
    );
    const duration = Date.now() - started;
    if (result) return result;
    logAiEvent('failure', {
      provider: 'openrouter',
      attempts: tried,
      total_duration_ms: duration,
    });
    throw new AiProviderError(
      'Every OpenRouter free model attempt failed. Check provider logs for details.',
      503,
    );
  }

  // Primary path: Gemini (retry once on temporary failures).
  const geminiApiKey = params.geminiApiKey;
  if (!geminiApiKey) {
    throw new AiProviderError('GEMINI_API_KEY is not configured on the server.', 500);
  }

  let failure: { status: number; safeMessage: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    logAiEvent('attempt', { provider: 'gemini', attempt });
    try {
      const text = await callGemini({
        apiKey: geminiApiKey,
        model: GEMINI_MODEL,
        prompt,
        generationConfig: params.generationConfig,
      });
      const duration = Date.now() - started;
      logAiEvent('success', {
        provider: 'gemini',
        model: GEMINI_MODEL,
        attempt,
        duration_ms: duration,
      });
      return { provider: 'gemini', model: GEMINI_MODEL, text, duration_ms: duration };
    } catch (err) {
      failure = toStatusAndMessage(err);

      // One retry ONLY for temporary provider problems; the 'gemini' test
      // override never retries. A non-transient status (400/401/403/404 …) is
      // a configuration/request error — surface it immediately.
      const retryAllowed = attempt === 1 && isTransient(failure.status) && override !== 'gemini';
      if (!retryAllowed) break;

      const delayMs = GEMINI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      logAiEvent('retry', {
        provider: 'gemini',
        next_attempt: attempt + 1,
        status: failure.status,
        delay_ms: delayMs,
      });
      await sleep(delayMs);
    }
  }

  const geminiFailure = failure ?? { status: 502, safeMessage: 'Gemini failed without a status.' };

  // No fallback for non-transient errors or when the test override forces the
  // primary path — surface the Gemini failure exactly as before.
  if (override === 'gemini' || !isTransient(geminiFailure.status)) {
    logAiEvent('failure', {
      provider: 'gemini',
      status: geminiFailure.status,
      transient: isTransient(geminiFailure.status),
      total_duration_ms: Date.now() - started,
    });
    throw new AiProviderError(geminiFailure.safeMessage, geminiFailure.status);
  }

  // Fallback: sequential OpenRouter free models — first success wins.
  if (!openrouterApiKey) {
    logAiEvent('fallback_skipped', {
      from: 'gemini',
      to: 'openrouter',
      reason: 'openrouter_key_missing',
      status: geminiFailure.status,
    });
    throw new AiProviderError(geminiFailure.safeMessage, geminiFailure.status);
  }

  logAiEvent('fallback_triggered', {
    from: 'gemini',
    to: 'openrouter',
    reason: `gemini_status_${geminiFailure.status}`,
  });

  try {
    const { result, tried } = await runOpenRouterChain(
      openrouterApiKey,
      prompt,
      params.validateModelText,
    );
    const duration = Date.now() - started;
    if (result) return result;

    logAiEvent('failure', {
      providers: ['gemini', 'openrouter'],
      gemini_status: geminiFailure.status,
      openrouter_attempts: tried,
      total_duration_ms: duration,
    });
    throw new AiProviderError(
      `AI providers unavailable: Gemini failed with status ${geminiFailure.status} ` +
        `(${geminiFailure.safeMessage}) and every OpenRouter free model attempt failed.`,
      503,
    );
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    const { status, safeMessage } = toStatusAndMessage(err);
    logAiEvent('failure', {
      providers: ['gemini', 'openrouter'],
      gemini_status: geminiFailure.status,
      openrouter_status: status,
      total_duration_ms: Date.now() - started,
    });
    throw new AiProviderError(
      `AI providers unavailable: Gemini failed with status ${geminiFailure.status} ` +
        `(${geminiFailure.safeMessage}) and OpenRouter failed with status ${status} ` +
        `(${safeMessage}).`,
      503,
    );
  }
}

