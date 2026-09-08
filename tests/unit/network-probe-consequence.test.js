// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

// The probe is mocked at `@/shared/api`, so pressing Test issues no request of
// any kind. `fetch` is stubbed as a failing spy: if the page or the inspector
// reaches the network, the assertion at the end of each test catches it.
const fixture = vi.hoisted(() => ({ calls: [], response: { ok: true, body: {} } }));
vi.mock('@/shared/api', () => ({
  call: vi.fn(async (url, options) => {
    fixture.calls.push({ url, ...options });
    return fixture.response;
  }),
}));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: (url) => ({
    loading: false,
    error: null,
    status: 200,
    goodAt: 1,
    at: 1,
    refresh: vi.fn(),
    data:
      url === '/api/provider-nodes'
        ? { nodes: [] }
        : url === '/api/settings'
          ? { outboundProxyEnabled: false, providerStrategies: {} }
          : {
              proxyPools: [
                {
                  id: 'pool-1',
                  name: 'Home relay',
                  proxyUrl: 'http://user:pass@10.0.0.5:8080',
                  type: 'http',
                  testStatus: 'active',
                  isActive: true,
                  boundConnectionCount: 3,
                },
              ],
            },
  }),
}));
// The inspector's own rendering is covered in operation-history-inspector; here
// it stands in as a mount marker so this file asserts the WIRING only.
vi.mock('@/shared/workspace/OperationHistoryInspector', () => ({
  OperationHistoryInspector: ({ subjectId, label }) => (
    <div data-testid="inspector">{`history ${subjectId} ${label}`}</div>
  ),
}));

const { default: NetworkPage } = await import('../../src/app/dashboard/network/page.js');

let container, root, fetchMock;
const button = (text) =>
  [...container.querySelectorAll('button')].find((el) => el.textContent.trim() === text);

beforeEach(async () => {
  fixture.calls = [];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  fetchMock = vi.fn(async () => {
    throw new Error('unexpected network call');
  });
  vi.stubGlobal('fetch', fetchMock);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MantineProvider env="test"><NetworkPage /></MantineProvider>));
  await act(async () => button('Pools').click());
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('network page probe disclosure', () => {
  it('states the activation consequence in the document before the control is used', () => {
    const disclosure = container.querySelector('#probe-consequence');
    expect(disclosure).toBeTruthy();
    const text = disclosure.textContent;
    expect(text).toContain('can change whether the pool is active');
    expect(text).toContain('Scope');
    expect(text).toContain('Timing');
    expect(text).toContain('Reversing it');
    expect(text).toContain('stops routing through it until a later probe succeeds');
    // Disclosure, not a tooltip: nothing hides this behind hover or focus.
    expect(disclosure.querySelector('[title]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('points the Test control at that disclosure so it is announced with the button', () => {
    const test = button('Test');
    expect(test).toBeTruthy();
    expect(test.getAttribute('aria-describedby')).toBe('probe-consequence');
    expect(container.querySelector('#probe-consequence')).toBeTruthy();
  });

  it('does not present the mutable pool status as a history', () => {
    // The column holds the pool's own current field, which every probe
    // overwrites. Said once for the table rather than per row, because the
    // repeated sentence inflated the row's auto track at 390px.
    const text = container.textContent;
    expect(text).toContain("pool's own current state, overwritten by each probe");
    expect(text).toContain('never finished leaves no mark there');
    expect(text).toContain('Latest applied');
  });

  it('mounts the retained history for one pool on demand, keyed to that pool', async () => {
    expect(container.querySelector('[data-testid="inspector"]')).toBeNull();
    const open = button('Probe history');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await act(async () => open.click());
    const inspector = container.querySelector('[data-testid="inspector"]');
    expect(inspector.textContent).toBe('history pool-1 Home relay');
    expect(button('Hide probe history').getAttribute('aria-expanded')).toBe('true');
    await act(async () => button('Hide probe history').click());
    expect(container.querySelector('[data-testid="inspector"]')).toBeNull();
    // Opening history is a read of retained evidence. It runs no probe.
    expect(fixture.calls).toEqual([]);
  });

  it('never leaks the proxy credential into the row', () => {
    expect(container.textContent).not.toContain('pass');
    expect(container.textContent).toContain('•••@10.0.0.5:8080');
  });
});
