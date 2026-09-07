// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ settings: {}, calls: [], reads: [], conflict: false, hash: 'a'.repeat(64) }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => {
  state.reads.push(url);
  return { loading: false, data: url === '/api/admin/shaping' ? { settings: state.settings, currentHash: state.hash } : url === '/api/settings' ? state.settings : { windows: { all: { stages: {} } } }, goodAt: 1, refresh: vi.fn() };
} }));
vi.mock('@/shared/api', () => ({ call: async (url, options = {}) => {
  state.calls.push({ url, ...options });
  if (options.method === 'POST') {
    if (state.conflict) return { ok: false, status: 409, body: { code: 'settings_conflict' } };
    state.settings = { ...state.settings, ...options.body.patch }; state.hash = 'b'.repeat(64);
    return { ok: true, status: 200, body: { afterHash: state.hash } };
  }
  return { ok: true, status: 200, body: { settings: state.settings, currentHash: state.hash } };
} }));
vi.mock('@/app/dashboard/shaping/Workbench', () => ({ ShapingWorkbench: () => null }));
vi.mock('@/app/dashboard/shaping/PlanOverrides', () => ({ PlanOverrides: () => null }));
import ShapingPage from '@/app/dashboard/shaping/page';
import { CONTROLS } from '@/app/dashboard/shaping/controlCatalog';
let container, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  localStorage.clear(); state.calls = []; state.reads = []; state.conflict = false; state.hash = 'a'.repeat(64);
  state.settings = Object.fromEntries(CONTROLS.map(control => [control.key, false]));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<MantineProvider env="test"><ShapingPage /></MantineProvider>)); }
async function review() { await render(); await act(async () => container.querySelector('[data-savings-control="rtkEnabled"] input').click()); }
async function submit() { await act(async () => container.querySelector('dialog form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

it('opens the simple view without service calls and requires explicit consent before a save', async () => {
  await review();
  expect(container.querySelector('h1').textContent).toBe('Token savings');
  expect(container.querySelector('dialog').open).toBe(true);
  expect(state.reads.some(url => /pxpipe|headroom|runtime/.test(url))).toBe(false);
  await submit();
  expect(state.calls).toEqual([]);
  expect(container.querySelector('dialog').textContent).toContain('Review and consent');
});

it('saves through the existing hash and consent boundary then verifies the refreshed setting', async () => {
  await review();
  await act(async () => container.querySelector('dialog input[type="checkbox"]').click());
  await submit();
  expect(state.calls).toEqual([
    { url: '/api/admin/shaping/controls', method: 'POST', body: { patch: { rtkEnabled: true }, expectedCurrent: 'a'.repeat(64), consent: ['rtkEnabled'] } },
    { url: '/api/admin/shaping' },
  ]);
  expect(container.textContent).toContain('Tool result reducer saved and verified after refresh');
  expect(container.querySelector('dialog').open).toBe(false);
  expect(container.querySelector('[data-savings-control="rtkEnabled"] input').checked).toBe(true);
});

it('retains a refused change and the saved off state after a settings conflict', async () => {
  state.conflict = true; await review();
  await act(async () => container.querySelector('dialog input[type="checkbox"]').click());
  await submit();
  expect(state.calls).toHaveLength(1);
  expect(container.querySelector('dialog').open).toBe(true);
  expect(container.querySelector('dialog').textContent).toContain('Settings changed after this view was read');
  expect(container.querySelector('[data-savings-control="rtkEnabled"] input').checked).toBe(false);
});
