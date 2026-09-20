import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { conversationService } from '@/services/conversationService';
import { Conversation, Message } from '@/types';

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

/** Preview for the conversations list (raw data only — no AI, no analysis). */
function previewOf(conversation: Conversation): string {
  const messages = conversation.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) return 'No messages yet';
  return last.message_text ?? `[${last.message_type}]`;
}

const channelBadgeClasses: Record<string, string> = {
  instagram: 'bg-pink-100 text-pink-800',
  facebook: 'bg-blue-100 text-blue-800',
  whatsapp: 'bg-green-100 text-green-800',
};

export default function Inbox() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  // Initial load (effect): every setState lives in the promise chain —
  // nothing runs synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    conversationService
      .getConversations()
      .then((list) => {
        if (!cancelled) setConversations(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load conversations.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Manual refresh (event handler — synchronous setState is allowed here).
  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    conversationService
      .getConversations()
      .then((list) => setConversations(list))
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Could not load conversations.')
      )
      .finally(() => setLoading(false));
  };

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  // Loading state is set by handleSelect (event handler) and cleared in the
  // promise chain — no synchronous setState inside the effect body.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    conversationService
      .getMessages(selectedId)
      .then((list) => {
        if (!cancelled) setMessages(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load messages.');
        }
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleSelect = (id: string) => {
    setMessages([]);
    setMessagesLoading(true);
    setSelectedId(id);
  };

  return (
    <div className="flex h-full">
      {/* Column 1: Conversations List (real data, RLS-scoped to the user's organization) */}
      <div className="w-80 border-r bg-card flex flex-col">
        <div className="p-4 border-b flex items-center gap-2">
          <input
            type="text"
            placeholder="Search conversations..."
            className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          />
          <button
            onClick={handleRefresh}
            title="Refresh"
            className="h-9 w-9 shrink-0 flex items-center justify-center rounded-md border border-input hover:bg-accent"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {loading ? (
            <p className="p-3 text-xs text-muted-foreground">Loading conversations…</p>
          ) : error ? (
            <p className="p-3 text-xs text-destructive">{error}</p>
          ) : conversations.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No conversations yet — incoming Instagram DMs will appear here.
            </p>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                onClick={() => handleSelect(conversation.id)}
                className={`w-full text-left p-3 mb-2 rounded-lg cursor-pointer border ${
                  conversation.id === selectedId
                    ? 'bg-accent text-accent-foreground border-input'
                    : 'hover:bg-accent hover:text-accent-foreground border-transparent'
                }`}
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="font-semibold text-sm truncate">
                    {conversation.contact?.name ?? 'Unknown contact'}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">
                    {formatTime(conversation.last_message_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {previewOf(conversation)}
                </p>
                <span
                  className={`mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    channelBadgeClasses[conversation.channel] ??
                    'bg-secondary text-secondary-foreground'
                  }`}
                >
                  {conversation.channel}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Column 2: Chat Thread (real messages from the database) */}
      <div className="flex-1 flex flex-col bg-background">
        <div className="h-16 border-b flex items-center px-6 bg-card shrink-0">
          <h2 className="font-semibold">
            {selected?.contact?.name ?? 'Select a conversation'}
          </h2>
          {selected && (
            <span
              className={`ml-3 px-2 py-0.5 rounded-full text-xs font-medium ${
                channelBadgeClasses[selected.channel] ??
                'bg-secondary text-secondary-foreground'
              }`}
            >
              {selected.channel}
            </span>
          )}
        </div>
        <div className="flex-1 p-6 overflow-auto">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Select a conversation to view its messages.
            </p>
          ) : messagesLoading ? (
            <p className="text-sm text-muted-foreground">Loading messages…</p>
          ) : messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No messages in this conversation yet.
            </p>
          ) : (
            <div className="flex flex-col space-y-4">
              {messages.map((message) => (
                <div key={message.id} className="flex items-start">
                  <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center mr-3 shrink-0 text-xs font-medium">
                    {(message.sender_external_id?.slice(-2) ?? '??').toUpperCase()}
                  </div>
                  <div>
                    <div className="bg-muted p-3 rounded-2xl rounded-tl-sm text-sm max-w-md break-words">
                      {message.message_text ?? `[${message.message_type}]`}
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {formatDate(message.created_at)} · inbound · {message.message_type}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="p-4 border-t bg-card shrink-0">
          <div className="flex gap-2">
            <input
              type="text"
              disabled
              placeholder="Outbound replies are not available yet (Phase 2)."
              className="flex-1 h-10 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm opacity-60"
            />
            <button
              disabled
              className="h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Column 3: Context panel (raw facts only — no AI analysis in Phase 1) */}
      <div className="w-80 border-l bg-card flex flex-col overflow-auto">
        {selected ? (
          <>
            <div className="p-6 border-b">
              <div className="flex flex-col items-center mb-4">
                <div className="w-20 h-20 rounded-full bg-accent flex items-center justify-center text-2xl mb-3">
                  {(selected.contact?.name ?? '?').slice(0, 2).toUpperCase()}
                </div>
                <h3 className="font-semibold text-lg text-center">
                  {selected.contact?.name ?? 'Unknown contact'}
                </h3>
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                <span
                  className={`px-2 py-1 rounded-md text-xs font-medium ${
                    channelBadgeClasses[selected.channel] ??
                    'bg-secondary text-secondary-foreground'
                  }`}
                >
                  {selected.channel}
                </span>
                <span className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium">
                  {selected.status}
                </span>
              </div>
            </div>
            <div className="p-6 space-y-3 text-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                  Contact ID
                </p>
                <p className="text-xs break-all">{selected.contact_id}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                  Conversation created
                </p>
                <p className="text-xs">{formatDate(selected.created_at)}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                  Last activity
                </p>
                <p className="text-xs">{formatDate(selected.last_message_at)}</p>
              </div>
              <p className="text-xs text-muted-foreground pt-2 border-t">
                Inbox Phase 1: inbound messages only. Outbound replies and AI features are not
                included in this phase.
              </p>
            </div>
          </>
        ) : (
          <div className="p-6 flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm text-center">
              Select a conversation to see contact details.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

