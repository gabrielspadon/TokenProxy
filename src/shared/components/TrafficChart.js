'use client';
import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtNum, fmtUsd } from '@/shared/format';

export function TrafficChart({ data = [], metric = 'requests', height = 210 }) {
  const id = useId().replaceAll(':', '');
  const format =
    metric === 'cost'
      ? fmtUsd
      : (v) => fmtNum(v, { notation: 'compact', maximumFractionDigits: 1 });
  const rows = data.map((d) => ({
    ...d,
    tokens: (d.promptTokens || 0) + (d.completionTokens || 0),
  }));
  if (!rows.some((r) => Number(r[metric]) > 0))
    return (
      <div className="chart-empty">
        <span className="chart-empty-bars" aria-hidden="true">
          ▁ ▃ ▅ ▂ ▆ ▃ ▁
        </span>
        <strong>No {metric} recorded in this period</strong>
        <span>The chart appears when the gateway records traffic.</span>
      </div>
    );
  return (
    <div
      className="traffic-chart"
      role="img"
      aria-label={`${metric} over time. ${rows.length} recorded time buckets.`}
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={1}>
        <AreaChart data={rows} margin={{ top: 14, right: 10, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--signal)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--signal)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--rule)" strokeDasharray="3 5" vertical={false} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            minTickGap={35}
            tick={{ fill: 'var(--slate)', fontSize: 11 }}
            dy={8}
          />
          <YAxis
            tickFormatter={format}
            axisLine={false}
            tickLine={false}
            width={48}
            tick={{ fill: 'var(--slate)', fontSize: 11 }}
          />
          <Tooltip
            formatter={(v) => [format(v), metric]}
            contentStyle={{
              background: 'var(--raised)',
              border: '1px solid var(--rule)',
              borderRadius: 8,
              color: 'var(--ink)',
            }}
          />
          <Area
            type="monotone"
            dataKey={metric}
            stroke="var(--signal)"
            fill={`url(#${id})`}
            strokeWidth={2.5}
            isAnimationActive={false}
            activeDot={{ r: 5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
