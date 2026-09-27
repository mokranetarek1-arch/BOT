import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AnalyticsRangeInput, AnalyticsRangePreset } from '@/services/analyticsService';

/**
 * Global period selector for the Analytics dashboard.
 *
 * Presets are one click; "Custom range" reveals two native date inputs. The
 * parent decides when a half-typed custom range is complete enough to query.
 */

const PRESETS: { preset: AnalyticsRangePreset; label: string }[] = [
  { preset: 'today', label: 'Today' },
  { preset: '7d', label: 'Last 7 days' },
  { preset: '30d', label: 'Last 30 days' },
  { preset: '90d', label: 'Last 90 days' },
  { preset: 'custom', label: 'Custom' },
];

export interface DateRangeFilterProps {
  value: AnalyticsRangeInput;
  onChange: (next: AnalyticsRangeInput) => void;
  disabled?: boolean;
}

/** `yyyy-mm-dd` for a date, in local time — the format `<input type="date">` wants. */
function toInputValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Sensible bounds the first time the user switches to a custom range. */
function defaultCustomBounds(): { from: string; to: string } {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  return { from: toInputValue(start), to: toInputValue(today) };
}

export function DateRangeFilter({ value, onChange, disabled }: DateRangeFilterProps) {
  // Seeds the date inputs the first time 'custom' is picked, and remembers the
  // user's own dates afterwards so switching presets back and forth is lossless.
  const [custom, setCustom] = useState<{ from: string; to: string }>(() =>
    value.from && value.to ? { from: value.from, to: value.to } : defaultCustomBounds(),
  );

  const selectPreset = (preset: AnalyticsRangePreset) => {
    if (preset === 'custom') {
      onChange({ preset, from: custom.from, to: custom.to });
      return;
    }
    onChange({ preset });
  };

  const isCustom = value.preset === 'custom';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((entry) => {
        const active = value.preset === entry.preset;
        return (
          <Button
            key={entry.preset}
            type="button"
            size="sm"
            variant={active ? 'default' : 'outline'}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => selectPreset(entry.preset)}
          >
            {entry.label}
          </Button>
        );
      })}

      {isCustom ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            aria-label="Start date"
            className="h-8 w-40"
            value={custom.from}
            max={custom.to}
            disabled={disabled}
            onChange={(event) => {
              const next = { ...custom, from: event.target.value };
              setCustom(next);
              onChange({ preset: 'custom', ...next });
            }}
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="End date"
            className="h-8 w-40"
            value={custom.to}
            min={custom.from}
            disabled={disabled}
            onChange={(event) => {
              const next = { ...custom, to: event.target.value };
              setCustom(next);
              onChange({ preset: 'custom', ...next });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
