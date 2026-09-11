import { describe, expect, it, vi } from 'vitest';
import { accountControlBaseline, accountControlEvidence, accountControlState, accountDraftState, accountLimitsPatch, accountWindows, accountWindowStale, accountWindowTime, makeAccountDraft, mergeAccountControls, rebaseAccountDraft, saveAccountControls, sortAccountControls } from '@/app/dashboard/accountControlPanelModel';
import { captureAccountControls } from '@/shared/utils/accountControls';

const now = Date.parse('2026-09-07T20:00:00Z');
const account = { id: 'one', provider: 'codex', authType: 'oauth', isActive: true, priority: 1, quotaPauseThresholds: { weekly: 10 } };
describe('account panel quota evidence', () => {
  it('keeps configured pause, recorded health and simultaneous local gates distinct', () => {
    const evidence = accountControlEvidence({ ...account, isActive: false, status: 'healthy', isDraining: true, quotaPauseThresholds: { 'semanal / 周': 10 }, lastQuotaSnapshot: { windows: [{ key: 'semanal / 周', remainingPercentage: 5 }] } }, now);
    // The switch-off itself is now a gate of its own, and it names WHO did it:
    // the tooltip on a row a 401 had killed used to be silent about the one
    // fact the operator needed. See tests/unit/account-state-taxonomy.test.js.
    expect(evidence).toMatchObject({ health: 'Recorded status healthy', gates: ['Switched off by the operator', 'Quota pause at 5% remaining in semanal / 周 (threshold 10%)', 'Local drain is on'] });
    expect(accountControlEvidence({ ...account, isActive: false, testStatus: 'unavailable', errorCode: 401 }, now).gates).toEqual(['Switched off automatically after a provider failure']);
    expect(accountControlEvidence({ ...account }, now)).toMatchObject({ health: 'Provider health unknown', gates: [] });
    expect(accountControlState({ ...account, status: 'drained' }, now)).toBe('Draining');
  });
  it('marks unknown, future, old and reset-passed observations as stale', () => {
    for (const window of [{}, { observedAt: '2026-09-07T20:01:00Z' }, { observedAt: '2026-09-07T19:00:00Z' }, { observedAt: '2026-09-07T19:59:00Z', resetAt: '2026-09-07T20:00:00Z' }]) expect(accountWindowStale(window, now)).toBe(true);
    expect(accountWindowStale({ observedAt: '2026-09-07T19:45:00Z' }, now)).toBe(false);
  });
  it('distinguishes configured enablement from missing qualification and observed problems', () => {
    expect(accountControlState({ ...account, status: 'unqualified' }, now)).toBe('Not checked');
    expect(accountControlState({ ...account, status: 'degraded' }, now)).toBe('Needs attention');
    expect(accountControlState({ ...account, status: 'unqualified', isActive: false }, now)).toBe('Paused');
  });
  it('unions database scopes, snapshot-only windows and threshold-only keys without invented quota', () => {
    const windows = accountWindows({ windows: [{ scope: 'database-only', percentage: null }], quotaPauseThresholds: { 'threshold-only': 20 }, lastQuotaSnapshot: { fetchedAt: '2026-09-07T19:00:00Z', windows: [{ key: 'snapshot-only', remainingPercentage: 35 }] } });
    expect(windows.map(window => window.key)).toEqual(['database-only', 'snapshot-only', 'threshold-only']);
    expect(windows[0].remaining).toBeNull(); expect(windows[1].remaining).toBe(35); expect(windows[2]).toMatchObject({ remaining: null, threshold: 20 });
  });
  it('retains zero after a stored reset passes and treats unlimited as unconstrained', () => {
    const current = { ...account, lastQuotaSnapshot: { fetchedAt: '2026-09-07T18:00:00Z', windows: [{ key: 'weekly', remainingPercentage: 0, resetAt: '2026-09-07T19:00:00Z' }, { key: 'other', remainingPercentage: 0, unlimited: true }] } };
    expect(accountWindows(current)[0].remaining).toBe(0);
    expect(accountWindowTime(current.lastQuotaSnapshot.windows[0].resetAt, now, true).label).toContain('awaiting update');
    expect(accountWindows(current)[1].unlimited).toBe(true);
    expect(accountControlState(current, now)).toBe('Enabled');
  });
  it('uses the newest comparable observation, and never derives entitlement from a denominator', () => {
    const windows = accountWindows({ windows: [{ scope: 'weekly', limit: 100, remaining: 70, percentage: { value: 40, observedAt: '2026-09-07T19:00:00Z' } }, { scope: 'raw', limit: 100, remaining: 70 }], lastQuotaSnapshot: { fetchedAt: '2026-09-07T18:00:00Z', windows: [{ key: 'weekly', remainingPercentage: 20 }] } });
    expect(windows[0].remaining).toBe(40); expect(windows[1].remaining).toBeNull();
  });
  it('never combines older unlimited state or an undated snapshot with newer dated percentages', () => {
    const projected = [{ scope: 'weekly', percentage: { value: 40, observedAt: '2026-09-07T19:00:00Z' } }];
    const snapshot = { fetchedAt: '2026-09-07T18:00:00Z', windows: [{ key: 'weekly', remainingPercentage: 0, unlimited: true }] };
    expect(accountWindows({ windows: projected, lastQuotaSnapshot: snapshot })[0]).toMatchObject({ remaining: 40, unlimited: false });
    expect(accountWindows({ windows: projected, lastQuotaSnapshot: { ...snapshot, fetchedAt: null } })[0]).toMatchObject({ remaining: 40, unlimited: false, observedAt: '2026-09-07T19:00:00Z' });
  });
  it('keeps configured accounts missing from health and a stable identity order', () => {
    const connections = [{ id: 'z', name: 'Last', isActive: true }, { id: 'a', name: 'First', isActive: false }];
    expect(mergeAccountControls(connections, [{ connectionId: 'z', windows: [{ scope: 'day' }] }]).map(item => item.connectionId)).toEqual(['a', 'z']);
    expect(mergeAccountControls(connections, [])[0].isActive).toBe(false);
  });
  it('requires valid priority and thresholds while preserving explicit zero', () => {
    expect(accountLimitsPatch(1, { weekly: 0, session: 99.5 })).toEqual({ priority: 1, quotaPauseThresholds: { weekly: 0, session: 99.5 } });
    for (const priority of [0, '', 1.5]) expect(accountLimitsPatch(priority, {})).toBeNull();
    for (const threshold of [-1, 101, '', Infinity]) expect(accountLimitsPatch(1, { weekly: threshold })).toBeNull();
  });
});
describe('account panel local ordering', () => {
  const observed = (id, remainingPercentage, resetAt, fetchedAt = '2026-09-07T19:59:00Z', unlimited = false) => ({ id, name: id, lastQuotaSnapshot: { fetchedAt, windows: [{ key: 'weekly', remainingPercentage, resetAt, unlimited }] } });
  it('orders known fresh headroom and reset values before missing, stale or unlimited observations', () => {
    const accounts = [observed('A stale', 0, '2026-09-07T20:01:00Z', '2026-09-07T19:00:00Z'), observed('B unlimited', 0, '2026-09-07T20:01:00Z', undefined, true), { id: 'C missing' }, observed('D less', 5, '2026-09-07T23:00:00Z'), observed('E sooner', 70, '2026-09-07T21:00:00Z')];
    expect(sortAccountControls(accounts, 'headroom', now).map(item => item.id)).toEqual(['D less', 'E sooner', 'A stale', 'B unlimited', 'C missing']);
    expect(sortAccountControls(accounts, 'reset', now).map(item => item.id)).toEqual(['E sooner', 'D less', 'A stale', 'B unlimited', 'C missing']);
    expect(accounts[0].id).toBe('A stale');
  });
  it('uses stable name ties and excludes passed resets without inventing replenishment', () => {
    const accounts = [observed('Z observed', 0, '2026-09-07T21:00:00Z'), observed('A reset passed', 0, '2026-09-07T19:59:00Z'), observed('Y observed', 0, '2026-09-07T21:00:00Z')];
    expect(sortAccountControls(accounts, 'headroom', now).map(item => item.id)).toEqual(['Y observed', 'Z observed', 'A reset passed']);
    expect(sortAccountControls(accounts, 'name', now).map(item => item.id)).toEqual(['A reset passed', 'Y observed', 'Z observed']);
  });
  it('can order an observed reset with unknown percentage without treating it as known headroom', () => {
    const accounts = [observed('A reset only', null, '2026-09-07T20:10:00Z'), observed('Z known headroom', 20, '2026-09-07T21:00:00Z')];
    expect(sortAccountControls(accounts, 'reset', now).map(item => item.id)).toEqual(['A reset only', 'Z known headroom']);
    expect(sortAccountControls(accounts, 'headroom', now).map(item => item.id)).toEqual(['Z known headroom', 'A reset only']);
  });
});
describe('account panel persistence', () => {
  it('accepts only a validated persisted identity and complete policy snapshot', () => {
    expect(accountControlBaseline(account, 'one')).toEqual({ id: 'one', ...captureAccountControls(account) });
    for (const connection of [{ id: 'one' }, { ...account, priority: '1' }, { ...account, quotaPauseThresholds: [] }, { ...account, quotaPauseThresholds: { weekly: '10' } }, { ...account, id: 'other' }]) expect(accountControlBaseline(connection, 'one')).toBeNull();
    expect(accountControlBaseline({ ...account, priority: null, quotaPauseThresholds: null }, 'one')).toMatchObject({ priority: null, quotaPauseThresholds: {} });
  });
  it('saves only changed policy fields and treats new zero thresholds as unchanged', () => {
    const before = accountControlBaseline({ ...account, priority: null }, 'one');
    const draft = makeAccountDraft(before, [{ key: 'weekly' }, { key: 'sessão / 週' }]);
    expect(accountDraftState(draft)).toEqual({ dirty: false, patch: {} });
    const changed = { ...draft, thresholds: { ...draft.thresholds, 'sessão / 週': 20 } };
    expect(accountDraftState(changed)).toEqual({ dirty: true, patch: { quotaPauseThresholds: { weekly: 10, 'sessão / 週': 20 } } });
    expect(accountDraftState({ ...changed, thresholds: { weekly: '' } })).toEqual({ dirty: true, patch: null });
    expect(accountDraftState({ ...draft, priority: 0 })).toEqual({ dirty: true, patch: null });
  });
  it('rebases explicitly edited fields without overwriting new untouched policy', () => {
    const before = accountControlBaseline(account, 'one');
    const draft = { ...makeAccountDraft(before, [{ key: 'weekly' }]), thresholds: { weekly: 30 } };
    const current = accountControlBaseline({ ...account, isActive: false, priority: 4, quotaPauseThresholds: { weekly: 20, monthly: 15 } }, 'one');
    const rebased = rebaseAccountDraft(draft, current, [{ key: 'weekly' }, { key: 'monthly' }]);
    expect(rebased).toMatchObject({ before: current, priority: 4, thresholds: { weekly: 30, monthly: 15 } });
    expect(accountDraftState(rebased).patch).toEqual({ quotaPauseThresholds: { weekly: 30, monthly: 15 } });
    expect(accountDraftState(rebaseAccountDraft(draft, { ...current, quotaPauseThresholds: { weekly: 30, monthly: 15 } }, [])).dirty).toBe(false);
  });
  it('accepts server priority renumbering and removed zero thresholds only after matching readback', async () => {
    const current = { ...account, priority: 2, quotaPauseThresholds: {} };
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connection: current }) });
    expect(await saveAccountControls(account, { priority: 50, quotaPauseThresholds: { weekly: 0 } }, request)).toMatchObject({ confirmed: true, current });
  });
  it('sends the exact control snapshot and verifies a separate readback', async () => {
    const current = { ...account, isActive: false };
    const request = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ connection: current }) }).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ connection: current }) });
    expect(await saveAccountControls(account, { isActive: false }, request)).toMatchObject({ confirmed: true });
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ isActive: false, expectedControls: captureAccountControls(account) });
    expect(request.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
  });
  it('does not repeat a conflict or network failure and never claims an inconsistent readback', async () => {
    const conflict = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    expect(await saveAccountControls(account, { isActive: false }, conflict)).toMatchObject({ confirmed: false, conflict: true }); expect(conflict).toHaveBeenCalledTimes(1);
    const failed = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await saveAccountControls(account, { isActive: false }, failed)).toMatchObject({ confirmed: false, message: expect.stringContaining('outcome unknown') });
    const stale = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connection: account }) });
    expect(await saveAccountControls(account, { isActive: false }, stale)).toMatchObject({ confirmed: false });
  });
});
