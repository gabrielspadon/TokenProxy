/**
 * The Codex callback path: the loopback bind, and the paste-back fallback.
 *
 * The bug this covers: Codex registers http://localhost:1455/auth/callback as its
 * redirect URI, and `localhost` resolves to ::1 first on a dual-stack host. A proxy
 * bound only to 127.0.0.1 is never reached, so the sign-in completes at the provider
 * and nothing answers the redirect.
 *
 * Every value here is invented. An authorization code is a credential and no real
 * one appears in this file.
 */
import net from 'node:net';
import os from 'node:os';
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
  startLocalServer,
} from '@/lib/oauth/utils/server';
import { CODEX_CONFIG } from '@/lib/oauth/constants/oauth';

const CODEX_PORT = CODEX_CONFIG.fixedPort;
const STATE = 'invented-state-value';
const VERIFIER = 'invented-code-verifier';
const DUMMY_CODE = 'invented-authorization-code';

// A raw TCP connect, which is what the browser does. fetch() would follow Node's
// own resolver and hide which family actually answered.
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

// A non-loopback address of this host, used to prove the bind did NOT widen.
function firstNonLoopbackAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

beforeEach(() => {
  exchangeTokens.mockReset();
  createProviderConnection.mockReset();
});

afterEach(() => {
  stopCodexProxy();
  stopXaiProxy();
  clearCodexSession(STATE);
});

describe('codex callback proxy bind', () => {
  it('answers on BOTH loopback families, which is what makes the localhost redirect land', async () => {
    expect(await startCodexProxy(4321)).toEqual({ success: true });
    expect(await reachable('127.0.0.1', CODEX_PORT)).toBe(true);
    expect(await reachable('::1', CODEX_PORT)).toBe(true);
  });

  it('does NOT widen past loopback — a code-bearing callback stays off the LAN', async () => {
    const external = firstNonLoopbackAddress();
    if (!external) return; // nothing to prove on a host with no external v4 address
    await startCodexProxy(4321);
    expect(await reachable(external, CODEX_PORT)).toBe(false);
  });

  it('frees the port on stop, so the next sign-in does not hit a half-closed listener', async () => {
    await startCodexProxy(4321);
    stopCodexProxy();
    // Both listeners must be gone. If either leaked, one family still answers.
    expect(await reachable('127.0.0.1', CODEX_PORT)).toBe(false);
    expect(await reachable('::1', CODEX_PORT)).toBe(false);
    // And the port is immediately re-bindable.
    expect(await startCodexProxy(4321)).toEqual({ success: true });
  });

  it('still reports port_busy when the fixed port is held, preserving the existing contract', async () => {
    const blocker = await startLocalServer(() => {}, CODEX_PORT);
    expect(await startCodexProxy(4321)).toEqual({ success: false, reason: 'port_busy' });
    blocker.close();
  });

  it('completes the exchange when the callback arrives over IPv6', async () => {
    registerCodexSession({ state: STATE, codeVerifier: VERIFIER, redirectUri: 'http://localhost' });
    exchangeTokens.mockResolvedValue({ accessToken: 'invented-access-token' });
    createProviderConnection.mockResolvedValue({ id: 'invented-conn', email: 'user@invalid' });
    await startCodexProxy(4321);
    const res = await fetch(
      `http://[::1]:${CODEX_PORT}/auth/callback?code=${DUMMY_CODE}&state=${STATE}`,
      { headers: { Connection: 'close' } }
    );
    expect(res.status).toBe(200);
    expect(getCodexSessionStatus(STATE)).toMatchObject({
      status: 'done',
      connectionId: 'invented-conn',
    });
  });
});

describe('xai proxy keeps the same bind shape', () => {
  it('answers on both loopback families', async () => {
    expect(await startXaiProxy(4321)).toEqual({ success: true });
    expect(await reachable('127.0.0.1', 56121)).toBe(true);
    expect(await reachable('::1', 56121)).toBe(true);
  });
});
