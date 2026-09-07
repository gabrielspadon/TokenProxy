// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import ConnectionsPage from '@/app/dashboard/connections/page';
import { AccountPaths } from '@/app/dashboard/network/AccountPaths';

const fixture = vi.hoisted(() => ({ workspace: null, reads: {} }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useOptionalWorkspace: () => fixture.workspace }));
vi.mock('@/shared/workspace/SelectionDock', () => ({ SelectionDock: ({ children, open, detail }) => <>{children}{open && <aside>{detail}</aside>}</> }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: fixture.reads[url] || {}, loading: false, refresh: vi.fn() }) }));
let root, container;
const account = { id: 'account-exact', provider: 'openai', name: 'Research', priority: 2 };
beforeEach(() => {
  fixture.workspace = null;
  fixture.reads = {
    '/api/providers': { connections: [account, { id: 'unknown-account', provider: 'claude', name: 'Personal' }] },
    '/api/admin/qualification': { connections: [{ connectionId: account.id, status: 'cooldown' }] },
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<MantineProvider env="test"><ConnectionsPage /></MantineProvider>)); }
async function show(value) {
  await act(async () => {
    const select = container.querySelector('.toolbar select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('keeps unknown health separate from recorded unhealthy accounts', async () => {
  await render(); await show('degraded');
  expect(container.querySelector('.connections-inventory').textContent).toContain('Research');
  expect(container.querySelector('.connections-inventory').textContent).not.toContain('Personal');
  await show('unknown');
  expect(container.querySelector('.connections-inventory').textContent).toContain('Personal');
  expect(container.querySelector('.connections-inventory').textContent).not.toContain('Research');
});

it('does not present disabled or unqualified accounts as observed unhealthy', async () => {
  fixture.reads['/api/providers'].connections.push({ id: 'unqualified-account', provider: 'openai', name: 'Never validated', isActive: false });
  fixture.reads['/api/admin/qualification'].connections.push({ connectionId: 'unqualified-account', status: 'unqualified' });
  await render(); await show('degraded');
  expect(container.querySelector('.connections-inventory').textContent).not.toContain('Never validated');
  await show('disabled');
  expect(container.querySelector('.connections-inventory').textContent).toContain('Never validated');
});

it('opens the retained exact account and creates analysis links with the same interval, model and comparison', async () => {
  fixture.workspace = {
    selectedRecord: { kind: 'account', id: account.id },
    scope: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z', model: 'gpt-6-astra', provider: null, connectionId: null },
    comparisonIds: ['account-exact', 'other-account'], setSelectedRecord: vi.fn(), setScope: vi.fn(),
  };
  await render();
  const link = [...container.querySelectorAll('aside a')].find(element => element.textContent === 'Context');
  const target = new URL(link.href);
  expect(target.pathname).toBe('/dashboard/context');
  expect(target.searchParams.get('start')).toBe(fixture.workspace.scope.start);
  expect(target.searchParams.get('end')).toBe(fixture.workspace.scope.end);
  expect(target.searchParams.get('model')).toBe('gpt-6-astra');
  expect(target.searchParams.get('compare')).toBe('account-exact,other-account');
  expect(target.searchParams.get('connectionId')).toBe(account.id);
  expect(JSON.parse(target.searchParams.get('selected'))).toEqual({ kind: 'account', id: account.id, connectionId: account.id, provider: account.provider });
});

it('selects into the shared workspace and filters current inventory only by the supported account dimensions', async () => {
  fixture.workspace = { scope: { provider: 'openai', model: 'not-entitlement-evidence', start: '2026-09-01T00:00:00Z' }, selectedRecord: null, setSelectedRecord: vi.fn(), setScope: vi.fn() };
  await render();
  const inventory = container.querySelector('.connections-inventory');
  expect(inventory.textContent).toContain('Research'); expect(inventory.textContent).not.toContain('Personal');
  await act(async () => inventory.querySelector('[aria-label="Inspect account Research"]').click());
  expect(fixture.workspace.setSelectedRecord).toHaveBeenCalledWith({ kind: 'account', id: account.id, connectionId: account.id, provider: 'openai' });
  expect(fixture.workspace.setScope).not.toHaveBeenCalled();
});

it('keeps selected evidence visible outside current account filters', async () => {
  fixture.workspace = { selectedRecord: { kind: 'account', id: account.id }, scope: { provider: 'claude' }, setSelectedRecord: vi.fn(), setScope: vi.fn() };
  await render();
  expect(container.textContent).toContain('selected account is outside the displayed filters');
  expect(container.querySelector('aside').textContent).toContain(account.id);
});

it('uses the retained account for the Network inspector without inventing observed reachability', async () => {
  fixture.workspace = { selectedRecord: { kind: 'account', id: account.id }, setSelectedRecord: vi.fn() };
  await act(async () => root.render(<AccountPaths connections={[account]} pools={[]} />));
  const inspector = container.querySelector('[aria-label="Network path inspector"]');
  expect(inspector.textContent).toContain('Not established by this configuration read');
  expect(inspector.querySelector('a').getAttribute('href')).toBe(`/dashboard/connections/${account.id}`);
  await act(async () => container.querySelector('.network-path-row').click());
  expect(fixture.workspace.setSelectedRecord).toHaveBeenCalledWith({ kind: 'account', id: account.id, connectionId: account.id, provider: account.provider });
});

it('reserves no empty Network inspector when no account is selected', async () => {
  await act(async () => root.render(<AccountPaths connections={[account]} pools={[]} />));
  expect(container.querySelector('[aria-label="Network path inspector"]')).toBeNull();
  expect(container.querySelector('.network-path-row').textContent).toContain(account.name);
});
