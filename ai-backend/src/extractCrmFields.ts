/**
 * CRM field extraction — prompt construction and strict output validation.
 *
 * The CRM schema belongs to the user: it is the organization's Dynamic Custom
 * CRM fields (public.crm_custom_fields) plus the built-in contact columns BOTD
 * already stores. The model's ONLY job is to map conversation evidence onto
 * those fields — it never invents values, never returns a field that is not in
 * the schema, and every update must point at the message it came from.
 *
 * Mirrored (same schema + same accept/reject rules) by the frontend service
 * src/services/crmFieldService.ts, which performs the manual extraction action.
 * Keep both files in sync when the contract changes.
 */

/** Allowed crm_custom_fields.field_type values (mirrors the DB CHECK). */
export type CrmFieldType = 'text' | 'number' | 'select' | 'phone' | 'date';

/**
 * Where a field lives:
 *  - 'contact': a built-in column of public.contacts (Name / Phone / City / Wilaya)
 *  - 'custom' : a key inside public.contact_custom_values.values
 */
export type CrmFieldTarget = 'contact' | 'custom';

/** One CRM field the organization tracks — the extraction schema entry. */
export interface CrmFieldDefinition {
  field_name: string;
  field_label: string;
  field_type: CrmFieldType;
  target: CrmFieldTarget;
  /** Optional hint telling the extractor what the field means. */
  description_for_ai: string | null;
  /** Choices for 'select' fields; null for every other type. */
  options: string[] | null;
}

/** One conversation message handed to the extractor (id = evidence anchor). */
export interface ConversationMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
}

/** One accepted extraction result. */
export interface CrmFieldUpdate {
  field: string;
  value: string | number;
  /** 0..1 — always explicit; updates below MIN_CONFIDENCE are dropped. */
  confidence: number;
  /** The id of the message the value was read from. */
  evidence_message_id: string;
}

/** Thrown when the caller's CRM schema / messages are invalid (HTTP 400). */
export class CrmSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmSchemaError';
  }
}

/** Thrown when the model output is unusable (HTTP 502). */
export class CrmExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmExtractionError';
  }
}

export const MAX_CRM_FIELDS = 30;
export const MAX_MESSAGES = 30;
export const MAX_MESSAGE_TEXT_LENGTH = 2000;
export const MAX_FIELD_LABEL_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MAX_OPTION_LENGTH = 100;

/**
 * An update must reach this confidence to be accepted at all. Below it the
 * model is expected to omit the field — an uncertain guess is never written.
 */
export const MIN_CONFIDENCE = 0.55;

/**
 * An ALREADY stored value is only replaced when the new one is explicitly
 * backed by a message and reaches this confidence. Otherwise the known value
 * stays (see shouldReplaceStoredValue in pipeline.ts).
 */
export const REPLACE_MIN_CONFIDENCE = 0.85;

const FIELD_NAME_RE = /^[a-z0-9_]+$/;
const ALLOWED_FIELD_TYPES = new Set<string>(['text', 'number', 'select', 'phone', 'date']);
const ALLOWED_TARGETS = new Set<string>(['contact', 'custom']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_MARKERS = new Set(['null', 'unknown', 'n/a', 'na', 'none', '-', '—']);

/**
 * Built-in contact columns the extractor may fill. They already exist in
 * public.contacts (no schema change) and are only ever written when empty —
 * confirmed data is never overwritten by an inference.
 */
export const CONTACT_CRM_FIELDS: readonly CrmFieldDefinition[] = [
  {
    field_name: 'name',
    field_label: 'Name',
    field_type: 'text',
    target: 'contact',
    description_for_ai: "The customer's own name, only when the customer states it.",
    options: null,
  },
  {
    field_name: 'phone',
    field_label: 'Phone',
    field_type: 'phone',
    target: 'contact',
    description_for_ai: 'A phone or WhatsApp number the customer shares.',
    options: null,
  },
  {
    field_name: 'wilaya',
    field_label: 'Wilaya',
    field_type: 'text',
    target: 'contact',
    description_for_ai: 'The Algerian wilaya (province) the customer says they are from.',
    options: null,
  },
  {
    field_name: 'city',
    field_label: 'City',
    field_type: 'text',
    target: 'contact',
    description_for_ai: 'The city or town the customer says they are from.',
    options: null,
  },
];

/**
 * Merges the built-in contact fields with the organization's custom fields.
 * A custom field whose field_name equals a built-in one wins (the user defined
 * it explicitly) so the schema never contains the same field name twice.
 */
export function buildCrmSchema(
  customFields: readonly CrmFieldDefinition[] = [],
): CrmFieldDefinition[] {
  const custom = customFields.filter((field) => field.target === 'custom');
  const customNames = new Set(custom.map((field) => field.field_name));
  const builtIns = CONTACT_CRM_FIELDS.filter((field) => !customNames.has(field.field_name));
  return [...builtIns, ...custom];
}

/**
 * Validates and normalizes the caller-supplied CRM schema.
 * Returns [] when absent/empty. Throws CrmSchemaError on any invalid entry so
 * the route can answer 400 before calling Gemini.
 */
export function sanitizeCrmFields(raw: unknown): CrmFieldDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CrmSchemaError('crm_fields must be an array of field objects.');
  }
  if (raw.length === 0) return [];
  if (raw.length > MAX_CRM_FIELDS) {
    throw new CrmSchemaError(`crm_fields exceeds the maximum of ${MAX_CRM_FIELDS} fields.`);
  }

  const fields: CrmFieldDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CrmSchemaError('Each crm_fields entry must be an object.');
    }
    const o = entry as Record<string, unknown>;
    const fieldName = typeof o.field_name === 'string' ? o.field_name.trim().toLowerCase() : '';
    const fieldLabel = typeof o.field_label === 'string' ? o.field_label.trim() : '';
    const fieldType = typeof o.field_type === 'string' ? o.field_type.trim() : '';
    const target = typeof o.target === 'string' ? o.target.trim() : 'custom';

    if (!fieldName || !FIELD_NAME_RE.test(fieldName) || fieldName.length > 60) {
      throw new CrmSchemaError(
        `Invalid field_name "${fieldName || '(empty)'}" — use lowercase letters, digits and underscores only.`,
      );
    }
    if (!fieldLabel || fieldLabel.length > MAX_FIELD_LABEL_LENGTH) {
      throw new CrmSchemaError(`Invalid field_label for "${fieldName}".`);
    }
    if (!ALLOWED_FIELD_TYPES.has(fieldType)) {
      throw new CrmSchemaError(
        `Invalid field_type "${fieldType}" for "${fieldName}" (allowed: text, number, select, phone, date).`,
      );
    }
    if (!ALLOWED_TARGETS.has(target)) {
      throw new CrmSchemaError(
        `Invalid target "${target}" for "${fieldName}" (allowed: contact, custom).`,
      );
    }
    if (seen.has(fieldName)) {
      throw new CrmSchemaError(`Duplicate field_name "${fieldName}".`);
    }

    let description: string | null = null;
    if (typeof o.description_for_ai === 'string' && o.description_for_ai.trim()) {
      const d = o.description_for_ai.trim();
      if (d.length > MAX_DESCRIPTION_LENGTH) {
        throw new CrmSchemaError(
          `description_for_ai for "${fieldName}" exceeds ${MAX_DESCRIPTION_LENGTH} characters.`,
        );
      }
      description = d;
    }

    let options: string[] | null = null;
    if (fieldType === 'select') {
      if (!Array.isArray(o.options) || o.options.length === 0) {
        throw new CrmSchemaError(`select field "${fieldName}" requires a non-empty options array.`);
      }
      options = o.options
        .map((opt) => String(opt).trim())
        .filter((opt) => opt.length > 0 && opt.length <= MAX_OPTION_LENGTH);
      if (options.length === 0) {
        throw new CrmSchemaError(`select field "${fieldName}" has no valid options.`);
      }
    } else if (Array.isArray(o.options) && o.options.length > 0) {
      // Tolerate clients that send options for non-select fields.
      options = o.options.map((opt) => String(opt).trim()).filter(Boolean);
    }

    seen.add(fieldName);
    fields.push({
      field_name: fieldName,
      field_label: fieldLabel,
      field_type: fieldType as CrmFieldType,
      target: target as CrmFieldTarget,
      description_for_ai: description,
      options,
    });
  }
  return fields;
}

/**
 * Validates the conversation messages sent by the caller. Message ids are the
 * evidence anchors of the contract, so an empty or id-less list is rejected.
 */
export function sanitizeMessages(raw: unknown): ConversationMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CrmSchemaError('messages must be a non-empty array of { id, direction, text }.');
  }

  const messages: ConversationMessage[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CrmSchemaError('Each messages entry must be an object.');
    }
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!id) throw new CrmSchemaError('Every message needs a non-empty id.');
    if (seen.has(id)) throw new CrmSchemaError(`Duplicate message id "${id}".`);
    if (!text) continue;

    seen.add(id);
    messages.push({
      id,
      direction: o.direction === 'outbound' ? 'outbound' : 'inbound',
      text: text.slice(0, MAX_MESSAGE_TEXT_LENGTH),
    });
  }

  if (messages.length === 0) {
    throw new CrmSchemaError('messages contains no usable text.');
  }
  return messages;
}

const PROMPT_VERSION = 'crm-field-extractor-v1';

export function getPromptVersion(): string {
  return PROMPT_VERSION;
}

const SYSTEM_RULES = `You are BOTD's CRM data extractor. A business sells through Instagram/Facebook DMs and defines its own CRM fields. Your only job: read the customer conversation and report the values these messages EXPLICITLY provide for the CRM fields listed below.

Return ONE JSON object with EXACTLY this shape:
{
  "updates": [
    { "field": "<field_name>", "value": <value>, "confidence": <0..1>, "evidence_message_id": "<id of the message>" }
  ]
}

Absolute rules:
- Use ONLY the field names listed below. Never invent a field.
- Report a field ONLY when the conversation contains its value. If a value is absent, omit the field completely — do not guess, do not use defaults, do not write "unknown".
- "value" must be what the customer actually stated (their wording, or the converted value when the field type requires it). Never replace it with your own interpretation.
- "evidence_message_id" MUST be the id of the message that contains the value (copy it exactly). An update without a real evidence id is rejected.
- "confidence" is a number between 0 and 1 for how certain you are. Use it honestly: below 0.55 the update is discarded, so omit uncertain fields instead.
- Never use the agent's messages as a source of customer data.
- Respond with ONLY the JSON object: no markdown, no code fences, no explanations.`;

/** Renders the CRM schema block of the prompt (one line per field). */
function buildSchemaSection(fields: CrmFieldDefinition[]): string {
  const lines = fields.map((field) => {
    const rules: string[] = [`type: ${field.field_type}`];
    if (field.field_type === 'select' && field.options) {
      rules.push(`allowed values: ${field.options.map((opt) => `"${opt}"`).join(' | ')}`);
    }
    if (field.description_for_ai) rules.push(`meaning: ${field.description_for_ai}`);
    return `- "${field.field_name}" (label: ${field.field_label}) — ${rules.join('; ')}`;
  });

  return `
CRM FIELDS (the only field names you may report):
${lines.join('\n')}

Value rules per type:
- "number": a JSON number (convert "350 million" to 350000000; the field meaning states the unit).
- "date": a string in "YYYY-MM-DD" format.
- "select": EXACTLY one of the allowed values listed for that field — never a different word.
- "phone" / "text": a plain string.`;
}

/** Renders the conversation with the message ids the model must reference. */
function buildConversationSection(messages: ConversationMessage[]): string {
  const lines = messages.map(
    (message) =>
      `id=${message.id} | ${message.direction === 'outbound' ? 'Agent' : 'Customer'}: ${message.text}`,
  );
  return `
CONVERSATION (oldest first):
${lines.join('\n')}`;
}

/** Builds the full prompt for one CRM extraction request. */
export function buildExtractionPrompt(
  fields: CrmFieldDefinition[],
  messages: ConversationMessage[],
): string {
  return `${SYSTEM_RULES}
${buildSchemaSection(fields)}
${buildConversationSection(messages)}`;
}

/** Gemini generationConfig for deterministic, JSON-only extraction. */
export const EXTRACTION_GENERATION_CONFIG = {
  responseMimeType: 'application/json',
  temperature: 0.1,
  maxOutputTokens: 1024,
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
    throw new CrmExtractionError('The AI returned a non-JSON response.');
  }
}

/** Multipliers accepted when the model echoes a magnitude word ("350 million"). */
const NUMBER_MAGNITUDES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  milliard: 1e9,
  mrd: 1e9,
};
const NUMBER_WITH_MAGNITUDE_RE =
  /^(-?\d+(?:[.,]\d+)?)\s*(thousand|million|milliard|billion|mn|bn|mrd|k|m|b)s?$/i;

/**
 * Parses a raw number value. Returns null unless the value is an explicit
 * number — the model may echo the message's wording ("350 million") even
 * though the prompt asks for a JSON number, so magnitude words are expanded
 * deterministically instead of dropping the update.
 */
function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  if (!s) return null;
  const plain = Number(s.replace(/\s+/g, ''));
  if (Number.isFinite(plain)) return plain;
  const match = NUMBER_WITH_MAGNITUDE_RE.exec(s);
  if (!match) return null;
  const base = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(base)) return null;
  const factor = NUMBER_MAGNITUDES[match[2].toLowerCase()];
  if (factor === undefined) return null;
  return base * factor;
}

/** Coerces one raw value to the declared field type (null = unusable). */
function coerceValue(field: CrmFieldDefinition, raw: unknown): string | number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') return null;

  if (field.field_type === 'number') return parseNumber(raw);

  const s = String(raw).trim();
  if (!s || EMPTY_MARKERS.has(s.toLowerCase())) return null;

  if (field.field_type === 'select') {
    const lower = s.toLowerCase();
    const match = (field.options ?? []).find((option) => option.toLowerCase() === lower);
    return match ?? null; // never invent an option that is not in the schema
  }
  if (field.field_type === 'date') {
    return DATE_RE.test(s) ? s : null;
  }
  // text | phone — a plain string, never a placeholder word.
  return s;
}

/** Reads a confidence value; null when missing or not a finite number. */
function readConfidence(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * Validates the parsed model output against the schema and the conversation.
 * Rejected updates are dropped silently on purpose: a field that cannot be
 * accepted simply stays unchanged in the CRM.
 *
 * Drop conditions: unknown field name, unusable/empty value, value that does
 * not fit the declared type (bad date, select option outside the list, …),
 * missing or too-low confidence, and an evidence_message_id that does not match
 * one of the supplied messages (no evidence → no write).
 */
export function normalizeCrmFieldUpdates(
  raw: unknown,
  fields: CrmFieldDefinition[],
  messages: ConversationMessage[],
): CrmFieldUpdate[] {
  const container = Array.isArray(raw)
    ? { updates: raw }
    : typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : null;
  if (!container) {
    throw new CrmExtractionError('The AI returned an unexpected response shape.');
  }

  const rawUpdates = container.updates;
  if (rawUpdates === undefined || rawUpdates === null) return [];
  if (!Array.isArray(rawUpdates)) {
    throw new CrmExtractionError('"updates" must be an array.');
  }

  const fieldsByName = new Map(fields.map((field) => [field.field_name, field]));
  const knownMessageIds = new Set(messages.map((message) => message.id));

  const accepted = new Map<string, CrmFieldUpdate>();
  for (const entry of rawUpdates) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;

    const fieldName = typeof o.field === 'string' ? o.field.trim().toLowerCase() : '';
    const field = fieldsByName.get(fieldName);
    if (!field) continue; // never write a field that is not in the CRM schema

    const value = coerceValue(field, o.value);
    if (value === null) continue;

    const confidence = readConfidence(o.confidence);
    if (confidence === null || confidence < MIN_CONFIDENCE) continue;

    const evidenceId = typeof o.evidence_message_id === 'string' ? o.evidence_message_id.trim() : '';
    if (!evidenceId || !knownMessageIds.has(evidenceId)) continue;

    const update: CrmFieldUpdate = {
      field: fieldName,
      value,
      confidence,
      evidence_message_id: evidenceId,
    };
    const previous = accepted.get(fieldName);
    if (!previous || update.confidence > previous.confidence) accepted.set(fieldName, update);
  }

  return [...accepted.values()];
}

/** Normalized comparison, so "Alger " and "alger" are treated as equal. */
export function sameValue(a: string | number | null | undefined, b: string | number): boolean {
  if (a === null || a === undefined) return false;
  const left = typeof a === 'number' ? a : a.trim();
  const right = typeof b === 'number' ? b : b.trim();
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  return String(left).toLowerCase() === String(right).toLowerCase();
}

/**
 * Value-integrity rule for an ORGANIZATION-DEFINED (custom) CRM field:
 *  - an empty field is filled by any accepted update;
 *  - an already stored value is kept as-is, unless the conversation clearly
 *    restates it (explicit evidence message AND confidence >= REPLACE_MIN_CONFIDENCE),
 *    which is the only supported way to correct a known value.
 */
export function shouldReplaceStoredValue(
  current: string | number | null | undefined,
  update: CrmFieldUpdate,
): boolean {
  const isEmpty = current === null || current === undefined || String(current).trim() === '';
  if (isEmpty) return true;
  if (sameValue(current, update.value)) return false; // already correct → no write
  return update.confidence >= REPLACE_MIN_CONFIDENCE;
}

/** An Instagram/Facebook placeholder name written by the ingestion worker. */
export const PLACEHOLDER_NAME_RE = /^(instagram|facebook) user /i;

/**
 * Value-integrity rule for a BUILT-IN contact column: it holds confirmed data,
 * so an extraction only fills it while it is empty or still a placeholder —
 * a confirmed value is never replaced by an inference.
 */
export function shouldFillContactField(
  current: string | null | undefined,
  update: CrmFieldUpdate,
): boolean {
  const trimmed = typeof current === 'string' ? current.trim() : '';
  const isEmptyOrPlaceholder =
    !trimmed || trimmed.toLowerCase() === 'unknown' || PLACEHOLDER_NAME_RE.test(trimmed);
  if (!isEmptyOrPlaceholder) return false;
  return !sameValue(trimmed, update.value);
}
