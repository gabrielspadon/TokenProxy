import { describe, it, expect, vi, beforeEach } from 'vitest';

// Provider validation receipts expose no token,
// no raw validation frame and no prompt body.
//
// WHY THIS TEST IS STRUCTURAL, NOT A GREP OVER OUTPUT. connectionsRepo's
// rowToConn spreads the DECRYPTED credential blob into every connection object
// it returns, so a connection in memory carries accessToken, refreshToken and
// apiKey beside its id. A handler that spread that object into a response would
// disclose all three, and the next credential field anyone adds upstream on top
// of them. The projection therefore picks every field by name, and this file
// plants fake credentials in every input and asserts none reaches the wire.
//
// Every fixture below is SYNTHETIC and obviously fake. Nothing is read from the
// environment or from any config file.

const FAKE = {
  accessToken: 'sk-test-notreal-0000-access-aaaaaaaaaaaa',
  refreshToken: 'rt-test-notreal-0000-refresh-bbbbbbbbbb',
  apiKey: 'sk-test-notreal-0000-apikey-cccccccccccc',
  idToken: 'id-test-notreal-0000-dddddddddddddddddd',
  clientKey: 'ck-test-notreal-0000-eeeeeeeeeeeeeeee',
  cookie: 'session=test-notreal-0000-ffffffffffffffff',
  prompt: 'PROMPT BODY: summarize this confidential customer record verbatim',
  frame: 'RAW VALIDATION FRAME {"messages":[{"role":"user","content":"private"}]}',
};

const FAKE_VALUES = Object.values(FAKE);

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  getWindows: vi.fn(),
  readAllDrainDocs: vi.fn(),
  readDrainDoc: vi.fn(),
  readQualification: vi.fn(),
  writeQualification: vi.fn(),
  testSingleConnection: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
  isConnectionDegraded: (conn) => conn.testStatus === 'error',
}));
vi.mock('@/lib/db/repos/quotaWindowsRepo.js', () => ({ getWindows: mocks.getWindows }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/app/api/providers/[id]/test/testUtils', () => ({
  testSingleConnection: mocks.testSingleConnection,
}));
vi.mock('open-sse/config/providerModels.js', () => ({
  getDefaultModel: () => 'claude-sonnet-4.5',
}));
// The single-flight set and the version hash are pure and process-local, so the
// real implementations stay; only the persistence calls are stubbed.
vi.mock('@/lib/admin/state.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readAllDrainDocs: mocks.readAllDrainDocs,
  readDrainDoc: mocks.readDrainDoc,
  readQualification: mocks.readQualification,
  writeQualification: mocks.writeQualification,
}));

const { GET } = await import('@/app/api/admin/qualification/[connectionId]/route.js');
const { GET: LIST } = await import('@/app/api/admin/qualification/route.js');
const { POST } = await import('@/app/api/admin/qualification/[connectionId]/recheck/route.js');

// A connection record shaped the way rowToConn actually returns one: the id and
// provider the ABI needs, sitting inside a pile of decrypted credentials it
// must never take.
const loadedConnection = (id = 'conn-1') => ({
  id,
  provider: 'anthropic',
  authType: 'oauth',
  name: 'primary account',
  email: 'operator@example.invalid',
  isActive: true,
  testStatus: 'active',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastErrorAt: null,
  lastError: null,
  accessToken: FAKE.accessToken,
  refreshToken: FAKE.refreshToken,
  apiKey: FAKE.apiKey,
  idToken: FAKE.idToken,
  providerSpecificData: { clientKey: FAKE.clientKey, cookie: FAKE.cookie },
});

const params = (connectionId) => ({ params: Promise.resolve({ connectionId }) });
const request = (body) => ({
  method: 'POST',
  url: 'http://localhost/api/admin/qualification/conn-1/recheck',
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const windowRow = {
  scope: '5h',
  remaining: 120,
  limit: 500,
  resetAt: '2026-01-01T05:00:00.000Z',
  observedAt: '2026-01-01T00:00:00.000Z',
  confidence: 'fresh',
};

function assertNoLeak(serialized) {
  for (const planted of FAKE_VALUES) expect(serialized).not.toContain(planted);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(null);
  mocks.getProviderConnectionById.mockResolvedValue(loadedConnection());
  mocks.getProviderConnections.mockResolvedValue([loadedConnection(), loadedConnection('conn-2')]);
  mocks.getWindows.mockResolvedValue([windowRow]);
  mocks.readAllDrainDocs.mockResolvedValue({});
  mocks.readDrainDoc.mockResolvedValue(null);
  mocks.readQualification.mockResolvedValue(null);
  mocks.writeQualification.mockResolvedValue(undefined);
});

describe('GET /api/admin/qualification/{connectionId}', () => {
  it('returns a qualification receipt in the frozen shape', async () => {
    const res = await GET({}, params('conn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(
      ['checkedAt', 'connectionId', 'generation', 'validation', 'provider', 'quota', 'status'].sort()
    );
    expect(body.connectionId).toBe('conn-1');
    expect(body.provider).toBe('anthropic');
    expect(['healthy', 'degraded', 'cooldown', 'drained', 'unqualified', 'error']).toContain(
      body.status
    );
    expect(Object.keys(body.generation).sort()).toEqual(['error', 'latencyMs', 'model', 'ok']);
    expect(body.quota).toHaveLength(1);
    // The store speaks freshness, the ABI speaks provenance.
    expect(body.quota[0].confidence).toBe('measured');
    expect(body.checkedAt).toBeNull();
    expect(body.validation.ok).toBeNull();
    expect(body.validation.generationVerified).toBe(false);
    expect(body.generation.ok).toBe(false);
  });

  it('discloses no credential from the decrypted connection record', async () => {
    const body = await (await GET({}, params('conn-1'))).json();
    assertNoLeak(JSON.stringify(body));
  });

  it('does not promote an old inferred model or configuration time to generation evidence', async () => {
    mocks.readQualification.mockResolvedValue({ ok: true, model: 'invented-default', latencyMs: 5, checkedAt: 'bad-time' });
    const body = await (await GET({}, params('conn-1'))).json();
    expect(body.checkedAt).toBeNull();
    expect(body.validation).toMatchObject({ ok: true, model: null, upstreamContact: 'not-recorded', generationVerified: false });
    expect(body.generation.model).toBeNull();
  });

  it('is 404 for a connection that does not exist, and says nothing else', async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);
    const res = await GET({}, params('nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.source).toBe('tokenproxy-admin');
    expect(body.code).toBe('not_found');
  });
});

describe('GET /api/admin/qualification', () => {
  it('lists every connection in the frozen Connection shape', async () => {
    const res = await LIST({});
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.connections).toHaveLength(2);
    for (const conn of body.connections) {
      expect(Object.keys(conn).sort()).toEqual(
        [
          'connectionId',
          'displayName',
          'isActive',
          'isDraining',
          'lastError',
          'lastQualifiedAt',
          'provider',
          'status',
        ].sort()
      );
      expect(conn.lastQualifiedAt).toBeNull();
    }
  });

  it('discloses no credential across the whole list', async () => {
    const body = await (await LIST({})).json();
    assertNoLeak(JSON.stringify(body));
  });

  it('reports a draining connection as drained', async () => {
    mocks.readAllDrainDocs.mockResolvedValue({ 'conn-2': { isDraining: true } });
    const body = await (await LIST({})).json();
    expect(body.connections.find((c) => c.connectionId === 'conn-2').status).toBe('drained');
    expect(body.connections.find((c) => c.connectionId === 'conn-1').status).toBe('healthy');
  });
});

describe('POST /api/admin/qualification/{connectionId}/recheck', () => {
  it('records a provider validation without inventing a generated response or model', async () => {
    mocks.testSingleConnection.mockResolvedValue({
      valid: true,
      latencyMs: 412,
      testedAt: '2026-01-01T00:00:10.000Z',
      error: null,
    });

    const res = await POST(request(), params('conn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mocks.testSingleConnection).toHaveBeenCalledWith('conn-1');
    expect(body.generation).toEqual({
      ok: true,
      model: null,
      latencyMs: 412,
      error: null,
    });
    expect(body.validation).toMatchObject({ ok: true, kind: 'provider-validation', checkedAt: '2026-01-01T00:00:10.000Z', upstreamContact: 'not-recorded', generationVerified: false });
    assertNoLeak(JSON.stringify(body));
  });

  it('keeps malformed validation results unknown instead of treating truthy values as a pass', async () => {
    mocks.testSingleConnection.mockResolvedValue({ valid: 'true' });
    const body = await (await POST(request(), params('conn-1'))).json();
    expect(body.validation.ok).toBeNull();
    expect(body.generation.ok).toBe(false);
  });

  it("keeps a failed probe a 200 and redacts the upstream's error text", async () => {
    mocks.testSingleConnection.mockResolvedValue({
      valid: false,
      latencyMs: 88,
      testedAt: '2026-01-01T00:00:10.000Z',
      // An upstream is free to echo back the credential it rejected.
      error: `401 rejected authorization: Bearer ${FAKE.accessToken} while sending ${FAKE.frame}`,
    });

    const res = await POST(request(), params('conn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.generation.ok).toBe(false);
    expect(body.generation.error).toContain('[redacted]');
    assertNoLeak(JSON.stringify(body));
  });

  it('records the probe rather than the generated content', async () => {
    mocks.testSingleConnection.mockResolvedValue({
      valid: true,
      latencyMs: 10,
      testedAt: '2026-01-01T00:00:10.000Z',
      error: null,
      // Fields a future probe might carry. Neither is part of the receipt.
      completion: FAKE.prompt,
      requestBody: FAKE.frame,
    });

    await POST(request(), params('conn-1'));
    const [, stored] = mocks.writeQualification.mock.calls.at(-1);
    expect(Object.keys(stored).sort()).toEqual(
      ['checkedAt', 'error', 'latencyMs', 'model', 'ok'].sort()
    );
    assertNoLeak(JSON.stringify(stored));
  });

  it('rejects a malformed body before it contacts the upstream', async () => {
    const res = await POST(request({ force: 'yes' }), params('conn-1'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_request');
    expect(mocks.testSingleConnection).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized field before it contacts the upstream', async () => {
    const res = await POST(request({ forse: true }), params('conn-1'));
    expect(res.status).toBe(400);
    expect(mocks.testSingleConnection).not.toHaveBeenCalled();
  });

  it('refuses to probe a draining connection', async () => {
    mocks.readDrainDoc.mockResolvedValue({
      isDraining: true,
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await POST(request(), params('conn-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('recheck_in_progress');
    expect(mocks.testSingleConnection).not.toHaveBeenCalled();
  });

  it('reuses a fresh provider validation instead of repeating the check', async () => {
    mocks.readQualification.mockResolvedValue({
      ok: true,
      model: 'claude-sonnet-4.5',
      latencyMs: 5,
      error: null,
      checkedAt: new Date().toISOString(),
    });
    const res = await POST(request(), params('conn-1'));
    expect(res.status).toBe(200);
    expect(mocks.testSingleConnection).not.toHaveBeenCalled();
  });

  it('probes anyway when force is set', async () => {
    mocks.readQualification.mockResolvedValue({
      ok: true,
      model: 'claude-sonnet-4.5',
      latencyMs: 5,
      error: null,
      checkedAt: new Date().toISOString(),
    });
    mocks.testSingleConnection.mockResolvedValue({
      valid: true,
      latencyMs: 20,
      testedAt: new Date().toISOString(),
      error: null,
    });
    await POST(request({ force: true }), params('conn-1'));
    expect(mocks.testSingleConnection).toHaveBeenCalledTimes(1);
  });

  it('admits one probe at a time per connection', async () => {
    let release;
    mocks.testSingleConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ valid: true, latencyMs: 1, testedAt: new Date().toISOString(), error: null });
        })
    );

    const first = POST(request(), params('conn-1'));
    // Let the first call claim the slot before the second one arrives.
    await new Promise((r) => setImmediate(r));
    const second = await POST(request(), params('conn-1'));

    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('recheck_in_progress');

    release();
    expect((await first).status).toBe(200);
    expect(mocks.testSingleConnection).toHaveBeenCalledTimes(1);
  });

  it('still records a finding when the probe itself throws', async () => {
    mocks.testSingleConnection.mockRejectedValue(new Error(`network died holding ${FAKE.apiKey}`));
    const res = await POST(request(), params('conn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation.ok).toBe(false);
    assertNoLeak(JSON.stringify(body));
    expect(mocks.writeQualification).toHaveBeenCalled();
  });
});
