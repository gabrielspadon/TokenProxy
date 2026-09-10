// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The shared chrome keeps its controls on the working surface: update behavior
// and preferences in the rail, saved investigations, retained evidence, the
// evidence export and the custom range as sections under the scope strip.
const state = vi.hoisted(() => ({ workspace: null, router: null }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({
  useWorkspace: () => state.workspace,
  useOptionalWorkspace: () => state.workspace,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/usage',
  useRouter: () => state.router,
}));
const { ObservationControls } = await import('../../src/shared/workspace/ObservationControls');
const { ScopeBar } = await import('../../src/shared/workspace/ScopeBar');

const SCOPE = {
  period: 'all',
  start: null,
  end: null,
  provider: null,
  connectionId: null,
  model: null,
  projectId: null,
};
const ENTRY = {
  id: 'entry-1',
  name: 'Retained view',
  kind: 'investigation',
  version: 3,
  definition: { lens: 'economics' },
};
let container, root, calls, pendingDelete;

function workspace(patch = {}) {
  return {
    scope: SCOPE,
    setScope: vi.fn(),
    snapshot: null,
    accounts: [
      { connectionId: 'account-a', provider: 'codex', displayName: 'Synthetic research account' },
    ],
    models: { data: { models: [] } },
    refresh: vi.fn(),
    selectedRecord: {
      kind: 'account',
      id: 'account-a',
      provider: 'codex',
      connectionId: 'account-a',
    },
    setSelectedRecord: vi.fn(),
    comparisonIds: [],
    setComparisonIds: vi.fn(),
    savedEntry: null,
    setSavedEntry: vi.fn(),
    captureDefinition: vi.fn(() => ({ schemaVersion: 1, lens: 'economics' })),
    restoreInvestigation: vi.fn(),
    contextView: { baseline: null },
    observations: { mode: 'summary', historical: false, pausedAt: null, setMode: vi.fn() },
    ...patch,
  };
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function render(element) {
  await act(async () => root.render(<MantineProvider env="test">{element}</MantineProvider>));
  await settle();
}
const button = (name, scope = document) =>
  [...scope.querySelectorAll('button')].find(
    (item) => item.textContent === name || item.getAttribute('aria-label') === name
  );
const region = (name) => document.querySelector(`section[aria-label="${name}"]`);
async function click(node) {
  expect(node).toBeTruthy();
  await act(async () => node.click());
  await settle();
}
async function escape() {
  await act(async () =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
  );
  await settle(40);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  });
  state.router = { push: vi.fn() };
  calls = [];
  pendingDelete = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      calls.push({
        url,
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (options.method === 'DELETE')
        return new Promise((resolve) => {
          pendingDelete = () => resolve(json({ ok: true }));
        });
      if (url === '/api/admin/investigations') return json({ items: [ENTRY] });
      return json({});
    })
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('offers update behavior as one inline radiogroup whose Live choice returns a fixed range to current evidence', async () => {
  state.workspace = workspace({
    scope: {
      ...SCOPE,
      period: 'custom',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-02T00:00:00.000Z',
    },
    observations: { mode: 'summary', historical: true, pausedAt: null, setMode: vi.fn() },
  });
  await render(<ObservationControls />);
  const group = container.querySelector(
    '[data-observation-control] [role="radiogroup"][aria-label="Update behavior"]'
  );
  expect([...group.querySelectorAll('label')].map((label) => label.textContent)).toEqual([
    'Summary',
    'Live',
    'Paused',
  ]);
  expect(container.querySelector('[data-observation-control]').textContent).toContain('Historical');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(group.querySelector('input[value="live"]'));
  expect(state.workspace.setScope).toHaveBeenCalledWith({ period: 'all', start: null, end: null });
  expect(state.workspace.observations.setMode).toHaveBeenCalledWith('live');
  expect(state.workspace.refresh).toHaveBeenCalledTimes(1);
});

it('disables Live for a snapshot, applies Paused at once and states when reads paused', async () => {
  state.workspace = workspace({ snapshot: { kind: 'synthetic-fixture', isolated: true } });
  await render(<ObservationControls />);
  const group = container.querySelector('[role="radiogroup"][aria-label="Update behavior"]');
  expect(group.querySelector('input[value="live"]').disabled).toBe(true);
  expect(container.querySelector('[data-observation-control]').textContent).toContain('Snapshot');
  await click(group.querySelector('input[value="paused"]'));
  expect(state.workspace.observations.setMode).toHaveBeenCalledWith('paused');
  expect(state.workspace.refresh).not.toHaveBeenCalled();
  state.workspace = workspace({
    observations: {
      mode: 'paused',
      historical: false,
      pausedAt: '2026-09-10T12:34:56.000Z',
      setMode: vi.fn(),
    },
  });
  await render(<ObservationControls />);
  const time = container.querySelector('[data-observation-control] time');
  expect(time.getAttribute('datetime')).toBe('2026-09-10T12:34:56.000Z');
  expect(time.parentElement.textContent).toBe('Paused at 12:34:56 UTC');
});

it('opens saved investigations under the strip, confirms deletion inline and holds the section while it writes', async () => {
  state.workspace = workspace();
  await render(<ScopeBar />);
  const trigger = button('Saved investigations');
  await click(trigger);
  const saved = region('Saved investigations');
  expect(saved).toBeTruthy();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(saved.querySelector('input'));
  await click(button('Delete Retained view', saved));
  const confirm = saved.querySelector('[role="group"][aria-label="Delete “Retained view”?"]');
  expect(confirm.textContent).toContain(
    'The stored definition will be removed; evidence records are untouched.'
  );
  expect(button('Cancel deletion', confirm)).toBeTruthy();
  expect(saved.querySelector('form')).toBeNull();
  await click(button('Delete saved entry', confirm));
  expect(calls.at(-1)).toEqual({
    url: '/api/admin/investigations/entry-1',
    method: 'DELETE',
    body: { version: 3 },
  });
  await escape();
  expect(region('Saved investigations')).toBeTruthy();
  await act(async () => pendingDelete());
  await settle();
  expect(region('Saved investigations').textContent).toContain('Saved entry deleted.');
  region('Saved investigations').focus();
  await escape();
  expect(region('Saved investigations')).toBeNull();
  expect(document.activeElement).toBe(button('Saved investigations'));
});

it('shows retained evidence and the export as one section at a time, and clearing closes the details', async () => {
  state.workspace = workspace();
  await render(<ScopeBar />);
  await click(button('Selected evidence'));
  const details = region('Retained evidence details');
  expect(details.textContent).toContain('account · account-a');
  await click(button('Export evidence'));
  expect(region('Retained evidence details')).toBeNull();
  expect(button('Download JSON evidence', region('Export recorded evidence'))).toBeTruthy();
  await click(button('Selected evidence'));
  expect(region('Export recorded evidence')).toBeNull();
  await click(button('Clear selection', region('Retained evidence details')));
  expect(state.workspace.setSelectedRecord).toHaveBeenCalledWith(null);
  expect(region('Retained evidence details')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('edits a custom UTC range inline and keeps its validation', async () => {
  state.workspace = workspace({ scope: { ...SCOPE, period: 'custom' } });
  await render(<ScopeBar analysisActions={false} />);
  await click(button('Edit range'));
  const range = region('Analysis time range');
  expect(range.textContent).toContain(
    'Times use UTC. The start is inclusive and the end is exclusive.'
  );
  await click(button('Apply range', range));
  expect(range.querySelector('[role="alert"]').textContent).toBe('Choose a start before the end.');
  expect(state.workspace.setScope).not.toHaveBeenCalled();
  await click(button('Cancel', range));
  expect(region('Analysis time range')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
