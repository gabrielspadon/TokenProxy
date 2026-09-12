'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Loader, SegmentedControl, Select } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
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
  { value: 'inputTokens', samples: 'inputSamples', label: 'Tokens in', token: '--metric-input' },
  { value: 'outputTokens', samples: 'outputSamples', label: 'Tokens out', token: '--metric-output' },
  { value: 'cacheReadTokens', samples: 'cacheReadSamples', label: 'Cache read', token: '--metric-cache' },
  { value: 'cacheWriteTokens', samples: 'cacheWriteSamples', label: 'Cache write', token: '--metric-write' },
];
const WEEKDAYS = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
];
const monthLabel = (ms) =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(ms);
const dayLabel = (ms) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(ms);
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
      { top: 18, height: 66, left: 52, right: 12 },
      { top: 114, height: 66, left: 52, right: 12 },
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
    grid: [{ top: 14, height: 128, left: 52, right: 12 }],
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
      line(
        'Cache read',
        'cacheReadTokens',
        METRIC_COLORS.cacheRead,
        0,
        'cacheReadSamples',
        plot,
        style
      ),
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

// Daily totals of all four token metrics on one month grid. A bucket is
// attributed to the UTC day it starts in. Absence and a recorded zero are
// carried separately all the way to the readout: `measured` counts the buckets
// that actually reported a metric, so a day whose cache write was never
// reported can never be summed into the same shape as a day that reported 0.
export function capacityCalendarDays(points) {
  const byDay = new Map();
  for (const point of points) {
    if (!Number.isFinite(point?.bucketStartMs)) continue;
    const key = day(point.bucketStartMs);
    let entry = byDay.get(key);
    if (!entry) {
      entry = { day: key, buckets: 0, metrics: {} };
      for (const item of CALENDAR_METRICS) entry.metrics[item.value] = { total: 0, measured: 0 };
      byDay.set(key, entry);
    }
    entry.buckets += 1;
    for (const item of CALENDAR_METRICS) {
      const value = measured(point, item.value, item.samples);
      if (value === null) continue;
      const cell = entry.metrics[item.value];
      cell.total += value;
      cell.measured += 1;
    }
  }
  return byDay;
}

export const capacityMonthStart = (ms) => {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
// Month arithmetic on the UTC calendar, so a step never lands on the 31st of a
// 30-day month and never shifts across a year boundary by an hour.
export const capacityShiftMonth = (ms, months) => {
  const date = new Date(capacityMonthStart(ms));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
};
// Five steps so a small positive total is always visibly separate from a
// recorded zero, and each metric is scaled against its own maximum in the
// month: cache reads are routinely an order of magnitude above output tokens,
// and one shared scale would flatten the smaller pair into the zero plate.
export const capacityCalendarLevel = (value, max) =>
  !Number.isFinite(value) || value <= 0 || !(max > 0) ? 0 : Math.min(4, Math.ceil((value / max) * 4));

export function capacityCalendarMonth(points, monthMs, window = null) {
  const byDay = capacityCalendarDays(points);
  const monthStartMs = capacityMonthStart(monthMs);
  const monthEndMs = capacityShiftMonth(monthStartMs, 1);
  const start = new Date(monthStartMs);
  const dayCount = Math.round((monthEndMs - monthStartMs) / DAY);
  // Monday-first: getUTCDay is 0 for Sunday, so Sunday leads six blanks.
  const lead = (start.getUTCDay() + 6) % 7;
  const days = Array.from({ length: dayCount }, (_, index) => {
    const dayMs = monthStartMs + index * DAY;
    const key = day(dayMs);
    // Outside the asked period the query never looked, so the day is unasked
    // rather than unreported. Saying "not reported" there would claim evidence
    // of absence the request never sought.
    const outside = Boolean(
      window &&
        ((Number.isFinite(window.startMs) && dayMs + DAY <= window.startMs) ||
          (Number.isFinite(window.endMs) && dayMs >= window.endMs))
    );
    return { dayMs, day: key, date: index + 1, outside, entry: outside ? null : byDay.get(key) || null };
  });
  const maxima = Object.fromEntries(
    CALENDAR_METRICS.map((item) => [
      item.value,
      Math.max(
        0,
        ...days.map((cell) =>
          cell.entry?.metrics[item.value].measured ? cell.entry.metrics[item.value].total : 0
        )
      ),
    ])
  );
  const cells = [...Array.from({ length: lead }, () => null), ...days];
  while (cells.length % 7) cells.push(null);
  return {
    monthStartMs,
    monthEndMs,
    label: monthLabel(monthStartMs),
    weeks: Array.from({ length: cells.length / 7 }, (_, index) =>
      cells.slice(index * 7, index * 7 + 7)
    ),
    days,
    maxima,
    recordedDays: days.filter((cell) => cell.entry).length,
    askedDays: days.filter((cell) => !cell.outside).length,
  };
}

// One reading per day, used by the visible readout, by the accessible name and
// by the tests. Every metric says one of three things and never blurs two:
// a total with its unit, "0 tokens" when zero was reported, "not reported"
// when no bucket carried the field.
export function capacityCalendarReading(cell) {
  const values = CALENDAR_METRICS.map((item) => {
    if (cell?.outside) return { ...item, reported: false, text: 'outside the selected period' };
    const metric = cell?.entry?.metrics[item.value];
    if (!metric || !metric.measured) return { ...item, reported: false, text: 'not reported' };
    const partial = metric.measured < cell.entry.buckets;
    return {
      ...item,
      reported: true,
      total: metric.total,
      text: `${number(metric.total)} tokens${partial ? ` (${number(metric.measured)} of ${number(cell.entry.buckets)} intervals reported)` : ''}`,
    };
  });
  const date = cell ? dayLabel(cell.dayMs) : null;
  return {
    date,
    values,
    label: cell
      ? `${date}. ${cell.outside ? 'Outside the selected period. ' : cell.entry ? '' : 'No recorded attempts. '}${values.map((item) => `${item.label} ${item.text}`).join('. ')}.`
      : null,
  };
}

const ARROWS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function CapacityCalendar({ month, selectedDay, onSelect }) {
  const grid = useRef(null);
  const moved = useRef(false);
  const [active, setActive] = useState(null);
  const [focused, setFocused] = useState(null);
  const inMonth = (key) => month.days.some((cell) => cell.day === key);
  const anchor =
    (focused && inMonth(focused) && focused) ||
    (selectedDay && inMonth(selectedDay) && selectedDay) ||
    month.days.find((cell) => cell.entry)?.day ||
    month.days.find((cell) => !cell.outside)?.day ||
    month.days[0].day;
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector(`[data-day="${anchor}"]`)?.focus();
  }, [anchor]);
  const shown = month.days.find((cell) => cell.day === (active || selectedDay)) || null;
  const reading = capacityCalendarReading(shown);
  function step(from, delta) {
    const index = month.days.findIndex((cell) => cell.day === from);
    const next = month.days[Math.min(month.days.length - 1, Math.max(0, index + delta))];
    if (!next || next.day === from) return;
    moved.current = true;
    setFocused(next.day);
    setActive(next.day);
  }
  function keys(event, cell) {
    if (event.key in ARROWS) {
      event.preventDefault();
      step(cell.day, ARROWS[event.key]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      step(cell.day, (event.key === 'Home' ? -1 : 1) * month.days.length);
    }
  }
  return (
    <div className={styles.calendar}>
      <div className={styles.legend} role="list" aria-label="Calendar metrics">
        <span className={styles.legendKey} role="listitem">
          <i className={styles.legendQuadrants} aria-hidden="true">
            {CALENDAR_METRICS.map((item) => (
              <b key={item.value} style={{ background: `var(${item.token})` }} />
            ))}
          </i>
          Each day, in this order
        </span>
        {CALENDAR_METRICS.map((item) => (
          <span className={styles.legendKey} role="listitem" key={item.value}>
            <i style={{ background: `var(${item.token})` }} />
            {item.label}
          </span>
        ))}
        <span className={styles.legendKey} role="listitem">
          <i data-level="0" />0 recorded
        </span>
        <span className={styles.legendKey} role="listitem">
          <i data-absent="true" />
          Not reported
        </span>
      </div>
      <table className={styles.month} ref={grid}>
        <caption>
          {month.label}. Daily token totals in UTC, four metrics per day. Move with the arrow
          keys; select a day to focus the page on it.
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th key={long} scope="col" abbr={long}>
                <span aria-hidden="true">{short}</span>
                <span className={styles.only}>{long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {month.weeks.map((week, index) => (
            <tr key={week.find(Boolean)?.day || index}>
              {week.map((cell, position) =>
                cell ? (
                  <td key={cell.day}>
                    <button
                      type="button"
                      data-day={cell.day}
                      data-selected={cell.day === selectedDay ? 'true' : undefined}
                      aria-pressed={cell.day === selectedDay}
                      aria-label={capacityCalendarReading(cell).label}
                      tabIndex={cell.day === anchor ? 0 : -1}
                      onFocus={() => setActive(cell.day)}
                      onBlur={() => setActive(null)}
                      onMouseEnter={() => setActive(cell.day)}
                      onMouseLeave={() => setActive(null)}
                      onKeyDown={(event) => keys(event, cell)}
                      onClick={() => onSelect(cell.day)}
                    >
                      <span className={styles.date} aria-hidden="true">
                        {cell.date}
                      </span>
                      <span className={styles.quadrants} aria-hidden="true">
                        {CALENDAR_METRICS.map((item) => {
                          const metric = cell.entry?.metrics[item.value];
                          const reported = Boolean(metric?.measured);
                          return (
                            <b
                              key={item.value}
                              style={{ '--quadrant': `var(${item.token})` }}
                              data-absent={reported ? undefined : cell.outside ? 'unasked' : 'true'}
                              data-level={
                                reported
                                  ? capacityCalendarLevel(metric.total, month.maxima[item.value])
                                  : undefined
                              }
                            />
                          );
                        })}
                      </span>
                    </button>
                  </td>
                ) : (
                  <td key={`blank-${index}-${position}`} />
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.readout} aria-live="polite">
        {shown ? (
          <>
            <b>{reading.date}</b>
            {reading.values.map((item) => (
              <span key={item.value} data-reported={item.reported ? 'true' : undefined}>
                <i style={{ background: `var(${item.token})` }} aria-hidden="true" />
                {item.label} {item.text}
              </span>
            ))}
          </>
        ) : (
          <>
            <b>{month.label}</b>
            <span>
              {month.askedDays
                ? `${number(month.recordedDays)} of ${number(month.askedDays)} days in the selected period carry recorded attempts. Hover or focus a day for its four totals.`
                : 'No day of this month is inside the selected period. Widen the period to read it.'}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

// One line of truth about whether this panel refreshes itself. The shared
// observation policy already knows; a quiet panel under a paused policy would
// otherwise read as quiet traffic. ui_live owns the control and the wording of
// the modes, this only reports the state it publishes.
export function capacityRefreshStatus(observations, snapshot) {
  if (!observations) return null;
  if (snapshot) return 'Fixed snapshot. This panel does not refresh; no activity since capture is implied.';
  if (observations.mode === 'paused')
    return `Updates paused${observations.pausedAt ? ` at ${utc(observations.pausedAt)} UTC` : ''}. This panel is not refreshing, so later activity is not shown here.`;
  if (observations.mode === 'summary')
    return 'Manual updates. This panel read once when opened and does not refresh on its own.';
  if (observations.historical)
    return 'Fixed UTC range. Live updates apply to current evidence only, so this panel does not refresh.';
  return null;
}

export function CapacityActivity() {
  const workspace = useWorkspace();
  const [chart, setChart] = useLocalStorage({
    key: 'tokenproxy.capacity-chart',
    defaultValue: 'requests',
  });
  const [scale, setScale] = useLocalStorage({
    key: 'tokenproxy.capacity-scale',
    defaultValue: 'auto',
  });
  const [style, setStyle] = useLocalStorage({
    key: 'tokenproxy.capacity-style',
    defaultValue: 'lines',
  });
  const [monthMs, setMonthMs] = useState(null);
  // One clock read per mount. Reading it during render would make the visible
  // month depend on when React happened to re-render.
  const [mountedAt] = useState(() => Date.now());
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
  const option = useMemo(
    () =>
      chart === 'tokens'
        ? capacityTokensOption(points, bucketMs, style)
        : chart === 'requests'
          ? capacityActivityOption(points, bucketMs, style)
          : null,
    [chart, points, bucketMs, style]
  );
  // The month on screen: the operator's own navigation while it is set,
  // otherwise the last month the selected period reaches.
  const latest = scopeEnd
    ? Date.parse(scopeEnd) - 1
    : (points.at(-1)?.bucketStartMs ?? (receivedAt ? Date.parse(receivedAt) : mountedAt));
  const shownMonthMs = monthMs ?? capacityMonthStart(latest);
  // What the current request actually covered, so an unasked day says so.
  const observed = {
    startMs: scopeStart ? Date.parse(scopeStart) : null,
    endMs: scopeEnd ? Date.parse(scopeEnd) : null,
  };
  const month = capacityCalendarMonth(points, shownMonthMs, observed);
  // Only the future is out of bounds. A floor at the earliest retained bucket
  // was tried and locked the operator out of every earlier month the moment a
  // selection narrowed the series to one day.
  const latestMonth = capacityMonthStart(Math.max(latest, mountedAt));
  const shiftMonth = (months) => setMonthMs(capacityShiftMonth(shownMonthMs, months));
  // A period of exactly one whole UTC day is the calendar's own selection.
  const selectedDay =
    Date.parse(scopeEnd) - Date.parse(scopeStart) === DAY && scopeStart?.endsWith('T00:00:00.000Z')
      ? day(Date.parse(scopeStart))
      : null;
  const choose = (point) => {
    const next = capacityBucketScope(point, bucketMs, workspace.scope);
    if (next) workspace.setScope(next);
  };
  const chooseDay = (value) => {
    const next = capacityDayScope(value);
    if (next) {
      setMonthMs(capacityMonthStart(Date.parse(next.start)));
      workspace.setScope(next);
    }
  };
  const fraction = summary?.cacheReadFraction;
  const requestCount =
    summary?.records > 0 && summary?.logicalRequests === 0 && summary?.unattributedAttempts > 0
      ? 'Unknown'
      : number(summary?.logicalRequests);
  const legend = chart === 'tokens' ? TOKEN_LEGEND : chart === 'requests' ? REQUEST_LEGEND : null;
  const refreshStatus = capacityRefreshStatus(workspace.observations, workspace.snapshot);
  return (
    <section className={styles.activity} aria-label="Requests and cache activity">
      <header className={styles.header}>
        <h2>Requests &amp; cache</h2>
        <div className={styles.selectors}>
          {chart === 'calendar' ? (
            <div className={styles.period}>
              <Button
                size="compact-xs"
                variant="default"
                aria-label="Previous month"
                onClick={() => shiftMonth(-1)}
              >
                ‹
              </Button>
              <b>{month.label}</b>
              <Button
                size="compact-xs"
                variant="default"
                aria-label="Next month"
                disabled={shownMonthMs >= latestMonth}
                onClick={() => shiftMonth(1)}
              >
                ›
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                disabled={shownMonthMs === capacityMonthStart(latest)}
                onClick={() => setMonthMs(null)}
              >
                Latest month
              </Button>
            </div>
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
      ) : (
        <>
          {!points.length ? (
            // The figures above come from the SUMMARY and this sentence was gated on
            // the SERIES, so a response carrying one without the other said "no
            // recorded activity" directly beneath a non-zero attempt count. Say what
            // is actually missing: the attempts are real, only the per-bucket series
            // that draws the chart is absent.
            <div className={styles.state}>
              {summary?.records > 0
                ? 'No per-interval series to chart for this period. The totals above still apply.'
                : 'No recorded activity for this period. Account controls remain available below.'}
            </div>
          ) : null}
          {chart === 'calendar' ? (
            // The month grid stands whether or not a series arrived: with no
            // series every day reads "not reported", which is the honest
            // reading and the one a blank chart could not give.
            <CapacityCalendar month={month} selectedDay={selectedDay} onSelect={chooseDay} />
          ) : !points.length ? null : (
            <>
              {legend ? (
                <div className={styles.legend}>
                  {option.series.map((series, index) => (
                    <span key={series.name}>
                      <i
                        style={{ background: `var(${legend[index]}, ${series.itemStyle.color})` }}
                      />
                      {series.name}
                    </span>
                  ))}
                </div>
              ) : null}
              <AnalyticalChart
                key={chart}
                option={option}
                height={chart === 'tokens' ? 172 : 208}
                label={
                  chart === 'tokens'
                    ? 'Input, output, cache read and cache write tokens over the selected UTC period. Select an interval to focus on it.'
                    : 'Requests, attempts and cache tokens over the selected UTC period. Counts and tokens use separate aligned tracks. Select an interval to focus on it.'
                }
                onEvents={{
                  click: (event) => choose(points.find((point) => point.bucketStartMs === event.value?.[0])),
                }}
              />
            </>
          )}
        </>
      )}
      <footer className={styles.foot}>
        <span>
          {chart === 'calendar'
            ? `Daily token totals · UTC. Recorded input is cache-inclusive, so the four quadrants are quantities, not a cost split.${Number.isFinite(bucketMs) && bucketMs > DAY ? ` This period is too long for whole days, so each bucket covers ${interval(bucketMs)} and lands on the day it starts in.` : ''} Select a day to focus.`
            : `${Number.isFinite(bucketMs) ? `${interval(bucketMs)} intervals${bucket && bucketMs > bucket ? ` (the ${interval(bucket)} scale is too fine for this period)` : ''} · UTC. Select an interval to focus.` : 'Selected UTC period.'}`}{' '}
          {resource.receivedAt ? `Updated ${utc(resource.receivedAt)} UTC.` : ''}
        </span>
        {refreshStatus ? <span data-refresh-status>{refreshStatus}</span> : null}
        {summary?.unattributedAttempts > 0 ? (
          <span>{number(summary.unattributedAttempts)} attempts have no request ID.</span>
        ) : null}
      </footer>
    </section>
  );
}
