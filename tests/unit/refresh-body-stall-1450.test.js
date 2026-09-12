/**
 * #1450 residual — the refresh half.
 *
 * The probe half (testUtils.js) already bounds every connection test with
 * FETCH_CONNECT_TIMEOUT_MS. The refresh paths in tokenRefresh/providers.js
 * passed no signal at all, and nothing underneath supplies one: undici
 * documents `bodyTimeout: 0` (proxyFetch.js, on the shared proxy dispatcher)
 * as "disable it entirely", and that dispatcher is the same one a chat stream
 * rides, so it cannot be shortened. An upstream that returns response headers
 * and then goes silent therefore left the refresh awaiting a body that never
 * arrived — and the chat request that triggered the refresh waited with it.
 *
 * Set before the module graph loads: runtimeConfig reads the env at import.
 */
process.env.FETCH_CONNECT_TIMEOUT_MS = '150';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Resolved lazily INSIDE the test: a top-level import of the registry pulls in
// the real proxyFetch before vi.mock hoists, which silently unmocks the module
// this file depends on. The subject is the generic PATH, not any one provider.
async function genericProvider() {
  const { PROVIDERS } = await import('../../open-sse/providers/index.js');
  const id = Object.entries(PROVIDERS).find(([, p]) => p?.refreshUrl && p?.clientId)?.[0];
  if (!id) throw new Error('no provider carries refreshUrl + clientId');
  return id;
}

vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: vi.fn(),
  installGlobalProxyFetch: () => {},
}));

let mod;
let proxyFetch;
let seq = 0;
const token = (name) => `${name}-rt-${++seq}`;

beforeEach(async () => {
  mod = await import('../../open-sse/services/tokenRefresh/providers.js');
  ({ proxyAwareFetch: proxyFetch } = await import('../../open-sse/utils/proxyFetch.js'));
  proxyFetch.mockReset();
});

// Headers arrive, the body never does. The stream ends only if the caller
// aborts it, which is exactly what undici's fetch does with a request signal.
function headersThenSilence(seen) {
  return (url, options = {}) => {
    seen.push({ url: String(url), options });
    const signal = options.signal;
    const body = new ReadableStream({
      start(controller) {
        if (!signal) return;
        const fail = () => {
          try {
            controller.error(signal.reason);
          } catch {
            /* already closed */
          }
        };
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function ok(seen) {
  return (url, options = {}) => {
    seen.push({ url: String(url), options });
    return new Response(
      JSON.stringify({ access_token: 'a', refreshToken: 'b', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
}

describe('a token refresh is bounded when the upstream body stalls (#1450)', () => {
  it('gives up on a silent body instead of hanging, and fails the way an errored refresh already does', async () => {
    const seen = [];
    proxyFetch.mockImplementation(headersThenSilence(seen));

    const result = await mod.refreshAccessToken(await genericProvider(), token('stall'), {}, null);

    expect(result).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].options.signal.aborted).toBe(true);
  }, 2000);

  it('still throws out of the Kiro path, which has no catch of its own today', async () => {
    const seen = [];
    proxyFetch.mockImplementation(headersThenSilence(seen));

    await expect(
      mod.refreshKiroToken(token('kiro'), { authMethod: 'social' }, null, null)
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
  }, 2000);

  // Trae is omitted: PROVIDER_OAUTH.trae carries no token URL, so it returns
  // before reaching the network and would prove nothing here.
  it('passes a deadline on every refresh path, not just the generic one', async () => {
    const seen = [];
    proxyFetch.mockImplementation(ok(seen));

    await mod.refreshAccessToken(await genericProvider(), token('generic'), {}, null);
    await mod.refreshGoogleToken(token('google'), 'cid', 'csecret', null);
    await mod.refreshCodexToken(token('codex'), null);
    await mod.refreshCopilotToken(token('copilot'), null);
    await mod.refreshCodebuddyToken(token('cb-cn'), null);
    await mod.refreshCodebuddyIntlToken(token('cb-intl'), null);
    await mod.refreshKiroToken(token('kiro-social'), { authMethod: 'social' }, null, null);
    await mod.refreshKiroToken(
      token('kiro-idc'),
      {
        authMethod: 'idc',
        clientId: 'c',
        clientSecret: 's',
        region: 'us-east-1',
      },
      null,
      null
    );

    expect(seen).toHaveLength(8);
    for (const call of seen) {
      expect(call.options.signal, `no deadline on ${call.url}`).toBeInstanceOf(AbortSignal);
    }
  });

});
