// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import ConnectionsPage from '@/app/dashboard/connections/page';
import { AccountPaths } from '@/app/dashboard/network/AccountPaths';

// Connections is one board: the state chips filter it, a caret opens the
// account's evidence inline, and the investigation links carry the retained
// interval, model and comparison. Nothing here is a dock or a dialog.
const fixture = vi.hoisted(() => ({ workspace: null, reads: {} }));
// The shared scope strip reads the whole workspace; these tests are about the
// board under it, so it is stubbed rather than fixtured.
vi.mock('@/shared/workspace/ScopeBar', () => ({ ScopeBar: () => null }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({
  useOptionalWorkspace: () => fixture.workspace,
}));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: (url) => ({ data: fixture.reads[url] || {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
let root, container;
const account = {
  id: 'account-exact',
  provider: 'openai',
  name: 'Research',
  priority: 2,
  isActive: true,
};
const board = () => container.querySelector('[aria-label="Connection inventory"]');
const chip = (label) =>
  [
    ...board().querySelectorAll('[role="group"][aria-label="Connection status summary"] button'),
  ].find((node) => node.textContent.trim().endsWith(label));

beforeEach(() => {
  fixture.workspace = null;
  fixture.reads = {
    '/api/providers': {
      connections: [
        account,
        { id: 'unknown-account', provider: 'claude', name: 'Personal', isActive: true },
      ],
    },
    '/api/admin/qualification': {
      connections: [{ connectionId: account.id, status: 'cooldown', isActive: true }],
    },
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <ConnectionsPage />
      </MantineProvider>
    )
  );
}
async function pick(label) {
  await act(async () => chip(label).click());
}

it('keeps unknown health separate from recorded unhealthy accounts', async () => {
  await render();
  await pick('attention');
  expect(board().textContent).toContain('Research');
  expect(board().textContent).not.toContain('Personal');
  await pick('attention');
  await pick('unknown');
  expect(board().textContent).toContain('Personal');
  expect(board().textContent).not.toContain('Research');
});

it('does not present disabled or unqualified accounts as observed unhealthy', async () => {
  fixture.reads['/api/providers'].connections.push({
    id: 'unqualified-account',
    provider: 'openai',
    name: 'Never validated',
    isActive: false,
  });
  fixture.reads['/api/admin/qualification'].connections.push({
    connectionId: 'unqualified-account',
    status: 'unqualified',
    isActive: false,
  });
  await render();
  await pick('attention');
  expect(board().textContent).not.toContain('Never validated');
  await pick('attention');
  await pick('paused');
  expect(board().textContent).toContain('Never validated');
});

it('opens the retained exact account and creates analysis links with the same interval, model and comparison', async () => {
  fixture.workspace = {
    selectedRecord: { kind: 'account', id: account.id },
    scope: {
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-02T00:00:00.000Z',
      model: 'gpt-6-astra',
      provider: null,
      connectionId: null,
    },
    comparisonIds: ['account-exact', 'other-account'],
    setSelectedRecord: vi.fn(),
    setScope: vi.fn(),
  };
  await render();
  const detail = container.querySelector('[role="region"][aria-label="Selection details"]');
  expect(detail).toBeTruthy();
  const link = [...detail.querySelectorAll('a')].find(
    (element) => element.textContent === 'Context'
  );
  const target = new URL(link.href);
  expect(target.pathname).toBe('/dashboard/context');
  expect(target.searchParams.get('start')).toBe(fixture.workspace.scope.start);
  expect(target.searchParams.get('end')).toBe(fixture.workspace.scope.end);
  expect(target.searchParams.get('model')).toBe('gpt-6-astra');
  expect(target.searchParams.get('compare')).toBe('account-exact,other-account');
  expect(target.searchParams.get('connectionId')).toBe(account.id);
  expect(JSON.parse(target.searchParams.get('selected'))).toEqual({
    kind: 'account',
    id: account.id,
    connectionId: account.id,
    provider: account.provider,
  });
});

it('selects into the shared workspace and filters current inventory only by the supported account dimensions', async () => {
  fixture.workspace = {
    scope: { provider: 'openai', model: 'not-entitlement-evidence', start: '2026-09-01T00:00:00Z' },
    selectedRecord: null,
    setSelectedRecord: vi.fn(),
    setScope: vi.fn(),
  };
  await render();
  expect(board().textContent).toContain('Research');
  expect(board().textContent).not.toContain('Personal');
  await act(async () => board().querySelector('[aria-label="Expand Research"]').click());
  expect(fixture.workspace.setSelectedRecord).toHaveBeenCalledWith({
    kind: 'account',
    id: account.id,
    connectionId: account.id,
    provider: 'openai',
  });
  expect(fixture.workspace.setScope).not.toHaveBeenCalled();
});

it('keeps selected evidence visible outside current account filters', async () => {
  fixture.workspace = {
    selectedRecord: { kind: 'account', id: account.id },
    scope: { provider: 'claude' },
    setSelectedRecord: vi.fn(),
    setScope: vi.fn(),
  };
  await render();
  expect(container.textContent).toContain('selected account is outside the displayed filters');
  expect(
    container.querySelector('[role="region"][aria-label="Selection details"]').textContent
  ).toContain(account.id);
});

it('uses the retained account for the Network inspector without inventing observed reachability', async () => {
  fixture.workspace = {
    selectedRecord: { kind: 'account', id: account.id },
    setSelectedRecord: vi.fn(),
  };
  await act(async () => root.render(<MantineProvider env="test"><AccountPaths connections={[account]} pools={[]} /></MantineProvider>));
  const inspector = container.querySelector('[aria-label="Network path inspector"]');
  expect(inspector.textContent).toContain('Not established by this configuration read');
  expect(inspector.querySelector('a').getAttribute('href')).toBe(
    `/dashboard/connections/${account.id}`
  );
  // The account paths inventory is the shared board, so the account's own name
  // button is what hands the exact retained identity to the workspace.
  fixture.workspace.selectedRecord = null;
  await act(async () => root.render(<MantineProvider env="test"><AccountPaths connections={[account]} pools={[]} /></MantineProvider>));
  await act(async () =>
    container.querySelector('button[aria-label^="Inspect account path for"]').click()
  );
  expect(fixture.workspace.setSelectedRecord).toHaveBeenCalledWith({
    kind: 'account',
    id: account.id,
    connectionId: account.id,
    provider: account.provider,
  });
});

it('reserves no empty Network inspector when no account is selected', async () => {
  await act(async () => root.render(<MantineProvider env="test"><AccountPaths connections={[account]} pools={[]} /></MantineProvider>));
  expect(container.querySelector('[aria-label="Network path inspector"]')).toBeNull();
  expect(container.querySelector('[data-connection-id]').textContent).toContain(account.name);
});
