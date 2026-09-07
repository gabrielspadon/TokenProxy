import { describe, expect, it } from 'vitest';
import { overrideCandidates, parseWindow, resolveWindowOverride } from '../../src/app/dashboard/model-context/contextModel.js';

describe('context-window editor contracts', () => {
  it('matches exact keys in engine precedence before case-insensitive wildcard insertion order', () => {
    const overrides = { '*astra*': 10, 'gpt-6-astra': 20, 'vendor/gpt-6-astra': 30, 'codex/gpt-6-astra': 40, 'codex/vendor/gpt-6-astra': 50 };
    const expected = ['codex/vendor/gpt-6-astra', 'codex/gpt-6-astra', 'gpt-6-astra', 'vendor/gpt-6-astra', '*astra*'];
    for (const key of expected) {
      expect(resolveWindowOverride(overrides, 'codex', 'vendor/gpt-6-astra').key).toBe(key);
      delete overrides[key];
    }
    expect(resolveWindowOverride(overrides, 'codex', 'vendor/gpt-6-astra')).toBeNull();
    expect(resolveWindowOverride({ '*ASTRA*': 10, 'codex/*': 20 }, 'codex', 'gpt-6-astra').key).toBe('*ASTRA*');
  });
  it('retains vendor-prefixed raw identity', () => {
    expect(overrideCandidates('codex', 'vendor/gpt-6-astra').map(row => row.key)).toEqual(['codex/vendor/gpt-6-astra', 'codex/gpt-6-astra', 'gpt-6-astra', 'vendor/gpt-6-astra']);
  });
  it.each(['', ' ', '0', '-1', '1.5', '1e6', 'Infinity', '9007199254740992'])('rejects invalid or imprecise token input %j', value => {
    expect(parseWindow(value)).toBeNull();
  });
  it('preserves exact positive whole tokens', () => {
    expect(parseWindow('1048576')).toBe(1048576);
  });
});
