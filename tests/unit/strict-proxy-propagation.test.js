import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks for database & proxy config resolution
const dbMocks = vi.hoisted(() => ({
  getProxyPools: vi.fn(),
  getProxyPoolById: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(() => ({})),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(),
  updateProviderStrategyProxyPoolSnapshotIfBound: vi.fn(),
}));

vi.mock('@/lib/localDb', () => ({
  getProxyPools: dbMocks.getProxyPools,
  getProxyPoolById: dbMocks.getProxyPoolById,
  getProviderConnections: dbMocks.getProviderConnections,
  getSettings: dbMocks.getSettings,
  updateConnectionProxyPoolSnapshotIfBound: dbMocks.updateConnectionProxyPoolSnapshotIfBound,
  updateProviderStrategyProxyPoolSnapshotIfBound: dbMocks.updateProviderStrategyProxyPoolSnapshotIfBound,
}));

vi.mock('@/models', () => ({
  getProxyPoolById: dbMocks.getProxyPoolById,
}));

import { getProviderCredentials } from '@/sse/services/auth.js';
import {
  RequiredProxyUnavailableError,
  resolveConnectionProxyConfig,
  toConnectionProxyOptions,
} from '@/lib/network/connectionProxy.js';
import { resolveEffectiveProxyRoute } from 'open-sse/utils/proxyFetch.js';
import { mergeRefreshedProviderSpecificData } from 'open-sse/services/tokenRefresh.js';

describe('PR A: strictProxy Propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.updateConnectionProxyPoolSnapshotIfBound.mockResolvedValue({ id: 'conn-1' });
    dbMocks.updateProviderStrategyProxyPoolSnapshotIfBound.mockResolvedValue({ providerId: 'mimo-free' });
  });

  describe('Credential Propagation (auth.js)', () => {
    it('propagates strictProxy=true for normal provider connection path', async () => {
      const mockPool = {
        id: 'pool-strict',
        name: 'Strict Proxy Pool',
        isActive: true,
        proxyUrl: 'http://127.0.0.1:9999',
        strictProxy: true,
      };
      dbMocks.getProviderConnections.mockResolvedValue([
        {
          id: 'conn-1',
          provider: 'openai',
          name: 'OpenAI Conn',
          testStatus: 'active',
          apiKey: 'sk-test-key',
          providerSpecificData: { proxyPoolId: 'pool-strict' },
        },
      ]);
      dbMocks.getProxyPools.mockResolvedValue([mockPool]);
      dbMocks.getProxyPoolById.mockResolvedValue(mockPool);

      const creds = await getProviderCredentials('openai', {}, null);
      expect(creds).toBeDefined();
      expect(creds.providerSpecificData.connectionProxyEnabled).toBe(true);
      expect(creds.providerSpecificData.connectionProxyUrl).toBe('http://127.0.0.1:9999');
      expect(creds.providerSpecificData.strictProxy).toBe(true);
    });

    it('propagates strictProxy=false for normal provider connection path', async () => {
      const mockPool = {
        id: 'pool-lenient',
        name: 'Lenient Proxy Pool',
        isActive: true,
        proxyUrl: 'http://127.0.0.1:9999',
        strictProxy: false,
      };
      dbMocks.getProviderConnections.mockResolvedValue([
        {
          id: 'conn-2',
          provider: 'openai',
          name: 'OpenAI Conn 2',
          testStatus: 'active',
          apiKey: 'sk-test-key-2',
          providerSpecificData: { proxyPoolId: 'pool-lenient' },
        },
      ]);
      dbMocks.getProxyPools.mockResolvedValue([mockPool]);
      dbMocks.getProxyPoolById.mockResolvedValue(mockPool);

      const creds = await getProviderCredentials('openai', {}, null);
      expect(creds).toBeDefined();
      expect(creds.providerSpecificData.strictProxy).toBe(false);
    });

    it('propagates strictProxy=true for no-auth virtual connection path', async () => {
      const mockPool = {
        id: 'pool-noauth-strict',
        name: 'NoAuth Strict Proxy Pool',
        isActive: true,
        proxyUrl: 'http://127.0.0.1:9999',
        strictProxy: true,
      };
      dbMocks.getProviderConnections.mockResolvedValue([]);
      dbMocks.getProxyPools.mockResolvedValue([mockPool]);
      dbMocks.getProxyPoolById.mockResolvedValue(mockPool);
      dbMocks.getSettings.mockResolvedValue({
        providerStrategies: {
          'mimo-free': { rotateStrategy: 'round-robin', proxyPoolId: 'pool-noauth-strict' },
        },
      });

      const creds = await getProviderCredentials('mimo-free', {}, null);
      expect(creds).toBeDefined();
      expect(creds.id).toBe('noauth');
      expect(creds.providerSpecificData.connectionProxyEnabled).toBe(true);
      expect(creds.providerSpecificData.strictProxy).toBe(true);
    });
  });

  describe('Pre-egress proxy provenance migration', () => {
    const target = 'https://agent.api5.cursor.sh/run';

    function resolveRoute(config, getEnvProxyUrl = vi.fn(() => 'http://environment-proxy.test:8080')) {
      return {
        route: resolveEffectiveProxyRoute(target, toConnectionProxyOptions(config), { getEnvProxyUrl }),
        getEnvProxyUrl,
      };
    }

    function expectUnavailableRoute(config) {
      const getEnvProxyUrl = vi.fn(() => 'http://environment-proxy.test:8080');
      const route = resolveEffectiveProxyRoute(target, {
        resolutionKind: config.resolutionKind,
        strictProxy: config.strictProxy,
        reason: config.reason,
      }, { getEnvProxyUrl });
      expect(route).toMatchObject({ kind: 'required-unavailable', reason: config.reason });
      expect(getEnvProxyUrl).not.toHaveBeenCalled();
    }

    it.each([
      ['new direct marker', { connectionProxyMode: 'direct' }, 'intentional-direct', false],
      ['old pool-none marker', { proxyPoolId: '__none__' }, 'intentional-direct', false],
      ['new proxy strict', { connectionProxyMode: 'proxy', connectionProxyEnabled: true, connectionProxyUrl: 'https://proxy.test:8443', strictProxy: true }, 'selected-proxy', true],
      ['new proxy non-strict', { connectionProxyMode: 'proxy', connectionProxyEnabled: true, connectionProxyUrl: 'socks5h://proxy.test:1080', strictProxy: false }, 'selected-proxy', false],
      ['legacy proxy strict', { connectionProxyEnabled: true, connectionProxyUrl: 'http://proxy.test:8080', strictProxy: true }, 'selected-proxy', true],
      ['legacy proxy non-strict', { connectionProxyEnabled: true, connectionProxyUrl: 'https://proxy.test:8443', strictProxy: false }, 'selected-proxy', false],
    ])('keeps %s provenance out of environment policy', async (_origin, data, resolutionKind, strictProxy) => {
      const config = await resolveConnectionProxyConfig(data);
      expect(config).toMatchObject({
        kind: 'usable',
        resolutionKind,
        strictProxy,
      });
      const { route, getEnvProxyUrl } = resolveRoute(config);
      expect(getEnvProxyUrl).not.toHaveBeenCalled();
      expect(route.kind).toBe(resolutionKind === 'selected-proxy' ? 'proxy' : 'direct');
    });

    it('keeps selected proxy fields intact in the safe transport options', async () => {
      const config = await resolveConnectionProxyConfig({
        connectionProxyMode: 'proxy',
        connectionProxyEnabled: true,
        connectionProxyUrl: 'https://proxy.test:8443',
        connectionNoProxy: '.internal.test',
        strictProxy: true,
      });
      expect(toConnectionProxyOptions(config)).toEqual({
        connectionProxyEnabled: true,
        connectionProxyUrl: 'https://proxy.test:8443',
        connectionNoProxy: '.internal.test',
        vercelRelayUrl: '',
        strictProxy: true,
        resolutionKind: 'selected-proxy',
      });
    });

    it('reads the historical false-empty tuple as unselected and permits environment policy', async () => {
      const config = await resolveConnectionProxyConfig({
        connectionProxyEnabled: false,
        connectionProxyUrl: '',
        connectionNoProxy: '',
      });
      expect(config).toMatchObject({ kind: 'usable', resolutionKind: 'unselected', source: 'legacy-default' });
      const { route, getEnvProxyUrl } = resolveRoute(config);
      expect(route.kind).toBe('proxy');
      expect(getEnvProxyUrl).toHaveBeenCalledTimes(1);
    });

    it.each(['true', 'false', 1, null, {}])(
      'fails closed on a malformed strictProxy %j in the historical false-empty shape',
      async (strictProxy) => {
        const config = await resolveConnectionProxyConfig({
          connectionProxyEnabled: false,
          connectionProxyUrl: '',
          connectionNoProxy: '',
          strictProxy,
        });
        expect(config).toMatchObject({ kind: 'required-unavailable', reason: 'legacy-proxy-strict-invalid' });
        expectUnavailableRoute(config);
        expect(() => toConnectionProxyOptions(config)).toThrow(RequiredProxyUnavailableError);
      },
    );

    it.each([
      ['direct conflict', { connectionProxyMode: 'direct', connectionProxyEnabled: false }, 'connection-proxy-direct-conflict'],
      ['ambiguous disabled legacy', { connectionProxyEnabled: false, connectionProxyUrl: 'https://proxy.test:8443' }, 'legacy-proxy-disabled-ambiguous'],
      ['missing enabled legacy', { connectionProxyUrl: 'https://proxy.test:8443' }, 'legacy-proxy-enabled-missing'],
      ['invalid strict proxy URL', { connectionProxyMode: 'proxy', connectionProxyEnabled: true, connectionProxyUrl: 'ftp://proxy.test:21', strictProxy: true }, 'legacy-proxy-invalid'],
    ])('fails closed for %s without resolving a route', async (_origin, data, reason) => {
      const config = await resolveConnectionProxyConfig(data);
      expect(config).toMatchObject({ kind: 'required-unavailable', reason });
      expectUnavailableRoute(config);
      expect(() => toConnectionProxyOptions(config)).toThrow(/Required proxy is unavailable/);
    });

    it('persists a pairless selected pool before returning usable credentials', async () => {
      dbMocks.getProxyPoolById.mockResolvedValue({
        id: 'pool-strict', isActive: true, proxyUrl: 'https://proxy.test:8443', strictProxy: true,
      });
      const persistPoolSnapshot = vi.fn().mockResolvedValue({ id: 'conn-1' });
      const config = await resolveConnectionProxyConfig(
        { proxyPoolId: 'pool-strict' },
        { persistPoolSnapshot },
      );
      expect(persistPoolSnapshot).toHaveBeenCalledWith({ proxyPoolId: 'pool-strict', strictProxy: true });
      expect(config).toMatchObject({ kind: 'usable', resolutionKind: 'selected-proxy', strictProxy: true });
    });

    it.each([
      ['missing', undefined, undefined],
      ['inactive', { id: 'pool-strict', isActive: false, proxyUrl: 'https://proxy.test:8443', strictProxy: true }, undefined],
      ['malformed', { id: 'pool-strict', isActive: true, proxyUrl: 'ftp://proxy.test:21', strictProxy: true }, undefined],
      ['lookup throws', new Error('lookup failed'), undefined],
      ['write fails', { id: 'pool-strict', isActive: true, proxyUrl: 'https://proxy.test:8443', strictProxy: true }, new Error('write failed')],
      ['no owner', { id: 'pool-strict', isActive: true, proxyUrl: 'https://proxy.test:8443', strictProxy: true }, null],
    ])('fails pairless selected pools that are %s before route resolution', async (_state, pool, persistResult) => {
      if (pool instanceof Error) dbMocks.getProxyPoolById.mockRejectedValue(pool);
      else dbMocks.getProxyPoolById.mockResolvedValue(pool);
      const persistPoolSnapshot = vi.fn();
      if (persistResult instanceof Error) persistPoolSnapshot.mockRejectedValue(persistResult);
      else persistPoolSnapshot.mockResolvedValue(persistResult);
      const config = await resolveConnectionProxyConfig(
        { proxyPoolId: 'pool-strict' },
        { persistPoolSnapshot },
      );
      expect(config).toMatchObject({ kind: 'required-unavailable' });
      expectUnavailableRoute(config);
    });

    it('returns no normal credentials when an active connection selection is unavailable', async () => {
      dbMocks.getProviderConnections.mockResolvedValue([
        {
          id: 'conn-unavailable', provider: 'openai', testStatus: 'active', apiKey: 'sk-test',
          providerSpecificData: { proxyPoolId: 'missing-pool', strictProxy: true },
        },
      ]);
      dbMocks.getSettings.mockResolvedValue({});
      dbMocks.getProxyPoolById.mockResolvedValue(null);
      await expect(getProviderCredentials('openai')).resolves.toBeNull();
    });

    it('persists fixed no-auth pool snapshots and carries rotating pairs without overwriting settings', async () => {
      const fixedPool = { id: 'fixed-pool', isActive: true, proxyUrl: 'https://proxy.test:8443', strictProxy: true };
      dbMocks.getSettings.mockResolvedValue({ providerStrategies: { 'mimo-free': { proxyPoolId: 'fixed-pool' } } });
      dbMocks.getProxyPoolById.mockResolvedValue(fixedPool);
      const fixed = await getProviderCredentials('mimo-free');
      expect(fixed.providerSpecificData).toMatchObject({ connectionProxyPoolId: 'fixed-pool', strictProxy: true });
      expect(dbMocks.updateProviderStrategyProxyPoolSnapshotIfBound)
        .toHaveBeenCalledWith('mimo-free', 'fixed-pool', { proxyPoolId: 'fixed-pool', strictProxy: true });

      vi.clearAllMocks();
      const rotatingPool = { id: 'rotating-pool', isActive: true, proxyUrl: 'https://proxy.test:8443', strictProxy: false };
      dbMocks.getSettings.mockResolvedValue({ providerStrategies: { 'mimo-free': { rotateStrategy: 'round-robin' } } });
      dbMocks.getProxyPools.mockResolvedValue([rotatingPool]);
      dbMocks.getProxyPoolById.mockResolvedValue(rotatingPool);
      const rotating = await getProviderCredentials('mimo-free');
      expect(rotating.providerSpecificData).toMatchObject({ connectionProxyPoolId: 'rotating-pool', strictProxy: false });
      expect(dbMocks.updateProviderStrategyProxyPoolSnapshotIfBound).not.toHaveBeenCalled();
    });

    it('preserves a proxy selection pair across an OAuth refresh merge', () => {
      const refreshed = mergeRefreshedProviderSpecificData(
        { proxyPoolId: 'pool-strict', strictProxy: true, machineId: 'machine-1' },
        { machineId: 'machine-2' },
      );
      expect(refreshed).toMatchObject({
        proxyPoolId: 'pool-strict', strictProxy: true, machineId: 'machine-2',
      });
    });
  });

  describe('Full Propagation & Fetch Behavior (chatCore -> proxyAwareFetch)', () => {
    it('Case A: strictProxy=true + proxy failure -> direct fetch invocation count = 0', async () => {
      let callCount = 0;
      const proxyFailure = new Error('connect ECONNREFUSED 127.0.0.1:19999');
      // Proxy fetch fails with connection error
      const mockProxyFetch = vi.fn(async () => {
        callCount++;
        throw proxyFailure;
      });

      const origFetch = globalThis.fetch;
      globalThis.fetch = mockProxyFetch;

      vi.resetModules();
      const { proxyAwareFetch } = await import('open-sse/utils/proxyFetch.js');

      const proxyOptions = {
        connectionProxyEnabled: true,
        connectionProxyUrl: 'http://127.0.0.1:19999',
        connectionNoProxy: '',
        vercelRelayUrl: '',
        strictProxy: true,
      };

      try {
        await expect(
          proxyAwareFetch('https://example.com/v1/chat/completions', { method: 'POST' }, proxyOptions)
        ).rejects.toBe(proxyFailure);

        // When strictProxy=true and proxy fails, it MUST NOT fall back to direct fetch.
        // The single call that failed was the proxy fetch attempt.
        expect(callCount).toBe(1);
        expect(mockProxyFetch.mock.calls[0][1].dispatcher.constructor.name).toBe('ProxyAgent');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('preserves the exact caller abort reason through strict proxy wrapping', async () => {
      const caller = new AbortController();
      const fakeFetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(init.signal.reason);
        if (init.signal.aborted) rejectAbort();
        else init.signal.addEventListener('abort', rejectAbort, { once: true });
      }));
      const origFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch;

      vi.resetModules();
      const { proxyAwareFetch } = await import('open-sse/utils/proxyFetch.js');
      const proxyOptions = {
        connectionProxyEnabled: true,
        connectionProxyUrl: 'http://127.0.0.1:19999',
        connectionNoProxy: '',
        vercelRelayUrl: '',
        strictProxy: true,
      };

      try {
        const pending = proxyAwareFetch(
          'https://example.com/v1/chat/completions',
          { method: 'POST', signal: caller.signal },
          proxyOptions,
        );
        const reason = new DOMException('client left', 'AbortError');
        caller.abort(reason);

        await expect(pending).rejects.toBe(reason);
        expect(fakeFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it.each(['GET', 'POST'])('strictProxy=false preserves replay safety for %s after proxy failure', async (method) => {
      let proxyAttempts = 0;
      let directFallbackAttempts = 0;
      const proxyFailure = new Error('connect ECONNREFUSED 127.0.0.1:19999');

      const fakeFetch = vi.fn(async (url, init) => {
        if (init?.dispatcher?.constructor?.name === 'ProxyAgent') {
          proxyAttempts++;
          throw proxyFailure;
        }
        directFallbackAttempts++;
        return new Response('{"ok":true}', { status: 200 });
      });

      const origFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch;

      vi.resetModules();
      const { proxyAwareFetch } = await import('open-sse/utils/proxyFetch.js');

      const proxyOptions = {
        connectionProxyEnabled: true,
        connectionProxyUrl: 'http://127.0.0.1:19999',
        connectionNoProxy: '',
        vercelRelayUrl: '',
        strictProxy: false,
      };

      try {
        const pending = proxyAwareFetch('https://example.com/v1/chat/completions', { method }, proxyOptions);
        if (method === 'GET') {
          expect((await pending).status).toBe(200);
          expect(directFallbackAttempts).toBe(1);
        } else {
          await expect(pending).rejects.toBe(proxyFailure);
          expect(directFallbackAttempts).toBe(0);
        }
        expect(proxyAttempts).toBe(1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('uses a direct Agent without treating it as a proxy egress', async () => {
      let proxyAttempts = 0;
      let directAttempts = 0;
      const fakeFetch = vi.fn(async (_url, init) => {
        if (init?.dispatcher?.constructor?.name === 'ProxyAgent') {
          proxyAttempts++;
          throw new Error('proxy must not be used for an intentional direct route');
        }
        directAttempts++;
        return new Response('{"ok":true}', { status: 200 });
      });
      const origFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch;

      vi.resetModules();
      const { proxyAwareFetch } = await import('open-sse/utils/proxyFetch.js');

      try {
        const res = await proxyAwareFetch(
          'https://example.com/v1/chat/completions',
          { method: 'POST' },
          { connectionProxyMode: 'direct', strictProxy: true },
        );

        expect(res.status).toBe(200);
        expect(proxyAttempts).toBe(0);
        expect(directAttempts).toBe(1);
        expect(fakeFetch.mock.calls[0][1].dispatcher.constructor.name).toBe('Agent');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
