// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import AccountOptions from '@/app/dashboard/connections/AccountOptions';
import ProviderImports from '@/app/dashboard/connections/ProviderImports';
import NetworkOptions from '@/app/dashboard/network/NetworkOptions';
import AccessPage from '@/app/dashboard/access/page';
import ConnectionsPage from '@/app/dashboard/connections/page';
import { kiroSocialCode } from '@/app/dashboard/connections/KiroSocial';
import ProviderControls from '@/app/dashboard/connections/ProviderControls';
import { ClientSetup } from '@/app/dashboard/keys/ClientSetup';
import { call } from '@/shared/api';

const fixture = vi.hoisted(() => ({ reads: {}, refresh: vi.fn() }));
vi.mock('@/shared/api', () => ({ call: vi.fn() }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: fixture.reads[url] || {}, loading: false, goodAt: 1, refresh: fixture.refresh }) }));
vi.mock('@/shared/workspace/SelectionDock', () => ({ SelectionDock: ({ children }) => <div>{children}</div> }));
let root, container;
beforeEach(() => {
  vi.clearAllMocks(); fixture.reads = {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function mount(element) { await act(async () => root.render(<MantineProvider env="test">{element}</MantineProvider>)); }
const button = (label, scope = document) => [...scope.querySelectorAll('button')].find(item => item.textContent.trim().endsWith(label));
async function click(label, scope) { await act(async () => button(label, scope).click()); }
const input = (label, scope = document) => [...scope.querySelectorAll('label')].find(item => item.textContent.includes(label) && item.control)?.control;
async function change(element, value) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function submit() { await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

it('does not report an accepted account option write as verified when readback differs', async () => {
  const connection = { id: 'fixture-account', provider: 'azure', name: 'Fixture account', providerSpecificData: { deployment: 'old' } };
  call.mockResolvedValueOnce({ ok: true, body: {} }).mockResolvedValueOnce({ ok: true, body: { connection } });
  await mount(<AccountOptions connection={connection} />);
  await change(input('Deployment'), 'new'); await submit();
  expect(call.mock.calls[0]).toEqual(['/api/providers/fixture-account', { method: 'PUT', body: { name: 'Fixture account', defaultModel: null, globalPriority: null, maxConcurrent: null, providerSpecificData: { deployment: 'new' } } }]);
  expect(document.body.textContent).toContain('saved state could not be confirmed');
  expect(button('Save account options').disabled).toBe(true);
  expect(input('Deployment').value).toBe('new');
});

it('keeps the nonsecret import draft on refusal and clears its credential', async () => {
  call.mockResolvedValue({ ok: false, status: 403, body: { error: 'fixture-secret must never render' } });
  await mount(<ProviderImports />);
  await change(input('Import mechanism'), 'codex-token');
  await change(input('Access token'), 'fixture-secret'); await change(input('Account name'), 'Fixture account'); await submit();
  expect(call).toHaveBeenCalledWith('/api/oauth/codex/import-token', { method: 'POST', body: { accessToken: 'fixture-secret', name: 'Fixture account' } });
  expect(input('Access token').value).toBe(''); expect(input('Account name').value).toBe('Fixture account');
  expect(document.body.textContent).not.toContain('fixture-secret');
  expect(document.body.textContent).toContain('Import was refused');
});

it('requires an explicit proxy test target before making any request', async () => {
  await mount(<NetworkOptions actionId="test" />);
  await change(input('Proxy URL'), 'http://fixture.invalid:8080'); await submit();
  expect(call).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('explicit test target URL');
});

it('saves edited SAML mappings while preserving an untouched certificate and nonsecret defaults', async () => {
  const settings = { samlEntryPoint: 'https://fixture.invalid/saml', samlIssuer: 'fixture-gateway', samlAttributeName: 'displayName', samlAttributeEmail: 'mail', samlLoginLabel: 'Fixture SSO' };
  fixture.reads['/api/auth/status'] = { authMode: 'sso', ssoType: 'saml', requireLogin: true, samlConfigured: true };
  fixture.reads['/api/settings'] = settings;
  call.mockResolvedValueOnce({ ok: true, body: {} }).mockResolvedValueOnce({ ok: true, body: { ...settings, samlAttributeName: 'commonName' } });
  await mount(<AccessPage />); await change(input('Display-name attribute'), 'commonName'); await click('Review configuration');
  const dialog = container.querySelector('dialog[open]'); await click('Save configuration', dialog);
  expect(call.mock.calls[0]).toEqual(['/api/settings', { method: 'PATCH', body: { ...settings, samlAttributeName: 'commonName' } }]);
  expect(container.textContent).toContain('Sign-in has not been tested');
});

it('restores a named release record with its concurrency version and verifies the exact stored record', async () => {
  const active = { releaseId: 'fixture-current', version: 'current', concurrencyVersion: 'version-1', status: 'active' };
  const target = { releaseId: 'fixture-old', version: 'old', status: 'rolled_back' };
  fixture.reads['/api/admin/activation'] = { active, history: [active, target] };
  const saved = { ...target, status: 'active', concurrencyVersion: 'version-2' };
  call.mockResolvedValueOnce({ ok: true, body: saved }).mockResolvedValueOnce({ ok: true, body: { active: saved } });
  await mount(<ConnectionsPage />); await change(input('Release record'), target.releaseId); await click('Restore a record');
  const dialog = container.querySelector('dialog[open]'); expect(dialog.querySelector('select')).toBeNull(); await click('Restore record', dialog);
  expect(call.mock.calls).toEqual([['/api/admin/rollback', { method: 'POST', body: { ifMatch: 'version-1', toReleaseId: target.releaseId } }], ['/api/admin/activation']]);
  expect(container.textContent).toContain('Recorded active release');
  expect(fixture.refresh).toHaveBeenCalled();
});

it('refuses Kiro callbacks from a different sign-in before extracting an authorization code', () => {
  const callback = 'kiro://kiro.kiroAgent/authenticate-success?code=fixture-code&state=fixture-state';
  expect(kiroSocialCode(callback, 'fixture-state')).toBe('fixture-code');
  expect(() => kiroSocialCode(callback, 'another-state')).toThrow('another sign-in');
  expect(() => kiroSocialCode(callback.replace('kiro:', 'https:'), 'fixture-state')).toThrow('not a Kiro');
});

it('creates a dynamic node account with exact provider identity and verifies the created row', async () => {
  fixture.reads['/api/provider-nodes'] = { nodes: [{ id: 'openai-compatible-fixture', name: 'Fixture node', type: 'openai-compatible' }] };
  const connection = { id: 'fixture-created', provider: 'openai-compatible-fixture' };
  call.mockResolvedValue({ ok: true, body: { connection } });
  await mount(<ConnectionsPage />); await click('Add a connection');
  const surface = container.querySelector('[aria-label="Add a connection"]'); await change(input('Provider', surface), connection.provider);
  await change(input('Name', surface), 'Fixture account'); await click('Review account', surface);
  const dialog = container.querySelector('dialog[open]'); expect(dialog.querySelector('input, select, textarea')).toBeNull(); await click('Add', dialog);
  expect(call.mock.calls).toEqual([['/api/providers', { method: 'POST', body: { provider: connection.provider, name: 'Fixture account', defaultModel: null, apiKey: '' } }], ['/api/providers/fixture-created']]);
  expect(dialog.textContent).toContain('The account is stored');
});

it('keeps registry OAuth-only providers out of the API-key creation branch', async () => {
  call.mockResolvedValue({ ok: true, body: { flowType: 'authorization_code_pkce' } });
  await mount(<ConnectionsPage />); await click('Add a connection');
  const surface = container.querySelector('[aria-label="Add a connection"]'); await change(input('Provider', surface), 'codex');
  expect(input('API key', surface)).toBeUndefined();
  expect(button('Review sign-in', surface)).toBeDefined();
  expect(call.mock.calls.every(([url]) => url.startsWith('/api/oauth/codex/authorize'))).toBe(true);
});

it('passes an explicit model through the client configuration check without invoking inference', async () => {
  call.mockResolvedValueOnce({ ok: true, body: { endpoints: { openaiBaseUrl: 'http://localhost/v1', anthropicBaseUrl: 'http://localhost' } } })
    .mockResolvedValueOnce({ ok: true, body: { tier: 'configuration', ok: true, findings: [] } });
  await mount(<ClientSetup record={{ id: 'fixture-key' }} />); await change(input('Model to check'), 'openai/fixture-model'); await click('Check configuration');
  expect(call.mock.calls[1]).toEqual(['/api/keys/fixture-key/connectivity', { method: 'POST', body: { tier: 'configuration', model: 'openai/fixture-model' } }]);
  expect(document.body.textContent).toContain('Nothing was contacted');
});

it('updates only the selected provider timeout and verifies its field without overwriting strategy siblings', async () => {
  const settings = { providerStrategies: { openai: { connectTimeoutMs: 8000, maxConcurrent: 4 }, codex: { maxConcurrent: 2 } } };
  call.mockResolvedValueOnce({ ok: true, body: settings }).mockResolvedValueOnce({ ok: true, body: settings })
    .mockResolvedValueOnce({ ok: true, body: {} }).mockResolvedValueOnce({ ok: true, body: { providerStrategies: { ...settings.providerStrategies, openai: { maxConcurrent: 4, connectTimeoutMs: 9000 } } } });
  await mount(<ProviderControls />); await change(input('Provider'), 'openai');
  await change(input('Provider connection timeout'), '9000'); await click('Save provider timeout');
  expect(call.mock.calls[2]).toEqual(['/api/settings', { method: 'PATCH', body: { providerStrategyPatch: { providerId: 'openai', values: { connectTimeoutMs: 9000 } } } }]);
  expect(document.body.textContent).toContain('Provider setting saved and read back');
});
