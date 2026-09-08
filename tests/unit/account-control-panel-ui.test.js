// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ connections: [], refresh: vi.fn() }));
vi.mock('@/shared/workspace/useResource', () => ({ useResource: () => ({ data: { connections: state.connections }, loading: false, receivedAt: '2026-09-07T19:00:00Z', refresh: state.refresh }) }));
import { AccountControlPanel } from '@/app/dashboard/AccountControlPanel';
import { captureAccountControls } from '@/shared/utils/accountControls';
let root, container, request;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear(); state.refresh.mockClear();
  state.connections = [{ id: 'account-a', name: 'Account A', provider: 'codex', authType: 'oauth', isActive: true, priority: 1, quotaPauseThresholds: { weekly: 10 }, lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:00:00Z', windows: [{ key: 'weekly', remainingPercentage: 25, resetAt: '2026-09-09T00:00:00Z' }] } }];
  request = vi.fn(async (_url, options) => ({ ok: true, status: 200, json: async () => ({ connection: options?.method === 'PUT' ? { ...state.connections[0], ...JSON.parse(options.body) } : state.connections[0] }) }));
  vi.stubGlobal('fetch', request); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(props = {}) { await act(async () => root.render(<MantineProvider env="test"><AccountControlPanel rows={[]} onSelect={vi.fn()} {...props} /></MantineProvider>)); }
const button = text => [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent) === text);
async function click(text) { await act(async () => button(text).click()); }
async function fill(input, value) {
  if (input.closest('[hidden]')) await act(async () => container.querySelector('[value="advanced"]').click());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function selectStatus(value) {
  await act(async () => { const input = container.querySelector('[aria-label="Account status"]'); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); });
}
const accountCard = (id = 'account-a') => container.querySelector(`[data-account-id="${id}"]`);
const field = (label, id) => accountCard(id).querySelector(`[aria-label="${label}"]`);

it('shows snapshot-only quota windows with a real percentage and reverses the scale for used', async () => {
  await render();
  expect(container.querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('25');
  const used = [...container.querySelectorAll('input')].find(input => input.value === 'used');
  await act(async () => used.click());
  expect(container.querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('75');
  expect(container.textContent).toContain('Pause ≤ 10% left');
  expect(container.querySelector('[role="meter"]').parentElement.textContent).toContain('Pause ≤ 10% left');
  expect(container.querySelector('details')).toBeNull();
  expect(field('Fallback priority').closest('[hidden]')).not.toBeNull();
  await act(async () => container.querySelector('[value="advanced"]').click());
  expect(field('Fallback priority').closest('[hidden]')).toBeNull();
  expect(container.textContent).toContain('2026-09-09 00:00:00 UTC');
});
it('uses Rows only for layout and preserves exact Unicode inspection identities', async () => {
  const onSelect = vi.fn(), onCompare = vi.fn();
  state.connections[0] = { ...state.connections[0], id: 'ação / 東京', name: 'João 東京', lastQuotaSnapshot: { windows: [{ key: 'sessão / 5時間', remainingPercentage: null }, { key: 'ilimitado', unlimited: true, remainingPercentage: 0 }] } };
  await render({ onSelect, onCompare });
  expect(container.querySelector('select[aria-label="Account status"]')).not.toBeNull();
  expect(container.querySelector('[value="compare"]')).toBeNull();
  await act(async () => container.querySelector('[value="rows"]').click());
  expect(onCompare).not.toHaveBeenCalled();
  await click('sessão / 5時間');
  expect(onSelect).toHaveBeenLastCalledWith('ação / 東京', 'sessão / 5時間');
  await click('Details');
  expect(onSelect).toHaveBeenLastCalledWith('ação / 東京');
  expect(container.textContent).toContain('Unknown');
  expect(container.textContent).toContain('Unlimited');
  expect(container.querySelector('[role="meter"]')).toBeNull();
  const decorativeMeters = [...container.querySelectorAll('[data-unknown="true"]')];
  expect(decorativeMeters).toHaveLength(3);
  for (const meter of decorativeMeters) {
    expect(meter.getAttribute('aria-hidden')).toBe('true');
    expect(meter.hasAttribute('aria-label')).toBe(false);
    expect(meter.hasAttribute('aria-valuenow')).toBe(false);
  }
});
it('labels derived healthy status without claiming an imported account passed a probe', async () => {
  state.connections[0] = { ...state.connections[0], status: 'healthy', testStatus: 'active' };
  await render();
  expect(container.textContent).toContain('Recorded status healthy');
  expect(container.textContent).toContain('Health observation time unknown.');
  expect(container.textContent).not.toContain('health passed');
});
it('shares comparison selection across filters and enforces four without losing hidden selections', async () => {
  state.connections = Array.from({ length: 5 }, (_, index) => ({ ...state.connections[0], id: `account-${index}`, name: `Account ${index}`, isActive: index !== 0 }));
  const onCompare = vi.fn(), changed = vi.fn();
  function SharedSelection() {
    const [ids, setIds] = useState([]);
    return <AccountControlPanel comparisonIds={ids} onComparisonChange={next => { changed(next); setIds(next); }} onCompare={onCompare} />;
  }
  await act(async () => root.render(<MantineProvider env="test"><SharedSelection /></MantineProvider>));
  expect(button('Compare selected (0)').disabled).toBe(true);
  for (let index = 0; index < 4; index++) {
    await act(async () => container.querySelector(`[aria-label="Compare Account ${index}"]`).closest('label').click());
    expect(changed).toHaveBeenCalledTimes(index + 1);
  }
  expect(changed).toHaveBeenLastCalledWith(['account-0', 'account-1', 'account-2', 'account-3']);
  expect(container.querySelector('[aria-label="Compare Account 4"]').disabled).toBe(true);
  await act(async () => container.querySelector('[aria-label="Compare Account 4"]').closest('label').click());
  expect(changed).toHaveBeenCalledTimes(4);
  await selectStatus('Enabled');
  expect(container.querySelector('[data-account-id="account-0"]')).toBeNull();
  expect(container.textContent).toContain('4 of 4 selected, 1 outside this view');
  await click('Compare selected (4)');
  expect(onCompare).toHaveBeenCalledOnce();
  await selectStatus('all');
  expect(container.querySelector('[aria-label="Compare Account 0"]').checked).toBe(true);
  await act(async () => container.querySelector('[aria-label="Compare Account 1"]').click());
  expect(container.querySelector('[aria-label="Compare Account 4"]').disabled).toBe(false);
  await click('Clear selection');
  expect(changed).toHaveBeenLastCalledWith([]);
});
it('does not reorder live headroom on clock ticks, and refresh explicitly reevaluates age', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T20:00:00Z'));
  state.connections = [{ ...state.connections[0], id: 'z-low', name: 'Z low', lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:46:00Z', windows: [{ key: 'weekly', remainingPercentage: 1 }] } }, { ...state.connections[0], id: 'a-high', name: 'A high', lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:59:00Z', windows: [{ key: 'weekly', remainingPercentage: 50 }] } }];
  await render();
  const sort = container.querySelector('[aria-label="Sort accounts"]');
  await act(async () => { sort.value = 'headroom'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  const order = () => [...container.querySelectorAll('[data-account-id]')].map(node => node.dataset.accountId);
  expect(order()).toEqual(['z-low', 'a-high']);
  await act(async () => vi.advanceTimersByTime(120000));
  expect(order()).toEqual(['z-low', 'a-high']);
  await click('Refresh');
  expect(order()).toEqual(['a-high', 'z-low']);
});
it.each(['providers', 'rows'])('uses local receipt time for new %s observations without trusting future timestamps', async source => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T20:00:00Z'));
  const observed = (id, name, remainingPercentage, fetchedAt) => ({ id, connectionId: id, name, displayName: name, isActive: true, provider: 'codex', lastQuotaSnapshot: { fetchedAt, windows: [{ key: 'weekly', remainingPercentage }] } });
  let records = [observed('a-high', 'A high', 80, '2026-09-07T19:59:00Z'), observed('z-low', 'Z low', 90, '2026-09-07T19:59:00Z')];
  const show = async (lock = {}) => {
    state.connections = source === 'providers' ? records : [];
    await render({ ...lock, rows: source === 'rows' ? records : [] });
  };
  await show();
  const sort = container.querySelector('[aria-label="Sort accounts"]');
  await act(async () => { sort.value = 'headroom'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  const order = () => [...container.querySelectorAll('[data-account-id]')].map(node => node.dataset.accountId);
  expect(order()).toEqual(['a-high', 'z-low']);
  vi.setSystemTime(new Date('2026-09-07T20:00:30Z'));
  records = [observed('a-high', 'A high', 80, '2026-09-07T20:00:20Z'), observed('z-low', 'Z low', 5, '2026-09-07T20:00:20Z'), observed('future', 'A future', 1, '2026-09-07T20:01:00Z')];
  await show();
  expect(order()).toEqual(['z-low', 'a-high', 'future']);
  expect(container.querySelector('[data-account-id="z-low"]').textContent).not.toContain('ahead of clock');
  expect(container.querySelector('[data-account-id="future"]').textContent).toContain('ahead of clock');
  await show({ comparisonIds: ['z-low'] });
  vi.setSystemTime(new Date('2026-09-07T20:00:50Z'));
  records = records.map(record => record.id === 'future' ? record : observed(record.id, record.name, record.id === 'a-high' ? 3 : 85, '2026-09-07T20:00:45Z'));
  await show({ comparisonIds: ['z-low'] });
  expect(order()).toEqual(['z-low', 'a-high', 'future']);
  await click('Refresh');
  expect(order()).toEqual(['a-high', 'z-low', 'future']);
});
it('uses a historical anchor established after mounting instead of the initial local clock', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T20:00:00Z'));
  state.connections = [{ ...state.connections[0], id: 'z-low', name: 'Z low', lastQuotaSnapshot: { fetchedAt: '2026-09-07T18:59:00Z', windows: [{ key: 'weekly', remainingPercentage: 5 }] } }, { ...state.connections[0], id: 'a-high', name: 'A high', lastQuotaSnapshot: { fetchedAt: '2026-09-07T18:59:00Z', windows: [{ key: 'weekly', remainingPercentage: 80 }] } }];
  await render();
  const sort = container.querySelector('[aria-label="Sort accounts"]');
  await act(async () => { sort.value = 'headroom'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  const order = () => [...container.querySelectorAll('[data-account-id]')].map(node => node.dataset.accountId);
  expect(order()).toEqual(['a-high', 'z-low']);
  await render({ anchor: Date.parse('2026-09-07T19:00:00Z') });
  expect(order()).toEqual(['z-low', 'a-high']);
});
it.each([{ selectedAccountId: 'z-low' }, { comparisonIds: ['z-low'] }])('retains selected account order through updated quota observations for %j', async lock => {
  const anchor = Date.parse('2026-09-07T20:00:00Z');
  state.connections = [{ ...state.connections[0], id: 'z-low', name: 'Z low', lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:59:00Z', windows: [{ key: 'weekly', remainingPercentage: 1 }] } }, { ...state.connections[0], id: 'a-high', name: 'A high', lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:59:00Z', windows: [{ key: 'weekly', remainingPercentage: 50 }] } }];
  await render({ anchor });
  const sort = container.querySelector('[aria-label="Sort accounts"]');
  await act(async () => { sort.value = 'headroom'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  await render({ ...lock, anchor });
  const order = () => [...container.querySelectorAll('[data-account-id]')].map(node => node.dataset.accountId);
  expect(order()).toEqual(['z-low', 'a-high']);
  state.connections = state.connections.map((connection, index) => ({ ...connection, lastQuotaSnapshot: { fetchedAt: '2026-09-07T20:00:00Z', windows: [{ key: 'weekly', remainingPercentage: index ? 2 : 90 }] } }));
  await render({ ...lock, anchor });
  expect(order()).toEqual(['z-low', 'a-high']);
  expect(container.querySelector('[data-account-id="z-low"] [role="meter"]').getAttribute('aria-valuenow')).toBe('90');
  await click('Refresh');
  expect(order()).toEqual(['a-high', 'z-low']);
});
it('reads fresh policy before pausing and retains the old state when verification fails', async () => {
  await render(); await click('Pause');
  expect(request.mock.calls.map(([, options]) => options.method || 'GET')).toEqual(['GET', 'PUT', 'GET']);
  expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ isActive: false, expectedControls: { isActive: true, priority: 1, quotaPauseThresholds: { weekly: 10 } } });
  expect(container.textContent).toContain('could not be verified');
  expect(button('Pause').disabled).toBe(true);
  expect(button('Read current settings')).not.toBeUndefined();
});
it('preserves an inline draft on conflict, requiring a new read before another save', async () => {
  await render();
  await fill(field('Auto-pause threshold for weekly'), 30);
  expect(button('Save changes')).not.toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(request).not.toHaveBeenCalled();
  request.mockImplementation(async (_url, options) => options?.method === 'PUT' ? { ok: false, status: 409, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ connection: state.connections[0] }) });
  await click('Save changes');
  expect(accountCard().textContent).toContain('Your draft is retained');
  expect(field('Auto-pause threshold for weekly').value).toBe('30%');
  expect(button('Save changes').disabled).toBe(true);
  expect(request.mock.calls.filter(([, options]) => options.method === 'PUT')).toHaveLength(1);
  state.connections[0] = { ...state.connections[0], priority: 4, quotaPauseThresholds: { weekly: 20, monthly: 15 } };
  await click('Read current settings');
  expect(field('Auto-pause threshold for weekly').value).toBe('30%');
  expect(field('Fallback priority').value).toBe('4');
  expect(field('Auto-pause threshold for monthly').value).toBe('15%');
  expect(button('Save changes').disabled).toBe(false);
});
it('verifies an inline save with the original expected policy and a separate readback', async () => {
  const before = structuredClone(state.connections[0]);
  let current = structuredClone(before);
  request.mockImplementation(async (_url, options) => {
    if (options?.method === 'PUT') current = { ...current, ...JSON.parse(options.body), quotaPauseThresholds: {} };
    return { ok: true, status: 200, json: async () => ({ connection: current }) };
  });
  await render();
  await fill(field('Fallback priority'), 3);
  await fill(field('Auto-pause threshold for weekly'), 0);
  expect(request).not.toHaveBeenCalled();
  await click('Save changes');
  expect(request.mock.calls.map(([, options]) => options.method || 'GET')).toEqual(['PUT', 'GET']);
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ priority: 3, quotaPauseThresholds: { weekly: 0 }, expectedControls: captureAccountControls(before) });
  expect(accountCard().textContent).toContain('saved and verified');
  expect(button('Save changes')).toBeUndefined();
  expect(field('Fallback priority').value).toBe('3');
  expect(accountCard().querySelector('form').contains(document.activeElement)).toBe(true);
});
it('retains independent drafts across filters and refresh without silently rebasing stale controls', async () => {
  state.connections.push({ ...state.connections[0], id: 'account-b', name: 'Account B', isActive: false });
  await render();
  await fill(field('Fallback priority'), 3);
  await fill(field('Auto-pause threshold for weekly', 'account-b'), 30);
  await fill(container.querySelector('[aria-label="Search accounts"]'), 'Account B');
  expect(accountCard()).toBeNull();
  expect(container.textContent).toContain('Some drafts are outside this view');
  await fill(container.querySelector('[aria-label="Search accounts"]'), '');
  await selectStatus('Enabled');
  expect(accountCard('account-b')).toBeNull();
  await selectStatus('all');
  state.connections = state.connections.map(connection => ({ ...connection, priority: 5 }));
  await click('Refresh');
  await render();
  expect(field('Fallback priority').value).toBe('3');
  expect(field('Auto-pause threshold for weekly', 'account-b').value).toBe('30%');
  expect(accountCard().textContent).toContain('Stored settings changed');
  expect([...accountCard().querySelectorAll('button')].find(node => node.textContent === 'Save changes').disabled).toBe(true);
  await act(async () => [...accountCard().querySelectorAll('button')].find(node => node.textContent === 'Discard').click());
  expect(field('Fallback priority').value).toBe('5');
  expect(accountCard('account-b').textContent).toContain('Save changes');
  expect(request).not.toHaveBeenCalled();
});
it('holds order while an unselected account has a draft and quota observations change', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T20:00:00Z'));
  state.connections = [{ ...state.connections[0], id: 'z-low', name: 'Z low', lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:59:00Z', windows: [{ key: 'weekly', remainingPercentage: 5 }] } }, { ...state.connections[0], id: 'a-high', name: 'A high', lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:59:00Z', windows: [{ key: 'weekly', remainingPercentage: 80 }] } }];
  await render();
  const sort = container.querySelector('[aria-label="Sort accounts"]');
  await act(async () => { sort.value = 'headroom'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  await fill(field('Fallback priority', 'z-low'), 3);
  state.connections = state.connections.map((connection, index) => ({ ...connection, lastQuotaSnapshot: { fetchedAt: '2026-09-07T20:00:00Z', windows: [{ key: 'weekly', remainingPercentage: index ? 1 : 90 }] } }));
  await render();
  expect([...container.querySelectorAll('[data-account-id]')].map(node => node.dataset.accountId)).toEqual(['z-low', 'a-high']);
  expect(field('Fallback priority', 'z-low').value).toBe('3');
});
it('requires a complete persisted baseline before editing a health-only account', async () => {
  const current = structuredClone(state.connections[0]);
  state.connections = [];
  request.mockResolvedValue({ ok: true, status: 200, json: async () => ({ connection: current }) });
  await render({ rows: [{ connectionId: current.id, displayName: 'Account A', isActive: true }] });
  expect(field('Fallback priority').disabled).toBe(true);
  await click('Read current settings');
  expect(request).toHaveBeenCalledOnce();
  expect(field('Fallback priority').disabled).toBe(false);
  await fill(field('Fallback priority'), 2);
  expect(button('Save changes').disabled).toBe(false);
  expect(request).toHaveBeenCalledOnce();
});
it('persists hidden accounts without changing routing settings', async () => {
  await render(); await click('Customize');
  const label = [...document.querySelectorAll('label')].find(node => node.textContent === 'Show Account A');
  await act(async () => document.getElementById(label.htmlFor).click());
  expect(container.querySelector('[data-account-id="account-a"]')).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('tokenproxy.account-control-panel')).hiddenAccounts).toEqual(['account-a']);
});
it('recovers malformed persisted visibility preferences before updating them', async () => {
  localStorage.setItem('tokenproxy.account-control-panel', JSON.stringify({ hiddenAccounts: 'broken', hiddenWindows: {}, density: 'compact' }));
  await render(); await click('Customize');
  for (const text of ['Show Account A', 'weekly']) {
    const label = [...document.querySelectorAll('label')].find(node => (node.getAttribute('aria-label') || node.textContent) === text);
    await act(async () => document.getElementById(label.htmlFor).click());
  }
  const saved = JSON.parse(localStorage.getItem('tokenproxy.account-control-panel'));
  expect(saved.hiddenAccounts).toEqual(['account-a']);
  expect(saved.hiddenWindows).toEqual([JSON.stringify(['account-a', 'weekly'])]);
  expect(request).not.toHaveBeenCalled();
});

it('retains a priority draft while switching the whole panel back to everyday controls', async () => {
  await render();
  expect(field('Fallback priority').closest('[hidden]')).not.toBeNull();
  expect(field('Auto-pause threshold for weekly').closest('[hidden]')).toBeNull();
  expect(button('Pause')).not.toBeUndefined();
  await act(async () => container.querySelector('[value="advanced"]').click());
  await fill(field('Fallback priority'), 4);
  await act(async () => container.querySelector('[value="everyday"]').click());
  expect(field('Fallback priority').closest('[hidden]')).not.toBeNull();
  expect(container.textContent).toContain('1 unsaved account draft');
  await act(async () => container.querySelector('[value="advanced"]').click());
  expect(field('Fallback priority').value).toBe('4');
  expect(request).not.toHaveBeenCalled();
});

it('stages a reserve slider change without applying it before Save changes', async () => {
  await render();
  const slider = accountCard().querySelector('input[type="range"]');
  await fill(slider, 20);
  expect(field('Auto-pause threshold for weekly').value).toBe('20%');
  expect(button('Save changes').disabled).toBe(false);
  expect(request).not.toHaveBeenCalled();
  await click('Discard');
  expect(field('Auto-pause threshold for weekly').value).toBe('10%');
  expect(document.activeElement).toBe(field('Auto-pause threshold for weekly'));
});
