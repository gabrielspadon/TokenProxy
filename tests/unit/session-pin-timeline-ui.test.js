// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: [], pages: {}, list: null, receipt: null }));
vi.mock('@/shared/api', () => ({
  call: async (url, options = {}) => {
    state.calls.push({ url, ...options });
    if (url.includes('/timeline'))
      return state.pages[url]
        ? { ok: true, body: state.pages[url] }
        : { ok: false, body: { code: 'state_unavailable' } };
    if (url.includes('/actions/')) return { ok: true, body: state.receipt };
    return { ok: true, body: state.list };
  },
}));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useOptionalWorkspace: () => null }));

const { default: SessionPins } = await import('@/shared/components/SessionPins.js');
const { timelineUrl, timelineSummary, timelineIdentifiers, timelineUnavailable } =
  await import('@/shared/workspace/pinTimelineModel.js');

const pinId = 'opaque-pin';
const pin = {
  id: pinId,
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
  targets: [],
};
const sources = {
  request: { available: true, join: 'stored-routing-hash', identitySource: 'explicit' },
  switch: { available: true, join: 'stored-routing-hash-and-model', identitySource: null },
  action: { available: true, join: 'stored-routing-hash-and-model', identitySource: null },
};
const timeBasis = {
  request: 'requestStats.timestamp',
  switch: 'accountSwitches.switchedAt',
  action: 'sessionPinActions.createdAt',
};
const boundaries = { ordering: 'recorded time, then kind, then id, all descending' };
const page = (items, extra = {}) => ({
  version: 1,
  model: pin.model,
  items,
  total: items.length,
  pageSize: 25,
  next: null,
  filters: {},
  timeRange: { start: '1970-01-01T00:00:00.000Z', end: '2026-09-06T02:00:00.000Z' },
  timeBasis,
  sources,
  boundaries,
  complete: true,
  ...extra,
});
const first = timelineUrl({ pinId, pageSize: 25 });
const items = [
  {
    kind: 'action',
    id: 'act-1',
    at: '2026-09-06T01:00:00.000Z',
    model: pin.model,
    timeBasis: 'createdAt',
    actionId: 'act-1',
    action: 'clear',
    status: 'applied',
    reason: 'operator-applied',
    connectionId: null,
    targetConnectionId: null,
    appliedAt: '2026-09-06T01:00:01.000Z',
  },
  {
    kind: 'switch',
    id: 'sw-1',
    at: '2026-09-06T00:30:00.000Z',
    model: pin.model,
    timeBasis: 'switchedAt',
    switchId: 'sw-1',
    connectionId: 'account-b',
    fromConnectionId: 'account-a',
    toConnectionId: 'account-b',
    trigger: 'exhaustion',
    reason: null,
  },
  {
    kind: 'request',
    id: 'req-1',
    at: '2026-09-06T00:10:00.000Z',
    model: pin.model,
    timeBasis: 'timestamp',
    requestId: 'req-1',
    logicalRequestId: null,
    connectionId: 'account-a',
    requestedModel: null,
    selectedModel: pin.model,
    servedModel: null,
    status: 'error',
    dispatchCoverage: null,
  },
];

let container, root;
const button = (text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
const click = (text) => act(async () => button(text).click());
const list = () => container.querySelector('[aria-label="Full pin timeline"]');

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
    value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  });
  state.calls = [];
  state.receipt = { id: 'act-1', status: 'applied', reason: 'operator-applied' };
  state.list = {
    version: 1,
    pins: [pin],
    next: null,
    observedAt: pin.lastSeenAt,
    boundaries: { historyLimitPerPin: 8 },
  };
  state.pages = { [first]: page(items) };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <SessionPins />
      </MantineProvider>
    )
  );
  await act(async () => container.querySelector('button[aria-label^="Inspect pin"]').click());
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('keeps the bounded recent view as the default and reads no timeline until expanded', () => {
  expect(container.textContent).toContain('Recent history');
  expect(list()).toBeNull();
  expect(state.calls.some((c) => c.url.includes('/timeline'))).toBe(false);
  const toggle = button('Full timeline');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBe('pin-full-timeline');
});

it('expands into a paged timeline and collapses back without losing the pin selection', async () => {
  await click('Full timeline');
  expect(state.calls.at(-1).url).toBe(first);
  expect(button('Full timeline')).toBeUndefined();
  expect(button('Hide full timeline').getAttribute('aria-expanded')).toBe('true');
  expect(list().querySelectorAll('li')).toHaveLength(3);
  await click('Hide full timeline');
  expect(list()).toBeNull();
  // The comparison table and its selected row are untouched by the expansion.
  expect(container.querySelector('tr[data-selected]').textContent).toContain('claude-fable-5');
  const dialog = container.querySelector('[role="dialog"]');
  const heading = document.getElementById(dialog.getAttribute('aria-labelledby'));
  expect(heading.textContent).toContain('account-a');
  expect(heading.textContent).toContain('claude-fable-5');
  expect(container.querySelector('[aria-label="Selection details"]')).not.toBeNull();
});

it('renders merge order, exact identifiers and every unknown as a word', async () => {
  await click('Full timeline');
  const rows = [...list().querySelectorAll('li')];
  expect(rows.map((row) => row.dataset.kind)).toEqual(['action', 'switch', 'request']);
  expect(rows[0].textContent).toContain('Control receipt');
  expect(rows[0].querySelector('code').textContent).toBe('act-1');
  expect(rows[1].textContent).toContain('account-a → account-b');
  // A switch with no recorded reason says so instead of rendering blank.
  expect(rows[1].textContent).toContain('No reason recorded');
  // A failed request never claims a served model.
  expect(rows[2].textContent).toContain('Requested Unknown');
  expect(rows[2].textContent).toContain('served Not confirmed');
  expect(rows[2].textContent).not.toContain('null');
  expect(rows[2].textContent).not.toContain('undefined');
  expect(container.textContent).toContain('requestStats.timestamp');
});

it('pages beyond page one and restarts paging when a filter changes', async () => {
  const second = timelineUrl({ pinId, pageSize: 25, cursor: 'cursor-2' });
  state.pages = {
    [first]: page(items, { next: 'cursor-2', total: 4 }),
    [second]: page([{ ...items[2], id: 'req-0', requestId: 'req-0' }], { total: 4 }),
  };
  await click('Full timeline');
  expect(button('Previous entries')).toBeUndefined();
  await click('More entries');
  expect(state.calls.at(-1).url).toBe(second);
  expect(list().querySelectorAll('li')).toHaveLength(1);
  await click('Previous entries');
  expect(state.calls.at(-1).url).toBe(first);
  // A filter change drops the cursor: it is only valid inside the set it cut.
  await click('More entries');
  const filtered = timelineUrl({ pinId, kind: 'switch', pageSize: 25 });
  state.pages[filtered] = page([items[1]], { total: 1, filters: { kind: 'switch' } });
  const select = container.querySelector('#pin-full-timeline select');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(
      select,
      'switch'
    );
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(state.calls.at(-1).url).toBe(filtered);
  expect(new URL(state.calls.at(-1).url, 'http://t.local').searchParams.has('cursor')).toBe(false);
});

it('names an unavailable source and surfaces a read failure instead of an empty list', async () => {
  state.pages = {
    [first]: page([items[0]], {
      sources: {
        ...sources,
        request: {
          available: false,
          join: 'stored-routing-hash',
          identitySource: null,
          reason: 'no-retained-session-join',
        },
      },
    }),
  };
  await click('Full timeline');
  expect(container.textContent).toContain('No exact retained session join');
  await click('Hide full timeline');
  state.pages = {};
  await click('Full timeline');
  expect(container.querySelector('[role="alert"]').textContent).toContain('state unavailable');
});

it('opens a receipt from a timeline entry without leaving the timeline', async () => {
  await click('Full timeline');
  await click('Open receipt');
  expect(state.calls.at(-1).url).toContain('/actions/act-1');
  expect(list()).not.toBeNull();
  expect(container.textContent).toContain('operator-applied');
});

it('builds request URLs and unknown wording as pure functions', () => {
  expect(timelineUrl({ pinId })).toBe('/api/admin/session-pins/timeline?pinId=opaque-pin');
  expect(
    Object.fromEntries(
      new URL(
        timelineUrl({
          pinId,
          kind: 'switch',
          connectionId: 'account-b',
          cursor: 'c',
          pageSize: 10,
        }),
        'http://t.local'
      ).searchParams
    )
  ).toEqual({
    pinId,
    kind: 'switch',
    connectionId: 'account-b',
    pageSize: '10',
    cursor: 'c',
  });
  expect(timelineSummary({ kind: 'switch' })).toBe(
    'First binding → Unknown account · Unknown trigger · No reason recorded'
  );
  expect(timelineSummary({ kind: 'action' })).toBe(
    'Unknown change · Unknown state · No reason recorded · Not applied'
  );
  // A null identifier is omitted, never rendered as an unknown identifier.
  expect(timelineIdentifiers(items[2]).map((i) => i.label)).toEqual([
    'Request',
    'Account',
    'Model',
  ]);
  expect(timelineUnavailable({ sources })).toEqual([]);
});
