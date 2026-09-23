/**
 * Automated background CRM extraction pipeline.
 *
 * Triggered by bright-worker (POST /ai/webhook/message) on every inbound
 * message. Steps:
 *   1. Load the contact, the conversation transcript (with message ids) and the
 *      organization's CRM schema (built-in contact columns + crm_custom_fields).
 *   2. Extract CRM values through Gemini — exactly the same prompt and
 *      validation as POST /ai/extract-crm-fields.
 *   3. Persist the accepted updates:
 *        - public.contact_custom_values → organization-defined CRM fields,
 *          merged; a stored value is only replaced by a strong, evidence-backed
 *          restatement (never weakened, never blanked);
 *        - public.contacts → built-in columns (name/phone/city/wilaya) filled
 *          only while they are empty or still an ingestion placeholder.
 *
 * There is deliberately NO contact_ai_insights write path anymore: the AI fills
 * the CRM fields the organization defined instead of a separate "insights"
 * layer with fixed intent/interests/sentiment types.
 *
 * All DB access uses the service-role client; the API key never leaves gemini.ts.
 */
import { getSupabaseAdmin } from './supabaseAdmin';
import { callGemini } from './gemini';
import { GEMINI_MODEL } from './config';
import {
  buildCrmSchema,
  buildExtractionPrompt,
  EXTRACTION_GENERATION_CONFIG,
  normalizeCrmFieldUpdates,
  parseModelJson,
  shouldFillContactField,
  shouldReplaceStoredValue,
  type ConversationMessage,
  type CrmFieldDefinition,
  type CrmFieldUpdate,
} from './extractCrmFields';

/** How many of the most recent messages are sent to the extractor. */
export const MAX_TRANSCRIPT_MESSAGES = 30;

/** Built-in contact columns the extractor may fill (confirmed-data columns). */
const CONTACT_COLUMNS = ['name', 'phone', 'city', 'wilaya'] as const;

export interface ProcessMessageParams {
  organizationId: string;
  contactId: string;
  conversationId: string;
}

export interface ProcessMessageResult {
  organizationId: string;
  contactId: string;
  conversationId: string;
  transcript_messages: number;
  crm_fields_used: number;
  /** Every update the model produced and the validator accepted. */
  updates: CrmFieldUpdate[];
  /** Custom CRM keys that were actually written (merged into the jsonb). */
  applied_custom_values: string[];
  /** Built-in contact columns that were actually filled. */
  applied_contact_fields: string[];
  /** Accepted updates that were skipped to protect a stored value. */
  skipped_updates: string[];
  contact_updates: string[];
  custom_values_written: number;
}

/**
 * Builds the analyzable transcript from the conversation's recent messages.
 * Each message keeps its database id because the extractor must cite the
 * message an extracted value came from.
 */
async function loadConversationMessages(
  sb: ReturnType<typeof getSupabaseAdmin>,
  conversationId: string,
): Promise<ConversationMessage[]> {
  const { data, error } = await sb
    .from('messages')
    .select('id, message_text, direction, message_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) throw new Error(`Could not load messages: ${error.message}`);

  const recent = (data ?? []).slice(-MAX_TRANSCRIPT_MESSAGES);
  return recent
    .map((row: Record<string, unknown>) => {
      const text =
        typeof row.message_text === 'string' && row.message_text.trim()
          ? row.message_text.trim()
          : `[${String(row.message_type ?? 'message')}]`;
      return {
        id: String(row.id),
        direction: (row.direction === 'outbound' ? 'outbound' : 'inbound') as
          | 'inbound'
          | 'outbound',
        text,
      };
    })
    .filter((message) => message.id && message.text);
}

/** Loads the organization's custom CRM fields as extraction-schema entries. */
async function loadCustomFields(
  sb: ReturnType<typeof getSupabaseAdmin>,
  organizationId: string,
): Promise<CrmFieldDefinition[]> {
  const { data, error } = await sb
    .from('crm_custom_fields')
    .select('field_name, field_label, field_type, options, description_for_ai')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Could not load custom fields: ${error.message}`);

  return (data ?? []).map((row: Record<string, unknown>) => ({
    field_name: String(row.field_name),
    field_label: String(row.field_label),
    field_type: String(row.field_type) as CrmFieldDefinition['field_type'],
    target: 'custom' as const,
    description_for_ai: typeof row.description_for_ai === 'string' ? row.description_for_ai : null,
    options: Array.isArray(row.options) ? row.options.map((opt) => String(opt)) : null,
  }));
}

/** The stored custom values object of a contact (empty object when none). */
async function loadCustomValues(
  sb: ReturnType<typeof getSupabaseAdmin>,
  contactId: string,
): Promise<Record<string, string | number | null>> {
  const { data } = await sb
    .from('contact_custom_values')
    .select('values')
    .eq('contact_id', contactId)
    .maybeSingle();

  const values = data?.values;
  return typeof values === 'object' && values !== null && !Array.isArray(values)
    ? (values as Record<string, string | number | null>)
    : {};
}

/**
 * Merges accepted updates into the contact's custom values and stores them.
 * A stored value is protected by shouldReplaceStoredValue; skipped updates are
 * reported instead of silently dropping data.
 */
async function applyCustomValueUpdates(
  sb: ReturnType<typeof getSupabaseAdmin>,
  params: {
    organizationId: string;
    contactId: string;
    updates: CrmFieldUpdate[];
    fields: CrmFieldDefinition[];
    stored: Record<string, string | number | null>;
  },
): Promise<{
  values: Record<string, string | number | null>;
  written: string[];
  skipped: string[];
}> {
  const { organizationId, contactId, updates, fields, stored } = params;
  const customNames = new Set(
    fields.filter((field) => field.target === 'custom').map((field) => field.field_name),
  );

  const merged: Record<string, string | number | null> = { ...stored };
  const written: string[] = [];
  const skipped: string[] = [];

  for (const update of updates) {
    if (!customNames.has(update.field)) continue;
    if (shouldReplaceStoredValue(merged[update.field], update)) {
      merged[update.field] = update.value;
      written.push(update.field);
    } else {
      skipped.push(`${update.field} (kept the stored value)`);
    }
  }

  if (written.length === 0) return { values: merged, written, skipped };

  const { error } = await sb.from('contact_custom_values').upsert(
    { contact_id: contactId, organization_id: organizationId, values: merged },
    { onConflict: 'contact_id' },
  );
  if (error) throw new Error(`Custom values upsert failed: ${error.message}`);

  return { values: merged, written, skipped };
}

/**
 * Conservative contacts update:
 *  - the built-in CRM columns (name / phone / city / wilaya) are filled ONLY
 *    while they are empty or still an ingestion placeholder — an extraction
 *    never overwrites confirmed data;
 *  - lead_status only moves forward from 'new' to 'contacted' (the pipeline is
 *    not a scoring system: qualified / won / lost stay manual).
 * Returns the list of columns that were actually updated.
 */
async function applyContactUpdates(
  sb: ReturnType<typeof getSupabaseAdmin>,
  params: {
    contactId: string;
    contact: Record<string, unknown>;
    updates: CrmFieldUpdate[];
    fields: CrmFieldDefinition[];
  },
): Promise<{ updated: string[]; skipped: string[] }> {
  const { contactId, contact, updates, fields } = params;
  const contactFields = fields.filter(
    (field) =>
      field.target === 'contact' && (CONTACT_COLUMNS as readonly string[]).includes(field.field_name),
  );

  const changed: Record<string, string> = {};
  const skipped: string[] = [];

  for (const field of contactFields) {
    const update = updates.find((entry) => entry.field === field.field_name);
    if (!update) continue;

    const current = contact[field.field_name];
    if (shouldFillContactField(typeof current === 'string' ? current : null, update)) {
      changed[field.field_name] = String(update.value);
    } else {
      skipped.push(`${field.field_name} (contact column already set)`);
    }
  }

  const currentLeadStatus = String(contact.lead_status ?? 'new');
  if (currentLeadStatus === 'new') changed.lead_status = 'contacted';

  if (Object.keys(changed).length === 0) return { updated: [], skipped };

  const { error } = await sb.from('contacts').update(changed).eq('id', contactId);
  if (error) throw new Error(`Contact update failed: ${error.message}`);

  return { updated: Object.keys(changed), skipped };
}

/**
 * Full automatic extraction pipeline for one inbound message:
 * transcript + CRM schema → Gemini → CRM fields (custom values + contact).
 */
export async function processInboundMessage(
  apiKey: string,
  params: ProcessMessageParams,
): Promise<ProcessMessageResult> {
  const { organizationId, contactId, conversationId } = params;
  const sb = getSupabaseAdmin();

  // 1. Contact must exist and belong to the organization (multi-tenant guard).
  const { data: contact, error: contactError } = await sb
    .from('contacts')
    .select('id, name, phone, city, wilaya, lead_status')
    .eq('id', contactId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (contactError) throw new Error(`Contact lookup failed: ${contactError.message}`);
  if (!contact) throw new Error('Contact not found for this organization.');

  // 2. Transcript (with message ids) + the organization's CRM schema.
  const messages = await loadConversationMessages(sb, conversationId);
  if (messages.length === 0) {
    throw new Error('No analyzable messages in this conversation.');
  }
  const customFields = await loadCustomFields(sb, organizationId);
  const fields = buildCrmSchema(customFields);

  // 3. Gemini extraction (same prompt/validation as /ai/extract-crm-fields).
  const text = await callGemini({
    apiKey,
    model: GEMINI_MODEL,
    prompt: buildExtractionPrompt(fields, messages),
    generationConfig: EXTRACTION_GENERATION_CONFIG,
  });
  const updates = normalizeCrmFieldUpdates(parseModelJson(text), fields, messages);

  // 4. Persist — custom CRM fields first, then the built-in contact columns.
  const stored = await loadCustomValues(sb, contactId);
  const customResult = await applyCustomValueUpdates(sb, {
    organizationId,
    contactId,
    updates,
    fields,
    stored,
  });
  const contactResult = await applyContactUpdates(sb, {
    contactId,
    contact: contact as unknown as Record<string, unknown>,
    updates,
    fields,
  });

  return {
    organizationId,
    contactId,
    conversationId,
    transcript_messages: messages.length,
    crm_fields_used: fields.length,
    updates,
    applied_custom_values: customResult.written,
    applied_contact_fields: contactResult.updated.filter((column) => column !== 'lead_status'),
    skipped_updates: [...customResult.skipped, ...contactResult.skipped],
    contact_updates: contactResult.updated,
    custom_values_written: customResult.written.length,
  };
}

