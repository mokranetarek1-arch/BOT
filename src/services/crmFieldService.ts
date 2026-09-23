import { supabase } from '@/utils/supabase';
import type {
  Contact,
  ContactCustomValues,
  CrmCustomField,
  CustomFieldType,
  Message,
} from '@/types';

/**
 * CRM service — the Dynamic Custom CRM (crm_custom_fields / contact_custom_values)
 * plus the AI field extraction that fills it.
 *
 * The AI does NOT produce a separate "insights" layer: it maps conversation
 * evidence onto the CRM fields the organization already defines, and the CRM
 * record is what the user reads.
 *
 * Reads/writes go through the signed-in user's session (RLS scopes everything
 * to their organization). The only network dependency is the standalone AI
 * backend's POST /ai/extract-crm-fields, which returns structured updates and
 * never touches the database for this path.
 *
 * The extraction schema, the coercion rules and the accept/reject rules mirror
 * ai-backend/src/extractCrmFields.ts — keep both files in sync.
 */

// ---------------------------------------------------------------------------
// CRM schema — built-in contact columns + organization-defined custom fields
// ---------------------------------------------------------------------------

/** 'contact' = built-in public.contacts column, 'custom' = contact_custom_values key. */
export type CrmFieldTarget = 'contact' | 'custom';

/** One CRM field handed to the extractor. */
export interface CrmFieldDefinition {
  field_name: string;
  field_label: string;
  field_type: CustomFieldType;
  target: CrmFieldTarget;
  description_for_ai: string | null;
  options: string[] | null;
}

/**
 * Built-in CRM fields that already exist as public.contacts columns
 * (no schema change). They are only ever written while empty/placeholder.
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
 * The extraction schema: built-in fields plus the organization's custom
 * fields. A custom field whose name equals a built-in one wins (the user
 * defined it explicitly), so no field name appears twice.
 */
export function buildCrmSchema(customFields: readonly CrmCustomField[]): CrmFieldDefinition[] {
  const custom: CrmFieldDefinition[] = customFields.map((field) => ({
    field_name: field.field_name,
    field_label: field.field_label,
    field_type: field.field_type,
    target: 'custom',
    description_for_ai: field.description_for_ai,
    options: field.options,
  }));
  const customNames = new Set(custom.map((field) => field.field_name));
  return [...CONTACT_CRM_FIELDS.filter((field) => !customNames.has(field.field_name)), ...custom];
}

/** Payload for creating/updating a custom field (mirrors the DB CHECK). */
export interface CustomFieldInput {
  field_name: string;
  field_label: string;
  field_type: CustomFieldType;
  description_for_ai?: string | null;
  options?: string[] | null;
}

/** Client-side validation mirroring the crm_custom_fields DB CHECKs. */
const FIELD_NAME_RE = /^[a-z0-9_]+$/;
const ALLOWED_FIELD_TYPES = new Set<CustomFieldType>([
  'text',
  'number',
  'select',
  'phone',
  'date',
]);

function normalizeFieldInput(input: CustomFieldInput): {
  field_name: string;
  field_label: string;
  field_type: CustomFieldType;
  options: string[] | null;
  description_for_ai: string | null;
} {
  const field_name = input.field_name.trim().toLowerCase();
  const field_label = input.field_label.trim();
  const field_type = input.field_type;

  if (!field_name || !FIELD_NAME_RE.test(field_name)) {
    throw new Error('Field name must be lowercase letters, digits and underscores only.');
  }
  if (!field_label) throw new Error('Field label is required.');
  if (!ALLOWED_FIELD_TYPES.has(field_type)) throw new Error('Invalid field type.');

  let options: string[] | null = null;
  if (field_type === 'select') {
    const parsed = (input.options ?? [])
      .map((opt) => opt.trim())
      .filter((opt) => opt.length > 0);
    if (parsed.length === 0) {
      throw new Error('Select fields need at least one option (comma separated).');
    }
    options = parsed;
  }

  const description = input.description_for_ai?.trim() || null;
  return { field_name, field_label, field_type, options, description_for_ai: description };
}

// ---------------------------------------------------------------------------
// AI extraction contract
// ---------------------------------------------------------------------------

/** One extracted CRM value, exactly as the AI backend returns it. */
export interface CrmFieldUpdate {
  /** field_name of an existing CRM field. */
  field: string;
  value: string | number;
  /** 0..1 — updates below MIN_CONFIDENCE are never accepted. */
  confidence: number;
  /** Message id the value was read from (evidence anchor). */
  evidence_message_id: string;
}

/** Outcome of one manual extraction run. */
export interface ExtractCrmFieldsResult {
  /** Updates accepted by the AI backend and re-validated here. */
  updates: CrmFieldUpdate[];
  /** Custom CRM keys written to contact_custom_values. */
  appliedCustomFields: string[];
  /** Built-in contact columns filled on public.contacts. */
  appliedContactFields: string[];
  /** Accepted updates kept out to protect a stored/confirmed value. */
  skipped: string[];
  /** The contact's custom values after the write. */
  values: ContactCustomValues;
}

/** Mirrors MIN_CONFIDENCE / REPLACE_MIN_CONFIDENCE in the AI backend. */
const MIN_CONFIDENCE = 0.55;
const REPLACE_MIN_CONFIDENCE = 0.85;
/** Only the most recent messages are sent (mirrors the pipeline transcript). */
const MAX_MESSAGES = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_MARKERS = new Set(['null', 'unknown', 'n/a', 'na', 'none', '-', '—']);
const PLACEHOLDER_NAME_RE = /^(instagram|facebook) user /i;

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

/** Parses a raw number value; null unless it is an explicit number. */
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

/** Coerces one value to the declared field type (null = unusable). */
function coerceValue(field: CrmFieldDefinition, raw: unknown): string | number | null {
  if (raw === undefined || raw === null || typeof raw === 'object') return null;

  if (field.field_type === 'number') return parseNumber(raw);

  const s = String(raw).trim();
  if (!s || EMPTY_MARKERS.has(s.toLowerCase())) return null;

  if (field.field_type === 'select') {
    const lower = s.toLowerCase();
    return (field.options ?? []).find((option) => option.toLowerCase() === lower) ?? null;
  }
  if (field.field_type === 'date') return DATE_RE.test(s) ? s : null;
  return s;
}

function readConfidence(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * Re-validates the backend's updates before anything is written: only fields
 * that exist in the CRM schema, values that fit the declared type, an explicit
 * confidence above the floor and an evidence message id that belongs to the
 * conversation that was sent. Everything else is dropped — the field simply
 * stays unchanged.
 */
export function normalizeUpdates(
  raw: unknown,
  fields: CrmFieldDefinition[],
  messageIds: readonly string[],
): CrmFieldUpdate[] {
  if (!Array.isArray(raw)) return [];

  const fieldsByName = new Map(fields.map((field) => [field.field_name, field]));
  const knownIds = new Set(messageIds);
  const accepted = new Map<string, CrmFieldUpdate>();

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;

    const fieldName = typeof o.field === 'string' ? o.field.trim().toLowerCase() : '';
    const field = fieldsByName.get(fieldName);
    if (!field) continue;

    const value = coerceValue(field, o.value);
    if (value === null) continue;

    const confidence = readConfidence(o.confidence);
    if (confidence === null || confidence < MIN_CONFIDENCE) continue;

    const evidenceMessageId =
      typeof o.evidence_message_id === 'string' ? o.evidence_message_id.trim() : '';
    if (!evidenceMessageId || !knownIds.has(evidenceMessageId)) continue;

    const update: CrmFieldUpdate = {
      field: fieldName,
      value,
      confidence,
      evidence_message_id: evidenceMessageId,
    };
    const previous = accepted.get(fieldName);
    if (!previous || update.confidence > previous.confidence) accepted.set(fieldName, update);
  }

  return [...accepted.values()];
}

function sameValue(a: string | number | null | undefined, b: string | number): boolean {
  if (a === null || a === undefined) return false;
  const left = typeof a === 'number' ? a : a.trim();
  const right = typeof b === 'number' ? b : b.trim();
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  return String(left).toLowerCase() === String(right).toLowerCase();
}

/**
 * Custom CRM field integrity rule: an empty field is filled, a stored value is
 * only replaced by a clearly stated (evidence-backed, high-confidence) value —
 * never downgraded, never blanked.
 */
function shouldReplaceStoredValue(
  current: string | number | null | undefined,
  update: CrmFieldUpdate,
): boolean {
  const isEmpty = current === null || current === undefined || String(current).trim() === '';
  if (isEmpty) return true;
  if (sameValue(current, update.value)) return false;
  return update.confidence >= REPLACE_MIN_CONFIDENCE;
}

/**
 * Built-in contact column integrity rule: it holds confirmed data, so an
 * extraction only fills it while it is empty or still a placeholder.
 */
function shouldFillContactField(
  current: string | null | undefined,
  update: CrmFieldUpdate,
): boolean {
  const trimmed = typeof current === 'string' ? current.trim() : '';
  const isEmptyOrPlaceholder =
    !trimmed || trimmed.toLowerCase() === 'unknown' || PLACEHOLDER_NAME_RE.test(trimmed);
  if (!isEmptyOrPlaceholder) return false;
  return !sameValue(trimmed, update.value);
}

/** The stored values jsonb as a plain object (never trusted blindly). */
function asValuesObject(raw: unknown): ContactCustomValues {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as ContactCustomValues)
    : {};
}

// ---------------------------------------------------------------------------
// Database access (RLS-scoped to the signed-in user's organization)
// ---------------------------------------------------------------------------

/**
 * Explicit column list for crm_custom_fields — never `select('*')`.
 * `updated_at` is deliberately NOT selected: the UI never uses it and some
 * databases were created with a reduced schema that has no such column.
 */
const CUSTOM_FIELD_COLUMNS =
  'id, organization_id, field_name, field_label, field_type, options, description_for_ai, created_at';

/** Insert-or-update the single custom values row of a contact (UNIQUE contact_id). */
async function upsertContactCustomValues(
  organizationId: string,
  contactId: string,
  values: ContactCustomValues,
): Promise<void> {
  const { error } = await supabase.from('contact_custom_values').upsert(
    { contact_id: contactId, organization_id: organizationId, values },
    { onConflict: 'contact_id' },
  );
  if (error) throw new Error(error.message);
}

/** The custom values object of one contact (empty object when none exist yet). */
async function fetchContactCustomValues(contactId: string): Promise<ContactCustomValues> {
  const { data, error } = await supabase
    .from('contact_custom_values')
    .select('contact_id, values')
    .eq('contact_id', contactId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return asValuesObject((data as { values?: unknown } | null)?.values);
}

/**
 * Public base URL of the AI backend (Render/Railway). It is NOT a secret, so a
 * built-in fallback keeps the manual extraction working even when the frontend
 * was built without the VITE_AI_BACKEND_URL environment variable. An explicitly
 * configured env var always wins over this fallback.
 */
const AI_BACKEND_FALLBACK_URL = 'https://botd-ai-backend.onrender.com';

/**
 * The AI backend allows Gemini 60s per request, so the browser must wait
 * longer than that — a manual extraction that is cut off early would look like
 * a failure even though the backend is still working.
 */
const EXTRACTION_TIMEOUT_MS = 70_000;

/** Response of POST /ai/extract-crm-fields (validated before use). */
interface ExtractCrmFieldsResponse {
  success?: boolean;
  model?: string;
  prompt_version?: string;
  crm_fields_used?: number;
  updates?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const crmFieldService = {
  // -------------------------------------------------------------------------
  // CRM schema — the organization's custom fields (Custom Fields Builder)
  // -------------------------------------------------------------------------

  /** All custom CRM columns of the organization, oldest first (stable order). */
  async listCustomFields(organizationId: string): Promise<CrmCustomField[]> {
    const { data, error } = await supabase
      .from('crm_custom_fields')
      .select(CUSTOM_FIELD_COLUMNS)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as CrmCustomField[];
  },

  /** Create one custom CRM column for the organization. */
  async createCustomField(
    organizationId: string,
    input: CustomFieldInput,
  ): Promise<CrmCustomField> {
    const normalized = normalizeFieldInput(input);
    const { data, error } = await supabase
      .from('crm_custom_fields')
      .insert({ organization_id: organizationId, ...normalized })
      .select(CUSTOM_FIELD_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    return data as unknown as CrmCustomField;
  },

  /** Update an existing custom CRM column (label / type / options / hint). */
  async updateCustomField(fieldId: string, input: CustomFieldInput): Promise<void> {
    const normalized = normalizeFieldInput(input);
    const { error } = await supabase
      .from('crm_custom_fields')
      .update(normalized)
      .eq('id', fieldId);
    if (error) throw new Error(error.message);
  },

  /** Delete a custom CRM column. Stored values keep their JSON keys but the
      column simply disappears from the CRM. */
  async deleteCustomField(fieldId: string): Promise<void> {
    const { error } = await supabase.from('crm_custom_fields').delete().eq('id', fieldId);
    if (error) throw new Error(error.message);
  },

  // -------------------------------------------------------------------------
  // Stored CRM values (contact_custom_values)
  // -------------------------------------------------------------------------

  /** The custom values object of one contact, or null when none exist yet. */
  async getContactCustomValues(contactId: string): Promise<ContactCustomValues | null> {
    const { data, error } = await supabase
      .from('contact_custom_values')
      .select('contact_id, values')
      .eq('contact_id', contactId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return null;
    const values = (data as { values?: unknown }).values;
    return typeof values === 'object' && values !== null && !Array.isArray(values)
      ? (values as ContactCustomValues)
      : null;
  },

  /**
   * Custom values for every contact of the organization, keyed by contact_id —
   * the shape the dynamic CRM table needs (one fetch for all rows).
   */
  async listContactCustomValues(
    organizationId: string,
  ): Promise<Record<string, ContactCustomValues>> {
    const { data, error } = await supabase
      .from('contact_custom_values')
      .select('contact_id, values')
      .eq('organization_id', organizationId);

    if (error) throw new Error(error.message);
    const map: Record<string, ContactCustomValues> = {};
    for (const row of (data ?? []) as Array<{ contact_id: string; values: unknown }>) {
      if (typeof row.values === 'object' && row.values !== null && !Array.isArray(row.values)) {
        map[row.contact_id] = row.values as ContactCustomValues;
      }
    }
    return map;
  },

  // -------------------------------------------------------------------------
  // AI CRM extraction (POST /ai/extract-crm-fields)
  // -------------------------------------------------------------------------

  /**
   * Extract CRM values from a contact's recent messages and write them to the
   * CRM record — the manual fallback of the automatic pipeline.
   *
   * The AI receives the CRM schema (built-in fields + the organization's custom
   * fields) and the conversation messages, and returns only evidence-backed
   * updates. This method re-validates them, then:
   *   - merges organization-defined values into contact_custom_values (a stored
   *     value is only replaced by a strong, explicitly stated one);
   *   - fills built-in contact columns (name/phone/city/wilaya) only while they
   *     are empty or still an ingestion placeholder.
   * Nothing is written for a field the conversation does not provide.
   */
  async extractContactCrmFields(params: {
    contact: Contact;
    customFields: readonly CrmCustomField[];
    messages: readonly Message[];
    /** Stored values, when the caller already loaded them (avoids a re-read). */
    existingValues?: ContactCustomValues | null;
  }): Promise<ExtractCrmFieldsResult> {
    const { contact, customFields, messages, existingValues } = params;

    const fields = buildCrmSchema(customFields);
    const usable = messages
      .filter((message) => typeof message.message_text === 'string' && message.message_text.trim())
      .slice(-MAX_MESSAGES);
    if (usable.length === 0) {
      throw new Error('No messages to extract from yet.');
    }

    const payloadMessages = usable.map((message) => ({
      id: message.id,
      direction: message.direction === 'outbound' ? 'outbound' : 'inbound',
      text: (message.message_text ?? '').trim(),
    }));
    const messageIds = payloadMessages.map((message) => message.id);

    const baseUrl = import.meta.env.VITE_AI_BACKEND_URL || AI_BACKEND_FALLBACK_URL;

    /** One extraction request; errors are returned, never thrown from a catch. */
    const requestUpdates = async (): Promise<
      { ok: true; updates: unknown } | { ok: false; error: Error }
    > => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

      try {
        const res = await fetch(`${baseUrl}/ai/extract-crm-fields`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            organization_id: contact.organization_id,
            contact_id: contact.id,
            crm_fields: fields.map((field) => ({
              field_name: field.field_name,
              field_label: field.field_label,
              field_type: field.field_type,
              target: field.target,
              description_for_ai: field.description_for_ai,
              options: field.options,
            })),
            messages: payloadMessages,
          }),
          signal: controller.signal,
        });

        const response = (await res.json().catch(() => null)) as ExtractCrmFieldsResponse | null;
        if (!res.ok || !response?.success) {
          return {
            ok: false,
            error: new Error(response?.error ?? `AI extraction failed (HTTP ${res.status}).`),
          };
        }
        return { ok: true, updates: response.updates };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return {
            ok: false,
            error: new Error('AI extraction timed out - the CRM was left unchanged.'),
          };
        }
        return {
          ok: false,
          error: err instanceof Error ? err : new Error('Could not reach the AI backend.'),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const response = await requestUpdates();
    if (!response.ok) throw response.error;

    const updates = normalizeUpdates(response.updates, fields, messageIds);

    // 1. Organization-defined CRM fields → contact_custom_values (merged).
    const stored = existingValues ?? (await fetchContactCustomValues(contact.id));
    const merged: ContactCustomValues = { ...asValuesObject(stored) };
    const appliedCustomFields: string[] = [];
    const skipped: string[] = [];

    for (const update of updates) {
      const field = fields.find((entry) => entry.field_name === update.field);
      if (!field || field.target !== 'custom') continue;

      if (shouldReplaceStoredValue(merged[field.field_name], update)) {
        merged[field.field_name] = update.value;
        appliedCustomFields.push(field.field_name);
      } else {
        skipped.push(`${field.field_label}: kept the stored value`);
      }
    }

    if (appliedCustomFields.length > 0) {
      await upsertContactCustomValues(contact.organization_id, contact.id, merged);
    }

    // 2. Built-in contact columns — filled only while empty/placeholder.
    const contactPatch: Record<string, string> = {};
    for (const update of updates) {
      const field = fields.find((entry) => entry.field_name === update.field);
      if (!field || field.target !== 'contact') continue;

      const current = (contact as unknown as Record<string, unknown>)[field.field_name];
      if (shouldFillContactField(typeof current === 'string' ? current : null, update)) {
        contactPatch[field.field_name] = String(update.value);
      } else {
        skipped.push(`${field.field_label}: the contact column is already set`);
      }
    }

    const appliedContactFields: string[] = [];
    if (Object.keys(contactPatch).length > 0) {
      const { data, error } = await supabase
        .from('contacts')
        .update(contactPatch)
        .eq('id', contact.id)
        .select('id');
      if (error) throw new Error(error.message);

      if (Array.isArray(data) && data.length > 0) {
        appliedContactFields.push(...Object.keys(contactPatch));
      } else {
        // PostgREST answers with 0 rows when RLS filters the UPDATE — report it
        // instead of pretending the contact record changed.
        skipped.push(
          `${Object.keys(contactPatch).join(', ')}: the contact row was not updated (your role may not allow it)`,
        );
      }
    }

    return { updates, appliedCustomFields, appliedContactFields, skipped, values: merged };
  },
};
