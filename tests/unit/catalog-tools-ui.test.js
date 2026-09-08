// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn(), data: {} }));
vi.mock('@/shared/api', () => ({ call: state.call }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: state.data[url], refresh: state.refresh, loading: false }) }));
import { CatalogTools } from '@/app/dashboard/models/CatalogTools';

let root, container;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() } });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  state.data = {
    '/api/models/custom': { models: [{ providerAlias: 'p', id: 'first', type: 'llm' }, { providerAlias: 'p', id: 'second', type: 'llm' }] },
    '/api/models/catalog-sync': { url: 'https://models.dev/api.json', scheduled: true, intervalMs: 86400000, lastSync: 1000 },
    '/api/models/availability': { models: [{ provider: 'p', model: 'first', status: 'cooldown', connectionId: 'one', connectionName: 'Synthetic one', until: '2099-01-01T00:00:00Z' }] },
  };
  state.call.mockReset(); state.refresh.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MantineProvider env="test"><CatalogTools /></MantineProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text);
const input = label => { const el = [...document.querySelectorAll('label')].find(element => element.textContent.startsWith(label)); return el && document.getElementById(el.htmlFor); };
async function fill(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(text) { await act(async () => button(text).click()); }

it('does not send on mount and keeps partial import results plus the original draft after readback', async () => {
  expect(state.call).not.toHaveBeenCalled();
  const models = [{ providerAlias: 'p', id: 'new', vision: true }, { providerAlias: 'p', id: 'bad', vision: 'wrong' }];
  await fill(input('Custom model JSON'), JSON.stringify(models));
  await click('Review bulk import');
  expect(state.call).not.toHaveBeenCalled();
  state.call.mockResolvedValueOnce({ ok: true, body: { results: [{ id: 'new', success: true, added: true }, { id: 'bad', success: false, error: 'vision must be boolean' }] } }).mockResolvedValueOnce({ ok: true, body: { models: [models[0]] } });
  await click('Confirm action');
  expect(state.call.mock.calls).toEqual([['/api/models/custom', { method: 'POST', body: { models } }], ['/api/models/custom']]);
  expect(container.textContent).toContain('Batch partially completed');
  expect(container.textContent).toContain('vision must be boolean');
  expect(input('Custom model JSON').value).toBe(JSON.stringify(models));
  expect(fetch).not.toHaveBeenCalled();
});

it('sends a single repeated-id delete after showing exact selected identities', async () => {
  await fill(input('Registered provider'), 'p');
  await act(async () => { container.querySelectorAll('input[type="checkbox"]').forEach(box => box.click()); });
  await click('Review bulk deletion');
  expect(document.querySelector('[role="dialog"]').textContent).toContain('second');
  state.call.mockResolvedValueOnce({ ok: true, body: { results: [{ id: 'first', success: true }, { id: 'second', success: true }] } }).mockResolvedValueOnce({ ok: true, body: { models: [] } });
  await click('Confirm action');
  expect(state.call.mock.calls[0]).toEqual(['/api/models/custom?providerAlias=p&type=llm&id=first&id=second', { method: 'DELETE' }]);
  expect(container.textContent).toContain('Saved state verified');
});

it('keeps a successful write with failed readback unconfirmed and never repeats it', async () => {
  await fill(input('Custom model JSON'), '[{"providerAlias":"p","id":"new"}]');
  await click('Review bulk import');
  state.call.mockResolvedValueOnce({ ok: true, body: { results: [{ id: 'new', success: true, added: true }] } }).mockResolvedValueOnce({ ok: false, status: 503, body: { error: 'read unavailable' } });
  await click('Confirm action');
  expect(container.textContent).toContain('Saved outcome needs verification');
  expect(state.call).toHaveBeenCalledTimes(2);
});

it('names provider-wide cooldown scope and verifies every matching lock is absent', async () => {
  expect(container.querySelector('#catalog-tool-cooldown')).not.toBeNull();
  await click('Review cooldown clearance');
  expect(document.querySelector('[role="dialog"]').textContent).toContain('across all matching accounts');
  state.call.mockResolvedValueOnce({ ok: true, body: { ok: true } }).mockResolvedValueOnce({ ok: true, body: { models: [] } });
  await click('Confirm action');
  expect(state.call.mock.calls[0]).toEqual(['/api/models/availability', { method: 'POST', body: { action: 'clearCooldown', provider: 'p', model: 'first' } }]);
  expect(container.textContent).toContain('does not prove model access');
});

it('requires explicit confirmation for provider diagnostics and renders each mixed result', async () => {
  expect(container.querySelector('#catalog-tool-test')).not.toBeNull();
  await fill(input('Diagnostic model IDs'), 'p/first\nq/second');
  await fill(input('Optional diagnostic prompt'), 'Synthetic prompt');
  await click('Review diagnostic sends');
  expect(state.call).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]').textContent).toContain('billed usage cannot be undone');
  state.call.mockResolvedValueOnce({ ok: true, body: { ok: false, results: [{ model: 'p/first', ok: true, latencyMs: 0, preview: 'answer' }, { model: 'q/second', ok: false, error: 'synthetic refusal' }] } });
  await click('Send diagnostics');
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/models/test', { method: 'POST', body: { models: ['p/first', 'q/second'], kind: 'llm', prompt: 'Synthetic prompt' } });
  expect(container.textContent).toContain('synthetic refusal');
  expect(container.textContent).toContain('Response validated');
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps suggested membership editable and verifies exact saved order', async () => {
  expect(container.querySelector('#catalog-tool-suggest')).not.toBeNull();
  state.call.mockResolvedValueOnce({ ok: true, body: { chain: ['p/first', 'q/second'], counted: 2, tiers: { top: ['p/first'], budget: ['q/second'] } } });
  await click('Suggest a fallback plan');
  expect(container.textContent).toContain('No plan has been saved');
  await fill(input('New plan name'), 'synthetic-plan');
  await fill(input('Ordered plan members'), 'q/second\np/first');
  await click('Review suggested plan');
  state.call.mockResolvedValueOnce({ ok: true, body: { name: 'synthetic-plan' } }).mockResolvedValueOnce({ ok: true, body: { combos: [{ name: 'synthetic-plan', models: ['q/second', 'p/first'] }] } });
  await click('Confirm action');
  expect(state.call.mock.calls[1]).toEqual(['/api/combos', { method: 'POST', body: { name: 'synthetic-plan', models: ['q/second', 'p/first'], kind: 'llm' } }]);
  expect(container.textContent).toContain('Saved state verified');
});

it('synchronizes metadata only after confirmation and verifies the persisted check', async () => {
  expect(container.querySelector('#catalog-tool-sync')).not.toBeNull();
  await click('Review catalog refresh');
  expect(state.call).not.toHaveBeenCalled();
  state.call.mockResolvedValueOnce({ ok: true, body: { result: { status: 'unchanged' } } }).mockResolvedValueOnce({ ok: true, body: { lastSync: 2000, lastResult: { status: 'unchanged' } } });
  await click('Confirm action');
  expect(state.call.mock.calls).toEqual([['/api/models/catalog-sync', { method: 'POST' }], ['/api/models/catalog-sync']]);
  expect(container.textContent).toContain('Saved state verified');
});
