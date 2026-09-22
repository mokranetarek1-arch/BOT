/**
 * Lead analysis — prompt construction and strict output validation.
 *
 * The backend owns the prompt: callers only send the raw message text, and
 * this module turns it into a structured Gemini request whose response is
 * forced to pure JSON (via responseMimeType) and then validated field by
 * field before it leaves the server. The Gemini API key is never involved
 * here — it lives only in gemini.ts.
 */

/** The exact fields BOTD's CRM pipeline expects from every analysis. */
export interface LeadAnalysis {
  client_name: string | null;
  phone_number: string | null;
  intent: string | null;
  product_or_service: string | null;
  lead_score: number | null;
  summary: string | null;
  suggested_reply: string | null;
}

/** Hard cap on accepted message length — protects latency and token budget. */
export const MAX_MESSAGE_LENGTH = 8_000;

const PROMPT_VERSION = 'lead-analyzer-v1';

export function getPromptVersion(): string {
  return PROMPT_VERSION;
}

const SYSTEM_RULES = `You are BOTD's lead-analysis engine for a social-commerce business that sells through Instagram and Facebook DMs.
Analyze the customer message below and return ONE JSON object with EXACTLY these keys:
{
  "client_name": string or null,
  "phone_number": string or null,
  "intent": string,
  "product_or_service": string or null,
  "lead_score": number,
  "summary": string,
  "suggested_reply": string
}
Field rules:
- "client_name": the customer's name ONLY if explicitly stated in the message, otherwise null.
- "phone_number": a phone/WhatsApp number ONLY if present in the message, otherwise null.
- "intent": exactly one of "purchase", "inquiry", "negotiation", "support", "complaint", "other".
- "product_or_service": the product or service the message is about, otherwise null.
- "lead_score": integer 0-100 estimating how likely this lead is to buy soon (100 = ready to buy).
- "summary": one concise sentence summarizing the customer's message.
- "suggested_reply": a short, professional suggested reply, written in the SAME LANGUAGE as the customer's message.
Output rules:
- Respond with ONLY the JSON object. No markdown, no code fences, no explanations.
- Use null (never "unknown" or "N/A") for missing values.
- "lead_score" must always be an integer between 0 and 100.`;

/** Builds the full user prompt for one lead-analysis request. */
export function buildLeadPrompt(messageText: string): string {
  return `${SYSTEM_RULES}

Customer message:
"""
${messageText}
"""`;
}

/** Gemini generationConfig for fast, deterministic, JSON-only responses. */
export const LEAD_GENERATION_CONFIG = {
  responseMimeType: 'application/json',
  temperature: 0.2,
  maxOutputTokens: 512,
};

/** Defensive parse: Gemini may still wrap JSON in markdown fences. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new GeminiSafeParseError('Gemini returned a non-JSON response.');
  }
}

export class GeminiSafeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiSafeParseError';
  }
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'unknown') {
    return null;
  }
  return trimmed;
}

function asLeadScore(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) n = value;
  else if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    n = Number(value);
  }
  if (n === null) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const ALLOWED_INTENTS = new Set([
  'purchase',
  'inquiry',
  'negotiation',
  'support',
  'complaint',
  'other',
]);

/**
 * Validates and normalizes the parsed model output into a LeadAnalysis.
 * Throws GeminiSafeParseError when the object is unusable (caller maps it
 * to HTTP 502). Every field is coerced defensively — model output is never
 * trusted as-is.
 */
export function normalizeLeadAnalysis(raw: unknown): LeadAnalysis {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GeminiSafeParseError('Gemini returned an unexpected response shape.');
  }
  const o = raw as Record<string, unknown>;

  let intent = asStringOrNull(o.intent);
  if (intent && !ALLOWED_INTENTS.has(intent)) intent = 'other';

  const analysis: LeadAnalysis = {
    client_name: asStringOrNull(o.client_name),
    phone_number: asStringOrNull(o.phone_number),
    intent,
    product_or_service: asStringOrNull(o.product_or_service),
    lead_score: asLeadScore(o.lead_score),
    summary: asStringOrNull(o.summary),
    suggested_reply: asStringOrNull(o.suggested_reply),
  };

  // Require at least one meaningful signal — otherwise the response is junk.
  const hasSignal =
    analysis.intent !== null ||
    analysis.summary !== null ||
    analysis.suggested_reply !== null ||
    analysis.client_name !== null ||
    analysis.product_or_service !== null;
  if (!hasSignal) {
    throw new GeminiSafeParseError('Gemini response did not contain usable lead fields.');
  }

  return analysis;
}
