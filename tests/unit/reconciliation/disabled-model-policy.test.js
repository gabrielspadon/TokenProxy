import { describe, expect, it } from 'vitest';
import { isAccountModelDisabled as disabled } from '@/shared/utils/disabledModelPolicy.js';

describe('pure disabled-model policy', () => {
  it.each(['cc', 'claude'])('resolves canonical and alias keys identically for %s', (provider) => {
    expect(disabled({ 'cc::a': ['m'] }, provider, 'm', 'a')).toBe(true);
    expect(disabled({ 'claude::a': ['cc/m'] }, provider, 'm', 'a')).toBe(true);
    expect(disabled({ cc: ['m'] }, provider, 'claude/m', 'b')).toBe(true);
  });
  it('recognizes additional registered provider aliases', () => {
    expect(disabled({ 'opencode-go::a': ['m'] }, 'ocg', 'm', 'a')).toBe(true);
  });
  it('an own empty array overrides all equivalent provider defaults', () => {
    const policy = { cc: ['m'], claude: ['m'], 'claude::a': [] };
    expect(disabled(policy, 'cc', 'm', 'a')).toBe(false);
    expect(disabled(policy, 'claude', 'm', 'b')).toBe(true);
    expect(disabled(policy, 'cc', 'm')).toBe(true);
  });
  it('an own nonempty list also replaces inheritance', () => {
    expect(disabled({ cc: ['m'], 'claude::a': ['sibling'] }, 'cc', 'm', 'a')).toBe(false);
  });
  it('contradictory duplicate account aliases cannot bypass a disable', () => {
    const policy = { 'cc::a': [], 'claude::a': ['m'] };
    expect(disabled(policy, 'cc', 'm', 'a')).toBe(true);
    expect(disabled(policy, 'claude', 'm', 'a')).toBe(true);
  });
  it('does not cross providers, accounts or model identifiers', () => {
    const policy = { 'cc::a': ['m', 'vendor/model'] };
    expect(disabled(policy, 'openai', 'm', 'a')).toBe(false);
    expect(disabled(policy, 'cc', 'm', 'ab')).toBe(false);
    expect(disabled(policy, 'cc', 'm-more', 'a')).toBe(false);
    expect(disabled(policy, 'cc', 'vendor/model', 'a')).toBe(true);
    expect(disabled(policy, 'cc', 'model', 'a')).toBe(false);
  });
  it('ignores malformed lists without mistaking them for an explicit override', () => {
    expect(disabled({ cc: ['m'], 'cc::a': null }, 'cc', 'm', 'a')).toBe(true);
    expect(disabled(null, 'cc', 'm', 'a')).toBe(false);
    expect(disabled({ cc: ['m'] }, 'cc', null, 'a')).toBe(false);
  });
});
