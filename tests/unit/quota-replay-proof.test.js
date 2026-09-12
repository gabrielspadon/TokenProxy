import { describe, expect, it } from 'vitest';
import { isSafeQuotaAccountRejection } from '../../open-sse/utils/replaySafety.js';

const rejected = (headers = {}) => new Response(null, { status: 429, headers });
const canonical = () => ({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage credits are required.' } });

describe('quota rejection proof', () => {
  it('separates same-account retry advice from a complete rejected-generation envelope', () => {
    expect(isSafeQuotaAccountRejection(rejected({ 'x-should-retry': 'false' }), canonical())).toBe(true);
  });
  it('preserves explicit accepted-generation provenance on a synthetic 429', () => {
    expect(isSafeQuotaAccountRejection(rejected({ 'x-tokenproxy-replay-safe': 'false' }), canonical())).toBe(false);
  });
  it.each([null, {}, { error: 'quota' }, { error: { message: '' } }, { ...canonical(), usage: { total_tokens: 0 } },
    { ...canonical(), output: [] }, { ...canonical(), choices: [] },
    { error: { message: 'quota', metadata: { cost: 0 } } },
    { error: { message: 'quota', metadata: { tool_calls: [] } } },
  ])('refuses incomplete, noncanonical or generation-bearing evidence %j', payload => {
    expect(isSafeQuotaAccountRejection(rejected(), payload)).toBe(false);
  });
});
