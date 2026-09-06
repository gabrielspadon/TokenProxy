// Error and fallback branches in open-sse/services/usage/codex.js the existing
// suites leave dark: non-OK usage fetch, reset-credit guards and consume paths,
// ISO normalization edge shapes, entitlement cache windows, account selection by
// idToken hints, malformed accounts JSON, and the subscriptions fallback.
// All network is mocked at proxyAwareFetch; URLs are read back from the SUT's
// own provider registry config, never hardcoded.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
  installGlobalProxyFetch: vi.fn(),
}));

const { U } = await import('../../open-sse/services/usage/shared.js');
const {
  getCodexUsage,
  getCodexRateLimitResetCredits,
  consumeCodexRateLimitResetCredit,
  getCodexSubscriptionEntitlement,
} = await import('../../open-sse/services/usage/codex.js');

const CFG = U('codex');

function makeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.sig`;
}

beforeEach(() => {
  mocks.proxyAwareFetch.mockReset();
});

describe('getCodexUsage error paths', () => {
  it('non-OK response returns an availability message, not a throw', async () => {
    mocks.proxyAwareFetch.mockResolvedValue({ ok: false, status: 503 });
    const out = await getCodexUsage('tok');
    expect(out.message).toContain('503');
    expect(mocks.proxyAwareFetch.mock.calls[0][0]).toBe(CFG.url);
  });

  it('network failure is wrapped with a Codex-specific error', async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error('ECONNRESET'));
    await expect(getCodexUsage('tok')).rejects.toThrow(/Failed to fetch Codex usage: ECONNRESET/);
  });
});

describe('getCodexRateLimitResetCredits', () => {
  it('rejects without an access token', async () => {
    await expect(getCodexRateLimitResetCredits(null)).rejects.toThrow(/re-authorize/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it('non-OK with unparseable body throws the fallback availability message', async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('bad json');
      },
    });
    await expect(getCodexRateLimitResetCredits('tok')).rejects.toThrow(/unavailable \(500\)/);
  });

  it('non-OK with a structured message surfaces that message', async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ detail: 'slow down' }),
    });
    await expect(getCodexRateLimitResetCredits('tok')).rejects.toThrow('slow down');
  });

  it('forwards the account id header from providerSpecificData', async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        available_count: 2,
        credits: [{ status: 'granted', granted_at: 1700000000 }],
      }),
    });
    const out = await getCodexRateLimitResetCredits('tok', null, { workspaceId: 'ws-1' });
    expect(out.availableCount).toBe(2);
    expect(out.credits[0].grantedAt).toBe(new Date(1700000000 * 1000).toISOString());
    const [, opts] = mocks.proxyAwareFetch.mock.calls[0];
    expect(opts.headers['ChatGPT-Account-ID']).toBe('ws-1');
  });
});

describe('consumeCodexRateLimitResetCredit', () => {
  it('rejects without an access token', async () => {
    await expect(consumeCodexRateLimitResetCredit(null, 'r1')).rejects.toThrow(/re-authorize/);
  });

  it('rejects a missing or non-string redeem request id', async () => {
    await expect(consumeCodexRateLimitResetCredit('tok', null)).rejects.toThrow(
      /redeem request id/
    );
    await expect(consumeCodexRateLimitResetCredit('tok', 42)).rejects.toThrow(/redeem request id/);
  });

  it('succeeds on code=reset and posts the redeem id to the consume URL', async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'reset', windows_reset: 1 }),
    });
    const out = await consumeCodexRateLimitResetCredit('tok', 'req-9');
    expect(out).toMatchObject({ ok: true, noCredit: false, code: 'reset', windowsReset: 1 });
    const [url, opts] = mocks.proxyAwareFetch.mock.calls[0];
    expect(url).toBe(CFG.resetCreditsConsumeUrl);
    expect(JSON.parse(opts.body)).toEqual({ redeem_request_id: 'req-9' });
  });

  it('reports noCredit on code=no_credit without throwing', async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'no_credit' }),
    });
    const out = await consumeCodexRateLimitResetCredit('tok', 'req-9');
    expect(out).toMatchObject({ ok: false, noCredit: true });
  });

  it('wraps a network failure', async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error('timeout'));
    await expect(consumeCodexRateLimitResetCredit('tok', 'r')).rejects.toThrow(
      /Failed to consume Codex reset credit: timeout/
    );
  });
});

describe('getCodexSubscriptionEntitlement cache and normalization', () => {
  it('numeric epoch-seconds JWT claim normalizes to ISO without network', async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 86400;
    const jwt = makeJwt({
      chatgpt_subscription_active_until: futureSec,
      chatgpt_plan_type: ' plus ',
    });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'at',
      idToken: jwt,
      providerSpecificData: {},
    });
    expect(res.subscriptionActiveUntil).toBe(new Date(futureSec * 1000).toISOString());
    expect(res.subscriptionPlan).toBe('plus');
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it('numeric-string claim normalizes; non-finite and object claims are rejected', async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 86400;
    const jwt = makeJwt({ chatgpt_subscription_active_until: String(futureSec) });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: null,
      idToken: jwt,
      providerSpecificData: {},
    });
    expect(res.subscriptionActiveUntil).toBe(new Date(futureSec * 1000).toISOString());

    // Non-finite numeric claim and an object claim both fall off the JWT path;
    // with no token and no cache the result is the null attempt patch.
    for (const claim of [Number.POSITIVE_INFINITY, {}, '   ']) {
      const bad = await getCodexSubscriptionEntitlement({
        accessToken: null,
        idToken: makeJwt({ chatgpt_subscription_active_until: claim }),
        providerSpecificData: {},
      });
      expect(bad.subscriptionActiveUntil).toBeNull();
      expect(bad.patch.codexSubscriptionAttemptAt).toBeTruthy();
    }
  });

  it('malformed JWT payload decodes to null and falls through', async () => {
    const res = await getCodexSubscriptionEntitlement({
      accessToken: null,
      idToken: 'a.%%%not-base64-json%%%.c',
      providerSpecificData: {},
    });
    expect(res.subscriptionActiveUntil).toBeNull();
  });

  it('out-of-range now falls back to a real clock for nowIso', async () => {
    const res = await getCodexSubscriptionEntitlement({
      accessToken: null,
      providerSpecificData: {},
      now: 9e15,
    });
    expect(new Date(res.patch.codexSubscriptionAttemptAt).getTime()).toBeGreaterThan(0);
  });

  it('fresh fetchedAt with a future cached expiry returns the cache without network', async () => {
    const future = new Date(Date.now() + 86400000);
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'at',
      providerSpecificData: {
        codexSubscriptionActiveUntil: future, // Date instance exercises the Date branch
        codexSubscriptionPlan: 'pro',
        codexSubscriptionSource: 'accounts',
        codexSubscriptionFetchedAt: new Date().toISOString(),
      },
    });
    expect(res.subscriptionActiveUntil).toBe(future.toISOString());
    expect(res.subscriptionPlan).toBe('pro');
    expect(res.patch).toEqual({});
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it('fresh fetchedAt, no cache, no token records only the attempt', async () => {
    const res = await getCodexSubscriptionEntitlement({
      accessToken: null,
      providerSpecificData: { codexSubscriptionFetchedAt: new Date().toISOString() },
    });
    expect(res.subscriptionActiveUntil).toBeNull();
    expect(Object.keys(res.patch)).toEqual(['codexSubscriptionAttemptAt']);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it('recent attempt with a future cache returns the cache; without cache and no token records the attempt', async () => {
    const cached = new Date(Date.now() + 3600000).toISOString();
    const base = {
      codexSubscriptionFetchedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      codexSubscriptionAttemptAt: new Date(Date.now() - 60 * 1000).toISOString(),
    };
    const hit = await getCodexSubscriptionEntitlement({
      accessToken: 'at',
      providerSpecificData: {
        ...base,
        codexSubscriptionActiveUntil: cached,
        codexSubscriptionPlan: 'plus',
      },
    });
    expect(hit.subscriptionActiveUntil).toBe(cached);
    expect(hit.patch).toEqual({});

    const miss = await getCodexSubscriptionEntitlement({
      accessToken: null,
      providerSpecificData: { ...base },
    });
    expect(miss.subscriptionActiveUntil).toBeNull();
    expect(Object.keys(miss.patch)).toEqual(['codexSubscriptionAttemptAt']);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it('no token but a stale future cache returns the cache with an attempt patch', async () => {
    const cached = new Date(Date.now() + 3600000).toISOString();
    const res = await getCodexSubscriptionEntitlement({
      accessToken: null,
      providerSpecificData: { codexSubscriptionActiveUntil: cached },
    });
    expect(res.subscriptionActiveUntil).toBe(cached);
    expect(Object.keys(res.patch)).toEqual(['codexSubscriptionAttemptAt']);
  });
});

describe('getCodexSubscriptionEntitlement network path', () => {
  it('selects the account by idToken org hint, honors account_ordering, uses entitlement expiry', async () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    mocks.proxyAwareFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        account_ordering: ['org-b', 'org-a'],
        accounts: {
          'org-a': {
            account: {
              organization_id: 'org-a',
              entitlement: { subscription_plan: 'team', expires_at: future },
            },
          },
          'org-b': {
            account: { organization_id: 'org-b', entitlement: { subscription_plan: 'free' } },
          },
          stray: { account: { name: 'no matching ordering key' } },
        },
      }),
    });
    const jwt = makeJwt({ 'https://api.openai.com/auth': { organization_id: 'org-a' } });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'opaque-token',
      idToken: jwt,
      providerSpecificData: {},
      force: true,
    });
    expect(res.subscriptionActiveUntil).toBe(future);
    expect(res.subscriptionPlan).toBe('team');
    expect(res.subscriptionSource).toBe('accounts');
    expect(res.patch.codexSubscriptionFetchedAt).toBeTruthy();
    expect(mocks.proxyAwareFetch.mock.calls[0][0]).toContain(CFG.accountsCheckUrl);
  });

  it('selects by idToken account id when no org hint matches', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    mocks.proxyAwareFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accounts: [{ id: 'acct-7', plan_type: 'plus', expires_at: future }] }),
    });
    const jwt = makeJwt({ chatgpt_account_id: 'acct-7' });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'opaque',
      idToken: jwt,
      providerSpecificData: {},
      force: true,
    });
    expect(res.subscriptionPlan).toBe('plus');
    expect(res.subscriptionActiveUntil).toBe(future);
  });

  it('malformed accounts JSON falls back to the cached snapshot', async () => {
    const cached = new Date(Date.now() + 3600000).toISOString();
    mocks.proxyAwareFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('bad');
      },
    });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'opaque',
      providerSpecificData: { codexSubscriptionActiveUntil: cached, codexSubscriptionPlan: 'plus' },
      force: true,
    });
    expect(res.subscriptionActiveUntil).toBe(cached);
    expect(Object.keys(res.patch)).toEqual(['codexSubscriptionAttemptAt']);
  });

  it('empty accounts list yields the null attempt result', async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'opaque',
      providerSpecificData: {},
      force: true,
    });
    expect(res.subscriptionActiveUntil).toBeNull();
    expect(Object.keys(res.patch)).toEqual(['codexSubscriptionAttemptAt']);
  });

  it('expired accounts snapshot triggers the subscriptions fallback (array shape)', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    mocks.proxyAwareFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accounts: [{ id: 'acct-1', plan_type: 'plus', expires_at: past }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ plan_type: 'pro', active_until: future }],
      });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'opaque',
      providerSpecificData: {},
      force: true,
    });
    expect(res.subscriptionActiveUntil).toBe(future);
    expect(res.subscriptionPlan).toBe('pro');
    expect(res.subscriptionSource).toBe('subscriptions');
    expect(mocks.proxyAwareFetch.mock.calls[1][0]).toContain(CFG.subscriptionsUrl);
  });

  it('subscriptions fallback unwraps { data: [...] } and { subscriptions: [...] }', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    for (const wrap of [
      { data: [{ plan: 'pro', expires_at: future }] },
      { subscriptions: [{ plan: 'pro', expires_at: future }] },
    ]) {
      mocks.proxyAwareFetch.mockReset();
      mocks.proxyAwareFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ accounts: [{ id: 'a', expires_at: past }] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => wrap });
      const res = await getCodexSubscriptionEntitlement({
        accessToken: 'opaque',
        providerSpecificData: {},
        force: true,
      });
      expect(res.subscriptionActiveUntil).toBe(future);
      expect(res.subscriptionSource).toBe('subscriptions');
    }
  });

  it('failed subscriptions fallback with only an expired snapshot returns the null attempt result', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    mocks.proxyAwareFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accounts: [{ id: 'a', expires_at: past }] }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    const res = await getCodexSubscriptionEntitlement({
      accessToken: 'opaque',
      providerSpecificData: {},
      force: true,
    });
    expect(res.subscriptionActiveUntil).toBeNull();
    expect(Object.keys(res.patch)).toEqual(['codexSubscriptionAttemptAt']);
  });
});
