// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workspace: null, chart: null, urls: [], own: null }));
vi.mock('@/shared/workspace/WorkspaceProvider', async () => ({
  ...(await import('@/shared/workspace/WorkspaceProvider')),
  useWorkspace: () => state.workspace,
}));
// A chosen scale and the calendar read their own series; the mock records the URL.
vi.mock('@/shared/workspace/useResource', () => ({
  useResource: url => { state.urls.push(url); return url ? state.own : { data: null, loading: false, error: null, refresh: () => {}, receivedAt: null }; },
}));
vi.mock('@/shared/workspace/AnalyticalChart', async () => ({
  ...(await import('@/shared/workspace/metricColors')),
  AnalyticalChart: props => { state.chart = props; return <div aria-label={props.label} />; },
}));
import { CALENDAR_METRICS, CapacityActivity, capacityActivityOption, capacityBucketScope, capacityCalendarDays, capacityCalendarLevel, capacityCalendarMonth, capacityCalendarReading, capacityDayScope, capacityMonthStart, capacityRefreshStatus, capacityShiftMonth, capacityTokensOption } from '@/app/dashboard/CapacityActivity';
let root, host;
const start = Date.parse('2026-09-07T12:00:00Z');
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const points = Array.from({ length: 8 }, (_, index) => ({ bucketStartMs: start + index * 60000, bucketStart: new Date(start + index * 60000).toISOString(), logicalRequests: 2, records: 3, failed: 1, cacheReadTokens: 900, cacheWriteTokens: 100, cacheReadSamples: 2, cacheWriteSamples: 2 }));
  state.workspace = { scope: { provider: 'codex', start: new Date(start + 30000).toISOString(), end: new Date(start + 8 * 60000).toISOString() }, setScope: vi.fn(), activity: {
    url: '/api/activity?scope=fixture', refresh: vi.fn(), loading: false, receivedAt: '2026-09-07T12:09:00Z',
    data: { source: 'requestStats', summary: { records: 24, logicalRequests: 10, unattributedAttempts: 4, failed: 8, cacheReadFraction: 0.75 }, series: { bucketMs: 60000, points } },
  } };
  state.own = { ...state.workspace.activity, url: '/api/activity?own' };
  state.urls = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<MantineProvider env="test"><CapacityActivity /></MantineProvider>));

it('keeps logical request totals, attempts and paired cache token share distinct', async () => {
  await render();
  const summary = [...host.querySelectorAll('dl > div')].map(node => node.textContent);
  expect(summary).toEqual(['Requests with an ID10', 'Attempts24', 'Failed attempts8', 'Cache read share of input75%']);
  expect(host.textContent).toContain('4 attempts have no request ID');
  expect(state.chart.option.yAxis.map(axis => axis.name)).toEqual(['Count', 'Tokens']);
  expect(state.chart.option.series[0].data[0][1]).toBe(2);
  expect(state.chart.option.series[1].data[0][1]).toBe(3);
  expect(state.chart.option.series.every(series => series.showSymbol && series.showAllSymbol)).toBe(true);
  expect(state.chart.option.tooltip).toMatchObject({ renderMode: 'html', appendTo: 'body', confine: false });
  await act(async () => host.querySelector('[value="tokens"]').click());
  expect(state.chart.option.series.map(series => series.name)).toEqual(['Tokens in', 'Tokens out', 'Cache read', 'Cache write']);
  expect(host.querySelector('[aria-label="Calendar metric"]')).toBeNull();
  state.chart = null;
  await act(async () => host.querySelector('[value="calendar"]').click());
  // Every metric shows at once: no exclusive picker, and no chart at all.
  expect(host.querySelector('[aria-label="Calendar metric"]')).toBeNull();
  expect(state.chart).toBeNull();
  expect(state.urls.at(-1)).toContain('bucketMs=86400000');
  expect(host.querySelector('table caption').textContent).toContain('September 2026');
  expect([...host.querySelectorAll('[role="listitem"]')].map(node => node.textContent))
    .toEqual(['Each day, in this order', 'Tokens in', 'Tokens out', 'Cache read', 'Cache write', '0 recorded', 'Not reported']);
  expect([...host.querySelectorAll('thead th')].map(node => node.getAttribute('abbr')))
    .toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  // Four quadrants per day in one fixed order, and one tab stop for the month.
  const cell = host.querySelector('[data-day="2026-09-07"]');
  expect(cell.querySelectorAll('span > b')).toHaveLength(4);
  expect([...host.querySelectorAll('[data-day]')].filter(node => node.tabIndex === 0)).toHaveLength(1);
});

it('offers a scale and a style for the time charts, and four fixed metrics for the calendar', async () => {
  await render();
  expect(state.urls.every(url => url === null)).toBe(true);
  expect(host.querySelector('[aria-label="Chart scale"]')).not.toBeNull();
  await act(async () => host.querySelector('[value="bars"]').click());
  expect(state.chart.option.series.every(series => series.type === 'bar')).toBe(true);
  await act(async () => host.querySelector('[value="area"]').click());
  expect(state.chart.option.series.every(series => series.type === 'line' && series.areaStyle)).toBe(true);
  await act(async () => root.unmount());
  // The server raised a one-minute request to one hour for this period.
  localStorage.setItem('tokenproxy.capacity-scale', JSON.stringify('60000'));
  state.own = { ...state.own, data: { ...state.own.data, series: { ...state.own.data.series, bucketMs: 3600000 } } };
  root = createRoot(host);
  await render();
  expect(state.urls.at(-1)).toContain('bucketMs=60000');
  expect(state.urls.at(-1)).toContain('provider=codex');
  expect(host.textContent).toContain('1-hour intervals (the 1-minute scale is too fine for this period)');
  expect(CALENDAR_METRICS.map(item => [item.label, item.value, item.samples, item.token])).toEqual([
    ['Tokens in', 'inputTokens', 'inputSamples', '--metric-input'],
    ['Tokens out', 'outputTokens', 'outputSamples', '--metric-output'],
    ['Cache read', 'cacheReadTokens', 'cacheReadSamples', '--metric-cache'],
    ['Cache write', 'cacheWriteTokens', 'cacheWriteSamples', '--metric-write'],
  ]);
});

it('sums every metric per UTC day and keeps an unreported metric out of the totals', () => {
  const points = [
    { bucketStartMs: Date.parse('2026-09-07T23:30:00Z'), cacheReadTokens: 10, cacheReadSamples: 1, cacheWriteTokens: 4, cacheWriteSamples: 1 },
    { bucketStartMs: Date.parse('2026-09-07T23:45:00Z'), cacheReadTokens: 5, cacheReadSamples: 1, cacheWriteTokens: 9, cacheWriteSamples: 0 },
    { bucketStartMs: Date.parse('2026-09-08T00:15:00Z'), cacheReadTokens: 7, cacheReadSamples: 1 },
    { bucketStartMs: Date.parse('2026-09-08T01:00:00Z'), cacheReadTokens: 99, cacheReadSamples: 0 },
  ];
  const days = capacityCalendarDays(points);
  expect(days.get('2026-09-07').metrics.cacheReadTokens).toEqual({ total: 15, measured: 2 });
  // The 9-token write was never measured, so it is absent rather than summed.
  expect(days.get('2026-09-07').metrics.cacheWriteTokens).toEqual({ total: 4, measured: 1 });
  expect(days.get('2026-09-08').metrics.cacheReadTokens).toEqual({ total: 7, measured: 1 });
  expect(days.get('2026-09-08').metrics.cacheWriteTokens).toEqual({ total: 0, measured: 0 });
  expect(days.get('2026-09-08').buckets).toBe(2);
  expect(capacityDayScope('2026-09-08')).toEqual({ period: 'custom', start: '2026-09-08T00:00:00.000Z', end: '2026-09-09T00:00:00.000Z' });
  expect(capacityDayScope('nope')).toBeNull();
  const tokens = capacityTokensOption([{ bucketStartMs: start, inputTokens: 40, inputSamples: 2, outputTokens: 0, outputSamples: 0 }], 60000);
  expect(tokens.series[0].data).toEqual([[start, 40]]);
  expect(tokens.series[1].data).toEqual([[start, null]]);
});

it('separates a reported zero, an unreported metric and a day with no attempts at all', () => {
  const points = [
    // An explicit zero day: every metric measured, all four totals zero.
    { bucketStartMs: Date.parse('2026-09-02T04:00:00Z'), inputTokens: 0, inputSamples: 3, outputTokens: 0, outputSamples: 3, cacheReadTokens: 0, cacheReadSamples: 3, cacheWriteTokens: 0, cacheWriteSamples: 3 },
    // Historical rows carrying no cache write field at all.
    { bucketStartMs: Date.parse('2026-09-03T04:00:00Z'), inputTokens: 1200, inputSamples: 2, outputTokens: 300, outputSamples: 2, cacheReadTokens: 800, cacheReadSamples: 2 },
  ];
  const month = capacityCalendarMonth(points, Date.parse('2026-09-15T00:00:00Z'));
  const zero = capacityCalendarReading(month.days[1]);
  expect(zero.values.map(item => [item.label, item.reported, item.text])).toEqual([
    ['Tokens in', true, '0 tokens'], ['Tokens out', true, '0 tokens'],
    ['Cache read', true, '0 tokens'], ['Cache write', true, '0 tokens'],
  ]);
  expect(zero.label).toBe('Wednesday, 2 September 2026. Tokens in 0 tokens. Tokens out 0 tokens. Cache read 0 tokens. Cache write 0 tokens.');
  const missingWrite = capacityCalendarReading(month.days[2]);
  expect(missingWrite.values.map(item => [item.reported, item.text])).toEqual([
    [true, '1,200 tokens'], [true, '300 tokens'], [true, '800 tokens'], [false, 'not reported'],
  ]);
  // A day with no rows says so and still reports every metric as unknown.
  const silent = capacityCalendarReading(month.days[3]);
  expect(silent.values.every(item => item.reported === false && item.text === 'not reported')).toBe(true);
  expect(silent.label).toBe('Friday, 4 September 2026. No recorded attempts. Tokens in not reported. Tokens out not reported. Cache read not reported. Cache write not reported.');
  expect(month.recordedDays).toBe(2);
  // A zero total is never a level, so it can never paint like a small total.
  expect(capacityCalendarLevel(0, 1000)).toBe(0);
  expect([1, 250, 251, 500, 501, 750, 751, 1000].map(value => capacityCalendarLevel(value, 1000))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  expect(capacityCalendarLevel(5, 0)).toBe(0);
});

it('aligns weekdays and dates across month, year and timezone boundaries', () => {
  // 1 February 2026 is a Sunday: six leading blanks, Monday-first.
  const february = capacityCalendarMonth([], Date.parse('2026-02-17T00:00:00Z'));
  expect(february.days).toHaveLength(28);
  expect(february.weeks[0].slice(0, 6).every(cell => cell === null)).toBe(true);
  expect(february.weeks[0][6]).toMatchObject({ date: 1, day: '2026-02-01' });
  expect(february.label).toBe('February 2026');
  // A leap February keeps 29 days.
  expect(capacityCalendarMonth([], Date.parse('2024-02-10T00:00:00Z')).days).toHaveLength(29);
  // December steps into January of the next year, and back again.
  const december = capacityMonthStart(Date.parse('2026-12-31T23:59:59Z'));
  expect(capacityShiftMonth(december, 1)).toBe(Date.parse('2027-01-01T00:00:00Z'));
  expect(capacityShiftMonth(december, -1)).toBe(Date.parse('2026-11-01T00:00:00Z'));
  // A 31st never leaks into a 30-day month.
  expect(capacityShiftMonth(Date.parse('2026-03-31T12:00:00Z'), 1)).toBe(Date.parse('2026-04-01T00:00:00Z'));
  // Adjacent dates stay adjacent, and every week is exactly seven columns.
  const march = capacityCalendarMonth([], Date.parse('2026-03-01T00:00:00Z'));
  expect(march.weeks.every(week => week.length === 7)).toBe(true);
  expect(march.days.map(cell => cell.day).slice(0, 3)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
  // A bucket just before UTC midnight belongs to the earlier day even when the
  // host clock is ahead of UTC; the grid is UTC throughout.
  const boundary = capacityCalendarMonth([{ bucketStartMs: Date.parse('2026-03-31T23:59:00Z'), inputTokens: 5, inputSamples: 1 }], Date.parse('2026-03-05T00:00:00Z'));
  expect(boundary.days.at(-1)).toMatchObject({ day: '2026-03-31', date: 31 });
  expect(boundary.days.at(-1).entry.metrics.inputTokens.total).toBe(5);
});

it('scales each metric against its own month maximum so a small metric stays visible', () => {
  const points = [
    { bucketStartMs: Date.parse('2026-09-01T04:00:00Z'), outputTokens: 40, outputSamples: 1, cacheReadTokens: 4_000_000, cacheReadSamples: 1 },
    { bucketStartMs: Date.parse('2026-09-02T04:00:00Z'), outputTokens: 160, outputSamples: 1, cacheReadTokens: 1_000_000, cacheReadSamples: 1 },
  ];
  const month = capacityCalendarMonth(points, Date.parse('2026-09-10T00:00:00Z'));
  expect(month.maxima).toEqual({ inputTokens: 0, outputTokens: 160, cacheReadTokens: 4_000_000, cacheWriteTokens: 0 });
  // 40 output tokens beside a 4M cache read would vanish on a shared scale.
  expect(capacityCalendarLevel(40, month.maxima.outputTokens)).toBe(1);
  expect(capacityCalendarLevel(160, month.maxima.outputTokens)).toBe(4);
});

it('reports a partially covered metric as a total plus its interval coverage', () => {
  const month = capacityCalendarMonth([
    { bucketStartMs: Date.parse('2026-09-05T01:00:00Z'), inputTokens: 90, inputSamples: 2 },
    { bucketStartMs: Date.parse('2026-09-05T02:00:00Z'), inputTokens: 10, inputSamples: 0 },
  ], Date.parse('2026-09-05T00:00:00Z'));
  expect(capacityCalendarReading(month.days[4]).values[0].text).toBe('90 tokens (1 of 2 intervals reported)');
});

it('says when this panel is not refreshing itself rather than letting a quiet page imply quiet traffic', () => {
  expect(capacityRefreshStatus(null, null)).toBeNull();
  expect(capacityRefreshStatus({ mode: 'live', background: true, historical: false }, null)).toBeNull();
  expect(capacityRefreshStatus({ mode: 'summary', background: false }, null)).toContain('does not refresh on its own');
  expect(capacityRefreshStatus({ mode: 'paused', background: false, pausedAt: '2026-09-07T12:00:00Z' }, null))
    .toBe('Updates paused at 07 Sept, 12:00 UTC. This panel is not refreshing, so later activity is not shown here.');
  expect(capacityRefreshStatus({ mode: 'live', background: false, historical: true }, null)).toContain('does not refresh');
  expect(capacityRefreshStatus({ mode: 'live', background: false }, { capturedAt: '2026-09-01T00:00:00Z' })).toContain('Fixed snapshot');
});

it('preserves missing token samples and sparse gaps instead of drawing measured zeros', () => {
  const option = capacityActivityOption([{ bucketStartMs: start, cacheReadTokens: 0, cacheReadSamples: 0 }, { bucketStartMs: start + 120000, cacheReadTokens: 60, cacheReadSamples: 1 }], 60000);
  expect(option.series[3].data).toEqual([[start, null], [start + 60000, null], [start + 120000, 60]]);
  expect(option.series[3].connectNulls).toBe(false);
});

it('bounds both tracks to the full covered minute when only one bucket remains', () => {
  const singleStart = Date.parse('2026-09-07T11:58:00.000Z');
  const option = capacityActivityOption([{ bucketStartMs: singleStart, logicalRequests: 1, records: 1 }], 60000);
  for (const axis of option.xAxis) {
    expect(axis.min).toBe(singleStart);
    expect(axis.max).toBe(Date.parse('2026-09-07T11:59:00.000Z'));
    expect(axis.minInterval).toBe(60000);
    expect(axis.splitNumber).toBe(4);
    expect(axis.axisLabel.formatter(axis.min)).toBe('11:58');
    expect(axis.axisLabel.formatter(axis.max)).toBe('11:59');
  }
  expect(option.series[0].data).toEqual([[singleStart, 1]]);
});

it('retains dates across UTC midnight even within a short interval', () => {
  const midnight = Date.parse('2026-09-08T00:00:00Z');
  const option = capacityActivityOption([{ bucketStartMs: midnight - 60000 }], 60000);
  const axis = option.xAxis[1];
  expect(axis.axisLabel.formatter(axis.min)).toBe('07 Sept, 23:59');
  expect(axis.axisLabel.formatter(axis.max)).toBe('08 Sept, 00:00');
});

it('keeps multi-day ticks distinct and supports seconds only for sub-minute buckets', () => {
  const days = capacityActivityOption([{ bucketStartMs: start }, { bucketStartMs: start + 2 * 86400000 }], 60000).xAxis[1];
  expect(days.axisLabel.formatter(days.min)).toBe('07 Sept, 12:00');
  expect(days.axisLabel.formatter(days.max)).toBe('09 Sept, 12:01');
  const seconds = capacityActivityOption([{ bucketStartMs: start + 15000 }], 15000).xAxis[1];
  expect(seconds.minInterval).toBe(15000);
  expect(seconds.axisLabel.formatter(seconds.min)).toBe('12:00:15');
  expect(seconds.axisLabel.formatter(seconds.max)).toBe('12:00:30');
});

it('includes the final bucket end across multiple sparse buckets without changing observations', () => {
  const points = [{ bucketStartMs: start, records: 2 }, { bucketStartMs: start + 120000, records: 1 }];
  const option = capacityActivityOption(points, 60000);
  for (const axis of option.xAxis) {
    expect(axis.min).toBe(start);
    expect(axis.max).toBe(start + 180000);
  }
  expect(option.series[1].data).toEqual([[start, 2], [start + 60000, null], [start + 120000, 1]]);
});

it.each([0, -60000, null, undefined, NaN, Infinity])('leaves the time domain unset for invalid bucket width %s', bucketMs => {
  const points = [{ bucketStartMs: start, records: 1 }, { bucketStartMs: start + 120000, records: 2 }];
  const option = capacityActivityOption(points, bucketMs);
  for (const axis of option.xAxis) {
    expect(axis.min).toBeUndefined();
    expect(axis.max).toBeUndefined();
    expect(axis.minInterval).toBeUndefined();
  }
  expect(option.series[1].data).toEqual([[start, 1], [start + 120000, 2]]);
});

it('leaves empty or overflowing time domains unset', () => {
  for (const option of [capacityActivityOption([], 60000), capacityActivityOption([{ bucketStartMs: Number.MAX_VALUE }], Number.MAX_VALUE)]) {
    for (const axis of option.xAxis) {
      expect(axis.min).toBeUndefined();
      expect(axis.max).toBeUndefined();
    }
  }
});

it('selects a clipped interval from a chart click and a whole day from a calendar cell', async () => {
  await render();
  act(() => state.chart.onEvents.click({ value: [start, 2] }));
  expect(state.workspace.setScope).toHaveBeenLastCalledWith({ period: 'custom', start: new Date(start + 30000).toISOString(), end: new Date(start + 60000).toISOString() });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => host.querySelector('[value="calendar"]').click());
  await act(async () => host.querySelector('[data-day="2026-09-07"]').click());
  expect(state.workspace.setScope).toHaveBeenLastCalledWith({ period: 'custom', start: '2026-09-07T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' });
  expect(state.workspace.setScope).toHaveBeenCalledTimes(2);
  expect(capacityBucketScope({ bucketStartMs: start - 120000 }, 60000, state.workspace.scope)).toBeNull();
  expect(capacityBucketScope({}, 60000, state.workspace.scope)).toBeNull();
});

it('does not turn entirely unattributed history into a known zero requests count', async () => {
  state.workspace.activity.data.summary = { records: 2, logicalRequests: 0, unattributedAttempts: 2, failed: 0, cacheReadFraction: null };
  await render();
  expect(host.querySelector('dl > div').textContent).toBe('Requests with an IDUnknown');
  expect(host.querySelector('dl').textContent).toContain('Cache read share of inputUnknown');
});

it('keeps data failures explicit and retryable', async () => {
  state.workspace.activity.error = 'fixture failure';
  await render();
  expect(host.textContent).toContain('Activity could not be refreshed');
  act(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Try again').click());
  expect(state.workspace.activity.refresh).toHaveBeenCalledOnce();
});

// One fixture with the shapes a real month contains: explicit zeros, a day
// missing only cache write, sparse days, a large count and both month edges.
const CALENDAR_FIXTURE = [
  { bucketStartMs: Date.parse('2026-09-01T06:00:00Z'), records: 4, inputTokens: 9_876_543_210, inputSamples: 4, outputTokens: 120_000, outputSamples: 4, cacheReadTokens: 4_500_000, cacheReadSamples: 4, cacheWriteTokens: 900_000, cacheWriteSamples: 4 },
  { bucketStartMs: Date.parse('2026-09-09T06:00:00Z'), records: 2, inputTokens: 0, inputSamples: 2, outputTokens: 0, outputSamples: 2, cacheReadTokens: 0, cacheReadSamples: 2, cacheWriteTokens: 0, cacheWriteSamples: 2 },
  { bucketStartMs: Date.parse('2026-09-17T06:00:00Z'), records: 3, inputTokens: 5_000, inputSamples: 3, outputTokens: 700, outputSamples: 3, cacheReadTokens: 2_000, cacheReadSamples: 3 },
  { bucketStartMs: Date.parse('2026-09-30T23:30:00Z'), records: 1, inputTokens: 1_500, inputSamples: 1, outputTokens: 90, outputSamples: 1, cacheReadTokens: 400, cacheReadSamples: 1, cacheWriteTokens: 50, cacheWriteSamples: 1 },
];
const calendarWorkspace = (patch = {}) => {
  localStorage.setItem('tokenproxy.capacity-chart', JSON.stringify('calendar'));
  state.workspace = { ...state.workspace, scope: { period: 'all' }, ...patch };
  state.own = { ...state.own, receivedAt: '2026-09-30T23:59:00Z',
    data: { ...state.own.data, series: { bucketMs: 86400000, points: CALENDAR_FIXTURE } } };
};
const quadrants = day => [...host.querySelector(`[data-day="${day}"]`).querySelectorAll('span > b')]
  .map(node => node.dataset.absent ? 'absent' : `level-${node.dataset.level}`);

it('renders four quadrants for every day, hatching only what no bucket reported', async () => {
  calendarWorkspace();
  await render();
  expect(host.querySelector('table caption').textContent).toContain('September 2026');
  expect(host.querySelectorAll('[data-day]')).toHaveLength(30);
  // The busiest day is at the top step for all four metrics.
  expect(quadrants('2026-09-01')).toEqual(['level-4', 'level-4', 'level-4', 'level-4']);
  // A reported zero is level 0 (flat), never hatched.
  expect(quadrants('2026-09-09')).toEqual(['level-0', 'level-0', 'level-0', 'level-0']);
  // Cache write was never reported that day, so only that quadrant is hatched.
  expect(quadrants('2026-09-17')).toEqual(['level-1', 'level-1', 'level-1', 'absent']);
  // A day with no rows at all is hatched throughout; it is unknown, not zero.
  expect(quadrants('2026-09-05')).toEqual(['absent', 'absent', 'absent', 'absent']);
  // The full date and all four values reach a screen reader without hovering.
  expect(host.querySelector('[data-day="2026-09-09"]').getAttribute('aria-label'))
    .toBe('Wednesday, 9 September 2026. Tokens in 0 tokens. Tokens out 0 tokens. Cache read 0 tokens. Cache write 0 tokens.');
  expect(host.querySelector('[data-day="2026-09-17"]').getAttribute('aria-label'))
    .toBe('Thursday, 17 September 2026. Tokens in 5,000 tokens. Tokens out 700 tokens. Cache read 2,000 tokens. Cache write not reported.');
  expect(host.querySelector('[data-day="2026-09-05"]').getAttribute('aria-label')).toContain('No recorded attempts.');
  // A large count keeps its digits rather than becoming a compact glyph.
  expect(host.querySelector('[data-day="2026-09-01"]').getAttribute('aria-label')).toContain('9,876,543,210 tokens');
  expect(host.textContent).toContain('quadrants are quantities, not a cost split');
});

it('gives all four exact values on hover and on keyboard focus, and moves by arrow key', async () => {
  calendarWorkspace();
  await render();
  const readout = () => host.querySelector('p[aria-live="polite"]').textContent;
  expect(readout()).toContain('4 of 30 days carry recorded attempts');
  const focusable = [...host.querySelectorAll('[data-day]')].filter(node => node.tabIndex === 0);
  expect(focusable.map(node => node.dataset.day)).toEqual(['2026-09-01']);
  // Hover carries the same reading as focus.
  await act(async () => host.querySelector('[data-day="2026-09-17"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(readout()).toContain('Thursday, 17 September 2026');
  expect(readout()).toContain('Cache write not reported');
  await act(async () => host.querySelector('[data-day="2026-09-17"]').dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  await act(async () => host.querySelector('[data-day="2026-09-09"]').focus());
  expect(readout()).toContain('Wednesday, 9 September 2026');
  expect(readout()).toContain('Cache read 0 tokens');
  const press = key => act(async () => host.querySelector(`[data-day="${document.activeElement.dataset.day}"]`)
    .dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key, bubbles: true }), {})));
  await press('ArrowRight');
  expect(document.activeElement.dataset.day).toBe('2026-09-10');
  await press('ArrowDown');
  expect(document.activeElement.dataset.day).toBe('2026-09-17');
  expect(readout()).toContain('Thursday, 17 September 2026');
  await press('ArrowUp');
  expect(document.activeElement.dataset.day).toBe('2026-09-10');
  await press('Home');
  expect(document.activeElement.dataset.day).toBe('2026-09-01');
  // Movement stops at the month edge rather than wrapping or leaving the grid.
  await press('ArrowLeft');
  expect(document.activeElement.dataset.day).toBe('2026-09-01');
  await press('End');
  expect(document.activeElement.dataset.day).toBe('2026-09-30');
  // Still one tab stop for the whole month after moving.
  expect([...host.querySelectorAll('[data-day]')].filter(node => node.tabIndex === 0)).toHaveLength(1);
});

it('shows the selected day and navigates months without losing weekday alignment', async () => {
  calendarWorkspace({ scope: { period: 'custom', start: '2026-09-09T00:00:00.000Z', end: '2026-09-10T00:00:00.000Z' } });
  await render();
  const selected = host.querySelector('[data-selected]');
  expect(selected.dataset.day).toBe('2026-09-09');
  expect(selected.getAttribute('aria-pressed')).toBe('true');
  expect([...host.querySelectorAll('[data-day]')].filter(node => node.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  // The selected day's four values are the readout without any pointer.
  expect(host.querySelector('p[aria-live="polite"]').textContent).toContain('Wednesday, 9 September 2026');
  await act(async () => host.querySelector('[aria-label="Previous month"]').click());
  expect(host.querySelector('table caption').textContent).toContain('August 2026');
  expect(host.querySelectorAll('[data-day]')).toHaveLength(31);
  // 1 August 2026 is a Saturday: five leading blanks in a Monday-first week.
  expect(host.querySelectorAll('tbody tr:first-child td:not(:has(button))')).toHaveLength(5);
  expect(host.querySelector('[data-selected]')).toBeNull();
  await act(async () => host.querySelector('[aria-label="Next month"]').click());
  expect(host.querySelector('table caption').textContent).toContain('September 2026');
  expect(host.querySelector('[data-selected]').dataset.day).toBe('2026-09-09');
});

it('updates under Live and stays put under Summary and Paused', async () => {
  calendarWorkspace({ observations: { mode: 'live', background: true, historical: false } });
  await render();
  expect(quadrants('2026-09-20')).toEqual(['absent', 'absent', 'absent', 'absent']);
  expect(host.querySelector('[data-refresh-status]')).toBeNull();
  // A later read adds a day; the same mounted grid takes it.
  await act(async () => {
    state.own = { ...state.own, receivedAt: '2026-09-30T23:59:30Z', data: { ...state.own.data,
      series: { bucketMs: 86400000, points: [...CALENDAR_FIXTURE, { bucketStartMs: Date.parse('2026-09-20T06:00:00Z'), records: 1, inputTokens: 640, inputSamples: 1, outputTokens: 12, outputSamples: 1, cacheReadTokens: 60, cacheReadSamples: 1, cacheWriteTokens: 8, cacheWriteSamples: 1 }] } } };
    root.render(<MantineProvider env="test"><CapacityActivity /></MantineProvider>);
  });
  expect(quadrants('2026-09-20')).toEqual(['level-1', 'level-1', 'level-1', 'level-1']);
  expect(host.querySelector('[data-day="2026-09-20"]').getAttribute('aria-label')).toContain('Tokens in 640 tokens');
  // Summary and Paused both say so: a quiet panel is not quiet traffic.
  for (const [observations, sentence] of [
    [{ mode: 'summary', background: false }, 'does not refresh on its own'],
    [{ mode: 'paused', background: false, pausedAt: '2026-09-30T23:50:00Z' }, 'Updates paused at 30 Sept, 23:50 UTC'],
  ]) {
    await act(async () => { state.workspace = { ...state.workspace, observations }; root.render(<MantineProvider env="test"><CapacityActivity /></MantineProvider>); });
    expect(host.querySelector('[data-refresh-status]').textContent).toContain(sentence);
    // The grid itself is unchanged by the observation mode.
    expect(host.querySelectorAll('[data-day]')).toHaveLength(30);
    expect(quadrants('2026-09-09')).toEqual(['level-0', 'level-0', 'level-0', 'level-0']);
  }
});

it('keeps a full honest month when no series arrived at all', async () => {
  calendarWorkspace();
  state.own = { ...state.own, receivedAt: '2026-09-30T23:59:00Z', data: { ...state.own.data, series: { bucketMs: 86400000, points: [] } } };
  await render();
  expect(host.textContent).toContain('No per-interval series to chart for this period');
  expect(host.querySelectorAll('[data-day]').length).toBeGreaterThan(27);
  // Nothing reads as a measured zero when nothing was measured.
  expect([...host.querySelectorAll('[data-day] span > b')].every(node => node.dataset.absent === 'true')).toBe(true);
});
