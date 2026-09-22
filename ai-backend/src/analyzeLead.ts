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
  /** Values for the organization's Dynamic Custom CRM fields (null = none). */
  custom_values: Record<string, string | number | null> | null;
}

/** One custom CRM field definition sent by the caller (Dynamic Custom CRM). */
export interface CustomSchemaField {
  field_name: string;
  field_label: string;
  field_type: 'text' | 'number' | 'select' | 'phone' | 'date';
  description_for_ai: string | null;
  options: string[] | null;
}

/** Thrown when the caller's custom_schema payload is invalid (HTTP 400). */
export class CustomSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomSchemaError';
  }
}

export const MAX_CUSTOM_FIELDS = 20;
const FIELD_NAME_RE = /^[a-z0-9_]+$/;
const MAX_FIELD_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 100;
const ALLOWED_FIELD_TYPES = new Set(['text', 'number', 'select', 'phone', 'date']);

/**
 * Validates and normalizes the caller-supplied custom_schema.
 * Returns null when absent/empty. Throws CustomSchemaError on any invalid
 * entry so the route can answer 400 before calling Gemini.
 */
export function sanitizeCustomSchema(raw: unknown): CustomSchemaField[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new CustomSchemaError('custom_schema must be an array of field objects.');
  }
  if (raw.length === 0) return null;
  if (raw.length > MAX_CUSTOM_FIELDS) {
    throw new CustomSchemaError(`custom_schema exceeds the maximum of ${MAX_CUSTOM_FIELDS} fields.`);
  }

  const fields: CustomSchemaField[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CustomSchemaError('Each custom_schema entry must be an object.');
    }
    const o = entry as Record<string, unknown>;
    const fieldName = typeof o.field_name === 'string' ? o.field_name.trim() : '';
    const fieldLabel = typeof o.field_label === 'string' ? o.field_label.trim() : '';
    const fieldType = typeof o.field_type === 'string' ? o.field_type.trim() : '';

    if (!fieldName || !FIELD_NAME_RE.test(fieldName)) {
      throw new CustomSchemaError(
        `Invalid field_name "${fieldName || '(empty)'}" — use lowercase letters, digits and underscores only.`,
      );
    }
    if (!fieldLabel || fieldLabel.length > MAX_FIELD_LABEL_LENGTH) {
      throw new CustomSchemaError(`Invalid field_label for "${fieldName}".`);
    }
    if (!ALLOWED_FIELD_TYPES.has(fieldType)) {
      throw new CustomSchemaError(
        `Invalid field_type "${fieldType}" for "${fieldName}" (allowed: text, number, select, phone, date).`,
      );
    }
    if (seen.has(fieldName)) {
      throw new CustomSchemaError(`Duplicate field_name "${fieldName}".`);
    }

    let description: string | null = null;
    if (typeof o.description_for_ai === 'string' && o.description_for_ai.trim()) {
      const d = o.description_for_ai.trim();
      if (d.length > MAX_DESCRIPTION_LENGTH) {
        throw new CustomSchemaError(
          `description_for_ai for "${fieldName}" exceeds ${MAX_DESCRIPTION_LENGTH} characters.`,
        );
      }
      description = d;
    }

    let options: string[] | null = null;
    if (fieldType === 'select') {
      if (!Array.isArray(o.options) || o.options.length === 0) {
        throw new CustomSchemaError(`select field "${fieldName}" requires a non-empty options array.`);
      }
      options = o.options
        .map((opt) => String(opt).trim())
        .filter((opt) => opt.length > 0 && opt.length <= MAX_OPTION_LENGTH);
      if (options.length === 0) {
        throw new CustomSchemaError(`select field "${fieldName}" has no valid options.`);
      }
    } else if (Array.isArray(o.options) && o.options.length > 0) {
      // Tolerate clients that send options for non-select fields.
      options = o.options.map((opt) => String(opt).trim()).filter(Boolean);
    }

    seen.add(fieldName);
    fields.push({
      field_name: fieldName,
      field_label: fieldLabel,
      field_type: fieldType as CustomSchemaField['field_type'],
      description_for_ai: description,
      options,
    });
  }
  return fields;
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
  "suggested_reply": string,
  "custom_values": object or null
}
Field rules:
- "client_name": the customer's name ONLY if explicitly stated in the message, otherwise null.
- "phone_number": a phone/WhatsApp number ONLY if present in the message, otherwise null.
- "intent": exactly one of "purchase", "inquiry", "negotiation", "support", "complaint", "other".
- "product_or_service": the product or service the message is about, otherwise null.
- "lead_score": integer 0-100 estimating how likely this lead is to buy soon (100 = ready to buy).
- "summary": one concise sentence summarizing the customer's message.
- "suggested_reply": a short, professional suggested reply, written in the SAME LANGUAGE as the customer's message.
- "custom_values": one entry per custom CRM field listed below, keyed by the exact field name; null when no custom fields are listed.
Output rules:
- Respond with ONLY the JSON object. No markdown, no code fences, no explanations.
- Use null (never "unknown" or "N/A") for missing values.
- "lead_score" must always be an integer between 0 and 100.
- Never invent values that are not present or clearly implied in the message.`;

/** Builds the "custom_values" instruction block for the Dynamic Custom CRM. */
function buildCustomFieldsSection(schema: CustomSchemaField[]): string {
  const lines = schema.map((field) => {
    const rules: string[] = [`type: ${field.field_type}`];
    if (field.field_type === 'select' && field.options) {
      rules.push(`options: ${field.options.map((opt) => `"${opt}"`).join(' | ')}`);
    }
    if (field.description_for_ai) {
      rules.push(`meaning: ${field.description_for_ai}`);
    }
    return `- "${field.field_name}" (label: ${field.field_label}) — ${rules.join('; ')}`;
  });

  return `
ADDITIONAL CUSTOM CRM FIELDS — return them under "custom_values":
The CRM of this organization tracks the following custom fields. "custom_values" MUST contain exactly one entry per field below, keyed by the exact field name:
${lines.join('\n')}
Custom field type rules:
- "number" → a JSON number.
- "date" → a string in "YYYY-MM-DD" format.
- "select" → EXACTLY one of the listed options.
- "phone" / "text" → a plain string.
- Use null for a field when the message does not contain that value.`;
}

/** Builds the full user prompt for one lead-analysis request. */
export function buildLeadPrompt(
  messageText: string,
  customSchema: CustomSchemaField[] | null = null,
): string {
  const customSection =
    customSchema && customSchema.length > 0 ? buildCustomFieldsSection(customSchema) : '';

  return `${SYSTEM_RULES}${customSection}

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
 * trusted as-is. Custom values are kept only for fields declared in the
 * schema and coerced to their declared type.
 */
export function normalizeLeadAnalysis(
  raw: unknown,
  customSchema: CustomSchemaField[] | null = null,
): LeadAnalysis {
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
    custom_values: normalizeCustomValues(o.custom_values, customSchema),
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

/**
 * Keeps only the declared schema fields, coerces each value to its declared
 * type, and collapses an all-null object to null so callers can skip the
 * persistence step entirely.
 */
function normalizeCustomValues(
  raw: unknown,
  schema: CustomSchemaField[] | null,
): Record<string, string | number | null> | null {
  if (!schema || schema.length === 0) return null;
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  const out: Record<string, string | number | null> = {};
  let hasValue = false;
  for (const field of schema) {
    const value = source[field.field_name];
    let normalized: string | number | null = null;

    if (value !== undefined && value !== null) {
      if (field.field_type === 'number') {
        const n = typeof value === 'number' ? value : Number(String(value).trim());
        if (Number.isFinite(n)) {
          normalized = n;
        }
      } else {
        const s = String(value).trim();
        if (s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'unknown') {
          normalized = s;
        }
      }
    }

    out[field.field_name] = normalized;
    if (normalized !== null) hasValue = true;
  }

  return hasValue ? out : null;
}
