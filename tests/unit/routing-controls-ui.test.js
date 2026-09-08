// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ calls: [], resource: null, response: null, read: null, receipt: null }));
vi.mock('@/shared/workspace/useResource', () => ({ useResource: () => ({ data: state.resource, refresh: vi.fn() }) }));
vi.mock('@/shared/api', () => ({ call: async (url, options = {}) => {
  state.calls.push({ url, ...options });
  return options.method === 'POST' ? state.response : url.includes('/receipts/') ? { ok: true, body: state.receipt } : { ok: true, body: state.read };
} }));
import { AutoRouting } from '@/shared/models-policy/AutoRouting';
import { BulkOverrides } from '@/app/dashboard/model-context/BulkOverrides';
let container, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  state.calls = []; state.resource = { rules: { simple: null, coding: null, reasoning: null }, currentHash: 'a'.repeat(64), receipts: [] };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = name => [...document.querySelectorAll('button')].find(node => node.textContent === name);
async function click(name) { await act(async () => button(name).click()); }
async function input(label, value) {
  const item = [...document.querySelectorAll('label')].find(node => node.textContent === label);
  const node = document.getElementById(item.htmlFor);
  await act(async () => { Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function render(node) { await act(async () => root.render(<MantineProvider env="test">{node}</MantineProvider>)); }
it('reviews all three automatic rules and reads the exact local receipt after saving', async () => {
  state.receipt = { id: 'receipt-a', before: state.resource.rules, after: { simple: 'openai/fixture', coding: null, reasoning: null }, afterHash: 'b'.repeat(64) };
  state.response = { ok: true, status: 200, body: { persistence: 'confirmed', currentHash: 'b'.repeat(64), receipt: state.receipt } };
  state.read = { ...state.resource, currentHash: 'b'.repeat(64), rules: state.receipt.after };
  await render(<AutoRouting />); await input('Simple request target', 'openai/fixture'); await click('Review automatic rules');
  expect(state.calls).toHaveLength(0);
  await click('Save automatic rules');
  expect(state.calls[0]).toMatchObject({ method: 'POST', url: '/api/admin/auto-routing', body: { expectedCurrent: 'a'.repeat(64), rules: { simple: 'openai/fixture', coding: null, reasoning: null } } });
  expect(state.calls.at(-1).url).toBe('/api/admin/auto-routing/receipts/receipt-a');
  expect(container.textContent).toContain('saved and verified');
});
it('retains automatic rules and blocks an interrupted submission', async () => {
  state.response = { ok: false, status: 0 };
  await render(<AutoRouting />); await input('Simple request target', 'openai/fixture'); await click('Review automatic rules'); await click('Save automatic rules');
  expect(container.textContent).toContain('Rules were not confirmed');
  expect(button('Save automatic rules').disabled).toBe(true);
  expect(container.querySelector('input').value).toBe('openai/fixture');
  expect(state.calls).toHaveLength(1);
});
it('rebases a retained automatic draft after conflict and requires renewed review before saving', async () => {
  state.response = { ok: false, status: 409 };
  await render(<AutoRouting />); await input('Simple request target', 'openai/intended');
  await click('Review automatic rules'); await click('Save automatic rules');
  expect(container.textContent).toContain('Rules changed after review');
  expect(button('Save automatic rules')).toBeUndefined();
  expect(button('Review automatic rules').disabled).toBe(true);
  state.read = { ...state.resource, currentHash: 'b'.repeat(64), rules: { simple: 'openai/concurrent', coding: null, reasoning: null } };
  await click('Refresh rules');
  expect(container.querySelector('input').value).toBe('openai/intended');
  expect(button('Save automatic rules')).toBeUndefined();
  expect(state.calls.filter(row => row.method === 'POST')).toHaveLength(1);
  await click('Review automatic rules');
  expect(container.querySelector('dd').textContent).toBe('openai/concurrent → openai/intended');
  state.receipt = { id: 'receipt-rebased', before: state.read.rules, after: { simple: 'openai/intended', coding: null, reasoning: null }, afterHash: 'c'.repeat(64) };
  state.response = { ok: true, status: 200, body: { persistence: 'confirmed', currentHash: 'c'.repeat(64), receipt: state.receipt } };
  state.read = { ...state.read, currentHash: 'c'.repeat(64), rules: state.receipt.after };
  await click('Save automatic rules');
  expect(state.calls.filter(row => row.method === 'POST').at(-1).body).toEqual({ expectedCurrent: 'b'.repeat(64), rules: state.receipt.after });
  expect(state.calls.at(-1).url).toBe('/api/admin/auto-routing/receipts/receipt-rebased');
  expect(container.textContent).toContain('saved and verified');
});
it('guards a mixed bulk set/remove using reviewed keys and accepts unrelated readback siblings', async () => {
  const receive = vi.fn();
  state.response = { ok: true, status: 200, body: { success: true, persistence: 'confirmed' } };
  state.read = { overrides: { 'openai/fixture': 128000, sibling: 45000 } };
  await render(<BulkOverrides overrides={{ old: 10000 }} onReadback={receive} />);
  await click('Edit several overrides'); await input('Overrides to set', 'openai/fixture = 128000'); await input('Override keys to remove', 'old'); await click('Review exact keys');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('#model-context-bulk-editor')).not.toBeNull();
  expect(state.calls).toHaveLength(0);
  await click('Save reviewed overrides');
  expect(state.calls[0].body).toEqual({ set: [{ key: 'openai/fixture', contextWindow: 128000 }], deleteKeys: ['old'], expectedOverrides: { 'openai/fixture': null, old: 10000 } });
  expect(receive).toHaveBeenCalledWith(state.read);
  expect(document.body.textContent).toContain('1 set and 1 remove operations saved and verified');
});
it('reports post-commit persistence uncertainty even when the current process reads changed override values', async () => {
  state.response = { ok: true, status: 207, body: { success: true, persistence: 'unconfirmed' } };
  state.read = { overrides: { exact: 20000 } };
  await render(<BulkOverrides overrides={{ exact: 10000 }} onReadback={vi.fn()} />);
  await click('Edit several overrides'); await input('Overrides to set', 'exact = 20000'); await click('Review exact keys'); await click('Save reviewed overrides');
  expect(document.body.textContent).toContain('persisted readback is incomplete');
  expect(button('Save reviewed overrides').disabled).toBe(true);
  expect(document.querySelector('textarea').value).toBe('exact = 20000');
});

it('invalidates an inline bulk review when its visible values change', async () => {
  await render(<BulkOverrides overrides={{ exact: 10000 }} onReadback={vi.fn()} />);
  await click('Edit several overrides'); await input('Overrides to set', 'exact = 20000'); await click('Review exact keys');
  expect(button('Save reviewed overrides')).toBeDefined();
  await input('Overrides to set', 'exact = 30000');
  expect(button('Save reviewed overrides')).toBeUndefined();
  expect(state.calls).toHaveLength(0);
  await click('Review exact keys');
  expect(container.querySelector('.model-context-bulk-review').textContent).toContain('10,000 tokens → 30,000 tokens');
});
