// @ts-nocheck
// ↑ This file runs on the Deno runtime (Supabase Edge Functions).
// TypeScript errors shown by VS Code here are false positives from the Node.js TS server.
// Install the "Deno" VS Code extension (denoland.vscode-deno) to get correct Deno intellisense.
//
// instagram-oauth/index.ts
// Instagram (Business) Login OAuth flow for BOTD Social CRM.
//
// This function is the ONLY place that touches Meta credentials and access tokens.
// The App Secret and the resulting Instagram access token NEVER reach the browser.
//
// Two actions (POST JSON):
//   { action: "start" }                      -> returns the Instagram authorize URL
//   { action: "callback", code, redirect_uri } -> exchanges code, stores social_account
//
// Deploy: supabase functions deploy instagram-oauth
// (JWT verification MUST stay ENABLED here: only logged-in users may call it.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
// All values come from Supabase Secrets. Nothing is hardcoded.
//
// INSTAGRAM_LOGIN_MODE:
//   "instagram" -> Instagram API with Instagram Login  (graph.instagram.com)
//   "facebook"  -> Facebook Login for Business / IG Graph (graph.facebook.com)
//
// Default is "instagram" (Instagram Business Login).
// ---------------------------------------------------------------------------

interface OAuthConfig {
  mode: 'instagram' | 'facebook';
  appId: string;
  appSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  graphBase: string;
  scopes: string[];
}

function getConfig(): OAuthConfig {
  const mode = (Deno.env.get('INSTAGRAM_LOGIN_MODE') ?? 'instagram') as
    | 'instagram'
    | 'facebook';

  const appId = Deno.env.get('INSTAGRAM_APP_ID') ?? '';
  const appSecret = Deno.env.get('INSTAGRAM_APP_SECRET') ?? '';
  const scopes = (Deno.env.get('INSTAGRAM_SCOPES') ??
    'instagram_business_basic')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (mode === 'facebook') {
    // Facebook Login for Business -> Instagram Graph API
    return {
      mode,
      appId,
      appSecret,
      authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
      graphBase: 'https://graph.facebook.com/v21.0',
      scopes,
    };
  }

  // Instagram API with Instagram Login (Business Login)
  return {
    mode: 'instagram',
    appId,
    appSecret,
    authorizeUrl: 'https://www.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    graphBase: 'https://graph.instagram.com',
    scopes,
  };
}

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

// ---------------------------------------------------------------------------
// SOCIAL ACCOUNTS — FLEXIBLE COLUMN DETECTION
// The exact schema of public.social_accounts is not frozen in this repo.
// We discover which columns actually exist before writing, so the function
// works regardless of migration state, and reports clearly what is missing
// instead of guessing column names.
// ---------------------------------------------------------------------------

async function getSocialAccountColumns(
  admin: ReturnType<typeof createClient>,
): Promise<Set<string>> {
  // information_schema is not exposed through PostgREST, so probe by
  // selecting candidate columns from an empty set. Any column that does not
  // exist triggers a Postgres "42703" error we can filter out.
  const candidates = [
    'id',
    'organization_id',
    'platform',
    'external_account_id',
    'account_name',
    'username',
    'access_token',
    'access_token_encrypted',
    'token_expires_at',
    'connected_at',
    'created_at',
    'updated_at',
  ];

  const existing = new Set<string>();
  for (const col of candidates) {
    const { error } = await admin
      .from('social_accounts')
      .select(col)
      .limit(0);
    if (!error) existing.add(col);
  }
  return existing;
}

function buildSocialAccountRow(
  columns: Set<string>,
  data: {
    organizationId: string;
    externalAccountId: string;
    accountName: string | null;
    accessToken: string;
    tokenExpiresAt: string | null;
  },
): Record<string, unknown> {
  const row: Record<string, unknown> = {};

  if (columns.has('organization_id')) row.organization_id = data.organizationId;
  if (columns.has('platform')) row.platform = 'instagram';
  if (columns.has('external_account_id')) {
    row.external_account_id = data.externalAccountId;
  }
  if (columns.has('account_name')) row.account_name = data.accountName;

  // Token storage: prefer an explicit encrypted column when present.
  if (columns.has('access_token_encrypted')) {
    // NOTE: this writes the raw token into the *_encrypted column.
    // If your project uses envelope encryption, plug it in here.
    row.access_token_encrypted = data.accessToken;
  } else if (columns.has('access_token')) {
    row.access_token = data.accessToken;
  }

  if (columns.has('token_expires_at') && data.tokenExpiresAt) {
    row.token_expires_at = data.tokenExpiresAt;
  }
  if (columns.has('connected_at')) row.connected_at = new Date().toISOString();

  return row;
}

// ---------------------------------------------------------------------------
// META / INSTAGRAM API CALLS
// ---------------------------------------------------------------------------

async function exchangeCodeForToken(
  cfg: OAuthConfig,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; userId: string; expiresIn: number | null }> {
  if (cfg.mode === 'facebook') {
    const url = new URL(cfg.tokenUrl);
    url.searchParams.set('client_id', cfg.appId);
    url.searchParams.set('client_secret', cfg.appSecret);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code', code);

    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(
        `Token exchange failed: ${data.error?.message ?? res.status}`,
      );
    }
    return {
      accessToken: data.access_token,
      userId: String(data.user_id ?? ''),
      // Will be resolved via /me below for facebook mode
      expiresIn: data.expires_in ?? null,
    };
  }

  // Instagram Login (Business Login): POST form-encoded
  const form = new URLSearchParams();
  form.set('client_id', cfg.appId);
  form.set('client_secret', cfg.appSecret);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);
  form.set('code', code);

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await res.json();
  if (!res.ok || data.error_type || data.error) {
    throw new Error(
      `Token exchange failed: ${data.error_message ?? data.error?.message ?? res.status}`,
    );
  }

  let accessToken: string = data.access_token;
  let userId: string = String(data.user_id ?? '');
  let expiresIn: number | null = data.expires_in ?? null;

  // Exchange the short-lived token for a long-lived one (60 days).
  // This is recommended production flow for Instagram Login.
  try {
    const longLived = new URL(`${cfg.graphBase}/access_token`);
    longLived.searchParams.set('grant_type', 'ig_exchange_token');
    longLived.searchParams.set('client_secret', cfg.appSecret);
    longLived.searchParams.set('access_token', accessToken);

    const llRes = await fetch(longLived.toString());
    const llData = await llRes.json();
    if (llRes.ok && llData.access_token) {
      accessToken = llData.access_token;
      expiresIn = llData.expires_in ?? expiresIn;
    }
  } catch (e) {
    console.warn('[instagram-oauth] long-lived exchange skipped:', e);
  }

  if (!userId) {
    const me = await fetchProfile(cfg, accessToken);
    userId = me.id;
  }

  return { accessToken, userId, expiresIn };
}

async function fetchProfile(
  cfg: OAuthConfig,
  accessToken: string,
): Promise<{ id: string; username: string | null; accountType: string | null }> {
  // Instagram Login: graph.instagram.com/me
  // Facebook mode: graph.facebook.com/me/accounts -> instagram_business_account
  const url = new URL(`${cfg.graphBase}/me`);
  url.searchParams.set('fields', 'id,username,account_type');
  url.searchParams.set('access_token', accessToken);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(
      `Profile fetch failed: ${data.error?.message ?? data.error_message ?? res.status}`,
    );
  }

  return {
    id: String(data.id ?? ''),
    username: data.username ?? null,
    accountType: data.account_type ?? null,
  };
}

// ---------------------------------------------------------------------------
// TENANT RESOLUTION
// Users are linked to organizations via the `organization_members` join table
// (organization_id, user_id, role) — the schema created in Register.tsx.
// There is NO organization_id column on `profiles`.
//
// A user may belong to several organizations; OAuth has no org picker, so we
// deterministically pick the first membership (ordered by organization_id for
// stability). Extend this later if you add multi-org switching.
//
// ONBOARDING REPAIR: accounts created before Register.tsx gained its
// organization step — or whose signup partially failed (e.g. RLS rejected the
// inserts) — have NO `organization_members` row at all, which used to fail
// OAuth with "No organization_id found for this user". For those accounts we
// create the missing organization + owner membership here, using the SAME
// existing tables as Register.tsx. The new org belongs exclusively to the
// JWT-verified caller: never another user's org, never a hardcoded id, never
// taken from the client.
// ---------------------------------------------------------------------------

interface AuthUserLike {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}

/**
 * Create the organization + owner membership this user is missing.
 * Mirrors Register.tsx steps 3 and 4 exactly (same tables, same shape).
 * Runs with the service-role client on the server; the user id always comes
 * from the verified JWT, never from the request body.
 */
async function ensureOrganizationForUser(
  admin: ReturnType<typeof createClient>,
  user: AuthUserLike,
): Promise<string> {
  const metaName = user.user_metadata?.['company_name'];
  const orgName =
    typeof metaName === 'string' && metaName.trim().length > 0
      ? metaName.trim()
      : 'My Organization';

  // 1. Create the organization (Register.tsx step 3).
  const { data: org, error: orgError } = await admin
    .from('organizations')
    .insert({ name: orgName })
    .select('id')
    .single();
  if (orgError || !org) {
    throw new Error(
      `Onboarding repair failed — could not create organization: ${orgError?.message ?? 'unknown error'}`,
    );
  }

  // 2. Make this user its owner (Register.tsx step 4).
  const { error: memberError } = await admin
    .from('organization_members')
    .insert({
      organization_id: org.id,
      user_id: user.id,
      role: 'owner',
    });
  if (memberError) {
    throw new Error(
      `Onboarding repair failed — could not create organization membership: ${memberError.message}`,
    );
  }

  console.log(
    `[instagram-oauth] onboarding repair: created organization ${org.id} for user ${user.id}`,
  );
  return org.id;
}

async function resolveOrganizationId(
  admin: ReturnType<typeof createClient>,
  user: AuthUserLike,
): Promise<string | null> {
  const { data: memberships, error: memberError } = await admin
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', user.id)
    .order('organization_id', { ascending: true })
    .limit(1);

  if (memberError) {
    throw new Error(
      `Failed to load organization membership: ${memberError.message}`,
    );
  }

  const first = Array.isArray(memberships) ? memberships[0] : memberships;
  if (first?.organization_id) return first.organization_id;

  // No membership at all -> complete onboarding server-side and return
  // the freshly created tenant instead of failing with 400.
  return ensureOrganizationForUser(admin, user);
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------

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
      {
        error:
          'Server misconfigured: INSTAGRAM_APP_ID and/or INSTAGRAM_APP_SECRET are missing from Supabase Secrets.',
      },
      500,
    );
  }

  // ---- Authenticate the caller (multi-tenant safety) --------------------
  // The frontend sends the user's Supabase JWT. We resolve the org from it,
  // NEVER trusting an organization_id supplied by the client.
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return json({ error: 'Unauthorized: missing or invalid session.' }, 401);
  }

  // Resolve the caller's organization (multi-tenant, server-side only).
  //
  // The real schema (see src/features/auth/pages/Register.tsx) links users to
  // organizations through the `organization_members` join table:
  //   organization_members (organization_id, user_id, role)
  // There is NO organization_id column on `profiles`.
  let organizationId: string | null = null;
  try {
    organizationId = await resolveOrganizationId(admin, user);
  } catch (e) {
    return json(
      {
        error: e instanceof Error ? e.message : 'Failed to resolve organization.',
        hint:
          'Automatic onboarding repair failed. Check the Edge Function logs for "onboarding repair" and ensure the user can own a row in public.organization_members (organization_id, user_id, role).',
      },
      400,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const action = body['action'] as string;

  // ---- ACTION: start ----------------------------------------------------
  if (action === 'start') {
    const redirectUri = body['redirect_uri'] as string;
    if (!redirectUri) {
      return json({ error: 'redirect_uri is required.' }, 400);
    }

    const authorizeUrl = new URL(cfg.authorizeUrl);
    authorizeUrl.searchParams.set('client_id', cfg.appId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', cfg.scopes.join(','));
    // A random state; the frontend stores the same value and compares on return.
    authorizeUrl.searchParams.set(
      'state',
      (body['state'] as string) ?? crypto.randomUUID(),
    );

    return json({ authorize_url: authorizeUrl.toString() });
  }

  // ---- ACTION: callback -------------------------------------------------
  if (action === 'callback') {
    const code = body['code'] as string;
    const redirectUri = body['redirect_uri'] as string;
    if (!code || !redirectUri) {
      return json({ error: 'code and redirect_uri are required.' }, 400);
    }
    if (!organizationId) {
      return json(
        {
          error:
            'No organization_id found for this user. Complete onboarding before connecting Instagram.',
        },
        400,
      );
    }

    try {
      const token = await exchangeCodeForToken(cfg, code, redirectUri);
      const profile = await fetchProfile(cfg, token.accessToken);

      const externalAccountId = profile.id || token.userId;
      if (!externalAccountId) {
        return json({ error: 'Could not resolve Instagram account id.' }, 502);
      }

      const tokenExpiresAt =
        token.expiresIn != null
          ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
          : null;

      const columns = await getSocialAccountColumns(admin);
      const row = buildSocialAccountRow(columns, {
        organizationId,
        externalAccountId,
        accountName: profile.username,
        accessToken: token.accessToken,
        tokenExpiresAt,
      });

      const hasTokenColumn =
        columns.has('access_token') || columns.has('access_token_encrypted');

      // Upsert on (organization_id, platform, external_account_id).
      // If the token column is missing, we still link the account so the
      // webhook can attribute messages — but we warn loudly.
      const { data: saved, error: upsertError } = await admin
        .from('social_accounts')
        .upsert(row, {
          onConflict: 'organization_id,platform,external_account_id',
        })
        .select('*')
        .single();

      if (upsertError) {
        return json(
          {
            error: `Failed to save social_account: ${upsertError.message}`,
            hint:
              'Ensure social_accounts has columns organization_id, platform, external_account_id and a unique constraint on (organization_id, platform, external_account_id).',
          },
          500,
        );
      }

      return json({
        ok: true,
        account: {
          id: saved?.id ?? null,
          external_account_id: externalAccountId,
          username: profile.username,
          account_type: profile.accountType,
        },
        token_stored: hasTokenColumn,
        warning: hasTokenColumn
          ? null
          : 'social_accounts has no access_token / access_token_encrypted column — the token was NOT persisted. Add the column to enable DM sending later.',
      });
    } catch (e) {
      console.error('[instagram-oauth] callback error:', e);
      return json(
        { error: e instanceof Error ? e.message : 'Unknown OAuth error.' },
        502,
      );
    }
  }

  return json({ error: `Unknown action: ${action ?? '(none)'}` }, 400);
});
