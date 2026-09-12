// Coverage for open-sse/services/tokenRefresh/providers.js error and delegate
// paths: xai classification, the thin delegate wrappers, kiro external_idp,
// kiro AWS/social failures, copilot/codebuddy/trae failure and catch
// exits. proxyAwareFetch captures globalThis.fetch at import time, so the
// network seam is the proxyFetch module itself, mocked below; nothing here
// can reach the wire. Tokens are unique per test so the module's 10s dedup
// cache never crosses cases.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: vi.fn(),
  installGlobalProxyFetch: () => {},
}));

let mod;
let proxyFetch;

beforeEach(async () => {
  mod = await import('../../open-sse/services/tokenRefresh/providers.js');
  ({ proxyAwareFetch: proxyFetch } = await import('../../open-sse/utils/proxyFetch.js'));
  proxyFetch.mockReset();
});

function respondWith(payload, { ok = true, status = 200 } = {}) {
  proxyFetch.mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

function respondThrow(message = 'boom') {
  proxyFetch.mockRejectedValue(new Error(message));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('refreshXaiToken failure classification', () => {
  it('maps an invalid_grant service error to the closed error shape', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/oauth/services/xai.js', () => ({
      XaiService: class {
        async refreshAccessToken() {
          throw new Error('invalid_grant: token revoked');
        }
      },
    }));
    const fresh = await import('../../open-sse/services/tokenRefresh/providers.js');
    const out = await fresh.refreshXaiToken(`xai-ig-${Date.now()}`, null);
    expect(out).toEqual({ error: 'invalid_grant' });
    vi.doUnmock('../../src/lib/oauth/services/xai.js');
    vi.resetModules();
  });

  it('returns null for a non-grant service error and for a missing token', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/oauth/services/xai.js', () => ({
      XaiService: class {
        async refreshAccessToken() {
          throw new Error('ECONNRESET');
        }
      },
    }));
    const fresh = await import('../../open-sse/services/tokenRefresh/providers.js');
    expect(await fresh.refreshXaiToken(`xai-net-${Date.now()}`, null)).toBeNull();
    expect(await fresh.refreshXaiToken('', null)).toBeNull();
    vi.doUnmock('../../src/lib/oauth/services/xai.js');
    vi.resetModules();
  });
});

describe('thin delegate wrappers reach the generic refresh', () => {
  it.each([
    ['refreshKimiToken', (m, t) => m.refreshKimiToken(t, {}, null)],
    ['refreshClaudeOAuthToken', (m, t) => m.refreshClaudeOAuthToken(t, null)],
    ['refreshIflowToken', (m, t) => m.refreshIflowToken(t, null)],
    ['refreshGitHubToken', (m, t) => m.refreshGitHubToken(t, null)],
  ])('%s returns the refreshed token pair', async (name, call) => {
    respondWith({ access_token: 'acc', refresh_token: 'rot', expires_in: 60 });
    const out = await call(mod, `${name}-${Date.now()}`);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ accessToken: 'acc', refreshToken: 'rot', expiresIn: 60 });
  });
});

describe('issueRecord keeps the earliest persisted issue time', () => {
  it('a persisted refreshTokenIssuedAt earlier than firstSeen backdates the record', async () => {
    const token = `issue-backdate-${Date.now()}`;
    const conn = { connectionId: `conn-${Date.now()}` };
    respondWith({ access_token: 'a1', expires_in: 60 });
    await mod.refreshAccessToken('github', token, conn, null);
    // Same conn+token again with an earlier persisted issue timestamp: takes
    // the existing-record branch and lowers firstSeen. Dedup serves the cached
    // result, but the record bookkeeping runs before dedup.
    const earlier = new Date(Date.now() - 86400000).toISOString();
    const out = await mod.refreshAccessToken(
      'github',
      token,
      { ...conn, refreshTokenIssuedAt: earlier },
      null
    );
    expect(out).toMatchObject({ accessToken: 'a1' });
  });
});

describe('refreshCodexToken transient failure', () => {
  it('returns null on a non-permanent HTTP failure', async () => {
    respondWith({ error: 'server_error' }, { ok: false, status: 503 });
    expect(await mod.refreshCodexToken(`codex-503-${Date.now()}`, null)).toBeNull();
  });
});

describe('refreshKiroToken external_idp', () => {
  // login.microsoftonline.com is on the module's own Microsoft endpoint
  // allowlist (src/lib/oauth/kiroExternalIdp.js), a validation constraint,
  // not a network target: proxyAwareFetch is mocked.
  const idpData = {
    authMethod: 'external_idp',
    clientId: 'cid',
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid offline_access',
  };

  it('returns tokens plus the normalized providerSpecificData on success', async () => {
    respondWith({ access_token: 'idp-acc', refresh_token: 'idp-rot', expires_in: 60 });
    const out = await mod.refreshKiroToken(`kiro-idp-ok-${Date.now()}`, idpData, null);
    expect(out).toMatchObject({ accessToken: 'idp-acc', refreshToken: 'idp-rot', expiresIn: 60 });
    expect(out.providerSpecificData).toMatchObject({ authMethod: 'external_idp', clientId: 'cid' });
    const body = proxyFetch.mock.calls[0][1].body;
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('returns null on an HTTP failure and on invalid refresh config', async () => {
    respondWith({ error: 'invalid_grant' }, { ok: false, status: 400 });
    const log = { warn: vi.fn(), error: vi.fn() };
    expect(await mod.refreshKiroToken(`kiro-idp-bad-${Date.now()}`, idpData, log)).toBeNull();
    // Missing clientId/scope makes buildExternalIdpRefreshParams throw -> null
    expect(
      await mod.refreshKiroToken(`kiro-idp-cfg-${Date.now()}`, { authMethod: 'external_idp' }, log)
    ).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('refreshKiroToken AWS and social failure exits', () => {
  it('IDC/AWS path returns null on an HTTP failure', async () => {
    respondWith({ error: 'nope' }, { ok: false, status: 400 });
    const out = await mod.refreshKiroToken(
      `kiro-aws-bad-${Date.now()}`,
      { clientId: 'c', clientSecret: 's' },
      null
    );
    expect(out).toBeNull();
  });

  it('social path returns null on an HTTP failure', async () => {
    respondWith({ error: 'nope' }, { ok: false, status: 400 });
    expect(await mod.refreshKiroToken(`kiro-soc-bad-${Date.now()}`, {}, null)).toBeNull();
  });

  it('social path success returns the token pair without a profileArn refetch when one is stored', async () => {
    respondWith({ accessToken: 'soc-acc', refreshToken: 'soc-rot', expiresIn: 60 });
    const out = await mod.refreshKiroToken(
      `kiro-soc-ok-${Date.now()}`,
      { profileArn: 'arn:aws:iam::0:profile/x' },
      null
    );
    expect(out).toMatchObject({ accessToken: 'soc-acc', refreshToken: 'soc-rot', expiresIn: 60 });
  });
});

describe('refreshCopilotToken failure exits', () => {
  it('returns null on HTTP failure, thrown fetch, and missing input token', async () => {
    respondWith({ message: 'bad' }, { ok: false, status: 401 });
    expect(await mod.refreshCopilotToken(`gh-cop-bad-${Date.now()}`, null)).toBeNull();
    respondThrow('ECONNREFUSED');
    expect(await mod.refreshCopilotToken(`gh-cop-net-${Date.now()}`, null)).toBeNull();
    expect(await mod.refreshCopilotToken('', null)).toBeNull();
  });
});

describe('codebuddy cn/intl failure exits', () => {
  it.each(['refreshCodebuddyToken', 'refreshCodebuddyIntlToken'])(
    '%s returns null on HTTP failure and on a code!=0 payload',
    async (fnName) => {
      respondWith({ code: 1, msg: 'denied' }, { ok: false, status: 403 });
      expect(await mod[fnName](`cb-http-${fnName}-${Date.now()}`, null)).toBeNull();
      respondWith({ code: 1, msg: 'denied' });
      expect(await mod[fnName](`cb-code-${fnName}-${Date.now()}`, null)).toBeNull();
    }
  );
});

describe('refreshTraeToken catch exit', () => {
  it('returns null when the fetch throws', async () => {
    respondThrow('reset');
    expect(await mod.refreshTraeToken(`trae-net-${Date.now()}`, {}, null)).toBeNull();
  });
});

describe('provider error log sanitization', () => {
  const opaque = 'opaque-canary {"refresh_token":"rotated-secret"}\nhttps://idp.invalid/error?token=secret';

  it.each([
    ['generic', (log, token) => mod.refreshAccessToken('github', token, {}, log)],
    ['codex', (log, token) => mod.refreshCodexToken(token, log)],
    ['kiro-aws', (log, token) => mod.refreshKiroToken(token, { clientId: 'client', clientSecret: 'secret' }, log)],
    ['kiro-social', (log, token) => mod.refreshKiroToken(token, {}, log)],
    ['copilot', (log, token) => mod.refreshCopilotToken(token, log)],
    ['codebuddy', (log, token) => mod.refreshCodebuddyToken(token, log)],
    ['codebuddy-intl', (log, token) => mod.refreshCodebuddyIntlToken(token, log)],
  ])('%s keeps opaque response bodies out of structured logs', async (name, call) => {
    respondWith({ error: opaque, message: opaque }, { ok: false, status: 503 });
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    await call(log, `sanitized-http-${name}-${Date.now()}`);
    const output = JSON.stringify([...log.error.mock.calls, ...log.warn.mock.calls]);
    expect(output).not.toContain('opaque-canary');
    expect(output).not.toContain('rotated-secret');
    expect(output).not.toContain('idp.invalid');
    expect(output).toContain('503');
    expect(output).toContain('reason');
  });

  it.each([
    ['generic', (log, token) => mod.refreshAccessToken('github', token, {}, log)],
    ['codex', (log, token) => mod.refreshCodexToken(token, log)],
    ['copilot', (log, token) => mod.refreshCopilotToken(token, log)],
    ['codebuddy', (log, token) => mod.refreshCodebuddyToken(token, log)],
    ['codebuddy-intl', (log, token) => mod.refreshCodebuddyIntlToken(token, log)],
  ])('%s keeps thrown opaque errors out of logs', async (name, call) => {
    respondThrow(opaque);
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    await call(log, `sanitized-throw-${name}-${Date.now()}`);
    const output = JSON.stringify([...log.error.mock.calls, ...log.warn.mock.calls]);
    expect(output).not.toContain('opaque-canary');
    expect(output).not.toContain('rotated-secret');
    expect(output).not.toContain('idp.invalid');
    expect(output).toContain('reason');
  });
});
