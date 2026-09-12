// Coverage for the REFRESH_HANDLERS dispatch table, the vertex handler glue,
// and getAllAccessTokens in open-sse/services/tokenRefresh.js. Every provider
// refresh implementation is mocked (network code lives in providers.js), so
// nothing here can reach the wire; global fetch is additionally stubbed to
// throw as a tripwire.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const SENTINEL = { accessToken: 'mocked-access' };

vi.mock('open-sse/services/tokenRefresh/providers.js', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {};
  for (const name of Object.keys(actual)) {
    // Only the refresh* async implementations are network code; keep helpers real.
    if (
      name.startsWith('refresh') &&
      name !== 'refreshProxyOptions' &&
      name !== 'refreshFailureWhy'
    ) {
      mocked[name] = vi.fn(async () => ({ accessToken: 'mocked-access' }));
    }
  }
  return { ...actual, ...mocked };
});

import * as mod from 'open-sse/services/tokenRefresh.js';
import * as providers from 'open-sse/services/tokenRefresh/providers.js';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('real fetch attempted');
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Dispatch keys of REFRESH_HANDLERS (a routing contract of the module, read
// from its source, not provider endpoint literals). vertex ids resolve through
// parseVertexSaJson and return null when apiKey is not a service-account JSON.
const HANDLER_KEYS = [
  'gemini-cli',
  'antigravity',
  'claude',
  'codex',
  'iflow',
  'github',
  'kiro',
  'xai',
  'grok-cli',
  'gcli',
  'codebuddy-cn',
  'codebuddy-intl',
  'trae',
  'zed',
  'windsurf',
  'kimi',
  'kimi-coding',
];

describe('REFRESH_HANDLERS dispatch', () => {
  it.each(HANDLER_KEYS)(
    '%s routes to a mocked provider refresh and returns its result',
    async (provider) => {
      const out = await mod.getAccessToken(
        provider,
        {
          refreshToken: `rt-${provider}`,
          providerSpecificData: {},
        },
        null
      );
      expect(out).toEqual(SENTINEL);
    }
  );

  it('gemini routes through the google refresh path', async () => {
    const out = await mod.getAccessToken('gemini', { refreshToken: 'rt-gemini' }, null);
    expect(out).toEqual(SENTINEL);
    expect(providers.refreshGoogleToken).toHaveBeenCalled();
  });

  it.each(['vertex', 'vertex-partner'])(
    '%s returns null when apiKey is not service-account JSON',
    async (provider) => {
      const out = await mod.getAccessToken(
        provider,
        { refreshToken: 'rt', apiKey: 'not-json' },
        null
      );
      expect(out).toBeNull();
    }
  );
});

describe('formatProviderCredentials gemini shape', () => {
  it('keeps apiKey, accessToken and projectId for gemini', () => {
    const out = mod.formatProviderCredentials(
      'gemini',
      {
        apiKey: 'k',
        accessToken: 't',
        refreshToken: 'r',
        projectId: 'p',
      },
      null
    );
    expect(out).toEqual({ apiKey: 'k', accessToken: 't', projectId: 'p' });
  });
});

describe('getAllAccessTokens', () => {
  it('collects tokens only for active connections with a provider', async () => {
    const userInfo = {
      connections: [
        { isActive: true, provider: 'claude', refreshToken: 'r1' },
        { isActive: false, provider: 'codex', refreshToken: 'r2' },
        { isActive: true, provider: null, refreshToken: 'r3' },
        // vertex without SA JSON apiKey -> handler yields null -> excluded
        { isActive: true, provider: 'vertex', refreshToken: 'r4' },
      ],
    };
    const out = await mod.getAllAccessTokens(userInfo, null);
    expect(Object.keys(out)).toEqual(['claude']);
    expect(out.claude).toEqual(SENTINEL);
  });

  it('returns an empty object when connections is absent or not an array', async () => {
    expect(await mod.getAllAccessTokens({}, null)).toEqual({});
    expect(await mod.getAllAccessTokens({ connections: 'nope' }, null)).toEqual({});
  });
});

describe('refreshVertexToken network-error path', () => {
  it('returns null when the token mint fetch throws (catch path)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const saJson = {
      type: 'service_account',
      client_email: `catch-path-${Date.now()}@example.test`,
      private_key: pem,
      project_id: 'p',
    };
    const log = { error: vi.fn() };
    const out = await mod.refreshVertexToken(saJson, log);
    expect(out).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });
});
