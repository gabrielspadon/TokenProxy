import { describe, expect, it } from 'vitest';
import { isAccountModelDisabled as disabled, resolveDisabledModelProvider } from '@/shared/utils/disabledModelPolicy.js';

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
  it('accepts a verified custom provider prefix without changing the upstream model ID', () => {
    expect(disabled({ 'corp::a': ['corp/vendor/model'] }, 'node-id', 'vendor/model', 'a', ['corp'])).toBe(true);
    expect(disabled({ corp: ['m'], 'node-id::a': [] }, 'node-id', 'm', 'a', ['corp'])).toBe(false);
  });
  it('assigns a shadowed alias to its configured node without changing canonical provider ownership', () => {
    const nodes = [{ id: 'node-id', type: 'openai-compatible', prefix: 'cc' }];
    expect(disabled({ cc: ['m'] }, 'node-id', 'm', 'a', ['cc'], nodes)).toBe(true);
    expect(disabled({ cc: ['m'] }, 'claude', 'm', 'a', [], nodes)).toBe(false);
    expect(disabled({ claude: ['m'] }, 'node-id', 'm', 'a', ['cc'], nodes)).toBe(false);
    expect(resolveDisabledModelProvider('cc', nodes)).toBe('node-id');
    expect(resolveDisabledModelProvider('claude', nodes)).toBe('claude');
  });
  it('keeps direct canonical policy IDs distinct even when a node uses one as a route prefix', () => {
    const nodes = [{ id: 'node-id', type: 'openai-compatible', prefix: 'claude' }];
    expect(disabled({ claude: ['m'] }, 'node-id', 'm', 'a', ['claude'], nodes)).toBe(false);
    expect(disabled({ 'node-id': ['claude/vendor/model'] }, 'node-id', 'vendor/model', 'a', ['claude'], nodes)).toBe(true);
    expect(resolveDisabledModelProvider('claude', nodes)).toBe('claude');
    expect(resolveDisabledModelProvider('node-id', nodes)).toBe('node-id');
  });
});
