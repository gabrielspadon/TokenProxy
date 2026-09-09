import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressWithHeadroom, resetHeadroomCircuitBreaker } from '../../open-sse/rtk/headroom.js';
import { compressWithPxpipe } from '../../open-sse/rtk/pxpipe.js';
import { compressMessages } from '../../open-sse/rtk/index.js';
import { reorderByRelevance } from '../../open-sse/utils/embedReorder.js';
import { compressBlobs } from '../../open-sse/utils/linguaCompress.js';
import { autocompact } from '../../open-sse/utils/epochCompact.js';
import { applyMemoryEnhancements } from '../../open-sse/services/memory/index.js';
vi.mock('../../open-sse/rtk/autodetect.js', () => ({ autoDetectFilter: () => () => { throw new Error('PRIVATE-FILTER-CONTENT'); } }));
const secret = 'PRIVATE-CONTEXT-SHOULD-NOT-BE-A-CODE';
afterEach(() => { vi.unstubAllGlobals(); resetHeadroomCircuitBreaker(); });
describe('optional services report observed failures', () => {
  for (const [mode, errorCode] of [['http', 'service_http_error'], ['malformed', 'invalid_response'], ['network', 'service_unavailable']]) {
    it(`Headroom ${mode} is one failed call with its body retained`, async () => {
      const fetch = vi.fn(async () => {
        if (mode === 'network') throw new Error(secret);
        return new Response(mode === 'malformed' ? '{broken' : secret, { status: mode === 'http' ? 503 : 200 });
      });
      vi.stubGlobal('fetch', fetch);
      const body = { messages: [{ role: 'user', content: 'An ordinary request' }] }, before = structuredClone(body), diagnostics = {};
      expect(await compressWithHeadroom(body, { enabled: true, allowLossy: true, format: 'openai', url: 'http://localhost:8787', diagnostics })).toBeNull();
      expect(diagnostics).toMatchObject({ outcome: 'failed', errorCode }); expect(fetch).toHaveBeenCalledTimes(1); expect(body).toEqual(before);
    });
  }
  it('PXPIPE failure retains the request and redacts arbitrary error text', async () => {
    const body = { messages: [{ role: 'assistant', content: 'x'.repeat(30000) }, { role: 'user', content: 'current request' }] };
    const result = await compressWithPxpipe(body, { enabled: true, allowLossy: true, format: 'claude', transform: async () => { throw new Error(secret); } });
    expect(result.summary).toMatchObject({ outcome: 'failed', errorCode: 'transform_exception' });
    expect(JSON.stringify(result)).not.toContain(secret); expect(result.body).toBeNull();
  });
  it('embedding HTTP failure reports one attempt without reordered messages', async () => {
    const fetch = vi.fn(async () => new Response(secret, { status: 503 })); vi.stubGlobal('fetch', fetch);
    const messages = [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' }, { role: 'assistant', content: 'second answer' }, { role: 'user', content: 'current question' }];
    const result = await reorderByRelevance(messages, { query: 'look for first question', embedUrl: 'http://localhost:11434/v1/embeddings', embedModel: 'fixture', cache: new Map(), keepRecentTurns: 1 });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'service_http_error', moved: 0 }); expect(result.messages).toBe(messages);
    expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify(result.errorCode)).not.toContain(secret);
  });
  it('Lingua distinguishes a service failure from its local skip gates', async () => {
    const messages = [{ role: 'user', content: 'head' }, { role: 'assistant', content: 'answer' },
      { role: 'tool', content: 'A quiet forest surrounds the old village. '.repeat(200) }, { role: 'user', content: 'current question' }];
    const fetchImpl = vi.fn(async () => new Response(secret, { status: 503 }));
    const result = await compressBlobs({ messages }, { epochCutIndex: 1, endpoint: 'http://localhost:8123', fetchImpl });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'service_http_error', applied: false }); expect(result.messages).toBe(messages);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await compressBlobs({ messages }, { epochCutIndex: 0 })).not.toHaveProperty('outcome', 'failed');
  });
  it('an epoch summarizer rejection is explicit and preserves all messages', async () => {
    const messages = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'retained history '.repeat(100) }));
    const summarizeFn = vi.fn(async () => { throw new Error(secret); });
    const result = await autocompact({ messages }, { windowTokens: 100, usedTokens: 1000, epochCutIndex: 1, keepRecentTurns: 2, summarizeFn });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'invalid_response', applied: false }); expect(result.messages).toBe(messages);
    expect(summarizeFn).toHaveBeenCalledTimes(1);
  });
  it('RTK traversal failure emits a bounded diagnostic instead of an ambiguous null', () => {
    const body = { messages: [{ role: 'tool', content: JSON.stringify({ values: Array.from({ length: 500 }, (_, i) => i) }, null, 2) }] };
    Object.freeze(body.messages[0]);
    const diagnostics = {};
    expect(compressMessages(body, true, { diagnostics })).toBeNull();
    expect(diagnostics).toMatchObject({ outcome: 'failed', errorCode: 'transform_exception' });
  });
  it('RTK swallowed filter exceptions still reach the stage diagnostic', () => {
    const body = { messages: [{ role: 'tool', content: 'ordinary text from a tool result '.repeat(500) }] }, before = JSON.stringify(body), diagnostics = {};
    const result = compressMessages(body, true, { allowLossy: true, diagnostics });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'transform_exception' });
    expect(diagnostics).toMatchObject({ outcome: 'failed', errorCode: 'transform_exception' });
    expect(JSON.stringify(body)).toBe(before);
  });
  it('memory preparation refuses an unisolatable collection before any mutation', async () => {
    const messages = [{ role: 'user', content: 'kept', unsupported: () => {} }];
    const body = { messages };
    const result = await applyMemoryEnhancements(body, { settings: { memoryCompactionEnabled: true } });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'transform_exception' });
    expect(body.messages).toBe(messages); expect(body.messages[0].content).toBe('kept');
  });
});
