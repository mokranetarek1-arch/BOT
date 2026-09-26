// @ts-nocheck
// ↑ This file runs on the Deno runtime (Supabase Edge Functions).
// TypeScript errors shown by VS Code here are false positives from the Node.js TS server.
// Install the "Deno" VS Code extension (denoland.vscode-deno) to get correct Deno intellisense.
//
// send-message/index.ts
// Outbound Instagram DM sending for BOTD Social CRM (Inbox replies).
//
// This is the ONLY place that uses the stored Instagram access token to SEND.
// The token never reaches the browser: the frontend calls this function with the
// user's Supabase JWT, the function resolves the tenant server-side, reads the
// token with the service role and talks to the Meta Graph API.
//
// Request  (POST JSON): { conversation_id: string, text: string }
// Response (200)      : { ok: true, recipient_id, message: {…} }
//
// Deploy: supabase functions deploy send-message
// (JWT verification MUST stay ENABLED here — unlike bright-worker, this endpoint
//  is called by logged-in users only.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
// Same Instagram Login mode switch as instagram-oauth:
//   "instagram" -> Instagram API with Instagram Login  (graph.instagram.com)
//   "facebook"  -> Facebook Login for Business / IG Graph (graph.facebook.com)
// The Graph version matches the call bright-worker already makes successfully
// with the same stored token.
// ---------------------------------------------------------------------------

const GRAPH_VERSION = 'v25.0';

function resolveGraphBase(): { mode: 'instagram' | 'facebook'; base: string } {
  const mode = (Deno.env.get('INSTAGRAM_LOGIN_MODE') ?? 'instagram').trim().toLowerCase();
  if (mode === 'facebook') {
    return { mode: 'facebook', base: `https://graph.facebook.com/${GRAPH_VERSION}` };
  }
  return { mode: 'instagram', base: `https://graph.instagram.com/${GRAPH_VERSION}` };
}

/** Meta rejects Instagram text messages longer than 1000 characters. */
const MAX_TEXT_LENGTH = 1000;

/** Outbound Graph call deadline — Meta normally answers in well under a second. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Messaging window: a business may only reply within 24h of the customer's last
 * inbound message (Meta rule). Checked here for a clear, early error message —
 * Meta remains the source of truth and its own refusal is surfaced when it
 * disagrees.
 */
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

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
// COLUMN DETECTION
// The exact schema of public.messages / public.social_accounts is not frozen in
// this repo, so optional columns are probed before being read or written (the
// same pattern bright-worker and instagram-oauth use) instead of guessing them.
// ---------------------------------------------------------------------------

async function getMessageColumns(
  admin: ReturnType<typeof createClient>,
): Promise<Set<string>> {
  const candidates = ['channel', 'direction', 'attachments'];
  const existing = new Set<string>();
  for (const col of candidates) {
    const { error } = await admin.from('messages').select(col).limit(0);
    if (!error) existing.add(col);
  }
  return existing;
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
    'token_expires_at',
  ];
  const existing = new Set<string>();
  for (const col of candidates) {
    const { error } = await admin.from('social_accounts').select(col).limit(0);
    if (!error) existing.add(col);
  }
  return existing;
}

// ---------------------------------------------------------------------------
// TENANT RESOLUTION
// Users are linked to organizations through the `organization_members` join
// table (organization_id, user_id, role). There is NO organization_id column on
// `profiles`. The organization ALWAYS comes from the verified JWT — never from
// the request body, so a caller can never write into another tenant.
// ---------------------------------------------------------------------------

async function resolveOrganizationId(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', userId)
    .order('organization_id', { ascending: true })
    .limit(1);

  if (error) throw new Error(error.message);
  return data?.[0]?.organization_id ?? null;
}

// ---------------------------------------------------------------------------
// META GRAPH — ERROR MAPPING
// ---------------------------------------------------------------------------

/** Extracts Meta's own error code/message. Never echoes the access token. */
function metaErrorInfo(data: unknown): { code: number | null; message: string } {
  const error = (data as { error?: Record<string, unknown> } | null)?.error;
  if (!error) return { code: null, message: '' };
  const code = typeof error['code'] === 'number' ? (error['code'] as number) : null;
  const message = typeof error['message'] === 'string' ? (error['message'] as string) : '';
  return { code, message };
}

/**
 * Maps a Meta refusal onto an HTTP status + a user-facing message.
 * Code 10 / OAuthException 190 / code 200 are the refusals users actually hit:
 * the closed 24h window, an expired token, and a missing permission.
 */
function describeMetaFailure(
  status: number,
  code: number | null,
  message: string,
): { status: number; error: string } {
  const detail = message ? ` Instagram said: ${message}` : '';

  if (code === 10 || /outside.*window|24[- ]hour/i.test(message)) {
    return {
      status: 409,
      error:
        'Instagram refused the message: the 24-hour reply window has closed. ' +
        `Ask the customer to write again first.${detail}`,
    };
  }
  if (code === 190 || status === 401) {
    return {
      status: 401,
      error:
        'Instagram rejected the stored access token (expired or revoked). ' +
        `Reconnect Instagram in Settings.${detail}`,
    };
  }
  if (code === 200 || status === 403) {
    return {
      status: 403,
      error:
        'Instagram refused the message (missing permission). ' +
        `Reconnect Instagram so the messaging scope is granted.${detail}`,
    };
  }
  return {
    status: 502,
    error: `Could not send the Instagram message (HTTP ${status}).${detail}`,
  };
}

// ---------------------------------------------------------------------------
// RECIPIENT + MESSAGING WINDOW
// ---------------------------------------------------------------------------

/**
 * The customer's Instagram-scoped id (IGSID) — the `recipient` of an outbound
 * DM. Read from contact_channels (the canonical channel identity, see
 * src/types/index.ts), with the last INBOUND message as a fallback for rows
 * created before that channel identity existed.
 */
async function resolveRecipientId(
  admin: ReturnType<typeof createClient>,
  params: { contactId: string | null; conversationId: string; channel?: string },
): Promise<string | null> {
  const targetChannel = params.channel ?? 'instagram';
  if (params.contactId) {
    const { data, error } = await admin
      .from('contact_channels')
      .select('external_user_id')
      .eq('contact_id', params.contactId)
      .eq('channel', targetChannel)
      .order('created_at', { ascending: true })
      .limit(1);

    if (!error) {
      const id = (data?.[0] as { external_user_id?: unknown } | undefined)
        ?.external_user_id;
      if (typeof id === 'string' && id) return id;
    }
  }

  // Fallback: whoever sent the last inbound message in this conversation.
  const { data, error } = await admin
    .from('messages')
    .select('sender_external_id')
    .eq('conversation_id', params.conversationId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) return null;
  const id = (data?.[0] as { sender_external_id?: unknown } | undefined)
    ?.sender_external_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Meta's 24-hour rule: a business may only reply within 24h of the customer's
 * LAST INBOUND message. The authoritative timestamp is read from the messages
 * table; `conversations.last_message_at` is only a fallback (it is also bumped
 * by our own outbound sends, so it can be later than the customer's message).
 *
 * Returns a user-facing error message when the window has closed, else null.
 * Never blocks a send it cannot judge: if no reference timestamp is available
 * the call proceeds and Meta's own answer decides.
 */
async function checkMessagingWindow(
  admin: ReturnType<typeof createClient>,
  params: { conversationId: string; lastMessageAt: string | null },
): Promise<string | null> {
  let referenceIso: string | null = params.lastMessageAt;

  const { data, error } = await admin
    .from('messages')
    .select('created_at')
    .eq('conversation_id', params.conversationId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1);

  if (!error) {
    const iso = (data?.[0] as { created_at?: unknown } | undefined)?.created_at;
    if (typeof iso === 'string' && iso) referenceIso = iso;
  }

  if (!referenceIso) return null;

  const lastInbound = new Date(referenceIso).getTime();
  if (!Number.isFinite(lastInbound)) return null;

  const elapsed = Date.now() - lastInbound;
  if (elapsed <= MESSAGING_WINDOW_MS) return null;

  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  return (
    `The 24-hour reply window closed about ${hours}h ago — Instagram only allows ` +
    "replies within 24 hours of the customer's last message. Ask the customer to " +
    'write again first.'
  );
}

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  // ---- Authenticate the caller (multi-tenant safety) --------------------
  // The frontend sends the user's Supabase JWT. We resolve the organization
  // from it, NEVER trusting an organization_id supplied by the client.
  const authHeader = req.headers.get('Authorization') ?? '';
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

  let organizationId: string | null = null;
  try {
    organizationId = await resolveOrganizationId(admin, user.id);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : 'Failed to resolve organization.' },
      400,
    );
  }
  if (!organizationId) {
    return json(
      { error: 'No organization found for this account. Complete onboarding first.' },
      400,
    );
  }

  // ---- Body -------------------------------------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const conversationId =
    typeof body['conversation_id'] === 'string' ? body['conversation_id'].trim() : '';
  const text = typeof body['text'] === 'string' ? body['text'].trim() : '';

  if (!conversationId) return json({ error: 'conversation_id is required.' }, 400);
  if (!text) return json({ error: 'Message text is required.' }, 400);
  if (text.length > MAX_TEXT_LENGTH) {
    return json(
      { error: `Message is too long (max ${MAX_TEXT_LENGTH} characters).` },
      400,
    );
  }

  // ---- Conversation, scoped to the caller's organization ----------------
  const { data: conversation, error: convError } = await admin
    .from('conversations')
    .select('id, organization_id, social_account_id, contact_id, channel, last_message_at')
    .eq('id', conversationId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (convError) {
    return json({ error: `Could not load the conversation: ${convError.message}` }, 500);
  }
  if (!conversation) return json({ error: 'Conversation not found.' }, 404);

  const isFacebook = conversation.channel === 'facebook';
  const isWhatsApp = conversation.channel === 'whatsapp';
  if (conversation.channel !== 'instagram' && !isFacebook && !isWhatsApp) {
    return json(
      { error: `Replying is not supported on the "${conversation.channel}" channel yet.` },
      400,
    );
  }

  // ---- The connected Social account (the token stays server-side) ----
  const columns = await getSocialAccountColumns(admin);
  // Same precedence as instagram-oauth: an explicit encrypted column wins.
  const tokenColumn = columns.has('access_token_encrypted')
    ? 'access_token_encrypted'
    : columns.has('access_token')
      ? 'access_token'
      : null;

  if (!tokenColumn) {
    return json(
      {
        error:
          'social_accounts has no access_token / access_token_encrypted column — the token was never stored.',
        hint:
          'Add the column, then reconnect in Settings.',
      },
      500,
    );
  }

  const { data: socialAccount, error: saError } = await admin
    .from('social_accounts')
    .select(`id, external_account_id, ${tokenColumn}`)
    .eq('id', conversation.social_account_id)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (saError) {
    return json({ error: `Could not load the social account: ${saError.message}` }, 500);
  }
  if (!socialAccount) {
    return json(
      { error: 'Connected account not found — reconnect it in Settings.' },
      404,
    );
  }

  const accountRow = socialAccount as Record<string, unknown>;
  const accountExternalId = String(accountRow['external_account_id'] ?? '');
  const accessToken = String(accountRow[tokenColumn] ?? '');

  if (!accountExternalId) {
    return json(
      { error: 'The connected account has no external_account_id — reconnect it.' },
      400,
    );
  }
  if (!accessToken) {
    return json(
      { error: 'No access token stored for this account — reconnect it in Settings.' },
      400,
    );
  }

  // ---- Recipient (customer PSID or IGSID) --------------------------------
  const recipientId = await resolveRecipientId(admin, {
    contactId: (conversation.contact_id as string | null) ?? null,
    conversationId: String(conversation.id),
    channel: conversation.channel,
  });
  if (!recipientId) {
    return json(
      { error: `Could not resolve the ${conversation.channel} recipient for this conversation.` },
      422,
    );
  }

  // ---- 24-hour messaging window ----------------------------------------
  const windowError = await checkMessagingWindow(admin, {
    conversationId: String(conversation.id),
    lastMessageAt: (conversation.last_message_at as string | null) ?? null,
  });
  if (windowError) return json({ error: windowError }, 409);

  // ---- Send through Meta ------------------------------------------------
  const endpoint = isWhatsApp
    ? `https://graph.facebook.com/v22.0/${encodeURIComponent(accountExternalId)}/messages`
    : isFacebook
      ? 'https://graph.facebook.com/v22.0/me/messages'
      : `${resolveGraphBase().base}/${encodeURIComponent(accountExternalId)}/messages`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let res: Response;
  let payload: unknown = null;
  try {
    let reqBody: Record<string, unknown>;
    if (isWhatsApp) {
      reqBody = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientId,
        type: 'text',
        text: { body: text },
      };
    } else {
      reqBody = {
        recipient: { id: recipientId },
        message: { text },
      };
      if (isFacebook) {
        reqBody.messaging_type = 'RESPONSE';
      }
    }

    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Never logged, never echoed back to the client.
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    payload = await res.json().catch(() => null);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return json(
        {
          error: `Meta did not answer within ${SEND_TIMEOUT_MS / 1000}s. The message was NOT sent.`,
        },
        504,
      );
    }
    console.error(
      '[send-message] Graph call failed:',
      e instanceof Error ? e.message : String(e),
    );
    return json({ error: 'Could not reach Meta API. Check the Edge Function logs.' }, 502);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const { code, message } = metaErrorInfo(payload);
    // Status + Meta code only — never the payload (it can echo the request).
    console.warn(
      `[send-message] Meta refused the message: status=${res.status} code=${code}`,
    );
    const failure = describeMetaFailure(res.status, code, message);
    return json({ error: failure.error }, failure.status);
  }

  const metaMessageId =
    typeof (payload as { message_id?: unknown } | null)?.message_id === 'string'
      ? String((payload as { message_id: string }).message_id)
      : Array.isArray((payload as { messages?: unknown[] } | null)?.messages) &&
        typeof ((payload as { messages: Record<string, unknown>[] }).messages[0]?.id) === 'string'
        ? String((payload as { messages: Record<string, unknown>[] }).messages[0].id)
        : '';
  const recipientConfirmed =
    typeof (payload as { recipient_id?: unknown } | null)?.recipient_id === 'string'
      ? String((payload as { recipient_id: string }).recipient_id)
      : recipientId;

  // ---- Persist the outbound message ------------------------------------
  // Idempotency comes from the same external_message_id uniqueness
  // bright-worker relies on for inbound deliveries: Meta's message id.
  const nowIso = new Date().toISOString();
  const externalMessageId = metaMessageId || `outbound-${crypto.randomUUID()}`;

  const msgColumns = await getMessageColumns(admin);
  const messageRow: Record<string, unknown> = {
    organization_id: organizationId,
    conversation_id: conversation.id,
    external_message_id: externalMessageId,
    sender_external_id: accountExternalId,
    message_text: text,
    message_type: 'text',
    raw_data: payload,
    created_at: nowIso,
  };
  if (msgColumns.has('channel')) messageRow.channel = conversation.channel;
  if (msgColumns.has('direction')) messageRow.direction = 'outbound';

  const { data: saved, error: insertError } = await admin
    .from('messages')
    .insert(messageRow)
    .select('id, created_at')
    .single();

  const storedId = (saved as { id?: unknown } | null)?.id;
  const storedCreatedAt = (saved as { created_at?: unknown } | null)?.created_at;
  const outboundMessage = {
    id: typeof storedId === 'string' ? storedId : externalMessageId,
    organization_id: organizationId,
    conversation_id: conversation.id,
    external_message_id: externalMessageId,
    sender_external_id: accountExternalId,
    message_type: 'text',
    message_text: text,
    direction: 'outbound',
    channel: conversation.channel,
    created_at: typeof storedCreatedAt === 'string' ? storedCreatedAt : nowIso,
  };

  // 23505 = this Meta message id is already stored (retry) — the DM did leave
  // Instagram, so it is not a failure for the caller.
  if (insertError && insertError.code !== '23505') {
    console.error('[send-message] Message sent but not stored:', insertError.message);
    return json({
      ok: true,
      recipient_id: recipientConfirmed,
      warning: `The message was sent to Instagram but could not be stored locally: ${insertError.message}`,
      message: outboundMessage,
    });
  }

  // Keep the conversation's activity timestamp in sync so the list reorders.
  await admin
    .from('conversations')
    .update({ last_message_at: nowIso })
    .eq('id', conversation.id)
    .eq('organization_id', organizationId);

  console.log(
    `[send-message] ✅ Outbound message sent. conversation=${conversation.id} mode=${graph.mode}`,
  );

  return json({
    ok: true,
    recipient_id: recipientConfirmed,
    message: outboundMessage,
  });
});







