// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  calls: [],
  preview: null,
  applied: null,
  pages: {},
  scope: null,
}));
vi.mock('@/shared/api', () => ({
  call: async (url, options = {}) => {
    state.calls.push({ url, ...options });
    if (url.endsWith('/preview')) return state.preview;
    if (url.endsWith('/apply')) return state.applied;
    if (url.includes('/actions/')) return state.applied;
    return { ok: true, body: state.pages[url] || state.pages.root };
  },
}));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({
  useOptionalWorkspace: () => (state.scope ? { scope: state.scope } : null),
}));
const {
  default: SessionPins,
  pinsUrl,
  receiptState,
} = await import('@/shared/components/SessionPins.js');
let container, root;
const pin = {
  id: 'opaque-pin',
  revision: 'r'.repeat(64),
  model: 'claude-fable-5',
  connectionId: 'account-a',
  state: 'active',
  provider: 'claude',
  expiresAt: '2026-09-07T00:00:00.000Z',
  pinnedAt: '2026-09-06T00:00:00.000Z',
  lastSeenAt: '2026-09-06T01:00:00.000Z',
  session: null,
  requests: [],
  switches: [],
  actions: [],
  targets: [{ id: 'account-b', name: 'Account B', enabled: true }],
};
const preview = {
  id: 'action-id',
  status: 'preview',
  expectedRevision: pin.revision,
  model: pin.model,
  previewExpiresAt: pin.expiresAt,
  preview: {
    consequence: 'Future selection may choose the same account.',
    conflicts: [],
    unknownEvidence: ['provider-acceptance'],
  },
};
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <SessionPins />
      </MantineProvider>
    )
  );
}
beforeEach(async () => {
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
    value: vi.fn(query => ({ matches: query.includes('min-width: 90em'), addEventListener() {}, removeEventListener() {} })),
  });
  state.calls = [];
  state.scope = null;
  state.preview = { ok: true, body: preview };
  state.applied = {
    ok: true,
    body: { ...preview, status: 'queued', reason: 'awaiting-subsequent-selection' },
  };
  state.pages = {
    root: {
      version: 1,
      pins: [pin],
      next: null,
      observedAt: pin.lastSeenAt,
      boundaries: { historyLimitPerPin: 8 },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
const click = (text) => act(async () => button(text).click());
async function select() {
  await act(async () => container.querySelector('button[aria-label^="Inspect pin"]').click());
}
async function submit() {
  await act(async () =>
    container
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
}

it('requires preview then explicit apply, retains receipt and refreshes the pin list', async () => {
  await select();
  expect(button('Apply this change')).toBeUndefined();
  await submit();
  expect(state.calls.at(-1)).toMatchObject({
    url: '/api/admin/session-pins/preview',
    body: { action: 'clear', expectedRevision: pin.revision, pinId: pin.id },
  });
  expect(state.calls.some((c) => c.url.endsWith('/apply'))).toBe(false);
  expect(container.textContent).toContain('Future selection may choose the same account.');
  await click('Apply this change');
  expect(state.calls.at(-2)).toMatchObject({
    url: '/api/admin/session-pins/apply',
    body: { id: preview.id, expectedRevision: pin.revision },
  });
  expect(state.calls.at(-1).url).toBe('/api/admin/session-pins');
  expect(container.textContent).toContain('Waiting for a subsequent request');
  expect(button('Apply this change')).toBeUndefined();
  await click('Refresh receipt');
  expect(state.calls.at(-1).url).toContain('/actions/action-id');
});

it('selection survives a refresh and live reorder without moving off the selected pin', async () => {
  await select();
  expect(container.querySelector('tr[data-selected]').textContent).toContain('claude-fable-5');
  // A live update prepends another pin; the selected row must stay selected.
  const other = { ...pin, id: 'other-pin', model: 'other-model', connectionId: 'account-b' };
  state.pages.root = { ...state.pages.root, pins: [other, pin] };
  await click('Refresh pins');
  const selectedRow = container.querySelector('tr[data-selected]');
  expect(selectedRow.textContent).toContain('claude-fable-5');
  expect(container.querySelector('[aria-label="Selection details"]').textContent).toContain(
    'account-a'
  );
});

it('places keyboard focus on the actual native horizontal inventory scroller', async () => {
  await render();
  const scroller = container.querySelector('[aria-label="Session pins table, scroll horizontally for all columns"]');
  expect(scroller.tagName).toBe('DIV');
  expect(scroller.tabIndex).toBe(0);
  expect(scroller.style.getPropertyValue('--table-overflow')).toBe('auto');
  expect(scroller.style.getPropertyValue('--table-min-width')).toContain('48.75rem');
  scroller.focus();
  expect(document.activeElement).toBe(scroller);
  expect(scroller.querySelector('table')).not.toBeNull();
});

it('a selected pin missing from the refreshed page keeps its selection and says so', async () => {
  await select();
  state.pages.root = { ...state.pages.root, pins: [] };
  await click('Refresh pins');
  expect(container.textContent).toContain('The selected pin is not in the current page or scope');
});

it('keeps an applied clear receipt visible after the pin is absent',async()=>{
  await select(); await submit();
  state.applied={ok:true,status:200,body:{...preview,action:'clear',status:'applied',reason:'operator-applied'}};
  state.pages.root={...state.pages.root,pins:[]};
  await click('Apply this change');
  expect(container.querySelector('[aria-label="Retained pin control receipt"]').textContent).toContain('Affinity was cleared');
  expect(container.textContent).toContain('action-id');
  expect(button('Refresh receipt')).toBeTruthy();
});

it('retains the exact uncertain action id and reads its receipt without replaying apply',async()=>{
  await select(); await submit();
  state.applied={ok:false,status:0,body:{code:'network'}};
  await click('Apply this change');
  expect(container.textContent).toContain('Application status unknown');
  expect(container.textContent).toContain('action-id');
  expect(button('Preview change').disabled).toBe(true);
  state.applied={ok:true,status:200,body:{...preview,status:'queued',reason:'awaiting-subsequent-selection'}};
  await click('Refresh receipt');
  expect(state.calls.filter(call=>call.url.endsWith('/apply'))).toHaveLength(1);
  expect(state.calls.some(call=>call.url.endsWith('/actions/action-id'))).toBe(true);
  expect(container.textContent).not.toContain('Application status unknown');
});

it('wires shared workspace scope into the backend list filters', () => {
  expect(pinsUrl(null)).toBe('/api/admin/session-pins');
  const url = new URL(
    pinsUrl(
      {
        provider: 'claude',
        connectionId: 'account-a',
        model: 'claude-fable-5',
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-06T00:00:00.000Z',
      },
      'cursor-1'
    ),
    'http://test.local'
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    provider: 'claude',
    connectionId: 'account-a',
    model: 'claude-fable-5',
    lastSeenFrom: '2026-09-01T00:00:00.000Z',
    lastSeenTo: '2026-09-06T00:00:00.000Z',
    before: 'cursor-1',
  });
});

it('requests the scoped list when the workspace carries filters', async () => {
  act(() => root.unmount());
  container.remove();
  state.scope = { provider: 'claude', connectionId: null, model: null, start: null, end: null };
  state.pages['/api/admin/session-pins?provider=claude'] = state.pages.root;
  state.calls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
  expect(state.calls[0].url).toBe('/api/admin/session-pins?provider=claude');
  expect(container.textContent).toContain('The shared scope filters this list');
});

it('renders every receipt status as its own distinct state', () => {
  expect(receiptState({ status: 'preview' })).toBe('Saved preview');
  expect(receiptState({ status: 'queued' })).toBe('Queued');
  expect(receiptState({ status: 'applied' })).toBe('Applied');
  expect(receiptState({ status: 'cancelled' })).toBe('Cancelled');
  expect(receiptState({ status: 'conflict', reason: 'preview_expired' })).toBe('Stale preview');
  expect(receiptState({ status: 'conflict', reason: 'pin_changed' })).toBe('Conflicting state');
  expect(receiptState({ status: 'later-vocabulary' })).toBe('Uncertain');
  expect(receiptState(null)).toBe('Uncertain');
});

it('labels the recent history as bounded, never as complete pagination', async () => {
  state.pages.root.pins = [
    {
      ...pin,
      requests: [
        { id: 'req-1', requestedModel: 'claude-fable-5', servedModel: null, status: 'error' },
      ],
      actions: [
        { id: 'a'.repeat(36), action: 'clear', status: 'applied', reason: 'operator-applied' },
      ],
    },
  ];
  await click('Refresh pins');
  await select();
  expect(container.textContent).toContain(
    'Most recent 8 requests, account switches and control receipts'
  );
  expect(container.textContent).toContain(
    'Older history is retained by the gateway but not shown here'
  );
  expect(container.textContent).toContain('Not confirmed');
  expect(container.textContent).toContain('Applied');
});

it('edits invalidate a preview and cannot submit a different target under an old receipt', async () => {
  await select();
  await submit();
  const actionField = container.querySelector('form select');
  await act(async () => {
    actionField.value = 'reassign';
    actionField.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('Apply this change')).toBeUndefined();
  const target = container.querySelectorAll('form select')[1];
  await act(async () => {
    target.value = 'account-b';
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await submit();
  expect(state.calls.at(-1).body).toMatchObject({
    action: 'reassign',
    targetConnectionId: 'account-b',
  });
});

it('shows stale-state refusal, removes apply and requires a new preview', async () => {
  await select();
  await submit();
  state.applied = {
    ok: false,
    status: 409,
    body: { ...preview, status: 'conflict', reason: 'pin_changed' },
  };
  await click('Apply this change');
  expect(container.querySelector('[role="alert"]').textContent).toContain('pin changed');
  expect(container.textContent).toContain('Conflicting state');
  expect(button('Apply this change')).toBeUndefined();
});

it('a failed preview never enables mutation or substitutes guessed request evidence', async () => {
  state.preview = { ok: false, status: 403, body: { code: 'forbidden_class' } };
  await select();
  await submit();
  expect(container.textContent).toContain('No exact retained requests');
  expect(container.querySelector('[role="alert"]').textContent).toContain('forbidden class');
  expect(button('Apply this change')).toBeUndefined();
});

it('pagination returns to the exact previous cursor', async () => {
  state.pages.root.next = 'page-two';
  state.pages['/api/admin/session-pins?before=page-two'] = {
    ...state.pages.root,
    next: 'page-three',
  };
  state.pages['/api/admin/session-pins?before=page-three'] = { ...state.pages.root, next: null };
  await click('Refresh pins');
  await click('More pins');
  await click('More pins');
  await click('Previous pins');
  expect(state.calls.at(-1).url).toBe('/api/admin/session-pins?before=page-two');
});
