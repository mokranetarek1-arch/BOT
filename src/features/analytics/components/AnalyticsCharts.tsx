import type { CSSProperties } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MessageSeriesPoint } from '@/services/analyticsService';
import { BAR_COLOR } from './chartData';
import type { ChannelBarDatum } from './chartData';

/**
 * Chart primitives for the Analytics dashboard, built on the Recharts version
 * already in package.json — no additional chart dependency is introduced.
 *
 * Every component is purely presentational: it receives already-aggregated real
 * data and renders it. No values are synthesised here.
 */

const INBOUND_COLOR = '#3b82f6';
const OUTBOUND_COLOR = '#8b5cf6';

/**
 * Tooltip styling reuses the project's own CSS variables, so it stays readable
 * in both the light and the dark theme without duplicating the palette.
 */
const TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
  color: 'hsl(var(--card-foreground))',
};
const TOOLTIP_LABEL_STYLE: CSSProperties = {
  color: 'hsl(var(--muted-foreground))',
  fontSize: 11,
};

/** `yyyy-mm-dd` → `dd/mm`, which is what fits on an axis. */
function shortDay(key: string): string {
  const parts = key.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : key;
}

// ---------------------------------------------------------------------------
// Messages over time
// ---------------------------------------------------------------------------

export function MessagesOverTimeChart({ points }: { points: MessageSeriesPoint[] }) {
  return (
    <div style={{ height: 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDay}
            tick={{ fontSize: 12 }}
            minTickGap={24}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={(label) => shortDay(String(label))}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="inbound"
            name="Inbound"
            stroke={INBOUND_COLOR}
            strokeWidth={2}
            dot={points.length <= 31 ? { r: 2 } : false}
          />
          <Line
            type="monotone"
            dataKey="outbound"
            name="Outbound"
            stroke={OUTBOUND_COLOR}
            strokeWidth={2}
            dot={points.length <= 31 ? { r: 2 } : false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel comparison
// ---------------------------------------------------------------------------

/** Messages (or conversations) per channel, as vertical bars. */
export function ChannelBarChart({
  data,
  valueLabel,
}: {
  data: ChannelBarDatum[];
  valueLabel: string;
}) {
  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
          <Bar dataKey="value" name={valueLabel} radius={[4, 4, 0, 0]}>
            {data.map((entry) => (
              <Cell key={entry.label} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars — statuses, CRM fields, locations
// ---------------------------------------------------------------------------

export interface HorizontalBarDatum {
  label: string;
  value: number;
  color?: string;
}

/**
 * A ranked horizontal bar chart. Used wherever the labels are words rather than
 * dates (statuses, CRM field names, locations), because horizontal bars keep
 * long labels readable.
 */
export function HorizontalBarChart({
  data,
  valueLabel,
  labelWidth = 150,
}: {
  data: HorizontalBarDatum[];
  valueLabel: string;
  labelWidth?: number;
}) {
  const height = Math.max(180, data.length * 34 + 32);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 28, bottom: 4, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
          <YAxis
            type="category"
            dataKey="label"
            width={labelWidth}
            tick={{ fontSize: 12 }}
          />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
          <Bar dataKey="value" name={valueLabel} radius={[0, 4, 4, 0]}>
            {data.map((entry, index) => (
              <Cell key={`${entry.label}-${index}`} fill={entry.color ?? BAR_COLOR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

