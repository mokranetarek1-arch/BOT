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
      'pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging,business_management',
    );
    // Force Facebook to always prompt so user can check/re-select which pages they authorize
    authorizeUrl.searchParams.set('auth_type', 'rerequest');
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
      accountsUrl.searchParams.set('limit', '100');
      accountsUrl.searchParams.set('access_token', userAccessToken);

      const accountsRes = await fetch(accountsUrl.toString());
      const accountsData = await accountsRes.json();
      if (!accountsRes.ok || accountsData.error) {
        throw new Error(`Fetching Facebook pages failed: ${accountsData.error?.message ?? accountsRes.status}`);
      }

      let pages = Array.isArray(accountsData.data) ? accountsData.data : [];

      // Also fetch pages owned by businesses the user has access to, in case any were omitted from /me/accounts
      try {
        const bizUrl = new URL('https://graph.facebook.com/v22.0/me/businesses');
        bizUrl.searchParams.set('fields', 'id,name');
        bizUrl.searchParams.set('access_token', userAccessToken);
        const bizRes = await fetch(bizUrl.toString());
        const bizData = await bizRes.json();
        if (bizRes.ok && Array.isArray(bizData.data)) {
          const existingIds = new Set(pages.map((p: Record<string, unknown>) => String(p.id)));
          for (const biz of bizData.data) {
            const bizPagesUrl = new URL(`https://graph.facebook.com/v22.0/${biz.id}/owned_pages`);
            bizPagesUrl.searchParams.set('fields', 'id,name,access_token');
            bizPagesUrl.searchParams.set('limit', '100');
            bizPagesUrl.searchParams.set('access_token', userAccessToken);
            const bpRes = await fetch(bizPagesUrl.toString());
            const bpData = await bpRes.json();
            if (bpRes.ok && Array.isArray(bpData.data)) {
              for (const p of bpData.data) {
                if (!existingIds.has(String(p.id))) {
                  pages.push(p);
                  existingIds.add(String(p.id));
                }
              }
            }
          }
        }
      } catch (bizErr) {
        console.warn('[facebook-oauth] business pages lookup non-fatal error:', bizErr);
      }
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

  if (action === 'whatsapp_signup') {
    // Meta Embedded Signup (WhatsApp). The client sends the short-lived
    // exchangeable code returned by FB.login. Per Meta's docs this code has a
    // ~30s TTL, so it is exchanged immediately, on this first request.
    const code = body['code'] as string;
    if (!code) return json({ error: 'code is required.' }, 400);

    const wabaIdFromClient = body['whatsapp_business_id'] as string | undefined;
    const phoneIdFromClient = body['phone_number_id'] as string | undefined;

    try {
      // Step 1 — exchange the code for a business (system user) token.
      const tokenUrl = new URL('https://graph.facebook.com/v22.0/oauth/access_token');
      tokenUrl.searchParams.set('client_id', cfg.appId);
      tokenUrl.searchParams.set('client_secret', cfg.appSecret);
      tokenUrl.searchParams.set('code', code);

      const tokenRes = await fetch(tokenUrl.toString());
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || tokenData.error) {
        throw new Error(
          `Could not exchange the Embedded Signup code: ${tokenData.error?.message ?? tokenRes.status}`,
        );
      }
      const businessToken = String(tokenData.access_token);

      // Step 2 — resolve the WABA and the business phone number. The client
      // usually returns both, but we fall back to the API so that a partial
      // response still connects.
      let wabaId = wabaIdFromClient ?? null;
      let phoneNumberId = phoneIdFromClient ?? null;

      if (!wabaId) {
        const wabaUrl = new URL(
          'https://graph.facebook.com/v22.0/me/owned_whatsapp_business_accounts',
        );
        wabaUrl.searchParams.set('fields', 'id,name');
        wabaUrl.searchParams.set('access_token', businessToken);
        const wabaRes = await fetch(wabaUrl.toString());
        const wabaData = await wabaRes.json();
        const firstWaba = Array.isArray(wabaData.data) ? wabaData.data[0] : null;
        if (!firstWaba) {
          throw new Error(
            'No WhatsApp Business Account was found for this Meta account.',
          );
        }
        wabaId = String(firstWaba.id);
      }

      let displayName: string | null = null;
      let displayPhone: string | null = null;

      if (!phoneNumberId) {
        const phoneUrl = new URL(
          `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
        );
        phoneUrl.searchParams.set('fields', 'id,display_phone_number,verified_name');
        phoneUrl.searchParams.set('access_token', businessToken);
        const phoneRes = await fetch(phoneUrl.toString());
        const phoneData = await phoneRes.json();
        const firstPhone = Array.isArray(phoneData.data) ? phoneData.data[0] : null;
        if (!firstPhone) {
          throw new Error('No phone number is registered on this WhatsApp Business Account.');
        }
        phoneNumberId = String(firstPhone.id);
        displayPhone = firstPhone.display_phone_number ?? null;
        displayName = firstPhone.verified_name ?? null;
      } else {
        // Confirm the number details for a better account label.
        try {
          const infoUrl = new URL(`https://graph.facebook.com/v22.0/${phoneNumberId}`);
          infoUrl.searchParams.set('fields', 'display_phone_number,verified_name');
          infoUrl.searchParams.set('access_token', businessToken);
          const infoRes = await fetch(infoUrl.toString());
          const infoData = await infoRes.json();
          displayPhone = infoData.display_phone_number ?? null;
          displayName = infoData.verified_name ?? null;
        } catch {
          // Non-fatal: the account can still be stored with a generic name.
        }
      }

      // Step 3 — register the number for Cloud API and subscribe webhooks.
      // Both are best-effort: the business token is already usable to send.
      try {
        const regUrl = new URL(
          `https://graph.facebook.com/v22.0/${phoneNumberId}/register`,
        );
        regUrl.searchParams.set('access_token', businessToken);
        await fetch(regUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp' }),
        });
      } catch (e) {
        console.warn('[whatsapp-signup] number registration warning:', e);
      }

      try {
        const subUrl = new URL(
          `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`,
        );
        subUrl.searchParams.set('access_token', businessToken);
        const subRes = await fetch(subUrl.toString(), { method: 'POST' });
        if (!subRes.ok) {
          console.warn('[whatsapp-signup] webhook subscription returned', subRes.status);
        }
      } catch (e) {
        console.warn('[whatsapp-signup] webhook subscription warning:', e);
      }

      // Step 4 — persist the account for this organization.
      const accountName = displayName || displayPhone || `WhatsApp ${phoneNumberId}`;

      const columns = await getSocialAccountColumns(admin);
      const row: Record<string, unknown> = {};
      if (columns.has('organization_id')) row.organization_id = organizationId;
      if (columns.has('platform')) row.platform = 'whatsapp';
      if (columns.has('external_account_id')) {
        row.external_account_id = String(phoneNumberId);
      }
      if (columns.has('account_name')) row.account_name = accountName;

      if (columns.has('access_token_encrypted')) {
        row.access_token_encrypted = businessToken;
      } else if (columns.has('access_token')) {
        row.access_token = businessToken;
      } else {
        return json(
          {
            error:
              'social_accounts has no access_token / access_token_encrypted column — the token was never stored.',
            hint: 'Add the column, then reconnect WhatsApp.',
          },
          500,
        );
      }
      if (columns.has('connected_at')) row.connected_at = new Date().toISOString();

      const { data: saved, error: upsertError } = await admin
        .from('social_accounts')
        .upsert(row, { onConflict: 'organization_id,platform,external_account_id' })
        .select('*')
        .single();

      if (upsertError) {
        return json(
          { error: `Failed to save the WhatsApp account: ${upsertError.message}` },
          500,
        );
      }

      return json({
        ok: true,
        account: {
          id: saved?.id ?? null,
          external_account_id: String(phoneNumberId),
          name: accountName,
        },
      });
    } catch (e) {
      console.error('[whatsapp-signup] error:', e);
      return json(
        { error: e instanceof Error ? e.message : 'Unknown WhatsApp sign-up error.' },
        502,
      );
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
      accountsUrl.searchParams.set('limit', '100');
      accountsUrl.searchParams.set('access_token', userAccessToken);

      const accountsRes = await fetch(accountsUrl.toString());
      const accountsData = await accountsRes.json();
      if (!accountsRes.ok || accountsData.error) {
        throw new Error(`Fetching Facebook pages failed: ${accountsData.error?.message ?? accountsRes.status}`);
      }

      let pages = Array.isArray(accountsData.data) ? accountsData.data : [];

      let targetPage = pages.find((p: Record<string, unknown>) => String(p.id) === String(pageId));

      // Check owned_pages of businesses if not found directly
      if (!targetPage) {
        try {
          const bizUrl = new URL('https://graph.facebook.com/v22.0/me/businesses');
          bizUrl.searchParams.set('fields', 'id,name');
          bizUrl.searchParams.set('access_token', userAccessToken);
          const bizRes = await fetch(bizUrl.toString());
          const bizData = await bizRes.json();
          if (bizRes.ok && Array.isArray(bizData.data)) {
            for (const biz of bizData.data) {
              const bpUrl = new URL(`https://graph.facebook.com/v22.0/${biz.id}/owned_pages`);
              bpUrl.searchParams.set('fields', 'id,name,access_token');
              bpUrl.searchParams.set('limit', '100');
              bpUrl.searchParams.set('access_token', userAccessToken);
              const bpRes = await fetch(bpUrl.toString());
              const bpData = await bpRes.json();
              if (bpRes.ok && Array.isArray(bpData.data)) {
                const found = bpData.data.find((p: Record<string, unknown>) => String(p.id) === String(pageId));
                if (found) {
                  targetPage = found;
                  break;
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }

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

