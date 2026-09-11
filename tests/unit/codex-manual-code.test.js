/**
 * The paste-back fallback for the fixed-port sign-ins.
 *
 * When the loopback callback never lands, the operator pastes the URL the provider
 * redirected their browser to. That URL carries its own `state`, and the check that
 * it matches the registered session is a security boundary: without it a URL
 * captured from a different grant would complete this one.
 *
 * Every code and state here is invented. No real authorization code appears.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  installGlobalProxyFetch: () => {},
  default: (...args) => globalThis.fetch(...args),
}));

let parseManualCallback;
let POST;

const SESSION_STATE = 'invented-session-state';
const OTHER_STATE = 'invented-other-state';
const DUMMY_CODE = 'invented-authorization-code';

beforeAll(async () => {
  ({ parseManualCallback, POST } =
    await import('../../src/app/api/oauth/[provider]/[action]/route.js'));
});

const manualCode = (provider, body) =>
  POST(
    new Request(`http://127.0.0.1:20129/api/oauth/${provider}/manual-code`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider, action: 'manual-code' }) }
  );

describe('parseManualCallback', () => {
  it('pulls the code and state out of a whole pasted callback URL', () => {
    const parsed = parseManualCallback(
      `http://localhost:1455/auth/callback?code=${DUMMY_CODE}&state=${SESSION_STATE}&scope=openid`,
      SESSION_STATE
    );
    expect(parsed).toMatchObject({
      code: DUMMY_CODE,
      state: SESSION_STATE,
      urlState: SESSION_STATE,
    });
  });

  it('accepts a bare code, falling back to the state the row already holds', () => {
    const parsed = parseManualCallback(DUMMY_CODE, SESSION_STATE);
    expect(parsed).toMatchObject({ code: DUMMY_CODE, state: SESSION_STATE });
    expect(parsed.urlState).toBeUndefined();
  });

  it('accepts a bare query fragment pasted without its origin', () => {
    const parsed = parseManualCallback(`?code=${DUMMY_CODE}&state=${SESSION_STATE}`, SESSION_STATE);
    expect(parsed).toMatchObject({ code: DUMMY_CODE, state: SESSION_STATE });
  });

  it('surfaces a provider error carried in the URL instead of exchanging it', () => {
    expect(() =>
      parseManualCallback(
        'http://localhost:1455/auth/callback?error=access_denied&error_description=user%20declined',
        SESSION_STATE
      )
    ).toThrow(/user declined/);
  });

  it('refuses a callback URL that carries no code', () => {
    expect(() =>
      parseManualCallback(
        `http://localhost:1455/auth/callback?state=${SESSION_STATE}`,
        SESSION_STATE
      )
    ).toThrow(/no authorization code/i);
  });
});

describe('manual-code route', () => {
  it('REFUSES a pasted URL whose state disagrees with the registered sign-in', async () => {
    // The failure direction that matters: the permissive path would be exchanging
    // a code from another grant. It must raise instead, and before any exchange.
    const response = await manualCode('codex', {
      url: `http://localhost:1455/auth/callback?code=${DUMMY_CODE}&state=${OTHER_STATE}`,
      state: SESSION_STATE,
    });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/different sign-in/i);
  });

  it('reports an expired or missing session as "start the sign-in again" rather than obscurely', async () => {
    const response = await manualCode('codex', {
      url: `http://localhost:1455/auth/callback?code=${DUMMY_CODE}&state=${SESSION_STATE}`,
      state: SESSION_STATE,
    });
    expect((await response.json()).error).toMatch(/start the sign-in again/i);
  });

  it('still refuses a provider that has no manual fallback', async () => {
    const response = await manualCode('claude', { code: DUMMY_CODE, state: SESSION_STATE });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/only supported for/i);
  });

  it('covers codex as well as xai, which was the only provider allowed before', async () => {
    for (const provider of ['codex', 'xai']) {
      const response = await manualCode(provider, { code: DUMMY_CODE, state: SESSION_STATE });
      // Both reach the session lookup and fail there, rather than being rejected
      // as an unsupported provider at the gate.
      expect(response.status).not.toBe(400);
    }
  });
});
