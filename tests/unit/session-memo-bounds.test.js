// PERFORMANCE-DELIVERY item 5 requires deterministic preparation to be cached
// "only with bounded memory, correct credential/privacy scope and
// content/model/protocol/configuration/tokenizer/transformation version keys".
// sessionMemo is the store the prefix-rung savers (qac, reorder) replay their
// decisions from, so its ceiling, its expiry and its namespace separation are
// the properties that keep one session's decisions out of another's prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoClear, memoGet, memoSet, textKey } from '../../open-sse/services/memory/sessionMemo.js';

const CAP = 4096;
const TTL_MS = 2 * 60 * 60 * 1000;

beforeEach(() => memoClear());
afterEach(() => {
  vi.useRealTimers();
  memoClear();
});

describe('sessionMemo bounds and scope', () => {
  it('stays under its cap as sessions accumulate, keeping the newest', async () => {
    for (let i = 0; i < CAP + 600; i++) memoSet('qac', `s${i}`, i);
    // The oldest sessions are gone rather than the table growing without limit.
    expect(memoGet('qac', 's0')).toBeUndefined();
    const newest = CAP + 599;
    expect(memoGet('qac', `s${newest}`)).toBe(newest);
    // Live count is observable only through hits, so probe the whole range.
    let live = 0;
    for (let i = 0; i < CAP + 600; i++) if (memoGet('qac', `s${i}`) !== undefined) live++;
    expect(live).toBeLessThanOrEqual(CAP);
    expect(live).toBeGreaterThan(0);
  });

  it('expires an entry after the TTL rather than replaying a stale decision', () => {
    vi.useFakeTimers();
    memoSet('reorder', 'sess', { order: ['a'] });
    vi.advanceTimersByTime(TTL_MS - 1000);
    expect(memoGet('reorder', 'sess')).toEqual({ order: ['a'] });
    // A read refreshes the entry, so age from the last touch, not the write.
    vi.advanceTimersByTime(TTL_MS + 1000);
    expect(memoGet('reorder', 'sess')).toBeUndefined();
  });

  it('separates namespaces and sessions so one memo never answers for another', () => {
    memoSet('qac', 'sess', 'qac-value');
    memoSet('reorder', 'sess', 'reorder-value');
    expect(memoGet('qac', 'sess')).toBe('qac-value');
    expect(memoGet('reorder', 'sess')).toBe('reorder-value');
    expect(memoGet('qac', 'other-sess')).toBeUndefined();
    // A key that could be read as "ns key" from either side must not collide.
    memoSet('a', 'b c', 1);
    memoSet('a b', 'c', 2);
    expect(memoGet('a', 'b c')).toBe(1);
    expect(memoGet('a b', 'c')).toBe(2);
  });

  it('refuses to store or serve an absent session key', () => {
    memoSet('qac', null, 'x');
    memoSet('qac', '', 'x');
    expect(memoGet('qac', null)).toBeUndefined();
    expect(memoGet('qac', '')).toBeUndefined();
  });

  it('keys memo content on the text, distinguishing length and content', () => {
    expect(textKey('abc')).toBe(textKey('abc'));
    expect(textKey('abc')).not.toBe(textKey('abd'));
    expect(textKey('ab')).not.toBe(textKey('abc'));
    expect(textKey('')).toBe(textKey(''));
  });
});
