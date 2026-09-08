// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workspace: null, chart: null }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useWorkspace: () => state.workspace }));
vi.mock('@/shared/workspace/AnalyticalChart', async () => ({
  ...(await import('@/shared/workspace/metricColors')),
  AnalyticalChart: props => { state.chart = props; return <div aria-label={props.label} />; },
}));
import { CapacityActivity, capacityActivityOption, capacityBucketScope } from '@/app/dashboard/CapacityActivity';
let root, host;
const start = Date.parse('2026-09-07T12:00:00Z');
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const points = Array.from({ length: 8 }, (_, index) => ({ bucketStartMs: start + index * 60000, bucketStart: new Date(start + index * 60000).toISOString(), logicalRequests: 2, records: 3, failed: 1, cacheReadTokens: 900, cacheWriteTokens: 100, cacheReadSamples: 2, cacheWriteSamples: 2 }));
  state.workspace = { scope: { provider: 'codex', start: new Date(start + 30000).toISOString(), end: new Date(start + 8 * 60000).toISOString() }, setScope: vi.fn(), activity: {
    url: '/api/activity?scope=fixture', refresh: vi.fn(), loading: false, receivedAt: '2026-09-07T12:09:00Z',
    data: { source: 'requestStats', summary: { records: 24, logicalRequests: 10, unattributedAttempts: 4, failed: 8, cacheReadFraction: 0.75 }, series: { bucketMs: 60000, points } },
  } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<MantineProvider env="test"><CapacityActivity /></MantineProvider>));

it('keeps logical request totals, attempts and paired cache token share distinct', async () => {
  await render();
  const summary = [...host.querySelectorAll('dl > div')].map(node => node.textContent);
  expect(summary).toEqual(['Requests with an ID10', 'Attempts24', 'Failed attempts8', 'Cache read share of input75%']);
  expect(host.textContent).toContain('4 attempts have no request ID');
  expect(host.textContent).not.toContain('Historical zeros may be unreported');
  expect(state.chart.option.yAxis.map(axis => axis.name)).toEqual(['Count', 'Tokens']);
  expect(state.chart.option.series[0].data[0][1]).toBe(2);
  expect(state.chart.option.series[1].data[0][1]).toBe(3);
  expect(state.chart.option.series.every(series => series.showSymbol && series.showAllSymbol)).toBe(true);
  await act(async () => host.querySelector('[value="data"]').click());
  expect(host.textContent).toContain('Historical zeros may be unreported');
  expect(host.textContent).toContain('interval counts do not add up to unique requests');
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
  }
  expect(option.series[0].data).toEqual([[singleStart, 1]]);
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

it('offers the same clipped interval selection through the chart and a paginated inline table', async () => {
  await render();
  act(() => state.chart.onEvents.click({ value: [start, 2] }));
  expect(state.workspace.setScope).toHaveBeenLastCalledWith({ period: 'custom', start: new Date(start + 30000).toISOString(), end: new Date(start + 60000).toISOString() });
  await act(async () => host.querySelector('[value="data"]').click());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelectorAll('tbody tr')).toHaveLength(5);
  const interval = host.querySelector('tbody button');
  act(() => interval.click());
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
