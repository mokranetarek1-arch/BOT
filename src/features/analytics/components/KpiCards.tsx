import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AnalyticsOverview } from '@/services/analyticsService';

/**
 * The six headline numbers, with their own loading and error states so the KPI
 * row behaves like every other section on the page.
 *
 * `changePct` is only passed for period-scoped metrics (messages,
 * conversations, new contacts). Leads / qualified / customers describe the CRM
 * *right now* — a status is not a period-scoped fact — so comparing them with a
 * previous window would be meaningless and is deliberately not done.
 */

function formatCount(value: number): string {
  return value.toLocaleString();
}

function Delta({ changePct }: { changePct: number | null }) {
  if (changePct === null) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">No comparable previous period</p>
    );
  }
  if (changePct === 0) {
    return <p className="mt-1 text-xs text-muted-foreground">No change vs previous period</p>;
  }
  const positive = changePct > 0;
  return (
    <p
      className={cn(
        'mt-1 text-xs font-medium',
        positive ? 'text-emerald-600' : 'text-red-600',
      )}
    >
      {positive ? '+' : ''}
      {changePct}% vs previous period
    </p>
  );
}

interface KpiCardProps {
  label: string;
  value: number;
  /** Omit for current-state counters; null means "no comparable period". */
  changePct?: number | null;
  hint?: string;
}

function KpiCard({ label, value, changePct, hint }: KpiCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{formatCount(value)}</div>
        {changePct !== undefined ? <Delta changePct={changePct} /> : null}
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/** Placeholder cards shown while the first query is in flight. */
function KpiSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading key metrics">
      <CardHeader className="pb-2">
        <div className="h-4 w-20 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="h-7 w-16 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-3 w-28 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

export interface KpiCardsProps {
  overview: AnalyticsOverview | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6';

export function KpiCards({ overview, loading, error, onRetry }: KpiCardsProps) {
  if (loading) {
    return (
      <div className={GRID}>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <KpiSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (error || !overview) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="text-sm text-destructive">{error ?? 'Key metrics unavailable.'}</p>
          {onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const { messages, conversations, newContacts, current } = overview;

  return (
    <div className={GRID}>
      <KpiCard label="Messages" value={messages.current} changePct={messages.changePct} />
      <KpiCard
        label="Conversations"
        value={conversations.current}
        changePct={conversations.changePct}
      />
      <KpiCard
        label="New contacts"
        value={newContacts.current}
        changePct={newContacts.changePct}
      />
      <KpiCard
        label="Leads"
        value={current.leads}
        hint="Open pipeline: new, contacted, qualified"
      />
      <KpiCard
        label="Qualified leads"
        value={current.qualifiedLeads}
        hint="lead_status = qualified"
      />
      <KpiCard label="Customers" value={current.customers} hint="lead_status = won" />
    </div>
  );
}

