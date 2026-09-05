// Mutation-kill coverage for adjustMaxTokens: pure function, no I/O.
import { describe, expect, it } from 'vitest';
import { adjustMaxTokens } from '../../open-sse/translator/formats/maxTokens.js';
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from '../../open-sse/config/runtimeConfig.js';

describe('adjustMaxTokens', () => {
  it('defaults to DEFAULT_MAX_TOKENS when max_tokens absent', () => {
    expect(adjustMaxTokens({})).toBe(DEFAULT_MAX_TOKENS);
  });

  it('keeps an explicit max_tokens under the default ceiling', () => {
    expect(adjustMaxTokens({ max_tokens: 100 })).toBe(100);
  });

  it('raises max_tokens to DEFAULT_MIN_TOKENS when tools present and below the floor', () => {
    const out = adjustMaxTokens({ max_tokens: 10, tools: [{ name: 'f' }] });
    expect(out).toBe(DEFAULT_MIN_TOKENS);
  });

  it('does not raise max_tokens for tools when already at or above the floor', () => {
    const out = adjustMaxTokens({ max_tokens: DEFAULT_MIN_TOKENS, tools: [{ name: 'f' }] });
    expect(out).toBe(DEFAULT_MIN_TOKENS);
  });

  it('leaves max_tokens untouched once strictly above the floor (kills always-raise mutant)', () => {
    const above = DEFAULT_MIN_TOKENS + 100;
    const out = adjustMaxTokens({ max_tokens: above, tools: [{ name: 'f' }] });
    expect(out).toBe(above);
  });

  it('ignores an empty tools array', () => {
    expect(adjustMaxTokens({ max_tokens: 10, tools: [] })).toBe(10);
  });

  it('ignores a non-array tools field', () => {
    expect(adjustMaxTokens({ max_tokens: 10, tools: 'nope' })).toBe(10);
  });

  it('bumps max_tokens strictly above thinking.budget_tokens', () => {
    const out = adjustMaxTokens({ max_tokens: 500, thinking: { budget_tokens: 500 } });
    expect(out).toBe(500 + 1024);
  });

  it('leaves max_tokens alone when already strictly greater than budget_tokens', () => {
    const out = adjustMaxTokens({ max_tokens: 600, thinking: { budget_tokens: 500 } });
    expect(out).toBe(600);
  });

  it('does not touch max_tokens when thinking has no budget_tokens', () => {
    const out = adjustMaxTokens({ max_tokens: 600, thinking: {} });
    expect(out).toBe(600);
  });

  it('clamps to the given ceiling even after the thinking bump', () => {
    const out = adjustMaxTokens({ max_tokens: 100, thinking: { budget_tokens: 200 } }, 150);
    expect(out).toBe(150);
  });

  it('clamps a value above a custom ceiling', () => {
    expect(adjustMaxTokens({ max_tokens: 999999 }, 5000)).toBe(5000);
  });

  it('does not clamp a value exactly at the ceiling', () => {
    expect(adjustMaxTokens({ max_tokens: 5000 }, 5000)).toBe(5000);
  });
});
