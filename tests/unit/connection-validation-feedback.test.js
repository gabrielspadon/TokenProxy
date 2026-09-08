// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import ProviderControls from '@/app/dashboard/connections/ProviderControls';

const fixture = vi.hoisted(() => ({ validation: null, calls: [], refresh: vi.fn(), providerSpecificData: {}, pools: [], quotaPauseThresholds: {}, lastQuotaSnapshot: null, settings: {} }));
vi.mock('react', async original => ({ ...await original(), use: () => ({ id: 'c-1' }) }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({
  loading: false, goodAt: 1, refresh: fixture.refresh,
  data: url === '/api/providers/c-1'
    ? { connection: { id: 'c-1', provider: 'openai', authType: 'apikey', name: 'Fixture account', isActive: true, maxConcurrent: 3, providerSpecificData: fixture.providerSpecificData, quotaPauseThresholds: fixture.quotaPauseThresholds, lastQuotaSnapshot: fixture.lastQuotaSnapshot } }
    : url === '/api/admin/qualification/c-1'
      ? { status: 'healthy', validation: fixture.validation, generation: { ok: true, model: 'old-default' } }
      : url === '/api/settings' ? { providerStrategies: { openai: { maxConcurrent: 9, unrelated: 'preserve' } } }
        : { connections: [], proxyPools: fixture.pools },
}) }));
vi.mock('@/shared/api', () => ({ call: vi.fn(async (url, options) => {
  fixture.calls.push({ url, ...options });
  if (url === '/api/settings') {
    const patch = options?.body?.providerStrategyPatch;
    if (patch) fixture.settings = { ...fixture.settings, providerStrategies: { ...fixture.settings.providerStrategies, [patch.providerId]: { ...fixture.settings.providerStrategies[patch.providerId], ...patch.values } } };
    return { ok: true, body: fixture.settings };
  }
  return { ok: true, body: {} };
}) }));
const { default: ConnectionPage } = await import('../../src/app/dashboard/connections/[id]/page.js');
let root, container;
beforeEach(async () => {
  fixture.calls = [];
  fixture.settings = { providerStrategies: { openai: { maxConcurrent: 9, unrelated: 'preserve' } } };
  fixture.providerSpecificData = {};
  fixture.pools = [];
  fixture.quotaPauseThresholds = {};
  fixture.lastQuotaSnapshot = null;
  fixture.validation = { ok: true, kind: 'provider-validation', model: null, latencyMs: 22,
    checkedAt: '2026-09-06T12:00:00.000Z', generationVerified: false, upstreamContact: 'not-recorded' };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function mount() { await act(async () => root.render(<MantineProvider env="test"><ConnectionPage params={Promise.resolve({ id: 'c-1' })} /></MantineProvider>)); }
function fact(label) { return [...container.querySelectorAll('dt')].find(e => e.textContent === label)?.nextElementSibling.textContent; }
const button = (label, scope = container) => [...scope.querySelectorAll('button')].find(node => node.textContent.trim().endsWith(label));
const task = title => [...container.querySelectorAll('.account-task-form')].find(node => node.querySelector('h2').textContent === title);
async function click(label, scope) { await act(async () => button(label, scope).click()); }
it('renders a check result separately from generation and independent capacity limits', async () => {
  await mount();
  expect(fact('Account ceiling')).toBe('3');
  expect(fact('Provider ceiling')).toBe('9');
  await click('Diagnostics');
  expect(fact('Verdict')).toBe('Check passed');
  expect(fact('Generation')).toBe('Not verified by this check');
  expect(fact('Model')).toBe('Not recorded');
  expect(container.textContent).not.toContain('Answered');
});
it('keeps missing canonical validation unknown despite an old legacy success field', async () => {
  fixture.validation = null; await mount(); await click('Diagnostics');
  expect(fact('Verdict')).toBe('Not established');
  expect(fact('Observed')).toBe('Not recorded');
});
it('clears only the selected provider ceiling through the supported field patch', async () => {
  await act(async () => root.render(<MantineProvider env="test"><ProviderControls onSaved={fixture.refresh} /></MantineProvider>));
  const provider = container.querySelector('select');
  await act(async () => { provider.value = 'openai'; provider.dispatchEvent(new Event('change', { bubbles: true })); });
  const input = [...container.querySelectorAll('label')].find(label => label.textContent === 'Shared provider concurrency ceiling').control;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Save provider ceiling');
  expect(fixture.calls.filter(call => call.method === 'PATCH')).toEqual([{ url: '/api/settings', method: 'PATCH', body: { providerStrategyPatch: { providerId: 'openai', values: { maxConcurrent: null } } } }]);
  expect(fixture.calls.filter(call => !call.method)).toHaveLength(3);
  expect(fixture.settings.providerStrategies.openai).toEqual({ maxConcurrent: null, unrelated: 'preserve' });
  expect(container.textContent).toContain('Provider setting saved and read back');
  expect(fixture.refresh).toHaveBeenCalled();
});
it('renders a selected pool ahead of a retained direct marker and restores direct after clearing it', async () => {
  fixture.providerSpecificData = { connectionProxyMode: 'direct', proxyPoolId: 'pool-1', strictProxy: true };
  fixture.pools = [{ id: 'pool-1', name: 'Selected fixture pool', isActive: true, strictProxy: true }];
  await mount();
  expect(fact('Proxy pool')).toContain('Selected fixture pool');
  expect(fact('Proxy pool')).not.toContain('direct');
  fixture.providerSpecificData = { connectionProxyMode: 'direct' };
  await mount();
  expect(fact('Proxy pool')).toContain('Explicit direct');
});

it('edits the union of exact snapshot keys and saved thresholds without losing configured-only windows', async () => {
  fixture.lastQuotaSnapshot = { windows: [{ key: 'session (5h)' }, { key: 'session (5h)' }] };
  fixture.quotaPauseThresholds = { 'session (5h)': 10, 'weekly (7d)': 20 };
  await mount();
  const surface = task('Quota pause thresholds');
  expect([...surface.querySelectorAll('label.field > span')].map(e => e.textContent)).toEqual(['session (5h)', 'weekly (7d)']);
  expect(surface.textContent).toContain('at or below');
  expect(surface.textContent).toContain('Set 0 or leave empty');
  expect(surface.textContent).not.toContain('default policy');
  const inputs = surface.querySelectorAll('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], '0');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Review quota pause thresholds', surface);
  const dialog = container.querySelector('dialog[open]'); expect(dialog.querySelector('input')).toBeNull();
  await click('Save', dialog);
  expect(fixture.calls).toEqual([{ url: '/api/providers/c-1', method: 'PUT', body: { quotaPauseThresholds: { 'session (5h)': 0, 'weekly (7d)': 20 } } }]);
});

it('shows unknown quota windows without fabricating a 5h input and keeps priority editable', async () => {
  await mount();
  const thresholds = task('Quota pause thresholds');
  expect(thresholds.querySelectorAll('input')).toHaveLength(0);
  expect(thresholds.textContent).toContain('No exact quota windows have been observed or configured');
  const input = task('Routing priority').querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '4');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Review routing priority');
  const dialog = container.querySelector('dialog[open]'); expect(dialog.querySelector('input')).toBeNull();
  await click('Save', dialog);
  expect(fixture.calls).toEqual([{ url: '/api/providers/c-1', method: 'PUT', body: { priority: 4 } }]);
});

it('allows fractional quota thresholds through native form validation and preserves their exact value', async () => {
  fixture.quotaPauseThresholds = { 'session (5h)': 12.5 }; await mount();
  const surface = task('Quota pause thresholds'), form = surface.querySelector('form'), input = surface.querySelector('input');
  expect(input.value).toBe('12.5'); expect(input.validity.stepMismatch).toBe(false); expect(form.checkValidity()).toBe(true);
  await click('Review quota pause thresholds', surface); await click('Save', container.querySelector('dialog[open]'));
  expect(fixture.calls).toEqual([{ url: '/api/providers/c-1', method: 'PUT', body: { quotaPauseThresholds: { 'session (5h)': 12.5 } } }]);
});
