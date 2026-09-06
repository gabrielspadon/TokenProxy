// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useResource } from '../../src/shared/workspace/useResource';
import { analyticsUrl } from '../../src/shared/workspace/WorkspaceProvider';

let root, container, pending, current;
function Probe({ url, onSnapshot, interval = 0 }) {
  const resource = useResource(url, { onSnapshot, interval });
  useEffect(() => {
    current = resource;
  }, [resource]);
  return (
    <div>
      {resource.loading
        ? 'Loading'
        : resource.error
          ? `Error ${resource.error}`
          : resource.data?.label || 'Empty'}
    </div>
  );
}
function response(label, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status || 200,
    headers: new Headers(options.headers),
    json: async () => options.body || { label },
  };
}
async function settle(index, value) {
  await act(async () => {
    pending[index].resolve(value);
    await Promise.resolve();
  });
}
function render(url, onSnapshot, interval = 0) {
  act(() => root.render(<Probe url={url} onSnapshot={onSnapshot} interval={interval} />));
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  pending = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url, options) =>
        new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }))
    )
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

describe('Shared workspace resource ownership', () => {
  it('aborts the previous scope and ignores its late response', async () => {
    render('/api/analytics?provider=first');
    render('/api/analytics?provider=second');
    expect(pending[0].options.signal.aborted).toBe(true);
    await settle(1, response('Second scope'));
    await settle(0, response('First scope'));
    expect(container.textContent).toBe('Second scope');
    expect(current.data.label).toBe('Second scope');
  });
  it('does not label previous data as a failed new scope', async () => {
    render('/api/analytics?provider=first');
    await settle(0, response('First scope'));
    render('/api/analytics?provider=second');
    expect(container.textContent).toBe('Loading');
    expect(current.data).toBeNull();
    await settle(
      1,
      response(null, { ok: false, status: 503, body: { error: { message: 'Read worker busy' } } })
    );
    expect(container.textContent).toContain('Read worker busy');
    expect(current.data).toBeNull();
  });
  it('takes snapshot identity only from guard response headers', async () => {
    const onSnapshot = vi.fn();
    render('/api/admin/health/detail', onSnapshot);
    await settle(
      0,
      response('Snapshot', {
        headers: {
          'x-tokenproxy-preview': 'historical-snapshot',
          'x-tokenproxy-preview-captured-at': '2026-09-06T15:45:01.749912Z',
        },
      })
    );
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith({
      isolated: true,
      capturedAt: '2026-09-06T15:45:01.749912Z',
    });
  });
  it('refreshes the current scope and cancels a read on unmount', async () => {
    render('/api/analytics?provider=first');
    await settle(0, response('First observation'));
    act(() => current.refresh());
    expect(pending[1].url).toBe('/api/analytics?provider=first');
    act(() => root.render(null));
    expect(pending[1].options.signal.aborted).toBe(true);
  });
  it('stops automatic polling after a snapshot header while allowing manual refresh', async () => {
    vi.useFakeTimers();
    render('/api/analytics', undefined, 100);
    await settle(
      0,
      response('Snapshot', { headers: { 'x-tokenproxy-preview': 'historical-snapshot' } })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => current.refresh());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('maps absolute scope and bounded page options without unsupported array filters', () => {
    const url = new URL(
      analyticsUrl(
        {
          period: 'custom',
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-02T00:00:00Z',
          provider: 'openai',
          connectionId: null,
          model: 'model/a',
        },
        'economics',
        { page: 2, pageSize: 20 }
      ),
      'http://localhost'
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      view: 'economics',
      groupBy: 'account',
      pageSize: '20',
      page: '2',
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-02T00:00:00Z',
      provider: 'openai',
      model: 'model/a',
    });
  });
});
