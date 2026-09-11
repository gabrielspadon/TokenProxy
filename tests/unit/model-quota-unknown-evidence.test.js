import { describe, expect, it } from 'vitest';
import { getExhaustedQuotaWindow, getActiveModelFailure, isModelLockActive } from 'open-sse/services/accountFallback.js';
import { accountAdmissionReason } from '@/sse/services/accountAdmissionPolicy.js';

const now = Date.parse('2026-09-06T16:00:00.000Z');
const model = 'gemini-pro';
const until = new Date(now + 3600000).toISOString();
const account = value => ({ id: 'model-quota', provider: 'antigravity', lastQuotaSnapshot: {
  windows: [{ key: model, remainingPercentage: value, resetAt: until }],
} });
describe('model-keyed quota evidence', () => {
  it.each([null, undefined, '', '   ', false, true, NaN, Infinity, -Infinity, 'NaN', 'Infinity', 'unknown', [], [0], {}])('keeps unknown %j out of model exhaustion gates', value => {
    const connection = account(value);
    expect(getExhaustedQuotaWindow(connection, model, now)).toBeNull();
    expect(getActiveModelFailure(connection, model, now)).toBeNull();
    expect(isModelLockActive(connection, model, now)).toBe(false);
    expect(accountAdmissionReason(connection, { model, now })).toBeNull();
  });
  it.each([0, '0', '0.0', ' 0 '])('retains measured zero %j as a model-specific exhaustion gate', value => {
    const connection = account(value);
    expect(getExhaustedQuotaWindow(connection, model, now)).toEqual({ key: model, until });
    expect(getActiveModelFailure(connection, model, now)).toMatchObject({ status: 429, until });
    expect(accountAdmissionReason(connection, { model, now })).toBe('quota-exhausted');
    expect(getExhaustedQuotaWindow(connection, 'another-model', now)).toBeNull();
  });
  it('recovers at the stated reset and does not create a hard gate for unlimited or non-model-keyed providers', () => {
    expect(getExhaustedQuotaWindow(account(0), model, Date.parse(until))).toBeNull();
    const unlimited = account(0); unlimited.lastQuotaSnapshot.windows[0].unlimited = true;
    expect(getExhaustedQuotaWindow(unlimited, model, now)).toBeNull();
    expect(getExhaustedQuotaWindow({ ...account(0), provider: 'claude' }, model, now)).toBeNull();
    expect(getExhaustedQuotaWindow(account(1), model, now)).toBeNull();
  });
});
