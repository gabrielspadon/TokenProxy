// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn() }));
vi.mock('@/shared/api', () => ({ call: state.call }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(''), usePathname: () => '/dashboard/notifications', useRouter: () => ({ replace() {}, push() {} }) }));
vi.mock('@/shared/workspace/NotificationRules', () => ({ NotificationRules: () => null }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: () => ({ data: { config: { enabled: false, endpoints: [], errorRate: { threshold: 0.5, windowSeconds: 300, minSamples: 20 } }, deliveries: [] }, status: 200, loading: false, refresh: state.refresh }) }));
import NotificationsPage from '@/app/dashboard/notifications/page';

let root, container;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  // The board toolbar carries a SegmentedControl, which measures itself.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  state.call.mockResolvedValue({ ok: true, status: 200, body: { ok: true, status: 204 } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MantineProvider env="test"><NotificationsPage /></MantineProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const button = (text, scope = container) => [...scope.querySelectorAll('button')].find(element => element.textContent === text);
// An irreversible act asks in place, so the confirmation is a group beside the
// control rather than a dialog over it.
const asking = title => container.querySelector(`[role="group"][aria-label="${title}"]`);
async function fill(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('tests an unsaved public address only after confirmation without creating a destination', async () => {
  expect(container.querySelector('form[aria-label="Add a destination"]')).not.toBeNull();
  expect(container.querySelector('input[type="url"]').closest('details, [role="dialog"], dialog')).toBeNull();
  await fill(container.querySelector('input[type="url"]'), 'https://example.com/synthetic-hook');
  await fill(container.querySelector('input[type="password"]'), 'synthetic-signing-value');
  await act(async () => button('Test this address without saving').click());
  expect(state.call).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="password"]').value).toBe('');
  expect(container.textContent).toContain('No destination is saved');
  const ask = asking('Test this address without saving');
  expect(ask).not.toBeNull();
  await act(async () => button('Send test', ask).click());
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/notifications/test', { method: 'POST', body: { url: 'https://example.com/synthetic-hook', secret: 'synthetic-signing-value' } });
  expect(container.textContent).toContain('Test response received');
  expect(fetch).not.toHaveBeenCalled();
});

it('separates explicit webhook evaluation from retained-rule evaluation and provider probing', async () => {
  await act(async () => button('Evaluate webhook conditions now').click());
  expect(state.call).not.toHaveBeenCalled();
  expect(container.textContent).toContain('does not probe providers or evaluate retained-evidence rules');
  const ask = asking('Evaluate webhook conditions now');
  expect(ask).not.toBeNull();
  await act(async () => button('Evaluate now', ask).click());
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/notifications', { method: 'POST' });
  expect(container.textContent).toContain('Webhook conditions evaluated');
  expect(fetch).not.toHaveBeenCalled();
});
