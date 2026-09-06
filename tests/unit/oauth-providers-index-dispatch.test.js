import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Dispatch contracts for the provider registry front door
// (src/lib/oauth/providers/index.js). Everything is asserted against the
// registry's own PROVIDERS map and per-provider config, never literals.
// All network via stubbed fetch / mocked provider methods.

// index.js calls installGlobalProxyFetch() at import time, which swaps the
// global fetch for its proxy wrapper and hides the vi.stubGlobal mock. No-op it.
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  installGlobalProxyFetch: () => {},
  default: (...args) => globalThis.fetch(...args),
}));

vi.mock('@/lib/localDb', () => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const loadIndex = () => import('@/lib/oauth/providers/index.js');

describe('getProvider / getProviderNames', () => {
  it('returns the registry entry for every listed name and throws on an unknown one', async () => {
    const mod = await loadIndex();
    const names = mod.getProviderNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(mod.getProvider(name)).toBe(mod.PROVIDERS[name]);
    }
    expect(() => mod.getProvider('definitely-not-a-provider')).toThrow(/Unknown provider/);
  });

  it('maps the legacy kimi-coding alias onto the kimi entry', async () => {
    const mod = await loadIndex();
    expect(mod.getProvider('kimi-coding')).toBe(mod.PROVIDERS.kimi);
  });
});

describe('generateAuthData', () => {
  it('returns a null authUrl and provider callback metadata for a device_code provider', async () => {
    const mod = await loadIndex();
    const name = mod
      .getProviderNames()
      .find((n) => mod.PROVIDERS[n].flowType === 'device_code' && !mod.PROVIDERS[n].prepareConfig);
    const provider = mod.PROVIDERS[name];
    const data = await mod.generateAuthData(name, 'http://127.0.0.1:1/cb');
    expect(data.authUrl).toBeNull();
    expect(data.flowType).toBe('device_code');
    expect(data.fixedPort).toBe(provider.fixedPort);
    expect(data.callbackPath).toBe(provider.callbackPath || '/callback');
    expect(data.state).toBeTruthy();
    expect(data.codeVerifier).toBeTruthy();
  });

  it('passes state and codeChallenge into buildAuthUrl for a PKCE provider, plain state otherwise', async () => {
    const mod = await loadIndex();
    const pkceName = mod
      .getProviderNames()
      .find(
        (n) =>
          mod.PROVIDERS[n].flowType === 'authorization_code_pkce' && !mod.PROVIDERS[n].prepareConfig
      );
    const plainName = mod
      .getProviderNames()
      .find(
        (n) => mod.PROVIDERS[n].flowType === 'authorization_code' && !mod.PROVIDERS[n].prepareConfig
      );

    for (const [name, expectChallenge] of [
      [pkceName, true],
      [plainName, false],
    ]) {
      const provider = mod.PROVIDERS[name];
      const spy = vi
        .spyOn(provider, 'buildAuthUrl')
        .mockReturnValue('https://example.invalid/auth');
      const data = await mod.generateAuthData(name, 'http://127.0.0.1:1/cb');
      expect(data.authUrl).toBe('https://example.invalid/auth');
      const [cfg, redirect, state, challenge] = spy.mock.calls[0];
      expect(cfg).toBe(provider.config);
      expect(redirect).toBe('http://127.0.0.1:1/cb');
      expect(state).toBe(data.state);
      if (expectChallenge) expect(challenge).toBe(data.codeChallenge);
      else expect(challenge).toBeUndefined();
      spy.mockRestore();
    }
  });

  it('runs prepareConfig with meta and honours config-provided state/verifier overrides', async () => {
    const mod = await loadIndex();
    const name = mod.getProviderNames().find((n) => mod.PROVIDERS[n].prepareConfig);
    const provider = mod.PROVIDERS[name];
    const prep = vi.spyOn(provider, 'prepareConfig').mockImplementation(async (config) => ({
      ...config,
      loginTraceID: 'trace-override',
      privateKeyVerifier: 'pk-override',
    }));
    const build = vi
      .spyOn(provider, 'buildAuthUrl')
      .mockReturnValue('https://example.invalid/auth');
    const data = await mod.generateAuthData(name, 'http://127.0.0.1:1/cb', { hint: 1 });
    expect(prep).toHaveBeenCalledWith(provider.config, { hint: 1 });
    expect(data.state).toBe('trace-override');
    expect(data.codeVerifier).toBe('pk-override');
    prep.mockRestore();
    build.mockRestore();
  });
});

describe('exchangeTokens', () => {
  it('threads code/verifier/state through exchangeToken, then postExchange, then mapTokens', async () => {
    const mod = await loadIndex();
    const name = mod
      .getProviderNames()
      .find((n) => !mod.PROVIDERS[n].prepareConfig && mod.PROVIDERS[n].exchangeToken);
    const provider = mod.PROVIDERS[name];
    const raw = { access_token: 'at' };
    const mapped = { accessToken: 'at' };
    const ex = vi.spyOn(provider, 'exchangeToken').mockResolvedValue(raw);
    const map = vi.spyOn(provider, 'mapTokens').mockReturnValue(mapped);
    const hadPost = typeof provider.postExchange === 'function';
    const post = hadPost
      ? vi.spyOn(provider, 'postExchange').mockResolvedValue({ extra: 1 })
      : null;

    const out = await mod.exchangeTokens(
      name,
      'code-1',
      'http://127.0.0.1:1/cb',
      'ver-1',
      'state-1'
    );
    expect(out).toBe(mapped);
    expect(ex).toHaveBeenCalledWith(
      provider.config,
      'code-1',
      'http://127.0.0.1:1/cb',
      'ver-1',
      'state-1',
      {}
    );
    expect(map).toHaveBeenCalledWith(raw, hadPost ? { extra: 1 } : null);
    ex.mockRestore();
    map.mockRestore();
    post?.mockRestore();
  });
});

describe('device code flow dispatch', () => {
  it('refuses requestDeviceCode and pollForToken for a non-device-code provider', async () => {
    const mod = await loadIndex();
    const name = mod.getProviderNames().find((n) => mod.PROVIDERS[n].flowType !== 'device_code');
    await expect(mod.requestDeviceCode(name, 'chal')).rejects.toThrow(
      /does not support device code flow/
    );
    await expect(mod.pollForToken(name, 'dc', 'v')).rejects.toThrow(
      /does not support device code flow/
    );
  });

  it('delegates requestDeviceCode to the provider with its own config', async () => {
    const mod = await loadIndex();
    const name = mod.getProviderNames().find((n) => mod.PROVIDERS[n].flowType === 'device_code');
    const provider = mod.PROVIDERS[name];
    const spy = vi.spyOn(provider, 'requestDeviceCode').mockResolvedValue({ deviceCode: 'dc' });
    await expect(mod.requestDeviceCode(name, 'chal')).resolves.toEqual({ deviceCode: 'dc' });
    expect(spy).toHaveBeenCalledWith(provider.config, 'chal', {});
    spy.mockRestore();
  });

  function deviceProvider(mod, exclude = []) {
    return mod
      .getProviderNames()
      .find((n) => mod.PROVIDERS[n].flowType === 'device_code' && !exclude.includes(n));
  }

  it('maps a token payload to success via postExchange + mapTokens', async () => {
    const mod = await loadIndex();
    const name = deviceProvider(mod, ['kiro']);
    const provider = mod.PROVIDERS[name];
    const poll = vi
      .spyOn(provider, 'pollToken')
      .mockResolvedValue({ ok: true, data: { access_token: 'at' } });
    const map = vi.spyOn(provider, 'mapTokens').mockReturnValue({ accessToken: 'at' });
    const post =
      typeof provider.postExchange === 'function'
        ? vi.spyOn(provider, 'postExchange').mockResolvedValue(null)
        : null;
    const out = await mod.pollForToken(name, 'dc', 'v');
    expect(out).toEqual({ success: true, tokens: { accessToken: 'at' } });
    poll.mockRestore();
    map.mockRestore();
    post?.mockRestore();
  });

  it('reports pending for authorization_pending and slow_down without failing', async () => {
    const mod = await loadIndex();
    const name = deviceProvider(mod);
    const provider = mod.PROVIDERS[name];
    const poll = vi.spyOn(provider, 'pollToken');

    poll.mockResolvedValueOnce({
      ok: true,
      data: { error: 'authorization_pending', error_description: 'wait' },
    });
    let out = await mod.pollForToken(name, 'dc', 'v');
    expect(out).toEqual({
      success: false,
      error: 'authorization_pending',
      errorDescription: 'wait',
      pending: true,
    });

    poll.mockResolvedValueOnce({ ok: true, data: { error: 'slow_down', message: 'slower' } });
    out = await mod.pollForToken(name, 'dc', 'v');
    expect(out).toEqual({
      success: false,
      error: 'slow_down',
      errorDescription: 'slower',
      pending: false,
    });
    poll.mockRestore();
  });

  it('surfaces a terminal error, defaults when no access token, and passes through non-ok results', async () => {
    const mod = await loadIndex();
    const name = deviceProvider(mod);
    const provider = mod.PROVIDERS[name];
    const poll = vi.spyOn(provider, 'pollToken');

    poll.mockResolvedValueOnce({
      ok: true,
      data: { error: 'expired_token', error_description: 'gone' },
    });
    let out = await mod.pollForToken(name, 'dc', 'v');
    expect(out).toEqual({ success: false, error: 'expired_token', errorDescription: 'gone' });

    poll.mockResolvedValueOnce({ ok: true, data: {} });
    out = await mod.pollForToken(name, 'dc', 'v');
    expect(out.error).toBe('no_access_token');

    poll.mockResolvedValueOnce({
      ok: false,
      data: { error: 'server_error', error_description: 'boom' },
    });
    out = await mod.pollForToken(name, 'dc', 'v');
    expect(out).toEqual({ success: false, error: 'server_error', errorDescription: 'boom' });
    poll.mockRestore();
  });

  it('resolves a missing kiro profileArn through the profile endpoint after a token success', async () => {
    const mod = await loadIndex();
    const provider = mod.PROVIDERS.kiro;
    const poll = vi
      .spyOn(provider, 'pollToken')
      .mockResolvedValue({ ok: true, data: { access_token: 'at' } });
    const post =
      typeof provider.postExchange === 'function'
        ? vi.spyOn(provider, 'postExchange').mockResolvedValue(null)
        : null;
    const map = vi.spyOn(provider, 'mapTokens').mockReturnValue({
      accessToken: 'at',
      providerSpecificData: {},
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ profiles: [{ arn: ' arn:aws:profile/x ' }] }),
    });
    const out = await mod.pollForToken('kiro', 'dc', 'v');
    expect(out.success).toBe(true);
    expect(out.tokens.providerSpecificData.profileArn).toBe('arn:aws:profile/x');
    poll.mockRestore();
    map.mockRestore();
    post?.mockRestore();
  });
});

describe('backfillCodexEmails', () => {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const makeJwt = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

  it('patches codex oauth connections missing email/account info, once per process', async () => {
    const db = await import('@/lib/localDb');
    db.getProviderConnections.mockResolvedValue([
      {
        id: 1,
        provider: 'codex',
        authType: 'oauth',
        idToken: makeJwt({
          email: 'a@b',
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'plus' },
        }),
      },
      { id: 2, provider: 'codex', authType: 'oauth', idToken: makeJwt({}) }, // undecodable info → skipped
      { id: 3, provider: 'claude', authType: 'oauth', idToken: 'x' }, // wrong provider → filtered
      {
        id: 4,
        provider: 'codex',
        authType: 'oauth',
        idToken: makeJwt({ email: 'c@d' }),
        email: 'c@d',
        providerSpecificData: { chatgptAccountId: 'has' },
      }, // complete → filtered
    ]);
    const mod = await loadIndex();
    await mod.backfillCodexEmails();

    expect(db.updateProviderConnection).toHaveBeenCalledTimes(1);
    const [id, patch] = db.updateProviderConnection.mock.calls[0];
    expect(id).toBe(1);
    expect(patch.email).toBe('a@b');
    expect(patch.providerSpecificData).toMatchObject({
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
    });

    // run-once guard
    await mod.backfillCodexEmails();
    expect(db.getProviderConnections).toHaveBeenCalledTimes(1);
  });

  it('resets the run-once guard when the DB read fails, so a later call retries', async () => {
    const db = await import('@/lib/localDb');
    db.getProviderConnections.mockRejectedValueOnce(new Error('db down'));
    const mod = await loadIndex();
    await mod.backfillCodexEmails(); // swallows, logs
    db.getProviderConnections.mockResolvedValueOnce([]);
    await mod.backfillCodexEmails();
    expect(db.getProviderConnections).toHaveBeenCalledTimes(2);
  });
});
