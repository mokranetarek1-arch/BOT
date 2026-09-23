import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { contactService } from '@/services/contactService';
import { conversationService } from '@/services/conversationService';
import {
  Contact,
  ContactChannel,
  ContactCustomValues,
  Conversation,
  CrmCustomField,
  Message,
} from '@/types';
import { crmFieldService } from '@/services/crmFieldService';
import {
  channelBadgeClasses,
  conversationStatusClasses,
  customerStatusClasses,
  formatCustomValue,
  formatDate,
  formatDateTime,
  formatLocation,
  leadStatusClasses,
  textOrDash,
} from '../crmFormat';

/**
 * Attachment metadata exactly as Meta provides it (type + payload reference).
 * The shape is NOT guaranteed, so it is validated at runtime instead of being
 * assumed. Nothing is analyzed here — the types are only listed as-is.
 */
function attachmentTypesOf(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const types: string[] = [];
  for (const item of attachments) {
    if (item && typeof item === 'object' && 'type' in item) {
      const type = (item as { type?: unknown }).type;
      if (typeof type === 'string' && type.trim()) types.push(type);
    }
  }
  return types;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </p>
      <p className="text-sm break-words">{value}</p>
    </div>
  );
}

/**
 * Contact details — a real view of public.contacts, the channel identities and
 * the conversations attached to it, plus the CRM fields the organization
 * defined (crm_custom_fields / contact_custom_values).
 *
 * The extracted CRM data is the primary content of this page; the conversations
 * and messages below it are the supporting source. There is no separate
 * "AI Insights" section: the AI writes the CRM fields themselves, automatically
 * on every inbound message (and on demand through the extraction button).
 *
 * Everything comes from Supabase and is scoped by RLS to the signed-in user's
 * organization, so a contact of another organization is simply "not found".
 */
export default function ContactDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [channels, setChannels] = useState<ContactChannel[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  // CRM state: the organization's field definitions, this contact's extracted
  // values and the state of the manual "Extract CRM data with AI" action.
  const [customFields, setCustomFields] = useState<CrmCustomField[]>([]);
  const [customValues, setCustomValues] = useState<ContactCustomValues | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractNotice, setExtractNotice] = useState<string | null>(null);

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  // Contact itself. Loaded separately from channels/conversations so a failure
  // in either of those never hides the contact.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    contactService
      .getContactById(id)
      .then((row) => {
        if (!cancelled) setContact(row);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load contact.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Channel identities (username / technical id live in contact_channels).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    contactService
      .listContactChannels(id)
      .then((list) => {
        if (!cancelled) setChannels(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setChannelsError(err instanceof Error ? err.message : 'Could not load channels.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Every conversation of the contact — a plain list, never a single row.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    conversationService
      .getConversationsByContact(id)
      .then((list) => {
        if (!cancelled) setConversations(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setConversationsError(
            err instanceof Error ? err.message : 'Could not load conversations.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Dynamic Custom CRM: org field definitions + this contact's stored values.
  useEffect(() => {
    if (!id || !contact) return;
    let cancelled = false;
    crmFieldService
      .listCustomFields(contact.organization_id)
      .then((list) => {
        if (!cancelled) setCustomFields(list);
      })
      .catch(() => {
        // Non-fatal: the contact still renders without custom columns.
      });
    return () => {
      cancelled = true;
    };
  }, [id, contact]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    crmFieldService
      .getContactCustomValues(id)
      .then((values) => {
        if (!cancelled) setCustomValues(values);
      })
      .catch(() => {
        // Non-fatal.
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Silent refresh when the tab becomes visible again: the automatic AI
  // extraction writes CRM values and contact fields in the background as
  // messages arrive, so the page stays current without a manual reload.
  // Failures are ignored (the last rendered data stays).
  useEffect(() => {
    if (!id) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      contactService
        .getContactById(id)
        .then((row) => {
          if (row) setContact(row);
        })
        .catch(() => {});
      crmFieldService
        .getContactCustomValues(id)
        .then((values) => setCustomValues(values))
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [id]);

  // Messages of the selected conversation (loading state is set by the click
  // handler, exactly like the Inbox, so nothing runs synchronously here).
  useEffect(() => {
    if (!selectedConversationId) return;
    let cancelled = false;
    conversationService
      .getMessages(selectedConversationId)
      .then((list) => {
        if (!cancelled) setMessages(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setMessagesError(err instanceof Error ? err.message : 'Could not load messages.');
        }
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConversationId]);

  const handleSelectConversation = (conversationId: string) => {
    setMessages([]);
    setMessagesError(null);
    setMessagesLoading(true);
    setSelectedConversationId(conversationId);
  };

  /**
   * Manual fallback of the automatic extraction: read the contact's most recent
   * messages, let the AI map them onto the CRM fields and write the result into
   * the CRM record. A field the conversation does not provide stays unchanged —
   * the AI only reports values it can back with a specific message.
   */
  const handleExtractCrmData = async () => {
    if (!contact || extracting) return;
    setExtracting(true);
    setExtractError(null);
    setExtractNotice(null);

    try {
      // Source messages: the open conversation when one is selected, otherwise
      // the first conversations that actually contain messages.
      let source: Message[] = messages;
      if (source.length === 0) {
        for (const conversation of conversations.slice(0, 3)) {
          const list = await conversationService.getMessages(conversation.id);
          if (list.length > 0) {
            source = list;
            break;
          }
        }
      }
      if (source.length === 0) {
        throw new Error('No messages found for this contact yet.');
      }

      const result = await crmFieldService.extractContactCrmFields({
        contact,
        customFields,
        messages: source,
        existingValues: customValues,
      });

      // Refresh the CRM record in place — no page reload needed.
      const [freshContact, freshValues] = await Promise.all([
        contactService.getContactById(contact.id),
        crmFieldService.getContactCustomValues(contact.id),
      ]);
      if (freshContact) setContact(freshContact);
      setCustomValues(freshValues);

      const written = [...result.appliedCustomFields, ...result.appliedContactFields];
      const notes: string[] = [
        written.length > 0
          ? `CRM updated: ${written.join(', ')}.`
          : 'No new CRM values found in this conversation.',
      ];
      if (result.skipped.length > 0) {
        notes.push(`Left unchanged: ${result.skipped.join('; ')}.`);
      }
      setExtractNotice(notes.join(' '));
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'CRM extraction failed.');
    } finally {
      setExtracting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading contact…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">Failed to load contact</h1>
        <p className="text-sm text-destructive mb-4">{error}</p>
        <button
          onClick={() => navigate(-1)}
          className="text-primary font-medium text-sm hover:underline"
        >
          ← Back
        </button>
      </div>
    );
  }

  // A deleted contact and a contact of another organization are reported the
  // same way on purpose: the UI never leaks whether the row exists.
  if (!contact) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">Contact not found</h1>
        <p className="text-sm text-muted-foreground mb-4">
          This contact does not exist or is not available.
        </p>
        <button
          onClick={() => navigate(-1)}
          className="text-primary font-medium text-sm hover:underline"
        >
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="p-6">
      <button
        onClick={() => navigate(-1)}
        className="text-primary font-medium text-sm hover:underline mb-4"
      >
        ← Back
      </button>

      {/* Header: identity + CRM state (real values coming from the database) */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{contact.name}</h1>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {contact.source && (
            <span className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium">
              {contact.source}
            </span>
          )}
          <span
            className={`px-2 py-1 rounded-full text-xs font-medium ${
              leadStatusClasses[contact.lead_status] ?? 'bg-secondary text-secondary-foreground'
            }`}
          >
            {contact.lead_status}
          </span>
          <span
            className={`px-2 py-1 rounded-full text-xs font-medium ${
              customerStatusClasses[contact.customer_status] ??
              'bg-secondary text-secondary-foreground'
            }`}
          >
            {contact.customer_status}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Contact information — confirmed data only */}
        <Card>
          <CardContent className="p-6">
            <h2 className="font-semibold mb-4">Contact Information</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <DetailRow label="Phone" value={textOrDash(contact.phone)} />
              <DetailRow label="Email" value={textOrDash(contact.email)} />
              <DetailRow label="Company" value={textOrDash(contact.company)} />
              <DetailRow label="City" value={textOrDash(contact.city)} />
              <DetailRow label="Wilaya" value={textOrDash(contact.wilaya)} />
              <DetailRow label="Country" value={textOrDash(contact.country)} />
              <DetailRow label="Location" value={formatLocation(contact.city, contact.wilaya)} />
              <DetailRow label="Created" value={formatDate(contact.created_at)} />
              <DetailRow
                label="Tags"
                value={contact.tags.length > 0 ? contact.tags.join(', ') : '—'}
              />
              <DetailRow label="Notes" value={textOrDash(contact.notes)} />
            </div>
          </CardContent>
        </Card>

        {/* Channels — the username comes from contact_channels, never guessed */}
        <Card>
          <CardContent className="p-6">
            <h2 className="font-semibold mb-4">Channels</h2>

            {channelsError && (
              <p className="text-sm text-destructive mb-3">
                Could not load channels: {channelsError}
              </p>
            )}

            {channels.length === 0 && !channelsError && (
              <p className="text-sm text-muted-foreground">No channels linked to this contact.</p>
            )}

            <ul className="space-y-3">
              {channels.map((channel) => (
                <li key={channel.id} className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`px-2 py-1 rounded-md text-xs font-medium ${
                      channelBadgeClasses[channel.channel] ??
                      'bg-secondary text-secondary-foreground'
                    }`}
                  >
                    {channel.channel}
                  </span>
                  <span className="text-sm">{channel.username ? `@${channel.username}` : '—'}</span>
                  <span className="text-xs text-muted-foreground">
                    added {formatDate(channel.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* CRM data — the fields the organization defined, filled by the AI from
          the conversation. This is where the user reads the customer
          information; the messages further down are the supporting source. */}
      <Card className="mb-6">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <h2 className="font-semibold">CRM Data</h2>
            <button
              type="button"
              onClick={handleExtractCrmData}
              disabled={extracting}
              title="Incoming messages are processed automatically. Use this to extract the CRM fields from this conversation again."
              className="inline-flex items-center h-9 px-4 rounded-md border text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {extracting ? 'Extracting CRM data...' : 'Extract CRM data with AI'}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Values are extracted from incoming messages into the fields defined in AI
            Configuration. A field the conversation does not mention stays empty — nothing is
            guessed or overwritten.
          </p>

          {extractError && <p className="text-sm text-destructive mb-3">{extractError}</p>}
          {extractNotice && <p className="text-sm text-muted-foreground mb-3">{extractNotice}</p>}

          {customFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No CRM fields defined yet. Add them under AI Configuration &gt; Custom Fields.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {customFields.map((field) => (
                <DetailRow
                  key={field.id}
                  label={field.field_label}
                  value={formatCustomValue(customValues?.[field.field_name])}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Conversations — a plain list on purpose: a contact can have several
          conversations (there is no unique constraint on contact_id). */}
      <Card className="mb-6">
        <CardContent className="p-6">
          <h2 className="font-semibold mb-4">Conversations</h2>

          {conversationsError && (
            <p className="text-sm text-destructive mb-3">
              Could not load conversations: {conversationsError}
            </p>
          )}

          {conversations.length === 0 && !conversationsError && (
            <p className="text-sm text-muted-foreground">
              No conversations with this contact yet.
            </p>
          )}

          <ul className="space-y-2">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  onClick={() => handleSelectConversation(conversation.id)}
                  className={`w-full text-left px-4 py-3 rounded-md border transition-colors ${
                    selectedConversationId === conversation.id
                      ? 'border-primary bg-muted'
                      : 'border-transparent hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`px-2 py-1 rounded-md text-xs font-medium ${
                        channelBadgeClasses[conversation.channel] ??
                        'bg-secondary text-secondary-foreground'
                      }`}
                    >
                      {conversation.channel}
                    </span>
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${
                        conversationStatusClasses[conversation.status] ??
                        'bg-secondary text-secondary-foreground'
                      }`}
                    >
                      {conversation.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {conversation.last_message_at
                      ? `Last message ${formatDateTime(conversation.last_message_at)}`
                      : 'No messages yet'}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Messages of the selected conversation — read only, no composer, and
          `raw_data` is never requested nor displayed. */}
      {selectedConversationId && (
        <Card>
          <CardContent className="p-6">
            <h2 className="font-semibold mb-4">Messages</h2>

            {messagesLoading && (
              <p className="text-sm text-muted-foreground">Loading messages…</p>
            )}

            {!messagesLoading && messagesError && (
              <p className="text-sm text-destructive">Could not load messages: {messagesError}</p>
            )}

            {!messagesLoading && !messagesError && messages.length === 0 && (
              <p className="text-sm text-muted-foreground">No messages in this conversation.</p>
            )}

            <ul className="space-y-3">
              {messages.map((message) => {
                const attachmentTypes = attachmentTypesOf(message.attachments);
                return (
                  <li key={message.id} className="border rounded-md p-4">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          message.direction === 'outbound'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {message.direction ?? 'inbound'}
                      </span>
                      <span className="text-xs text-muted-foreground">{message.message_type}</span>
                      {message.channel && (
                        <span className="text-xs text-muted-foreground">{message.channel}</span>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {formatDateTime(message.created_at)}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {textOrDash(message.message_text)}
                    </p>
                    {attachmentTypes.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Attachments: {attachmentTypes.join(', ')}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
