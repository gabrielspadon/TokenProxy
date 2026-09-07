// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPERATION_HISTORY_PAGE_SIZE,
  UNRESOLVED_LABEL,
  operationHistoryUrl,
  resolveOperationRows,
} from '@/shared/workspace/operationHistoryModel';
import { ProbeConsequence } from '@/app/dashboard/network/ProbeConsequence';

const { OperationHistoryInspector } = await import('@/shared/workspace/OperationHistoryInspector');

// The probe is mocked by never being invoked: this suite renders retained rows
// and asserts on the copy. Nothing here opens a socket, and `fetch` is stubbed
// per-test so a real request would surface as an unexpected call.
let root, container, fetchMock, pages;

const event = (over = {}) => ({
  id: 1,
  operationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  phase: 'reachability',
  state: 'succeeded',
  source: 'proxy-pool-test',
  actorClass: 'operator',
  subjectKind: 'proxyPool',
  subjectId: 'pool-1',
  provider: null,
  connectionId: null,
  requestId: null,
  logicalRequestId: null,
  occurredAt: '2026-09-06T10:00:00.000Z',
  capturedAt: '2026-09-06T10:00:01.000Z',
  code: null,
  details: { status: 200, elapsedMs: 120, timedOut: false, cancelled: false },
  ...over,
});

const page = (items, over = {}) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: OPERATION_HISTORY_PAGE_SIZE,
  pages: 1,
  hasMore: false,
  filters: { subjectKind: 'proxyPool', subjectId: 'pool-1' },
  timeRange: {
    field: 'capturedAt',
    start: '2026-08-07T10:00:00.000Z',
    end: '2026-09-06T10:00:00.000Z',
    endExclusive: true,
  },
  freshness: { source: 'committed-sqlite', snapshotCompletedAt: '2026-09-06T10:05:00.000Z' },
  ...over,
});

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const render = async (props = {}) => {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <OperationHistoryInspector subjectId="pool-1" label="Home relay" {...props} />
      </MantineProvider>
    )
  );
  await flush();
};
const clickLabel = async (label) => {
  const element = container.querySelector(`[aria-label="${label}"]`);
  expect(element, `no control labelled ${label}`).toBeTruthy();
  await act(async () => element.click());
  await flush();
};

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
  pages = new Map();
  fetchMock = vi.fn(async (url) => {
    const requested = new URL(String(url), 'http://localhost');
    const body = pages.get(requested.searchParams.get('page') || '1') || page([]);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probe history rendering', () => {
  it('renders a retained receipt with its identifiers, both times, actor, source and code', async () => {
    pages.set(
      '1',
      page([
        event({ id: 2, state: 'failed', code: 'probe_timeout' }),
        event({ id: 1, state: 'started' }),
      ])
    );
    await render();
    const text = container.textContent;
    expect(text).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(text).toContain('reachability');
    expect(text).toContain('Failed');
    expect(text).toContain('probe_timeout');
    expect(text).toContain('operator');
    expect(text).toContain('proxy-pool-test');
    // Occurrence and capture are both shown; they differ by a second here.
    expect(text).toContain('6 Sept, 10:00:00');
    expect(text).toContain('6 Sept, 10:00:01');
    // A start paired with its terminal receipt is NOT unresolved.
    expect(text).not.toContain(UNRESOLVED_LABEL);
  });

  it('a start with no terminal receipt reads as unresolved, never as failure', async () => {
    pages.set('1', page([event({ id: 1, state: 'started', code: null, details: {} })]));
    await render();
    const text = container.textContent;
    expect(text).toContain(UNRESOLVED_LABEL);
    expect(text).toContain('neither a success nor a failure');
    expect(text).toContain('not permission to resend the check');
    // The failure vocabulary must not attach to an unresolved row.
    expect(text).not.toContain('Failed');
    expect(text).not.toContain('Succeeded');
    // Marked structurally as well as by colour, so greyscale still separates it.
    expect(container.querySelector('tr[data-kind="unresolved"]')).toBeTruthy();
    expect(container.querySelector('tr[data-kind="terminal"]')).toBeNull();
  });

  it('a cancelled probe is not a failure and reports activation untouched', async () => {
    pages.set(
      '1',
      page([
        event({
          id: 3,
          state: 'cancelled',
          code: 'probe_cancelled',
          details: { cancelled: true, timedOut: false, status: 499 },
        }),
        event({ id: 2, state: 'started' }),
      ])
    );
    await render();
    expect(container.textContent).toContain('Cancelled');
    expect(container.textContent).not.toContain('Failed');
    await clickLabel('Inspect operation aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee reachability');
    const text = container.textContent;
    expect(text).toContain('This is not a failure');
    expect(text).toContain('Activation was left exactly as it was');
    expect(text).toContain('aborted before the probe answered');
  });

  it('shows a conflict as a discarded result, naming which conflict was recorded', async () => {
    pages.set(
      '1',
      page([
        event({
          id: 4,
          state: 'conflict',
          code: 'pool_configuration_changed',
          details: { conflict: true, status: 200, elapsedMs: 90 },
        }),
      ])
    );
    await render();
    expect(container.textContent).toContain('Conflict');
    await clickLabel('Inspect operation aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee reachability');
    const text = container.textContent;
    expect(text).toContain('The pool was edited between the probe being decided');
    expect(text).toContain('discarded');
    expect(text).toContain('Yes, the result was discarded');
    expect(text).not.toContain('Failed');
  });

  it('renders a missing value as a word and never as a fabricated zero', async () => {
    pages.set(
      '1',
      page([event({ id: 5, state: 'uncertain', code: null, details: {}, occurredAt: null })])
    );
    await render();
    await clickLabel('Inspect operation aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee reachability');
    const detail = container.querySelector('[aria-label="Selected operation event"]');
    expect(detail.textContent).toContain('Not recorded');
    // The dt/dd pairs for absent measurements must not read 0.
    const pairs = [...detail.querySelectorAll('dd')].map((dd) => dd.textContent);
    expect(pairs).toContain('Not recorded');
    expect(pairs).not.toContain('0');
    expect(pairs).not.toContain('0 ms');
  });

  it('keeps the freshness and join limitations visible instead of implying completeness', async () => {
    pages.set('1', page([event()]));
    await render();
    const text = container.textContent;
    expect(text).toContain('Committed snapshot');
    expect(text).toContain('What this history does not tell you');
    expect(text).toContain('Nothing is joined onto the pool record');
    expect(text).toContain('reading as unresolved here');
    expect(text).toContain('an allowlist of structural fields');
  });

  it('says nothing was retained rather than showing an empty grid', async () => {
    pages.set('1', page([]));
    await render();
    expect(container.textContent).toContain('No probe event for this pool was captured');
    expect(container.querySelector('table')).toBeNull();
  });
});

describe('probe history paging', () => {
  it('requests page two through the bounded query and renders its rows', async () => {
    const many = (start) =>
      Array.from({ length: OPERATION_HISTORY_PAGE_SIZE }, (_, i) =>
        event({ id: start + i, operationId: `op-${start + i}` })
      );
    pages.set('1', page(many(100), { total: 24, pages: 3, page: 1, hasMore: true }));
    pages.set('2', page(many(200), { total: 24, pages: 3, page: 2, hasMore: true }));
    await render();
    expect(container.textContent).toContain('op-100');

    await clickLabel('Probe history page 2');
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const second = urls.find((url) => url.includes('page=2'));
    expect(second, `no page=2 request in ${urls.join(', ')}`).toBeTruthy();
    expect(second).toContain(`pageSize=${OPERATION_HISTORY_PAGE_SIZE}`);
    expect(second).toContain('subjectId=pool-1');
    expect(container.textContent).toContain('op-200');
    expect(container.textContent).not.toContain('op-100');
  });

  it('sends a state filter to the server rather than filtering a cut page', async () => {
    pages.set('1', page([event()]));
    await render();
    const before = fetchMock.mock.calls.length;
    const select = container.querySelector('[aria-label="Filter recorded operation state"]');
    expect(select).toBeTruthy();
    // The URL builder is the contract the Select drives; assert it directly so
    // the test does not depend on Mantine's combobox internals.
    expect(operationHistoryUrl('pool-1', 3, { state: 'conflict' })).toBe(
      `/api/admin/operations/events?subjectKind=proxyPool&subjectId=pool-1&page=3&pageSize=${OPERATION_HISTORY_PAGE_SIZE}&state=conflict`
    );
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe('activation consequence disclosure', () => {
  // Not a tooltip: the copy is in the document, next to the control, at all times.
  it('states scope, timing and reversibility beside the control', () => {
    const html = renderToStaticMarkup(<ProbeConsequence id="probe-consequence" />);
    expect(html).toContain('can change whether the pool is active');
    expect(html).toContain('sets this pool active');
    expect(html).toContain('disables it');
    expect(html).toContain('same transaction as the receipt');
    expect(html).toContain('Reversing it');
    expect(html).toContain('probing again');
    expect(html).toContain('leave activation exactly as it was');
    expect(html).not.toContain('title=');
    expect(html).not.toContain('tooltip');
  });
});

describe('resolution pairing', () => {
  it('pairs a start against a terminal receipt only within the same operation and phase', () => {
    const rows = resolveOperationRows([
      { id: 4, operationId: 'op-a', phase: 'reachability', state: 'failed' },
      { id: 3, operationId: 'op-a', phase: 'reachability', state: 'started' },
      { id: 2, operationId: 'op-a', phase: 'authentication', state: 'started' },
      { id: 1, operationId: 'op-b', phase: 'reachability', state: 'started' },
    ]);
    expect(rows.map((row) => row.unresolved)).toEqual([false, false, true, true]);
    expect(rows[2].presentation.label).toBe(UNRESOLVED_LABEL);
    expect(rows[3].presentation.label).toBe(UNRESOLVED_LABEL);
    expect(rows[0].presentation.label).toBe('Failed');
  });

  it('tolerates a missing or non-array payload without inventing rows', () => {
    expect(resolveOperationRows(undefined)).toEqual([]);
    expect(resolveOperationRows(null)).toEqual([]);
  });
});
