'use client';
import { useMemo, useRef, useState } from 'react';
import { Button, Loader, Modal, Pagination, Table } from '@mantine/core';
import { AnalyticalChart, METRIC_COLORS } from './AnalyticalChart';
import { useWorkspace } from './WorkspaceProvider';
import styles from './workspace.module.css';

const number = (value) => (value == null ? '—' : new Intl.NumberFormat('en-US').format(value));
const date = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export function ActivityBand({ resource: suppliedResource, title = 'Recorded attempts' }) {
  const workspace = useWorkspace();
  const resource = suppliedResource || workspace.activity;
  const [tableOpen, setTableOpen] = useState(false),
    [tablePage, setTablePage] = useState({ key: null, page: 1 });
  const chart = useRef(null);
  const points = resource.data?.series?.points;
  const pageKey = `${resource.url}:${points?.length || 0}`;
  const page = tablePage.key === pageKey ? tablePage.page : 1;
  const summary = resource.data?.summary;
  const selectBucket = (point) => {
    const start = point?.bucketStartMs, size = resource.data?.series?.bucketMs;
    if (!Number.isFinite(start) || !Number.isFinite(size) || size <= 0) return;
    const lower = Date.parse(workspace.scope.start), upper = Date.parse(workspace.scope.end);
    const first = Math.max(start, Number.isFinite(lower) ? lower : start);
    const last = Math.min(start + size, Number.isFinite(upper) ? upper : start + size);
    if (first >= last) return;
    workspace.setScope({ period: 'custom', start: new Date(first).toISOString(), end: new Date(last).toISOString() });
    setTableOpen(false);
  };
  const option = useMemo(
    () => ({
      grid: { top: 5, bottom: 22, left: 30, right: 7 },
      toolbox: { show: false },
      tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, valueFormatter: number },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: '#dce2ec' } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: '#65728a',
          fontSize: 13,
          hideOverlap: true,
          formatter: (value) =>
            `${date(value)} ${new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`,
        },
      },
      yAxis: {
        type: 'value',
        splitNumber: 2,
        axisLabel: {
          color: '#5e6d85',
          fontSize: 13,
          formatter: (value) => (value >= 1000 ? `${value / 1000}k` : value),
        },
        splitLine: { lineStyle: { color: '#eef1f6' } },
      },
      brush: {
        xAxisIndex: 0,
        brushMode: 'single',
        brushType: 'lineX',
        throttleType: 'debounce',
        throttleDelay: 300,
        brushStyle: { color: 'rgba(0,111,120,0.12)', borderColor: METRIC_COLORS.selected },
        toolbox: [],
      },
      series: [
        {
          name: 'Recorded attempts',
          type: 'bar',
          data: (points || []).map((point) => [point.bucketStartMs, point.records]),
          barMaxWidth: 6,
          itemStyle: { color: METRIC_COLORS.input },
          emphasis: { itemStyle: { color: METRIC_COLORS.selected } },
        },
        {
          name: 'Failed attempts',
          type: 'line',
          showSymbol: false,
          data: (points || []).map((point) => [point.bucketStartMs, point.failed]),
          lineStyle: { color: METRIC_COLORS.failure, width: 1.5 },
          itemStyle: { color: METRIC_COLORS.failure },
        },
      ],
    }),
    [points]
  );
  return (
    <div className={styles.activity}>
      <div className={styles.activitySurface}>
        <div className={styles.activitySummary}>
          <h2>{title}</h2>
          <div className={styles.activityTotal}>{summary ? number(summary.records) : '—'}</div>
          <p>{summary ? `${number(summary.failed)} failed` : 'Within selected scope'}</p>
        </div>
        {resource.loading ? (
          <div className={styles.activityUnavailable}>
            <Loader size="sm" />
            Loading recorded activity…
          </div>
        ) : resource.error ? (
          <div className={styles.activityUnavailable}>
            Activity is unavailable.{' '}
            <Button variant="subtle" onClick={resource.refresh}>
              Try again
            </Button>
          </div>
        ) : !points?.length ? (
          <div className={styles.activityUnavailable}>No recorded activity in this interval.</div>
        ) : (
          <div className={styles.activityChart}>
            <div className={styles.activityLegend}>
              <span className={styles.legendItem}>
                <i className={styles.legendSwatch} style={{ '--color': METRIC_COLORS.input }} />
                Attempts
              </span>
              <span className={styles.legendItem}>
                <i className={styles.legendSwatch} style={{ '--color': METRIC_COLORS.failure }} />
                Failures
              </span>
              <span style={{ marginInlineStart: 'auto' }}>
                {!suppliedResource &&
                  summary?.lastSeenAt &&
                  Date.parse(summary.lastSeenAt) - Date.parse(summary.firstSeenAt) >
                    7 * 86400000 && (
                    <Button
                      size="compact-xs"
                      variant="light"
                      onClick={() =>
                        workspace.setScope({
                          period: 'custom',
                          start: new Date(
                            Date.parse(summary.lastSeenAt) - 7 * 86400000
                          ).toISOString(),
                          end: new Date(Date.parse(summary.lastSeenAt) + 1).toISOString(),
                        })
                      }
                    >
                      Focus recent activity · 7 days
                    </Button>
                  )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() =>
                    chart.current?.dispatchAction({
                      type: 'takeGlobalCursor',
                      key: 'brush',
                      brushOption: { brushType: 'lineX', brushMode: 'single' },
                    })
                  }
                >
                  Select interval
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => {
                    setTablePage({ key: pageKey, page: 1 });
                    setTableOpen(true);
                  }}
                >
                  View data
                </Button>
              </span>
            </div>
            <AnalyticalChart
              height={70}
              option={option}
              onReady={(instance) => {
                chart.current = instance;
              }}
              label={`${number(summary.records)} recorded attempts across the selected UTC interval. Use the time range controls to change the interval.`}
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
          </div>
        )}
      </div>
      <div className={styles.activityFoot}>
        <span>
          {summary?.firstSeenAt
            ? `${date(summary.firstSeenAt)} – ${date(summary.lastSeenAt)} · ${Math.round((resource.data.series.bucketMs || 0) / 60000)}-minute buckets`
            : 'Historical requests, separate from current quota observations'}
        </span>
        <span>
          {summary?.recordedPending
            ? `${number(summary.recordedPending)} recorded pending · not live requests`
            : 'This view reads stored observations only'}
        </span>
      </div>
      <Modal
        opened={tableOpen}
        onClose={() => setTableOpen(false)}
        title="Recorded activity by UTC bucket"
        size="xl"
      >
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Bucket start (UTC)</Table.Th>
              <Table.Th>Attempts</Table.Th>
              <Table.Th>Failed</Table.Th>
              <Table.Th>Recorded input tokens</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(points || []).slice((page - 1) * 20, page * 20).map((point) => (
              <Table.Tr key={point.bucketStart}>
                  <Table.Td><Button variant="subtle" size="compact-sm" onClick={() => selectBucket(point)} aria-label={`Filter activity to ${point.bucketStart} UTC`}>{point.bucketStart}</Button></Table.Td>
                <Table.Td>{number(point.records)}</Table.Td>
                <Table.Td>{number(point.failed)}</Table.Td>
                <Table.Td>{number(point.inputTokens)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Pagination
          mt="md"
          value={page}
          onChange={(next) => setTablePage({ key: pageKey, page: next })}
          total={Math.max(1, Math.ceil((points?.length || 0) / 20))}
        />
      </Modal>
    </div>
  );
}
