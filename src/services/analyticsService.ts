import { supabase } from '@/utils/supabase';
import { organizationService } from '@/services/organizationService';
import {
  ContactCustomValues,
  CrmCustomField,
  CustomFieldType,
  CustomerStatus,
  LeadStatus,
} from '@/types';

/**
 * Analytics for the Social CRM — every number returned here comes from
 * Supabase rows for the signed-in user's organization. No mock, no sample
 * dataset, no stored aggregate table.
 *
 * Multi-tenancy: the organization id is resolved server-side-side from
 * `organization_members` (organizationService) and never accepted from the
 * caller, so a component can never ask for another tenant's data. RLS is the
 * second line of defence and is left untouched.
 *
 * Performance contract:
 *  - scalar KPI counts use PostgREST `head: true` COUNT queries: Postgres
 *    computes them and no rows cross the wire;
 *  - the only row-transferring queries select the handful of columns the
 *    aggregation actually needs (never `select *`);
 *  - every row-transferring query is paginated, because PostgREST silently
 *    caps a response at 1000 rows — without the loop every aggregate would be
 *    quietly wrong as soon as a period holds more than 1000 rows.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AnalyticsRangePreset = 'today' | '7d' | '30d' | '90d' | 'custom';

/** What the date-range selector produces. */
export interface AnalyticsRangeInput {
  preset: AnalyticsRangePreset;
  /** `yyyy-mm-dd`, read only when preset === 'custom'. */
  from?: string;
  /** `yyyy-mm-dd` (inclusive), read only when preset === 'custom'. */
  to?: string;
}

/** A half-open interval: `from` inclusive, `to` exclusive. */
export interface ResolvedPeriod {
  from: Date;
  to: Date;
}

/**
 * A period-scoped KPI plus its previous-period comparison.
 *
 * `previous` is null when the comparison cannot be computed, and `changePct`
 * is null when the previous value is 0 — a change from zero is not a
 * meaningful percentage, so the UI omits it rather than showing infinity.
 */
export interface KpiValue {
  current: number;
  previous: number | null;
  changePct: number | null;
}

/**
 * Current-state counters. These describe the CRM *now* (a status is not a
 * period-scoped fact), so they carry no period comparison.
 */
export interface CurrentCounters {
  leads: number;
  qualifiedLeads: number;
  customers: number;
  totalContacts: number;
}

export interface AnalyticsOverview {
  messages: KpiValue;
  conversations: KpiValue;
  newContacts: KpiValue;
  current: CurrentCounters;
}

/** One day of the "Messages over time" series. */
export interface MessageSeriesPoint {
  /** Local day, `yyyy-mm-dd`. */
  date: string;
  inbound: number;
  outbound: number;
  total: number;
}

/** One row of "Messages by channel" / "Conversations by channel". */
export interface ChannelBreakdown {
  channel: string;
  label: string;
  messages: number;
  /** Distinct conversations that had activity on this channel in the period. */
  conversations: number;
  /** Share of the period's messages, 0-100. */
  messageSharePct: number;
}

export interface StatusCount {
  status: string;
  label: string;
  count: number;
}

export interface StatusFunnel {
  leadStatus: StatusCount[];
  customerStatus: StatusCount[];
}

/** How many contacts hold a non-empty value for one dynamic CRM field. */
export interface CrmFieldPopulation {
  field_name: string;
  field_label: string;
  field_type: CustomFieldType;
  filledCount: number;
  /** Share of the organization's contacts, 0-100. */
  filledSharePct: number;
}

/** Most common values inside one `select` CRM field. */
export interface CrmSelectFieldValues {
  field_name: string;
  field_label: string;
  topValues: { value: string; count: number }[];
  /** Contacts holding any value for this field. */
  filledCount: number;
}

/** One entry of "Top locations". */
export interface TopLocation {
  location: string;
  /** Which contact column the value came from. */
  kind: 'wilaya' | 'city';
  count: number;
}

export type ActivityKind = 'contact' | 'conversation' | 'message' | 'crm_update';

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  /** Short kind label, e.g. "New contact". */
  kindLabel: string;
  /** Human-readable subject (contact name, channel, ...). */
  subject: string;
  at: string;
}

export interface AnalyticsData {
  /** The resolved period actually queried, echoed for the UI. */
  periodLabel: string;
  /** Inclusive ISO bounds of the selected period. */
  periodFrom: string;
  periodTo: string;
  overview: AnalyticsOverview;
  messagesOverTime: MessageSeriesPoint[];
  channels: ChannelBreakdown[];
  funnel: StatusFunnel;
  /** Ranked by filledCount, empty values excluded. */
  crmFieldPopulation: CrmFieldPopulation[];
  /** Only `select` fields that actually hold values. */
  crmSelectValues: CrmSelectFieldValues[];
  topLocations: TopLocation[];
  recentActivity: ActivityEntry[];
}

// ---------------------------------------------------------------------------
// Reference data — mirrors the DB CHECK constraints. Nothing is invented here.
// ---------------------------------------------------------------------------

/** Display order of contacts.lead_status. */
export const LEAD_STATUS_ORDER: readonly LeadStatus[] = [
  'new',
  'contacted',
  'qualified',
  'won',
  'lost',
];

/** Display order of contacts.customer_status. */
export const CUSTOMER_STATUS_ORDER: readonly CustomerStatus[] = [
  'prospect',
  'active',
  'inactive',
  'blocked',
];

const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  won: 'Won',
  lost: 'Lost',
};

const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  prospect: 'Prospect',
  active: 'Active',
  inactive: 'Inactive',
  blocked: 'Blocked',
};

/**
 * A contact still in the pipeline: created, being worked, or qualified.
 * 'won' contacts are counted as customers and 'lost' contacts left the
 * pipeline — the same split the Leads page uses
 * (contactService.OPEN_LEAD_STATUSES).
 */
const OPEN_LEAD_STATUSES: readonly LeadStatus[] = ['new', 'contacted', 'qualified'];

const CHANNEL_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  // `messages.channel` is nullable; rows saved before the channel backfill
  // have no value. Labelled explicitly instead of being hidden.
  unknown: 'Unknown',
};

/** Human label for a channel value read from the database. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

const STATUS_LABELS: Record<string, string> = {
  ...LEAD_STATUS_LABELS,
  ...CUSTOMER_STATUS_LABELS,
};

/** Human label for any lead/customer status value. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** `yyyy-mm-dd` for a date in the browser's local timezone. */
export function toDayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parses the `yyyy-mm-dd` emitted by an `<input type="date">` as a LOCAL day. */
function parseDayKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDay(date: Date): string {
  const day = `${date.getDate()}`.padStart(2, '0');
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

/**
 * Turns the selector state into real query bounds.
 *
 * Presets end at `now`: a period still being lived must not be rounded up to
 * midnight, which would count days that have not happened. Their start is
 * day-aligned so the chart buckets line up with calendar days.
 *
 * `custom` covers whole days — the end date the user picked is INCLUDED.
 */
export function resolvePeriod(
  input: AnalyticsRangeInput,
  now: Date = new Date(),
): ResolvedPeriod {
  if (input.preset === 'custom') {
    const from = input.from ? parseDayKey(input.from) : null;
    const to = input.to ? parseDayKey(input.to) : null;
    if (from && to && to >= from) {
      return { from: startOfDay(from), to: addDays(startOfDay(to), 1) };
    }
    // An incomplete or backwards custom range falls back to the default period
    // rather than throwing, so the dashboard stays usable while the user types.
  }

  const days =
    input.preset === 'today' ? 1 : input.preset === '90d' ? 90 : input.preset === '7d' ? 7 : 30;
  return { from: addDays(startOfDay(now), -(days - 1)), to: now };
}

/**
 * The immediately preceding window of the SAME length.
 *
 * Identical duration is what makes the comparison fair: for 'today' it means
 * "yesterday up to the same time", not all of yesterday.
 */
export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod {
  const duration = period.to.getTime() - period.from.getTime();
  return {
    from: new Date(period.from.getTime() - duration),
    to: new Date(period.from.getTime()),
  };
}

/** Human label of the resolved period, used as the dashboard subtitle. */
export function describePeriod(
  period: ResolvedPeriod,
  preset: AnalyticsRangePreset,
): string {
  if (preset === 'today') return 'Today';
  if (preset === '7d') return 'Last 7 days';
  if (preset === '30d') return 'Last 30 days';
  if (preset === '90d') return 'Last 90 days';
  return `${formatDay(period.from)} - ${formatDay(new Date(period.to.getTime() - 1))}`;
}


// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** PostgREST's hard cap on the rows a single request can return. */
const PAGE_SIZE = 1000;

/**
 * Upper bound on pages per dataset (20 x 1000 rows). Keeps the worst case
 * bounded so a very large organization can never hang the dashboard.
 */
const MAX_PAGES = 20;

/** Recent-activity feeds are tiny by design. */
const ACTIVITY_LIMIT = 5;

interface PageResult {
  data: unknown;
  error: { message: string } | null;
}

interface CountResult {
  count: number | null;
  error: { message: string } | null;
}

type Row = Record<string, unknown>;

/**
 * Reads every row matching a query, one page at a time.
 *
 * The loop is required for CORRECTNESS, not speed: PostgREST silently
 * truncates a response at 1000 rows, so a single `.select()` would under-count
 * every aggregate above that threshold without ever raising an error.
 */
async function fetchAllPages(
  runPage: (offset: number, limit: number) => PromiseLike<PageResult>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const { data, error } = await runPage(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = Array.isArray(data) ? (data as Row[]) : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Reads a bounded result set (used for the `limit()`-ed activity feeds). */
async function fetchRows(build: () => PromiseLike<PageResult>): Promise<Row[]> {
  const { data, error } = await build();
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** Runs an exact COUNT query server-side — no rows are transferred. */
async function countRows(build: () => PromiseLike<CountResult>): Promise<number> {
  const { count, error } = await build();
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Reads a nullable `text` column defensively. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A CRM value counts as filled when it holds something other than null, an
 * empty string or whitespace. `0` and `false` are real answers, so they count.
 */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** Rounds to one decimal — the precision the KPI cards display. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Period-over-period change in percent.
 *
 * `changePct` is null when the comparison is not meaningful: no previous
 * period, or a previous value of 0 (a change from zero has no percentage, and
 * showing "infinite%" or a fake 100% would be inventing data).
 */
function buildKpi(current: number, previous: number | null): KpiValue {
  if (previous === null || previous === 0) {
    return { current, previous: previous ?? null, changePct: null };
  }
  return {
    current,
    previous,
    changePct: round1(((current - previous) / previous) * 100),
  };
}


// ---------------------------------------------------------------------------
// Dataset loaders — one query per dataset, minimal columns only
// ---------------------------------------------------------------------------

/**
 * Messages of a period, with just the four columns the aggregation needs: the
 * day bucket, the direction split, the channel split and the conversation
 * identity. `message_text` and `raw_data` are never downloaded.
 */
async function loadMessageRows(orgId: string, period: ResolvedPeriod): Promise<Row[]> {
  return fetchAllPages((offset, limit) =>
    supabase
      .from('messages')
      .select('created_at, direction, channel, conversation_id')
      .eq('organization_id', orgId)
      .gte('created_at', period.from.toISOString())
      .lt('created_at', period.to.toISOString())
      .order('created_at', { ascending: true })
      .range(offset, limit),
  );
}

/**
 * Only the conversation ids of a period.
 *
 * Conversations that "had activity" are the distinct conversation_ids among
 * the period's messages. `conversations.last_message_at` cannot be used
 * instead: it holds the LATEST activity ever, so a past period would miss every
 * conversation that is still active today.
 */
async function loadConversationIds(orgId: string, period: ResolvedPeriod): Promise<Row[]> {
  return fetchAllPages((offset, limit) =>
    supabase
      .from('messages')
      .select('conversation_id')
      .eq('organization_id', orgId)
      .gte('created_at', period.from.toISOString())
      .lt('created_at', period.to.toISOString())
      .range(offset, limit),
  );
}

/**
 * Contact columns needed for the funnel, the current-state counters and the
 * location breakdown. `city` and `wilaya` are the only location sources.
 */
async function loadContactRows(orgId: string): Promise<Row[]> {
  return fetchAllPages((offset, limit) =>
    supabase
      .from('contacts')
      .select('lead_status, customer_status, city, wilaya, created_at')
      .eq('organization_id', orgId)
      .range(offset, limit),
  );
}

/** The organization's dynamic CRM schema. */
async function loadCustomFields(orgId: string): Promise<CrmCustomField[]> {
  const { data, error } = await supabase
    .from('crm_custom_fields')
    .select(
      'id, organization_id, field_name, field_label, field_type, options, description_for_ai, created_at',
    )
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CrmCustomField[];
}

/** One row per contact holding custom values — the jsonb is the only source. */
async function loadCustomValueRows(orgId: string): Promise<Row[]> {
  return fetchAllPages((offset, limit) =>
    supabase
      .from('contact_custom_values')
      .select('contact_id, values')
      .eq('organization_id', orgId)
      .range(offset, limit),
  );
}

/** Reads a to-one embedded `contacts(name)` value defensively. */
function embeddedContactName(value: unknown): string {
  const record = Array.isArray(value) ? value[0] : value;
  if (record && typeof record === 'object') {
    return text((record as Row)['name']);
  }
  return '';
}

/**
 * Recent events, assembled from four bounded reads (5 rows each) rather than by
 * scanning history. Sorted newest first by the real timestamp of each event.
 */
async function loadRecentActivity(orgId: string): Promise<ActivityEntry[]> {
  const [contactRows, conversationRows, messageRows, crmRows] = await Promise.all([
    fetchRows(() =>
      supabase
        .from('contacts')
        .select('id, name, created_at')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(ACTIVITY_LIMIT),
    ),
    fetchRows(() =>
      supabase
        .from('conversations')
        .select('id, channel, created_at, contact:contacts(name)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(ACTIVITY_LIMIT),
    ),
    fetchRows(() =>
      supabase
        .from('messages')
        .select('id, channel, created_at')
        .eq('organization_id', orgId)
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false })
        .limit(ACTIVITY_LIMIT),
    ),
    fetchRows(() =>
      supabase
        .from('contact_custom_values')
        .select('contact_id, updated_at, contact:contacts(name)')
        .eq('organization_id', orgId)
        .order('updated_at', { ascending: false })
        .limit(ACTIVITY_LIMIT),
    ),
  ]);

  const entries: ActivityEntry[] = [];

  for (const row of contactRows) {
    entries.push({
      id: `contact:${String(row['id'] ?? '')}`,
      kind: 'contact',
      kindLabel: 'New contact',
      subject: text(row['name']) || 'Unnamed contact',
      at: String(row['created_at'] ?? ''),
    });
  }

  for (const row of conversationRows) {
    const channel = text(row['channel']);
    entries.push({
      id: `conversation:${String(row['id'] ?? '')}`,
      kind: 'conversation',
      kindLabel: 'New conversation',
      subject: embeddedContactName(row['contact']) || channelLabel(channel),
      at: String(row['created_at'] ?? ''),
    });
  }

  for (const row of messageRows) {
    entries.push({
      id: `message:${String(row['id'] ?? '')}`,
      kind: 'message',
      kindLabel: 'Incoming message',
      subject: channelLabel(text(row['channel'])),
      at: String(row['created_at'] ?? ''),
    });
  }

  for (const row of crmRows) {
    entries.push({
      id: `crm:${String(row['contact_id'] ?? '')}`,
      kind: 'crm_update',
      kindLabel: 'CRM fields updated',
      subject: embeddedContactName(row['contact']) || 'Contact',
      at: String(row['updated_at'] ?? ''),
    });
  }

  return entries
    .filter((entry) => entry.at.length > 0)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, ACTIVITY_LIMIT * 2);
}


// ---------------------------------------------------------------------------
// Aggregation — pure functions over the rows loaded above
// ---------------------------------------------------------------------------

/** Reads the `contact_custom_values.values` jsonb defensively. */
function readValues(value: unknown): ContactCustomValues {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ContactCustomValues;
  }
  return {};
}

/**
 * Buckets the period's messages by local calendar day.
 *
 * Every day of the period is seeded with 0 first: a day with no messages has a
 * real count of zero, so filling the gap states a fact rather than inventing
 * one. Messages outside the seed window (a very long custom range) are still
 * counted, so no activity is ever silently dropped.
 */
function buildMessageSeries(rows: readonly Row[], period: ResolvedPeriod): MessageSeriesPoint[] {
  const buckets = new Map<string, MessageSeriesPoint>();

  // Caps how many zero-days are seeded, so a decade-long custom range cannot
  // produce an unrenderable chart.
  const MAX_SEEDED_DAYS = 400;
  const lastDay = startOfDay(new Date(period.to.getTime() - 1));
  let cursor = startOfDay(period.from);
  let seeded = 0;
  while (cursor <= lastDay && seeded < MAX_SEEDED_DAYS) {
    const key = toDayKey(cursor);
    buckets.set(key, { date: key, inbound: 0, outbound: 0, total: 0 });
    cursor = addDays(cursor, 1);
    seeded += 1;
  }

  for (const row of rows) {
    const createdAt = Date.parse(String(row['created_at'] ?? ''));
    if (Number.isNaN(createdAt)) continue;
    const key = toDayKey(new Date(createdAt));

    const bucket =
      buckets.get(key) ?? { date: key, inbound: 0, outbound: 0, total: 0 };
    // `direction` defaults to 'inbound' in the database, so anything that is
    // not explicitly outbound is counted as inbound and the parts always sum to
    // the total.
    if (text(row['direction']) === 'outbound') {
      bucket.outbound += 1;
    } else {
      bucket.inbound += 1;
    }
    bucket.total += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Messages per channel, plus the number of DISTINCT conversations active on
 * each — a conversation count, never the message count.
 */
function buildChannelBreakdown(rows: readonly Row[]): ChannelBreakdown[] {
  const acc = new Map<string, { messages: number; conversations: Set<string> }>();

  for (const row of rows) {
    const channel = text(row['channel']) || 'unknown';
    const entry = acc.get(channel) ?? { messages: 0, conversations: new Set<string>() };
    entry.messages += 1;
    const conversationId = text(row['conversation_id']);
    if (conversationId) entry.conversations.add(conversationId);
    acc.set(channel, entry);
  }

  const total = rows.length;
  return [...acc.entries()]
    .map(([channel, entry]) => ({
      channel,
      label: channelLabel(channel),
      messages: entry.messages,
      conversations: entry.conversations.size,
      messageSharePct: total > 0 ? round1((entry.messages / total) * 100) : 0,
    }))
    .sort((a, b) => b.messages - a.messages);
}

/**
 * Counts rows per status value.
 *
 * The canonical statuses are always returned (a status nobody is in has a real
 * count of 0). Any unexpected value the database happens to hold is appended
 * instead of being hidden, so the numbers always sum to the true total.
 */
function countStatuses(
  rows: readonly Row[],
  column: string,
  order: readonly string[],
): StatusCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const status = text(row[column]);
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const known: StatusCount[] = order.map((status) => ({
    status,
    label: statusLabel(status),
    count: counts.get(status) ?? 0,
  }));
  const unexpected: StatusCount[] = [...counts.keys()]
    .filter((status) => !order.includes(status))
    .sort()
    .map((status) => ({ status, label: statusLabel(status), count: counts.get(status) ?? 0 }));

  return [...known, ...unexpected];
}


/**
 * How many contacts hold a non-empty value for each DYNAMIC CRM field.
 *
 * The field list is read from `crm_custom_fields`, never hardcoded, so a
 * column the organization adds or removes appears or disappears on its own.
 * Empty values are excluded — a blank field is not information.
 */
function buildCrmFieldPopulation(
  fields: readonly CrmCustomField[],
  valueRows: readonly Row[],
  totalContacts: number,
): CrmFieldPopulation[] {
  const parsed = valueRows.map((row) => readValues(row['values']));

  return fields
    .map((field) => {
      let filledCount = 0;
      for (const values of parsed) {
        if (hasValue(values[field.field_name])) filledCount += 1;
      }
      return {
        field_name: field.field_name,
        field_label: field.field_label,
        field_type: field.field_type,
        filledCount,
        filledSharePct: totalContacts > 0 ? round1((filledCount / totalContacts) * 100) : 0,
      };
    })
    .filter((entry) => entry.filledCount > 0)
    .sort((a, b) => b.filledCount - a.filledCount);
}

/**
 * Most common values inside each `select` CRM field.
 *
 * Restricted to `select` fields on purpose: their values come from a
 * controlled option list, so counting them is meaningful. Free-text answers are
 * never grouped — clustering arbitrary text would mean inventing categories.
 */
function buildCrmSelectValues(
  fields: readonly CrmCustomField[],
  valueRows: readonly Row[],
): CrmSelectFieldValues[] {
  const parsed = valueRows.map((row) => readValues(row['values']));
  const TOP_VALUES_PER_FIELD = 5;

  return fields
    .filter((field) => field.field_type === 'select')
    .map((field) => {
      // Option labels, so a stored value is displayed with the organization's
      // own casing even when the AI stored it differently.
      const canonical = new Map<string, string>();
      for (const option of field.options ?? []) {
        canonical.set(option.trim().toLowerCase(), option.trim());
      }

      const counts = new Map<string, { value: string; count: number }>();
      let filledCount = 0;

      for (const values of parsed) {
        const raw = values[field.field_name];
        if (!hasValue(raw)) continue;
        filledCount += 1;

        const label = String(raw).trim();
        // Case-insensitive grouping: "Golf" and "golf" are one answer.
        const key = label.toLowerCase();
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(key, { value: canonical.get(key) ?? label, count: 1 });
        }
      }

      const topValues = [...counts.values()]
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, TOP_VALUES_PER_FIELD);

      return {
        field_name: field.field_name,
        field_label: field.field_label,
        topValues,
        filledCount,
      };
    })
    .filter((entry) => entry.topValues.length > 0)
    .sort((a, b) => b.filledCount - a.filledCount);
}

/**
 * Where the contacts that entered the CRM during the period are located.
 *
 * Each contact contributes exactly one location: its wilaya (the broader
 * province) when set, otherwise its city. Contacts with neither are simply
 * absent, and the caller shows an empty state rather than a guess.
 */
function buildTopLocations(
  rows: readonly Row[],
  period: ResolvedPeriod,
): TopLocation[] {
  const fromMs = period.from.getTime();
  const toMs = period.to.getTime();
  const acc = new Map<string, TopLocation>();

  for (const row of rows) {
    const createdAt = Date.parse(String(row['created_at'] ?? ''));
    if (Number.isNaN(createdAt) || createdAt < fromMs || createdAt >= toMs) continue;

    const wilaya = text(row['wilaya']);
    const city = text(row['city']);
    const location = wilaya || city;
    if (!location) continue;
    const kind: 'wilaya' | 'city' = wilaya ? 'wilaya' : 'city';

    const key = `${kind}:${location.toLowerCase()}`;
    const existing = acc.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      acc.set(key, { location, kind, count: 1 });
    }
  }

  return [...acc.values()]
    .sort((a, b) => b.count - a.count || a.location.localeCompare(b.location))
    .slice(0, 8);
}


// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const analyticsService = {
  /**
   * Every number the Analytics dashboard shows, for one period.
   *
   * The organization is resolved from `organization_members` for the signed-in
   * user and is never taken from the caller, so the page cannot ask for another
   * tenant's data. RLS applies on top of that.
   *
   * The independent datasets are loaded in parallel; a failure in any of them
   * rejects the whole call so the page shows one honest error state instead of
   * a partially populated dashboard.
   */
  async getAnalytics(range: AnalyticsRangeInput): Promise<AnalyticsData> {
    const orgId = await organizationService.getCurrentOrganizationId();

    const period = resolvePeriod(range);
    const previous = previousPeriod(period);

    const fromIso = period.from.toISOString();
    const toIso = period.to.toISOString();
    const prevFromIso = previous.from.toISOString();
    const prevToIso = previous.to.toISOString();

    const [
      messageRows,
      previousConversationRows,
      contactRows,
      customFields,
      customValueRows,
      messagesCurrent,
      messagesPrevious,
      newContactsCurrent,
      newContactsPrevious,
      recentActivity,
    ] = await Promise.all([
      loadMessageRows(orgId, period),
      loadConversationIds(orgId, previous),
      loadContactRows(orgId),
      loadCustomFields(orgId),
      loadCustomValueRows(orgId),
      // Exact COUNT queries: Postgres counts, the browser downloads no rows.
      countRows(() =>
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .gte('created_at', fromIso)
          .lt('created_at', toIso),
      ),
      countRows(() =>
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .gte('created_at', prevFromIso)
          .lt('created_at', prevToIso),
      ),
      countRows(() =>
        supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .gte('created_at', fromIso)
          .lt('created_at', toIso),
      ),
      countRows(() =>
        supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .gte('created_at', prevFromIso)
          .lt('created_at', prevToIso),
      ),
      loadRecentActivity(orgId),
    ]);

    // Conversations are counted as DISTINCT conversation ids among the period's
    // messages — never as a message count.
    const countDistinctConversations = (rows: readonly Row[]): number =>
      new Set(
        rows.map((row) => text(row['conversation_id'])).filter((id) => id.length > 0),
      ).size;

    const funnel: StatusFunnel = {
      leadStatus: countStatuses(contactRows, 'lead_status', LEAD_STATUS_ORDER),
      customerStatus: countStatuses(contactRows, 'customer_status', CUSTOMER_STATUS_ORDER),
    };

    const totalOf = (entries: readonly StatusCount[], statuses: readonly string[]): number =>
      entries
        .filter((entry) => statuses.includes(entry.status))
        .reduce((sum, entry) => sum + entry.count, 0);

    return {
      periodLabel: describePeriod(period, range.preset),
      periodFrom: fromIso,
      periodTo: toIso,
      overview: {
        messages: buildKpi(messagesCurrent, messagesPrevious),
        conversations: buildKpi(
          countDistinctConversations(messageRows),
          countDistinctConversations(previousConversationRows),
        ),
        newContacts: buildKpi(newContactsCurrent, newContactsPrevious),
        current: {
          leads: totalOf(funnel.leadStatus, OPEN_LEAD_STATUSES),
          qualifiedLeads: totalOf(funnel.leadStatus, ['qualified']),
          // A "customer" is a contact whose lead pipeline reached 'won'.
          // Defined once here so the KPI and the funnel can never disagree.
          customers: totalOf(funnel.leadStatus, ['won']),
          totalContacts: contactRows.length,
        },
      },
      messagesOverTime: buildMessageSeries(messageRows, period),
      channels: buildChannelBreakdown(messageRows),
      funnel,
      crmFieldPopulation: buildCrmFieldPopulation(
        customFields,
        customValueRows,
        contactRows.length,
      ),
      crmSelectValues: buildCrmSelectValues(customFields, customValueRows),
      topLocations: buildTopLocations(contactRows, period),
      recentActivity,
    };
  },
};

