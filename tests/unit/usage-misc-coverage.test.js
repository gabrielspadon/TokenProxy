import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queue of responses consumed in call order; a function entry throws/behaves custom.
let RESPONSES = [];
const fetchMock = vi.fn(async (url, opts) => {
  const next = RESPONSES.shift();
  if (typeof next === 'function') return next(url, opts);
  if (next instanceof Error) throw next;
  return next;
});

vi.mock('open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const {
  getIflowUsage,
  getOllamaUsage,
  getGlmUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
  getOpencodeGoUsage,
} = await import('open-sse/services/usage/misc.js');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  RESPONSES = [];
  fetchMock.mockClear();
});

describe('getIflowUsage', () => {
  it('returns a static connected message', async () => {
    const out = await getIflowUsage('tok');
    expect(out.message).toMatch(/iFlow connected/);
  });
});

describe('getOllamaUsage', () => {
  it('requires a key', async () => {
    expect((await getOllamaUsage(null)).message).toMatch(/not available/);
  });

  it('maps 401/403 to invalid-key and other non-ok to an error message', async () => {
    RESPONSES = [json({}, 401)];
    expect((await getOllamaUsage('k')).message).toMatch(/invalid or expired/);
    RESPONSES = [json({}, 500)];
    expect((await getOllamaUsage('k')).message).toMatch(/\(500\)/);
  });

  it('reports non-JSON usage bodies', async () => {
    RESPONSES = [new Response('not json', { status: 200 })];
    expect((await getOllamaUsage('k')).message).toMatch(/not JSON/);
  });

  it('converts 0..1 ratios to percentage quotas and titles the plan from /api/me', async () => {
    RESPONSES = [
      json({ limits: { session: { usage: 0.25 }, weekly: { usage: 1.5 } } }),
      json({ Plan: 'hobby' }),
    ];
    const out = await getOllamaUsage('k');
    expect(out.plan).toBe('Hobby');
    expect(out.quotas['Session (5h)']).toMatchObject({
      used: 25,
      total: 100,
      remainingPercentage: 75,
    });
    // ratio clamps at 1
    expect(out.quotas['Weekly (7d)'].used).toBe(100);
  });

  it('falls back to the default plan when /api/me fails, and handles no limits', async () => {
    RESPONSES = [json({ limits: {} }), new Error('me down')];
    const out = await getOllamaUsage('k');
    expect(out.plan).toBe('Ollama Cloud');
    expect(out.message).toMatch(/No usage limits/);
    expect(out.quotas).toEqual({});
  });

  it('returns the error message when the fetch throws', async () => {
    RESPONSES = [new Error('net down')];
    expect((await getOllamaUsage('k')).message).toMatch(/net down/);
  });
});

describe('getGlmUsage', () => {
  it('requires a key and maps 401 and other errors', async () => {
    expect((await getGlmUsage(null)).message).toMatch(/not available/);
    RESPONSES = [json({}, 401)];
    expect((await getGlmUsage('k', 'glm')).message).toMatch(/invalid or expired/);
    RESPONSES = [json({}, 503)];
    expect((await getGlmUsage('k', 'glm')).message).toMatch(/\(503\)/);
  });

  it('skips non-token limits, defaults plan to Unknown, and null resetAt for zero times', async () => {
    RESPONSES = [
      json({
        data: {
          limits: [
            { type: 'OTHER_LIMIT', percentage: 50 },
            null,
            { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 0 },
          ],
        },
      }),
    ];
    const out = await getGlmUsage('k', 'glm-cn');
    expect(out.plan).toBe('Unknown');
    expect(Object.keys(out.quotas)).toEqual(['session']);
    expect(out.quotas.session.resetAt).toBeNull();
    expect(out.quotas.session.remaining).toBe(70);
  });

  it('returns the error message when the fetch throws', async () => {
    RESPONSES = [new Error('glm down')];
    expect((await getGlmUsage('k', 'glm')).message).toMatch(/glm down/);
  });
});

describe('getVercelAiGatewayUsage', () => {
  it('requires a key and maps auth failures', async () => {
    expect((await getVercelAiGatewayUsage(null)).message).toMatch(/not available/);
    RESPONSES = [json({}, 403)];
    expect((await getVercelAiGatewayUsage('k')).message).toMatch(/invalid or expired/);
  });

  it('includes trimmed error text on other failures', async () => {
    RESPONSES = [new Response('server exploded', { status: 500 })];
    const out = await getVercelAiGatewayUsage('k');
    expect(out.message).toMatch(/\(500\): server exploded/);
  });

  it('reports an unfunded account when both numbers are zero', async () => {
    RESPONSES = [json({ balance: '0', total_used: '0' })];
    const out = await getVercelAiGatewayUsage('k');
    expect(out.message).toMatch(/No credit allocation/);
    expect(out.quotas).toEqual({});
  });

  it('builds Used and Remaining quotas from decimal strings', async () => {
    RESPONSES = [json({ balance: '4.50', total_used: '0.50' })];
    const out = await getVercelAiGatewayUsage('k');
    expect(out.quotas['Used (USD)'].unlimited).toBe(true);
    const rem = out.quotas['Remaining (USD)'];
    expect(rem.remaining).toBe(4.5);
    expect(rem.remainingPercentage).toBeCloseTo(90);
  });

  it('returns the error message when the fetch throws', async () => {
    RESPONSES = [new Error('vercel down')];
    expect((await getVercelAiGatewayUsage('k')).message).toMatch(/vercel down/);
  });
});

describe('getQoderUsage', () => {
  it('requires a token and reports non-ok status', async () => {
    expect((await getQoderUsage(null)).message).toMatch(/no access token/);
    RESPONSES = [json({}, 500)];
    expect((await getQoderUsage('t')).message).toMatch(/returned 500/);
  });

  it('reports non-JSON bodies', async () => {
    RESPONSES = [new Response('nope', { status: 200 })];
    expect((await getQoderUsage('t')).message).toMatch(/not JSON/);
  });

  it('shapes user and org quotas with a shared ISO resetAt and scalar metadata', async () => {
    const expiresAt = 1800000000000;
    RESPONSES = [
      json({
        userQuota: { total: 100, used: 40, remaining: 60, unit: 'points' },
        orgResourcePackage: {},
        totalUsagePercentage: 40,
        isQuotaExceeded: false,
        expiresAt,
      }),
    ];
    const out = await getQoderUsage('t');
    expect(out.quotas.user).toEqual({
      total: 100,
      used: 40,
      remaining: 60,
      unit: 'points',
      resetAt: new Date(expiresAt).toISOString(),
    });
    expect(out.quotas.organization.unit).toBe('credits');
    expect(out.totalUsagePercentage).toBe(40);
    expect(out.isQuotaExceeded).toBe(false);
    expect(out.expiresAt).toBe(expiresAt);
  });

  it('treats a missing or non-positive expiresAt as null resetAt', async () => {
    RESPONSES = [json({ userQuota: {}, expiresAt: 0 })];
    const out = await getQoderUsage('t');
    expect(out.quotas.user.resetAt).toBeNull();
    expect(out.expiresAt).toBeNull();
  });

  it('returns the error message when the fetch throws', async () => {
    RESPONSES = [new Error('qoder down')];
    expect((await getQoderUsage('t')).message).toMatch(/qoder down/);
  });
});

describe('getOpencodeGoUsage', () => {
  it('requires a key and maps auth/other failures', async () => {
    expect((await getOpencodeGoUsage(null)).message).toMatch(/not available/);
    RESPONSES = [json({}, 403)];
    expect((await getOpencodeGoUsage('k')).message).toMatch(/invalid or expired/);
    RESPONSES = [json({}, 500)];
    expect((await getOpencodeGoUsage('k')).message).toMatch(/\(500\)/);
  });

  it('builds all three windows, clamping percent into 0..100', async () => {
    RESPONSES = [
      json({
        usage: {
          rolling: { percent: 150, resetsAt: '2026-01-01T00:00:00Z' },
          weekly: { percent: -5 },
          monthly: { percent: 33 },
        },
      }),
    ];
    const out = await getOpencodeGoUsage('k');
    expect(out.quotas['Rolling (5h)']).toMatchObject({
      used: 100,
      remaining: 0,
      resetAt: '2026-01-01T00:00:00Z',
    });
    expect(out.quotas['Weekly']).toMatchObject({ used: 0, remaining: 100, resetAt: null });
    expect(out.quotas['Monthly'].used).toBe(33);
  });

  it('returns an empty quota set when usage is absent, and the error on throw', async () => {
    RESPONSES = [json({})];
    expect((await getOpencodeGoUsage('k')).quotas).toEqual({});
    RESPONSES = [new Error('go down')];
    expect((await getOpencodeGoUsage('k')).message).toMatch(/go down/);
  });
});
