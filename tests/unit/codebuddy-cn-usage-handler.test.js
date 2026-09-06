// CodeBuddy CN usage handler: refill vs bonus pack classification, cadence
// labels, credential/error paths. proxyAwareFetch mocked, zero real HTTP.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from 'open-sse/utils/proxyFetch.js';
import {
  getCodeBuddyCnUsage,
  getCodeBuddyIntlUsage,
} from 'open-sse/services/usage/codebuddy-cn.js';
import { U } from 'open-sse/services/usage/shared.js';

const DAY = 86400000;
const now = Date.now();

function wrap(accounts) {
  return { code: 0, data: { Response: { Data: { Accounts: accounts } } } };
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// Refill pack: DeductionEndTime far past CycleEndTime (>2d gap).
function refillAcc(cycleDays, overrides = {}) {
  const cycleEnd = now + 5 * DAY;
  return {
    PackageName: '基础体验包',
    CycleStartTime: cycleEnd - cycleDays * DAY,
    CycleEndTime: cycleEnd,
    DeductionEndTime: cycleEnd + 30 * DAY,
    CycleCapacityUsed: 6.5,
    CycleCapacitySize: 500,
    ...overrides,
  };
}

// Bonus pack: cycle end == deduction end.
function bonusAcc(endOffsetDays, overrides = {}) {
  const end = now + endOffsetDays * DAY;
  return {
    PackageName: '活动赠送包',
    CycleStartTime: now - DAY,
    CycleEndTime: end,
    DeductionEndTime: end,
    CapacityUsed: 12,
    CapacitySize: 100,
    ...overrides,
  };
}

beforeEach(() => vi.mocked(proxyAwareFetch).mockReset());

describe('getCodeBuddyCnUsage', () => {
  it('returns a message when no credential is available', async () => {
    const out = await getCodeBuddyCnUsage(null, null, null);
    expect(out.message).toMatch(/credential not available/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it('POSTs the registry usage URL with a bearer token', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([refillAcc(30)])));
    await getCodeBuddyCnUsage('tok', null, null);
    const [url, opts] = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(url).toBe(U('codebuddy-cn').url);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  it('falls back to apiKey when accessToken is missing', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([refillAcc(30)])));
    await getCodeBuddyCnUsage(null, 'key-only', null);
    const [, opts] = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer key-only');
  });

  it.each([401, 403])('maps %i to an invalid-credential message', async (status) => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(new Response('', { status }));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.message).toMatch(/invalid or expired/);
  });

  it('maps other non-ok statuses to an API error message with the status', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(new Response('', { status: 502 }));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.message).toMatch(/502/);
  });

  it('surfaces a non-zero upstream code with its msg', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes({ code: 7, msg: 'bad thing' }));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.message).toMatch(/bad thing/);
  });

  it('surfaces a non-zero code without msg as unknown', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes({ code: 7 }));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.message).toMatch(/unknown/);
  });

  it('reports no credit package when accounts are empty', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([])));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.message).toMatch(/No credit package/);
  });

  it('labels a ~30d refill pack Monthly with cycle balances and recurring:true', async () => {
    const acc = refillAcc(30, {
      CycleCapacityUsedPrecise: '6.54',
      CycleCapacitySizePrecise: '500',
    });
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([acc])));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.plan).toBe(acc.PackageName);
    expect(out.quotas.Monthly).toMatchObject({
      used: 6.54,
      total: 500,
      recurring: true,
      unlimited: false,
    });
    expect(out.quotas.Monthly.resetAt).toBe(new Date(acc.CycleEndTime).toISOString());
  });

  it('labels a ~7d cycle Weekly and a ~1d cycle Daily', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([refillAcc(7), refillAcc(1)])));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(Object.keys(out.quotas)).toEqual(expect.arrayContaining(['Weekly', 'Daily']));
  });

  it('disambiguates duplicate cadence labels with a counter', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([refillAcc(30), refillAcc(30)])));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.quotas.Monthly).toBeDefined();
    expect(out.quotas['Monthly 2']).toBeDefined();
  });

  it('classifies one-shot packs as bonus, sorted soonest-expiring first, recurring:false', async () => {
    const late = bonusAcc(20, { CapacityUsed: 1 });
    const soon = bonusAcc(3, { CapacityUsedPrecise: '12.5', CapacitySizePrecise: '100' });
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([late, soon])));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.quotas['Bonus Pack 1']).toMatchObject({ used: 12.5, total: 100, recurring: false });
    expect(out.quotas['Bonus Pack 2'].used).toBe(1);
  });

  it('names the plan from the first refill pack when both kinds exist', async () => {
    const refill = refillAcc(30, { PackageName: 'RefillPlan' });
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([bonusAcc(3), refill])));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.plan).toBe('RefillPlan');
  });

  it('falls back to SubProductName then a default plan name', async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(
      jsonRes(wrap([bonusAcc(3, { PackageName: undefined, SubProductName: 'Sub' })]))
    );
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.plan).toBe('Sub');
  });

  it('treats a pack with unparsable cycle end as bonus with null resetAt', async () => {
    const acc = bonusAcc(1, { CycleEndTime: undefined, DeductionEndTime: undefined });
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonRes(wrap([acc])));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.quotas['Bonus Pack 1'].resetAt).toBeNull();
  });

  it('wraps a thrown parse error into a message', async () => {
    // Invalid JSON makes response.json() throw inside the handler's try block.
    vi.mocked(proxyAwareFetch).mockResolvedValue(new Response('not json', { status: 200 }));
    const out = await getCodeBuddyCnUsage('t', null, null);
    expect(out.message).toMatch(/codebuddy-cn.*error/i);
  });
});

describe('getCodeBuddyIntlUsage', () => {
  it('scopes messages to the intl provider id', async () => {
    const out = await getCodeBuddyIntlUsage(null, null, null);
    expect(out.message).toContain('codebuddy-intl');
  });
});
