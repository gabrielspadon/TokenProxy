// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePoll } from '../../src/shared/hooks/usePoll';
import { Freshness } from '../../src/shared/components/Freshness';
import { WorkspaceProvider } from '../../src/shared/workspace/WorkspaceProvider';

let root, container;
function LegacyControl() {
  const resource = usePoll('/api/legacy-control', 1000);
  return (
    <>
      <Freshness status={resource.loading ? 'connecting' : 'live'} lastDataAt={resource.goodAt} />
      <button onClick={resource.refresh}>Refresh control</button>
    </>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'x-tokenproxy-preview': 'historical-snapshot',
        'x-tokenproxy-captured-at': '2026-09-06T15:45:00Z',
      }),
      json: async () => ({}),
    }))
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('labels a historical control snapshot, stops recurring reads, and preserves manual refresh', async () => {
  await act(async () =>
    root.render(
      <WorkspaceProvider>
        <LegacyControl />
      </WorkspaceProvider>
    )
  );
  expect(container.querySelector('[role="status"]').textContent).toBe('Snapshot');
  const legacyCalls = () =>
    fetch.mock.calls.filter(([url]) => url === '/api/legacy-control').length;
  expect(legacyCalls()).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(legacyCalls()).toBe(1);
  await act(async () => container.querySelector('button').click());
  expect(legacyCalls()).toBe(2);
  expect(container.querySelector('[role="status"]').textContent).not.toContain('Live');
});
