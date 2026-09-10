'use client';
import { useMemo, useRef, useState } from 'react';
import { Button, Loader, Pagination, SegmentedControl } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { AnalyticalChart, METRIC_COLORS } from './AnalyticalChart';
import { useWorkspace } from './WorkspaceProvider';
import styles from './activityBand.module.css';

const EMPTY = [];
const number = (value) => (value == null ? '—' : new Intl.NumberFormat('en-US').format(value));
const compact = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
        value
      )
    : '—';
const date = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const CHARTS = [
  { value: 'attempts', label: 'Attempts' },
  { value: 'tokens', label: 'Tokens' },
];
export const STYLES = [
  { value: 'bars', label: 'Bars' },
  { value: 'lines', label: 'Lines' },
  { value: 'area', label: 'Area' },
];
// Every series the block can draw, so the legend and the option are built from
// one list rather than two that drift.
const SERIES = {
  attempts: [
    { key: 'records', name: 'Attempts', color: METRIC_COLORS.input, primary: true },
    { key: 'failed', name: 'Failures', color: METRIC_COLORS.failure },
  ],
  tokens: [
    {
      key: 'inputTokens',
      name: 'Recorded input · tokens',
      color: METRIC_COLORS.input,
      primary: true,
    },
  ],
};

export function activityBandOption(points, chart, style, colors = METRIC_COLORS) {
  const chosen = SERIES[chart] || SERIES.attempts;
  return {
    grid: { top: 6, bottom: 22, left: 38, right: 8 },
    toolbox: { show: false },
    // The balloon renders as HTML on the document body, so the small chart box
    // and its overflow clipping cannot crop it.
    tooltip: {
      trigger: 'axis',
      renderMode: 'html',
      appendTo: 'body',
      confine: false,
      valueFormatter: number,
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: 'var(--rule)' } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        fontSize: 12,
        hideOverlap: true,
        formatter: (value) =>
          `${date(value)} ${new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`,
      },
    },
    yAxis: {
      type: 'value',
      splitNumber: 2,
      minInterval: chart === 'attempts' ? 1 : undefined,
      axisLabel: { fontSize: 12, formatter: compact },
      axisTick: { show: false },
    },
    brush: {
      xAxisIndex: 0,
      brushMode: 'single',
      brushType: 'lineX',
      throttleType: 'debounce',
      throttleDelay: 300,
      brushStyle: { color: 'rgba(0,111,120,0.12)', borderColor: colors.selected },
      toolbox: [],
    },
    series: chosen.map((series) => ({
      name: series.name,
      type: style === 'bars' && series.primary ? 'bar' : 'line',
      data: (points || EMPTY).map((point) => [point.bucketStartMs, point[series.key] ?? null]),
      ...(style === 'bars' && series.primary
        ? { barMaxWidth: 6 }
        : {
            showSymbol: false,
            connectNulls: false,
            lineStyle: { color: series.color, width: 1.5 },
            ...(style === 'area' ? { areaStyle: { color: series.color, opacity: 0.16 } } : {}),
          }),
      itemStyle: { color: series.color },
      emphasis: { itemStyle: { color: colors.selected } },
    })),
  };
}

// `totals` is the block's own summary: one small chip per measure, the way the
// Capacity board's Requests & cache block carries its four totals. Each entry
// is [label, value] with an optional swatch colour.
export function ActivityBand({
  resource: suppliedResource,
  title = 'Recorded attempts',
  totals = EMPTY,
}) {
  const workspace = useWorkspace();
  const resource = suppliedResource || workspace.activity;
  const [tableOpen, setTableOpen] = useState(false);
  const [tablePage, setTablePage] = useState({ key: null, page: 1 });
  const [chart, setChart] = useLocalStorage({
    key: 'tokenproxy.activity-chart',
    defaultValue: 'attempts',
  });
  const [style, setStyle] = useLocalStorage({
    key: 'tokenproxy.activity-style',
    defaultValue: 'bars',
  });
  const chartRef = useRef(null);
  const points = resource.data?.series?.points;
  const pageKey = `${resource.url}:${points?.length || 0}`;
  const page = tablePage.key === pageKey ? tablePage.page : 1;
  const summary = resource.data?.summary;
  const selectBucket = (point) => {
    const start = point?.bucketStartMs,
      size = resource.data?.series?.bucketMs;
    if (!Number.isFinite(start) || !Number.isFinite(size) || size <= 0) return;
    const lower = Date.parse(workspace.scope.start),
      upper = Date.parse(workspace.scope.end);
    const first = Math.max(start, Number.isFinite(lower) ? lower : start);
    const last = Math.min(start + size, Number.isFinite(upper) ? upper : start + size);
    if (first >= last) return;
    workspace.setScope({
      period: 'custom',
      start: new Date(first).toISOString(),
      end: new Date(last).toISOString(),
    });
  };
  const option = useMemo(() => activityBandOption(points, chart, style), [points, chart, style]);
  const measures = totals.length
    ? totals
    : [
        ['Recorded attempts', number(summary?.records)],
        ['Failed attempts', number(summary?.failed)],
      ];
  const bucketMinutes = Math.round((resource.data?.series?.bucketMs || 0) / 60000);
  return (
    <section className={styles.activity} aria-label="Retained request activity">
      <header className={styles.header}>
        <h2>{title}</h2>
        <div className={styles.selectors}>
          <SegmentedControl
            size="xs"
            aria-label="Activity chart style"
            value={style}
            onChange={setStyle}
            data={STYLES}
          />
          <SegmentedControl
            size="xs"
            aria-label="Activity chart"
            value={chart}
            onChange={setChart}
            data={CHARTS}
          />
        </div>
      </header>
      <dl className={styles.totals}>
        {measures.map(([label, value, color]) => (
          <div key={label}>
            <dt>
              {color ? <i style={{ background: color }} /> : null}
              {label}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {resource.loading && !points?.length ? (
        <div className={styles.state} role="status">
          <Loader size="xs" /> Reading recorded activity…
        </div>
      ) : resource.error ? (
        <div className={styles.state} role="status">
          Activity is unavailable.
          <Button size="compact-xs" variant="subtle" onClick={resource.refresh}>
            Try again
          </Button>
        </div>
      ) : !points?.length ? (
        <div className={styles.state}>No recorded activity in this interval.</div>
      ) : (
        <>
          <div className={styles.legend}>
            {option.series.map((series) => (
              <span key={series.name}>
                <i style={{ background: series.itemStyle.color }} />
                {series.name}
              </span>
            ))}
          </div>
          <AnalyticalChart
            key={chart}
            height={96}
            option={option}
            onReady={(instance) => {
              chartRef.current = instance;
            }}
            label={`${number(summary?.records)} recorded attempts across the selected UTC interval. Select an interval to focus on it.`}
            onEvents={{
              click: (event) => selectBucket(points?.[event.dataIndex]),
              brushEnd: (event) => {
                const range = event.areas?.[0]?.coordRange;
                if (range?.length === 2 && range[0] < range[1])
                  workspace.setScope({
                    period: 'custom',
                    start: new Date(range[0]).toISOString(),
                    end: new Date(range[1]).toISOString(),
                  });
              },
            }}
          />
        </>
      )}
      <footer className={styles.foot}>
        <span>
          {summary?.firstSeenAt
            ? `${date(summary.firstSeenAt)} – ${date(summary.lastSeenAt)} · ${bucketMinutes}-minute buckets · UTC. Select an interval to focus.`
            : 'Stored observations only, separate from current quota observations.'}
          {summary?.recordedPending
            ? ` ${number(summary.recordedPending)} recorded pending, not live requests.`
            : ''}
        </span>
        <span className={styles.footActions}>
          {!suppliedResource &&
          summary?.lastSeenAt &&
          Date.parse(summary.lastSeenAt) - Date.parse(summary.firstSeenAt) > 7 * 86400000 ? (
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() =>
                workspace.setScope({
                  period: 'custom',
                  start: new Date(Date.parse(summary.lastSeenAt) - 7 * 86400000).toISOString(),
                  end: new Date(Date.parse(summary.lastSeenAt) + 1).toISOString(),
                })
              }
            >
              Focus 7 days
            </Button>
          ) : null}
          {points?.length ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() =>
                chartRef.current?.dispatchAction({
                  type: 'takeGlobalCursor',
                  key: 'brush',
                  brushOption: { brushType: 'lineX', brushMode: 'single' },
                })
              }
            >
              Select interval
            </Button>
          ) : null}
          {points?.length ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              aria-expanded={tableOpen}
              onClick={() => {
                setTablePage({ key: pageKey, page: 1 });
                setTableOpen((open) => !open);
              }}
            >
              {tableOpen ? 'Hide data' : 'View data'}
            </Button>
          ) : null}
        </span>
      </footer>
      {tableOpen ? (
        <div className={styles.data}>
          <table aria-label="Recorded activity by UTC bucket">
            <thead>
              <tr>
                <th>Bucket start (UTC)</th>
                <th>Attempts</th>
                <th>Failed</th>
                <th>Recorded input tokens</th>
              </tr>
            </thead>
            <tbody>
              {(points || EMPTY).slice((page - 1) * 20, page * 20).map((point) => (
                <tr key={point.bucketStart}>
                  <td>
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      onClick={() => selectBucket(point)}
                      aria-label={`Filter activity to ${point.bucketStart} UTC`}
                    >
                      {point.bucketStart}
                    </Button>
                  </td>
                  <td>{number(point.records)}</td>
                  <td>{number(point.failed)}</td>
                  <td>{number(point.inputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            size="xs"
            mt="xs"
            value={page}
            onChange={(next) => setTablePage({ key: pageKey, page: next })}
            total={Math.max(1, Math.ceil((points?.length || 0) / 20))}
          />
        </div>
      ) : null}
    </section>
  );
}
