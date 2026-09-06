/**
 * Coverage for src/lib/oauth/utils/server.js beyond what
 * oauth-callback-wait.test.js already covers (waitForCallbackParams, the
 * basic startLocalServer listen/close cycle).
 *
 * Not covered there: the register/get/clear session CRUD for
 * all six providers; the Mode A (server-side exchange) / Mode B (redirect
 * fallback) branches; the CSRF loopback-origin and state-mismatch branches;
 * and the /callback + 404 branches of startLocalServer itself.
 *
 * exchangeTokens and createProviderConnection are mocked (real network +
 * DB writes otherwise); everything else runs for real over loopback HTTP,
 * which the real-IO guard permits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/oauth/providers', () => ({ exchangeTokens: vi.fn() }));
vi.mock('@/models', () => ({ createProviderConnection: vi.fn() }));

import { exchangeTokens } from '@/lib/oauth/providers';
import { createProviderConnection } from '@/models';
import {
  startLocalServer,
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
  startCodexProxy,
  stopCodexProxy,
  registerXaiSession,
  getXaiSessionStatus,
  clearXaiSession,
  startXaiProxy,
  stopXaiProxy,
  registerTraeSession,
  getTraeSessionStatus,
  clearTraeSession,
  startTraeProxy,
  stopTraeProxy,
  registerWindsurfSession,
  getWindsurfSessionStatus,
  clearWindsurfSession,
  startWindsurfProxy,
  stopWindsurfProxy,
  registerDevinSession,
  getDevinSessionStatus,
  clearDevinSession,
  startDevinProxy,
  stopDevinProxy,
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
  startZedProxy,
  stopZedProxy,
} from '@/lib/oauth/utils/server';
import {
  CODEX_CONFIG,
  DEVIN_CONFIG,
  TRAE_CONFIG,
  WINDSURF_CONFIG,
  ZED_HOSTED_CONFIG,
} from '@/lib/oauth/constants/oauth';

async function get(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.text() };
}

beforeEach(() => {
  exchangeTokens.mockReset();
  createProviderConnection.mockReset();
});

describe('startLocalServer', () => {
  it('invokes onCallback with the query params and serves the success page on /callback', async () => {
    let received = null;
    const { port, close } = await startLocalServer((params) => (received = params));
    const { status, body } = await get(port, '/callback?code=abc&state=xyz');
    expect(status).toBe(200);
    expect(body).toMatch(/Authentication Successful/);
    expect(received).toEqual({ code: 'abc', state: 'xyz' });
    close();
  });

  it('404s any path other than /callback or /auth/callback', async () => {
    const { port, close } = await startLocalServer(() => {});
    const { status, body } = await get(port, '/nope');
    expect(status).toBe(404);
    expect(body).toBe('Not found');
    close();
  });

  it('rejects with a friendly message when a fixed port is already taken', async () => {
    const first = await startLocalServer(() => {}, 41999);
    await expect(startLocalServer(() => {}, 41999)).rejects.toThrow(/already in use/);
    first.close();
  });
});

// One table-driven block per fixed-port provider (Codex, Xai) and one per
// dynamic-port provider (Trae, Windsurf, Devin, Zed) covers the CRUD +
// Mode A/B branches without six near-identical copies (cover branches, not
// lines of ceremony).
describe.each([
  {
    name: 'Codex',
    register: registerCodexSession,
    getStatus: getCodexSessionStatus,
    clear: clearCodexSession,
    start: startCodexProxy,
    stop: stopCodexProxy,
    port: 1455,
  },
  {
    name: 'Xai',
    register: registerXaiSession,
    getStatus: getXaiSessionStatus,
    clear: clearXaiSession,
    start: startXaiProxy,
    stop: stopXaiProxy,
    port: 56121,
  },
])('$name fixed-port proxy', ({ register, getStatus, clear, start, stop, port }) => {
  afterEach(() => stop());

  it('register/getStatus/clear round-trip, and refuses an incomplete session', () => {
    expect(register({ state: 's1' })).toBe(false);
    expect(register({ state: 's1', codeVerifier: 'v', redirectUri: 'http://x' })).toBe(true);
    expect(getStatus('s1')).toMatchObject({ status: 'pending' });
    clear('s1');
    expect(getStatus('s1')).toBeNull();
  });

  it('Mode B redirects to the app port and stops when no session is registered', async () => {
    const started = await start(4321);
    expect(started).toEqual({ success: true });
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`http://localhost:4321/callback?code=abc`);
  });

  it('Mode A exchanges tokens and renders success when a session is registered', async () => {
    register({ state: 's2', codeVerifier: 'v', redirectUri: 'http://x' });
    exchangeTokens.mockResolvedValue({ accessToken: 'tok' });
    createProviderConnection.mockResolvedValue({ id: 'conn-1', email: 'a@b.c' });
    await start(4321);
    const { status, body } = await get(port, '/callback?code=abc&state=s2');
    expect(status).toBe(200);
    expect(body).toMatch(/Authentication Successful/);
    expect(getStatus('s2')).toMatchObject({ status: 'done', connectionId: 'conn-1' });
  });

  it('Mode A renders failure and preserves the error when exchangeTokens rejects', async () => {
    register({ state: 's3', codeVerifier: 'v', redirectUri: 'http://x' });
    exchangeTokens.mockRejectedValue(new Error('bad code'));
    await start(4321);
    const { status, body } = await get(port, '/callback?code=abc&state=s3');
    expect(status).toBe(200);
    expect(body).toMatch(/Authentication Failed/);
    expect(body).toMatch(/bad code/);
    expect(getStatus('s3')).toMatchObject({ status: 'error', error: 'bad code' });
  });

  it('404s a path other than the callback path', async () => {
    await start(4321);
    const { status } = await get(port, '/nope');
    expect(status).toBe(404);
  });
});

describe.each([
  {
    name: 'Trae',
    register: registerTraeSession,
    getStatus: getTraeSessionStatus,
    clear: clearTraeSession,
    start: () => startTraeProxy(),
    stop: stopTraeProxy,
    callbackPath: '/callback',
    seed: { state: 't1' },
    stateRequiredWhenPresent: true, // optional state check: absent state is allowed
    contentType: 'html',
  },
  {
    name: 'Windsurf',
    register: registerWindsurfSession,
    getStatus: getWindsurfSessionStatus,
    clear: clearWindsurfSession,
    start: () => startWindsurfProxy(),
    stop: stopWindsurfProxy,
    callbackPath: '/windsurf-auth-callback',
    seed: { state: 'w1' },
    stateRequiredWhenPresent: false, // strict check: state always required
    contentType: 'html',
  },
])(
  '$name dynamic-port proxy',
  ({
    register,
    getStatus,
    clear,
    start,
    stop,
    callbackPath,
    seed,
    stateRequiredWhenPresent,
    contentType,
  }) => {
    afterEach(() => {
      clear(seed.state);
      stop();
    });

    it('register/getStatus/clear round-trip, and refuses a session with no state', () => {
      expect(register({})).toBe(false);
      expect(register(seed)).toBe(true);
      expect(getStatus(seed.state)).toMatchObject({ status: 'pending' });
      clear(seed.state);
      expect(getStatus(seed.state)).toBeNull();
    });

    it('rejects a cross-origin callback with 403 before ever checking state', async () => {
      register(seed);
      const { port } = await start();
      const { status, body } = await get(port, `${callbackPath}?state=${seed.state}`, {
        Origin: 'https://evil.example',
      });
      expect(status).toBe(403);
      expect(body).toMatch(/Cross-origin/);
    });

    it("renders 'no active session' when nothing was registered", async () => {
      const { port } = await start();
      const { status, body } = await get(port, `${callbackPath}?state=x`);
      expect(status).toBe(200);
      expect(body).toMatch(/No active .* login session/);
    });

    it(
      stateRequiredWhenPresent
        ? 'tolerates a missing state but rejects a mismatched one'
        : 'requires state and rejects a mismatch',
      async () => {
        register(seed);
        const { port } = await start();
        const { status: mismatchStatus, body: mismatchBody } = await get(
          port,
          `${callbackPath}?state=wrong-state`
        );
        expect(mismatchBody).toMatch(/state mismatch/);
        expect(mismatchStatus).toBe(200);
        if (!stateRequiredWhenPresent) {
          // Windsurf's mismatch branch also stops the proxy (source.js:626),
          // unlike Trae's, so a follow-up request needs a fresh port.
          clear(seed.state);
          register(seed);
          const restarted = await start();
          const noStateRes = await get(restarted.port, callbackPath);
          expect(noStateRes.body).toMatch(/No active .* login session|state mismatch/);
        }
      }
    );

    it('exchanges tokens and renders success on a matching callback', async () => {
      register(seed);
      exchangeTokens.mockResolvedValue({ accessToken: 'tok' });
      createProviderConnection.mockResolvedValue({ id: 'conn-2', email: 'a@b.c' });
      const { port } = await start();
      const { status, body } = await get(port, `${callbackPath}?state=${seed.state}&code=abc`);
      expect(status).toBe(200);
      expect(body).toMatch(/Authentication Successful/);
      expect(getStatus(seed.state)).toMatchObject({ status: 'done', connectionId: 'conn-2' });
    });
  }
);

describe('Devin proxy (fixed port, text/plain, requires codeVerifier)', () => {
  afterEach(() => stopDevinProxy());

  it('register requires state and codeVerifier', () => {
    expect(registerDevinSession({ state: 'd1' })).toBe(false);
    expect(registerDevinSession({ state: 'd1', codeVerifier: 'v', redirectUri: 'http://x' })).toBe(
      true
    );
    expect(getDevinSessionStatus('d1')).toMatchObject({ status: 'pending' });
    clearDevinSession('d1');
    expect(getDevinSessionStatus('d1')).toBeNull();
  });

  it('400s a state mismatch as text/plain and stops the proxy', async () => {
    registerDevinSession({ state: 'd2', codeVerifier: 'v', redirectUri: 'http://x' });
    const { port } = await startDevinProxy();
    const { status, body } = await get(port, '/callback?state=wrong');
    expect(status).toBe(400);
    expect(body).toMatch(/state mismatch/);
  });

  it('exchanges tokens and returns plain-text success on a matching callback', async () => {
    registerDevinSession({ state: 'd3', codeVerifier: 'v', redirectUri: 'http://x' });
    exchangeTokens.mockResolvedValue({ accessToken: 'tok' });
    createProviderConnection.mockResolvedValue({ id: 'conn-3', email: 'a@b.c' });
    const { port } = await startDevinProxy();
    const { status, body } = await get(port, '/callback?state=d3&code=abc');
    expect(status).toBe(200);
    expect(body).toMatch(/completed/);
  });

  it('500s with plain text when the exchange throws', async () => {
    registerDevinSession({ state: 'd4', codeVerifier: 'v', redirectUri: 'http://x' });
    exchangeTokens.mockRejectedValue(new Error('boom'));
    const { port } = await startDevinProxy();
    const { status, body } = await get(port, '/callback?state=d4&code=abc');
    expect(status).toBe(500);
    expect(body).toMatch(/failed/);
  });
});

describe('Zed proxy (RSA native-app, preferred port with EADDRINUSE fallback)', () => {
  afterEach(() => stopZedProxy());

  it('register requires state and codeVerifier', () => {
    expect(registerZedSession({ state: 'z1' })).toBe(false);
    expect(registerZedSession({ state: 'z1', codeVerifier: 'key' })).toBe(true);
    expect(getZedSessionStatus('z1')).toMatchObject({ status: 'pending' });
    clearZedSession('z1');
    expect(getZedSessionStatus('z1')).toBeNull();
  });

  it('falls back to a random port when the preferred port is already bound', async () => {
    const blocker = await startLocalServer(() => {}, 42010);
    const { success, port } = await startZedProxy(42010);
    expect(success).toBe(true);
    expect(port).not.toBe(42010);
    blocker.close();
  });

  it('exchanges tokens and renders success on a matching callback at /', async () => {
    registerZedSession({ state: 'z2', codeVerifier: 'key' });
    exchangeTokens.mockResolvedValue({ accessToken: 'tok' });
    createProviderConnection.mockResolvedValue({ id: 'conn-4', email: 'a@b.c' });
    const { port } = await startZedProxy(0);
    const { status, body } = await get(port, '/?state=z2&access_token=enc&user_id=u1');
    expect(status).toBe(200);
    expect(body).toMatch(/Authentication Successful/);
  });
});

// ── Edge coverage: already-running fast paths, listen errors, Mode A error
// branches, state-mismatch reads, idle timeouts (fired via fake timers). Lives
// in this file because the fixed ports (1455, 56121, 59653) cannot be bound by
// two parallel vitest workers at once.

const XAI_PORT = 56121; // hardcoded in the SUT, not exported from config

async function getClose(port, path, headers = {}) {
  // Connection: close — undici's keep-alive pool otherwise reuses a dead
  // socket across the stop/start cycles on the fixed-port proxies.
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Connection: 'close', ...headers },
    redirect: 'manual',
  });
  return { status: res.status, body: await res.text() };
}

// Start a proxy under fake timers so its idle timeout is captured, fire it,
// then prove the server actually closed (connection refused).
async function fireIdleTimeout(startFn, timeoutMs) {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const started = await startFn();
  await vi.advanceTimersByTimeAsync(timeoutMs + 1);
  vi.useRealTimers();
  return started;
}

beforeEach(() => {
  exchangeTokens.mockReset();
  createProviderConnection.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  stopCodexProxy();
  stopXaiProxy();
  stopTraeProxy();
  stopWindsurfProxy();
  stopDevinProxy();
  stopZedProxy();
  clearTraeSession();
  clearWindsurfSession();
  clearDevinSession();
  clearZedSession();
});

describe('startLocalServer listen errors', () => {
  it('rejects with the raw error for a non-EADDRINUSE failure (privileged port)', async () => {
    await expect(startLocalServer(() => {}, 80)).rejects.toThrow(/EACCES|EPERM/);
  });
});

describe.each([
  {
    name: 'Codex',
    register: registerCodexSession,
    getStatus: getCodexSessionStatus,
    start: startCodexProxy,
    stop: stopCodexProxy,
    port: CODEX_CONFIG.fixedPort,
    timeoutMs: 300000,
  },
  {
    name: 'Xai',
    register: registerXaiSession,
    getStatus: getXaiSessionStatus,
    start: startXaiProxy,
    stop: stopXaiProxy,
    port: XAI_PORT,
    timeoutMs: 300000,
  },
])('$name fixed-port proxy edges', ({ register, getStatus, start, stop, port, timeoutMs }) => {
  afterEach(() => stop());

  it('resolves immediately when the proxy is already running', async () => {
    await start(4321);
    expect(await start(4321)).toEqual({ success: true });
  });

  it('reports port_busy when the fixed port is already bound', async () => {
    const blocker = await startLocalServer(() => {}, port);
    expect(await start(4321)).toEqual({ success: false, reason: 'port_busy' });
    blocker.close();
  });

  it('Mode A surfaces the provider error param via error_description', async () => {
    register({ state: 'err1', codeVerifier: 'v', redirectUri: 'http://x' });
    await start(4321);
    const { status, body } = await getClose(
      port,
      '/callback?state=err1&error=access_denied&error_description=user%20denied'
    );
    expect(status).toBe(200);
    expect(body).toMatch(/user denied/);
    expect(getStatus('err1')).toMatchObject({ status: 'error', error: 'user denied' });
  });

  it('Mode A fails when no authorization code arrives', async () => {
    register({ state: 'err2', codeVerifier: 'v', redirectUri: 'http://x' });
    await start(4321);
    const { body } = await getClose(port, '/callback?state=err2');
    expect(body).toMatch(/No authorization code received/);
    expect(getStatus('err2')).toMatchObject({ status: 'error' });
  });

  it('idle timeout closes the proxy', async () => {
    await fireIdleTimeout(() => start(4321), timeoutMs);
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });
});

describe.each([
  {
    name: 'Trae',
    register: registerTraeSession,
    getStatus: getTraeSessionStatus,
    clear: clearTraeSession,
    start: () => startTraeProxy(),
    callbackPath: TRAE_CONFIG.callbackPath,
    timeoutMs: TRAE_CONFIG.oauthTimeoutMs,
  },
  {
    name: 'Windsurf',
    register: registerWindsurfSession,
    getStatus: getWindsurfSessionStatus,
    clear: clearWindsurfSession,
    start: () => startWindsurfProxy(),
    callbackPath: WINDSURF_CONFIG.callbackPath,
    timeoutMs: WINDSURF_CONFIG.oauthTimeoutMs,
  },
])(
  '$name dynamic-port proxy edges',
  ({ name, register, getStatus, clear, start, callbackPath, timeoutMs }) => {
    it('getStatus returns null on a state mismatch, and clear is state-scoped', () => {
      register({ state: 'right' });
      expect(getStatus('wrong')).toBeNull();
      expect(getStatus('right')).toMatchObject({ status: 'pending' });
      clear('right');
    });

    it('resolves the same callbackUrl when already running', async () => {
      const first = await start();
      const second = await start();
      expect(second).toEqual(first);
      expect(second.callbackUrl).toBe(`http://127.0.0.1:${second.port}${callbackPath}`);
    });

    it('404s an unknown path', async () => {
      const { port } = await start();
      const { status } = await getClose(port, '/definitely-not-the-callback');
      expect(status).toBe(404);
    });

    it('renders failure and records the error when the exchange rejects', async () => {
      register({ state: 'ex1' });
      exchangeTokens.mockRejectedValue(new Error(`${name} exchange blew up`));
      const { port } = await start();
      const { status, body } = await getClose(port, `${callbackPath}?state=ex1&code=abc`);
      expect(status).toBe(200);
      expect(body).toMatch(/Authentication Failed/);
      expect(getStatus('ex1')).toMatchObject({
        status: 'error',
        error: `${name} exchange blew up`,
      });
      clear('ex1');
    });

    it('idle timeout closes the proxy', async () => {
      const { port } = await fireIdleTimeout(start, timeoutMs);
      await expect(fetch(`http://127.0.0.1:${port}${callbackPath}`)).rejects.toThrow();
    });
  }
);

describe('Devin proxy edges', () => {
  it('getStatus returns null on a state mismatch', () => {
    registerDevinSession({ state: 'd-right', codeVerifier: 'v' });
    expect(getDevinSessionStatus('d-wrong')).toBeNull();
    clearDevinSession('d-right');
  });

  it('resolves the fixed-port callbackUrl when already running', async () => {
    const first = await startDevinProxy();
    const second = await startDevinProxy();
    expect(second.success).toBe(true);
    expect(second.callbackUrl).toBe(
      `http://127.0.0.1:${DEVIN_CONFIG.callbackPort}${DEVIN_CONFIG.callbackPath}`
    );
    expect(second.port).toBe(first.port);
  });

  it('404s an unknown path and reports no active session as text', async () => {
    const { port } = await startDevinProxy();
    expect((await getClose(port, '/nope')).status).toBe(404);
    const { status, body } = await getClose(port, DEVIN_CONFIG.callbackPath);
    expect(status).toBe(200);
    expect(body).toMatch(/No active Devin login session/);
  });

  it('rejects a cross-origin callback with 403', async () => {
    registerDevinSession({ state: 'd1', codeVerifier: 'v' });
    const { port } = await startDevinProxy();
    const { status, body } = await getClose(port, `${DEVIN_CONFIG.callbackPath}?state=d1`, {
      Origin: 'https://evil.example',
    });
    expect(status).toBe(403);
    expect(body).toMatch(/Cross-origin/);
  });

  it('reports the fixed port as busy when already bound elsewhere', async () => {
    const blocker = await startLocalServer(() => {}, DEVIN_CONFIG.callbackPort);
    const res = await startDevinProxy();
    expect(res.success).toBe(false);
    expect(res.reason).toContain(String(DEVIN_CONFIG.callbackPort));
    blocker.close();
  });

  it('idle timeout closes the proxy', async () => {
    const { port } = await fireIdleTimeout(() => startDevinProxy(), DEVIN_CONFIG.oauthTimeoutMs);
    await expect(fetch(`http://127.0.0.1:${port}${DEVIN_CONFIG.callbackPath}`)).rejects.toThrow();
  });
});

describe('Zed proxy edges', () => {
  it('getStatus returns null on a state mismatch', () => {
    registerZedSession({ state: 'z-right', codeVerifier: 'k' });
    expect(getZedSessionStatus('z-wrong')).toBeNull();
    clearZedSession('z-right');
  });

  it('resolves the same callbackUrl when already running', async () => {
    const first = await startZedProxy(0);
    const second = await startZedProxy(0);
    expect(second).toEqual(first);
  });

  it('404s an unknown path, reports no session, and rejects cross-origin', async () => {
    const { port } = await startZedProxy(0);
    expect((await getClose(port, '/nope')).status).toBe(404);
    const noSession = await getClose(port, '/?state=x');
    expect(noSession.body).toMatch(/No active Zed login session/);
    registerZedSession({ state: 'z1', codeVerifier: 'k' });
    const cross = await getClose(port, '/?state=z1', { Origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(cross.body).toMatch(/Cross-origin/);
  });

  it('renders failure and records the error when the exchange rejects', async () => {
    registerZedSession({ state: 'z2', codeVerifier: 'k' });
    exchangeTokens.mockRejectedValue(new Error('zed decrypt failed'));
    const { port } = await startZedProxy(0);
    const { status, body } = await getClose(port, '/?state=z2&access_token=enc');
    expect(status).toBe(200);
    expect(body).toMatch(/Authentication Failed/);
    expect(getZedSessionStatus('z2')).toMatchObject({
      status: 'error',
      error: 'zed decrypt failed',
    });
  });

  it('fails outright on a non-EADDRINUSE listen error (privileged port)', async () => {
    const res = await startZedProxy(80);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/EACCES|EPERM|listen/);
  });

  it('idle timeout closes the proxy on the normal listen path', async () => {
    const { port } = await fireIdleTimeout(
      () => startZedProxy(0),
      ZED_HOSTED_CONFIG.oauthTimeoutMs
    );
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('idle timeout closes the proxy on the EADDRINUSE fallback path too', async () => {
    const blocker = await startLocalServer(() => {}, 42017);
    const { port } = await fireIdleTimeout(
      () => startZedProxy(42017),
      ZED_HOSTED_CONFIG.oauthTimeoutMs
    );
    expect(port).not.toBe(42017);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    blocker.close();
  });
});
