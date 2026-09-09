// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
const state = vi.hoisted(() => ({ setScope: vi.fn() }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useOptionalWorkspace: () => state }));
import ProjectBudgets from '@/shared/components/workspace/ProjectBudgets';
let root, host;
const button = label => [...host.querySelectorAll('button')].find(node => node.textContent === label);
const field = label => host.querySelector(`#${[...host.querySelectorAll('label')].find(node => node.textContent === label)?.htmlFor}`);
async function input(label, value) { await act(async () => { const node = field(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function select(label, value) { await act(async () => { const node = field(label); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }); }
const mount = props => act(async () => root.render(<MantineProvider env="test"><ProjectBudgets {...props}/></MantineProvider>));
const fixture = { project: { id: 'project', name: 'Research', revision: 1, maxPromptTokens: null, maxCompletionTokens: 100, maxCostUsd: null, budgetPolicy: 'strict', budgetMode: 'enforce', alertPercent: null, alertCooldownSeconds: 3600, archived: false, bindingEffect: 'Missing client identity is refused.' }, bindings: [], reservations: [], account: {}, outstanding: { requests: 0 }, durableStorage: true, asOf: '2026-09-08T12:00:00Z', forecast: { available: false, completeHours: 0, records: 0, knownCostRecords: 0, timeRange: { start: null, end: '2026-09-08T12:00:00Z' } } };
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.stubGlobal('ResizeObserver', class { observe(){} unobserve(){} disconnect(){} }); window.matchMedia = vi.fn(() => ({ matches: false, addEventListener(){}, removeEventListener(){} })); host = document.createElement('div'); document.body.append(host); root = createRoot(host); state.setScope.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('keeps creation disabled until initial state loads', async () => {
  let resolve; const waiting = new Promise(done => { resolve = done; });
  vi.stubGlobal('fetch', async () => { await waiting; return Response.json({ items: [], keys: [] }); });
  await mount(); expect(field('Project name').disabled).toBe(true); expect(button('Review project policy').disabled).toBe(true);
  await act(async () => resolve()); expect(field('Project name').disabled).toBe(false);
});
it('keeps an acknowledged create identity when readback fails and requires a fresh read before retry', async () => {
  let created = false, failRead = true;
  const fetcher = vi.fn(async (url, options) => {
    if (url === '/api/keys') return Response.json({ keys: [] });
    if (options?.method === 'POST') { created = true; return Response.json(fixture); }
    if (url.includes('/project?')) { if (failRead) return Response.json({ error: 'Read unavailable' }, { status: 503 }); return Response.json(fixture); }
    return Response.json({ items: created ? [fixture.project] : [] });
  });
  vi.stubGlobal('fetch', fetcher); await mount(); await input('Project name', 'Research');
  await act(async () => button('Review project policy').click()); await act(async () => button('Confirm project change').click());
  expect(host.textContent).toContain('Change acknowledged, but persistence readback was not verified'); expect(field('Project').value).toBe('project'); expect(button('Confirm project change')).toBeUndefined(); expect(button('Review project policy').disabled).toBe(true);
  failRead = false; await act(async () => button('Read current project').click());
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  expect(field('Output token ceiling').value).toBe('100');
  expect(button('Review project policy').disabled).toBe(false);
});
it('shows exact binding evidence, preserves identity after stale refusal, and passes exact scope to navigation', async () => {
  const clientRef = `ctx1_${'a'.repeat(64)}`, projectRef = `ctx1_${'b'.repeat(64)}`;
  const onAnalyze = vi.fn();
  vi.stubGlobal('fetch', async (url, options) => url === '/api/keys' ? Response.json({ keys: [{ id: 'key', name: 'Client' }] }) : options?.method === 'POST' ? Response.json({ error: 'This project changed' }, { status: 409 }) : url.includes('/candidates?') ? Response.json({ items: [{ apiKeyId: 'key', clientRef, projectRef }] }) : url.includes('/project?') ? Response.json(fixture) : Response.json({ items: [fixture.project] }));
  await mount({ onAnalyze }); await select('Project', 'project'); await select('Binding client key', 'key'); await select('Observed client project', `${clientRef}/${projectRef}`);
  await act(async () => button('Review binding').click());
  const review = host.querySelector('[aria-label="Review project change"]'); expect(review.textContent).toContain(clientRef); expect(review.textContent).toContain(projectRef); expect(document.activeElement).toBe(review);
  await act(async () => button('Confirm project change').click()); expect(host.textContent).toContain('This project changed'); expect(field('Observed client project').value).toBe(`${clientRef}/${projectRef}`);
  await act(async () => button('View contributing records').click()); expect(state.setScope).toHaveBeenCalledWith({ projectId: 'project' }); expect(onAnalyze).toHaveBeenCalledWith('project');
});
it('identifies the exact client on unbinding without broadening its mutation payload', async () => {
  const identity = { id: 'binding', apiKeyId: 'key', clientRef: `ctx1_${'a'.repeat(64)}`, projectRef: `ctx1_${'b'.repeat(64)}` };
  let current = { ...fixture, bindings: [identity] };
  const fetcher = vi.fn(async (url, options) => {
    if (url === '/api/keys') return Response.json({ keys: [{ id: 'key', name: 'Client' }] });
    if (options?.method === 'DELETE') { current = { ...fixture, project: { ...fixture.project, revision: 2 } }; return Response.json(current); }
    return Response.json(url.includes('/project?') ? current : { items: [fixture.project] });
  });
  vi.stubGlobal('fetch', fetcher); await mount(); await select('Project', 'project');
  await act(async () => button('Remove binding').click());
  const review = host.querySelector('[aria-label="Review project change"]');
  expect(review.textContent).toContain(identity.apiKeyId); expect(review.textContent).toContain(identity.clientRef); expect(review.textContent).toContain(identity.projectRef);
  await act(async () => button('Confirm project change').click());
  const [url, options] = fetcher.mock.calls.find(([, options]) => options?.method === 'DELETE');
  expect(url).toBe('/api/admin/projects/project/bindings/binding'); expect(JSON.parse(options.body)).toEqual({ expectedRevision: 1 });
  expect(host.textContent).toContain('Saved and read back Research, revision 2'); expect(button('Remove binding')).toBeUndefined();
});
