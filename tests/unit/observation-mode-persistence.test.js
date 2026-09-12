// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_OBSERVATION_MODE,
  OBSERVATION_MODE_KEY,
  ObservationProvider,
  readStoredMode,
  useObservationPolicy,
} from '../../src/shared/workspace/ObservationPolicy';
import { useResource } from '../../src/shared/workspace/useResource';
import { useEventStream } from '../../src/shared/hooks/useEventStream';

// The operator's chosen update behavior has to survive a route change and a
// reload, and restoring it must not start work the mode does not permit.
// Navigation and reload are the same event here: ObservationProvider mounts
// again and re-reads storage.
//
// What each mode owes, measured below rather than asserted from the source:
// every mode reads each source ONCE when a page opens, because a workspace
// with nothing on screen has nothing to hold. Only Live repeats that read, and
// only Live opens a stream. Paused adds that it keeps the last values through
// a transition instead of clearing them.
let container, root, policy, opened;

function Probe({ url = '/api/probe', stream = null }) {
  policy = useObservationPolicy();
  const resource = useResource(url, { interval: 15000 });
  const state = useEventStream(stream, () => {});
  useEffect(() => {
    void resource;
    void state;
  });
  return <span>{policy.mode}</span>;
}
async function mount(props = {}) {
  await act(async () => {
    root.render(
      <ObservationProvider>
        <Probe {...props} />
      </ObservationProvider>
    );
  });
}
async function unmount() {
  await act(async () => root.render(null));
}
const reads = () => fetch.mock.calls.filter(([url]) => url === '/api/probe').length;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  opened = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      opened.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ label: 'ok' }),
    }))
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('defaults a first-time operator to the manual mode, reads once and writes nothing', async () => {
  await mount();
  expect(policy.mode).toBe(DEFAULT_OBSERVATION_MODE);
  expect(policy.background).toBe(false);
  // Nothing is stored until the operator chooses, so the default can move
  // later without a stale preference overriding it.
  expect(window.localStorage.getItem(OBSERVATION_MODE_KEY)).toBeNull();
  expect(reads()).toBe(1);
  expect(opened).toHaveLength(0);
});

it('persists an explicit choice and restores it when the provider mounts again', async () => {
  await mount();
  await act(async () => policy.setMode('live'));
  expect(window.localStorage.getItem(OBSERVATION_MODE_KEY)).toBe('live');
  // A route change unmounts and remounts the provider. That is what used to
  // discard the choice and silently return the operator to a static page.
  await unmount();
  await mount();
  expect(policy.mode).toBe('live');
  expect(policy.background).toBe(true);
});

it('restores paused with no stream at any point during hydration', async () => {
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'paused');
  await mount({ stream: '/api/usage/stream' });
  expect(policy.mode).toBe('paused');
  expect(policy.background).toBe(false);
  // The one read is the page opening. No EventSource is ever constructed --
  // not even for the frame before the stored mode is known, which is what the
  // hydration gate on `background` buys.
  expect(reads()).toBe(1);
  expect(opened).toHaveLength(0);
});

it('reads exactly once when hydrating into live, not once per hydration frame', async () => {
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'live');
  await mount();
  expect(reads()).toBe(1);
});

it('opens exactly one stream for a stored live mode and closes it on unmount', async () => {
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'live');
  await mount({ stream: '/api/usage/stream' });
  expect(opened).toHaveLength(1);
  await unmount();
  expect(opened).toHaveLength(1);
  expect(opened[0].closed).toBe(true);
});

it('reconnects a dropped stream on bounded backoff and cleans up on unmount', async () => {
  vi.useFakeTimers();
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'live');
  await mount({ stream: '/api/usage/stream' });
  expect(opened).toHaveLength(1);
  // First failure: 1 s. Second: 2 s. The existing backoff, exercised rather
  // than read -- the earlier investigation never killed the transport.
  await act(async () => opened[0].onerror(new Event('error')));
  expect(opened[0].closed).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(opened).toHaveLength(2);
  await act(async () => opened[1].onerror(new Event('error')));
  await act(async () => vi.advanceTimersByTimeAsync(1999));
  expect(opened).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(opened).toHaveLength(3);
  // Three consecutive failures read as stale rather than as still connecting.
  await act(async () => opened[2].onerror(new Event('error')));
  expect(container.textContent).toBe('live');
  await unmount();
  // The pending reconnect timer is cleared, so nothing opens after unmount.
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(opened).toHaveLength(3);
  expect(opened.every((source) => source.closed)).toBe(true);
});

it('resumes from paused with a single catch-up read, not one per missed interval', async () => {
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'paused');
  await mount();
  expect(reads()).toBe(1);
  await act(async () => policy.setMode('live'));
  expect(reads()).toBe(2);
});

it('falls back to the manual default for a malformed or unreadable stored value', async () => {
  for (const raw of ['LIVE', '"live"', '{}', '', 'streaming']) {
    window.localStorage.setItem(OBSERVATION_MODE_KEY, raw);
    expect(readStoredMode()).toBe(DEFAULT_OBSERVATION_MODE);
  }
  // A store whose getItem throws is over quota or otherwise unusable.
  expect(
    readStoredMode(() => ({
      getItem() {
        throw new Error('blocked');
      },
    }))
  ).toBe(DEFAULT_OBSERVATION_MODE);
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'nonsense');
  await mount({ stream: '/api/usage/stream' });
  expect(policy.mode).toBe(DEFAULT_OBSERVATION_MODE);
  expect(policy.background).toBe(false);
  expect(opened).toHaveLength(0);
});

it('survives a localStorage property getter that throws, without stranding consumers', async () => {
  // The failure that matters is not a throwing getItem, it is a throwing
  // ACCESSOR: under a blocked or partitioned context, reading
  // window.localStorage raises SecurityError before any method is called. If
  // the store is acquired at the call site rather than inside the helper, that
  // throw escapes the mount effect, `hydrated` never becomes true and every
  // useResource consumer loads forever.
  expect(
    readStoredMode(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    })
  ).toBe(DEFAULT_OBSERVATION_MODE);

  const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  try {
    await mount({ stream: '/api/usage/stream' });
    expect(policy.mode).toBe(DEFAULT_OBSERVATION_MODE);
    // Hydration completed, so reads are permitted and nothing hangs.
    expect(policy.hydrated).toBe(true);
    expect(reads()).toBe(1);
    expect(opened).toHaveLength(0);
    // Choosing a mode still applies for this session; only the saving fails.
    await act(async () => policy.setMode('live'));
    expect(policy.mode).toBe('live');
    expect(policy.background).toBe(true);
  } finally {
    Object.defineProperty(window, 'localStorage', real);
  }
});

it('keeps a throwing storage accessor from breaking the cross-tab listener', async () => {
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'live');
  await mount();
  expect(policy.mode).toBe('live');
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  try {
    // The storage event fires on a store that has since become unreadable.
    // It resolves to the default rather than throwing out of the listener.
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: OBSERVATION_MODE_KEY }));
    });
    expect(policy.mode).toBe(DEFAULT_OBSERVATION_MODE);
  } finally {
    Object.defineProperty(window, 'localStorage', real);
  }
});

it('applies another tab writing the key, and a cleared key returns to manual', async () => {
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'live');
  await mount();
  expect(policy.mode).toBe('live');
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'paused');
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: OBSERVATION_MODE_KEY }));
  });
  expect(policy.mode).toBe('paused');
  // key === null is a whole-store clear.
  window.localStorage.clear();
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(policy.mode).toBe(DEFAULT_OBSERVATION_MODE);
});

it('holds paused past two poll intervals, then keeps live on the existing 15 s cadence', async () => {
  vi.useFakeTimers();
  window.localStorage.setItem(OBSERVATION_MODE_KEY, 'paused');
  await mount();
  expect(reads()).toBe(1);
  // 31 s clears two 15 s cycles and any cooldown boundary inside them. The
  // earlier 18 s sample could not separate "held" from "not due yet".
  await act(async () => vi.advanceTimersByTimeAsync(31000));
  expect(reads()).toBe(1);
  await act(async () => policy.setMode('live'));
  expect(reads()).toBe(2);
  await act(async () => vi.advanceTimersByTimeAsync(14000));
  expect(reads()).toBe(2);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(reads()).toBe(3);
  // Pausing again stops the cadence and holds, without clearing what is shown.
  await act(async () => policy.setMode('paused'));
  await act(async () => vi.advanceTimersByTimeAsync(31000));
  expect(reads()).toBe(3);
});
