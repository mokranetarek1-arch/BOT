/** Central configuration constants for the BOTD AI backend. */
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Outbound Gemini deadline. 60s covers Render/Railway cold starts, queued
 * generations and long JSON outputs — flash models usually answer in <10s.
 * The free Gemini REST API itself may cut slower responses earlier, in which
 * case the caller still surfaces the upstream message (never a raw dump).
 */
export const GEMINI_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// OpenRouter fallback provider — used SEQUENTIALLY, only after Gemini fails
// with a temporary provider problem (429/500/502/503/504/network/timeout) and
// its single retry also failed. The chain then walks FREE OpenRouter models
// one model at a time (first success wins). Keys stay server-side in this
// service's environment.
// ---------------------------------------------------------------------------

/** OpenRouter REST base — overridable via OPENROUTER_BASE_URL. */
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Per-model attempt deadline (env: OPENROUTER_TIMEOUT_MS). Tighter than
 * Gemini's 60s because up to OPENROUTER_MAX_MODELS attempts share the budget.
 */
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 30_000;

/**
 * Upper bound of free models tried per request (env: OPENROUTER_MAX_MODELS),
 * so a long fallback chain can never turn into dozens of upstream calls.
 */
export const DEFAULT_OPENROUTER_MAX_MODELS = 3;

/**
 * First Gemini retry delay after a transient failure. The single retry doubles
 * it (short exponential backoff: 500ms → 1000ms).
 */
export const GEMINI_RETRY_BASE_DELAY_MS = 500;

/**
 * HTTP statuses treated as a TEMPORARY provider problem: worth one Gemini
 * retry and, if it still fails, the sequential OpenRouter fallback. Any other
 * status (400/401/403/404 …) is a configuration/request error and surfaces
 * immediately without fallback.
 */
export const TRANSIENT_AI_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

