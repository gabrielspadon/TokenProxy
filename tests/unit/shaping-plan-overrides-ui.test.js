// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ plans: null, history: null, calls: [], response: null, readback: null, receipt: null }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: url.includes('plan-receipts') ? state.history : state.plans, refresh: vi.fn() }) }));
vi.mock('@/shared/api', () => ({ call: async (url, options = {}) => {
  state.calls.push({ url, ...options });
  return options.method === 'POST' ? state.response : url.includes('plan-receipts') ? { ok: true, body: state.receipt } : state.readback;
} }));
import { PlanOverrides } from '../../src/app/dashboard/shaping/PlanOverrides';
let container, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  state.calls = [];
  state.plans = { settingsHash: 'g'.repeat(64), plans: [{ id: 'plan-a', name: 'PlanA', controls: {}, currentHash: 'a'.repeat(64), effective: { cavemanEnabled: false } }] };
  state.history = { rows: [], pagination: { pages: 0, total: 0 } };
  state.receipt = { id: 'receipt-a', name: 'PlanA', before: {}, after: { caveman: true }, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), scope: 'Per-plan tokenSaver only', createdAt: '2026-09-07T10:00:00.000Z' };
  state.response = { ok: true, status: 200, body: { persistence: 'confirmed', receipt: state.receipt } };
  state.readback = { ok: true, body: { plans: [{ name: 'PlanA', currentHash: 'b'.repeat(64) }] } };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
async function click(text) { await act(async () => button(text).click()); }
async function select(label, value) {
  const element = [...container.querySelectorAll('label')].find(node => node.textContent === label);
  const input = document.getElementById(element.htmlFor);
  await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function render() { await act(async () => root.render(<MantineProvider env="test"><PlanOverrides globalSettings={{ cavemanEnabled: false, memoryToolPruningEnabled: true }} /></MantineProvider>)); }
async function stage() { await render(); await select('Routing plan', 'PlanA'); await select('Compact response instructions', 'on'); await click('Review plan changes'); }
it('freezes the reviewed hashes, requires consent and verifies the exact retained receipt', async () => {
  await stage();
  expect(button('Save plan controls').disabled).toBe(true);
  state.plans.settingsHash = 'h'.repeat(64); state.plans.plans[0] = { ...state.plans.plans[0], currentHash: 'z'.repeat(64) };
  await render();
  await act(async () => container.querySelector('input[type="checkbox"]').click());
  await click('Save plan controls');
  expect(state.calls[0]).toMatchObject({ method: 'POST', body: { name: 'PlanA', patch: { caveman: true }, expectedCurrent: 'a'.repeat(64), expectedSettings: 'g'.repeat(64) } });
  expect(state.calls.map(call => call.url)).toContain('/api/admin/shaping/plan-receipts/receipt-a');
  expect(container.textContent).toContain('saved and verified from retained state');
  expect(container.textContent).toContain('receipt-a');
});
it('retains a stale draft with a conflict notice and never automatically replays it', async () => {
  await stage(); state.response = { ok: false, status: 409, body: { code: 'settings_conflict' } };
  await act(async () => container.querySelector('input[type="checkbox"]').click()); await click('Save plan controls');
  expect(container.textContent).toContain('The plan or global settings changed');
  expect(container.textContent).toContain('Inherit → On');
  expect(state.calls).toHaveLength(1);
});
it('blocks replay when the transport outcome is unknown', async () => {
  await stage(); state.response = { ok: false, status: 0, body: { code: 'network' } };
  await act(async () => container.querySelector('input[type="checkbox"]').click()); await click('Save plan controls');
  expect(container.textContent).toContain('The save outcome is unknown');
  expect(button('Save plan controls').disabled).toBe(true);
  expect(state.calls).toHaveLength(1);
});
it('reads an earlier retained receipt after a new component mount', async () => {
  state.history.rows = [state.receipt]; state.history.pagination.total = 1; state.history.pagination.pages = 1;
  await render(); await select('Retained plan change', 'receipt-a');
  expect(container.textContent).toContain('receipt-a');
  expect(state.calls).toEqual([{ url: '/api/admin/shaping/plan-receipts/receipt-a' }]);
});
