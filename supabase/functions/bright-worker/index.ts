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
    const sender = msg['sender'] as Record<string, unknown> | undefined;
    const message = msg['message'] as Record<string, unknown> | undefined;
    const timestampMs = (msg['timestamp'] as number) ?? Date.now();

    if (!sender || !message) continue;

    const senderId = (sender['id'] as string) ?? '';
    const messageId = (message['mid'] as string) ?? '';

    // Skip echo events (messages sent by the page itself)
    if (message['is_echo'] === true) {
      console.log('[bright-worker] Skipping echo message:', messageId);
      continue;
    }

    // Determine message type and content
    let messageText: string | null = null;
    let messageType = 'unsupported';

    if (typeof message['text'] === 'string') {
      messageText = message['text'];
      messageType = 'text';
    } else if (message['attachments']) {
      const attachments = message['attachments'] as Record<string, unknown>[];
      const firstAttachment = attachments[0];
      messageType = (firstAttachment?.['type'] as string) ?? 'unsupported';
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
    const sender = msg['sender'] as Record<string, unknown> | undefined;
    const message = msg['message'] as Record<string, unknown> | undefined;
    const timestampMs = (msg['timestamp'] as number) ?? Date.now();

    if (!sender || !message) continue;

    const senderId = (sender['id'] as string) ?? '';
    const messageId = (message['mid'] as string) ?? '';

    // Skip echo events
    if (message['is_echo'] === true) {
      console.log('[bright-worker] Skipping Facebook echo message:', messageId);
      continue;
    }

    let messageText: string | null = null;
    let messageType = 'unsupported';

    if (typeof message['text'] === 'string') {
      messageText = message['text'];
      messageType = 'text';
    } else if (message['attachments']) {
      const attachments = message['attachments'] as Record<string, unknown>[];
      const firstAttachment = attachments[0];
      messageType = (firstAttachment?.['type'] as string) ?? 'unsupported';
    }

    events.push({
      channel: 'facebook',
      social_account_external_id: recipientId,
      external_user_id: senderId,
      external_conversation_id: null,
      external_message_id: messageId,
      message_text: messageText,
      message_type: messageType,
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

async function persistEvent(
  supabase: ReturnType<typeof createClient>,
  event: NormalizedEvent,
  organizationId: string,
) {
  console.log(`[bright-worker] Persisting ${event.channel} event:`, {
    social_account_external_id: event.social_account_external_id,
    external_user_id: event.external_user_id,
    external_message_id: event.external_message_id,
    message_type: event.message_type,
  });

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
    console.log('[bright-worker] Found existing contact_channel:', contactChannelId);
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
    console.log('[bright-worker] Created new contact + channel:', newContact.id, contactChannelId);
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
    console.log('[bright-worker] Created new conversation:', conversationId);
  }

  // 4. Insert message (idempotent via external_message_id uniqueness)
  const { error: msgError } = await supabase
    .from('messages')
    .insert({
      organization_id: resolvedOrgId,
      conversation_id: conversationId,
      external_message_id: event.external_message_id,
      sender_external_id: event.external_user_id,
      message_text: event.message_text,
      message_type: event.message_type,
      raw_data: event.raw_data,
      created_at: new Date(event.timestamp_ms).toISOString(),
    });

  if (msgError) {
    // Unique constraint violation = duplicate delivery, safe to ignore
    if (msgError.code === '23505') {
      console.log('[bright-worker] Duplicate message skipped:', event.external_message_id);
    } else {
      console.error('[bright-worker] Error inserting message:', msgError.message);
    }
    return;
  }

  // 5. Store raw webhook event
  await supabase.from('raw_webhook_events').insert({
    organization_id: resolvedOrgId,
    platform: event.channel,
    external_account_id: event.social_account_external_id,
    payload: event.raw_data,
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
    // Always return 200 quickly to Meta; process asynchronously
    // (We process synchronously here for MVP; for production use a queue)

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      console.error('[bright-worker] Failed to parse JSON body');
      return new Response('Bad Request', { status: 400 });
    }

    console.log('[bright-worker] Received POST event, object type:', body['object']);

    // Initialize Supabase with the service role key (server-side only, never exposed to browser)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // For MVP: use a default organization_id derived from a Supabase secret
    // In production, this will be resolved from the social_account → organization mapping
    const defaultOrgId = Deno.env.get('DEFAULT_ORGANIZATION_ID') ?? '';

    const objectType = body['object'] as string;
    const entries = body['entry'] as Record<string, unknown>[] | undefined;

    if (!Array.isArray(entries)) {
      console.warn('[bright-worker] No entries in payload');
      return new Response('OK', { status: 200 });
    }

    // Detect platform and parse events
    for (const entry of entries) {
      if (objectType !== 'instagram' && objectType !== 'page') {
        console.warn('[bright-worker] Unknown object type:', objectType);
        continue;
      }

      const normalizedEvents: NormalizedEvent[] =
        objectType === 'instagram'
          ? parseInstagramEvent(entry)
          : parseFacebookEvent(entry);

      for (const event of normalizedEvents) {
        await persistEvent(supabase, event, defaultOrgId);
      }
    }

    return new Response('OK', { status: 200 });
  }

  return new Response('Method Not Allowed', { status: 405 });
});

