// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeQuotaSeries } from '@/lib/db/analytics/quotaTrend.mjs';
import {
  quotaChecksUrl,
  quotaObservationOption,
  quotaWorkbenchUrl,
} from '@/shared/workspace/quotaWorkbenchModel';

const state = vi.hoisted(() => ({ workspace: null, chart: null }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useWorkspace: () => state.workspace }));
vi.mock('@/shared/workspace/AnalyticalChart', () => ({
  AnalyticalChart: (props) => {
    state.chart = props;
    return <div role="img" aria-label={props.label} />;
  },
}));
const { QuotaHistoryWorkbench } = await import('@/shared/workspace/QuotaHistoryWorkbench');
const start = '2026-09-06T10:00:00.000Z',
  end = '2026-09-06T10:57:00.000Z';
const anchor = Date.parse(end);
let root, container, fixture, fetchMock;
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const render = async (props = {}) => {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <QuotaHistoryWorkbench account={{ connectionId: 'account-1' }} anchor={anchor} {...props} />
      </MantineProvider>
    )
  );
  await flush();
};
const clickText = async (text) => {
  const element = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === text
  );
  expect(element).toBeTruthy();
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
  state.workspace = {
    scope: { start, end, provider: 'claude', model: 'retained-model' },
    observeSnapshot: vi.fn(),
    setSelectedAccountId: vi.fn(),
  };
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `sample-${i}`,
    observedAt: new Date(Date.parse(start) + i * 300_000).toISOString(),
    capturedAt: new Date(Date.parse(start) + i * 300_000).toISOString(),
    remaining: 200 - i * 10,
    limit: 200,
    unit: 'requests',
    resetAt: '2026-09-07T00:00:00Z',
  }));
  fixture = {
    complete: true,
    total: rows.length,
    series: [
      {
        id: 'window-1',
        scope: 'weekly',
        source: 'provider-usage',
        resourceType: 'request-limit',
        measurement: 'absolute',
        analysis: analyzeQuotaSeries(rows, { asOf: end }),
        points: rows.map((row) => ({ ...row, value: row.remaining, confidence: 'reported' })),
        coverage: { records: rows.length, measured: rows.length, timed: rows.length },
      },
    ],
    freshness: { source: 'committed-sqlite', snapshotCompletedAt: end },
  };
  fetchMock = vi.fn(async (url) =>
    response(String(url).includes('/history?') ? { items: [], total: 0, pages: 0 } : fixture)
  );
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  state.chart = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Quota workbench interaction', () => {
  it('uses a shared account/provider/time scope and explicitly discloses unavailable model attribution', async () => {
    const url = quotaWorkbenchUrl(state.workspace.scope, 'account-1', anchor);
    expect(Object.fromEntries(new URL(url, 'http://localhost').searchParams)).toEqual({
      connectionId: 'account-1',
      provider: 'claude',
      start,
      end,
    });
    expect(
      new URL(quotaChecksUrl(url, 2, 'failed'), 'http://localhost').searchParams.get('page')
    ).toBe('2');
    await render();
    expect(container.textContent).toContain('The shared model filter is preserved');
    expect(container.textContent).toContain('Projected exhaustion');
    expect(container.textContent).toContain('120 requests/hour');
    expect(state.chart.option.series[0].type).toBe('scatter');
    expect(state.chart.option.tooltip.renderMode).toBe('richText');
  });
  it('links a point to its contributing table page and keeps it selected during a refresh', async () => {
    await render();
    await act(async () => state.chart.onEvents.click({ data: { id: 'sample-0' } }));
    expect(
      container
        .querySelector('[aria-label="Inspect quota observation sample-0"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    expect(
      container.querySelector('[aria-label="Selected quota observation"]').textContent
    ).toContain('sample-0');
    await clickText('Refresh history');
    expect(
      container
        .querySelector('[aria-label="Inspect quota observation sample-0"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
  });
  it('filters contributing rows with observation zoom while preserving an out-of-zoom selection', async () => {
    await render();
    await act(async () => state.chart.onEvents.click({ data: { id: 'sample-0' } }));
    await act(async () =>
      state.chart.onEvents.datazoom({
        startValue: Date.parse(start) + 30 * 60_000,
        endValue: anchor,
      })
    );
    expect(
      container.querySelectorAll('table[aria-label="Contributing quota observations"] tbody tr')
    ).toHaveLength(6);
    expect(container.textContent).toContain(
      'This selection is outside the current observation zoom.'
    );
    await clickText('Clear observation zoom');
    expect(container.textContent).not.toContain('This selection is outside');
  });
  it('makes scenario exclusion local and does not perform a mutation or upstream request', async () => {
    await render();
    const input = container.querySelector('input[type="checkbox"]');
    expect(input).toBeTruthy();
    await act(async () => input.click());
    expect(container.textContent).toContain(
      'Redistribution to other accounts has not been simulated.'
    );
    expect(
      fetchMock.mock.calls.every(
        ([url, options]) => url.startsWith('/api/admin/quota/') && !options.method
      )
    ).toBe(true);
  });
  it('does not construct a forecast when the population is incomplete or unavailable', async () => {
    fixture = { complete: false, total: 5001, instruction: 'Narrow the time range.' };
    await render();
    expect(container.textContent).toContain('no partial-data forecast');
    expect(state.chart).toBeNull();
    fetchMock.mockImplementation(async () =>
      response({ error: { message: 'Read worker busy' } }, 503)
    );
    await clickText('Refresh history');
    expect(container.textContent).toContain('Read worker busy');
  });
  it('shows unknown balance/times and excludes them from plotted measurements', async () => {
    fixture.series[0].points[0] = { ...fixture.series[0].points[0], value: null, observedAt: null };
    const option = quotaObservationOption(fixture.series[0], null, null);
    expect(option.series[0].data).toHaveLength(11);
    expect(option.series[0].data.some((point) => point.id === 'sample-0')).toBe(false);
  });
});
