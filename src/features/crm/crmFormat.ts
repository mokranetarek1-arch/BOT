/**
 * Presentation helpers shared by the CRM pages (leads / customers / contact
 * details). Formatting and badge class maps ONLY — no database access, no
 * fetching, no business rules.
 */

/** Simple readable date (contacts.created_at, conversations.created_at …). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Date + time — used for last_message_at and message timestamps. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** city + wilaya, skipping missing values (never prints "undefined" / "null"). */
export function formatLocation(city: string | null, wilaya: string | null): string {
  const parts = [city, wilaya].filter((value): value is string => Boolean(value && value.trim()));
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** A nullable text value as-is, with an em dash placeholder when empty. */
export function textOrDash(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

/** Format a Dynamic CRM custom value for display (never prints raw JSON). */
export function formatCustomValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return String(value);
  const trimmed = value.trim();
  return trimmed ? trimmed : '—';
}

/** Badge colours per real lead_status value coming from the database. */
export const leadStatusClasses: Record<string, string> = {
  new: 'bg-yellow-100 text-yellow-800',
  contacted: 'bg-blue-100 text-blue-800',
  qualified: 'bg-indigo-100 text-indigo-800',
  won: 'bg-green-100 text-green-800',
  lost: 'bg-red-100 text-red-800',
};

/** Badge colours per real customer_status value coming from the database. */
export const customerStatusClasses: Record<string, string> = {
  prospect: 'bg-yellow-100 text-yellow-800',
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-gray-100 text-gray-800',
  blocked: 'bg-red-100 text-red-800',
};

/** Badge colours per conversations.status value. */
export const conversationStatusClasses: Record<string, string> = {
  open: 'bg-green-100 text-green-800',
  closed: 'bg-gray-100 text-gray-800',
  snoozed: 'bg-yellow-100 text-yellow-800',
};

/** Channel badge colours (same palette as the Inbox conversation list). */
export const channelBadgeClasses: Record<string, string> = {
  instagram: 'bg-pink-100 text-pink-800',
  facebook: 'bg-blue-100 text-blue-800',
  whatsapp: 'bg-green-100 text-green-800',
};
