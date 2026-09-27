import type { ChannelBreakdown } from '@/services/analyticsService';

/**
 * Chart data mapping + palette, kept out of the component module so
 * `AnalyticsCharts.tsx` only exports components (the react-refresh lint rule).
 *
 * These are presentation mappings only: they reshape already-aggregated real
 * values, they never compute or invent a number.
 */

export const BAR_COLOR = '#3b82f6';

/** Channel colours follow each platform's own brand colour. */
export const CHANNEL_COLORS: Record<string, string> = {
  instagram: '#ec4899',
  facebook: '#3b82f6',
  whatsapp: '#10b981',
  unknown: '#64748b',
};

export interface ChannelBarDatum {
  label: string;
  value: number;
  color: string;
}

/**
 * Maps a channel breakdown onto the bar datum shape.
 *
 * `metric` picks between the message count and the DISTINCT conversation count,
 * so the two channel sections can never accidentally share one number.
 */
export function toChannelBars(
  channels: ChannelBreakdown[],
  metric: 'messages' | 'conversations',
): ChannelBarDatum[] {
  return channels.map((entry) => ({
    label: entry.label,
    value: metric === 'messages' ? entry.messages : entry.conversations,
    color: CHANNEL_COLORS[entry.channel] ?? BAR_COLOR,
  }));
}
