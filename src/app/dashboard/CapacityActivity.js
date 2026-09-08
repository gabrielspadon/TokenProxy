'use client';
import { useMemo, useState } from 'react';
import { Button, Loader, Pagination, SegmentedControl, Table } from '@mantine/core';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import styles from './capacityActivity.module.css';

const EMPTY = [];
const LEGEND_COLORS = ['--signal', '--metric-input', '--refusal', '--metric-cache', '--metric-write'];
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value) : 'Unknown';
const compact = value => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const utc = value => new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const measured = (point, key, samples) => Number.isFinite(point?.[key]) && (!samples || point[samples] > 0) ? point[key] : null;

export function capacityBucketScope(point, bucketMs, scope) {
  if (!Number.isFinite(point?.bucketStartMs) || !Number.isFinite(bucketMs) || bucketMs <= 0) return null;
  const lower = Date.parse(scope.start), upper = Date.parse(scope.end);
  const start = Math.max(point.bucketStartMs, Number.isFinite(lower) ? lower : point.bucketStartMs);
  const end = Math.min(point.bucketStartMs + bucketMs, Number.isFinite(upper) ? upper : point.bucketStartMs + bucketMs);
  return start < end ? { period: 'custom', start: new Date(start).toISOString(), end: new Date(end).toISOString() } : null;
}

export function capacityActivityOption(points, bucketMs) {
  // A missing bucket is a gap in retained evidence, not a measured zero.
  const plot = points.flatMap((point, index) => index && point.bucketStartMs - points[index - 1].bucketStartMs > bucketMs
    ? [{ bucketStartMs: points[index - 1].bucketStartMs + bucketMs }, point] : [point]);
  const metric = (name, key, color, grid, samples) => ({
    name, type: 'line', xAxisIndex: grid, yAxisIndex: grid, connectNulls: false,
    showSymbol: true, showAllSymbol: true, symbolSize: 4, lineStyle: { width: 2, color }, itemStyle: { color },
    data: plot.map(point => [point.bucketStartMs, measured(point, key, samples)]),
  });
  return {
    grid: [{ top: 19, height: 35, left: 52, right: 15 }, { top: 87, height: 35, left: 52, right: 15 }],
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, valueFormatter: value => value == null ? 'Unknown' : number(value) },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [0, 1].map(gridIndex => ({ type: 'time', gridIndex, min: points[0]?.bucketStartMs, max: points.at(-1)?.bucketStartMs,
      axisTick: { show: false }, axisLine: { show: false }, splitLine: { show: false }, axisLabel: { show: gridIndex === 1, formatter: utc, hideOverlap: true } })),
    yAxis: ['Count', 'Tokens'].map((name, gridIndex) => ({ type: 'value', name, gridIndex, min: 0, minInterval: 1,
      nameGap: 7, splitNumber: 2, axisLabel: { formatter: compact }, axisTick: { show: false } })),
    series: [
      metric('Requests with an ID', 'logicalRequests', METRIC_COLORS.selected, 0),
      metric('Attempts', 'records', METRIC_COLORS.input, 0),
      metric('Failed attempts', 'failed', METRIC_COLORS.failure, 0),
      metric('Cache reads · tokens', 'cacheReadTokens', METRIC_COLORS.cacheRead, 1, 'cacheReadSamples'),
      metric('Cache writes · tokens', 'cacheWriteTokens', METRIC_COLORS.cacheWrite, 1, 'cacheWriteSamples'),
    ],
  };
}

export function CapacityActivity() {
  const workspace = useWorkspace(), resource = workspace.activity;
  const [view, setView] = useState('chart'), [pagination, setPagination] = useState({ key: null, page: 1 });
  const points = resource.data?.series?.points || EMPTY, summary = resource.data?.summary;
  const bucketMs = resource.data?.series?.bucketMs;
  const key = `${resource.url}:${points.length}`, page = pagination.key === key ? pagination.page : 1;
  const option = useMemo(() => capacityActivityOption(points, bucketMs), [points, bucketMs]);
  const choose = point => {
    const next = capacityBucketScope(point, bucketMs, workspace.scope);
    if (next) workspace.setScope(next);
  };
  const fraction = summary?.cacheReadFraction;
  const requestCount = summary?.records > 0 && summary?.logicalRequests === 0 && summary?.unattributedAttempts > 0 ? 'Unknown' : number(summary?.logicalRequests);
  return <section className={styles.activity} aria-label="Requests and cache activity">
    <header className={styles.header}><h2>Requests &amp; cache</h2><SegmentedControl size="xs" aria-label="Activity presentation" value={view} onChange={setView} data={[{ value: 'chart', label: 'Chart' }, { value: 'data', label: 'Data' }]} /></header>
    <dl className={styles.summary}>
      <div><dt>Requests with an ID</dt><dd>{requestCount}</dd></div>
      <div><dt>Attempts</dt><dd>{number(summary?.records)}</dd></div>
      <div><dt>Failed attempts</dt><dd>{number(summary?.failed)}</dd></div>
      <div><dt>Cache read share of input</dt><dd>{Number.isFinite(fraction) ? `${number(fraction * 100)}%` : 'Unknown'}</dd></div>
    </dl>
    {resource.loading && !summary ? <div className={styles.state} role="status"><Loader size="sm" /> Loading activity…</div>
      : resource.error ? <div className={styles.state} role="status">Activity could not be refreshed.<Button variant="subtle" onClick={resource.refresh}>Try again</Button></div>
        : !points.length ? <div className={styles.state}>No recorded activity for this period. Account controls remain available below.</div>
          : view === 'chart' ? <>
            <div className={styles.legend}>{option.series.map((series, index) => <span key={series.name}><i style={{ background: `var(${LEGEND_COLORS[index]}, ${series.itemStyle.color})` }} />{series.name}</span>)}</div>
            <AnalyticalChart option={option} height={149} label="Requests, attempts and cache tokens over the selected UTC period. Counts and tokens use separate aligned tracks. Use Data for keyboard interval selection." onEvents={{ click: event => {
              const start = event.value?.[0];
              choose(points.find(point => point.bucketStartMs === start));
            } }} />
          </> : <div className={styles.data}>
            <div className={styles.tableScroll}><Table striped><Table.Thead><Table.Tr><Table.Th>Interval start · UTC</Table.Th><Table.Th>Requests with an ID</Table.Th><Table.Th>Attempts</Table.Th><Table.Th>Failed</Table.Th><Table.Th>Cache read tokens</Table.Th><Table.Th>Cache write tokens</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{points.slice((page - 1) * 5, page * 5).map(point => <Table.Tr key={point.bucketStartMs}>
                <Table.Td><Button variant="subtle" size="compact-sm" onClick={() => choose(point)} aria-label={`Filter activity to ${point.bucketStart} UTC`}>{utc(point.bucketStartMs)}</Button></Table.Td>
                <Table.Td>{number(point.logicalRequests)}</Table.Td><Table.Td>{number(point.records)}</Table.Td><Table.Td>{number(point.failed)}</Table.Td>
                <Table.Td>{number(measured(point, 'cacheReadTokens', 'cacheReadSamples'))}</Table.Td><Table.Td>{number(measured(point, 'cacheWriteTokens', 'cacheWriteSamples'))}</Table.Td>
              </Table.Tr>)}</Table.Tbody></Table></div>
            <Pagination size="sm" value={page} onChange={next => setPagination({ key, page: next })} total={Math.max(1, Math.ceil(points.length / 5))} />
          </div>}
    <footer className={styles.foot}>
      <span>{Number.isFinite(bucketMs) ? `${number(bucketMs / 60000)}-minute intervals · UTC. Select an interval to focus.` : 'Selected UTC period.'} {resource.receivedAt ? `Updated ${utc(resource.receivedAt)} UTC.` : ''}</span>
      {summary?.unattributedAttempts > 0 ? <span>{number(summary.unattributedAttempts)} attempts have no request ID.</span> : null}
      {view === 'data' ? <><span>Requests can span intervals; interval counts do not add up to unique requests.</span>
      <span>Cache share uses paired recorded read/input tokens. Historical zeros may be unreported. Current account availability is shown below.</span></> : null}
    </footer>
  </section>;
}
