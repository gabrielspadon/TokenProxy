import { describe, expect, it } from 'vitest';
import { withReplaySafety } from '../../open-sse/utils/replaySafety.js';

describe('client retry permission', () => {
  it('overrides an upstream retry hint when the accepted outcome is uncertain', async () => {
    const upstream = Response.json({ error: 'outcome unknown' }, { status: 502,
      headers: { 'x-should-retry': 'true', 'retry-after': '4' } });
    const response = withReplaySafety(upstream, false, 2000);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('retry-after')).toBe('4');
    expect(upstream.headers.get('x-should-retry')).toBe('true');
    expect(await response.json()).toEqual({ error: 'outcome unknown' });
  });

  it('lets a client wait on a busy account without permitting account rotation', () => {
    const response = withReplaySafety(new Response('busy', { status: 503 }), false, 1500, true);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(response.headers.get('x-should-retry')).toBe('true');
    expect(response.headers.get('retry-after')).toBe('2');
  });

  it('retains an explicit upstream refusal even when the gateway knows rejection was safe', () => {
    const response = withReplaySafety(new Response('rejected', { status: 429,
      headers: { 'x-should-retry': 'false' } }), false, 0, true);
    expect(response.headers.get('x-should-retry')).toBe('false');
  });

  it('handles immutable response headers without mutating the source', () => {
    const upstream = Response.redirect('https://example.test/rejected', 307);
    const response = withReplaySafety(upstream);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('location')).toBe('https://example.test/rejected');
    expect(upstream.headers.has('x-tokenproxy-replay-safe')).toBe(false);
  });
});
