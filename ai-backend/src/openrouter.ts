/**
 * Minimal direct REST client for OpenRouter — the sequential FALLBACK provider
 * used when Gemini is temporarily unavailable. No SDK, no framework — just
 * fetch (same style as gemini.ts), so no new dependencies are introduced.
 *
 * Also home of the FREE-MODEL RESOLUTION: models are discovered dynamically
 * through the public GET /models endpoint (pricing "0" for prompt+completion,
 * text in/out), sorted deterministically by id, unless the operator pins them
 * via OPENROUTER_FREE_MODELS / AI_TEST_MODEL. Never logs or exposes the key.
 */
import {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MAX_MODELS,
  DEFAULT_OPENROUTER_TIMEOUT_MS,
} from './config';

/** Safe error type: carries an HTTP status and a secret-free message. */
export class OpenRouterError extends Error {
  status?: number;
  safeMessage: string;

  constructor(safeMessage: string, status?: number) {
    super(safeMessage);
    this.name = 'OpenRouterError';
    this.status = status;
    this.safeMessage = safeMessage;
  }
}

/** Env: OPENROUTER_BASE_URL (default https://openrouter.ai/api/v1). */
export function resolveOpenRouterBaseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL ?? '').trim() || DEFAULT_OPENROUTER_BASE_URL;
}

/** Env: OPENROUTER_TIMEOUT_MS — per-model attempt deadline. */
export function resolveOpenRouterTimeoutMs(): number {
  const raw = Number(process.env.OPENROUTER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OPENROUTER_TIMEOUT_MS;
}

/** Env: OPENROUTER_MAX_MODELS — cap of free models tried per request. */
export function resolveOpenRouterMaxModels(): number {
  const raw = Number(process.env.OPENROUTER_MAX_MODELS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_OPENROUTER_MAX_MODELS;
}

/** Env: OPENROUTER_FREE_MODELS — explicit comma-separated override list. */
function resolveEnvModels(): string[] {
  return (process.env.OPENROUTER_FREE_MODELS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Env: AI_TEST_MODEL — dev-only pin of a single model (never skips validation). */
function resolveTestModel(): string | null {
  return (process.env.AI_TEST_MODEL ?? '').trim() || null;
}

// ---------------------------------------------------------------------------
// FREE-MODEL DISCOVERY
// ---------------------------------------------------------------------------

/**
 * Cached result of the dynamic discovery. TTL-based so a burst of fallback
 * requests shares one upstream GET /models call, while still picking up models
 * that OpenRouter adds/retires between requests.
 */
const FREE_MODEL_CACHE_TTL_MS = 5 * 60_000;
let freeModelCache: { fetchedAt: number; ids: string[] } | null = null;

/** True only when BOTH prompt and completion pricing are exactly zero. */
function isFreeModel(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const pricing = (entry as { pricing?: { prompt?: unknown; completion?: unknown } }).pricing;
  if (typeof pricing !== 'object' || pricing === null) return false;
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  return (
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt === 0 &&
    completion === 0
  );
}

/** Keeps only models that accept text input and produce text output. */
function supportsText(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const arch = (entry as { architecture?: { input_modalities?: unknown; output_modalities?: unknown } })
    .architecture;
  if (typeof arch !== 'object' || arch === null) return true; // field absent — don't exclude
  const input = Array.isArray(arch.input_modalities) ? arch.input_modalities : null;
  const output = Array.isArray(arch.output_modalities) ? arch.output_modalities : null;
  if (input && !input.includes('text')) return false;
  if (output && !output.includes('text')) return false;
  return true;
}

/**
 * Resolves the ordered list of free OpenRouter models to try, STRICTLY
 * sequential and capped at OPENROUTER_MAX_MODELS:
 *
 *   1. AI_TEST_MODEL (dev-only pin) → a single-element list.
 *   2. OPENROUTER_FREE_MODELS (explicit comma-separated override) → that list.
 *   3. Dynamic discovery: GET {OPENROUTER_BASE_URL}/models — public, no auth —
 *      keep entries with pricing 0/0 and text in/out, sort by id for a
 *      deterministic order, cache for 5 minutes, then cap at MAX_MODELS.
 *
 * The unified `openrouter/free` router id is deliberately NOT used: it would
 * let OpenRouter pick the model itself (non-deterministic). Discovery failures
 * surface as OpenRouterError — never invented fallback lists, never scraping.
 */
export async function resolveModelChain(): Promise<string[]> {
  const pinned = resolveTestModel();
  if (pinned) return [pinned];

  const fromEnv = resolveEnvModels();
  if (fromEnv.length > 0) return fromEnv.slice(0, resolveOpenRouterMaxModels());

  if (freeModelCache && Date.now() - freeModelCache.fetchedAt < FREE_MODEL_CACHE_TTL_MS) {
    return freeModelCache.ids.slice(0, resolveOpenRouterMaxModels());
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), resolveOpenRouterTimeoutMs());
  try {
    const res = await fetch(`${resolveOpenRouterBaseUrl()}/models`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new OpenRouterError(
        `OpenRouter models list request failed with status ${res.status}.`,
        res.status,
      );
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      throw new OpenRouterError('OpenRouter returned an unexpected models list.', 502);
    }
    const list = (data as { data?: unknown }).data;
    if (!Array.isArray(list)) {
      throw new OpenRouterError('OpenRouter returned an unexpected models list.', 502);
    }

    const ids = list
      .filter((entry) => isFreeModel(entry) && supportsText(entry))
      .map((entry) => String((entry as { id?: unknown }).id ?? '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)); // deterministic order

    if (ids.length === 0) {
      throw new OpenRouterError('No free OpenRouter models are currently available.', 502);
    }

    freeModelCache = { fetchedAt: Date.now(), ids };
    return ids.slice(0, resolveOpenRouterMaxModels());
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OpenRouterError(
        `OpenRouter models list timed out after ${resolveOpenRouterTimeoutMs() / 1000}s.`,
        504,
      );
    }
    throw new OpenRouterError('Could not reach the OpenRouter models list.', 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface CallOpenRouterParams {
  apiKey: string;
  /** Explicit free model id from resolveModelChain() — never `openrouter/free`. */
  model: string;
  /** The exact same prompt string the Gemini path receives (same task). */
  prompt: string;
}

/**
 * Runs the conversation-analysis prompt through ONE OpenRouter model and
 * returns the raw text — the caller feeds it through the SAME parse/validate
 * layer as Gemini before anything is written.
 * Deliberately sends only { model, messages }: no temperature/token params, so
 * any free model stays request-compatible.
 */
export async function callOpenRouter({
  apiKey,
  model,
  prompt,
}: CallOpenRouterParams): Promise<string> {
  const endpoint = `${resolveOpenRouterBaseUrl()}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), resolveOpenRouterTimeoutMs());

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The Authorization header value must never be logged or echoed back.
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    });

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON body from upstream — handled as an unexpected shape below.
    }

    if (!res.ok) {
      // Surface OpenRouter's own message when present, without echoing the key.
      const upstreamMsg =
        typeof data === 'object' && data !== null && 'error' in data
          ? String((data as { error?: { message?: unknown } }).error?.message ?? '')
          : '';
      throw new OpenRouterError(
        upstreamMsg || `OpenRouter API request failed with status ${res.status}.`,
        res.status,
      );
    }

    const content = extractContent(data);
    if (!content) {
      throw new OpenRouterError('OpenRouter returned an unexpected response shape.', 502);
    }

    return content;
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OpenRouterError(
        `OpenRouter request timed out after ${resolveOpenRouterTimeoutMs() / 1000}s.`,
        504,
      );
    }
    throw new OpenRouterError('Could not reach the OpenRouter API.', 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Extracts choices[0].message.content from a chat completions response. */
function extractContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first?.message?.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

