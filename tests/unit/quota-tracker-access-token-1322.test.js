/**
 * #1322 — the Quota Tracker says "No Providers Connected" on an install that
 * has providers connected.
 *
 * That empty state is `totals.eligibleConnections === 0`
 * (dashboard usage/components/ProviderLimits/utils.js), and the count comes
 * from GET /api/providers/client. Its eligibility test accepted `oauth` and the
 * usage-capable API-key providers and nothing else — so a Codex account added
 * by pasting a ChatGPT token was invisible to it, because that flow persists
 * authType "access_token" (src/app/api/oauth/codex/import-token/route.js).
 *
 * Nothing else in the tree treats that authType as second class: the routing
 * engine maps it straight onto "oauth" (open-sse/services/provider.js,
 * credentialAuthMode), and the Codex reset-credits endpoint that lives INSIDE
 * /api/usage/[connectionId]/ already accepts it explicitly. The quota page was
 * the odd one out, and it was odd in three places at once — the listing route,
 * the usage route, and the shared helper each carried their own copy of the
 * rule.
 *
 * These pin the rule in the one place all three now read it from.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isQuotaEligible } from '@/shared/utils/quotaPause.js';
import { USAGE_APIKEY_PROVIDERS } from '@/shared/constants/providers';

let rows = [];

vi.mock('@/lib/localDb', () => ({
  getProviderConnections: async () => rows,
}));

vi.mock('@/lib/oauth/providers', () => ({
  backfillAccountIdentity: async () => {},
}));

const conn = (over = {}) => ({
  id: 'c1',
  provider: 'codex',
  authType: 'access_token',
  isActive: true,
  ...over,
});

async function listClientProviders(query = '') {
  const { GET } = await import('@/app/api/providers/client/route.js');
  const response = await GET(new Request(`http://localhost/api/providers/client?${query}`));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  rows = [];
});

describe('a pasted-token account is quota-eligible (#1322)', () => {
  it('the shared helper accepts access_token', () => {
    expect(isQuotaEligible({ authType: 'access_token', provider: 'codex' })).toBe(true);
  });

  it('access_token behaves exactly like the OAuth grant it is', () => {
    // Not "eligible everywhere" — eligible on the same terms. The provider gate
    // stays where it already was, in the listing route below.
    for (const provider of ['codex', 'definitely-not-a-usage-provider']) {
      expect(isQuotaEligible({ authType: 'access_token', provider })).toBe(
        isQuotaEligible({ authType: 'oauth', provider })
      );
    }
  });

  it('the rules that were already right are unchanged', () => {
    expect(isQuotaEligible({ authType: 'oauth', provider: 'claude' })).toBe(true);
    expect(isQuotaEligible({ authType: 'apikey', provider: USAGE_APIKEY_PROVIDERS[0] })).toBe(true);
    expect(isQuotaEligible({ authType: 'cookie', provider: 'claude' })).toBe(false);
  });
});

describe('the Quota Tracker counts that account (#1322)', () => {
  it('does not report an empty install when the only account is a pasted token', async () => {
    rows = [conn()];
    const { status, body } = await listClientProviders();

    expect(status).toBe(200);
    // eligibleConnections is what drives the "No Providers Connected" panel.
    expect(body.totals.eligibleConnections).toBe(1);
    expect(body.connections).toHaveLength(1);
    expect(body.providerOptions).toContain('codex');
  });

  it('lists a pasted token alongside an OAuth account of the same provider', async () => {
    rows = [conn({ id: 'token' }), conn({ id: 'oauth', authType: 'oauth' })];
    const { body } = await listClientProviders();

    expect(body.totals.eligibleConnections).toBe(2);
    expect(body.connections.map((c) => c.id).sort()).toEqual(['oauth', 'token']);
  });

  it('still excludes a provider that reports no usage at all', async () => {
    rows = [conn({ provider: 'definitely-not-a-usage-provider' })];
    const { body } = await listClientProviders();

    expect(body.totals.eligibleConnections).toBe(0);
  });
});

describe('one owner for the rule (#1322)', () => {
  // Three copies of an eligibility test is how they came to disagree. The
  // listing route can never again be looser or stricter than the route that
  // answers, because neither spells the rule out any more.
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  it('the listing route reads the shared helper', () => {
    const src = read('../../src/app/api/providers/client/route.js');
    expect(src).toContain('isQuotaEligible');
  });

  it('the usage route reads the shared helper instead of its own copy', () => {
    const src = read('../../src/app/api/usage/[connectionId]/route.js');
    expect(src).toContain('isQuotaEligible');
    expect(src).not.toContain('const isApikeyEligible');
  });
});
