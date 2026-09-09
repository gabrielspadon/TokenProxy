// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EvaluationSets } from '../../src/app/dashboard/shaping/EvaluationSets.js';
import { ShapingWorkbench } from '../../src/app/dashboard/shaping/Workbench.js';
import { Handoffs } from '../../src/app/dashboard/shaping/Handoffs.js';
import { HandoffEvidence } from '../../src/shared/components/context-workspace/ContextInspector.js';
import { call } from '../../src/shared/api.js';
vi.mock('../../src/shared/api.js', () => ({ call: vi.fn() }));
vi.mock('../../src/shared/components/Confirm', () => ({ Confirm: () => null }));
vi.mock('../../src/shared/components/Notice', () => ({ Notice: ({ title, children }) => <aside>{title}{children}</aside> }));
const builtin = [{ id: 'built-in', name: 'Built-in cases', revision: 1, count: 4, synthetic: true }];
let container, root;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); });
const button = label => [...container.querySelectorAll('button')].find(node => node.textContent === label);
async function change(input, value) {
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}

it('imports only explicitly acknowledged inputs and preserves selected versions outside the visible page', async () => {
  const saved = { id: 'saved-set', setId: 'family', name: 'My cases', revision: 1, count: 1, contentHash: 'a'.repeat(64) };
  call.mockImplementation(async (url, options = {}) => options.method === 'POST' ? { ok: true, status: 200, body: { version: saved, persistence: 'confirmed' } } :
    url.endsWith('/saved-set') ? { ok: true, body: saved } : { ok: true, body: { rows: [], pagination: { page: 1, pages: 2, total: 11 } } });
  function Harness() { const [selected, setSelected] = useState(''); return <EvaluationSets builtins={builtin} selected={selected} onSelect={setSelected} />; }
  await act(async () => root.render(<Harness />));
  await change(container.querySelector('[aria-label="Evaluation set name"]'), 'My cases');
  const upload = container.querySelector('input[type="file"]');
  const cases = [{ id: 'one', contextWindow: 100000, body: { messages: [{ role: 'user', content: 'Selected input' }] } }];
  await act(async () => { Object.defineProperty(upload, 'files', { configurable: true, value: [{ name: 'cases.json', size: 123, text: async () => JSON.stringify(cases) }] }); upload.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('Save evaluation set').disabled).toBe(true);
  expect(call.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  await act(async () => container.querySelector('input[type="checkbox"]').click());
  await act(async () => button('Save evaluation set').click());
  expect(call.mock.calls.find(([, options]) => options?.method === 'POST')[1].body).toEqual({ name: 'My cases', fixtures: cases, acknowledgeRetention: true });
  expect(container.querySelector('select').value).toBe(saved.id);
  await act(async () => button('Next sets').click());
  expect(container.querySelector('select').value).toBe(saved.id);
  expect(container.textContent).toContain('Selected 1 cases, version 1');
});

it('cancels the active comparison without offering promotion from incomplete evidence', async () => {
  const profile = { id: 1, name: 'Saved', revision: 1, settings: { rtkEnabled: false } };
  let observedSignal;
  call.mockImplementation(async (url, options = {}) => {
    if (options.method === 'POST') {
      observedSignal = options.signal;
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ ok: false, body: { code: 'cancelled' } }), { once: true }));
    }
    if (url === '/api/admin/shaping') return { ok: true, body: { settings: profile.settings, currentHash: 'x', fixtureSets: builtin, coverage: { takesEffect: 'New requests' } } };
    return { ok: true, body: { rows: url.includes('/profiles?') ? [profile] : [], pagination: { total: 1, pages: 1 } } };
  });
  await act(async () => root.render(<ShapingWorkbench />));
  await act(async () => button('Baseline').click()); await act(async () => button('Candidate').click());
  await change(container.querySelector('.shaping-set-picker select'), 'built-in');
  await act(async () => button('Run offline comparison').click());
  expect(observedSignal.aborted).toBe(false);
  await act(async () => button('Cancel comparison').click());
  expect(observedSignal.aborted).toBe(true); expect(container.textContent).toContain('Cancellation requested');
  expect(button('Review promotion')).toBeUndefined();
});

it('requires handoff review, preserves sessions across pages and reports uncertain persistence', async () => {
  const rows = [{ id: 'source-record', projectId: 'project', projectName: 'Project', contextSessionId: 'source' }, { id: 'target-record', projectId: 'project', projectName: 'Project', contextSessionId: 'target' }];
  call.mockImplementation(async (url, options = {}) => options.method === 'POST' ? { ok: true, status: 207, body: { packet: { effect: 'Subsequent requests only' }, recovery: 'Disk state is unconfirmed.' } } :
    { ok: true, body: { rows: url.includes('handoff-targets?page=1') ? rows : [], pagination: { pages: 2 } } });
  await act(async () => root.render(<Handoffs enabled={false} />));
  expect(container.textContent).toContain('Handoff injection is off');
  await change(container.querySelectorAll('select')[0], rows[0].id);
  await change(container.querySelectorAll('select')[1], rows[1].id);
  await change(container.querySelector('textarea'), 'Reviewed summary');
  expect(button('Approve handoff').disabled).toBe(true);
  await act(async () => button('Next sessions').click());
  expect([...container.querySelectorAll('select')].slice(0, 2).map(node => node.value)).toEqual(rows.map(row => row.id));
  await act(async () => container.querySelector('input[type="checkbox"]').click());
  await act(async () => button('Approve handoff').click());
  const sent = call.mock.calls.find(([, options]) => options?.method === 'POST')[1].body;
  expect(sent).toMatchObject({ sourceRequestId: rows[0].id, targetRequestId: rows[1].id, summary: 'Reviewed summary', acknowledgeContent: true });
  expect(container.textContent).toContain('Persistence unconfirmed');
  expect(button('Approve handoff').disabled).toBe(true);
});

it('links retained handoff source attempts without manufacturing absent session identities', async () => {
  const inspect = vi.fn(), row = { handoffId: 'packet', sourceRequestId: 'source', targetRequestId: 'target', sourceSessionId: 7, targetSessionId: null, executionRequestId: 'origin' };
  await act(async () => root.render(<HandoffEvidence rows={[row]} requestId="retry" onInspect={inspect} />));
  expect(container.textContent).toContain('Reused preparation');
  expect(button('Inspect target request').disabled).toBe(true);
  await act(async () => button('Inspect source request').click());
  expect(inspect).toHaveBeenCalledWith({ kind: 'context-attempt', id: 'source', sessionId: 7 });
});
