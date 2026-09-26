// @ts-nocheck
// ↑ Runs on Deno (Supabase Edge Functions).
// facebook-oauth/index.ts
// Facebook Page / Messenger OAuth flow for BOTD Social CRM.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function getConfig(): { appId: string; appSecret: string } {
  const appId =
    Deno.env.get('FACEBOOK_APP_ID') ??
    Deno.env.get('INSTAGRAM_APP_ID') ??
    '';
  const appSecret =
    Deno.env.get('FACEBOOK_APP_SECRET') ??
    Deno.env.get('INSTAGRAM_APP_SECRET') ??
    '';
  return { appId, appSecret };
}

async function getSocialAccountColumns(
  admin: ReturnType<typeof createClient>,
): Promise<Set<string>> {
  const candidates = [
    'id',
    'organization_id',
    'platform',
    'external_account_id',
    'account_name',
    'access_token',
    'access_token_encrypted',
    'connected_at',
  ];
  const existing = new Set<string>();
  for (const col of candidates) {
    const { error } = await admin.from('social_accounts').select(col).limit(0);
    if (!error) existing.add(col);
  }
  return existing;
}

async function resolveOrganizationId(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  const { data: memberships, error } = await admin
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', userId)
    .order('organization_id', { ascending: true })
    .limit(1);

  if (error) throw new Error(`Failed to load organization: ${error.message}`);
  const first = Array.isArray(memberships) ? memberships[0] : memberships;
  return first?.organization_id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  const cfg = getConfig();
  if (!cfg.appId || !cfg.appSecret) {
    return json(
      { error: 'Server misconfigured: App credentials missing from Supabase Secrets.' },
      500,
    );
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: 'Unauthorized: missing or invalid session.' }, 401);
  }

  let organizationId: string | null = null;
  try {
    organizationId = await resolveOrganizationId(admin, user.id);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Org resolution failed.' }, 400);
  }

  if (!organizationId) {
    return json({ error: 'No organization found for this user.' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const action = body['action'] as string;

  if (action === 'start') {
    const redirectUri = body['redirect_uri'] as string;
    if (!redirectUri) return json({ error: 'redirect_uri is required.' }, 400);

    const authorizeUrl = new URL('https://www.facebook.com/v22.0/dialog/oauth');
    authorizeUrl.searchParams.set('client_id', cfg.appId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set(
      'scope',
      'pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging',
    );
    authorizeUrl.searchParams.set('state', (body['state'] as string) ?? crypto.randomUUID());
    return json({ authorize_url: authorizeUrl.toString() });
  }

  if (action === 'callback') {
    const code = body['code'] as string;
    const redirectUri = body['redirect_uri'] as string;
    if (!code || !redirectUri) return json({ error: 'code and redirect_uri are required.' }, 400);

    try {
      const tokenUrl = new URL('https://graph.facebook.com/v22.0/oauth/access_token');
      tokenUrl.searchParams.set('client_id', cfg.appId);
      tokenUrl.searchParams.set('client_secret', cfg.appSecret);
      tokenUrl.searchParams.set('redirect_uri', redirectUri);
      tokenUrl.searchParams.set('code', code);

      const tokenRes = await fetch(tokenUrl.toString());
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || tokenData.error) {
        throw new Error(`Token exchange failed: ${tokenData.error?.message ?? tokenRes.status}`);
      }

      const userAccessToken = tokenData.access_token;
      const accountsUrl = new URL('https://graph.facebook.com/v22.0/me/accounts');
      accountsUrl.searchParams.set('fields', 'id,name,access_token');
      accountsUrl.searchParams.set('access_token', userAccessToken);

      const accountsRes = await fetch(accountsUrl.toString());
      const accountsData = await accountsRes.json();
      if (!accountsRes.ok || accountsData.error) {
        throw new Error(`Fetching Facebook pages failed: ${accountsData.error?.message ?? accountsRes.status}`);
      }

      const pages = Array.isArray(accountsData.data) ? accountsData.data : [];
      if (pages.length === 0) {
        return json(
          { error: 'No Facebook Page found. Ensure you manage a Facebook Page and that you granted permission.' },
          400,
        );
      }

      const requestedPageId = body['page_id'] ? String(body['page_id']) : null;

      // If user has multiple pages and did not specify one yet, return the list for selection
      if (pages.length > 1 && !requestedPageId) {
        return json({
          ok: true,
          selection_required: true,
          user_access_token: userAccessToken,
          pages: pages.map((p: Record<string, unknown>) => ({
            id: String(p.id),
            name: String(p.name),
          })),
        });
      }

      const primaryPage = requestedPageId
        ? pages.find((p: Record<string, unknown>) => String(p.id) === requestedPageId) ?? pages[0]
        : pages[0];
      const pageId = String(primaryPage.id);
      const pageName = String(primaryPage.name);
      const pageAccessToken = String(primaryPage.access_token);

      const columns = await getSocialAccountColumns(admin);
      const row: Record<string, unknown> = {};
      if (columns.has('organization_id')) row.organization_id = organizationId;
      if (columns.has('platform')) row.platform = 'facebook';
      if (columns.has('external_account_id')) row.external_account_id = pageId;
      if (columns.has('account_name')) row.account_name = pageName;

      if (columns.has('access_token_encrypted')) {
        row.access_token_encrypted = pageAccessToken;
      } else if (columns.has('access_token')) {
        row.access_token = pageAccessToken;
      }
      if (columns.has('connected_at')) row.connected_at = new Date().toISOString();

      const { data: saved, error: upsertError } = await admin
        .from('social_accounts')
        .upsert(row, { onConflict: 'organization_id,platform,external_account_id' })
        .select('*')
        .single();

      if (upsertError) {
        return json({ error: `Failed to save Facebook account: ${upsertError.message}` }, 500);
      }

      // Best effort webhook subscription
      try {
        const subUrl = new URL(`https://graph.facebook.com/v22.0/${pageId}/subscribed_apps`);
        await fetch(subUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscribed_fields: ['messages', 'messaging_postbacks'],
            access_token: pageAccessToken,
          }),
        });
      } catch (e) {
        console.warn('[facebook-oauth] page webhook subscription warning:', e);
      }

      return json({
        ok: true,
        account: {
          id: saved?.id ?? null,
          external_account_id: pageId,
          name: pageName,
        },
      });
    } catch (e) {
      console.error('[facebook-oauth] callback error:', e);
      return json({ error: e instanceof Error ? e.message : 'Unknown Facebook OAuth error.' }, 502);
    }
  }

  if (action === 'select_page') {
    const userAccessToken = body['user_access_token'] as string;
    const pageId = body['page_id'] as string;
    if (!userAccessToken || !pageId) {
      return json({ error: 'user_access_token and page_id are required.' }, 400);
    }

    try {
      const accountsUrl = new URL('https://graph.facebook.com/v22.0/me/accounts');
      accountsUrl.searchParams.set('fields', 'id,name,access_token');
      accountsUrl.searchParams.set('access_token', userAccessToken);

      const accountsRes = await fetch(accountsUrl.toString());
      const accountsData = await accountsRes.json();
      if (!accountsRes.ok || accountsData.error) {
        throw new Error(`Fetching Facebook pages failed: ${accountsData.error?.message ?? accountsRes.status}`);
      }

      const pages = Array.isArray(accountsData.data) ? accountsData.data : [];
      const targetPage = pages.find((p: Record<string, unknown>) => String(p.id) === String(pageId));
      if (!targetPage) {
        return json({ error: `Page with ID ${pageId} not found among authorized pages.` }, 404);
      }

      const pageName = String(targetPage.name);
      const pageAccessToken = String(targetPage.access_token);

      const columns = await getSocialAccountColumns(admin);
      const row: Record<string, unknown> = {};
      if (columns.has('organization_id')) row.organization_id = organizationId;
      if (columns.has('platform')) row.platform = 'facebook';
      if (columns.has('external_account_id')) row.external_account_id = String(pageId);
      if (columns.has('account_name')) row.account_name = pageName;

      if (columns.has('access_token_encrypted')) {
        row.access_token_encrypted = pageAccessToken;
      } else if (columns.has('access_token')) {
        row.access_token = pageAccessToken;
      }
      if (columns.has('connected_at')) row.connected_at = new Date().toISOString();

      const { data: saved, error: upsertError } = await admin
        .from('social_accounts')
        .upsert(row, { onConflict: 'organization_id,platform,external_account_id' })
        .select('*')
        .single();

      if (upsertError) {
        return json({ error: `Failed to save Facebook account: ${upsertError.message}` }, 500);
      }

      // Webhook subscription
      try {
        const subUrl = new URL(`https://graph.facebook.com/v22.0/${pageId}/subscribed_apps`);
        await fetch(subUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscribed_fields: ['messages', 'messaging_postbacks'],
            access_token: pageAccessToken,
          }),
        });
      } catch (e) {
        console.warn('[facebook-oauth] page webhook subscription warning:', e);
      }

      return json({
        ok: true,
        account: {
          id: saved?.id ?? null,
          external_account_id: String(pageId),
          name: pageName,
        },
      });
    } catch (e) {
      console.error('[facebook-oauth] select_page error:', e);
      return json({ error: e instanceof Error ? e.message : 'Unknown select_page error.' }, 502);
    }
  }

  return json({ error: `Unknown action: "${action}".` }, 400);
});

