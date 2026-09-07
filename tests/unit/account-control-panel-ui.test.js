// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ connections: [], refresh: vi.fn() }));
vi.mock('@/shared/workspace/useResource', () => ({ useResource: () => ({ data: { connections: state.connections }, loading: false, receivedAt: '2026-09-07T19:00:00Z', refresh: state.refresh }) }));
import { AccountControlPanel } from '@/app/dashboard/AccountControlPanel';
let root, container, request;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear(); state.refresh.mockClear();
  state.connections = [{ id: 'account-a', name: 'Account A', provider: 'codex', authType: 'oauth', isActive: true, priority: 1, quotaPauseThresholds: { weekly: 10 }, lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:00:00Z', windows: [{ key: 'weekly', remainingPercentage: 25, resetAt: '2026-09-09T00:00:00Z' }] } }];
  request = vi.fn(async (_url, options) => ({ ok: true, status: 200, json: async () => ({ connection: options?.method === 'PUT' ? { ...state.connections[0], ...JSON.parse(options.body) } : state.connections[0] }) }));
  vi.stubGlobal('fetch', request); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<MantineProvider env="test"><AccountControlPanel rows={[]} onSelect={vi.fn()} /></MantineProvider>)); }
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
async function click(text) { await act(async () => button(text).click()); }

it('shows snapshot-only quota windows with a real percentage and reverses the scale for used', async () => {
  await render();
  expect(container.querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('25');
  const used = [...container.querySelectorAll('input')].find(input => input.value === 'used');
  await act(async () => used.click());
  expect(container.querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('75');
  expect(container.textContent).toContain('Pause ≤ 10% left');
});
it('reads fresh policy before pausing and retains the old state when verification fails', async () => {
  await render(); await click('Pause');
  expect(request.mock.calls.map(([, options]) => options.method || 'GET')).toEqual(['GET', 'PUT', 'GET']);
  expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ isActive: false, expectedControls: { isActive: true, priority: 1, quotaPauseThresholds: { weekly: 10 } } });
  expect(container.textContent).toContain('could not be verified');
  expect(button('Pause').disabled).toBe(true);
  expect(button('Read current settings')).not.toBeUndefined();
});
it('preserves a limits draft on conflict, requiring a new read before another save', async () => {
  await render(); await click('Limits');
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog.textContent).toContain('weekly');
  request.mockImplementation(async (_url, options) => options?.method === 'PUT' ? { ok: false, status: 409, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ connection: state.connections[0] }) });
  await click('Save limits');
  expect(dialog.textContent).toContain('Your draft is retained');
  expect(button('Save limits').disabled).toBe(true);
  expect(request.mock.calls.filter(([, options]) => options.method === 'PUT')).toHaveLength(1);
});
it('persists hidden accounts without changing routing settings', async () => {
  await render(); await click('Customize');
  const label = [...document.querySelectorAll('label')].find(node => node.textContent === 'Show Account A');
  await act(async () => document.getElementById(label.htmlFor).click());
  expect(container.querySelector('[data-account-id="account-a"]')).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('tokenproxy.account-control-panel')).hiddenAccounts).toEqual(['account-a']);
});
it('recovers malformed persisted visibility preferences before updating them', async () => {
  localStorage.setItem('tokenproxy.account-control-panel', JSON.stringify({ hiddenAccounts: 'broken', hiddenWindows: {}, density: 'compact' }));
  await render(); await click('Customize');
  for (const text of ['Show Account A', 'weekly']) {
    const label = [...document.querySelectorAll('label')].find(node => node.textContent === text);
    await act(async () => document.getElementById(label.htmlFor).click());
  }
  const saved = JSON.parse(localStorage.getItem('tokenproxy.account-control-panel'));
  expect(saved.hiddenAccounts).toEqual(['account-a']);
  expect(saved.hiddenWindows).toEqual([JSON.stringify(['account-a', 'weekly'])]);
  expect(request).not.toHaveBeenCalled();
});
