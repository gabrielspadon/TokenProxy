import { describe, expect, it, vi } from 'vitest';
import { accountControlState, accountLimitsPatch, accountWindows, accountWindowTime, mergeAccountControls, saveAccountControls } from '@/app/dashboard/accountControlPanelModel';
import { captureAccountControls } from '@/shared/utils/accountControls';

const now = Date.parse('2026-09-07T20:00:00Z');
const account = { id: 'one', provider: 'codex', authType: 'oauth', isActive: true, priority: 1, quotaPauseThresholds: { weekly: 10 } };
describe('account panel quota evidence', () => {
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
describe('account panel persistence', () => {
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
