import { supabase } from '@/utils/supabase';
import { ContactInsight } from '@/types';

/**
 * Read-only access to AI inferences (public.contact_ai_insights).
 *
 * Reads are scoped by RLS to the signed-in user's organization — a company can
 * only ever see its own insights. No mock data, no service role, explicit
 * column lists only. There is intentionally no create/update/delete here:
 * writing insights is reserved for a future server-side analyzer.
 */

/** Explicit column list — never `select('*')`. */
const INSIGHT_FIELDS =
  'id, organization_id, contact_id, conversation_id, insight_type, value, confidence, model, prompt_version, source_message_ids, created_at, updated_at';

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
};
