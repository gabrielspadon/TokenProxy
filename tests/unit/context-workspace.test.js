// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFixture } from '../fixtures/context-workspace.js';
import { bucketScope, contextUrl, quantity, signedBytes, trendOption } from '../../src/shared/components/context-workspace/contextModel.js';

const state = vi.hoisted(() => ({ workspace: null, chart: null }));
vi.mock('@/shared/workspace/WorkspaceProvider', async () => {
  const { useState,useCallback }=await import('react');
  return {useWorkspace:()=>{
    const [contextView,setContext]=useState(()=>({sessionId:state.workspace.initialSessionId ?? null,page:1,projectLabel:null,clientTool:null}));
    const [selectedRecord,setSelectedRecord]=useState(null);
    const setContextView=useCallback((patch)=>setContext(previous=>({...previous,...patch})),[]);
    return {...state.workspace,contextView,setContextView,selectedRecord,setSelectedRecord};
  }};
});
vi.mock('@/shared/workspace/ScopeBar', () => ({ ScopeBar: () => <div aria-label="Shared scope fixture" /> }));
vi.mock('@/shared/workspace/ActivityBand', () => ({ ActivityBand: () => <div aria-label="Shared activity fixture" /> }));
// Canvas drawing belongs to the shared wrapper. This suite exercises data and interaction contracts.
vi.mock('@/shared/workspace/AnalyticalChart', () => ({ METRIC_COLORS: { selected: '#455bca', input: '#647ac8', cacheRead: '#208d82', failure: '#b34e61' }, AnalyticalChart: (props) => { state.chart = props; return <div role="img" aria-label={props.label} />; } }));
const { ContextWorkspace } = await import('../../src/shared/components/context-workspace/ContextWorkspace.js');
let container, root, fixture, fetchMock, router;
const initialScope = { period: 'all', start: null, end: null, provider: null, model: null, connectionId: null };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function render() { if(state.workspace.initialSessionId===undefined)state.workspace.initialSessionId=fixture.overview.sessions?.[0]?.id ?? null; await act(async () => root.render(<RouterContext.Provider value={router}><MantineProvider env="test"><ContextWorkspace /></MantineProvider></RouterContext.Provider>)); await flush(); }
async function click(selector) { const element = container.querySelector(selector); expect(element).not.toBeNull(); await act(async () => element.click()); await flush(); }
function button(text) { return [...container.querySelectorAll('button')].find((item) => item.textContent === text); }
async function clickText(text) { const element = button(text); expect(element).toBeTruthy(); await act(async () => element.click()); await flush(); }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  fixture = contextFixture(); state.chart = null;
  router = { pathname: '/dashboard/context', asPath: '/dashboard/context', push: vi.fn(), replace: vi.fn(), prefetch: vi.fn().mockResolvedValue(undefined) };
  state.workspace = { scope: { ...initialScope }, setScope: vi.fn(), accounts: [{ connectionId: 'synthetic-account', displayName: 'Synthetic account' }], snapshot: null, observeSnapshot: vi.fn() };
  fetchMock = vi.fn(async (url, options) => options?.method === 'PATCH' ? response({ updated: true }) : response(String(url).includes('/sessions/') ? fixture.detail : fixture.overview));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Context projection contracts', () => {
  it('maps every shared filter and exclusive end without timezone conversion', () => {
    const scope = { start: '2026-09-06T10:00:00Z', end: '2026-09-06T11:00:00Z', provider: 'a/b', model: 'model', connectionId: 'account' };
    const url = new URL(contextUrl(scope, { sessionId: 7, page: 2, projectLabel: 'Human label', clientTool: 'cli' }), 'http://test.local');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', pageSize: '25', provider: 'a/b', model: 'model', connectionId: 'account', from: scope.start, until: scope.end, projectLabel: 'Human label', clientTool: 'cli' });
    expect(url.pathname).toBe('/api/context/sessions/7');
  });
  it('retains null measurements and never stacks cache onto inclusive input', () => {
    const option = trendOption(fixture.detail.trend, {}, initialScope);
    expect(option.series[1].data.map((point) => point[1])).toEqual([1200, null, 400]);
    expect(option.series[2].data.map((point) => point[1])).toEqual([400, null, 50]);
    expect(option.series.every((series) => !series.stack)).toBe(true);
    expect(option.series[0].type).toBe('scatter');
    expect(quantity(null)).toBe('Unknown'); expect(quantity(0)).toBe('0'); expect(quantity(Infinity)).toBe('Unknown');
    expect(signedBytes(-1000)).toBe('-1,000 B'); expect(signedBytes(40)).toBe('+40 B');
  });
  it('clips focused buckets to the shared half-open range', () => {
    expect(bucketScope({ bucketStart: '2026-09-06T10:00:00Z' }, 60000, { start: '2026-09-06T10:00:20Z', end: '2026-09-06T10:00:50Z' })).toEqual({ period: 'custom', start: '2026-09-06T10:00:20.000Z', end: '2026-09-06T10:00:50.000Z' });
  });
  it('includes dates in track ticks when a session spans days', () => {
    fixture.detail.trend.points[2].bucketStart = '2026-09-07T10:02:00.000Z';
    const option = trendOption(fixture.detail.trend, {}, initialScope);
    expect(option.xAxis[2].axisLabel.formatter(Date.parse('2026-09-07T10:02:00Z'))).toBe('09-07 10:02');
  });
});

describe('Context workspace', () => {
  it('leaves the identity unselected until an operator chooses a session', async () => {
    state.workspace.initialSessionId=null;
    await render();
    expect(container.querySelector('[aria-label="Recorded session cohort"]')).not.toBeNull();
    expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sessions/'))).toBe(false);
    expect(state.chart).toBeNull();
  });
  it('renders isolated SQLite writer and read-worker projections without inventing unavailable fields', async () => {
    expect(process.env.DATA_DIR).toContain('tokenproxy-test-file-');
    const { saveRequestStats } = await import('../../src/lib/db/repos/requestStatsRepo.js');
    const { getAdapter } = await import('../../src/lib/db/driver.js');
    const { getContextOverview, getContextSession, updateContextSession } = await import('../../src/lib/db/repos/contextRepo.js');
    const db = await getAdapter();
    try {
      for (const [index, turn] of fixture.detail.turns.entries()) {
        await saveRequestStats({ id: String(turn.id), timestamp: new Date(Date.now() - 600000 + index * 60000).toISOString(), provider: turn.provider, model: turn.model, connectionId: turn.connectionId, status: turn.status,
          tokens: turn.usageSource === 'provider' ? { prompt_tokens: turn.providerInputTokens, completion_tokens: turn.providerOutputTokens, cached_tokens: turn.cacheReadTokens, cache_creation_input_tokens: turn.cacheWriteTokens } : null,
          contextTelemetry: { sessionHash: 'f'.repeat(32), identitySource: 'inferred', logicalRequestId: turn.logicalRequestId, attempt: 1, contextEstimate: turn.contextEstimate, bodyAfterBytes: turn.bodyAfterBytes, clientTool: turn.clientTool, controls: turn.controls,
            stages: turn.stages.map((stage) => ({ stage: stage.stage, in: stage.beforeBytes, out: stage.afterBytes, semanticPreserving: stage.stage === 'rtk' })) },
        });
      }
      await saveRequestStats({ id: 'unattributed', timestamp: new Date().toISOString(), status: 'success', tokens: { prompt_tokens: 10 } });
      fixture.overview = await getContextOverview();
      expect(fixture.overview.recording).toMatchObject({ totalRetainedAttempts: 4, attributedAttempts: 3, unattributedAttempts: 1, rejectedAttempts: 0 });
      const id = fixture.overview.sessions[0].id;
      await updateContextSession(id, { projectLabel: 'Synthetic SQLite pipeline' });
      fixture.overview = await getContextOverview();
      fixture.detail = await getContextSession(id);
      expect(fixture.detail.summary).toMatchObject({ providerInputTokens: 1600, cacheReadTokens: 450, cacheWriteTokens: 0, missingUsageSamples: 1, savedBytes: 2880 });
      expect(fixture.detail.turns[1]).toMatchObject({ usageSource: 'missing', providerInputTokens: null });
      await render(); await click('[aria-label="Inspect attempt 101"]');
      expect(container.textContent).toContain('Synthetic SQLite pipeline');
      expect(container.querySelectorAll('table[aria-label="Ordered shaping stages"] tbody tr')).toHaveLength(14);
      expect(container.textContent).toContain('-960 B');
      expect(state.chart.option.series[1].data.map((point) => point[1])).toEqual([1200, null, 400]);
    } finally {
      await globalThis._contextAnalytics?.client.close();
      db.close();
    }
  });
  it('shows historical coverage without synthesizing sessions or requesting their details', async () => {
    fixture.overview = { ...fixture.overview, recording: { totalRetainedAttempts: 77589, attributedAttempts: 0, unattributedAttempts: 77589, rejectedAttempts: 0 }, sessions: [], summary: { sessions: 0 } };
    state.workspace.snapshot = { isolated: true, capturedAt: '2026-09-06T10:03:00Z' };
    await render();
    expect(container.textContent).toContain('77,589');
    expect(container.textContent).toContain('No context evidence in this selection');
    expect(container.textContent).toContain('cannot reconstruct session identities');
    expect(container.textContent).toContain('will not generate requests');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sessions/'))).toBe(false);
    expect(state.chart).toBeNull();
  });
  it('renders real v9 rows, preserves unknown cache versus observed zero, and opens all 14 ordered stages', async () => {
    await render();
    const rows = container.querySelectorAll('table[aria-label="Session request attempts"] tbody tr');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('1.2K400080');
    expect(rows[1].textContent).toContain('Incomplete');
    expect(rows[1].textContent).toContain('Unknown');
    await click('[aria-label="Inspect attempt 101"]');
    const stageRows = container.querySelectorAll('table[aria-label="Ordered shaping stages"] tbody tr');
    expect(stageRows.length).toBe(14);
    expect(stageRows[0].textContent).toContain('01Tool disclosure');
    expect(stageRows[13].textContent).toContain('14Final normalization');
    expect(stageRows[3].textContent).toContain('-1,000 B');
    expect(stageRows[5].textContent).toContain('+40 B');
    expect(container.textContent).toContain('Synthetic account');
    expect(container.querySelector('[aria-label="Resize detail panel"]')).not.toBeNull();
  });
  it('keeps provider usage on failures and labels prefix changes as observations', async () => {
    await render(); await click('[aria-label="Inspect attempt 103"]');
    expect(container.textContent).toContain('Provider reported');
    expect(container.textContent).toContain('400 tokens');
    await click('[aria-label="Inspect attempt 102"]');
    expect(container.textContent).toContain('Usage missing');
    expect(container.textContent).toContain('not proof of client compaction');
    expect(container.textContent).toContain('may combine separate agents');
  });
  it('focuses the full-session trend through shared scope, not the visible attempt page', async () => {
    fixture.detail.turns = fixture.detail.turns.slice(0, 1);
    await render();
    expect(state.chart.option.series[0].data.length).toBe(3);
    await act(async () => state.chart.onEvents.click({ dataIndex: 2 }));
    expect(state.workspace.setScope).toHaveBeenCalledWith({ period: 'custom', start: '2026-09-06T10:02:00.000Z', end: '2026-09-06T10:03:00.000Z' });
  });
  it('preserves the investigated session and request when a focused interval excludes them', async () => {
    const chosen = { ...fixture.detail.session, id: 8, projectLabel: 'Chosen investigation' };
    fixture.overview.sessions.push(chosen);
    await render();
    fixture.detail.session = chosen;
    const sessionButton = [...container.querySelectorAll('[aria-label="Recorded session cohort"] button')].find((item) => item.textContent.includes('Chosen investigation'));
    await act(async () => sessionButton.click()); await flush();
    await click('[aria-label="Inspect attempt 101"]');
    await act(async () => state.chart.onEvents.click({ dataIndex: 2 }));
    state.workspace = { ...state.workspace, scope: { ...initialScope, ...state.workspace.setScope.mock.calls.at(-1)[0] } };
    fixture.overview.sessions = [fixture.overview.sessions[0]];
    fixture.detail = { ...fixture.detail, turns: [], summary: { ...fixture.detail.summary, attempts: 0 }, trend: { ...fixture.detail.trend, points: [] } };
    await render();
    expect(fetchMock.mock.calls.at(-1)[0]).toContain('/sessions/8?page=1');
    expect(container.textContent).toContain('Selected session #8 has no attempts in this scope');
    expect(container.textContent).toContain('Selected request #101 is outside this page or scope');
    expect(container.querySelector('table[aria-label="Session request attempts"]')).toBeNull();
    fixture.detail = { ...contextFixture().detail, session: chosen };
    state.workspace = { ...state.workspace, scope: { ...initialScope } };
    await render();
    expect(container.querySelector('[aria-label="Selection details"]')).not.toBeNull();
    expect(container.textContent).toContain('Chosen investigation');
  });
  it('keeps the initial session when a shared filter changes the cohort order', async () => {
    await render();
    fixture.overview.sessions = [{ ...fixture.detail.session, id: 9, projectLabel: 'Different cohort leader' }, fixture.detail.session];
    state.workspace = { ...state.workspace, scope: { ...initialScope, model: 'different-model' } };
    await render();
    expect(fetchMock.mock.calls.at(-1)[0]).toContain('/sessions/7?page=1');
    expect(container.querySelector('[aria-pressed="true"]').textContent).toContain('Synthetic research');
  });
  it('paginates attempts on the server without replacing a still-returned selected identity', async () => {
    fixture.detail.pagination = { ...fixture.detail.pagination, totalItems: 26, totalPages: 2, hasNext: true };
    await render(); await click('[aria-label="Inspect attempt 101"]');
    await click('[aria-label="Next attempts page"]');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sessions/7?page=2'))).toBe(true);
    expect(container.querySelector('[aria-label="Selection details"]')?.textContent).toContain('Request #101');
  });
  it('saves an operator label with a PATCH and exposes an authorization refusal', async () => {
    await render(); await clickText('Edit project label');
    fetchMock.mockImplementation(async (url, options) => options?.method === 'PATCH' ? response({ error: 'Operator authorization required' }, 403) : response(String(url).includes('/sessions/') ? fixture.detail : fixture.overview));
    await clickText('Save label');
    expect(fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')[1]).toMatchObject({ body: JSON.stringify({ projectLabel: 'Synthetic research' }) });
    expect(container.textContent).toContain('Project label not saved');
    expect(container.textContent).toContain('Operator authorization required');
  });
  it('refreshes both projections only after a successful project label save', async () => {
    await render(); await clickText('Edit project label');
    const before = fetchMock.mock.calls.length;
    await clickText('Save label');
    const requests = fetchMock.mock.calls.slice(before);
    expect(requests.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
    expect(requests.filter(([, options]) => options?.method !== 'PATCH')).toHaveLength(2);
    expect(button('Edit project label')).toBeTruthy();
  });
  it('shows recorded controls and routing receipt scope without claiming active pins', async () => {
    await render(); await click('[aria-label="Inspect attempt 101"]');
    await click('input[value="controls"]');
    expect(container.textContent).toContain('Lossy tool results allowedDisabled');
    expect(container.textContent).toContain('Visual conversion allowedUnknown');
    await click('input[value="routing"]');
    expect(container.textContent).toContain('independent of the turn time filter');
    expect(container.textContent).toContain('Synthetic cooldown receipt');
    expect(container.textContent).toContain('Stored account pins');
    expect(container.textContent).not.toContain('Active pin');
  });
  it('uses client navigation for recorded controls without resetting the shared scope', async () => {
    state.workspace.scope = { ...initialScope, provider: 'synthetic-provider', start: '2026-09-06T10:00:00Z', end: '2026-09-06T11:00:00Z' };
    const sharedScope = state.workspace.scope;
    await render(); await click('[aria-label="Inspect attempt 101"]');
    await click('input[value="controls"]');
    const link = container.querySelector('[aria-label="Selection details"] a[href="/dashboard/shaping"]');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/dashboard/shaping', { scroll: true });
    expect(state.workspace.scope).toBe(sharedScope);
    expect(state.workspace.setScope).not.toHaveBeenCalled();
  });
  it('shows requested and served model evidence together', async () => {
    fixture.detail.turns[0].requestedModel = 'requested-alias';
    await render();
    expect(container.querySelector('table[aria-label="Session request attempts"]').textContent).toContain('Served provider / model');
    expect(container.querySelector('table[aria-label="Session request attempts"] tbody tr').textContent).toContain('Requested · requested-alias');
    await click('[aria-label="Inspect attempt 101"]');
    expect(container.querySelector('[aria-label="Selection details"]').textContent).toContain('Served provider / model');
    expect(container.querySelector('[aria-label="Selection details"]').textContent).toContain('requested-alias');
  });
  it('keeps pagination available for an empty page of a nonempty cohort', async () => {
    fixture.overview.sessions = [];
    fixture.overview.pagination = { page: 2, pageSize: 20, totalItems: 1, totalPages: 1, hasPrev: true, hasNext: false };
    await render();
    expect(container.textContent).toContain('No sessions on this page');
    expect(container.textContent).not.toContain('No context evidence in this selection');
    expect(container.querySelector('[aria-label="Previous sessions page"]').disabled).toBe(false);
  });
  it('drops previous evidence immediately when the shared scope changes', async () => {
    await render(); await click('[aria-label="Inspect attempt 101"]');
    fetchMock.mockImplementation(() => new Promise(() => {}));
    state.workspace = { ...state.workspace, scope: { ...initialScope, provider: 'different-provider' } };
    await render();
    expect(container.querySelector('table[aria-label="Session request attempts"]')).toBeNull();
    expect(container.textContent).not.toContain('Synthetic research');
    expect(container.textContent).toContain('Reading recorded context');
  });
  it('exposes a failed read without presenting fabricated zero coverage', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'Analytics reader is busy' }, 503));
    await render();
    expect(container.textContent).toContain('Context unavailable');
    expect(container.textContent).toContain('Analytics reader is busy');
    expect(container.querySelector('[aria-label="Context recording coverage"]').textContent).toContain('Unknown');
    expect(container.textContent).not.toContain('No context evidence in this selection');
  });
});
