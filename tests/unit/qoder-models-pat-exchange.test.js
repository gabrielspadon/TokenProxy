// PAT exchange, catalog fetch/caching and abort paths in qoderModels.js.
// proxyAwareFetch is mocked; zero network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => mocks.proxyAwareFetch(...args),
}));
vi.mock('../../open-sse/shared/qoder/cosy.js', () => ({
  buildCosyHeaders: () => ({}),
}));

const {
  clearQoderCatalog,
  getQoderModelConfig,
  invalidateQoderCatalog,
  isQoderPat,
  resolveQoderCredentials,
  resolveQoderModels,
} = await import('../../open-sse/services/qoderModels.js');

import {
  QODER_CHAT_BASE_ALT,
  QODER_JOB_TOKEN_EXCHANGE_URL,
  QODER_MODEL_LIST_URL,
  QODER_USERINFO_URL,
} from '../../open-sse/shared/qoder/constants.js';

const jsonRes = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

const CHAT_ENTRY = {
  key: 'qmodel_latest',
  enable: true,
  display_name: 'Qoder Latest',
  max_input_tokens: 200_000,
  max_output_tokens: 16_000,
  is_vl: true,
  is_reasoning: true,
  description: 'd',
};
const CATALOG = { chat: [CHAT_ENTRY, { key: 'hidden_model', enable: false }, null, {}] };

const jtCreds = {
  accessToken: 'jt-job-token',
  providerSpecificData: { userId: 'user-1', machineId: 'm-1' },
};

beforeEach(() => {
  clearQoderCatalog();
  mocks.proxyAwareFetch.mockReset();
});
afterEach(() => clearQoderCatalog());

describe('isQoderPat', () => {
  it('recognizes only pt-prefixed strings', () => {
    expect(isQoderPat('pt-abc')).toBe(true);
    expect(isQoderPat('jt-abc')).toBe(false);
    expect(isQoderPat(null)).toBe(false);
    expect(isQoderPat(42)).toBe(false);
  });
});

describe('resolveQoderCredentials PAT exchange', () => {
  it('exchanges a PAT for a job token and resolves the user id', async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      if (url === QODER_JOB_TOKEN_EXCHANGE_URL) {
        return jsonRes({
          token: 'jt-fresh',
          refresh_token: 'rt',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (url === QODER_USERINFO_URL) return jsonRes({ id: 'user-from-api' });
      throw new Error(`unexpected url ${url}`);
    });
    const resolved = await resolveQoderCredentials({ apiKey: 'pt-secret' });
    expect(resolved.accessToken).toBe('jt-fresh');
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.providerSpecificData.userId).toBe('user-from-api');
    expect(resolved.providerSpecificData.authMethod).toBe('pat');

    // Cached: a second resolve for the same PAT makes no further calls.
    const callsBefore = mocks.proxyAwareFetch.mock.calls.length;
    await resolveQoderCredentials({ apiKey: 'pt-secret' });
    expect(mocks.proxyAwareFetch.mock.calls.length).toBe(callsBefore);
  });

  it('falls back to the stored userId when userinfo fails, and honours expires_in', async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      if (url === QODER_JOB_TOKEN_EXCHANGE_URL) {
        return jsonRes({ token: 'jt-2', expires_in: 60_000 });
      }
      return jsonRes({}, { ok: false, status: 500 });
    });
    const resolved = await resolveQoderCredentials({
      accessToken: 'pt-other',
      providerSpecificData: { userId: 'stored-user' },
    });
    expect(resolved.accessToken).toBe('jt-2');
    expect(resolved.providerSpecificData.userId).toBe('stored-user');
  });

  it('throws on a failed exchange and on a missing token', async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonRes({ msg: 'no' }, { ok: false, status: 403 }));
    await expect(resolveQoderCredentials({ apiKey: 'pt-bad' })).rejects.toThrow(/403/);
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonRes({}));
    await expect(resolveQoderCredentials({ apiKey: 'pt-empty' })).rejects.toThrow(/no job token/);
  });

  it('passes non-PAT credentials through unchanged', async () => {
    const creds = { accessToken: 'dt-plain', providerSpecificData: { userId: 'u' } };
    expect(await resolveQoderCredentials(creds)).toBe(creds);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe('resolveQoderModels catalog fetch', () => {
  it('routes a jt- token to the alternate chat base and maps model fields', async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonRes(CATALOG));
    const result = await resolveQoderModels(jtCreds);
    const listUrl = mocks.proxyAwareFetch.mock.calls[0][0];
    expect(listUrl).toBe(`${QODER_CHAT_BASE_ALT}/algo/api/v2/model/list`);

    const listed = result.models.find((m) => m.id === CHAT_ENTRY.key);
    expect(listed).toEqual(
      expect.objectContaining({
        name: CHAT_ENTRY.display_name,
        contextLength: CHAT_ENTRY.max_input_tokens,
        isVL: true,
        isReasoning: true,
        maxOutputTokens: CHAT_ENTRY.max_output_tokens,
      })
    );
    // Disabled entries stay out of models but keep their config cached.
    expect(result.models.some((m) => m.id === 'hidden_model')).toBe(false);
    expect(result.rawConfigs.has('hidden_model')).toBe(true);
  });

  it('routes a non-jt token to the primary model list URL', async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonRes(CATALOG));
    await resolveQoderModels({ accessToken: 'dt-x', providerSpecificData: { userId: 'u2' } });
    expect(mocks.proxyAwareFetch.mock.calls[0][0]).toBe(QODER_MODEL_LIST_URL);
  });

  it('caches per credential and invalidates on demand', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonRes(CATALOG));
    await resolveQoderModels(jtCreds);
    await resolveQoderModels(jtCreds);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    invalidateQoderCatalog(jtCreds);
    await resolveQoderModels(jtCreds);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    invalidateQoderCatalog(null); // no-op branch
  });

  it('coalesces concurrent misses into one upstream call', async () => {
    let release;
    mocks.proxyAwareFetch.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(jsonRes(CATALOG));
        })
    );
    const p1 = resolveQoderModels(jtCreds);
    const p2 = resolveQoderModels(jtCreds);
    await new Promise((r) => setImmediate(r));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null on HTTP failure, bad body shape, and missing identity', async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonRes({}, { ok: false, status: 500 }));
    expect(await resolveQoderModels(jtCreds)).toBeNull();
    clearQoderCatalog();
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonRes({ not_chat: [] }));
    expect(await resolveQoderModels(jtCreds)).toBeNull();
    expect(await resolveQoderModels({ accessToken: 'jt-x', providerSpecificData: {} })).toBeNull();
    expect(await resolveQoderModels(null)).toBeNull();
  });

  it('returns null and warns when the PAT exchange fails inside resolveQoderModels', async () => {
    const log = { warn: vi.fn() };
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonRes({}, { ok: false, status: 403 }));
    expect(await resolveQoderModels({ apiKey: 'pt-dead' }, { log })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('QODER', expect.stringContaining('PAT exchange failed'));
  });

  it('propagates a pre-aborted caller signal as a rejection', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    mocks.proxyAwareFetch.mockImplementation(async (_url, init) => {
      if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
      return jsonRes(CATALOG);
    });
    await expect(resolveQoderModels(jtCreds, { signal: controller.signal })).rejects.toThrow(
      'gone'
    );
  });

  it('forwards a live caller abort onto the fetch signal', async () => {
    const controller = new AbortController();
    let sawAbort;
    mocks.proxyAwareFetch.mockImplementation(
      (_url, init) =>
        new Promise((_res, rej) => {
          sawAbort = new Promise((r) =>
            init.signal.addEventListener('abort', () => {
              r(true);
              rej(init.signal.reason);
            })
          );
        })
    );
    const p = resolveQoderModels(jtCreds, { signal: controller.signal });
    p.catch(() => {}); // rejection asserted below; keep it handled meanwhile
    await new Promise((r) => setImmediate(r));
    controller.abort(new Error('caller left'));
    expect(await sawAbort).toBe(true);
    await expect(p).rejects.toThrow('caller left');
  });
});

describe('getQoderModelConfig', () => {
  it('returns a defensive copy keyed to the requested model', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonRes(CATALOG));
    const config = await getQoderModelConfig(jtCreds, 'hidden_model');
    expect(config.key).toBe('hidden_model');
    config.key = 'mutated';
    const again = await getQoderModelConfig(jtCreds, 'hidden_model');
    expect(again.key).toBe('hidden_model');
  });

  it('returns null for an unknown key and when the catalog is unavailable', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonRes(CATALOG));
    expect(await getQoderModelConfig(jtCreds, 'no-such-model')).toBeNull();
    clearQoderCatalog();
    mocks.proxyAwareFetch.mockResolvedValue(jsonRes({}, { ok: false, status: 500 }));
    expect(await getQoderModelConfig(jtCreds, CHAT_ENTRY.key)).toBeNull();
  });
});
