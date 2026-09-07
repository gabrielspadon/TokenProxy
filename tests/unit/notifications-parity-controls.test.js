// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn() }));
vi.mock('@/shared/api', () => ({ call: state.call }));
vi.mock('@/shared/workspace/NotificationRules', () => ({ NotificationRules: () => null }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: () => ({ data: { config: { enabled: false, endpoints: [], errorRate: { threshold: 0.5, windowSeconds: 300, minSamples: 20 } }, deliveries: [] }, status: 200, loading: false, refresh: state.refresh }) }));
vi.mock('@/shared/components/Confirm', () => ({ Confirm: ({ open, onConfirm, changes }) => open ? <div role="dialog"><p>{changes}</p><button onClick={onConfirm}>Confirm test action</button></div> : null }));
import NotificationsPage from '@/app/dashboard/notifications/page';

let root, container;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  state.call.mockResolvedValue({ ok: true, status: 200, body: { ok: true, status: 204 } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MantineProvider env="test"><NotificationsPage /></MantineProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const button = text => [...container.querySelectorAll('button')].find(element => element.textContent === text);
async function fill(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('tests an unsaved public address only after confirmation without creating a destination', async () => {
  await fill(container.querySelector('input[type="url"]'), 'https://example.com/synthetic-hook');
  await fill(container.querySelector('input[type="password"]'), 'synthetic-signing-value');
  await act(async () => button('Test this address without saving').click());
  expect(state.call).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="password"]').value).toBe('');
  expect(container.textContent).toContain('No destination is saved');
  await act(async () => button('Confirm test action').click());
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/notifications/test', { method: 'POST', body: { url: 'https://example.com/synthetic-hook', secret: 'synthetic-signing-value' } });
  expect(container.textContent).toContain('Test response received');
  expect(fetch).not.toHaveBeenCalled();
});

it('separates explicit webhook evaluation from retained-rule evaluation and provider probing', async () => {
  await act(async () => button('Evaluate webhook conditions now').click());
  expect(state.call).not.toHaveBeenCalled();
  expect(container.textContent).toContain('does not probe providers or evaluate retained-evidence rules');
  await act(async () => button('Confirm test action').click());
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/notifications', { method: 'POST' });
  expect(container.textContent).toContain('Webhook conditions evaluated');
  expect(fetch).not.toHaveBeenCalled();
});
