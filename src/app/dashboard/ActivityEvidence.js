'use client';
import { useMemo } from 'react';
import { Select, Tooltip, useMantineColorScheme } from '@mantine/core';
import { AnalyticalChart } from '@/shared/workspace/AnalyticalChart';
import { chartMetricColors, chartThemeColors } from '@/shared/workspace/metricColors';
import styles from './accountBoard.module.css';

const number = (value) => (value == null ? '—' : new Intl.NumberFormat('en-US').format(value));
const compact = (value) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(0)}%`);
const validDate = (value) => value && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0;
const timestamp = (value) =>
  validDate(value)
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    : 'Unknown';

// Recorded input over the shared interval, split into uncached, cached-read
// and cache-write shares, on the same grid as a quota line so the two read
// as one list: label, bar, total, cached share.
export function UsageLine({ record, state, compact: dense = false }) {
  const total = record && record.inputSamples !== 0 ? record.inputTokens : null;
  const complete =
    total > 0 &&
    record.inconsistentCacheRows === 0 &&
    record.inputSamples === record.records &&
    record.cacheReadSamples === record.records &&
    record.cacheWriteSamples === record.records &&
    record.uncachedInputSamples === record.records;
  const read = total > 0 ? (record.cacheReadTokens / total) * 100 : 0;
  const write = total > 0 ? (record.cacheWriteTokens / total) * 100 : 0;
  const evidence = state
    ? state
    : !record
      ? 'No recorded attempts in the shared interval.'
      : `${number(total)} recorded input tokens across ${number(record.inputSamples)} of ${number(record.records)} attempts. Cached reads ${number(record.cacheReadTokens)} (${number(record.cacheReadSamples)} samples); cache writes ${number(record.cacheWriteTokens)} (${number(record.cacheWriteSamples)} samples).${complete ? '' : ' The split is not complete for every attempt, so no shares are drawn.'}`;
  return (
    <div className={styles.line} data-usage data-compact={dense || undefined}>
      {dense ? null : (
        <span className={styles.lineLabel} data-static title={evidence}>
          Usage
        </span>
      )}
      <Tooltip label={evidence}>
        <div className={styles.meter} data-unknown={!complete || undefined} aria-hidden="true">
          {complete ? (
            <span className={styles.shares}>
              <i style={{ width: `${Math.max(0, 100 - read - write)}%` }} data-share="input" />
              <i style={{ width: `${read}%` }} data-share="read" />
              <i style={{ width: `${write}%` }} data-share="write" />
            </span>
          ) : null}
        </div>
      </Tooltip>
      <span className={styles.lineValue} data-usage>
        {state || !record || total == null ? '—' : compact(total)}
      </span>
      <span className={styles.lineReset}>
        {!state && total > 0 && Number.isFinite(record.cacheReadFraction)
          ? `${pct(record.cacheReadFraction)} read`
          : ''}
      </span>
    </div>
  );
}

// Stored reset deadlines over the next seven days, one diamond each, above
// the accounts. Selecting one lands on that account's window.
export function ResetHorizon({ rows, anchor, onSelect }) {
  const { colorScheme } = useMantineColorScheme();
  const future = useMemo(
    () =>
      rows.flatMap((row) =>
        (row.windows || [])
          .filter(
            (window) =>
              validDate(window.resetAt) &&
              Date.parse(window.resetAt) > anchor &&
              Date.parse(window.resetAt) <= anchor + 7 * 86400000
          )
          .map((window) => ({
            ...window,
            connectionId: row.connectionId,
            account: row.displayName || row.name || row.connectionId,
          }))
      ),
    [rows, anchor]
  );
  const option = useMemo(() => {
    const theme = chartThemeColors(colorScheme);
    const palette = chartMetricColors();
    return {
      grid: { left: 8, right: 10, top: 8, bottom: 20 },
      tooltip: {
        trigger: 'item',
        renderMode: 'html',
        appendTo: 'body',
        confine: false,
        formatter: (item) =>
          `${item.data.account}<br/>${item.data.scope}<br/>${timestamp(item.value[0])} UTC`,
      },
      xAxis: {
        type: 'time',
        min: anchor,
        max: anchor + 7 * 86400000,
        axisLabel: {
          color: theme.slate,
          fontSize: 11,
          hideOverlap: true,
          formatter: (value) =>
            new Date(value).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            }),
        },
        axisLine: { lineStyle: { color: theme.rule } },
        splitLine: { show: true, lineStyle: { color: theme.rule } },
        axisTick: { show: false },
      },
      yAxis: { type: 'value', min: 0, max: 2, show: false },
      series: [
        {
          type: 'scatter',
          symbol: 'diamond',
          symbolSize: 9,
          itemStyle: { color: palette.input, opacity: 0.85 },
          data: future.map((window, index) => ({
            value: [Date.parse(window.resetAt), 0.7 + (index % 3) * 0.3],
            connectionId: window.connectionId,
            account: window.account,
            scope: window.scope,
          })),
        },
      ],
    };
  }, [anchor, future, colorScheme]);
  return (
    <div className={styles.horizon} role="group" aria-label="Reset horizon">
      <div className={styles.horizonTitle}>
        <h3>Reset horizon</h3>
        <span>{future.length} in the next 7 days</span>
      </div>
      <div className={styles.horizonChart}>
        <AnalyticalChart
          option={option}
          height={40}
          label={`${future.length} recorded quota reset deadlines in the next seven days. Select one to open that account's window.`}
          onEvents={{
            click: (event) => {
              if (event.data?.connectionId) onSelect(event.data.connectionId, event.data.scope);
            },
          }}
        />
      </div>
      <Select
        size="xs"
        aria-label="Inspect a reset deadline"
        placeholder="Inspect deadline"
        searchable
        clearable
        value={null}
        onChange={(value) => {
          const chosen = future.find((window) => `${window.connectionId}:${window.scope}` === value);
          if (chosen) onSelect(chosen.connectionId, chosen.scope);
        }}
        data={future.map((window) => ({
          value: `${window.connectionId}:${window.scope}`,
          label: `${timestamp(window.resetAt)} · ${window.account} · ${window.scope}`,
        }))}
        comboboxProps={{ width: 480 }}
        className={styles.horizonPick}
      />
      <span className={styles.legend} aria-hidden="true">
        <i data-share="input" />Uncached<i data-share="read" />Cached read<i data-share="write" />Cache write
      </span>
    </div>
  );
}
