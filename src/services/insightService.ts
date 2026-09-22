import { supabase } from '@/utils/supabase';
import type { ContactInsight, InsightType } from '@/types';

/**
 * Access to AI inferences (public.contact_ai_insights).
 *
 * Reads are scoped by RLS to the signed-in user's organization — a company can
 * only ever see its own insights. No mock data, no service role, explicit
 * column lists only.
 *
 * Writes happen only through analyzeContactLead(): the frontend calls the AI
 * backend (Render) which returns the structured analysis, and the result is
 * persisted as three insight rows. Row shapes respect the DB CHECK constraint
 * on insight_type:
 *   - 'intent'    ← { intent }
 *   - 'interests' ← { product_or_service } (only when present)
 *   - 'summary'   ← { client_name, phone_number, lead_score, summary,
 *                     suggested_reply }  (full lead analysis)
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
   * 1. POST {VITE_AI_BACKEND_URL}/ai/analyze-lead
   * 2. Validate the structured response
   * 3. Upsert intent / interests / summary rows in contact_ai_insights
   *
   * Throws with a user-safe message on any failure — no API keys and no raw
   * backend payloads are ever exposed.
   */
  async analyzeContactLead(params: {
    contactId: string;
    organizationId: string;
    messageText: string;
  }): Promise<LeadAnalysisData> {
    const { contactId, organizationId, messageText } = params;

    const baseUrl = import.meta.env.VITE_AI_BACKEND_URL;
    if (!baseUrl) {
      throw new Error('AI backend URL is not configured (VITE_AI_BACKEND_URL).');
    }

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

    return analysis;
  },
};
