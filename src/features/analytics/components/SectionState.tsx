import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Shared shell for every Analytics block.
 *
 * Each block owns its loading skeleton, its "no data" state and the error
 * state with a retry, so a section can never silently render an empty chart.
 * A block with no rows shows the explicit empty state instead of a fake zero.
 */
export interface AnalyticsSectionProps {
  title: string;
  /** Optional one-line explanation of what the numbers mean. */
  subtitle?: string;
  loading: boolean;
  error: string | null;
  /** True when the query succeeded but the period holds nothing to show. */
  isEmpty: boolean;
  onRetry?: () => void;
  children: ReactNode;
}

export function AnalyticsSection({
  title,
  subtitle,
  loading,
  error,
  isEmpty,
  onRetry,
  children,
}: AnalyticsSectionProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2" aria-busy="true" aria-label={`Loading ${title}`}>
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ) : error ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-destructive">{error}</p>
            {onRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : isEmpty ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No data for this period
          </p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
