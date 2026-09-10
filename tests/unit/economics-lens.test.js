// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import EconomicsLens, {
  EconomicsDetail,
} from '../../src/shared/components/workspace/EconomicsLens';
import {
  averageTokens,
  costShare,
  formatEstimate,
  groupFilters,
  groupKey,
  groupName,
  qualityNotes,
  TOKEN_COLUMNS,
} from '../../src/shared/components/workspace/economics';

const quantities = {
  records: 10,
  inputTokens: 1000,
  uncachedInputTokens: 200,
  cacheReadTokens: 700,
  cacheWriteTokens: 100,
  outputTokens: 80,
  costSamples: 8,
  zeroCostRows: 3,
  recordedCostUsd: 4,
  inputSamples: 10,
  outputSamples: 10,
  cacheReadSamples: 9,
  cacheWriteSamples: 9,
  uncachedInputSamples: 9,
  inconsistentCacheRows: 0,
  missingTokenDetailRows: 0,
  invalidTokenRows: 0,
};
const providerA = {
  ...quantities,
  provider: 'openai',
  model: 'shared-model',
  connectionId: 'configured-1',
};
const providerB = {
  ...quantities,
  provider: 'anthropic',
  model: 'shared-model',
  connectionId: 'historical-123456789',
  recordedCostUsd: 9,
  records: 20,
};
const recordA = {
  id: 19,
  timestamp: '2026-09-01T12:00:00.000Z',
  provider: 'openai',
  model: 'shared-model',
  connectionId: 'configured-1',
  inputTokens: 1000,
  uncachedInputTokens: 0,
  cacheReadTokens: 1700,
  cacheWriteTokens: 100,
  outputTokens: 80,
  recordedCostUsd: 0,
  status: 'success',
  inconsistentCache: 1,
  missingTokenDetail: 0,
  invalidTokens: 0,
};
const recordB = {
  ...recordA,
  id: 18,
  timestamp: '2026-09-01T11:00:00.000Z',
  recordedCostUsd: 0.01,
};
const data = {
  summary: { ...quantities, records: 30, recordedCostUsd: 13 },
  groups: [providerA, providerB],
  items: [recordA, recordB],
  pagination: {
    page: 1,
    pageSize: 2,
    totalItems: 30,
    totalPages: 15,
    hasNext: true,
    hasPrev: false,
  },
};

let container;
let root;
// The dense cohort table and the record ledger are the Advanced level; the
// Everyday level renders the same population as compact cards.
function mount(props = {}) {
  act(() =>
    root.render(
      <MantineProvider env="test">
        <EconomicsLens data={data} advanced {...props} />
      </MantineProvider>
    )
  );
}
function click(element) {
  expect(element).not.toBeNull();
  act(() => element.click());
}
function byButton(text, parent = container) {
  return [...parent.querySelectorAll('button')].find((element) =>
    element.textContent.includes(text)
  );
}
function tableBody(label) {
  return container.querySelector(`table[aria-label="${label}"] tbody`);
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
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Economics ledger interactions', () => {
  it('retains chosen token-column modes while a server sort or scope read temporarily unloads the rows', () => {
    mount();
    click(byButton('Show token columns'));
    click(byButton('Show record token columns'));
    mount({data:null,loading:true});
    mount();
    expect(byButton('Show overview columns')).toBeDefined();
    expect(byButton('Show record overview')).toBeDefined();
    expect(container.querySelector('table[aria-label="Economics by cohort"]').textContent).toContain('Cache read');
  });
  it('keeps overview measures compact and exposes full token columns with server sorting', () => {
    const onLedgerSortingChange = vi.fn();
    mount({ onLedgerSortingChange });
    const table = container.querySelector('table[aria-label="Recorded requests"]');
    expect(table.querySelectorAll('thead th')).toHaveLength(5);
    expect(table.textContent).toContain('Input includes cache; values are separate');
    click(byButton('Show record token columns'));
    click(byButton('Cache read', table));
    expect(onLedgerSortingChange).toHaveBeenCalledWith({ id: 'cacheReadTokens', desc: true });
    click(byButton('Show record overview'));
    expect(table.querySelectorAll('thead th')).toHaveLength(5);
  });
  it('sorts the cohort book numerically and keeps named provider/model identities distinct', () => {
    mount({ groupBy: 'model' });
    let rows = [...tableBody('Economics by cohort').querySelectorAll('tr')];
    expect(rows[0].textContent).toContain('Anthropic');
    click(
      byButton('Recorded cost', container.querySelector('table[aria-label="Economics by cohort"]'))
    );
    rows = [...tableBody('Economics by cohort').querySelectorAll('tr')];
    expect(rows[0].textContent).toContain('OpenAI');
    expect(rows[1].textContent).toContain('Anthropic');
    expect(rows.every((row) => row.textContent.includes('shared-model'))).toBe(true);
  });

  it('inspects a cohort without filtering and exposes a separate exact drilldown', () => {
    const onGroupSelect = vi.fn(),
      onInspect = vi.fn();
    mount({ onGroupSelect, onInspect });
    click(container.querySelector('button[aria-label="Inspect openai on openai"]'));
    expect(onGroupSelect).not.toHaveBeenCalled();
    expect(onInspect).toHaveBeenCalledWith({
      kind: 'economics-group',
      group: providerA,
      groupBy: 'provider',
    });
    const onDrilldown = vi.fn();
    act(() => root.render(<MantineProvider env="test"><EconomicsDetail selection={onInspect.mock.calls[0][0]} onDrilldown={onDrilldown}/></MantineProvider>));
    click(byButton('Filter contributing ledger to this cohort'));
    expect(onDrilldown).toHaveBeenCalledWith('provider', providerA);
    mount({ selectedGroup: providerA, ledgerData: { ...data, items: [recordA] }, onGroupSelect });
    expect(tableBody('Economics by cohort').querySelectorAll('tr')).toHaveLength(2);
    expect(tableBody('Recorded requests').querySelectorAll('tr')).toHaveLength(1);
    click(byButton('Show full scope'));
    expect(onGroupSelect).toHaveBeenLastCalledWith(null);
  });

  it('uses server sorting for the complete ledger and never reorders only the loaded page', () => {
    const onLedgerSortingChange = vi.fn();
    mount({ onLedgerSortingChange });
    const table = container.querySelector('table[aria-label="Recorded requests"]');
    click(byButton('Recorded USD', table));
    expect(onLedgerSortingChange).toHaveBeenCalledWith({ id: 'recordedCostUsd', desc: true });
    expect(tableBody('Recorded requests').querySelector('tr').textContent).toContain(
      '09-01 12:00:00'
    );
    expect(container.textContent).toContain(
      'Sorting and status filters apply to the complete contributing ledger.'
    );
  });

  it('requests another server page and opens the exact record in the inspection dock', () => {
    const onPageChange = vi.fn(),
      onInspect = vi.fn();
    mount({ onPageChange, onInspect });
    click(container.querySelector('button[aria-label="Request ledger page 2"]'));
    expect(onPageChange).toHaveBeenCalledWith(2);
    click(container.querySelector('button[aria-label="Inspect record 19"]'));
    expect(onInspect).toHaveBeenCalledWith({ kind: 'economics-record', record: recordA });
  });

  it('restores the exact record highlight and holds row positions while live quantities change', () => {
    const ids = () => [...tableBody('Recorded requests').querySelectorAll('button[aria-label^="Inspect record"]')].map(button => button.getAttribute('aria-label'));
    mount({ inspectedRecordId: '19' });
    expect(container.querySelector('button[aria-label="Inspect record 19"]').getAttribute('aria-pressed')).toBe('true');
    mount({ inspectedRecordId: '19', data: {...data, items: [recordB, {...recordA, inputTokens: 2500}, {...recordB,id:20}] } });
    expect(ids()).toEqual(['Inspect record 19','Inspect record 18','Inspect record 20']);
    expect(tableBody('Recorded requests').querySelector('tr').textContent).toContain('2.5K');
    mount({ inspectedRecordId: null, data: {...data, items: [recordB, recordA]} });
    expect(ids()).toEqual(['Inspect record 18','Inspect record 19']);
  });

  it('compares selected named cohorts using explicit usable-sample denominators', () => {
    mount();
    click(container.querySelector('input[aria-label="Compare openai on openai"]'));
    click(container.querySelector('input[aria-label="Compare anthropic on anthropic"]'));
    const comparison = container.querySelector('[aria-label="Selected cohort comparison"]');
    expect(comparison.textContent).toContain('openai');
    expect(comparison.textContent).toContain('anthropic');
    expect(comparison.textContent).toContain('Cost samples / all records');
    expect(comparison.textContent).toContain('Cache read tokens / usable sample');
    expect(comparison.textContent).toContain('77.78 (9 samples)');
    click(byButton('Clear comparison'));
    expect(container.querySelector('[aria-label="Selected cohort comparison"]')).toBeNull();
  });

  it('retains comparison snapshots across server pages and loading, but clears a changed population', () => {
    const filters = { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z', groupPage: 1 };
    mount({ data: { ...data, filters, groups: [providerA] } });
    click(container.querySelector('input[aria-label="Compare openai on openai"]'));
    mount({ data: null, loading: true });
    mount({ data: { ...data, filters: { ...filters, groupPage: 2 }, groups: [providerB] } });
    click(container.querySelector('input[aria-label="Compare anthropic on anthropic"]'));
    let comparison = container.querySelector('[aria-label="Selected cohort comparison"]');
    expect(comparison.textContent).toContain('openai');
    expect(comparison.textContent).toContain('anthropic');
    expect(comparison.textContent).toContain('including cohorts on other pages');
    mount({ data: { ...data, filters, groups: [{ ...providerA, recordedCostUsd: 99 }] } });
    comparison = container.querySelector('[aria-label="Selected cohort comparison"]');
    expect(comparison.textContent).toContain('$4.00');
    expect(comparison.textContent).not.toContain('$99.00');
    expect(container.querySelector('input[aria-label="Compare openai on openai"]').checked).toBe(true);
    mount({ data: { ...data, filters: { ...filters, provider: 'openai' }, groups: [providerA] } });
    expect(container.querySelector('[aria-label="Selected cohort comparison"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Compare openai on openai"]').checked).toBe(false);
  });

  it('holds compared cohort positions during live updates without requiring an inspected row', () => {
    mount();
    click(container.querySelector('input[aria-label="Compare openai on openai"]'));
    mount({data:{...data,groups:[{...providerA,recordedCostUsd:100},{...providerB,recordedCostUsd:1}]}});
    let rows=[...tableBody('Economics by cohort').querySelectorAll('tr')];
    expect(rows[0].textContent).toContain('Anthropic');expect(rows[1].textContent).toContain('OpenAI');
    expect(rows[1].textContent).toContain('$100.00');
    click(byButton('Clear comparison'));
    rows=[...tableBody('Economics by cohort').querySelectorAll('tr')];
    expect(rows[0].textContent).toContain('OpenAI');
  });

  it('exposes pinning and switches grouping through controlled props', () => {
    const onGroupByChange = vi.fn();
    mount({ onGroupByChange });
    click(byButton('Unpin identity'));
    expect(byButton('Pin identity')).toBeDefined();
    click(container.querySelector('input[aria-label="Group economics by"]'));
    click(
      [...container.querySelectorAll('[role="option"]')].find(
        (option) => option.textContent === 'Model'
      )
    );
    expect(onGroupByChange.mock.calls[0][0]).toBe('model');
  });

  it('does not silently display the full ledger under a selected cohort while its rows are unavailable', () => {
    mount({ selectedGroup: providerA, ledgerLoading: true });
    expect(tableBody('Recorded requests')).toBeNull();
    expect(container.textContent).toContain('Loading contributing records');
    expect(tableBody('Economics by cohort').querySelectorAll('tr')).toHaveLength(2);
  });

  it('does not turn an unassigned identity into an unfiltered request', () => {
    const onGroupSelect = vi.fn(),
      onInspect = vi.fn();
    mount({
      data: { ...data, groups: [{ ...providerA, connectionId: null }] },
      groupBy: 'account',
      onGroupSelect,
      onInspect,
    });
    click(container.querySelector('button[aria-label="Inspect Unassigned account on openai"]'));
    // The unassigned identity now maps to a precise missing-connectionId predicate, never an unfiltered scope.
    expect(onGroupSelect).not.toHaveBeenCalled();
    expect(groupFilters(onInspect.mock.calls[0][0].group, 'account')).toEqual({
      provider: 'openai',
      missing: 'connectionId',
    });
    expect(onInspect).toHaveBeenCalledOnce();
    onGroupSelect.mockClear();
    mount({
      data: { ...data, groups: [{ ...providerA, provider: null, connectionId: null }] },
      groupBy: 'account',
      onGroupSelect,
      onInspect,
    });
    click(
      container.querySelector(
        'button[aria-label="Inspect Unassigned account on unspecified provider"]'
      )
    );
    expect(onGroupSelect).not.toHaveBeenCalled();
  });

  it('groups cohorts into compact pricing cards at the Everyday level and filters by a state chip', () => {
    const onInspect = vi.fn();
    act(() =>
      root.render(
        <MantineProvider env="test">
          <EconomicsLens data={data} advanced={false} onInspect={onInspect} />
        </MantineProvider>
      )
    );
    // Everyday shows cards, never the dense cohort table or the record ledger.
    expect(tableBody('Economics by cohort')).toBeNull();
    expect(tableBody('Recorded requests')).toBeNull();
    const cards = [...container.querySelectorAll('article')];
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Partly priced');
    expect(cards[0].textContent).toContain('$9.00');
    expect(container.querySelector('[aria-label="Density"]')).not.toBeNull();
    click(container.querySelector('button[aria-label="Inspect anthropic on anthropic"]'));
    expect(onInspect).toHaveBeenCalledWith({
      kind: 'economics-group',
      group: providerB,
      groupBy: 'provider',
    });
    // Every cohort here is partly priced, so the priced chip is absent and the
    // partly-priced chip keeps both.
    const chips = [...container.querySelectorAll('[aria-label="Cohort summary"] button')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['2 cohorts', '2 partly priced']);
    click(chips[1]);
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('article')).toHaveLength(2);
  });

  it('renders load, error and empty states without stale economics', () => {
    mount({ loading: true });
    expect(container.querySelector('[role="status"]').textContent).toContain(
      'Loading recorded economics'
    );
    expect(tableBody('Economics by cohort')).toBeNull();
    mount({ error: new Error('offline') });
    expect(container.querySelector('[role="alert"]').textContent).toContain('could not be loaded');
    mount({
      data: {
        ...data,
        groups: [],
        items: [],
        summary: { ...quantities, records: 0, recordedCostUsd: null },
      },
    });
    expect(container.textContent).toContain('No economics records match this scope');
    expect(tableBody('Economics by cohort')).toBeNull();
  });

  it('retains unknown and inconsistent record data without inventing cache savings or a context join', () => {
    const record = {
      ...recordA,
      cacheWriteTokens: null,
      uncachedInputTokens: null,
      missingTokenDetail: 1,
    };
    act(() =>
      root.render(
        <MantineProvider env="test">
          <EconomicsDetail selection={{ kind: 'economics-record', record }} />
        </MantineProvider>
      )
    );
    expect(container.textContent).toContain('Unknown');
    expect(container.textContent).toContain('quantities do not reconcile');
    expect(container.textContent).toContain('zero does not establish free usage');
    expect(container.textContent).toContain('not linked by timestamp');
    expect(container.textContent).toContain('1,700');
  });

  it.each(['error','pending','aborted','cancelled',null])('keeps %s model evidence as an attempted identity', status => {
    act(()=>root.render(<MantineProvider env="test"><EconomicsDetail selection={{kind:'economics-record',record:{...recordA,status,requestedModel:'requested-route'}}}/></MantineProvider>));
    expect(container.textContent).toContain('Requested · requested-route');
    expect(container.textContent).toContain('Recorded attempt · openai / shared-model');
    expect(container.textContent).not.toContain('Served ·');
    click(byButton('Exact links'));
    expect(container.textContent).toContain('Recorded attempt provider / model');
    expect(container.textContent).not.toContain('Served provider / model');
  });

  it('shows an aggregate with no usable input samples as unknown even when its empty sum is zero', () => {
    mount({ data: { ...data, groups: [{ ...providerA, inputTokens: 0, inputSamples: 0 }] } });
    click(byButton('Show token columns'));
    const values = [...tableBody('Economics by cohort').querySelectorAll('td')];
    const headers = [...container.querySelectorAll('table[aria-label="Economics by cohort"] thead th')];
    const inputColumn = headers.findIndex(header => header.textContent.startsWith('InputCache inclusive'));
    expect(inputColumn).toBeGreaterThan(-1);
    expect(values[inputColumn].textContent).toBe('Unknown');
  });

  it('labels persisted pending status and avoids an inverted page range when the result page is empty', () => {
    mount({ data: { ...data, items: [{ ...recordA, status: 'pending' }] } });
    expect(tableBody('Recorded requests').textContent).toContain('Recorded pending');
    mount({ data: { ...data, items: [], pagination: { ...data.pagination, page: 100 } } });
    expect(container.textContent).toContain('0–0 of 30 records');
  });
});

describe('Economics numerical and identity boundaries', () => {
  it('keeps shared model names distinct across providers', () => {
    expect(groupKey(providerA, 'model')).not.toBe(groupKey(providerB, 'model'));
    expect(groupFilters(providerA, 'model')).toEqual({ provider: 'openai', model: 'shared-model' });
    expect(groupFilters({ ...providerA, connectionId: null }, 'account')).toEqual({
      provider: 'openai',
      missing: 'connectionId',
    });
    expect(
      groupFilters({ ...providerA, provider: null, connectionId: null }, 'account')
    ).toBeNull();
  });
  it('uses persisted account names and a compact historical account fallback', () => {
    expect(
      groupName(providerA, 'account', [{ id: 'configured-1', name: 'Research account' }])
    ).toBe('Research account');
    expect(groupName(providerB, 'account')).toBe('Historical account historic');
  });
  it('does not coerce missing or unsupported numeric quantities into zero', () => {
    expect(formatEstimate(null)).toBe('Unknown');
    expect(formatEstimate(Infinity)).toBe('Unknown');
    expect(formatEstimate(0.0000001)).toBe('<$0.0001');
    expect(costShare(providerA, { recordedCostUsd: 0 })).toBeNull();
    expect(
      averageTokens({ cacheReadTokens: null, cacheReadSamples: 0 }, TOKEN_COLUMNS[2])
    ).toBeNull();
    expect(averageTokens({ cacheReadTokens: 100, cacheReadSamples: 2 }, TOKEN_COLUMNS[2])).toBe(50);
  });
  it('warns separately about missing detail and invalid quantities', () => {
    const notes = qualityNotes({ ...quantities, missingTokenDetailRows: 2, invalidTokenRows: 1 });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('2 records lack');
    expect(notes[1]).toContain('remain unknown');
  });
});
