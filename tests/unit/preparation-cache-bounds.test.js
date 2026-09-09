// PERFORMANCE-DELIVERY item 5: "Cache deterministic preparation only with
// bounded memory ...". Two of the preparation caches sit on the request path
// and grow one entry per live client session, so an unbounded one is a slow
// leak that only shows up on a long-running gateway. These exercise the
// ceilings themselves rather than asserting the constants exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disclosureTools, _cache } from 'open-sse/utils/toolDisclosure.js';
import { reorderByRelevance } from '../../open-sse/utils/embedReorder.js';

const DISCLOSURE_MAX = 500;

function mkTool(name) {
  return { type: 'function', function: { name, description: `does ${name}`, parameters: { type: 'object', properties: {} } } };
}
const TOOLS = Array.from({ length: 40 }, (_, i) => mkTool(`tool_${i}`));
const BODY = { messages: [{ role: 'user', content: 'please do tool_3' }] };

beforeEach(() => {
  _cache.clear();
  vi.unstubAllGlobals();
});

describe('tool disclosure session cache is bounded', () => {
  it('stops growing once past its ceiling, however many sessions arrive', () => {
    for (let i = 0; i < DISCLOSURE_MAX * 2; i++) {
      disclosureTools(TOOLS, BODY, `sess-${i}`, { maxTools: 5 });
    }
    expect(_cache.size).toBeLessThanOrEqual(DISCLOSURE_MAX);
    // The newest session survives: eviction takes the oldest, not the arrival.
    expect(_cache.has(`sess-${DISCLOSURE_MAX * 2 - 1}`)).toBe(true);
  });

  it('keeps a live session disclosures across the eviction of others', () => {
    disclosureTools(TOOLS, BODY, 'long-lived', { maxTools: 5 });
    const disclosed = [..._cache.get('long-lived').disclosed];
    expect(disclosed.length).toBeGreaterThan(0);
    for (let i = 0; i < DISCLOSURE_MAX; i++) {
      disclosureTools(TOOLS, BODY, `churn-${i}`, { maxTools: 5 });
      // Touching the long-lived session each round refreshes its lastSeen, so
      // prune's TTL sweep and its oldest-half fallback both spare it.
      disclosureTools(TOOLS, BODY, 'long-lived', { maxTools: 5 });
    }
    expect(_cache.get('long-lived')?.disclosed).toEqual(disclosed);
  });
});

describe('embedding vector cache is bounded', () => {
  it('evicts least-recently-used entries rather than growing without limit', async () => {
    const cache = new Map();
    const fetchMock = vi.fn(async (_url, opts) => {
      const b = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: b.input.map((text, index) => ({ index, embedding: [text.length % 7, 1, 0] })) }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    // Each call embeds one query plus two historical pairs, so 400 distinct
    // conversations put well over the 512-entry ceiling through the cache.
    for (let i = 0; i < 400; i++) {
      await reorderByRelevance(
        [
          { role: 'user', content: `topic ${i} alpha beta` },
          { role: 'assistant', content: `answer ${i} alpha` },
          { role: 'user', content: `topic ${i} gamma delta` },
          { role: 'assistant', content: `answer ${i} gamma` },
          { role: 'user', content: `current question ${i}` },
          { role: 'assistant', content: `tail ${i}` },
        ],
        {
          query: `topic ${i} alpha beta relevance`,
          embedUrl: 'http://embed.test/v1/embeddings',
          embedModel: 'test-embed',
          keepRecentTurns: 2,
          cache,
        },
      );
    }
    expect(cache.size).toBeLessThanOrEqual(512);
    expect(cache.size).toBeGreaterThan(0);
  });
});
