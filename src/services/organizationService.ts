import { supabase } from '@/utils/supabase';

/**
 * Resolves the signed-in user's organization through the organization_members
 * join table — there is NO organization_id column on profiles. RLS guarantees
 * a user can only ever read their own memberships, so this is tenant-safe by
 * construction (same pattern as the instagram-oauth Edge Function).
 */
export const organizationService = {
  /** The current user's organization id, or throws when unavailable. */
  async getCurrentOrganizationId(): Promise<string> {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      throw new Error('You are not signed in.');
    }

    const { data, error } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', userData.user.id)
      .limit(1);

    if (error) throw new Error(error.message);
    const orgId = data?.[0]?.organization_id;
    if (!orgId) throw new Error('No organization found for this account.');
    return orgId;
  },
};
