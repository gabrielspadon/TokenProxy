// @vitest-environment jsdom
import { act, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConnectionPage from '@/app/dashboard/connections/[id]/page';
import AccountOptions from '@/app/dashboard/connections/AccountOptions';
import KeysPage from '@/app/dashboard/keys/page';
import NetworkPage from '@/app/dashboard/network/page';
import { AccessProfiles } from '@/app/dashboard/keys/AccessProfiles';
import { AccountPathBinding } from '@/app/dashboard/network/AccountPaths';
import { call } from '@/shared/api';

const fixture = vi.hoisted(() => ({ reads: {}, refresh: vi.fn() }));
vi.mock('@/shared/api', () => ({ call: vi.fn() }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: fixture.reads[url] || {}, refresh: fixture.refresh, loading: false, goodAt: 1 }) }));
vi.mock('@/store/authStatus', () => ({ useAuthStatus: selector => selector({ status: { authenticated: true } }) }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useOptionalWorkspace: () => null }));
// The shared scope strip reads the whole workspace; these tests are about the
// board under it, so it is stubbed rather than fixtured.
vi.mock('@/shared/workspace/ScopeBar', () => ({ ScopeBar: () => null }));
vi.mock('@/shared/workspace/SelectionDock', () => ({ SelectionDock: ({ children, detail, open }) => <>{children}{open ? detail : null}</> }));
const account = { id: 'exact-account', name: 'Research', provider: 'openai', priority: 3, globalPriority: 8, maxConcurrent: 2, providerSpecificData: {} };
const pool = { id: 'strict-pool', name: 'Private relay', isActive: true, strictProxy: true };
let root, container, network;
beforeEach(() => {
  vi.clearAllMocks(); fixture.reads = {
    '/api/providers/exact-account': { connection: account }, '/api/providers': { connections: [account] },
    '/api/settings': { providerStrategies: { openai: { maxConcurrent: 7 } } },
    '/api/proxy-pools': { proxyPools: [pool] }, '/api/proxy-pools?includeUsage=true': { proxyPools: [pool] },
    '/api/keys': { keys: [{ id: 'key-1', name: 'Workstation', usage: {}, isActive: true }] },
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  network = vi.fn(() => { throw new Error('Unexpected real network request'); }); vi.stubGlobal('fetch', network);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function mount(element) { await act(async () => root.render(<MantineProvider env="test"><Suspense fallback="Reading">{element}</Suspense></MantineProvider>)); }
const button = (text, scope = container) => [...scope.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === text || node.textContent.trim().endsWith(text));
const input = (text, scope = container) => [...scope.querySelectorAll('label')].find(node => node.textContent.includes(text) && node.control)?.control;
async function click(text, scope) { await act(async () => button(text, scope).click()); }
// The task switch is a control keyed by task value, rendered either as a
// segmented control (radios) or as a tab list; address it by value either way.
const task = (value, scope = container) => scope.querySelector(`input[type="radio"][value="${value}"]`)
  || [...scope.querySelectorAll('[role="tab"], button')].find(node => node.textContent.trim().toLowerCase() === value);
async function open(value, scope = container) { await act(async () => task(value, scope).click()); }
// A field that saves from itself: type, then commit with Enter.
async function commit(node, value) { await change(node, value); await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); }
async function change(node, value) {
  await act(async () => {
    const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

it('shows account policy directly and preserves both priority meanings without duplicating provider concurrency', async () => {
  await mount(<ConnectionPage params={Promise.resolve({ id: account.id })} />);
  expect(input('Global display priority').value).toBe('8');
  expect(input('Account concurrency ceiling').value).toBe('2');
  const priority = container.querySelector('section[aria-label="Routing priority"] input');
  expect(priority.value).toBe('3');
  expect(container.querySelector('details, dialog')).toBeNull();
  expect(button('Concurrency ceiling')).toBeUndefined();
  expect(call).not.toHaveBeenCalled();
  call.mockResolvedValue({ ok: true, body: { connection: { ...account, priority: 5 } } });
  await commit(priority, '5');
  expect(call.mock.calls[0]).toEqual(['/api/providers/exact-account', { method: 'PUT', body: { priority: 5 } }]);
  expect(container.querySelector('dialog')).toBeNull();
});

it('opens auth and model controls in one task step without calling providers', async () => {
  await mount(<ConnectionPage params={Promise.resolve({ id: account.id })} />);
  await open('auth'); expect(input('API key')).toBeDefined();
  expect(input('API key').closest('dialog')).toBeNull();
  await open('models'); expect(container.querySelector('details')).toBeNull();
  expect(container.textContent).toContain('Edit model access'); expect(call).not.toHaveBeenCalled();
});

it('mounts client setup only when the key is open on that task, and saves expiry in place', async () => {
  await mount(<KeysPage />); expect(call).not.toHaveBeenCalled(); await click('Configure Workstation');
  const expiry = container.querySelector('[aria-label="Expiry for Workstation"]');
  expect(expiry.closest('dialog')).toBeNull();
  call.mockResolvedValue({ ok: true, body: { keys: [{ id: 'key-1', name: 'Workstation', usage: {}, isActive: true, expiresAt: '2026-10-01T12:30:00.000Z' }] } });
  await commit(expiry, '2026-10-01T12:30:00');
  expect(call.mock.calls[0]).toEqual(['/api/keys/key-1', { method: 'PUT', body: { expiresAt: '2026-10-01T12:30:00.000Z' } }]);
  expect(call.mock.calls[1]).toEqual(['/api/keys']);
  expect(container.querySelector('dialog')).toBeNull();
  call.mockResolvedValue({ ok: true, body: { endpoints: {} } });
  await open('setup', container.querySelector('[data-account-id="key-1"]'));
  expect(call).toHaveBeenLastCalledWith('/api/keys/key-1/connectivity');
});

it('edits profile fields on row selection and preserves the reviewed version in the final write', async () => {
  const profile = { id: 'profile-1', name: 'Lab', version: 4, keyCount: 2, allowedModels: [], budgetPolicy: 'strict', maxPromptTokens: null, maxCompletionTokens: null, maxCostUsd: 5, expiryDays: null };
  const poll = { data: { profiles: [profile] }, refresh: fixture.refresh };
  await mount(<AccessProfiles poll={poll} onKeysChanged={fixture.refresh} />);
  await act(async () => container.querySelector('.profile-row').click());
  expect(input('Profile name').value).toBe('Lab'); expect(container.querySelector('dialog[open]')).toBeNull();
  await change(input('Recorded cost ceiling'), '9'); await click('Review profile');
  const dialog = container.querySelector('[role="group"][aria-label="Edit access profile"]');
  expect(dialog.querySelector('input, select, textarea')).toBeNull(); expect(container.querySelector('dialog')).toBeNull();
  expect(dialog.textContent).toContain('9 USD'); expect(call).not.toHaveBeenCalled();
  const saved = { ...profile, version: 5, maxCostUsd: 9 };
  call.mockResolvedValueOnce({ ok: true, body: { profile: saved } }).mockResolvedValueOnce({ ok: true, body: { profiles: [saved] } });
  await click('Save profile', dialog);
  expect(call.mock.calls[0]).toEqual(['/api/access-profiles/profile-1', { method: 'PUT', body: { name: 'Lab', allowedModels: [], budgetPolicy: 'strict', maxPromptTokens: null, maxCompletionTokens: null, maxCostUsd: 9, expiryDays: null, expectedVersion: 4, expectedName: 'Lab' } }]);
  expect(container.textContent).toContain('Profile version 5 saved and verified');
});

it.each([
  ['__none__', { proxyPoolId: '__none__' }, { connectionProxyMode: 'direct' }],
  ['__clear__', { proxyPoolId: null }, { connectionProxyMode: 'proxy', connectionProxyEnabled: true }],
  ['strict-pool', { proxyPoolId: 'strict-pool' }, { proxyPoolId: 'strict-pool', strictProxy: true }],
])('binds %s directly and verifies the returned account snapshot', async (mode, body, data) => {
  await mount(<AccountPathBinding connection={account} pools={[pool]} onSaved={fixture.refresh} />);
  await change(input('Account path'), mode); await click('Review account path');
  expect(call).not.toHaveBeenCalled();
  const dialog = container.querySelector('[role="alertdialog"][aria-label="Review account path"]');
  expect(dialog.querySelector('select, input, textarea')).toBeNull(); expect(container.querySelector('dialog')).toBeNull();
  const saved = { ...account, providerSpecificData: data };
  call.mockResolvedValue({ ok: true, body: { connection: saved } }); await click('Apply account path', dialog);
  expect(call.mock.calls).toEqual([['/api/providers/exact-account', { method: 'PUT', body }], ['/api/providers/exact-account']]);
  expect(container.textContent).toContain('Account path saved and read back');
});

it('retains custom-proxy semantics without rendering the credential and blocks an incomplete readback', async () => {
  await mount(<AccountPathBinding connection={account} pools={[pool]} />);
  await change(input('Account path'), '__legacy__'); await change(input('Account proxy URL'), 'http://user:private-value@proxy.invalid');
  await change(input('Bypass hosts'), 'localhost'); await click('Review account path');
  const dialog = container.querySelector('[role="alertdialog"][aria-label="Review account path"]');
  expect(dialog.textContent).not.toContain('private-value'); expect(container.querySelector('dialog')).toBeNull();
  call.mockResolvedValueOnce({ ok: true, body: { connection: { ...account, providerSpecificData: { connectionProxyMode: 'proxy', connectionProxyEnabled: true, connectionNoProxy: 'localhost' } } } }).mockResolvedValueOnce({ ok: false, status: 503 });
  await click('Apply account path', dialog);
  expect(call.mock.calls[0][1].body).toEqual({ connectionProxyEnabled: true, connectionProxyUrl: 'http://user:private-value@proxy.invalid', connectionNoProxy: 'localhost' });
  expect(input('Account proxy URL').value).toBe(''); expect(button('Review account path').disabled).toBe(true);
  expect(input('Account path').disabled).toBe(true);
  expect(container.textContent).toContain('saved account path was not confirmed');
});

it('splits network tasks without opening dialogs or dispatching operations', async () => {
  await mount(<NetworkPage />);
  expect(input('Connection timeout in milliseconds')).toBeDefined();
  await open('nodes'); expect(input('Adapter JSON')).toBeDefined();
  await click('Add a node'); expect(input('Name')).toBeDefined(); expect(input('Name').closest('dialog')).toBeNull();
  await open('pools'); await click('Add a pool'); expect(input('Proxy URL')).toBeDefined(); expect(input('Proxy URL').closest('dialog')).toBeNull();
  await open('relay'); expect(input('Cloudflare account ID')).toBeDefined(); expect(input('Vercel deployment token')).toBeDefined();
  expect(container.querySelector('dialog[open], details')).toBeNull(); expect(call).not.toHaveBeenCalled();
});

it('updates clean account options from saved state and preserves conflicting edited fields until reset', async () => {
  await mount(<AccountOptions connection={account} />);
  await change(input('Default model'), 'draft-model');
  await mount(<AccountOptions connection={{ ...account, name: 'Renamed', maxConcurrent: 6 }} />);
  expect(input('Account name').value).toBe('Renamed'); expect(input('Account concurrency ceiling').value).toBe('6');
  expect(input('Default model').value).toBe('draft-model');
  await mount(<AccountOptions connection={{ ...account, name: 'Renamed', maxConcurrent: 6, defaultModel: 'saved-model' }} />);
  expect(input('Default model').value).toBe('draft-model'); expect(button('Save account options').disabled).toBe(true);
  expect(container.textContent).toContain('Saved account fields changed'); expect(call).not.toHaveBeenCalled();
  await click('Reset draft'); expect(input('Default model').value).toBe('saved-model'); expect(button('Save account options').disabled).toBe(false);
});

it('does not mount client setup before the key is opened on that task', async () => {
  await mount(<KeysPage />); await click('Configure Workstation');
  expect(call).not.toHaveBeenCalled();
  const card = container.querySelector('[data-account-id="key-1"]');
  call.mockResolvedValue({ ok: true, body: { endpoints: {} } });
  await open('setup', card); await open('limits', card);
  expect(call).toHaveBeenCalledTimes(1);
  await open('setup', card); await open('limits', card);
  expect(call).toHaveBeenCalledTimes(1);
});

it('adopts a profile from its own field and reads the key back', async () => {
  const previous = { id: 'key-1', name: 'Workstation', isActive: true, usage: {}, maxPromptTokens: 100, allowedModels: ['old/model'], budgetPolicy: 'strict', effectiveBudgetPolicy: 'strict' };
  fixture.reads['/api/keys'] = { keys: [previous] };
  fixture.reads['/api/access-profiles'] = { profiles: [{ id: 'lab-profile', name: 'Lab', version: 1 }] };
  await mount(<KeysPage />); await click('Configure Workstation');
  const saved = { ...previous, profile: { profileId: 'lab-profile' } };
  call.mockResolvedValueOnce({ ok: true, body: { key: saved } }).mockResolvedValueOnce({ ok: true, body: { keys: [saved] } });
  await change(container.querySelector('[aria-label="Access profile for Workstation"]'), 'lab-profile');
  expect(call.mock.calls).toEqual([
    ['/api/keys/key-1/profile', { method: 'POST', body: { profileId: 'lab-profile' } }],
    ['/api/keys'],
  ]);
  expect(container.querySelector('dialog')).toBeNull();
});

it('sends only the field that changed when the allowlist is edited', async () => {
  fixture.reads['/api/keys'] = { keys: [{ id: 'key-1', name: 'Workstation', isActive: true, usage: {}, maxPromptTokens: 100, allowedModels: ['old/model'] }] };
  await mount(<KeysPage />); await click('Configure Workstation');
  call.mockResolvedValue({ ok: true, body: { keys: [{ id: 'key-1', name: 'Workstation', isActive: true, usage: {}, maxPromptTokens: 100, allowedModels: ['desired/model'] }] } });
  await commit(container.querySelector('[aria-label="Model allowlist for Workstation"]'), 'desired/model');
  expect(call.mock.calls[0]).toEqual(['/api/keys/key-1', { method: 'PUT', body: { allowedModels: ['desired/model'] } }]);
  expect(call.mock.calls[1]).toEqual(['/api/keys']);
});

it('edits a quota threshold from its own field and takes a polled change back', async () => {
  fixture.reads['/api/providers/exact-account'] = { connection: { ...account, lastQuotaSnapshot: { windows: [{ key: 'session' }] }, quotaPauseThresholds: {} } };
  await mount(<ConnectionPage params={Promise.resolve({ id: account.id })} />);
  call.mockResolvedValue({ ok: true, body: {} });
  await commit(container.querySelector('[aria-label="Auto-pause threshold for session"]'), '10');
  expect(call.mock.calls[0]).toEqual(['/api/providers/exact-account', { method: 'PUT', body: { quotaPauseThresholds: { session: 10 } } }]);
  fixture.reads['/api/providers/exact-account'] = { connection: { ...account, lastQuotaSnapshot: { windows: [{ key: 'session' }] }, quotaPauseThresholds: { session: 20 } } };
  await mount(<ConnectionPage params={Promise.resolve({ id: account.id })} />);
  expect(container.querySelector('[aria-label="Auto-pause threshold for session"]').value).toBe('20%');
});

it('acknowledges header clearing so a later unrelated account save does not repeat it', async () => {
  await mount(<AccountOptions connection={account} />);
  const clear = input('Clear all custom upstream headers');
  await act(async () => clear.click());
  call.mockResolvedValue({ ok: true, body: { connection: account } }); await click('Save account options');
  expect(call.mock.calls[0][1].body.providerSpecificData).toEqual({ customHeaders: {} });
  expect(clear.checked).toBe(false);
  await change(input('Default model'), 'new-model');
  call.mockResolvedValue({ ok: true, body: { connection: { ...account, defaultModel: 'new-model' } } }); await click('Save account options');
  expect(call.mock.calls[2][1].body.providerSpecificData).toBeUndefined();
});

it('reports an account control write whose saved value does not read back', async () => {
  await mount(<ConnectionPage params={Promise.resolve({ id: account.id })} />);
  call.mockResolvedValueOnce({ ok: true, body: {} })
    .mockResolvedValueOnce({ ok: true, body: { connection: { ...account, priority: 4 } } });
  await commit(container.querySelector('section[aria-label="Routing priority"] input'), '7');
  expect(call.mock.calls).toEqual([
    ['/api/providers/exact-account', { method: 'PUT', body: { priority: 7 } }],
    ['/api/providers/exact-account'],
  ]);
  expect(container.textContent).toContain('was accepted, but the saved state was not read back');
  expect(container.querySelector('dialog')).toBeNull();
});
