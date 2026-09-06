// Coverage for open-sse/services/capacityAdapter.js: config normalization,
// strategy selection, pooled model flattening, history stripping, and the
// handleSingleModel wrapper. Capability lookups are mocked so expectations
// derive from the adapter's own contracts, not from any provider catalog.
import { afterEach, describe, expect, it, vi } from 'vitest';

const capsByModel = new Map();
vi.mock('open-sse/providers/capabilities.js', () => ({
  getCapabilitiesForModel: vi.fn(
    (provider, model) => capsByModel.get(`${provider}/${model}`) || capsByModel.get(model) || {}
  ),
}));

import {
  getCapacityAdapterConfig,
  getCapacityAdapterModels,
  getCapacityAdapterStrategy,
  getActiveAdapterStrategy,
  augmentModelsWithCapacityAdapter,
  stripHistoryForContext,
  withCapacityAdapterStripping,
} from 'open-sse/services/capacityAdapter.js';

afterEach(() => {
  capsByModel.clear();
  vi.clearAllMocks();
});

describe('getCapacityAdapterConfig', () => {
  it('normalizes the legacy array form: entries via .model, falsy dropped, enabled fallback', () => {
    const settings = {
      capacityAdapter: { vision: [{ model: 'a/m1' }, 'b/m2', null, ''] },
    };
    const cfg = getCapacityAdapterConfig('vision', settings);
    expect(cfg).toEqual({ enabled: true, roundRobin: false, models: ['a/m1', 'b/m2'] });
  });

  it('substitutes the default fallback model when enabled with an empty pool', () => {
    const cfg = getCapacityAdapterConfig('vision', {
      capacityAdapter: { vision: { enabled: true, models: [] } },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.models).toHaveLength(1);
    expect(typeof cfg.models[0]).toBe('string');
  });

  it('missing or malformed entry disables the capability', () => {
    expect(getCapacityAdapterConfig('pdf', {})).toEqual({
      enabled: false,
      roundRobin: false,
      models: [],
    });
    expect(getCapacityAdapterConfig('pdf', { capacityAdapter: { pdf: 42 } })).toEqual({
      enabled: false,
      roundRobin: false,
      models: [],
    });
  });
});

describe('getCapacityAdapterModels', () => {
  it('flattens enabled pools in capability order, deduped, skipping disabled', () => {
    const settings = {
      capacityAdapter: {
        vision: { enabled: true, models: ['x/a', 'x/b'] },
        pdf: { enabled: false, models: ['x/c'] },
        audioInput: { enabled: true, models: ['x/b', 'x/d'] },
      },
    };
    expect(getCapacityAdapterModels(settings)).toEqual(['x/a', 'x/b', 'x/d']);
  });
});

describe('strategy selection', () => {
  it('round-robin only when enabled AND roundRobin', () => {
    expect(
      getCapacityAdapterStrategy('vision', {
        capacityAdapter: { vision: { enabled: true, roundRobin: true, models: ['x/a'] } },
      })
    ).toBe('round-robin');
    expect(
      getCapacityAdapterStrategy('vision', {
        capacityAdapter: { vision: { enabled: true, models: ['x/a'] } },
      })
    ).toBe('fallback');
    expect(
      getCapacityAdapterStrategy('vision', {
        capacityAdapter: { vision: { enabled: false, roundRobin: true, models: ['x/a'] } },
      })
    ).toBe('fallback');
  });

  it('getActiveAdapterStrategy picks the first hard capability with a usable pool', () => {
    const settings = {
      capacityAdapter: {
        vision: { enabled: false, models: ['x/a'] },
        pdf: { enabled: true, roundRobin: true, models: ['x/b'] },
      },
    };
    expect(getActiveAdapterStrategy(['vision', 'pdf'], settings)).toBe('round-robin');
    expect(getActiveAdapterStrategy(['vision'], settings)).toBe('fallback');
    expect(getActiveAdapterStrategy([], settings)).toBe('fallback');
    expect(getActiveAdapterStrategy(null, settings)).toBe('fallback');
    expect(getActiveAdapterStrategy(['not-a-hard-cap'], settings)).toBe('fallback');
  });
});

describe('augmentModelsWithCapacityAdapter', () => {
  it('no-ops on empty hard caps, non-array models, or empty models', () => {
    expect(augmentModelsWithCapacityAdapter(['a/m'], [], {})).toEqual(['a/m']);
    expect(augmentModelsWithCapacityAdapter(null, ['vision'], {})).toBeNull();
    expect(augmentModelsWithCapacityAdapter([], ['vision'], {})).toEqual([]);
  });

  it('prepends capable pool models when no original model satisfies, dedupes originals', () => {
    capsByModel.set('pool/cap', { vision: true });
    capsByModel.set('orig/nocap', {});
    const settings = {
      capacityAdapter: { vision: { enabled: true, models: ['pool/cap', 'orig/nocap'] } },
    };
    const out = augmentModelsWithCapacityAdapter(['orig/nocap'], ['vision'], settings);
    expect(out).toEqual(['pool/cap', 'orig/nocap']);
  });

  it('leaves models untouched when a member already satisfies, or the pool cannot', () => {
    capsByModel.set('orig/cap', { vision: true });
    const settings = { capacityAdapter: { vision: { enabled: true, models: ['pool/nocap'] } } };
    expect(augmentModelsWithCapacityAdapter(['orig/cap'], ['vision'], settings)).toEqual([
      'orig/cap',
    ]);
    capsByModel.clear();
    expect(augmentModelsWithCapacityAdapter(['orig/nocap'], ['vision'], settings)).toEqual([
      'orig/nocap',
    ]);
  });

  it('handles bare model strings without a provider slash', () => {
    capsByModel.set('bare', { vision: true });
    expect(augmentModelsWithCapacityAdapter(['bare'], ['vision'], {})).toEqual(['bare']);
  });
});

describe('stripHistoryForContext', () => {
  const msg = (role, text) => ({ role, content: text });

  it('returns body unchanged when no message-array key exists or the array is empty', () => {
    const b1 = { foo: 1 };
    expect(stripHistoryForContext(b1, 100)).toBe(b1);
    const b2 = { messages: [] };
    expect(stripHistoryForContext(b2, 100)).toBe(b2);
  });

  it('returns body unchanged when only system messages exist, or no older turns', () => {
    const sysOnly = { messages: [msg('system', 's')] };
    expect(stripHistoryForContext(sysOnly, 100)).toBe(sysOnly);
    const noOlder = { messages: [msg('system', 's'), msg('user', 'current')] };
    expect(stripHistoryForContext(noOlder, 100)).toBe(noOlder);
  });

  it('keeps system + head + trailing user run, drops the middle', () => {
    const big = 'x'.repeat(2000);
    const older = [];
    for (let i = 0; i < 10; i++) {
      older.push(msg('user', `${big}-u${i}`), msg('assistant', `${big}-a${i}`));
    }
    const body = { messages: [msg('system', 'sys'), ...older, msg('user', 'tail-with-media')] };
    // Tiny context window forces dropping; head trims from the end first.
    const out = stripHistoryForContext(body, 1);
    expect(out).not.toBe(body);
    expect(out.messages[0].role).toBe('system');
    expect(out.messages.at(-1).content).toBe('tail-with-media');
    expect(out.messages.length).toBeLessThan(body.messages.length);
    // Original body untouched
    expect(body.messages.length).toBe(22);
  });

  it('returns body unchanged when head keep covers all older turns within budget', () => {
    const body = {
      messages: [
        msg('system', 's'),
        msg('user', 'u1'),
        msg('assistant', 'a1'),
        msg('user', 'tail'),
      ],
    };
    expect(stripHistoryForContext(body, 200000)).toBe(body);
  });

  it('supports the input and contents keys and array-block content lengths', () => {
    const blocks = [{ text: 'x'.repeat(500) }, { type: 'image' }];
    const older = [];
    for (let i = 0; i < 12; i++)
      older.push({ role: 'user', content: blocks }, { role: 'model', content: blocks });
    const body = {
      input: [
        { role: 'developer', content: 'd' },
        ...older,
        { role: 'user', content: [{ text: 'tail' }] },
      ],
    };
    const out = stripHistoryForContext(body, 1);
    expect(out.input[0].role).toBe('developer');
    // contents key with parts
    const cBody = {
      contents: [
        { role: 'user', parts: 'p1' },
        { role: 'model', parts: 'p2' },
        { role: 'user', parts: 'tail' },
      ],
    };
    expect(stripHistoryForContext(cBody, 200000)).toBe(cBody);
  });
});

describe('withCapacityAdapterStripping', () => {
  it('returns the handler itself when the pool is empty', () => {
    const h = vi.fn();
    expect(withCapacityAdapterStripping(h, [])).toBe(h);
  });

  it('strips history only for adapter models, passing extra args through', () => {
    capsByModel.set('p/adapter', { contextWindow: 1 });
    const seen = [];
    const handler = (body, modelStr, extra) => {
      seen.push({ body, modelStr, extra });
      return 'ret';
    };
    const wrapped = withCapacityAdapterStripping(handler, ['p/adapter']);

    const big = 'x'.repeat(5000);
    const older = [];
    for (let i = 0; i < 10; i++)
      older.push({ role: 'user', content: big }, { role: 'assistant', content: big });
    const body = { messages: [...older, { role: 'user', content: 'tail' }] };

    expect(wrapped(body, 'p/adapter', 'extra1')).toBe('ret');
    expect(seen[0].modelStr).toBe('p/adapter');
    expect(seen[0].extra).toBe('extra1');
    expect(seen[0].body.messages.length).toBeLessThan(body.messages.length);

    expect(wrapped(body, 'other/model', 'extra2')).toBe('ret');
    expect(seen[1].body).toBe(body); // untouched for non-adapter model
  });
});
