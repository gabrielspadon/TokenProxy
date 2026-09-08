// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.search), usePathname: () => '/dashboard/requests', useRouter: () => ({ replace: state.replace }) }));
vi.mock('@/shared/components/request-workbench/catalog', () => ({ localCatalogue: () => [{ id: 'fixture/model', name: 'Synthetic local model', providerLabel: 'Synthetic provider', params: ['temperature'] }], operationProviders: () => ['Synthetic provider'] }));
const { RequestWorkbench } = await import('../../src/shared/components/request-workbench/RequestWorkbench');
let container, root;
const button = label => [...container.querySelectorAll('button')].find(element => element.textContent === label);
const mount = async () => { await act(async () => root.render(<MantineProvider env="test"><RequestWorkbench /></MantineProvider>)); };
const change = async (element, value) => {
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
beforeEach(() => {
  state.search = ''; state.replace.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() } });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'Synthetic answer' } }] })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('opens with no network request, exposes every operation, and leaves sending disabled without a key', async () => {
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelectorAll('select option')).toHaveLength(20);
  expect(button('Send gateway request').disabled).toBe(true);
  expect(container.textContent).toContain('No provider requests run when you open this page');
  expect(container.querySelector('a[href="/dashboard/compatibility"]')).toBeTruthy();
});
it('validates without inference and only explicit sending consumes the transient password field', async () => {
  await mount();
  const editor = container.querySelector('textarea[aria-label="Native request JSON"]');
  await change(editor, JSON.stringify({ model: 'fixture/model', messages: [{ role: 'user', content: 'Synthetic request' }], stream: false }));
  await act(async () => button('Validate locally').click());
  expect(container.textContent).toContain('Locally valid');
  expect(fetch).not.toHaveBeenCalled();
  await change(container.querySelector('input[type="password"]'), 'synthetic-client-key');
  await act(async () => button('Send gateway request').click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('/v1/chat/completions');
  expect(container.querySelector('input[type="password"]').value).toBe('');
  expect(container.textContent).toContain('Synthetic answer');
  expect(container.textContent).not.toContain('synthetic-client-key');
  expect(button('Export redacted diagnostic')).toBeTruthy();
});
it('retains the input and stops observation without replay after cancellation', async () => {
  fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Synthetic abort', 'AbortError')))));
  await mount();
  const native = JSON.stringify({ model: 'fixture/model', messages: [{ role: 'user', content: 'Keep this draft' }] });
  await change(container.querySelector('textarea[aria-label="Native request JSON"]'), native);
  await change(container.querySelector('input[type="password"]'), 'synthetic-client-key');
  await act(async () => { button('Send gateway request').click(); });
  expect(button('Stop waiting')).toBeTruthy();
  await act(async () => button('Stop waiting').click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('The gateway or provider may already have accepted work');
  expect(container.querySelector('textarea[aria-label="Native request JSON"]').value).toBe(native);
});
it('prepares a video poll with the exact returned ID and account, without polling automatically', async () => {
  state.search = 'operation=video-generate';
  fetch.mockResolvedValue(Response.json({ request_id: 'synthetic-job', status: 'pending' }, { headers: { 'x-tokenproxy-connection-id': 'synthetic-account' } }));
  await mount();
  await change(container.querySelector('textarea[aria-label="Native request JSON"]'), JSON.stringify({ model: 'xai/synthetic-video', prompt: 'Synthetic scene' }));
  await change(container.querySelector('input[type="password"]'), 'synthetic-client-key');
  await act(async () => button('Send gateway request').click());
  await act(async () => button('Prepare status check').click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(state.replace).toHaveBeenCalledWith('/dashboard/requests?operation=video-poll', { scroll: false });
  state.search = 'operation=video-poll'; await mount();
  expect([...container.querySelectorAll('input')].some(input => input.value === 'synthetic-job')).toBe(true);
  expect([...container.querySelectorAll('input')].some(input => input.value === 'synthetic-account')).toBe(true);
});
