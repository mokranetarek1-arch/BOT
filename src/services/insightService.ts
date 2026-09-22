import { supabase } from '@/utils/supabase';
import type {
  ContactCustomValues,
  ContactInsight,
  CrmCustomField,
  CustomFieldType,
  InsightType,
} from '@/types';

/**
 * Access to AI inferences (public.contact_ai_insights) and to the Dynamic
 * Custom CRM Engine tables (public.crm_custom_fields / contact_custom_values).
 *
 * Reads are scoped by RLS to the signed-in user's organization — a company can
 * only ever see its own data. No mock data, no service role, explicit column
 * lists only.
 *
 * Writes happen through analyzeContactLead() (AI backend → insights rows →
 * contact_custom_values) and through the Custom Fields Builder (crm_custom_fields).
 * Row shapes respect the DB CHECK constraints:
 *   - contact_ai_insights.insight_type: intent | interests | summary
 *   - crm_custom_fields.field_type: text | number | select | phone | date
 *   - select fields require a non-empty options array; others require NULL.
 */

/** Explicit column list — never `select('*')`. */
const INSIGHT_FIELDS =
  'id, organization_id, contact_id, conversation_id, insight_type, value, confidence, model, prompt_version, source_message_ids, created_at, updated_at';

/** Must match the value returned by the AI backend's prompt_version. */
const DEFAULT_PROMPT_VERSION = 'lead-analyzer-v1';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/** Structured lead analysis returned by POST /ai/analyze-lead. */
export interface LeadAnalysisData {
  client_name: string | null;
  phone_number: string | null;
  intent: string | null;
  product_or_service: string | null;
  lead_score: number | null;
  summary: string | null;
  suggested_reply: string | null;
  /** Extracted values for the organization's custom fields (null = none). */
  custom_values: ContactCustomValues | null;
}

/** Payload shape for one custom field sent to the AI backend. */
export interface CustomSchemaFieldInput {
  field_name: string;
  field_label: string;
  field_type: CustomFieldType;
  description_for_ai?: string | null;
  options?: string[] | null;
}

/** Payload for creating/updating a custom field (mirrors the DB CHECK). */
export interface CustomFieldInput {
  field_name: string;
  field_label: string;
  field_type: CustomFieldType;
  description_for_ai?: string | null;
  options?: string[] | null;
}

interface AnalyzeLeadResponse {
  success?: boolean;
  model?: string;
  prompt_version?: string;
  data?: Partial<LeadAnalysisData>;
  error?: string;
}

/**
 * Insert-or-update one contact-level insight row (conversation_id = NULL).
 *
 * The unique constraint cannot dedupe NULL conversation_ids (Postgres treats
 * NULLs as distinct), so a plain .upsert() would duplicate rows on every
 * analysis. Find-then-update-or-insert is the reliable pattern here.
 */
async function upsertInsightRow(params: {
  organizationId: string;
  contactId: string;
  insightType: InsightType;
  value: Record<string, unknown>;
  model: string;
  promptVersion: string;
}): Promise<void> {
  const { organizationId, contactId, insightType, value, model, promptVersion } = params;

  const { data: existing, error: selectError } = await supabase
    .from('contact_ai_insights')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('contact_id', contactId)
    .eq('insight_type', insightType)
    .eq('prompt_version', promptVersion)
    .is('conversation_id', null)
    .limit(1)
    .maybeSingle();
  if (selectError) throw new Error(selectError.message);

  if (existing?.id) {
    const { error } = await supabase
      .from('contact_ai_insights')
      .update({ value, model })
      .eq('id', existing.id);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from('contact_ai_insights').insert({
    organization_id: organizationId,
    contact_id: contactId,
    conversation_id: null,
    insight_type: insightType,
    value,
    model,
    prompt_version: promptVersion,
    source_message_ids: [],
  });
  if (error) throw new Error(error.message);
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

function normalizeFieldInput(
  input: CustomFieldInput,
): {
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

/** Insert-or-update the single custom values row of a contact (UNIQUE contact_id). */
async function upsertContactCustomValues(
  organizationId: string,
  contactId: string,
  values: ContactCustomValues,
): Promise<void> {
  const { error } = await supabase.from('contact_custom_values').upsert(
    {
      contact_id: contactId,
      organization_id: organizationId,
      values,
    },
    { onConflict: 'contact_id' },
  );
  if (error) throw new Error(error.message);
}

/** Defensive parse of the model-returned custom_values object. */
function parseCustomValues(raw: unknown): ContactCustomValues | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: ContactCustomValues = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.trim()) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    } else {
      out[key] = null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Public base URL of the AI backend (Render). It is NOT a secret, so a
 * built-in fallback keeps /ai/analyze-lead working even when the frontend was
 * built without the VITE_AI_BACKEND_URL environment variable (e.g. a Vercel
 * build made before the variable was configured). An explicitly configured
 * env var always wins over this fallback.
 */
const AI_BACKEND_FALLBACK_URL = 'https://botd-ai-backend.onrender.com';

export const insightService = {
  /**
   * All insights of one contact, newest first.
   * Returns [] when none exist — the expected state before any analysis runs.
   */
  async listContactInsights(contactId: string): Promise<ContactInsight[]> {
    const { data, error } = await supabase
      .from('contact_ai_insights')
      .select(INSIGHT_FIELDS)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as ContactInsight[];
  },

  /**
   * Analyze one customer message through the AI backend and persist the
   * result as contact-level insights.
   *
   * 1. POST {VITE_AI_BACKEND_URL}/ai/analyze-lead (falls back to the built-in
   *    Render URL when the env var is missing)
   * 2. Validate the structured response
   * 3. Upsert intent / interests / summary rows in contact_ai_insights
   * 4. Persist custom_values into contact_custom_values when present
   *
   * Throws with a user-safe message on any failure — no API keys and no raw
   * backend payloads are ever exposed.
   */
  async analyzeContactLead(params: {
    contactId: string;
    organizationId: string;
    messageText: string;
    /** Dynamic Custom CRM fields the AI should also extract. */
    customSchema?: CustomSchemaFieldInput[];
  }): Promise<LeadAnalysisData> {
    const { contactId, organizationId, messageText, customSchema } = params;

    const baseUrl = import.meta.env.VITE_AI_BACKEND_URL || AI_BACKEND_FALLBACK_URL;

    // 1. Call the AI backend. 30s ceiling so the UI never hangs on Render
    //    cold starts combined with Gemini latency.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    let payload: AnalyzeLeadResponse | null = null;
    try {
      const res = await fetch(`${baseUrl}/ai/analyze-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_text: messageText,
          contact_id: contactId,
          organization_id: organizationId,
          custom_schema: customSchema ?? [],
        }),
        signal: controller.signal,
      });

      payload = (await res.json().catch(() => null)) as AnalyzeLeadResponse | null;

      if (!res.ok || !payload?.success || !payload.data) {
        throw new Error(payload?.error ?? `AI analysis failed (HTTP ${res.status}).`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('AI analysis timed out. Please try again.');
      }
      if (err instanceof Error) throw err;
      throw new Error('Could not reach the AI backend.');
    } finally {
      clearTimeout(timeoutId);
    }

    // 2. Defensive shape validation — the backend is trusted, but not blindly.
    const d = payload.data as Partial<LeadAnalysisData>;
    const analysis: LeadAnalysisData = {
      client_name: typeof d.client_name === 'string' ? d.client_name : null,
      phone_number: typeof d.phone_number === 'string' ? d.phone_number : null,
      intent: typeof d.intent === 'string' ? d.intent : null,
      product_or_service: typeof d.product_or_service === 'string' ? d.product_or_service : null,
      lead_score:
        typeof d.lead_score === 'number' && Number.isFinite(d.lead_score) ? d.lead_score : null,
      summary: typeof d.summary === 'string' ? d.summary : null,
      suggested_reply: typeof d.suggested_reply === 'string' ? d.suggested_reply : null,
      custom_values: parseCustomValues(d.custom_values),
    };

    // 3. Persist — three rows keyed on (org, contact, type, prompt_version).
    const model = typeof payload.model === 'string' ? payload.model : DEFAULT_MODEL;
    const promptVersion =
      typeof payload.prompt_version === 'string' ? payload.prompt_version : DEFAULT_PROMPT_VERSION;

    await upsertInsightRow({
      organizationId,
      contactId,
      insightType: 'intent',
      value: { intent: analysis.intent },
      model,
      promptVersion,
    });

    if (analysis.product_or_service !== null) {
      await upsertInsightRow({
        organizationId,
        contactId,
        insightType: 'interests',
        value: { product_or_service: analysis.product_or_service },
        model,
        promptVersion,
      });
    }

    await upsertInsightRow({
      organizationId,
      contactId,
      insightType: 'summary',
      value: {
        client_name: analysis.client_name,
        phone_number: analysis.phone_number,
        lead_score: analysis.lead_score,
        summary: analysis.summary,
        suggested_reply: analysis.suggested_reply,
      },
      model,
      promptVersion,
    });

    // 4. Dynamic Custom CRM — persist extracted custom values when present.
    if (analysis.custom_values && Object.keys(analysis.custom_values).length > 0) {
      await upsertContactCustomValues(organizationId, contactId, analysis.custom_values);
    }

    return analysis;
  },

  // -------------------------------------------------------------------------
  // Dynamic Custom CRM Engine — crm_custom_fields (column definitions)
  // -------------------------------------------------------------------------

  /** All custom CRM columns of the organization, oldest first (stable order). */
  async listCustomFields(organizationId: string): Promise<CrmCustomField[]> {
    const { data, error } = await supabase
      .from('crm_custom_fields')
      .select(
        'id, organization_id, field_name, field_label, field_type, options, description_for_ai, created_at, updated_at',
      )
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
      .select(
        'id, organization_id, field_name, field_label, field_type, options, description_for_ai, created_at, updated_at',
      )
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
      column simply disappears from the dynamic table. */
  async deleteCustomField(fieldId: string): Promise<void> {
    const { error } = await supabase.from('crm_custom_fields').delete().eq('id', fieldId);
    if (error) throw new Error(error.message);
  },

  // -------------------------------------------------------------------------
  // Dynamic Custom CRM Engine — contact_custom_values (per-contact values)
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
   * the shape the dynamic customers table needs (one fetch for all rows).
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
};
