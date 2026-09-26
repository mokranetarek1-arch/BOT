/**
 * Service to manage read/unread status of conversations locally per client.
 * Uses localStorage with key `botd_read_state_{convId}` storing the ISO timestamp
 * when the conversation was last read by the user.
 */
const STORAGE_PREFIX = 'botd_read_at_';

export const readStateService = {
  /** Mark conversation as read now */
  markAsRead(conversationId: string, timestampIso?: string): void {
    try {
      const readAt = timestampIso || new Date().toISOString();
      localStorage.setItem(`${STORAGE_PREFIX}${conversationId}`, readAt);
      window.dispatchEvent(new Event('botd-read-state-updated'));
    } catch {
      // localStorage may fail in private mode
    }
  },

  /** Get last read timestamp for conversation */
  getLastReadAt(conversationId: string): string | null {
    try {
      return localStorage.getItem(`${STORAGE_PREFIX}${conversationId}`);
    } catch {
      return null;
    }
  },

  /**
   * Check if a conversation is unread.
   * A conversation is unread if its last_message_at is strictly newer
   * than its stored read timestamp.
   */
  isUnread(conversationId: string, lastMessageAt: string | null | undefined): boolean {
    if (!lastMessageAt) return false;
    const readAt = this.getLastReadAt(conversationId);
    if (!readAt) return true; // Never opened yet
    return new Date(lastMessageAt).getTime() > new Date(readAt).getTime();
  },
};
