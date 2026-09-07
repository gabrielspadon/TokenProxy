// @vitest-environment jsdom
import { act } from 'react';
import { MantineProvider } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ reads: {}, refresh: vi.fn() }));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: url => ({ data: null, error: null, loading: false, status: 200, ...fixture.reads[url], refresh: () => fixture.refresh(url) }),
}));
vi.mock('@/store/authStatus', () => ({ useAuthStatus: selector => selector({ status: { requireLogin: true } }) }));
const { default: SystemPage } = await import('@/app/dashboard/system/page');
const { default: RemotePage } = await import('@/app/dashboard/remote/page');
let root, container;
const network = { status: 0, error: { code: 'network', error: 'Synthetic read aborted' } };

beforeEach(() => {
  fixture.reads = {};
  fixture.refresh.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('')));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('scopes a failed version read while retaining successful process health', async () => {
  fixture.reads = {
    '/api/admin/health': { data: { uptimeSeconds: 240 } },
    '/api/admin/health/detail': { data: { status: 'healthy', checks: { database: { status: 'healthy', latencyMs: 0 }, connections: [] } } },
    '/api/version': network,
  };
  await act(async () => root.render(<MantineProvider env="test"><SystemPage /></MantineProvider>));
  expect(container.textContent).toContain('Version information could not be read.');
  expect(container.textContent).toContain('Healthy');
  expect(container.textContent).not.toContain('The gateway did not answer.');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry version read').click());
  expect(fixture.refresh).toHaveBeenCalledWith('/api/version');
});

it('retains the gateway failure notice when the process health read fails', async () => {
  fixture.reads = { '/api/admin/health': network };
  await act(async () => root.render(<MantineProvider env="test"><SystemPage /></MantineProvider>));
  expect(container.textContent).toContain('The gateway did not answer.');
});

it('scopes a failed mesh host read and retries only that observation', async () => {
  fixture.reads = {
    '/api/tunnel/status': { data: { tunnel: { settingsEnabled: false }, tailscale: { settingsEnabled: false } } },
    '/api/tunnel/tailscale-check': network,
  };
  await act(async () => root.render(<RemotePage />));
  expect(container.textContent).toContain('Mesh host status could not be read.');
  expect(container.textContent).toContain('Configured off');
  expect(container.textContent).not.toContain('The gateway did not answer.');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry mesh host read').click());
  expect(fixture.refresh).toHaveBeenCalledWith('/api/tunnel/tailscale-check');
});

it.each([[SystemPage, '/api/version'], [RemotePage, '/api/tunnel/tailscale-check']])('preserves authentication refusals for a partial read', async (Page, endpoint) => {
  fixture.reads = { [endpoint]: { status: 401, error: { source: 'tokenproxy-admin', code: 'unauthorized' } } };
  await act(async () => root.render(<MantineProvider env="test"><Page /></MantineProvider>));
  expect(container.textContent).toContain('This needs an operator credential.');
});

it.each([
  [SystemPage, '/api/admin/health', { uptimeSeconds: 240 }, 'Process health could not be refreshed.', 'Retry process health read'],
  [SystemPage, '/api/admin/health/detail', { status: 'healthy', checks: { database: { status: 'healthy', latencyMs: 0 }, connections: [] } }, 'Readiness checks could not be refreshed.', 'Retry readiness read'],
  [RemotePage, '/api/tunnel/status', { tunnel: { settingsEnabled: false }, tailscale: { settingsEnabled: false } }, 'Remote process status could not be refreshed.', 'Retry remote process read'],
  [RemotePage, '/api/tunnel/tailscale-check', { installed: true, loggedIn: true }, 'Mesh host status could not be read.', 'Retry mesh host read'],
  [RemotePage, '/api/settings/require-login', { tunnelDashboardAccess: false }, 'Remote access policy could not be refreshed.', 'Retry access policy read'],
])('makes a failed refresh visible beside retained data, case %#', async (Page, endpoint, data, notice, retry) => {
  fixture.reads = { [endpoint]: { ...network, data, goodAt: 1 } };
  await act(async () => root.render(<MantineProvider env="test"><Page /></MantineProvider>));
  expect(container.textContent).toContain(notice);
  expect(container.textContent).toContain('last successful');
  expect(container.textContent).not.toContain('The gateway did not answer.');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === retry).click());
  expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith(endpoint);
});
