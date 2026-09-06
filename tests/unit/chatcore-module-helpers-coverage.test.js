// Covers the module-scope helpers of open-sse/handlers/chatCore.js that the
// handler-level suites never reach: the exported token-expiry predicate, the
// proxy-selection log's no-egress and no_proxy branches, stripContinuityFields'
// early returns, and the REQ-summary listener guards that feed
// sessionCalibrationFor. Everything here is pure or listener-driven, so no
// upstream is contacted; proxyFetch is stubbed anyway because
// installGlobalProxyFetch would otherwise replace a stubbed global fetch.
import { describe, it, expect, vi } from 'vitest';

// Partial mock: only the two network-facing exports are replaced. The real
// redactProxyUrlForLog has to survive, because logProxySelection's masking is
// exactly what the PROXY-line assertions below check.
vi.mock('../../open-sse/utils/proxyFetch.js', async (orig) => ({
  ...(await orig()),
  proxyAwareFetch: vi.fn(async () => {
    throw new Error('no test in this file may reach an upstream');
  }),
  installGlobalProxyFetch: vi.fn(),
}));

vi.mock('@/lib/usageDb.js', () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const writeContextStatusMock = vi.fn();
vi.mock('../../open-sse/handlers/chatCore/contextStatusStore.js', async (orig) => ({
  ...(await orig()),
  writeContextStatus: (...args) => writeContextStatusMock(...args),
}));

const { isTokenExpiringSoon, logProxySelection, stripContinuityFields, sessionCalibrationFor } =
  await import('../../open-sse/handlers/chatCore.js');
const { reqSummary, VERDICTS } = await import('../../src/shared/observability/decide.js');

function makeLog() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('isTokenExpiringSoon', () => {
  // A credential with no expiry is not expiring. Returning true here would
  // make every API-key connection refresh on each request.
  it.each([[null], [undefined], [''], [0]])('treats %o as not expiring', (value) => {
    expect(isTokenExpiringSoon(value)).toBe(false);
  });

  it('is true inside the default buffer and false outside it', () => {
    const now = Date.now();
    // The default buffer is 5 minutes; probe one minute either side of it.
    expect(isTokenExpiringSoon(new Date(now + 4 * 60_000).toISOString())).toBe(true);
    expect(isTokenExpiringSoon(new Date(now + 6 * 60_000).toISOString())).toBe(false);
  });

  it('honours an explicit buffer and treats an already-past expiry as expiring', () => {
    const now = Date.now();
    const in90s = new Date(now + 90_000).toISOString();
    expect(isTokenExpiringSoon(in90s, 30_000)).toBe(false);
    expect(isTokenExpiringSoon(in90s, 120_000)).toBe(true);
    expect(isTokenExpiringSoon(new Date(now - 60_000).toISOString())).toBe(true);
  });

  it('accepts an epoch-millisecond expiry, not only an ISO string', () => {
    expect(isTokenExpiringSoon(Date.now() + 60_000)).toBe(true);
    expect(isTokenExpiringSoon(Date.now() + 60 * 60_000)).toBe(false);
  });
});

describe('logProxySelection', () => {
  it('logs no PROXY line when neither a relay nor an enabled connection proxy is set', () => {
    const log = makeLog();
    logProxySelection({
      proxyOptions: { connectionProxyEnabled: false, connectionProxyUrl: 'http://unused:8080' },
      credentials: { connectionName: 'conn-a' },
      provider: 'openai',
      model: 'gpt-4o',
      log,
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('logs the no_proxy list on debug when the connection proxy carries one', () => {
    const log = makeLog();
    logProxySelection({
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: 'http://user:secret@proxy.internal:8080',
        connectionNoProxy: 'localhost,127.0.0.1',
      },
      credentials: {
        connectionName: 'conn-b',
        providerSpecificData: { connectionProxyPoolId: 'pool-9' },
      },
      provider: 'openai',
      model: 'gpt-4o',
      log,
    });

    const [, urlLine] = log.info.mock.calls[0];
    expect(urlLine).toContain('pool=pool-9');
    // The password must never reach the log; the host must survive it.
    expect(urlLine).not.toContain('secret');
    expect(urlLine).toContain('proxy.internal');

    const [, noProxyLine] = log.debug.mock.calls[0];
    expect(noProxyLine).toContain('no_proxy=localhost,127.0.0.1');
  });

  it('falls back to the connection id, then to unknown, for the conn= tag', () => {
    const log = makeLog();
    logProxySelection({
      proxyOptions: { vercelRelayUrl: 'https://relay.example/api?token=abc' },
      credentials: { connectionId: 'conn-id-only' },
      provider: 'kiro',
      model: 'kr/claude-opus-4.8',
      log,
    });
    expect(log.info.mock.calls[0][1]).toContain('conn=conn-id-only');

    const log2 = makeLog();
    logProxySelection({
      proxyOptions: { vercelRelayUrl: 'https://relay.example/api' },
      credentials: {},
      provider: 'kiro',
      model: 'kr/claude-opus-4.8',
      log: log2,
    });
    expect(log2.info.mock.calls[0][1]).toContain('conn=unknown');
    expect(log2.info.mock.calls[0][1]).toContain('pool=none');
  });

  it('does not throw when no log sink is supplied', () => {
    expect(() =>
      logProxySelection({
        proxyOptions: { vercelRelayUrl: 'https://relay.example/api' },
        credentials: { connectionName: 'c' },
        provider: 'openai',
        model: 'gpt-4o',
        log: undefined,
      })
    ).not.toThrow();
  });
});

describe('stripContinuityFields', () => {
  it('returns the body untouched when it has no messages array', () => {
    expect(stripContinuityFields(null, 'openai', 'gpt-4o')).toBe(null);
    const noMessages = { input: [] };
    expect(stripContinuityFields(noMessages, 'openai', 'gpt-4o')).toBe(noMessages);
    const notAnArray = { messages: 'nope' };
    expect(stripContinuityFields(notAnArray, 'openai', 'gpt-4o')).toBe(notAnArray);
  });

  it('drops encrypted continuity fields even with no provider or model given', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: 'a',
          encrypted_content: 'E',
          reasoning_encrypted_content: 'R',
        },
        null,
        'not-an-object',
      ],
    };
    const out = stripContinuityFields(body, null, null);
    expect(out.messages[0]).not.toHaveProperty('encrypted_content');
    expect(out.messages[0]).not.toHaveProperty('reasoning_encrypted_content');
    expect(out.messages[0].content).toBe('a');
    // Non-object entries are skipped rather than throwing.
    expect(out.messages[1]).toBe(null);
    expect(out.messages[2]).toBe('not-an-object');
  });
});

describe('REQ summary listener feeding sessionCalibrationFor', () => {
  // The listener is registered as an import side effect and keyed by rid. A
  // rid that was never remembered must leave calibration untouched, which is
  // what these guards assert. Calibration for an unknown sid is the identity
  // factor 1, so any drift shows up as a value other than 1.
  const unknownSid = '0123abcd';

  it('ignores a summary with no rid field', () => {
    reqSummary('ok', { in: 1000 });
    expect(sessionCalibrationFor(unknownSid)).toBe(1);
  });

  it('ignores a non-string rid', () => {
    reqSummary('ok', { rid: 12345, in: 1000 });
    expect(sessionCalibrationFor(unknownSid)).toBe(1);
  });

  it('ignores a rid that was never registered against a session', () => {
    reqSummary('ok', { rid: 'rid-never-seen', in: 1000 });
    expect(writeContextStatusMock).not.toHaveBeenCalled();
    expect(sessionCalibrationFor(unknownSid)).toBe(1);
  });

  it('returns the identity factor for a falsy sid', () => {
    expect(sessionCalibrationFor(null)).toBe(1);
    expect(sessionCalibrationFor('')).toBe(1);
    expect(sessionCalibrationFor(undefined)).toBe(1);
  });

  it('leaves calibration alone on a non-ok verdict', () => {
    // Only an "ok" summary carries a billed count worth calibrating from. The
    // verdict strings come from VERDICTS.REQ in decide.js rather than being
    // spelled out here, so a rename of one breaks this test loudly.
    for (const verdict of VERDICTS.REQ.filter((v) => v !== 'ok')) {
      reqSummary(verdict, { rid: 'rid-unknown-2', in: 5000 });
    }
    expect(writeContextStatusMock).not.toHaveBeenCalled();
    expect(sessionCalibrationFor(unknownSid)).toBe(1);
  });

  it('ignores an ok summary whose token fields sum to zero', () => {
    reqSummary('ok', { rid: 'rid-unknown-3', in: 0, cr: 0, cw: 0 });
    expect(writeContextStatusMock).not.toHaveBeenCalled();
  });
});
