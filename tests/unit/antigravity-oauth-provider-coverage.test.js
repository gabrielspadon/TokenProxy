// Coverage for src/lib/oauth/providers/antigravity.js. Every URL and header
// expectation derives from the provider's own `config` export
// (ANTIGRAVITY_CONFIG), never a hardcoded literal. All network via a stubbed
// global fetch; postExchange's fire-and-forget onboarding loop runs under
// fake timers so its 5s sleeps cost nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import antigravity from '@/lib/oauth/providers/antigravity.js';

const cfg = antigravity.config;

function stubFetch(responder) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url), init);
    if (r instanceof Error) throw r;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('buildAuthUrl', () => {
  it('builds the authorize URL from the config with offline consent params', () => {
    const url = new URL(antigravity.buildAuthUrl(cfg, 'http://localhost:9/cb', 'st4te'));
    expect(`${url.origin}${url.pathname}`).toBe(cfg.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(cfg.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:9/cb');
    expect(url.searchParams.get('scope')).toBe(cfg.scopes.join(' '));
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('exchangeToken', () => {
  it('POSTs the code with client credentials to the config token URL', async () => {
    const { fn } = stubFetch(() => ({ json: { access_token: 'acc' } }));
    const out = await antigravity.exchangeToken(cfg, 'c0de', 'http://localhost:9/cb');
    expect(out).toEqual({ access_token: 'acc' });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe(cfg.tokenUrl);
    expect(init.body.get('grant_type')).toBe('authorization_code');
    expect(init.body.get('client_id')).toBe(cfg.clientId);
    expect(init.body.get('client_secret')).toBe(cfg.clientSecret);
    expect(init.body.get('code')).toBe('c0de');
    expect(init.body.get('redirect_uri')).toBe('http://localhost:9/cb');
  });

  it('throws with the upstream body text on a non-ok response', async () => {
    stubFetch(() => ({ ok: false, status: 400, text: 'bad_code' }));
    await expect(antigravity.exchangeToken(cfg, 'c', 'r')).rejects.toThrow(
      'Token exchange failed: bad_code'
    );
  });
});

describe('postExchange', () => {
  const tokens = { access_token: 'at-123' };

  it('returns userInfo and the default-tier projectId, then onboards until done', async () => {
    let onboardCalls = 0;
    const { fn } = stubFetch((url) => {
      if (url.startsWith(cfg.userInfoUrl)) return { json: { email: 'u@example.invalid' } };
      if (url === cfg.loadCodeAssistEndpoint)
        return {
          json: {
            cloudaicompanionProject: { id: 'proj-1' },
            allowedTiers: [
              { id: 'ignored', isDefault: false },
              { id: ' free-tier ', isDefault: true },
            ],
          },
        };
      if (url === cfg.onboardUserEndpoint) {
        onboardCalls += 1;
        return { json: { done: onboardCalls >= 2 } };
      }
      throw new Error(`unexpected url ${url}`);
    });

    vi.useFakeTimers();
    const out = await antigravity.postExchange(tokens);
    expect(out).toEqual({ userInfo: { email: 'u@example.invalid' }, projectId: 'proj-1' });

    // drain the fire-and-forget onboarding loop: first attempt not done,
    // second done=true breaks the loop after one 5s sleep.
    await vi.advanceTimersByTimeAsync(10000);
    expect(onboardCalls).toBe(2);

    const loadCall = fn.mock.calls.find(([u]) => String(u) === cfg.loadCodeAssistEndpoint);
    expect(loadCall[1].headers.Authorization).toBe(`Bearer ${tokens.access_token}`);
    expect(loadCall[1].headers['User-Agent']).toBe(cfg.loadCodeAssistUserAgent);
    const onboardCall = fn.mock.calls.find(([u]) => String(u) === cfg.onboardUserEndpoint);
    expect(JSON.parse(onboardCall[1].body).tierId).toBe('free-tier');
  });

  it('accepts a string cloudaicompanionProject with the default tier', async () => {
    const { fn } = stubFetch((url) => {
      if (url.startsWith(cfg.userInfoUrl)) return { ok: false, status: 401, text: 'no' };
      if (url === cfg.loadCodeAssistEndpoint)
        return { json: { cloudaicompanionProject: 'proj-str' } };
      if (url === cfg.onboardUserEndpoint) return { json: { done: true } };
      throw new Error(`unexpected url ${url}`);
    });
    vi.useFakeTimers();
    const out = await antigravity.postExchange(tokens);
    // non-ok userinfo → {}, string project id accepted, tiers absent → default tier kept
    expect(out).toEqual({ userInfo: {}, projectId: 'proj-str' });
    await vi.advanceTimersByTimeAsync(10000);
    const onboardCall = fn.mock.calls.find(([u]) => String(u) === cfg.onboardUserEndpoint);
    expect(JSON.parse(onboardCall[1].body).tierId).toBe('legacy-tier');
  });

  it('returns an empty projectId when loadCodeAssist is non-ok, and swallows a thrown load', async () => {
    stubFetch((url) => {
      if (url.startsWith(cfg.userInfoUrl)) return { json: {} };
      if (url === cfg.loadCodeAssistEndpoint) return { ok: false, status: 500, text: 'down' };
      throw new Error(`unexpected url ${url}`);
    });
    expect(await antigravity.postExchange(tokens)).toEqual({ userInfo: {}, projectId: '' });

    stubFetch((url) => {
      if (url.startsWith(cfg.userInfoUrl)) return { json: {} };
      if (url === cfg.loadCodeAssistEndpoint) return new Error('ECONNRESET');
      throw new Error(`unexpected url ${url}`);
    });
    expect(await antigravity.postExchange(tokens)).toEqual({ userInfo: {}, projectId: '' });
  });

  it('onboarding loop breaks on a thrown onboard fetch without surfacing', async () => {
    let onboardCalls = 0;
    stubFetch((url) => {
      if (url.startsWith(cfg.userInfoUrl)) return { json: {} };
      if (url === cfg.loadCodeAssistEndpoint)
        return { json: { cloudaicompanionProject: { id: 'p' }, allowedTiers: 'not-an-array' } };
      if (url === cfg.onboardUserEndpoint) {
        onboardCalls += 1;
        return new Error('network down');
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.useFakeTimers();
    const out = await antigravity.postExchange(tokens);
    expect(out.projectId).toBe('p');
    await vi.advanceTimersByTimeAsync(60000);
    expect(onboardCalls).toBe(1); // thrown fetch breaks the retry loop
  });

  it('onboarding retries when the onboard response is non-ok', async () => {
    let onboardCalls = 0;
    stubFetch((url) => {
      if (url.startsWith(cfg.userInfoUrl)) return { json: {} };
      if (url === cfg.loadCodeAssistEndpoint)
        return { json: { cloudaicompanionProject: { id: 'p2' } } };
      if (url === cfg.onboardUserEndpoint) {
        onboardCalls += 1;
        return onboardCalls < 2
          ? { ok: false, status: 429, text: 'slow down' }
          : { json: { done: true } };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.useFakeTimers();
    await antigravity.postExchange(tokens);
    await vi.advanceTimersByTimeAsync(20000);
    expect(onboardCalls).toBe(2);
  });
});

describe('mapTokens', () => {
  it('maps snake_case token fields and folds in postExchange extras', () => {
    const out = antigravity.mapTokens(
      { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 's' },
      { userInfo: { email: 'e@example.invalid' }, projectId: 'p' }
    );
    expect(out).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 3600,
      scope: 's',
      email: 'e@example.invalid',
      projectId: 'p',
    });
  });

  it('tolerates a missing extras bag', () => {
    const out = antigravity.mapTokens({ access_token: 'a' });
    expect(out.email).toBeUndefined();
    expect(out.projectId).toBeUndefined();
  });
});
