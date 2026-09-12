import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleComboChat } from '../../open-sse/services/combo.js';

const log = { info() {}, warn() {}, error() {} };
const body = { messages: [{ role: 'user', content: 'hello' }] };
const failure = (status, message, headers = {}) => Response.json({ error: { message } }, {
  status, headers: { 'x-tokenproxy-replay-safe': 'true', ...headers },
});
const run = (models, dispatch) => handleComboChat({ body, models, handleSingleModel: dispatch, log });

describe('combo exhaustion preserves failure evidence', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-12T12:00:00Z'); });
  afterEach(() => vi.useRealTimers());

  it.each(['30', 'Sat, 12 Sep 2026 12:00:30 GMT'])('retains Retry-After %s and safe rejection proof', async (retryAfter) => {
    const response = await run(['p/a'], async () => failure(429, 'quota exhausted', { 'retry-after': retryAfter }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('true');
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('quota exhausted') } });
  });

  it('uses elapsed time rather than restarting an earlier retry window', async () => {
    const response = await run(['p/a', 'p/b'], async (_, model) => {
      if (model === 'p/a') return failure(429, 'first quota', { 'retry-after': '30' });
      vi.setSystemTime(Date.now() + 12_000);
      return failure(429, 'second quota', { 'retry-after': '60' });
    });
    expect(response.headers.get('retry-after')).toBe('18');
    expect((await response.json()).error.message).toContain('first quota');
  });

  it.each([
    [[400, 'context length exceeded'], [429, 'quota exhausted']],
    [[429, 'quota exhausted'], [400, 'context length exceeded']],
  ].map(errors => ({ errors })))('keeps status and message from the actionable quota failure', async ({ errors }) => {
    let count = 0;
    const response = await run(['p/a', 'p/b'], async () => failure(...errors[count++]));
    expect(count).toBe(2);
    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toBe('quota exhausted');
  });

  it('lets an exhausted safe nested combo reach its healthy outer sibling', async () => {
    const calls = [];
    const response = await run(['nested', 'p/healthy'], async (_, model) => {
      calls.push(model);
      if (model === 'nested') return run(['p/a', 'p/b'], async (_, inner) => {
        calls.push(inner);
        return failure(429, 'quota exhausted');
      });
      return Response.json({ choices: [{ message: { content: 'healthy' } }] });
    });
    expect(calls).toEqual(['nested', 'p/a', 'p/b', 'p/healthy']);
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('healthy');
  });

  it.each(['false', null])('does not traverse beyond an unsafe or unknown member (%s)', async (proof) => {
    const calls = [];
    const response = await run(['p/a', 'p/unsafe', 'p/never'], async (_, model) => {
      calls.push(model);
      const result = failure(429, model);
      if (model === 'p/unsafe') {
        if (proof === null) result.headers.delete('x-tokenproxy-replay-safe');
        else result.headers.set('x-tokenproxy-replay-safe', proof);
      }
      return result;
    });
    expect(calls).toEqual(['p/a', 'p/unsafe']);
    expect(response.headers.get('x-tokenproxy-replay-safe')).not.toBe('true');
    expect(response.headers.get('x-should-retry')).toBe('false');
  });

  it.each(['garbage', '-1', '0'])('does not invent a retry window for invalid header %s', async (header) => {
    const response = await run(['p/a'], async () => failure(429, 'quota', { 'retry-after': header }));
    expect(response.headers.has('retry-after')).toBe(false);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('true');
  });
});
