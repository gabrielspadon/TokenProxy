// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: null, calls: [], response: null, receipt: null }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: url.includes('receipts') ? { rows: [], pagination: { pages: 0, total: 0 } } : state.current, refresh: vi.fn() }) }));
vi.mock('@/shared/api', () => ({ call: async (url, options = {}) => {
  state.calls.push({ url, ...options });
  return options.method === 'POST' ? state.response : url.includes('receipts') ? { ok: true, body: state.receipt } : { ok: true, body: { ...state.current, currentHash: 'b'.repeat(64) } };
} }));
import { RuntimeSettings } from '../../src/app/dashboard/shaping/RuntimeSettings';
let container, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  state.calls = [];
  state.current = { currentHash: 'a'.repeat(64), settings: { headroomUrl: 'http://127.0.0.1:8787', embedReorderUrl: 'http://127.0.0.1:11434/v1/embeddings', embedReorderModel: 'fixture-embedding', pxpipeAutoInstall: true, contextStructureEnabled: true } };
  state.receipt = { id: 'receipt-a', before: { settings: state.current.settings }, after: { settings: { ...state.current.settings, pxpipeAutoInstall: false } }, changedKeys: ['pxpipeAutoInstall'], afterHash: 'b'.repeat(64), scope: 'Shaping service settings and structural recording only' };
  state.response = { ok: true, status: 200, body: { persistence: 'confirmed', receipt: state.receipt, afterHash: 'b'.repeat(64) } };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
async function click(text) { await act(async () => button(text).click()); }
async function checkbox(label) {
  const element = [...container.querySelectorAll('label')].find(node => node.textContent === label);
  await act(async () => document.getElementById(element.htmlFor).click());
}
async function stage() {
  await act(async () => root.render(<MantineProvider env="test"><RuntimeSettings /></MantineProvider>));
  await checkbox('Allow automatic PXPIPE installation'); await click('Review service settings');
}
it('saves and verifies local configuration without contacting a sidecar or loading a service', async () => {
  await stage(); expect(state.calls).toEqual([]);
  expect(button('Save service settings').disabled).toBe(true);
  await checkbox('I reviewed request-data destinations, installation permission and structural recording effects.'); await click('Save service settings');
  expect(state.calls[0]).toMatchObject({ url: '/api/admin/shaping/runtime', method: 'POST', body: { patch: { pxpipeAutoInstall: false }, expectedCurrent: 'a'.repeat(64), acknowledgeRequestData: true } });
  expect(state.calls.map(call => call.url)).toEqual(['/api/admin/shaping/runtime', '/api/admin/shaping/runtime', '/api/admin/shaping/runtime-receipts/receipt-a']);
  expect(container.textContent).toContain('saved and verified. No service was contacted');
});
it('preserves a refused nonsecret draft and blocks an uncertain replay', async () => {
  await stage(); state.response = { ok: false, status: 0, body: { code: 'network' } };
  await checkbox('I reviewed request-data destinations, installation permission and structural recording effects.'); await click('Save service settings');
  expect(container.textContent).toContain('Save outcome unknown');
  expect(container.textContent).toContain('On → Off');
  expect(button('Save service settings').disabled).toBe(true);
  expect(state.calls).toHaveLength(1);
});
