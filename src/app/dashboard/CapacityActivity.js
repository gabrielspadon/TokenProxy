'use client';
import { useMemo } from 'react';
import { Button, Loader, SegmentedControl, Select, useComputedColorScheme } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import { chartMetricColors, chartThemeColors } from '@/shared/workspace/metricColors';
import { useResource } from '@/shared/workspace/useResource';
import { analyticsUrl, useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import styles from './capacityActivity.module.css';

const EMPTY = [];
const DAY = 86400000;
export const CHARTS = [
  { value: 'requests', label: 'Requests' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'calendar', label: 'Calendar' },
];
// The time axis scale. Auto is the server's own choice for the period; a
// chosen scale is read as its own series and is never finer than the server
// allows for that period.
const HOUR = 3600000;
export const SCALES = [
  { value: 'auto', label: 'Auto' },
  { value: String(60000), label: '1 min' },
  { value: String(5 * 60000), label: '5 min' },
  { value: String(15 * 60000), label: '15 min' },
  { value: String(HOUR), label: '1 hour' },
  { value: String(6 * HOUR), label: '6 hours' },
  { value: String(DAY), label: '1 day' },
  { value: String(7 * DAY), label: '1 week' },
];
export const STYLES = [
  { value: 'lines', label: 'Lines' },
  { value: 'bars', label: 'Bars' },
  { value: 'area', label: 'Area' },
];
export const CALENDAR_METRICS = [
  {
    value: 'inputTokens',
    samples: 'inputSamples',
    label: 'Tokens in',
    group: 'Tokens',
    short: 'In',
    color: 'input',
    legend: '--metric-input',
  },
  {
    value: 'outputTokens',
    samples: 'outputSamples',
    label: 'Tokens out',
    group: 'Tokens',
    short: 'Out',
    color: 'output',
    legend: '--metric-output',
  },
  {
    value: 'cacheReadTokens',
    samples: 'cacheReadSamples',
    label: 'Cache read',
    group: 'Cache',
    short: 'Read',
    color: 'cacheRead',
    legend: '--metric-cache',
  },
  {
    value: 'cacheWriteTokens',
    samples: 'cacheWriteSamples',
    label: 'Cache write',
    group: 'Cache',
    short: 'Write',
    color: 'cacheWrite',
    legend: '--metric-write',
  },
];
// The metric picker groups by family so no option repeats "tokens" or "cache".
export const METRIC_CHOICES = ['Tokens', 'Cache'].map((group) => ({
  group,
  items: CALENDAR_METRICS.filter((item) => item.group === group).map((item) => ({
    value: item.value,
    label: item.short,
  })),
}));
const interval = (ms) =>
  ms >= DAY && ms % DAY === 0
    ? `${number(ms / DAY)}-day`
    : ms >= HOUR && ms % HOUR === 0
      ? `${number(ms / HOUR)}-hour`
      : `${number(ms / 60000)}-minute`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const REQUEST_LEGEND = [
  '--signal',
  '--metric-input',
  '--refusal',
  '--metric-cache',
  '--metric-write',
];
const TOKEN_LEGEND = ['--metric-input', '--metric-output', '--metric-cache', '--metric-write'];
const number = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
    : 'Unknown';
const compact = (value) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const utc = (value) =>
  new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
// A recorded value counts only when its samples say it was measured. A point
// that carries no sample field at all (older rows) is taken as measured.
const measured = (point, key, samples) =>
  Number.isFinite(point?.[key]) && (!samples || !(samples in point) || point[samples] > 0)
    ? point[key]
    : null;
// The balloon renders as HTML on the document body, so the small chart box and
// its overflow clipping cannot crop it.
const balloon = (extra = {}) => ({
  trigger: 'axis',
  renderMode: 'html',
  appendTo: 'body',
  confine: false,
  ...extra,
});

export function capacityBucketScope(point, bucketMs, scope) {
  if (!Number.isFinite(point?.bucketStartMs) || !Number.isFinite(bucketMs) || bucketMs <= 0)
    return null;
  const lower = Date.parse(scope.start),
    upper = Date.parse(scope.end);
  const start = Math.max(point.bucketStartMs, Number.isFinite(lower) ? lower : point.bucketStartMs);
  const end = Math.min(
    point.bucketStartMs + bucketMs,
    Number.isFinite(upper) ? upper : point.bucketStartMs + bucketMs
  );
  return start < end
    ? { period: 'custom', start: new Date(start).toISOString(), end: new Date(end).toISOString() }
    : null;
}

export function capacityDayScope(day) {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(start)
    ? {
        period: 'custom',
        start: new Date(start).toISOString(),
        end: new Date(start + DAY).toISOString(),
      }
    : null;
}

function timeAxis(points, bucketMs) {
  const validBucket = Number.isFinite(bucketMs) && bucketMs > 0;
  const first = points[0]?.bucketStartMs,
    last = points.at(-1)?.bucketStartMs;
  const end = validBucket && Number.isFinite(last) ? last + bucketMs : null;
  const validDomain = Number.isFinite(first) && Number.isFinite(end) && end > first;
  const tickFormat = new Intl.DateTimeFormat('en-GB', {
    ...(validDomain && Math.floor(first / DAY) === Math.floor(end / DAY)
      ? {}
      : { day: '2-digit', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    ...(validBucket && bucketMs < 60000 ? { second: '2-digit' } : {}),
    timeZone: 'UTC',
  });
  // A missing bucket is a gap in retained evidence, not a measured zero.
  const plot = points.flatMap((point, index) =>
    validBucket && index && point.bucketStartMs - points[index - 1].bucketStartMs > bucketMs
      ? [{ bucketStartMs: points[index - 1].bucketStartMs + bucketMs }, point]
      : [point]
  );
  const axis = (gridIndex, showLabel) => ({
    type: 'time',
    gridIndex,
    min: validDomain ? first : undefined,
    max: validDomain ? end : undefined,
    splitNumber: 4,
    minInterval: validBucket ? bucketMs : undefined,
    axisTick: { show: false },
    axisLine: { show: false },
    splitLine: { show: false },
    axisLabel: {
      show: showLabel,
      formatter: (value) => tickFormat.format(value),
      hideOverlap: true,
    },
  });
  return { plot, axis };
}

const line = (name, key, color, grid, samples, plot, style = 'lines') => ({
  name,
  type: style === 'bars' ? 'bar' : 'line',
  xAxisIndex: grid,
  yAxisIndex: grid,
  itemStyle: { color },
  ...(style === 'bars'
    ? { barMaxWidth: 10, barGap: '10%' }
    : {
        connectNulls: false,
        showSymbol: true,
        showAllSymbol: true,
        symbolSize: 4,
        lineStyle: { width: 2, color },
        ...(style === 'area' ? { areaStyle: { color, opacity: 0.16 } } : {}),
      }),
  data: plot.map((point) => [point.bucketStartMs, measured(point, key, samples)]),
});

export function capacityActivityOption(points, bucketMs, style = 'lines') {
  const { plot, axis } = timeAxis(points, bucketMs);
  return {
    grid: [
      { top: 16, height: 30, left: 48, right: 12 },
      { top: 66, height: 30, left: 48, right: 12 },
    ],
    tooltip: balloon({ valueFormatter: (value) => (value == null ? 'Unknown' : number(value)) }),
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [axis(0, false), axis(1, true)],
    yAxis: ['Count', 'Tokens'].map((name, gridIndex) => ({
      type: 'value',
      name,
      gridIndex,
      min: 0,
      minInterval: 1,
      nameGap: 7,
      splitNumber: 2,
      axisLabel: { formatter: compact },
      axisTick: { show: false },
    })),
    series: [
      line('Requests with an ID', 'logicalRequests', METRIC_COLORS.selected, 0, null, plot, style),
      line('Attempts', 'records', METRIC_COLORS.input, 0, null, plot, style),
      line('Failed attempts', 'failed', METRIC_COLORS.failure, 0, null, plot, style),
      line(
        'Cache reads · tokens',
        'cacheReadTokens',
        METRIC_COLORS.cacheRead,
        1,
        'cacheReadSamples',
        plot,
        style
      ),
      line(
        'Cache writes · tokens',
        'cacheWriteTokens',
        METRIC_COLORS.cacheWrite,
        1,
        'cacheWriteSamples',
        plot,
        style
      ),
    ],
  };
}

export function capacityTokensOption(points, bucketMs, style = 'lines') {
  const { plot, axis } = timeAxis(points, bucketMs);
  return {
    grid: [{ top: 12, height: 82, left: 48, right: 12 }],
    tooltip: balloon({ valueFormatter: (value) => (value == null ? 'Unknown' : number(value)) }),
    xAxis: [axis(0, true)],
    yAxis: [
      {
        type: 'value',
        name: 'Tokens',
        gridIndex: 0,
        min: 0,
        minInterval: 1,
        nameGap: 7,
        splitNumber: 3,
        axisLabel: { formatter: compact },
        axisTick: { show: false },
      },
    ],
    series: [
      line('Tokens in', 'inputTokens', METRIC_COLORS.input, 0, 'inputSamples', plot, style),
      line('Tokens out', 'outputTokens', METRIC_COLORS.output, 0, 'outputSamples', plot, style),
      line('Cache read', 'cacheReadTokens', METRIC_COLORS.cacheRead, 0, 'cacheReadSamples', plot, style),
      line(
        'Cache write',
        'cacheWriteTokens',
        METRIC_COLORS.cacheWrite,
        0,
        'cacheWriteSamples',
        plot,
        style
      ),
    ],
  };
}

// Daily totals of one token metric as a GitHub-style calendar. A bucket is
// attributed to the UTC day it starts in.
export function capacityCalendarOption(
  points,
  metric,
  theme = { paper: '#f4f6f8', raised: '#fff', slate: '#52606d' },
  palette = {},
  range = null
) {
  const days = new Map();
  for (const point of points) {
    const value = measured(point, metric.value, metric.samples);
    if (value === null || !Number.isFinite(point.bucketStartMs)) continue;
    const day = new Date(point.bucketStartMs).toISOString().slice(0, 10);
    days.set(day, (days.get(day) || 0) + value);
  }
  const data = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  // The grid spans the asked range (a year ending now, like GitHub, when the
  // period is open) and otherwise the days that carry data.
  const first = range?.start ?? data[0]?.[0] ?? new Date().toISOString().slice(0, 10);
  const last = range?.end ?? data.at(-1)?.[0] ?? first;
  const max = Math.max(1, ...data.map(([, value]) => value));
  const color = palette[metric.color] || METRIC_COLORS[metric.color];
  // Up to half a year keeps fixed square cells; a longer range spreads to the
  // width and the height so the cells stay close to square.
  const weeks = Math.ceil((Date.parse(last) - Date.parse(first)) / (7 * DAY)) + 1;
  const cell = weeks <= 26 ? 13 : 'auto';
  return {
    tooltip: balloon({
      trigger: 'item',
      formatter: (item) =>
        `${item.value[0]}<br/>${number(item.value[1])} ${metric.label.toLowerCase()}`,
    }),
    visualMap: { min: 0, max, show: false, inRange: { color: [theme.paper, color] } },
    calendar: {
      top: 22,
      left: 36,
      right: 10,
      bottom: 4,
      cellSize: [cell, cell],
      range: [first, last],
      splitLine: { show: false },
      itemStyle: { borderWidth: 2, borderColor: theme.raised, color: theme.paper },
      dayLabel: { firstDay: 1, nameMap: 'en', fontSize: 11, color: theme.slate, margin: 6 },
      monthLabel: { fontSize: 11, color: theme.slate, margin: 6 },
      yearLabel: { show: false },
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data,
        emphasis: { itemStyle: { borderColor: theme.slate } },
      },
    ],
    days: data.length,
  };
}

export function CapacityActivity() {
  const workspace = useWorkspace();
  const scheme = useComputedColorScheme('light');
  const [chart, setChart] = useLocalStorage({
    key: 'tokenproxy.capacity-chart',
    defaultValue: 'requests',
  });
  const [metricKey, setMetricKey] = useLocalStorage({
    key: 'tokenproxy.capacity-calendar-metric',
    defaultValue: 'inputTokens',
  });
  const [scale, setScale] = useLocalStorage({
    key: 'tokenproxy.capacity-scale',
    defaultValue: 'auto',
  });
  const [style, setStyle] = useLocalStorage({
    key: 'tokenproxy.capacity-style',
    defaultValue: 'lines',
  });
  const metric = CALENDAR_METRICS.find((item) => item.value === metricKey) || CALENDAR_METRICS[0];
  // The calendar always reads whole UTC days and a chosen scale reads its own
  // series; Auto shares the workspace read.
  const bucket = chart === 'calendar' ? DAY : scale === 'auto' ? null : Number(scale);
  const own = useResource(
    bucket
      ? analyticsUrl(workspace.scope, 'activity', { bucketMs: String(bucket), pageSize: '1' })
      : null,
    { onSnapshot: workspace.observeSnapshot }
  );
  const resource = bucket ? own : workspace.activity;
  const points = resource.data?.series?.points || EMPTY,
    summary = workspace.activity.data?.summary;
  const bucketMs = resource.data?.series?.bucketMs;
  const { start: scopeStart, end: scopeEnd } = workspace.scope;
  const receivedAt = resource.receivedAt;
  const option = useMemo(() => {
    if (chart === 'tokens') return capacityTokensOption(points, bucketMs, style);
    if (chart === 'calendar') {
      const end = scopeEnd
        ? Date.parse(scopeEnd) - 1
        : receivedAt
          ? Date.parse(receivedAt)
          : points.at(-1)?.bucketStartMs;
      const start = scopeStart ? Date.parse(scopeStart) : end - 364 * DAY;
      const range =
        Number.isFinite(start) && Number.isFinite(end) ? { start: day(start), end: day(end) } : null;
      return capacityCalendarOption(
        points,
        metric,
        chartThemeColors(scheme),
        chartMetricColors(),
        range
      );
    }
    return capacityActivityOption(points, bucketMs, style);
  }, [chart, metric, points, bucketMs, scheme, style, scopeStart, scopeEnd, receivedAt]);
  const choose = (point) => {
    const next = capacityBucketScope(point, bucketMs, workspace.scope);
    if (next) workspace.setScope(next);
  };
  const fraction = summary?.cacheReadFraction;
  const requestCount =
    summary?.records > 0 && summary?.logicalRequests === 0 && summary?.unattributedAttempts > 0
      ? 'Unknown'
      : number(summary?.logicalRequests);
  const legend = chart === 'calendar' ? null : chart === 'tokens' ? TOKEN_LEGEND : REQUEST_LEGEND;
  return (
    <section className={styles.activity} aria-label="Requests and cache activity">
      <header className={styles.header}>
        <h2>Requests &amp; cache</h2>
        <div className={styles.selectors}>
          {chart === 'calendar' ? (
            <Select
              size="xs"
              aria-label="Calendar metric"
              value={metric.value}
              onChange={(value) => value && setMetricKey(value)}
              data={METRIC_CHOICES}
              allowDeselect={false}
              className={styles.metricPick}
              leftSection={<span className={styles.pickGroup}>{metric.group}</span>}
              leftSectionWidth={54}
            />
          ) : (
            <>
              <Select
                size="xs"
                aria-label="Chart scale"
                value={scale}
                onChange={(value) => value && setScale(value)}
                data={SCALES}
                allowDeselect={false}
                className={styles.pick}
              />
              <SegmentedControl
                size="xs"
                aria-label="Chart style"
                value={style}
                onChange={setStyle}
                data={STYLES}
              />
            </>
          )}
          <SegmentedControl
            size="xs"
            aria-label="Activity chart"
            value={chart}
            onChange={setChart}
            data={CHARTS}
          />
        </div>
      </header>
      <dl className={styles.summary}>
        <div>
          <dt>Requests with an ID</dt>
          <dd>{requestCount}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{number(summary?.records)}</dd>
        </div>
        <div>
          <dt>Failed attempts</dt>
          <dd>{number(summary?.failed)}</dd>
        </div>
        <div>
          <dt>Cache read share of input</dt>
          <dd>{Number.isFinite(fraction) ? `${number(fraction * 100)}%` : 'Unknown'}</dd>
        </div>
      </dl>
      {resource.loading && !points.length && !resource.error ? (
        <div className={styles.state} role="status">
          <Loader size="xs" /> Loading activity…
        </div>
      ) : resource.error ? (
        <div className={styles.state} role="status">
          Activity could not be refreshed.
          <Button size="compact-xs" variant="subtle" onClick={resource.refresh}>
            Try again
          </Button>
        </div>
      ) : !points.length ? (
        <div className={styles.state}>
          No recorded activity for this period. Account controls remain available below.
        </div>
      ) : (
        <>
          {legend ? (
            <div className={styles.legend}>
              {option.series.map((series, index) => (
                <span key={series.name}>
                  <i style={{ background: `var(${legend[index]}, ${series.itemStyle.color})` }} />
                  {series.name}
                </span>
              ))}
            </div>
          ) : null}
          <AnalyticalChart
            key={chart}
            option={option}
            height={chart === 'tokens' ? 110 : chart === 'calendar' ? 150 : 120}
            label={
              chart === 'calendar'
                ? `${metric.label} per UTC day over the selected period, ${option.days} days with a recorded total. Select a day to focus on it.`
                : chart === 'tokens'
                  ? 'Input, output, cache read and cache write tokens over the selected UTC period. Select an interval to focus on it.'
                  : 'Requests, attempts and cache tokens over the selected UTC period. Counts and tokens use separate aligned tracks. Select an interval to focus on it.'
            }
            onEvents={{
              click: (event) => {
                if (chart === 'calendar') {
                  const next = capacityDayScope(event.value?.[0]);
                  if (next) workspace.setScope(next);
                  return;
                }
                const start = event.value?.[0];
                choose(points.find((point) => point.bucketStartMs === start));
              },
            }}
          />
        </>
      )}
      <footer className={styles.foot}>
        <span>
          {chart === 'calendar'
            ? `Daily totals · UTC${scopeStart ? '' : ', the last year'}. Select a day to focus.`
            : `${Number.isFinite(bucketMs) ? `${interval(bucketMs)} intervals${bucket && bucketMs > bucket ? ` (the ${interval(bucket)} scale is too fine for this period)` : ''} · UTC. Select an interval to focus.` : 'Selected UTC period.'}`}{' '}
          {resource.receivedAt ? `Updated ${utc(resource.receivedAt)} UTC.` : ''}
        </span>
        {summary?.unattributedAttempts > 0 ? (
          <span>{number(summary.unattributedAttempts)} attempts have no request ID.</span>
        ) : null}
      </footer>
    </section>
  );
}
