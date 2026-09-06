'use client';
import { useMemo, useRef, useState } from 'react';
import { Button, Pagination } from '@mantine/core';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import {
  economicRange,
  economicTrendRows,
  economicTimeDomain,
  economicTick,
  TREND_METRICS,
} from './economicsTrend';
import { formatCount, formatEstimate, formatTokens } from './economics';
import styles from './EconomicsLens.module.css';

const utc = (value) => new Date(value).toISOString().slice(0, 16).replace('T', ' ');
export function EconomicsTrend({ data, onTimeRangeChange }) {
  const chart = useRef(null);
  const [showData, setShowData] = useState(false),
    [page, setPage] = useState(1);
  const points = data.series?.points;
  const bucketMs = data.series?.bucketMs;
  const rows = useMemo(() => economicTrendRows(points, bucketMs), [points, bucketMs]);
  const domain = useMemo(() => economicTimeDomain(points), [points]);
  const totalPages = Math.max(1, Math.ceil((points?.length || 0) / 20));
  const effectivePage = Math.min(page, totalPages);
  const select = (start, end) => {
    const range = economicRange(start, end, data.filters);
    if (range) onTimeRangeChange?.(...range);
  };
  const option = useMemo(
    () => ({
      grid: [
        { top: 27, height: 50, left: 60, right: 12 },
        { top: 116, height: 64, left: 60, right: 12 },
      ],
      title: [
        {
          text: 'Recorded estimate · USD',
          top: 0,
          left: 0,
          textStyle: { fontSize: 13, fontWeight: 500, color: '#5a687d' },
        },
        {
          text: 'Recorded quantities · tokens',
          top: 88,
          left: 0,
          textStyle: { fontSize: 13, fontWeight: 500, color: '#5a687d' },
        },
      ],
      legend: {
        top: 87,
        right: 8,
        data: TREND_METRICS.slice(1).map((metric) => metric.name),
        itemWidth: 12,
        itemHeight: 3,
        textStyle: { fontSize: 13 },
      },
      xAxis: [0, 1].map((gridIndex) => ({
        type: 'time',
        gridIndex,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#dce1e9' } },
        axisLabel: {
          show: gridIndex === 1,
          fontSize: 13,
          fontFamily: 'IBM Plex Mono',
          formatter: (value) => economicTick(value, (domain?.end || 0) - (domain?.start || 0)),
          hideOverlap: true,
        },
      })),
      yAxis: [0, 1].map((gridIndex) => ({
        type: 'value',
        gridIndex,
        splitNumber: 2,
        axisLabel: {
          fontSize: 13,
          formatter: gridIndex ? formatTokens : (value) => `$${formatTokens(value)}`,
        },
        splitLine: { lineStyle: { color: '#edf0f5' } },
      })),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        confine: true,
        formatter: (entries) => {
          const point = entries[0]?.data?.[2];
          if (!point || point.gap) return 'No recorded observations in this interval';
          return [
            utc(point.bucketStartMs) + ' UTC',
            ...entries.map((entry) => {
              const metric = TREND_METRICS[entry.seriesIndex];
              return `${metric.name}: ${metric.axis ? formatCount(entry.value[1]) : formatEstimate(entry.value[1])} ${metric.unit} (${formatCount(point[metric.samples])}/${formatCount(point.records)} samples)`;
            }),
            point.inconsistentCacheRows
              ? `${formatCount(point.inconsistentCacheRows)} records have inconsistent cache totals`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
        },
      },
      toolbox: { show: false },
      brush: {
        xAxisIndex: [0, 1],
        brushType: 'lineX',
        brushMode: 'single',
        toolbox: [],
        brushStyle: { color: 'rgba(69,91,202,0.12)', borderColor: '#7d90e2' },
      },
      series: TREND_METRICS.map((metric, index) => ({
        name: metric.name,
        type: 'line',
        xAxisIndex: metric.axis,
        yAxisIndex: metric.axis,
        showSymbol: rows.length < 20,
        symbolSize: 4,
        connectNulls: false,
        lineStyle: { width: index === 0 ? 2 : 1.5 },
        itemStyle: { color: METRIC_COLORS[metric.color] },
        data: rows.map((row) => [row.bucketStartMs, row.values[index], row]),
      })),
    }),
    [rows, domain]
  );
  if (!points?.length) return null;
  return (
    <section className={styles.trend} aria-label="Cost and token quantities over time">
      {domain && (
        <div className={styles.trendDomain}>
          <span>
            Recorded interval{' '}
            <strong>
              {utc(domain.start)} – {utc(domain.end)} UTC
            </strong>
            {domain.separated && (
              <small>Records span separated periods. Blank intervals carry no observations.</small>
            )}
          </span>
          {domain.separated && onTimeRangeChange && (
            <Button
              size="xs"
              variant="light"
              onClick={() => select(domain.end - 7 * 86400000, domain.end + 1)}
            >
              Focus recent activity · 7 days
            </Button>
          )}
        </div>
      )}
      <div className={styles.trendTools}>
        <span>Aligned UTC buckets · quantities are separate, unstacked series</span>
        <span>
          {onTimeRangeChange && (
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() =>
                chart.current?.dispatchAction({
                  type: 'takeGlobalCursor',
                  key: 'brush',
                  brushOption: { brushType: 'lineX', brushMode: 'single' },
                })
              }
            >
              Select time interval
            </Button>
          )}
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setShowData((value) => !value)}
            aria-expanded={showData}
          >
            {showData ? 'Hide bucket data' : 'View bucket data'}
          </Button>
        </span>
      </div>
      <AnalyticalChart
        option={option}
        height={215}
        label="Recorded dollar estimates and four unstacked token series share the same UTC time axis. Missing samples are gaps. Toggle token series in the legend or use the bucket data table."
        onReady={(instance) => {
          chart.current = instance;
        }}
        onEvents={{
          brushEnd: (event) => {
            const range = event.areas?.[0]?.coordRange;
            if (range?.length === 2) select(range[0], range[1]);
          },
        }}
      />
      {showData && (
        <div className={styles.trendData}>
          <table className={styles.comparisonTable} aria-label="Economics by UTC bucket">
            <thead>
              <tr>
                <th>UTC bucket</th>
                <th>Records</th>
                {TREND_METRICS.map((metric) => (
                  <th key={metric.key}>
                    {metric.name}
                    <small>{metric.unit}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(points || []).slice((effectivePage - 1) * 20, effectivePage * 20).map((point) => (
                <tr key={point.bucketStartMs}>
                  <th>
                    {onTimeRangeChange ? (
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        onClick={() => select(point.bucketStartMs, point.bucketStartMs + bucketMs)}
                      >
                        {utc(point.bucketStartMs)}
                      </Button>
                    ) : (
                      utc(point.bucketStartMs)
                    )}
                  </th>
                  <td>{formatCount(point.records)}</td>
                  {TREND_METRICS.map((metric) => (
                    <td key={metric.key}>
                      {point[metric.samples] > 0
                        ? metric.axis
                          ? formatCount(point[metric.key])
                          : formatEstimate(point[metric.key])
                        : 'Unknown'}
                      <small>{formatCount(point[metric.samples])} samples</small>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination value={effectivePage} onChange={setPage} total={totalPages} mt="sm" />
        </div>
      )}
    </section>
  );
}
