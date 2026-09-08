// @vitest-environment jsdom
// Compatibility workbench page: mount, run lifecycle rendering, cancellation
// control, and honest failure states (missing edge, result_unretainable,
// timed-out deadline, unknown-not-guessed fields). API is mocked at the
// @/shared/api seam like session-pins-ui.test.js.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: [], routes: {} }));
vi.mock('@/shared/api', () => ({
  call: async (url, options = {}) => {
    state.calls.push({ url, ...options });
    const handler = state.routes[`${options.method || 'GET'} ${url.split('?')[0]}`];
    return handler ? handler(options) : { ok: false, status: 404, body: { code: 'not_found' } };
  },
}));
const CompatibilityPage = (await import('@/app/dashboard/compatibility/page.js')).default;

const fixture = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  revision: 3,
  contentHash: 'abc123def456',
  archived: false,
  createdAt: '2026-09-06T10:00:00.000Z',
  name: 'Synthetic tool round trip',
  definition: {
    version: 1,
    origin: 'synthetic',
    suitable: true,
    operation: 'request',
    sourceFormat: 'openai',
    targetFormat: 'claude',
    model: 'synthetic-model',
    payload: { messages: [] },
  },
};
const baseRun = {
  id: '11111111-2222-3333-4444-555555555555',
  fixtureId: fixture.id,
  fixtureRevision: 3,
  fixtureHash: fixture.contentHash,
  scope: 'local-translation',
  implementationVersion: 'local-compatibility-v1',
  createdAt: '2026-09-06T10:05:00.000Z',
  finishedAt: null,
  result: null,
  error: null,
};
const catalog = {
  fixtures: [fixture],
  evidence: [],
  formats: ['openai', 'claude', 'gemini', 'openai-responses'],
  limits: { fixtureIds: 200, queued: 4, timeoutMs: 3000 },
  evidenceBasis: 'Retained local fixture outcomes only.',
};

let container, root, runsBody;
const packet = (run) => ({ run, fixture });

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
  vi.useFakeTimers();
  state.calls = [];
  runsBody = { items: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } };
  state.routes = {
    'GET /api/admin/compatibility': () => ({ ok: true, status: 200, body: catalog }),
    'GET /api/admin/compatibility/runs': () => ({ ok: true, status: 200, body: runsBody }),
    [`GET /api/admin/compatibility/runs/${baseRun.id}`]: () => ({
      ok: true,
      status: 200,
      body: packet(runsBody.items[0] || baseRun),
    }),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const render = () =>
  act(async () =>
    root.render(
      <MantineProvider env="test">
        <CompatibilityPage />
      </MantineProvider>
    )
  );
const button = (text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
const click = (text) => act(async () => button(text).click());

it('mounts the fixture book, queue contract and empty inspector from retained state', async () => {
  await render();
  if (runsBody.items.length) await click('Runs');
  expect(container.textContent).toContain('Fixture book');
  expect(container.textContent).toContain('Synthetic tool round trip');
  expect(container.textContent).toContain('4');
  expect(button('Run revision 3')).toBeTruthy();
  await click('Runs');
  expect(container.textContent).toContain('waiting slots');
  expect(container.textContent).toContain('Select a retained run');
  expect(container.textContent).toContain('No run is retained yet');
});

it('submits a pinned revision, renders the queued run identity, then the terminal receipt', async () => {
  state.routes['POST /api/admin/compatibility/runs'] = (options) => {
    expect(options.body).toEqual({ fixtureId: fixture.id, revision: 3 });
    runsBody = {
      items: [{ ...baseRun, status: 'queued' }],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    };
    return { ok: true, status: 200, body: { ...baseRun, status: 'queued' } };
  };
  await render();
  if (runsBody.items.length) await click('Runs');
  await click('Run revision 3');
  expect(container.textContent).toContain('queued');
  expect(container.textContent).toContain('abc123de');
  expect(container.textContent).toContain('local-compatibility-v1');
  expect(container.textContent).toContain('Waiting for this exact local run');
  // The non-terminal packet polls; the next tick returns a succeeded receipt.
  runsBody = {
    items: [
      {
        ...baseRun,
        status: 'succeeded',
        finishedAt: '2026-09-06T10:05:01.000Z',
        result: {
          sourceFormat: 'openai',
          targetFormat: 'claude',
          operation: 'request',
          route: { mode: 'direct' },
          checks: [
            {
              id: 'source-envelope',
              label: 'Source message envelope',
              outcome: 'passed',
              basis: 'x',
            },
          ],
          input: {},
          output: {},
          comparison: {},
          quantities: { inputBytes: 10, outputBytes: 12, translatorDurationMs: 1.5 },
        },
      },
    ],
    pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100);
  });
  expect(container.textContent).toContain('Local checks passed');
  expect(container.textContent).toContain('Direct translator');
  expect(button('Export this run')).toBeTruthy();
  expect(button('Cancel run')).toBeUndefined();
});

it('cancel is offered on a live run, calls the cancel route, and a cancelled receipt loses it', async () => {
  runsBody = {
    items: [{ ...baseRun, status: 'running' }],
    pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
  };
  let cancelled = false;
  state.routes[`POST /api/admin/compatibility/runs/${baseRun.id}/cancel`] = () => {
    cancelled = true;
    runsBody = {
      items: [
        {
          ...baseRun,
          status: 'cancelled',
          finishedAt: '2026-09-06T10:05:02.000Z',
          error: {
            code: 'operator_cancelled',
            message: 'Cancelled by the operator. No retry was scheduled.',
          },
        },
      ],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    };
    return { ok: true, status: 200, body: runsBody.items[0] };
  };
  await render();
  if (runsBody.items.length) await click('Runs');
  await act(async () =>
    container.querySelector(`[aria-label="Inspect run ${baseRun.id}"]`).click()
  );
  expect(container.textContent).toContain('You can cancel it');
  await click('Cancel run');
  expect(cancelled).toBe(true);
  expect(container.textContent).toContain('cancelled');
  expect(container.querySelector('[role="alert"]').textContent).toContain('No retry was scheduled');
  expect(button('Cancel run')).toBeUndefined();
});

it('renders honest terminal failures: deadline, missing edge and result_unretainable', async () => {
  const terminal = (error) => ({
    ...baseRun,
    status: error.code === 'deadline' ? 'timed-out' : 'failed',
    finishedAt: '2026-09-06T10:05:03.000Z',
    error,
  });
  for (const error of [
    {
      code: 'deadline',
      message: 'The3second local execution deadline elapsed. No automatic retry was started.',
    },
    {
      code: 'route_unavailable',
      message:
        'A complete registered conversion path is unavailable. No passthrough was substituted.',
    },
    {
      code: 'result_unretainable',
      message:
        'The run finished but its result could not be retained within the byte limit. No retry was started.',
    },
  ]) {
    runsBody = {
      items: [terminal(error)],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    };
    await render();
  if (runsBody.items.length) await click('Runs');
    await act(async () =>
      container.querySelector(`[aria-label="Inspect run ${baseRun.id}"]`).click()
    );
    expect(container.querySelector('[role="alert"]').textContent).toContain(error.message);
    expect(container.textContent).toContain('The terminal receipt is retained');
    expect(button('Cancel run')).toBeUndefined();
    expect(container.textContent).toContain(terminal(error).status);
  }
});

it('queue refusal surfaces as an explicit notice and schedules nothing', async () => {
  state.routes['POST /api/admin/compatibility/runs'] = () => ({
    ok: false,
    status: 503,
    body: {
      code: 'queue_full',
      error: 'The local execution queue is full. Nothing was scheduled; retry deliberately later.',
    },
  });
  await render();
  if (runsBody.items.length) await click('Runs');
  await click('Run revision 3');
  expect(container.textContent).toContain('Queue full, run refused');
  expect(container.textContent).toContain('Nothing was scheduled');
  await click('Runs');
  expect(container.textContent).toContain('Select a retained run');
});

it('unknown identity fields render unknown, never a guessed value', async () => {
  runsBody = {
    items: [
      {
        ...baseRun,
        status: 'interrupted',
        fixtureHash: null,
        implementationVersion: null,
        createdAt: null,
      },
    ],
    pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
  };
  await render();
  if (runsBody.items.length) await click('Runs');
  const row = container.querySelector('table tbody tr');
  expect(row.textContent).toContain('unknown');
  expect(row.textContent).toContain('interrupted');
});

it('a disconnected submission reports unknown acceptance and never replays the run', async () => {
  state.routes['POST /api/admin/compatibility/runs'] = () => ({ ok: false, status: 0, body: { code: 'network' } });
  await render();
  if (runsBody.items.length) await click('Runs');
  await click('Run revision 3');
  expect(container.textContent).toContain('Run acceptance is unknown');
  expect(container.textContent).toContain('may have been accepted');
  expect(state.calls.filter((entry) => entry.method === 'POST')).toHaveLength(1);
});

it('missing retained measurements remain unknown and do not crash the result inspector', async () => {
  runsBody = { items: [{ ...baseRun, status: 'succeeded', result: { sourceFormat: 'openai', targetFormat: 'claude', route: { mode: 'direct' }, checks: [], quantities: { inputBytes: 0, outputBytes: null, translatorDurationMs: null } } }], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 } };
  await render();
  if (runsBody.items.length) await click('Runs');
  await act(async () => container.querySelector(`[aria-label="Inspect run ${baseRun.id}"]`).click());
  expect(container.textContent).toContain('Input 0 B');
  expect(container.textContent).toContain('Output Unknown B');
  expect(container.textContent).toContain('Translator Unknown ms');
});

it('archives an exact fixture revision with confirmation and readback without running it', async () => {
  let stored = { ...fixture };
  state.routes['GET /api/admin/compatibility'] = () => ({ ok: true, status: 200, body: { ...catalog, fixtures: [stored] } });
  state.routes[`PATCH /api/admin/compatibility/fixtures/${fixture.id}`] = options => {
    expect(options.body).toMatchObject({ revision: 3, archived: true, definition: fixture.definition });
    stored = { ...stored, revision: 4, archived: true };
    return { ok: true, status: 200, body: stored };
  };
  state.routes[`GET /api/admin/compatibility/fixtures/${fixture.id}`] = () => ({ ok: true, status: 200, body: stored });
  await render();
  if (runsBody.items.length) await click('Runs');
  await click('Archive fixture');
  expect(state.calls.some(call => call.method === 'PATCH')).toBe(false);
  const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm archive');
  expect(confirm).toBeTruthy();
  await act(async () => confirm.click());
  expect(container.textContent).toContain('Fixture archived and read back.');
  expect(button('Run revision 4').disabled).toBe(true);
  expect(button('Restore fixture')).toBeTruthy();
  expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  expect(state.calls.some(call => call.url === '/api/admin/compatibility/runs' && call.method === 'POST')).toBe(false);
});
