/**
 * Automated background pipeline for the AI Lead Analyzer.
 *
 * Triggered by bright-worker (POST /ai/webhook/message) on every inbound
 * message. Steps:
 *   1. Load the conversation transcript + the organization's custom fields.
 *   2. Analyze through Gemini (same prompt/validation as /ai/analyze-lead).
 *   3. Persist: contact_ai_insights, contact_custom_values (merged) and
 *      conservative contacts updates (fill empty name/phone, upgrade
 *      lead_status — never overwrite confirmed facts, never downgrade).
 *
 * All DB access uses the service-role client and never touches the API key.
 */
import { getSupabaseAdmin } from './supabaseAdmin';
import { callGemini } from './gemini';
import { GEMINI_MODEL } from './config';
import {
  buildLeadPrompt,
  getPromptVersion,
  LEAD_GENERATION_CONFIG,
  normalizeLeadAnalysis,
  parseModelJson,
  type CustomSchemaField,
} from './analyzeLead';

export const MAX_TRANSCRIPT_MESSAGES = 20;

/** Placeholder names created by bright-worker for brand-new contacts. */
const PLACEHOLDER_NAME_RE = /^(instagram|facebook) user /i;

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
  custom_fields_used: number;
  analysis: {
    client_name: string | null;
    phone_number: string | null;
    intent: string | null;
    product_or_service: string | null;
    lead_score: number | null;
    summary: string | null;
    suggested_reply: string | null;
    custom_values: Record<string, string | number | null> | null;
  };
  contact_updates: string[];
  insights_written: string[];
  custom_values_written: number;
}

/** Builds the analyzable transcript from the conversation's recent messages. */
async function buildTranscript(
  sb: ReturnType<typeof getSupabaseAdmin>,
  conversationId: string,
): Promise<string> {
  const { data, error } = await sb
    .from('messages')
    .select('message_text, direction, message_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) throw new Error(`Could not load messages: ${error.message}`);

  const recent = (data ?? []).slice(-MAX_TRANSCRIPT_MESSAGES);
  return recent
    .map(
      (m: { message_text: string | null; direction: string | null; message_type: string }) =>
        `${m.direction === 'outbound' ? 'Agent' : 'Customer'}: ${m.message_text ?? `[${m.message_type}]`}`,
    )
    .join('\n');
}

/** Loads the organization's custom CRM fields as the Gemini schema. */
async function loadCustomSchema(
  sb: ReturnType<typeof getSupabaseAdmin>,
  organizationId: string,
): Promise<CustomSchemaField[]> {
  const { data, error } = await sb
    .from('crm_custom_fields')
    .select('field_name, field_label, field_type, options, description_for_ai')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Could not load custom fields: ${error.message}`);

  return (data ?? []).map((row: Record<string, unknown>) => ({
    field_name: String(row.field_name),
    field_label: String(row.field_label),
    field_type: String(row.field_type) as CustomSchemaField['field_type'],
    description_for_ai: typeof row.description_for_ai === 'string' ? row.description_for_ai : null,
    options: Array.isArray(row.options) ? row.options.map((opt) => String(opt)) : null,
  }));
}

/**
 * Insert-or-update one contact-level insight row (conversation_id = NULL).
 * Same key as the frontend writer (org + contact + type + prompt_version).
 */
async function upsertInsightRow(
  sb: ReturnType<typeof getSupabaseAdmin>,
  params: {
    organizationId: string;
    contactId: string;
    insightType: 'intent' | 'interests' | 'summary';
    value: Record<string, unknown>;
    model: string;
    promptVersion: string;
  },
): Promise<'created' | 'updated'> {
  const { organizationId, contactId, insightType, value, model, promptVersion } = params;

  const { data: existing, error: selectError } = await sb
    .from('contact_ai_insights')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('contact_id', contactId)
    .eq('insight_type', insightType)
    .eq('prompt_version', promptVersion)
    .is('conversation_id', null)
    .limit(1)
    .maybeSingle();
  if (selectError) throw new Error(`Insight lookup failed: ${selectError.message}`);

  if (existing?.id) {
    const { error } = await sb
      .from('contact_ai_insights')
      .update({ value, model })
      .eq('id', existing.id);
    if (error) throw new Error(`Insight update failed: ${error.message}`);
    return 'updated';
  }

  const { error } = await sb.from('contact_ai_insights').insert({
    organization_id: organizationId,
    contact_id: contactId,
    conversation_id: null,
    insight_type: insightType,
    value,
    model,
    prompt_version: promptVersion,
    source_message_ids: [],
  });
  if (error) throw new Error(`Insight insert failed: ${error.message}`);
  return 'created';
}

/** Merges the new non-null values over the stored ones (history is kept). */
async function upsertCustomValues(
  sb: ReturnType<typeof getSupabaseAdmin>,
  params: {
    organizationId: string;
    contactId: string;
    values: Record<string, string | number | null>;
  },
): Promise<number> {
  const { organizationId, contactId, values } = params;

  const { data: existingRow } = await sb
    .from('contact_custom_values')
    .select('values')
    .eq('contact_id', contactId)
    .maybeSingle();

  const stored =
    typeof existingRow?.values === 'object' && existingRow.values !== null
      ? (existingRow.values as Record<string, string | number | null>)
      : {};

  const merged: Record<string, string | number | null> = { ...stored };
  let changed = 0;
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== merged[key]) {
      merged[key] = value;
      changed += 1;
    }
  }

  const { error } = await sb.from('contact_custom_values').upsert(
    { contact_id: contactId, organization_id: organizationId, values: merged },
    { onConflict: 'contact_id' },
  );
  if (error) throw new Error(`Custom values upsert failed: ${error.message}`);
  return changed;
}

/**
 * Conservative contacts update:
 *  - name / phone are filled ONLY when empty or placeholder — AI inference
 *    never overwrites confirmed facts.
 *  - lead_status only moves forward: new → contacted (analysis happened),
 *    then → qualified on a strong buying signal. won/lost are never touched.
 * Returns the list of columns that were actually updated.
 */
async function updateContactFromAnalysis(
  sb: ReturnType<typeof getSupabaseAdmin>,
  params: {
    contactId: string;
    clientName: string | null;
    phoneNumber: string | null;
    intent: string | null;
    leadScore: number | null;
  },
): Promise<string[]> {
  const { contactId, clientName, phoneNumber, intent, leadScore } = params;

  const { data: contact, error } = await sb
    .from('contacts')
    .select('name, phone, lead_status')
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw new Error(`Contact lookup failed: ${error.message}`);
  if (!contact) throw new Error('Contact not found.');

  const updates: Record<string, string> = {};
  const currentName = typeof contact.name === 'string' ? contact.name.trim() : '';
  const isPlaceholder =
    !currentName ||
    currentName.toLowerCase() === 'unknown' ||
    PLACEHOLDER_NAME_RE.test(currentName);

  if (clientName && (!currentName || isPlaceholder) && clientName !== currentName) {
    updates.name = clientName;
  }
  const currentPhone = typeof contact.phone === 'string' ? contact.phone.trim() : '';
  if (phoneNumber && !currentPhone && phoneNumber !== currentPhone) {
    updates.phone = phoneNumber;
  }

  const currentLeadStatus = String(contact.lead_status ?? 'new');
  const strongSignal = intent === 'purchase' || (typeof leadScore === 'number' && leadScore >= 70);
  if (currentLeadStatus === 'new') {
    updates.lead_status = strongSignal ? 'qualified' : 'contacted';
  } else if (currentLeadStatus === 'contacted' && strongSignal) {
    updates.lead_status = 'qualified';
  }

  if (Object.keys(updates).length === 0) return [];

  const { error: updateError } = await sb
    .from('contacts')
    .update(updates)
    .eq('id', contactId);
  if (updateError) throw new Error(`Contact update failed: ${updateError.message}`);
  return Object.keys(updates);
}

/**
 * Full automatic pipeline for one inbound message:
 * transcript + custom schema → Gemini → insights + custom values + contact.
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
    .select('id')
    .eq('id', contactId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (contactError) throw new Error(`Contact lookup failed: ${contactError.message}`);
  if (!contact) throw new Error('Contact not found for this organization.');

  // 2. Transcript + custom schema.
  const transcript = await buildTranscript(sb, conversationId);
  if (!transcript.trim()) {
    throw new Error('No analyzable messages in this conversation.');
  }
  const customSchema = await loadCustomSchema(sb, organizationId);

  // 3. Gemini analysis (same prompt/validation as the manual endpoint).
  const text = await callGemini({
    apiKey,
    model: GEMINI_MODEL,
    prompt: buildLeadPrompt(transcript, customSchema.length > 0 ? customSchema : null),
    generationConfig: LEAD_GENERATION_CONFIG,
  });
  const analysis = normalizeLeadAnalysis(parseModelJson(text), customSchema);

  const model = GEMINI_MODEL;
  const promptVersion = getPromptVersion();
  const insightsWritten: string[] = [];

  // 4. Insights (intent / interests / summary — same shapes as the frontend).
  insightsWritten.push(
    `intent:${await upsertInsightRow(sb, {
      organizationId,
      contactId,
      insightType: 'intent',
      value: { intent: analysis.intent },
      model,
      promptVersion,
    })}`,
  );

  if (analysis.product_or_service !== null) {
    insightsWritten.push(
      `interests:${await upsertInsightRow(sb, {
        organizationId,
        contactId,
        insightType: 'interests',
        value: { product_or_service: analysis.product_or_service },
        model,
        promptVersion,
      })}`,
    );
  }

  insightsWritten.push(
    `summary:${await upsertInsightRow(sb, {
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
    })}`,
  );

  // 5. Dynamic custom values (merged over previous ones).
  let customValuesWritten = 0;
  if (analysis.custom_values && Object.keys(analysis.custom_values).length > 0) {
    customValuesWritten = await upsertCustomValues(sb, {
      organizationId,
      contactId,
      values: analysis.custom_values,
    });
  }

  // 6. Conservative contacts update (name / phone / lead_status).
  const contactUpdates = await updateContactFromAnalysis(sb, {
    contactId,
    clientName: analysis.client_name,
    phoneNumber: analysis.phone_number,
    intent: analysis.intent,
    leadScore: analysis.lead_score,
  });

  return {
    organizationId,
    contactId,
    conversationId,
    transcript_messages: transcript.split('\n').length,
    custom_fields_used: customSchema.length,
    analysis: {
      client_name: analysis.client_name,
      phone_number: analysis.phone_number,
      intent: analysis.intent,
      product_or_service: analysis.product_or_service,
      lead_score: analysis.lead_score,
      summary: analysis.summary,
      suggested_reply: analysis.suggested_reply,
      custom_values: analysis.custom_values,
    },
    contact_updates: contactUpdates,
    insights_written: insightsWritten,
    custom_values_written: customValuesWritten,
  };
}

