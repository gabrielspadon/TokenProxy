// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActivityBand } from '@/shared/workspace/ActivityBand';

const state = vi.hoisted(() => ({ workspace: null, events: null }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useWorkspace: () => state.workspace }));
vi.mock('@/shared/workspace/AnalyticalChart', () => ({
  METRIC_COLORS: { input: '#3B62B3', failure: '#B23A43', selected: '#006F78' },
  AnalyticalChart: ({ onEvents }) => { state.events = onEvents; return <div aria-label="Activity plot" />; },
}));
let root, container;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  state.workspace = { scope: { start: '2026-09-07T10:00:30.000Z', end: '2026-09-07T10:01:30.000Z' }, setScope: vi.fn(), activity: {
    data: { summary: { records: 2, failed: 0 }, series: { bucketMs: 60000, points: [
      { bucketStart: '2026-09-07T10:00:00Z', bucketStartMs: Date.parse('2026-09-07T10:00:00Z'), records: 1, failed: 0 },
      { bucketStart: '2026-09-07T10:01:00Z', bucketStartMs: Date.parse('2026-09-07T10:01:00Z'), records: 1, failed: 0 },
    ] } },
  } };
  await act(async () => root.render(<MantineProvider env="test"><ActivityBand /></MantineProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('filters a clicked chart bucket to its contributing population without widening the original range', async () => {
  await act(async () => state.events.click({ dataIndex: 0 }));
  expect(state.workspace.setScope).toHaveBeenLastCalledWith({ period: 'custom', start: '2026-09-07T10:00:30.000Z', end: '2026-09-07T10:01:00.000Z' });
  await act(async () => state.events.click({ dataIndex: 1 }));
  expect(state.workspace.setScope).toHaveBeenLastCalledWith({ period: 'custom', start: '2026-09-07T10:01:00.000Z', end: '2026-09-07T10:01:30.000Z' });
  await act(async () => state.events.click({ dataIndex: -1 }));
  expect(state.workspace.setScope).toHaveBeenCalledTimes(2);
});

it('offers the same interval selection from the keyboard-reachable data table', async () => {
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'View data').click());
  const button = document.querySelector('[aria-label="Filter activity to 2026-09-07T10:00:00Z UTC"]');
  expect(button.tagName).toBe('BUTTON');
  await act(async () => button.click());
  expect(state.workspace.setScope).toHaveBeenCalledWith({ period: 'custom', start: '2026-09-07T10:00:30.000Z', end: '2026-09-07T10:01:00.000Z' });
});
