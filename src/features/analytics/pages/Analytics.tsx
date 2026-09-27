import { useCallback, useEffect, useState } from 'react';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { KpiCards } from '../components/KpiCards';
import { AnalyticsSection } from '../components/SectionState';
import {
  ChannelBarChart,
  HorizontalBarChart,
  MessagesOverTimeChart,
} from '../components/AnalyticsCharts';
import type { HorizontalBarDatum } from '../components/AnalyticsCharts';
import { toChannelBars } from '../components/chartData';
import { analyticsService } from '@/services/analyticsService';
import type { AnalyticsData, AnalyticsRangeInput } from '@/services/analyticsService';
import { cn } from '@/lib/utils';

/**
 * Analytics — real numbers from Supabase for the signed-in organization.
 *
 * The page only owns the filter state and the loading/error state; every query
 * and every aggregation lives in `analyticsService`. Nothing on this screen is
 * hardcoded and no placeholder remains.
 */

/** Funnel colours: a cool-to-warm ramp for the lead pipeline. */
const LEAD_STATUS_COLORS: Record<string, string> = {
  new: '#94a3b8',
  contacted: '#60a5fa',
  qualified: '#34d399',
  won: '#059669',
  lost: '#f87171',
};

const CUSTOMER_STATUS_COLORS: Record<string, string> = {
  prospect: '#94a3b8',
  active: '#34d399',
  inactive: '#fbbf24',
  blocked: '#f87171',
};

const ACTIVITY_STYLES: Record<string, string> = {
  contact: 'bg-blue-100 text-blue-700',
  conversation: 'bg-violet-100 text-violet-700',
  message: 'bg-emerald-100 text-emerald-700',
  crm_update: 'bg-amber-100 text-amber-700',
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

/** Absolute timestamp of a real event, in local time. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = `${date.getDate()}`.padStart(2, '0');
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()} ${hours}:${minutes}`;
}

/** Result of one request, tagged with the exact request it answers. */
interface LoadResult {
  key: string;
  data?: AnalyticsData;
  error?: string;
}

export default function Analytics() {
  const [range, setRange] = useState<AnalyticsRangeInput>({ preset: '30d' });
  const [reloadToken, setReloadToken] = useState(0);
  const [result, setResult] = useState<LoadResult | null>(null);

  // A custom range is queried only once both dates are present and ordered:
  // querying a half-typed range would fetch a period the user never asked for.
  const customIncomplete =
    range.preset === 'custom' && (!range.from || !range.to || range.to < range.from);

  // Identifies the request the current filter state needs. Comparing this key
  // with the one stored on the last result DERIVES the loading state, so the
  // effect never has to call setState synchronously (which would cascade a
  // re-render on every filter change).
  const requestKey = `${range.preset}|${range.from ?? ''}|${range.to ?? ''}|${reloadToken}`;

  useEffect(() => {
    if (customIncomplete) return;

    let cancelled = false;

    analyticsService
      .getAnalytics(range)
      .then((data) => {
        if (!cancelled) setResult({ key: requestKey, data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({
            key: requestKey,
            error: err instanceof Error ? err.message : 'Could not load analytics.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [range, requestKey, customIncomplete]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  const isCurrent = result?.key === requestKey;
  // While the user is still filling in a custom range nothing is fetched, so the
  // last loaded result simply stays on screen.
  const loading = !customIncomplete && !isCurrent;
  const shown = isCurrent || customIncomplete ? result : null;
  const data = shown?.data ?? null;
  const error = shown?.error ?? null;
  const periodLabel = data?.periodLabel ?? '';
  // Derived views of the payload. Each stays empty while loading or on error,
  // which is exactly what makes every section render its empty/error state.
  const points = data?.messagesOverTime ?? [];
  const channels = data?.channels ?? [];
  const messageTotal = data?.overview.messages.current ?? 0;
  const funnel = data?.funnel ?? null;
  const crmFields = data?.crmFieldPopulation ?? [];
  const crmSelectValues = data?.crmSelectValues ?? [];
  const locations = data?.topLocations ?? [];
  const activity = data?.recentActivity ?? [];

  const leadStatusBars: HorizontalBarDatum[] = (funnel?.leadStatus ?? []).map((entry) => ({
    label: entry.label,
    value: entry.count,
    color: LEAD_STATUS_COLORS[entry.status],
  }));
  const customerStatusBars: HorizontalBarDatum[] = (funnel?.customerStatus ?? []).map(
    (entry) => ({
      label: entry.label,
      value: entry.count,
      color: CUSTOMER_STATUS_COLORS[entry.status],
    }),
  );
  const crmFieldBars: HorizontalBarDatum[] = crmFields.map((entry) => ({
    label: entry.field_label,
    value: entry.filledCount,
  }));
  const locationBars: HorizontalBarDatum[] = locations.map((entry) => ({
    label: entry.location,
    value: entry.count,
  }));
  const hasContacts = (data?.overview.current.totalContacts ?? 0) > 0;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            {periodLabel ? `Showing ${periodLabel}` : 'Loading period…'}
            {data
              ? ` · ${formatCount(data.overview.current.totalContacts)} contacts in the CRM`
              : ''}
          </p>
        </div>
        <DateRangeFilter value={range} onChange={setRange} disabled={loading} />
      </div>

      <KpiCards
        overview={data?.overview ?? null}
        loading={loading}
        error={error}
        onRetry={retry}
      />

      <AnalyticsSection
        title="Messages over time"
        subtitle="Inbound and outbound messages per day in the selected period."
        loading={loading}
        error={error}
        isEmpty={messageTotal === 0}
        onRetry={retry}
      >
        <MessagesOverTimeChart points={points} />
      </AnalyticsSection>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AnalyticsSection
          title="Messages by channel"
          subtitle="Messages received and sent on each connected channel."
          loading={loading}
          error={error}
          isEmpty={channels.length === 0}
          onRetry={retry}
        >
          <ChannelBarChart
            data={toChannelBars(channels, 'messages')}
            valueLabel="Messages"
          />
          <ul className="mt-4 space-y-1 border-t pt-3">
            {channels.map((entry) => (
              <li
                key={`messages-${entry.channel}`}
                className="flex items-center justify-between text-xs"
              >
                <span className="text-muted-foreground">{entry.label}</span>
                <span className="font-medium">
                  {formatCount(entry.messages)} · {entry.messageSharePct}%
                </span>
              </li>
            ))}
          </ul>
        </AnalyticsSection>

        <AnalyticsSection
          title="Conversations by channel"
          subtitle="Distinct conversations with activity in the period — not messages."
          loading={loading}
          error={error}
          isEmpty={channels.length === 0}
          onRetry={retry}
        >
          <ChannelBarChart
            data={toChannelBars(channels, 'conversations')}
            valueLabel="Conversations"
          />
          <ul className="mt-4 space-y-1 border-t pt-3">
            {channels.map((entry) => (
              <li
                key={`conversations-${entry.channel}`}
                className="flex items-center justify-between text-xs"
              >
                <span className="text-muted-foreground">{entry.label}</span>
                <span className="font-medium">{formatCount(entry.conversations)}</span>
              </li>
            ))}
          </ul>
        </AnalyticsSection>
      </div>

      <AnalyticsSection
        title="Lead funnel"
        subtitle="Contacts by lead_status and by customer_status — the statuses as they stand right now."
        loading={loading}
        error={error}
        isEmpty={!hasContacts}
        onRetry={retry}
      >
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">Lead status</h3>
            <HorizontalBarChart data={leadStatusBars} valueLabel="Contacts" labelWidth={110} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">Customer status</h3>
            <HorizontalBarChart
              data={customerStatusBars}
              valueLabel="Contacts"
              labelWidth={110}
            />
          </div>
        </div>
      </AnalyticsSection>

      <AnalyticsSection
        title="Most populated CRM fields"
        subtitle="Your dynamic CRM columns, ranked by the number of contacts holding a non-empty value."
        loading={loading}
        error={error}
        isEmpty={crmFieldBars.length === 0}
        onRetry={retry}
      >
        <HorizontalBarChart data={crmFieldBars} valueLabel="Contacts" labelWidth={170} />
      </AnalyticsSection>

      <AnalyticsSection
        title="Top values in select fields"
        subtitle="Most common answers inside your single-choice (select) CRM fields. Free-text fields are not grouped."
        loading={loading}
        error={error}
        isEmpty={crmSelectValues.length === 0}
        onRetry={retry}
      >
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {crmSelectValues.map((field) => (
            <div key={field.field_name}>
              <h3 className="mb-2 text-sm font-medium">
                {field.field_label}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {formatCount(field.filledCount)} contacts
                </span>
              </h3>
              <ul className="space-y-1">
                {field.topValues.map((entry) => (
                  <li
                    key={entry.value}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="truncate text-muted-foreground">{entry.value}</span>
                    <span className="shrink-0 font-medium">{formatCount(entry.count)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </AnalyticsSection>

      <AnalyticsSection
        title="Top locations"
        subtitle="Wilaya (preferred) or city of the contacts created during the selected period."
        loading={loading}
        error={error}
        isEmpty={locationBars.length === 0}
        onRetry={retry}
      >
        <HorizontalBarChart data={locationBars} valueLabel="Contacts" labelWidth={170} />
      </AnalyticsSection>

      <AnalyticsSection
        title="Recent activity"
        subtitle="Newest events across contacts, conversations, incoming messages and CRM fields."
        loading={loading}
        error={error}
        isEmpty={activity.length === 0}
        onRetry={retry}
      >
        <ul className="divide-y">
          {activity.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={cn(
                    'shrink-0 rounded px-2 py-0.5 text-xs font-medium',
                    ACTIVITY_STYLES[entry.kind] ?? 'bg-muted text-muted-foreground',
                  )}
                >
                  {entry.kindLabel}
                </span>
                <span className="truncate text-sm">{entry.subject}</span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatWhen(entry.at)}
              </span>
            </li>
          ))}
        </ul>
      </AnalyticsSection>
    </div>
  );
}
