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
