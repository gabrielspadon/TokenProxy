// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { preparePlanImport } from '@/shared/models-policy/planTransferModel';
import { PlanTransfer } from '@/shared/models-policy/PlanTransfer';

const current = { combos: [{ id: 'keep-id', name: 'Work', kind: 'llm', models: ['openai/old'] }, { id: 'other-id', name: 'Other', models: ['openai/other'], kind: 'llm' }], aliases: { exact: 'openai/old' }, settings: { comboStrategy: 'fusion', comboStrategies: { Work: { memberConnections: { 'openai/old': 'account-a' }, fusionTuning: { minPanel: 1 }, judgeModel: 'openai/old-judge' } } } };
const file = JSON.stringify({ version: 2, combos: [{ name: 'Work', kind: 'llm', models: ['openai/second', 'openai/first'], strategy: { fallbackStrategy: 'fallback' } }, { name: 'New', models: ['openai/new'], roundRobin: true }] });
it('merges exact names and ordered members without changing aliases, siblings or unexported restrictions', () => {
  const before = structuredClone(current), result = preparePlanImport(file, current, { createId: () => 'new-id' });
  expect(current).toEqual(before);
  expect(result.document.combos[0]).toEqual({ id: 'keep-id', name: 'Work', kind: 'llm', models: ['openai/second', 'openai/first'] });
  expect(result.document.combos[1]).toEqual(before.combos[1]);
  expect(result.document.aliases).toEqual(before.aliases);
  expect(result.document.settings.comboStrategies.Work).toEqual({ memberConnections: { 'openai/old': 'account-a' }, fusionTuning: { minPanel: 1 }, fallbackStrategy: 'fallback' });
  expect(result.document.settings.comboStrategies.New.fallbackStrategy).toBe('round-robin');
  expect(result).toMatchObject({ added: ['New'], updated: ['Work'], retained: ['Other'] });
});
it('requires explicit capacity exclusion and rejects malformed, ambiguous or credential-bearing files', () => {
  const capacity = JSON.stringify({ ...JSON.parse(file), capacityAdapter: { vision: { enabled: true } } });
  expect(() => preparePlanImport(capacity, current)).toThrow('Acknowledge');
  expect(preparePlanImport(capacity, current, { excludeCapacityAdapter: true }).excludedCapacityAdapter).toBe(true);
  for (const source of [
    { version: 9, combos: [] },
    { version: 2, combos: [{ name: 'Bad', models: ['openai/a'], credentials: 'private' }] },
    { version: 2, combos: [{ name: '__proto__', models: ['openai/a'] }] },
    { version: 2, combos: [{ name: 'Bad', models: ['https://provider/model'] }] },
    { version: 2, combos: [{ name: 'Bad', models: [], strategy: { fallbackStrategy: 'fallback' }, roundRobin: false }] },
    { version: 2, combos: [{ name: 'Same', models: [] }, { name: 'Same', models: [] }] },
  ]) expect(() => preparePlanImport(JSON.stringify(source), current)).toThrow();
});
let root, container, calls, failure, adopted;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  calls = []; failure = null; adopted = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (options.method === 'POST' && failure) return new Response(JSON.stringify({ code: failure.code, error: 'Synthetic write uncertainty' }), { status: failure.status });
    const draft = { id: 'exact-draft', revision: 1, version: { contentHash: 'b'.repeat(64), document: current } };
    return new Response(JSON.stringify(url.endsWith('/configuration') ? { currentHash: 'a'.repeat(64), document: current } : draft));
  }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
async function prepare() {
  await act(async () => root.render(<MantineProvider env="test"><PlanTransfer onImported={adopted} /></MantineProvider>));
  const field = container.querySelector('textarea');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, file); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Review plan import').click());
}
it('stores only a reviewed draft and reads its exact immutable revision before returning to the editor', async () => {
  await prepare(); await act(async () => button('Store imported draft').click());
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['GET /api/admin/configuration', 'POST /api/admin/configuration/drafts', 'GET /api/admin/configuration/drafts/exact-draft']);
  expect(calls[1].body.expectedCurrent).toBe('a'.repeat(64));
  expect(calls[1].body.document.combos[0].id).toBe('keep-id');
  expect(adopted).toHaveBeenCalledWith(expect.objectContaining({ id: 'exact-draft', revision: 1 }));
});
it('retains pasted input and blocks replay when a server write may already have committed', async () => {
  failure = { status: 500, code: 'configuration_failed' };
  await prepare(); await act(async () => button('Store imported draft').click());
  expect(container.querySelector('textarea').value).toBe(file);
  expect(button('Store imported draft').disabled).toBe(true);
  expect(button('Return to pasted file').disabled).toBe(true);
  expect(adopted).not.toHaveBeenCalled();
});
