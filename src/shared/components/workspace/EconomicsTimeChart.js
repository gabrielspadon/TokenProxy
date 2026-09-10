'use client';
import { useMemo, useRef, useState } from 'react';
import { Button, Pagination, SegmentedControl, useMantineColorScheme } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { chartThemeColors } from '@/shared/workspace/metricColors';
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
const usdTick = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 3,
});
const tinyUsdTick = new Intl.NumberFormat('en-US', {
  notation: 'scientific',
  maximumSignificantDigits: 3,
});
export const CHARTS = [
  { value: 'both', label: 'Both' },
  { value: 'amount', label: 'Amount' },
  { value: 'tokens', label: 'Tokens' },
];
export const STYLES = [
  { value: 'lines', label: 'Lines' },
  { value: 'bars', label: 'Bars' },
  { value: 'area', label: 'Area' },
];
// Which TREND_METRICS a chart choice draws. The amount series is index 0; the
// four token quantities follow it.
const SERIES = { both: [0, 1, 2, 3, 4], amount: [0], tokens: [1, 2, 3, 4] };

export function economicsChartOption(rows, domain, chart, style, theme) {
  const chosen = SERIES[chart] || SERIES.both;
  const tracks = chart === 'both' ? [0, 1] : [chart === 'amount' ? 0 : 1];
  const gridOf = (axis) => tracks.indexOf(axis);
  const grid = tracks.map((_, index) =>
    chart === 'both'
      ? { top: 22 + index * 70, height: 40, left: 62, right: 16, outerBoundsMode: 'none' }
      : { top: 22, height: 100, left: 62, right: 16, outerBoundsMode: 'none' }
  );
  const span = (domain?.end || 0) - (domain?.start || 0);
  return {
    grid,
    xAxis: tracks.map((_, index) => ({
      type: 'time',
      gridIndex: index,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.rule } },
      axisLabel: {
        show: index === tracks.length - 1,
        fontSize: 12,
        formatter: (value) => economicTick(value, span),
        hideOverlap: true,
      },
    })),
    yAxis: tracks.map((axis, index) => ({
      type: 'value',
      gridIndex: index,
      splitNumber: 2,
      name: axis ? 'Tokens' : 'USD',
      nameGap: 7,
      axisLabel: {
        fontSize: 12,
        formatter: axis
          ? formatTokens
          : (value) =>
              `$${(value !== 0 && Math.abs(value) < 0.0001 ? tinyUsdTick : usdTick).format(value)}`,
      },
      splitLine: { lineStyle: { color: theme.rule } },
    })),
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    // The balloon renders as HTML on the document body, so the small chart box
    // and its overflow clipping cannot crop it.
    tooltip: {
      trigger: 'axis',
      renderMode: 'html',
      appendTo: 'body',
      confine: false,
      formatter: (entries) => {
        const point = entries[0]?.data?.[2];
        if (!point || point.gap) return 'No recorded observations in this interval';
        return [
          `${utc(point.bucketStartMs)} UTC`,
          ...entries.map((entry) => {
            const metric = TREND_METRICS[chosen[entry.seriesIndex]];
            return `${metric.name}: ${metric.axis ? formatCount(entry.value[1]) : formatEstimate(entry.value[1])} ${metric.unit} (${formatCount(point[metric.samples])}/${formatCount(point.records)} samples)`;
          }),
          point.inconsistentCacheRows
            ? `${formatCount(point.inconsistentCacheRows)} records have inconsistent cache totals`
            : '',
        ]
          .filter(Boolean)
          .join('<br/>');
      },
    },
    toolbox: { show: false },
    brush: {
      xAxisIndex: tracks.map((_, index) => index),
      brushType: 'lineX',
      brushMode: 'single',
      toolbox: [],
      brushStyle: { color: theme.signalWash, borderColor: METRIC_COLORS.selected },
    },
    series: chosen.map((index) => {
      const metric = TREND_METRICS[index];
      const color = index === 0 ? theme.ink : METRIC_COLORS[metric.color];
      const axis = gridOf(metric.axis);
      return {
        name: metric.name,
        type: style === 'bars' ? 'bar' : 'line',
        xAxisIndex: axis,
        yAxisIndex: axis,
        itemStyle: { color },
        ...(style === 'bars'
          ? { barMaxWidth: 10, barGap: '10%' }
          : {
              showSymbol: true,
              symbolSize: 4,
              connectNulls: false,
              lineStyle: { width: index === 0 ? 2 : 1.5, color },
              ...(style === 'area' ? { areaStyle: { color, opacity: 0.16 } } : {}),
            }),
        data: rows.map((row) => [row.bucketStartMs, row.values[index], row]),
      };
    }),
  };
}

// The chart block, in the same shape the Capacity board's Requests & cache
// block uses: heading with compact selectors, the totals, the legend, the
// chart, then one line of foot.
export function EconomicsChart({ data, summary, onTimeRangeChange }) {
  const { colorScheme } = useMantineColorScheme();
  const chartRef = useRef(null);
  const [showData, setShowData] = useState(false);
  const [page, setPage] = useState(1);
  const [chart, setChart] = useLocalStorage({
    key: 'tokenproxy.economics-chart',
    defaultValue: 'both',
  });
  const [style, setStyle] = useLocalStorage({
    key: 'tokenproxy.economics-style',
    defaultValue: 'lines',
  });
  const points = data?.series?.points;
  const bucketMs = data?.series?.bucketMs;
  const rows = useMemo(() => economicTrendRows(points, bucketMs), [points, bucketMs]);
  const domain = useMemo(() => economicTimeDomain(points), [points]);
  const totalPages = Math.max(1, Math.ceil((points?.length || 0) / 20));
  const effectivePage = Math.min(page, totalPages);
  const select = (start, end) => {
    const range = economicRange(start, end, data?.filters);
    if (range) onTimeRangeChange?.(...range);
  };
  const option = useMemo(
    () => economicsChartOption(rows, domain, chart, style, chartThemeColors(colorScheme)),
    [rows, domain, chart, style, colorScheme]
  );
  const totals = [
    ['Recorded amount', formatEstimate(summary?.recordedCostUsd)],
    ['Cost coverage', `${formatCount(summary?.costSamples)} / ${formatCount(summary?.records)}`],
    [
      'Exact request links',
      `${formatCount(summary?.linkedRequestRows)} / ${formatCount(summary?.records)}`,
    ],
    ['Zero-cost records', formatCount(summary?.zeroCostRows)],
  ];
  return (
    <section className={styles.chartBlock} aria-label="Recorded cost and quantities">
      <header className={styles.chartHead}>
        <h2>Cost &amp; quantities</h2>
        <div className={styles.chartSelectors}>
          <SegmentedControl
            size="xs"
            aria-label="Chart style"
            value={style}
            onChange={setStyle}
            data={STYLES}
          />
          <SegmentedControl
            size="xs"
            aria-label="Economics chart"
            value={chart}
            onChange={setChart}
            data={CHARTS}
          />
        </div>
      </header>
      <dl className={styles.chartTotals}>
        {totals.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {!points?.length ? (
        <div className={styles.chartState}>
          No recorded amounts for this period. The cohorts below stay available.
        </div>
      ) : (
        <>
          <div className={styles.chartLegend}>
            {option.series.map((series) => (
              <span key={series.name}>
                <i style={{ background: series.itemStyle.color }} />
                {series.name}
              </span>
            ))}
          </div>
          <AnalyticalChart
            key={chart}
            option={option}
            height={chart === 'both' ? 156 : 142}
            label="Recorded USD amounts and four unstacked token series share the same UTC time axis. Amounts are estimates or upstream reports. Missing samples are gaps. Select an interval to focus on it."
            onReady={(instance) => {
              chartRef.current = instance;
            }}
            onEvents={{
              brushEnd: (event) => {
                const range = event.areas?.[0]?.coordRange;
                if (range?.length === 2) select(range[0], range[1]);
              },
            }}
          />
        </>
      )}
      <footer className={styles.chartFoot}>
        <span>
          {domain
            ? `${utc(domain.start)} – ${utc(domain.end)} UTC · aligned buckets, unstacked series.`
            : 'Selected UTC period.'}
          {domain?.separated
            ? ' Records span separated periods; blank intervals carry no observations.'
            : ''}
        </span>
        <span className={styles.chartFootActions}>
          {domain?.separated && onTimeRangeChange ? (
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => select(domain.end - 7 * 86400000, domain.end + 1)}
            >
              Focus 7 days
            </Button>
          ) : null}
          {onTimeRangeChange && points?.length ? (
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() =>
                chartRef.current?.dispatchAction({
                  type: 'takeGlobalCursor',
                  key: 'brush',
                  brushOption: { brushType: 'lineX', brushMode: 'single' },
                })
              }
            >
              Select time interval
            </Button>
          ) : null}
          {points?.length ? (
            <Button
              size="compact-xs"
              variant="subtle"
              aria-expanded={showData}
              onClick={() => setShowData((value) => !value)}
            >
              {showData ? 'Hide bucket data' : 'View bucket data'}
            </Button>
          ) : null}
        </span>
      </footer>
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
          <Pagination
            size="xs"
            value={effectivePage}
            onChange={setPage}
            total={totalPages}
            mt="sm"
          />
        </div>
      )}
    </section>
  );
}
