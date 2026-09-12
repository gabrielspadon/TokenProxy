import { describe, it, expect, vi, beforeEach } from 'vitest';

// Contract test for GET /api/system/state — the aggregate the dashboard shell
// reads once per refresh. It asserts the response SHAPE and the null contract,
// not the numbers: a measure the schema genuinely cannot answer must be null
// with a stated reason, never 0.

const mocks = vi.hoisted(() => ({
  getTrafficWindow: vi.fn(),
  getSpendWindow: vi.fn(),
  getFailoverWindow: vi.fn(),
  getUpstreamHealthSummary: vi.fn(),
  // dashboardGuard dependencies (auth refusal case)
  getSettings: vi.fn(),
  checkKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  nextSymbol: Symbol('next'),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextSymbol),
    json: (body, init) => Response.json(body, init),
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock('@/lib/db/repos/requestStatsRepo.js', () => ({
  getTrafficWindow: mocks.getTrafficWindow,
}));
vi.mock('@/lib/db/repos/usageRepo.js', () => ({
  getSpendWindow: mocks.getSpendWindow,
}));
vi.mock('@/lib/db/repos/accountSwitchRepo.js', () => ({
  getFailoverWindow: mocks.getFailoverWindow,
}));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({
  getUpstreamHealthSummary: mocks.getUpstreamHealthSummary,
}));

vi.mock('@/lib/localDb', () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.checkKey,
}));
vi.mock('@/shared/utils/machineId', () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));
vi.mock('@/lib/auth/dashboardSession', () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { GET, SYSTEM_STATE_UNITS, UNANSWERABLE } =
  await import('../../src/app/api/system/state/route.js');
const { proxy } = await import('../../src/dashboardGuard.js');

const ROLLING_MEASURES = ['throughput', 'errorRate', 'latencyP95', 'failoverCount', 'spend'];
const INSTANT_MEASURES = ['connectedUpstreams', 'degradedUpstreams'];
const ALL_MEASURES = [...ROLLING_MEASURES, ...INSTANT_MEASURES];

function routeRequest(search = '', signal = undefined) {
  return { url: `http://localhost:20128/api/system/state${search}`, signal };
}

function busyTraffic(overrides = {}) {
  return {
    requests: 1800,
    errors: 36,
    latencySamples: 1200,
    latencyPercentileMs: 2400,
    lastEventAt: new Date().toISOString(),
    ...overrides,
  };
}

function emptyTraffic() {
  return {
    requests: 0,
    errors: 0,
    latencySamples: 0,
    latencyPercentileMs: null,
    lastEventAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTrafficWindow.mockResolvedValue(busyTraffic());
  mocks.getSpendWindow.mockResolvedValue({
    spendUsd: 4.25,
    samples: 1800,
    pricedSamples: 1700,
    providerReportedSamples: 0,
    estimatedSamples: 1700,
    unknownSamples: 100,
    evidenceKind: 'application-estimate',
  });
  mocks.getFailoverWindow.mockResolvedValue({
    failovers: 2,
    knownNonFailovers: 1,
    unknownTriggers: 1,
    samples: 4,
  });
  mocks.getUpstreamHealthSummary.mockResolvedValue({
    total: 46,
    connected: 6,
    degraded: 2,
    degradedProviderCount: 2,
    degradedProvidersOmitted: 0,
    degradedProviders: [
      { provider: 'claude', degradedConnections: 1, likelyCauses: ['authentication'] },
      { provider: 'openai', degradedConnections: 1, likelyCauses: ['rate_limited'] },
    ],
  });
});

describe('GET /api/system/state — shape, units and windows', () => {
  it('carries generatedAt, the rolling window and every documented measure', async () => {
    const res = await GET(routeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.window.kind).toBe('rolling');
    expect(body.window.seconds).toBe(3600);
    expect(Date.parse(body.window.to) - Date.parse(body.window.from)).toBe(3600 * 1000);

    expect(Object.keys(body.measures).sort()).toEqual([...ALL_MEASURES].sort());
  });

  it('gives every measure an explicit unit matching the exported contract', async () => {
    const body = await (await GET(routeRequest())).json();
    for (const name of ALL_MEASURES) {
      expect(body.measures[name].unit).toBe(SYSTEM_STATE_UNITS[name]);
      expect(typeof body.measures[name].unit).toBe('string');
    }
    expect(SYSTEM_STATE_UNITS.throughput).toBe('requests_per_second');
    expect(SYSTEM_STATE_UNITS.errorRate).toBe('ratio');
    expect(SYSTEM_STATE_UNITS.latencyP95).toBe('milliseconds');
    expect(SYSTEM_STATE_UNITS.spend).toBe('usd');
    expect(SYSTEM_STATE_UNITS.failoverCount).toBe('count');
    expect(SYSTEM_STATE_UNITS.connectedUpstreams).toBe('count');
    expect(SYSTEM_STATE_UNITS.degradedUpstreams).toBe('count');
  });

  it('states the time window each measure covers — rolling for traffic, instant for upstreams', async () => {
    const body = await (await GET(routeRequest())).json();
    for (const name of ROLLING_MEASURES) {
      expect(body.measures[name].window.kind).toBe('rolling');
      expect(body.measures[name].window.seconds).toBe(3600);
      expect(body.measures[name].window.from).toBe(body.window.from);
    }
    for (const name of INSTANT_MEASURES) {
      expect(body.measures[name].window.kind).toBe('instant');
      expect(body.measures[name].window.seconds).toBe(0);
      expect(body.measures[name].window.at).toBe(body.generatedAt);
    }
  });

  it('names the source table and the index each answered measure was read through', async () => {
    const body = await (await GET(routeRequest())).json();
    expect(body.measures.throughput.source).toBe('requestStats');
    expect(body.measures.throughput.index).toBe('idx_rs_ts');
    expect(body.measures.latencyP95.index).toBe('idx_rs_ts');
    expect(body.measures.spend.source).toBe('usageHistory');
    expect(body.measures.spend.index).toBe('idx_uh_ts');
    expect(body.measures.connectedUpstreams.source).toBe('providerConnections');
  });

  it('computes throughput per second and error rate as a ratio over the window', async () => {
    const body = await (await GET(routeRequest())).json();
    expect(body.measures.throughput.value).toBeCloseTo(1800 / 3600, 10);
    expect(body.measures.errorRate.value).toBeCloseTo(36 / 1800, 10);
    expect(body.measures.latencyP95.value).toBe(2400);
    expect(body.measures.latencyP95.sampleCount).toBe(1200);
    expect(body.measures.spend.value).toBe(4.25);
    expect(body.measures.spend.evidenceKind).toBe('application-estimate');
    expect(body.measures.spend.sampleCount).toBe(1700);
    expect(body.measures.spend.unknownSampleCount).toBe(100);
    expect(body.measures.failoverCount.value).toBe(2);
    expect(body.measures.failoverCount.unknownTriggerCount).toBe(1);
    expect(body.measures.connectedUpstreams.value).toBe(6);
    expect(body.measures.degradedUpstreams.value).toBe(2);
    // Degraded includes persisted failures on disabled connections, so its
    // denominator must be every configured connection, not active ones only.
    expect(body.measures.degradedUpstreams.sampleCount).toBe(46);
  });

  it('names degraded Providers with safe likely causes from the same bounded read', async () => {
    const body = await (await GET(routeRequest())).json();

    expect(body.providerHealth).toEqual({
      status: 'degraded',
      source: 'providerConnections',
      observedAt: body.generatedAt,
      unavailable: null,
      degradedProviderCount: 2,
      degradedProvidersOmitted: 0,
      degradedProviders: [
        { provider: 'claude', degradedConnections: 1, likelyCauses: ['authentication'] },
        { provider: 'openai', degradedConnections: 1, likelyCauses: ['rate_limited'] },
      ],
    });
    expect(JSON.stringify(body.providerHealth)).not.toContain('connectionId');
  });

  it('clamps windowSeconds to the supported range instead of trusting the caller', async () => {
    const wide = await (await GET(routeRequest('?windowSeconds=999999'))).json();
    expect(wide.window.seconds).toBe(21600);
    const narrow = await (await GET(routeRequest('?windowSeconds=1'))).json();
    expect(narrow.window.seconds).toBe(60);
    const junk = await (await GET(routeRequest('?windowSeconds=abc'))).json();
    expect(junk.window.seconds).toBe(3600);
    const chosen = await (await GET(routeRequest('?windowSeconds=300'))).json();
    expect(chosen.window.seconds).toBe(300);
    expect(chosen.measures.throughput.value).toBeCloseTo(1800 / 300, 10);
  });
});

describe('the null contract — unanswerable is null, never zero', () => {
  it('reports semantic failovers while keeping unknown triggers visible', async () => {
    const body = await (await GET(routeRequest())).json();
    expect(body.measures.failoverCount).toMatchObject({
      value: 2,
      sampleCount: 4,
      unknownTriggerCount: 1,
      source: 'accountSwitches',
      index: 'idx_as_at',
      unavailable: null,
    });
    expect(body.unanswerable).not.toContain('failoverCount');
    expect(UNANSWERABLE).not.toContain('failoverCount');
  });

  it('returns null error rate on an empty database rather than a 0 that reads as healthy', async () => {
    mocks.getTrafficWindow.mockResolvedValue(emptyTraffic());
    mocks.getSpendWindow.mockResolvedValue({ spendUsd: null, samples: 0, pricedSamples: 0,
      providerReportedSamples: 0, estimatedSamples: 0, unknownSamples: 0, evidenceKind: 'unknown' });
    mocks.getFailoverWindow.mockResolvedValue({ failovers: 0, knownNonFailovers: 0, unknownTriggers: 0, samples: 0 });
    mocks.getUpstreamHealthSummary.mockResolvedValue({
      total: 0,
      connected: 0,
      degraded: 0,
      degradedProviderCount: 0,
      degradedProvidersOmitted: 0,
      degradedProviders: [],
    });

    const res = await GET(routeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    // Measured zeroes: no request in a known window really is 0 req/s.
    expect(body.measures.throughput.value).toBe(0);
    expect(body.measures.spend.value).toBeNull();
    expect(body.measures.spend.evidenceKind).toBe('unknown');
    expect(body.measures.connectedUpstreams.value).toBe(0);
    expect(body.measures.degradedUpstreams.value).toBe(0);
    expect(body.measures.failoverCount.value).toBe(0);

    // Unanswerable: 0 errors out of 0 requests is not a rate, and no measured
    // latency sample is not a p95 of zero.
    expect(body.measures.errorRate.value).toBeNull();
    expect(typeof body.measures.errorRate.unavailable).toBe('string');
    expect(body.measures.latencyP95.value).toBeNull();
    expect(typeof body.measures.latencyP95.unavailable).toBe('string');
    expect(body.measures.latencyP95.sampleCount).toBe(0);
  });

  it('reports freshness as empty with no event, and live/idle against the window', async () => {
    mocks.getTrafficWindow.mockResolvedValue(emptyTraffic());
    let body = await (await GET(routeRequest())).json();
    expect(body.freshness.state).toBe('empty');
    expect(body.freshness.lastEventAt).toBeNull();
    expect(body.freshness.ageSeconds).toBeNull();

    mocks.getTrafficWindow.mockResolvedValue(
      busyTraffic({ lastEventAt: new Date(Date.now() - 5000).toISOString() })
    );
    body = await (await GET(routeRequest())).json();
    expect(body.freshness.state).toBe('live');
    expect(body.freshness.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body.freshness.unit).toBe('seconds');

    mocks.getTrafficWindow.mockResolvedValue(
      busyTraffic({ lastEventAt: new Date(Date.now() - 7200 * 1000).toISOString() })
    );
    body = await (await GET(routeRequest())).json();
    expect(body.freshness.state).toBe('idle');
    expect(body.freshness.ageSeconds).toBeGreaterThan(3600);
  });
});

describe('partial source failure degrades to null, never to a 500', () => {
  it("nulls only the failed source's measures and keeps 200 for the rest", async () => {
    mocks.getTrafficWindow.mockRejectedValue(new Error('requestStats unavailable'));

    const res = await GET(routeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    for (const name of ['throughput', 'errorRate', 'latencyP95']) {
      expect(body.measures[name].value).toBeNull();
      expect(typeof body.measures[name].unavailable).toBe('string');
    }
    expect(body.freshness.state).toBe('unknown');

    expect(body.measures.spend.value).toBe(4.25);
    expect(body.measures.failoverCount.value).toBe(2);
    expect(body.measures.connectedUpstreams.value).toBe(6);
    expect(body.measures.degradedUpstreams.value).toBe(2);
    expect(body.unanswerable).toEqual(
      expect.arrayContaining(['throughput', 'errorRate', 'latencyP95'])
    );
  });

  it('survives every source failing at once and still answers 200 with a full shape', async () => {
    mocks.getTrafficWindow.mockRejectedValue(new Error('no stats'));
    mocks.getSpendWindow.mockRejectedValue(new Error('no usage'));
    mocks.getFailoverWindow.mockRejectedValue(new Error('no switches'));
    mocks.getUpstreamHealthSummary.mockRejectedValue(new Error('no connections'));

    const res = await GET(routeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.measures).sort()).toEqual([...ALL_MEASURES].sort());
    for (const name of ALL_MEASURES) {
      expect(body.measures[name].value).toBeNull();
      expect(body.measures[name].unit).toBe(SYSTEM_STATE_UNITS[name]);
    }
  });

  it('never exposes a repository exception through unavailable state', async () => {
    mocks.getUpstreamHealthSummary.mockRejectedValue(
      new Error('postgres://operator:secret@private-host/tokenproxy'),
    );

    const body = await (await GET(routeRequest())).json();

    expect(body.providerHealth.status).toBe('unavailable');
    expect(body.providerHealth.unavailable).toBe('source unavailable');
    expect(JSON.stringify(body)).not.toContain('postgres://');
    expect(JSON.stringify(body)).not.toContain('private-host');
  });
});

describe('abort propagation', () => {
  it('refuses before touching any source when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await GET(routeRequest('', controller.signal));
    expect(res.status).toBe(499);
    expect(mocks.getTrafficWindow).not.toHaveBeenCalled();
    expect(mocks.getSpendWindow).not.toHaveBeenCalled();
    expect(mocks.getFailoverWindow).not.toHaveBeenCalled();
    expect(mocks.getUpstreamHealthSummary).not.toHaveBeenCalled();
  });

  it('stops at the next source boundary when the client aborts mid-flight', async () => {
    const controller = new AbortController();
    mocks.getTrafficWindow.mockImplementation(async () => {
      controller.abort();
      return busyTraffic();
    });

    const res = await GET(routeRequest('', controller.signal));
    expect(res.status).toBe(499);
    expect(mocks.getTrafficWindow).toHaveBeenCalledTimes(1);
    expect(mocks.getSpendWindow).not.toHaveBeenCalled();
    expect(mocks.getFailoverWindow).not.toHaveBeenCalled();
    expect(mocks.getUpstreamHealthSummary).not.toHaveBeenCalled();
  });
});

describe('authentication on the existing global gate', () => {
  function guardRequest(pathname, headers = {}) {
    return {
      nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
      headers: new Headers(headers),
      cookies: { get: vi.fn(() => undefined) },
      url: `http://localhost${pathname}`,
      method: 'GET',
    };
  }

  beforeEach(() => {
    process.env.TOKENPROXY_PEER_TOKEN = 'peer-token-fixture';
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.checkKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue('cli-token');
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it('refuses an unauthenticated request with 401 — never 200', async () => {
    const res = await proxy(guardRequest('/api/system/state'));
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(200);
  });

  it('lets an authenticated dashboard session through the same gate', async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const req = guardRequest('/api/system/state');
    req.cookies.get = vi.fn(() => ({ value: 'jwt' }));
    const res = await proxy(req);
    expect(res).toBe(mocks.nextSymbol);
  });

  it('is not on the public allow-list or a public prefix', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/dashboardGuard.js', import.meta.url), 'utf8')
    );
    expect(source).not.toMatch(/["']\/api\/system/);
  });
});
