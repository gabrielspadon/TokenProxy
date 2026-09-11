/**
 * The fixed-port callback proxy's LIFECYCLE, as distinct from its bind
 * (codex-callback-bind.test.js) and its request handling
 * (oauth-proxy-servers.test.js).
 *
 * Three defects, each with the failure direction it closes:
 *
 * 1. STALE REDIRECT TARGET. The already-running fast path kept the FIRST
 *    attempt's handler, whose appPort was captured when that handler was built.
 *    A second sign-in from a different dashboard port still 302'd Mode B to the
 *    first port. Permissive input: a second startCodexProxy with a new appPort.
 *    It must now govern the redirect.
 * 2. A DEAD LISTENER MUST NOT REPORT SUCCESS. The fast path tested a non-empty
 *    module variable, never whether those servers were listening. Permissive
 *    input: a start called while the module still holds closed servers. It must
 *    rebind rather than resolve success over a port nothing answers on.
 * 3. A PENDING SESSION MUST NOT OUTLIVE ITS LISTENER. Only the listener that
 *    just closed could have completed it, so a survivor made poll-status answer
 *    "pending" against a dead port for the full deadline. A session that already
 *    reached done or error is the outcome the dashboard still has to read, and
 *    must survive.
 *
 * Every value here is invented. An authorization code is a credential and no
 * real one appears in this file.
 */
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/oauth/providers', () => ({ exchangeTokens: vi.fn() }));
vi.mock('@/models', () => ({ createProviderConnection: vi.fn() }));

import { exchangeTokens } from '@/lib/oauth/providers';
import { createProviderConnection } from '@/models';
import {
  startCodexProxy,
  stopCodexProxy,
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
  startXaiProxy,
  stopXaiProxy,
  registerXaiSession,
  getXaiSessionStatus,
} from '@/lib/oauth/utils/server';
import { CODEX_CONFIG } from '@/lib/oauth/constants/oauth';

const CODEX_PORT = CODEX_CONFIG.fixedPort;
const XAI_PORT = 56121; // hardcoded in the SUT, not exported from config
const FIRST_APP_PORT = 4321;
const SECOND_APP_PORT = 20129;
const VERIFIER = 'invented-code-verifier';
const DUMMY_CODE = 'invented-authorization-code';

// Connection: close — undici's keep-alive pool otherwise reuses a socket across
// the stop/start cycles these tests depend on.
async function callback(port, query, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/auth/callback?${query}`, {
    redirect: 'manual',
    headers: { Connection: 'close' },
    ...options,
  });
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

// A raw TCP connect is the only honest answer to "is this port live", because the
// module's own bookkeeping is exactly what these tests refuse to trust.
function reachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 0 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// `server.close()` stops accepting asynchronously, so the kernel can still answer
// a connect for a turn or two after the lifecycle has let go. Polling the port is
// the honest wait for that drain; it is not a tolerance for flakiness, and it
// fails rather than passing if the port never closes.
async function waitUntil(condition, { timeoutMs = 2000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

beforeEach(() => {
  exchangeTokens.mockReset();
  createProviderConnection.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  stopCodexProxy();
  stopXaiProxy();
});

describe('defect 1 — the redirect target follows the CURRENT attempt', () => {
  it('302s Mode B to the app port of the latest start, not the first', async () => {
    expect(await startCodexProxy(FIRST_APP_PORT)).toEqual({ success: true });
    // Second sign-in from a different dashboard port. The proxy is already
    // listening, so this takes the fast path and keeps the first handler.
    expect(await startCodexProxy(SECOND_APP_PORT)).toEqual({ success: true });

    // No session for this state, so the handler takes Mode B and redirects.
    const { status, location } = await callback(
      CODEX_PORT,
      `code=${DUMMY_CODE}&state=invented-unregistered-state`
    );
    expect(status).toBe(302);
    // Before the fix this read http://localhost:4321/... — a port the dashboard
    // that started the second attempt never occupied, so the code-bearing
    // callback was relayed into nothing.
    expect(location).toContain(`http://localhost:${SECOND_APP_PORT}/callback`);
    expect(location).not.toContain(`localhost:${FIRST_APP_PORT}`);
  });

  it('keeps the same guarantee for xai', async () => {
    await startXaiProxy(FIRST_APP_PORT);
    await startXaiProxy(SECOND_APP_PORT);
    const { location } = await callback(XAI_PORT, 'state=invented-unregistered-state');
    expect(location).toContain(`http://localhost:${SECOND_APP_PORT}/callback`);
  });
});

describe('defect 2 — liveness answers to the kernel, not to module state', () => {
  it('does NOT report success over servers that are no longer listening', async () => {
    // The fake clock goes in BEFORE the start, because `adopt()` arms the idle
    // timer at BIND time: a fake installed afterwards never owns that handle and
    // advancing it fires nothing, which reads as the product failing to close a
    // port it was never asked to close. Only the global setTimeout is faked, so
    // the socket work below runs on the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await startCodexProxy(FIRST_APP_PORT);
    expect(await reachable('127.0.0.1', CODEX_PORT)).toBe(true);

    // A listener that goes away WITHOUT stopCodexProxy is the leak this closes:
    // the module still held the server objects, so the old length test reported a
    // working proxy while the kernel had nothing bound. Firing the lifecycle's own
    // idle timer reproduces exactly that disagreement, and it is how the leak
    // actually arises in production, without reaching into module internals or
    // asking production code for a test-only accessor.
    await vi.advanceTimersByTimeAsync(600000 + 1);
    vi.useRealTimers();
    // `server.close()` is asynchronous, so the port keeps accepting until the
    // event loop drains it. That drain is what this waits for.
    await waitUntil(async () => !(await reachable('127.0.0.1', CODEX_PORT)));
    expect(await reachable('127.0.0.1', CODEX_PORT)).toBe(false);

    // The contract under test: a start here must produce a LISTENING proxy. The
    // pre-fix code resolved {success:true} off the stale array and bound nothing,
    // so the sign-in window opened onto a dead port.
    expect(await startCodexProxy(SECOND_APP_PORT)).toEqual({ success: true });
    expect(await reachable('127.0.0.1', CODEX_PORT)).toBe(true);
    expect(await reachable('::1', CODEX_PORT)).toBe(true);

    // And it is a REAL proxy: it serves, rather than merely holding the port.
    const { status } = await callback(CODEX_PORT, 'state=invented-unregistered-state');
    expect(status).toBe(302);
  });

  it('arms exactly one idle timer across repeated starts, so none is orphaned', async () => {
    // A single module-level timeout variable meant a second successful bind
    // overwrote the first's handle, leaving that proxy bound with nothing left to
    // close it. The lifecycle clears the handle it replaces, so the count of
    // uncleared long timers stays at one no matter how often start is called.
    const live = new Set();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const handle = realSet(fn, ms, ...rest);
      if (ms >= 600000) live.add(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      live.delete(handle);
      return realClear(handle);
    };
    try {
      await startCodexProxy(FIRST_APP_PORT);
      await startCodexProxy(SECOND_APP_PORT);
      await startCodexProxy(FIRST_APP_PORT);
      expect(live.size).toBe(1);
      stopCodexProxy();
      expect(live.size).toBe(0);
    } finally {
      for (const handle of live) realClear(handle);
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });
});

describe('defect 3 — a pending session dies with its listener', () => {
  it('drops a pending session on stop, instead of polling "pending" against a dead port', async () => {
    const state = 'invented-pending-state';
    registerCodexSession({
      state,
      codeVerifier: VERIFIER,
      redirectUri: `http://localhost:${CODEX_PORT}/auth/callback`,
    });
    await startCodexProxy(FIRST_APP_PORT);
    expect(getCodexSessionStatus(state)).toMatchObject({ status: 'pending' });

    stopCodexProxy();
    expect(await reachable('127.0.0.1', CODEX_PORT)).toBe(false);
    // Before the fix this stayed {status:'pending'}, so the dashboard polled for
    // its full 600s deadline against a port nothing was bound to: no error, no
    // completion, which is what the operator sees as the window doing nothing.
    // poll-status reports "unknown" for a missing session, which ends the wait.
    expect(getCodexSessionStatus(state)).toBeNull();
  });

  it('does NOT drop a session that already reached a terminal status', async () => {
    // The success path stops the proxy from the handler's own `finally`, AFTER
    // setting status to done. Clearing indiscriminately would destroy the result
    // the dashboard is about to read and turn a completed sign-in into "unknown".
    const state = 'invented-completing-state';
    registerCodexSession({
      state,
      codeVerifier: VERIFIER,
      redirectUri: `http://localhost:${CODEX_PORT}/auth/callback`,
    });
    exchangeTokens.mockResolvedValue({ accessToken: 'invented-access-token' });
    createProviderConnection.mockResolvedValue({ id: 'invented-conn', email: 'user@invalid' });

    await startCodexProxy(FIRST_APP_PORT);
    const { status } = await callback(CODEX_PORT, `code=${DUMMY_CODE}&state=${state}`);
    expect(status).toBe(200);
    expect(getCodexSessionStatus(state)).toMatchObject({
      status: 'done',
      connectionId: 'invented-conn',
    });
    clearCodexSession(state);
  });

  it('stops a restarted proxy from exchanging against a stale session', async () => {
    const state = 'invented-stale-state';
    registerCodexSession({
      state,
      codeVerifier: VERIFIER,
      redirectUri: `http://localhost:${CODEX_PORT}/auth/callback`,
    });
    await startCodexProxy(FIRST_APP_PORT);
    stopCodexProxy();
    await startCodexProxy(SECOND_APP_PORT);

    // The stale state is gone, so this is an unknown state: Mode B, no exchange.
    const { status } = await callback(CODEX_PORT, `code=${DUMMY_CODE}&state=${state}`);
    expect(status).toBe(302);
    expect(exchangeTokens).not.toHaveBeenCalled();
  });

  it('applies the same session rule to xai', async () => {
    const state = 'invented-xai-state';
    registerXaiSession({ state, codeVerifier: VERIFIER, redirectUri: 'http://localhost' });
    await startXaiProxy(FIRST_APP_PORT);
    stopXaiProxy();
    expect(getXaiSessionStatus(state)).toBeNull();
  });
});
