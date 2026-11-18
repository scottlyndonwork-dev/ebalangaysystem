'use client';
import { palette } from '@ebalangay/shared/design';
import { TrendingDown, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '../lib/utils.js';
import { Card, Skeleton } from './primitives.js';

/** Series colors in order; brand first, then accessible contrasts. */
export const CHART_COLORS = [
  palette.brand[500],
  palette.amber[500],
  palette.blue[500],
  palette.brand[800],
  palette.red[500],
] as const;

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Percent change vs previous period, e.g. 12.5 or -3. */
  change?: number | null;
  /** e.g. "vs last week" */
  changeLabel?: string;
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}

export function StatCard({
  label,
  value,
  change,
  changeLabel,
  icon,
  loading,
  className,
}: StatCardProps) {
  const up = (change ?? 0) >= 0;
  return (
    <Card className={cn('flex flex-col gap-2 p-4', className)}>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        {icon}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div className="text-2xl font-bold tabular-nums">{value}</div>
      )}
      {change != null && !loading ? (
        <div className={cn('flex items-center gap-1 text-xs', up ? 'text-primary' : 'text-danger')}>
          {up ? (
            <TrendingUp className="size-3.5" aria-hidden />
          ) : (
            <TrendingDown className="size-3.5" aria-hidden />
          )}
          <span className="tabular-nums">
            {up ? '+' : ''}
            {change.toFixed(1)}%
          </span>
          {changeLabel ? <span className="text-muted-foreground">{changeLabel}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}

export interface ChartSeries<T> {
  key: keyof T & string;
  label: string;
  color?: string;
}

export interface ChartProps<T> {
  data: readonly T[];
  xKey: keyof T & string;
  series: readonly ChartSeries<T>[];
  /** Format axis ticks and tooltip values, e.g. formatCentavos. */
  valueFormatter?: (value: number) => string;
  xFormatter?: (value: string) => string;
  height?: number;
  /** Accessible summary of what the chart shows. */
  ariaLabel: string;
  className?: string;
}

const axisProps = {
  stroke: 'var(--text-muted)',
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;
const tooltipStyle = {
  contentStyle: {
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    fontSize: 12,
  },
  labelStyle: { color: 'var(--text)' },
};

export function LineChart<T>({
  data,
  xKey,
  series,
  valueFormatter,
  xFormatter,
  height = 280,
  ariaLabel,
  className,
}: ChartProps<T>) {
  return (
    <div role="img" aria-label={ariaLabel} className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer>
        <RLineChart
          data={data as unknown as Record<string, unknown>[]}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey={xKey as string} {...axisProps} tickFormatter={xFormatter} />
          <YAxis {...axisProps} tickFormatter={valueFormatter} width={72} />
          <Tooltip
            {...tooltipStyle}
            formatter={(v) =>
              valueFormatter && typeof v === 'number' ? valueFormatter(v) : String(v)
            }
          />
          {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key as string}
              name={s.label}
              stroke={s.color ?? CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </RLineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BarChart<T>({
  data,
  xKey,
  series,
  valueFormatter,
  xFormatter,
  height = 280,
  ariaLabel,
  className,
  stacked,
}: ChartProps<T> & { stacked?: boolean }) {
  return (
    <div role="img" aria-label={ariaLabel} className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer>
        <RBarChart
          data={data as unknown as Record<string, unknown>[]}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey={xKey as string} {...axisProps} tickFormatter={xFormatter} />
          <YAxis {...axisProps} tickFormatter={valueFormatter} width={72} />
          <Tooltip
            {...tooltipStyle}
            cursor={{ fill: 'var(--surface-muted)' }}
            formatter={(v) =>
              valueFormatter && typeof v === 'number' ? valueFormatter(v) : String(v)
            }
          />
          {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key as string}
              name={s.label}
              stackId={stacked ? 'stack' : undefined}
              fill={s.color ?? CHART_COLORS[i % CHART_COLORS.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface HeatmapProps {
  /** values[row][col], e.g. 7 weekdays x 24 hours of order counts. */
  values: readonly (readonly number[])[];
  rowLabels: readonly string[];
  colLabels: readonly string[];
  /** Accessible name; the grid is also exposed as a table. */
  caption: string;
  formatValue?: (value: number) => string;
  className?: string;
}

/** Opacity ramp of the brand color; 0 shows as empty. */
export function heatLevel(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(4, Math.ceil((value / max) * 4));
}
const LEVEL_CLASSES = [
  'bg-muted',
  'bg-brand-50',
  'bg-brand-300',
  'bg-brand-500',
  'bg-brand-800',
] as const;

export function Heatmap({
  values,
  rowLabels,
  colLabels,
  caption,
  formatValue = String,
  className,
}: HeatmapProps) {
  const max = Math.max(0, ...values.flat());
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="border-separate border-spacing-0.5 text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {colLabels.map((c) => (
              <th key={c} scope="col" className="px-0.5 font-normal text-muted-foreground">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {values.map((row, r) => (
            <tr key={rowLabels[r] ?? r}>
              <th scope="row" className="pr-2 text-right font-normal text-muted-foreground">
                {rowLabels[r]}
              </th>
              {row.map((v, c) => (
                <td
                  key={c}
                  title={`${rowLabels[r]} ${colLabels[c]}: ${formatValue(v)}`}
                  className={cn('size-5 min-w-5 rounded-sm', LEVEL_CLASSES[heatLevel(v, max)])}
                >
                  <span className="sr-only">{formatValue(v)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
