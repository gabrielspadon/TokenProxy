// @vitest-environment jsdom
// Changing the provider while a sign-in is still in flight abandons that grant.
// The row must release itself, because the guard that discards the stale result
// used to sit ahead of setBusy and left the form frozen until someone cancelled.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ grant: null, aborted: false }));
vi.mock('@/shared/api', () => ({ call: vi.fn(async () => ({ ok: true, body: { flowType: 'authorization_code' } })) }));
vi.mock('@/shared/oauthGrant', () => ({
  importPasted: vi.fn(),
  runGrant: vi.fn((provider, flowType, { signal }) => {
    signal?.addEventListener('abort', () => { fixture.aborted = true; });
    return new Promise((resolve) => { fixture.grant = resolve; });
  }),
}));
const { AddAccountRow } = await import('@/app/dashboard/AddAccountRow');

let root, container;
beforeEach(() => {
  fixture.grant = null; fixture.aborted = false;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // Mantine's Combobox scrolls the active option on a timer that outlives the
  // test; jsdom has no scrollIntoView, so the timer throws after the assertions.
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const submit = () => container.querySelector('form');
async function choose(id) {
  await act(async () => container.querySelector('[aria-label="Provider"]').click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    node => (node.getAttribute('value') || node.dataset.value) === id
  );
  await act(async () => option.click());
}

it('releases the row when the provider changes during a pending grant', async () => {
  await act(async () => root.render(<MantineProvider env="test"><AddAccountRow /></MantineProvider>));
  await choose('claude');
  await act(async () => submit().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(submit().querySelector('button[type="submit"]').disabled).toBe(true);
  await choose('kimi');
  expect(fixture.aborted).toBe(true);
  // The abandoned grant settles after the switch; the row must not stay busy.
  await act(async () => { fixture.grant({ ok: false, status: 0, body: { error: 'Cancelled.' } }); });
  expect(submit().querySelector('button[type="submit"]').disabled).toBe(false);
});
