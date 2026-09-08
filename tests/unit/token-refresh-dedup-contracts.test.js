/**
 * Contract tests for open-sse/services/tokenRefresh/dedup.js: in-flight
 * coalescing, result TTL, failure eviction, fingerprint shape, chain-peer
 * registry bounds and label capping. All timing goes through fake timers;
 * no network is touched (the module makes no requests itself).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { tokenFingerprint, chainPeers, connsLabel, dedupRefresh } =
  await import('open-sse/services/tokenRefresh/dedup.js');

// Unique tokens per test: the module-level dedup cache persists across cases.
let seq = 0;
const freshToken = () => `tok-${Date.now()}-${seq++}`;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tokenFingerprint', () => {
  it('is the first 8 hex of sha256 and never the token', () => {
    const token = 'secret-token-value';
    const expected = createHash('sha256').update(token).digest('hex').slice(0, 8);
    expect(tokenFingerprint(token)).toBe(expected);
    expect(tokenFingerprint(token)).toHaveLength(8);
    expect(tokenFingerprint(token)).not.toContain('secret');
  });

  it('null for empty input', () => {
    expect(tokenFingerprint('')).toBeNull();
    expect(tokenFingerprint(null)).toBeNull();
  });
});

describe('connsLabel', () => {
  it('caps at 3 with a +N tail', () => {
    expect(connsLabel(null)).toBeNull();
    expect(connsLabel([])).toBeNull();
    expect(connsLabel(['a', 'b'])).toBe('a,b');
    expect(connsLabel(['a', 'b', 'c', 'd', 'e'])).toBe('a,b,c+2');
  });
});

describe('dedupRefresh coalescing', () => {
  it('no token: every call runs its own fn', async () => {
    const fn = vi.fn().mockResolvedValue('r');
    await dedupRefresh('p', '', fn);
    await dedupRefresh('p', null, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls on the same provider:token share one in-flight promise', async () => {
    const token = freshToken();
    let resolveFn;
    const fn = vi.fn(
      () =>
        new Promise((res) => {
          resolveFn = res;
        })
    );
    const log = { info: vi.fn() };

    const p1 = dedupRefresh('prov', token, fn, log, 'conn0000');
    const p2 = dedupRefresh('prov', token, fn, log, 'conn1111');
    await Promise.resolve();
    resolveFn('fresh');
    await expect(p1).resolves.toBe('fresh');
    await expect(p2).resolves.toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('TOKEN_REFRESH', expect.stringContaining('in-flight'));
  });

  it('different tokens do not coalesce', async () => {
    const fn = vi.fn().mockResolvedValue('r');
    await dedupRefresh('prov', freshToken(), fn);
    await dedupRefresh('prov', freshToken(), fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a settled result is reused within its TTL, then expires', async () => {
    const token = freshToken();
    const fn = vi.fn().mockResolvedValue('first');
    const log = { info: vi.fn() };

    await dedupRefresh('prov', token, fn, log, 'connAAAA');
    const reused = await dedupRefresh('prov', token, fn, log, 'connBBBB');
    expect(reused).toBe('first');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'TOKEN_REFRESH',
      expect.stringContaining('recent refresh result')
    );

    // Past the result TTL the cached entry is dead and fn runs again.
    await vi.advanceTimersByTimeAsync(11_000);
    fn.mockResolvedValue('second');
    await expect(dedupRefresh('prov', token, fn, log)).resolves.toBe('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a failed refresh is evicted so the next call retries', async () => {
    const token = freshToken();
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    await expect(dedupRefresh('prov', token, fn)).rejects.toThrow('boom');
    await expect(dedupRefresh('prov', token, fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('chainPeers', () => {
  it('lists the other connections seen with the token, excluding the asker', async () => {
    const token = freshToken();
    const fp = tokenFingerprint(token);
    const fn = vi.fn().mockResolvedValue('r');
    await dedupRefresh('prov', token, fn, null, 'connX');
    await dedupRefresh('prov', token, fn, null, 'connY');

    expect(chainPeers(fp, 'connX')).toEqual(['connY']);
    expect(chainPeers(fp, null).sort()).toEqual(['connX', 'connY']);
    expect(chainPeers('00000000', null)).toEqual([]);
  });

  it('expires members past the chain TTL', async () => {
    const token = freshToken();
    const fp = tokenFingerprint(token);
    await dedupRefresh('prov', token, vi.fn().mockResolvedValue('r'), null, 'connZ');
    expect(chainPeers(fp, null)).toEqual(['connZ']);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 1000);
    expect(chainPeers(fp, null)).toEqual([]);
  });

  it('caps members per chain, evicting the oldest', async () => {
    const token = freshToken();
    const fp = tokenFingerprint(token);
    const fn = () => Promise.resolve('r');
    for (let i = 0; i < 20; i++) {
      await dedupRefresh('prov', token, fn, null, `c${i}`);
      await vi.advanceTimersByTimeAsync(11_000); // step past result TTL so each call re-registers
    }
    const peers = chainPeers(fp, null);
    expect(peers.length).toBeLessThanOrEqual(16);
    expect(peers).not.toContain('c0');
    expect(peers).toContain('c19');
  });
});
