// @ts-nocheck
// ↑ This file runs on the Deno runtime (Supabase Edge Functions).
// TypeScript errors shown by VS Code here are false positives from the Node.js TS server.
// Install the "Deno" VS Code extension (denoland.vscode-deno) to get correct Deno intellisense.
//
// bright-worker/index.ts
// Multi-channel Meta Webhook handler for BOTD Social CRM
// Handles: GET verification + POST events (Instagram, Facebook/Messenger)
// Deploys to: https://exoajfewjydcgxsslswq.supabase.co/functions/v1/bright-worker

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface NormalizedEvent {
  channel: 'instagram' | 'facebook';
  /** The external_account_id of the company's social account (recipient) */
  social_account_external_id: string;
  /** The external user ID of the person who sent the message */
  external_user_id: string;
  /** Optional conversation/thread identifier provided by Meta */
  external_conversation_id: string | null;
  /** The unique message ID from Meta (used for idempotency) */
  external_message_id: string;
  message_text: string | null;
  /** 'text' | 'image' | 'video' | 'audio' | 'story_mention' | 'unsupported' */
  message_type: string;
  /** Attachment metadata exactly as provided by Meta (type + payload URL). */
  attachments: Array<Record<string, unknown>>;
  /** Any available profile data from the payload */
  profile_data: Record<string, unknown>;
  /** Full raw payload preserved for debugging / future use */
  raw_data: unknown;
  timestamp_ms: number;
}

// ---------------------------------------------------------------------------
// INSTAGRAM PARSER
// Parses the actual Instagram Messaging webhook payload structure.
// Ref: https://developers.facebook.com/docs/messenger-platform/webhooks
// Instagram DM payload object field: "instagram", entry[].messaging[]
// ---------------------------------------------------------------------------

function parseInstagramEvent(entry: Record<string, unknown>): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  // Instagram sends messaging events under entry.messaging[]
  const messaging = entry['messaging'] as Record<string, unknown>[] | undefined;
  if (!Array.isArray(messaging)) return events;

  // The recipient is the page/IG account that received the message
  const recipientId = (entry['id'] as string) ?? '';

  for (const msg of messaging) {
    const message = msg['message'] as Record<string, unknown> | undefined;
    const timestampMs = (msg['timestamp'] as number) ?? Date.now();

    // ---- EVENT_TYPE classification ------------------------------------
    // Only real inbound `message` events become chat messages. Seen
    // receipts, deliveries, reactions, echoes, optins, referrals and
    // postbacks are logged and SKIPPED — never stored as text messages.
    if (!message || message['is_echo'] === true) {
      const eventType = message?.['is_echo'] === true
        ? 'echo'
        : msg['read']
        ? 'message_seen'
        : msg['delivery']
        ? 'message_delivered'
        : msg['reaction']
        ? 'message_reactions'
        : msg['optin']
        ? 'optin'
        : msg['referral']
        ? 'referral'
        : msg['postback']
        ? 'postback'
        : 'unknown_non_message';
      console.log(`EVENT_TYPE: ${eventType} (skipped — not an inbound chat message)`);
      continue;
    }

    const sender = msg['sender'] as Record<string, unknown> | undefined;
    if (!sender) {
      console.log('EVENT_TYPE: message_without_sender (skipped)');
      continue;
    }

    const senderId = (sender['id'] as string) ?? '';
    const messageId = (message['mid'] as string) ?? '';
    if (!messageId) {
      // external_message_id powers idempotency; without it we cannot dedupe.
      console.log('EVENT_TYPE: message_without_mid (skipped)');
      continue;
    }

    // Determine message type and content
    let messageText: string | null = null;
    let messageType = 'unsupported';
    const attachments: Array<Record<string, unknown>> = [];

    if (typeof message['text'] === 'string') {
      messageText = message['text'];
      messageType = 'text';
    } else if (Array.isArray(message['attachments'])) {
      // Store ONLY the metadata Meta provides (type + payload URL).
      // No AI analysis, no content inference (Phase 1).
      for (const att of message['attachments'] as Record<string, unknown>[]) {
        const payload = att['payload'] as Record<string, unknown> | undefined;
        attachments.push({
          type: (att['type'] as string) ?? null,
          url: (payload?.['url'] as string) ?? null,
        });
      }
      messageType = (attachments[0]?.['type'] as string) ?? 'unsupported';
    } else if (message['story_mention']) {
      messageType = 'story_mention';
    }

    events.push({
      channel: 'instagram',
      social_account_external_id: recipientId,
      external_user_id: senderId,
      external_conversation_id: null, // Instagram DMs don't provide a conversation ID in the payload
      external_message_id: messageId,
      message_text: messageText,
      message_type: messageType,
      attachments,
      profile_data: {}, // No profile data available in the webhook payload
      raw_data: msg,
      timestamp_ms: timestampMs,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// FACEBOOK / MESSENGER PARSER
// Facebook Messenger uses a very similar payload structure to Instagram DMs.
// The primary difference is the object type ("page" vs "instagram") and
// the sender/recipient IDs refer to Facebook PSIDs instead of Instagram IDs.
// This parser is structurally ready; extend it when Messenger is enabled.
// ---------------------------------------------------------------------------

function parseFacebookEvent(entry: Record<string, unknown>): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  const messaging = entry['messaging'] as Record<string, unknown>[] | undefined;
  if (!Array.isArray(messaging)) return events;

  const recipientId = (entry['id'] as string) ?? '';

  for (const msg of messaging) {
    const message = msg['message'] as Record<string, unknown> | undefined;
    const timestampMs = (msg['timestamp'] as number) ?? Date.now();

    // Same EVENT_TYPE classification as Instagram: only inbound `message`
    // events are persisted; receipts/reactions/echoes are skipped.
    if (!message || message['is_echo'] === true) {
      const eventType = message?.['is_echo'] === true
        ? 'echo'
        : msg['read']
        ? 'message_seen'
        : msg['delivery']
        ? 'message_delivered'
        : msg['reaction']
        ? 'message_reactions'
        : msg['optin']
        ? 'optin'
        : msg['referral']
        ? 'referral'
        : msg['postback']
        ? 'postback'
        : 'unknown_non_message';
      console.log(`EVENT_TYPE: ${eventType} (skipped — not an inbound chat message)`);
      continue;
    }

    const sender = msg['sender'] as Record<string, unknown> | undefined;
    if (!sender) {
      console.log('EVENT_TYPE: message_without_sender (skipped)');
      continue;
    }

    const senderId = (sender['id'] as string) ?? '';
    const messageId = (message['mid'] as string) ?? '';
    if (!messageId) {
      console.log('EVENT_TYPE: message_without_mid (skipped)');
      continue;
    }

    let messageText: string | null = null;
    let messageType = 'unsupported';
    const attachments: Array<Record<string, unknown>> = [];

    if (typeof message['text'] === 'string') {
      messageText = message['text'];
      messageType = 'text';
    } else if (Array.isArray(message['attachments'])) {
      for (const att of message['attachments'] as Record<string, unknown>[]) {
        const payload = att['payload'] as Record<string, unknown> | undefined;
        attachments.push({
          type: (att['type'] as string) ?? null,
          url: (payload?.['url'] as string) ?? null,
        });
      }
      messageType = (attachments[0]?.['type'] as string) ?? 'unsupported';
    }

    events.push({
      channel: 'facebook',
      social_account_external_id: recipientId,
      external_user_id: senderId,
      external_conversation_id: null,
      external_message_id: messageId,
      message_text: messageText,
      message_type: messageType,
      attachments,
      profile_data: {},
      raw_data: msg,
      timestamp_ms: timestampMs,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// CRM PERSISTENCE
// Idempotent: find-or-create for contacts, channel identities, conversations.
// Messages are inserted once per external_message_id.
// ---------------------------------------------------------------------------

/**
 * Detect which optional messaging columns actually exist on `messages`
 * (channel / direction / attachments) so the insert row adapts to the
 * migration state instead of failing on a missing column.
 */
async function getMessageColumns(
  supabase: ReturnType<typeof createClient>,
): Promise<Set<string>> {
  const candidates = ['channel', 'direction', 'attachments'];
  const existing = new Set<string>();
  for (const col of candidates) {
    const { error } = await supabase.from('messages').select(col).limit(0);
    if (!error) existing.add(col);
  }
  return existing;
}

/**
 * Best-effort contact identity enrichment (Phase 1.5).
 *
 * Instagram DM webhooks carry ONLY identifiers (IGSIDs) — no username or
 * display name. The sender's username can be obtained officially from the
 * Message Details API using the message ID and the receiving account's
 * stored Instagram User access token:
 *   GET https://graph.instagram.com/v25.0/<MESSAGE_ID>
 *       ?fields=id,created_time,from,to,message
 *
 * Rules:
 *  - Runs ONLY for placeholder-named contacts ("instagram user 123456" /
 *    empty / unknown) so the API is NOT called for every message.
 *  - Never throws and never alters the ingestion outcome: on any failure the
 *    placeholder name is kept and a warning is logged.
 *  - The access token is read from social_accounts (service role) and is
 *    NEVER logged.
 */
async function enrichContactUsername(
  supabase: ReturnType<typeof createClient>,
  params: { socialAccountId: string; contactChannelId: string; messageId: string },
): Promise<void> {
  const isPlaceholderName = (name: string | null | undefined): boolean => {
    const value = (name ?? '').trim().toLowerCase();
    if (!value) return true;
    if (value === 'unknown' || value === 'unknown contact') return true;
    // Names created by this worker: "<channel> user <last-6-of-IGSID>"
    return /^(instagram|facebook) user /i.test(name ?? '');
  };

  try {
    // 1. The receiving account's stored Instagram User access token.
    const { data: socialAccount, error: saError } = await supabase
      .from('social_accounts')
      .select('access_token')
      .eq('id', params.socialAccountId)
      .maybeSingle();
    if (saError) {
      console.warn(
        `CONTACT_ENRICH_SKIPPED: social_accounts access_token unavailable (${saError.message})`,
      );
      return;
    }
    const accessToken = socialAccount?.access_token as string | undefined | null;
    if (!accessToken) {
      console.warn(
        'CONTACT_ENRICH_SKIPPED: no access token stored for this social account (reconnect to enable username enrichment)',
      );
      return;
    }

    // 2. Current contact/channel state. Skip if already enriched — this is
    //    what keeps the Message Details API from being called per message.
    const { data: channel } = await supabase
      .from('contact_channels')
      .select('contact_id, profile_data')
      .eq('id', params.contactChannelId)
      .maybeSingle();
    const channelProfile = channel?.profile_data as Record<string, unknown> | null;
    if (!channel?.contact_id) {
      console.warn('CONTACT_ENRICH_SKIPPED: contact_channel not found');
      return;
    }
    if (channelProfile?.['username']) {
      return; // username already known from a previous message
    }

    const { data: contact } = await supabase
      .from('contacts')
      .select('id, name')
      .eq('id', channel.contact_id)
      .maybeSingle();
    if (!contact) {
      console.warn('CONTACT_ENRICH_SKIPPED: contact not found');
      return;
    }
    if (!isPlaceholderName(contact.name as string | undefined)) {
      return; // a real name is already present
    }

    // 3. Message Details API — the official, documented username source.
    const detailsUrl = new URL(
      `https://graph.instagram.com/v25.0/${encodeURIComponent(params.messageId)}`,
    );
    detailsUrl.searchParams.set('fields', 'id,created_time,from,to,message');
    detailsUrl.searchParams.set('access_token', accessToken);

    const res = await fetch(detailsUrl.toString());
    const details = await res.json();
    if (!res.ok || details?.error) {
      console.warn(
        `CONTACT_ENRICH_FAILED: message details request failed (${details?.error?.message ?? res.status})`,
      );
      return;
    }

    const detailsPayload = Array.isArray(details?.data) ? details.data[0] : details;
    const username = detailsPayload?.from?.username as string | undefined;
    if (!username) {
      console.warn('CONTACT_ENRICH_FAILED: no username in message details response');
      return;
    }

    // 4. Persist the Meta-trusted username. contacts.name is updated only
    //    while it is still a placeholder; existing real names are never
    //    overwritten.
    if (isPlaceholderName(contact.name as string | undefined)) {
      await supabase
        .from('contacts')
        .update({ name: username })
        .eq('id', contact.id);
    }

    const mergedProfile = {
      ...((channelProfile ?? {}) as Record<string, unknown>),
      username,
    };
    await supabase
      .from('contact_channels')
      .update({ profile_data: mergedProfile })
      .eq('id', params.contactChannelId);

    console.log(`CONTACT_ENRICHED: contact=${contact.id} username=${username}`);
  } catch (e) {
    console.warn(
      'CONTACT_ENRICH_FAILED:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function persistEvent(
  supabase: ReturnType<typeof createClient>,
  event: NormalizedEvent,
  organizationId: string,
) {
  console.log(
    `EVENT_TYPE: ${event.channel}:${event.message_type} mid=${event.external_message_id} sender=${event.external_user_id}`,
  );

  // 1. Find the social_account by external_account_id + channel
  const { data: socialAccount, error: saError } = await supabase
    .from('social_accounts')
    .select('id, organization_id')
    .eq('external_account_id', event.social_account_external_id)
    .eq('platform', event.channel)
    .maybeSingle();

  if (saError) {
    console.error('[bright-worker] Error looking up social_account:', saError.message);
    return;
  }

  // If we can't find a matching social account, we can't attribute the message.
  // This is expected before any account is connected through the settings UI.
  if (!socialAccount) {
    console.warn(
      `[bright-worker] No social_account found for ${event.channel} account ${event.social_account_external_id}. ` +
      `Storing raw event only.`
    );

    // Still store the raw event for debugging
    await supabase.from('raw_webhook_events').insert({
      organization_id: organizationId,
      platform: event.channel,
      external_account_id: event.social_account_external_id,
      payload: event.raw_data,
    });
    return;
  }

  console.log(
    `SOCIAL_ACCOUNT_FOUND: ${socialAccount.id} organization=${socialAccount.organization_id}`,
  );
  const resolvedOrgId = socialAccount.organization_id;
  const socialAccountId = socialAccount.id;

  // 2. Find or create the contact_channel (the sender's identity on this platform)
  let contactChannelId: string;
  const { data: existingChannel, error: ccError } = await supabase
    .from('contact_channels')
    .select('id, contact_id')
    .eq('channel', event.channel)
    .eq('external_user_id', event.external_user_id)
    .eq('organization_id', resolvedOrgId)
    .maybeSingle();

  if (ccError) {
    console.error('[bright-worker] Error looking up contact_channel:', ccError.message);
    return;
  }

  if (existingChannel) {
    contactChannelId = existingChannel.id;
    console.log(`CONTACT_FOUND_OR_CREATED: found contact_channel=${contactChannelId}`);
  } else {
    // Create a contact first, then a contact_channel record
    const { data: newContact, error: contactError } = await supabase
      .from('contacts')
      .insert({
        organization_id: resolvedOrgId,
        // Name will be updated later if profile data becomes available
        name: `${event.channel} user ${event.external_user_id.slice(-6)}`,
      })
      .select('id')
      .single();

    if (contactError || !newContact) {
      console.error('[bright-worker] Error creating contact:', contactError?.message);
      return;
    }

    const { data: newChannel, error: newChannelError } = await supabase
      .from('contact_channels')
      .insert({
        organization_id: resolvedOrgId,
        contact_id: newContact.id,
        channel: event.channel,
        external_user_id: event.external_user_id,
        profile_data: event.profile_data,
      })
      .select('id')
      .single();

    if (newChannelError || !newChannel) {
      console.error('[bright-worker] Error creating contact_channel:', newChannelError?.message);
      return;
    }

    contactChannelId = newChannel.id;
    console.log(`CONTACT_FOUND_OR_CREATED: created contact=${newContact.id} contact_channel=${contactChannelId} name="${newContact.name ?? ''}"`);
  }

  // Get the contact_id from the channel record for the conversation
  const { data: channelRow } = await supabase
    .from('contact_channels')
    .select('contact_id')
    .eq('id', contactChannelId)
    .single();

  const contactId = channelRow?.contact_id;

  // 3. Find or create the conversation
  let conversationId: string;
  const { data: existingConv, error: convError } = await supabase
    .from('conversations')
    .select('id')
    .eq('social_account_id', socialAccountId)
    .eq('contact_id', contactId)
    .eq('channel', event.channel)
    .maybeSingle();

  if (convError) {
    console.error('[bright-worker] Error looking up conversation:', convError.message);
    return;
  }

  if (existingConv) {
    conversationId = existingConv.id;
    // Update last_message_at
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date(event.timestamp_ms).toISOString() })
      .eq('id', conversationId);
    console.log(`CONVERSATION_FOUND_OR_CREATED: found conversation=${conversationId}`);
  } else {
    const { data: newConv, error: newConvError } = await supabase
      .from('conversations')
      .insert({
        organization_id: resolvedOrgId,
        social_account_id: socialAccountId,
        contact_id: contactId,
        channel: event.channel,
        external_conversation_id: event.external_conversation_id,
        status: 'open',
        last_message_at: new Date(event.timestamp_ms).toISOString(),
      })
      .select('id')
      .single();

    if (newConvError || !newConv) {
      console.error('[bright-worker] Error creating conversation:', newConvError?.message);
      return;
    }

    conversationId = newConv.id;
    console.log(`CONVERSATION_FOUND_OR_CREATED: created conversation=${conversationId}`);
  }

  // 4. Insert message (idempotent via external_message_id uniqueness).
  // Optional columns (channel / direction / attachments) are written only
  // when they exist, so the worker works before AND after the migration.
  const msgColumns = await getMessageColumns(supabase);
  const messageRow: Record<string, unknown> = {
    organization_id: resolvedOrgId,
    conversation_id: conversationId,
    external_message_id: event.external_message_id,
    sender_external_id: event.external_user_id,
    message_text: event.message_text,
    message_type: event.message_type,
    raw_data: event.raw_data,
    created_at: new Date(event.timestamp_ms).toISOString(),
  };
  if (msgColumns.has('channel')) messageRow.channel = event.channel;
  if (msgColumns.has('direction')) messageRow.direction = 'inbound';
  if (msgColumns.has('attachments') && event.attachments.length > 0) {
    messageRow.attachments = event.attachments;
  }

  const { error: msgError } = await supabase
    .from('messages')
    .insert(messageRow);

  if (msgError) {
    // Unique constraint violation = duplicate delivery, safe to ignore
    if (msgError.code === '23505') {
      console.log(`MESSAGE_DUPLICATE_SKIPPED: ${event.external_message_id}`);
    } else {
      console.error('[bright-worker] Error inserting message:', msgError.message);
    }
    return;
  }

  console.log(`MESSAGE_SAVED: ${event.external_message_id} conversation=${conversationId}`);

  // 5. Store raw webhook event
  await supabase.from('raw_webhook_events').insert({
    organization_id: resolvedOrgId,
    platform: event.channel,
    external_account_id: event.social_account_external_id,
    payload: event.raw_data,
  });

  // 6. Best-effort contact identity enrichment (username via the Message
  //    Details API). Only for placeholder-named contacts; failures are
  //    logged and never affect the saved message.
  await enrichContactUsername(supabase, {
    socialAccountId,
    contactChannelId,
    messageId: event.external_message_id,
  });

  console.log('[bright-worker] ✅ Event persisted successfully. message_id:', event.external_message_id);
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ------------------------------------------------------------------
  // GET: Meta webhook verification handshake
  // ------------------------------------------------------------------
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    const verifyToken = Deno.env.get('META_VERIFY_TOKEN');

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[bright-worker] ✅ Webhook verified successfully');
      return new Response(challenge ?? '', { status: 200 });
    }

    console.warn('[bright-worker] ⚠️ Webhook verification failed: token mismatch or missing params');
    return new Response('Forbidden', { status: 403 });
  }

  // ------------------------------------------------------------------
  // POST: Incoming Meta event
  // ------------------------------------------------------------------
  if (req.method === 'POST') {
    const rawBody = await req.text();

    // Optional webhook signature verification (X-Hub-Signature-256).
    // Enabled ONLY when META_WEBHOOK_SECRET is set (should equal the App
    // Secret of the subscribed Meta app). The secret is never logged.
    const webhookSecret = Deno.env.get('META_WEBHOOK_SECRET') ?? '';
    if (webhookSecret) {
      const signature = req.headers.get('x-hub-signature-256') ?? '';
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(webhookSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(rawBody),
      );
      const expected =
        'sha256=' +
        Array.from(new Uint8Array(mac))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      if (signature !== expected) {
        console.warn('WEBHOOK_SIGNATURE: MISMATCH — request rejected');
        return new Response('Invalid signature', { status: 401 });
      }
      console.log('WEBHOOK_SIGNATURE: OK');
    } else {
      console.warn(
        'WEBHOOK_SIGNATURE: DISABLED — set META_WEBHOOK_SECRET to verify X-Hub-Signature-256',
      );
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.error('WEBHOOK_RECEIVED: invalid JSON body');
      return new Response('Bad Request', { status: 400 });
    }

    const objectType = (body['object'] as string) ?? 'unknown';
    const entries = body['entry'] as Record<string, unknown>[] | undefined;
    console.log(
      `WEBHOOK_RECEIVED: object=${objectType} entries=${Array.isArray(entries) ? entries.length : 0}`,
    );

    if (!Array.isArray(entries)) {
      console.warn('EVENT_TYPE: no_entry_array (nothing to process)');
      return new Response('OK', { status: 200 });
    }

    // Initialize Supabase with the service role key (server-side only, never exposed to browser)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fallback org ONLY for raw webhook events that cannot be attributed to
    // any connected social account. Real attribution always comes from
    // social_accounts.organization_id (multi-tenant, never hardcoded).
    const defaultOrgId = Deno.env.get('DEFAULT_ORGANIZATION_ID') ?? '';

    // Parse and queue persistence work. Respond 200 to Meta FIRST, then
    // finish persistence in the background (EdgeRuntime.waitUntil) so we
    // never delay the response with long processing.
    const persistence: Promise<void>[] = [];
    for (const entry of entries) {
      if (objectType !== 'instagram' && objectType !== 'page') {
        console.log(
          `EVENT_TYPE: unsupported_object:${objectType} (skipped — not a messaging event, nothing stored as a message)`,
        );
        continue;
      }

      const normalizedEvents: NormalizedEvent[] =
        objectType === 'instagram'
          ? parseInstagramEvent(entry)
          : parseFacebookEvent(entry);

      for (const event of normalizedEvents) {
        persistence.push(persistEvent(supabase, event, defaultOrgId));
      }
    }

    if (persistence.length > 0) {
      const all = Promise.all(persistence);
      const edgeRuntime = (
        globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }
      ).EdgeRuntime;
      if (edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(all);
      } else {
        await all;
      }
    }

    return new Response('OK', { status: 200 });
  }

  return new Response('Method Not Allowed', { status: 405 });
});

