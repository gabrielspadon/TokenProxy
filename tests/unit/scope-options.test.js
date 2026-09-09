import { describe, expect, it } from 'vitest';
import {
  POPULAR_PROVIDERS,
  modelsForAccounts,
  providerChoiceId,
  providerChoices,
  providerIdOf,
} from '@/shared/workspace/scopeOptions';

const models = [
  { provider: 'cx', model: 'gpt-5.2' },
  { provider: 'openai', model: 'gpt-5.2' },
  { provider: 'cc', model: 'claude-opus-5' },
  { provider: 'kimi', model: 'kimi-k2' },
];
const accounts = [{ provider: 'codex' }, { provider: 'openai' }, { provider: 'claude' }];

describe('scope options', () => {
  it('lists only models of providers with an account, matching alias and id', () => {
    expect(modelsForAccounts(models, accounts).map((item) => `${item.provider}/${item.model}`)).toEqual([
      'cx/gpt-5.2',
      'openai/gpt-5.2',
      'cc/claude-opus-5',
    ]);
    expect(modelsForAccounts(models, accounts, 'codex')).toEqual([{ provider: 'cx', model: 'gpt-5.2' }]);
    expect(modelsForAccounts(models, [], null)).toEqual([]);
  });
  it('resolves a model row alias back to the provider id', () => {
    expect(providerIdOf('cx')).toBe('codex');
    expect(providerIdOf('cc')).toBe('claude');
    expect(providerIdOf('openai')).toBe('openai');
    expect(providerIdOf('unknown-thing')).toBe('unknown-thing');
  });
  it('puts popular providers first and keeps every provider in the full list', () => {
    const entries = [
      { id: 'zeta', name: 'Zeta' },
      { id: 'codex', name: 'OpenAI Codex' },
      { id: 'claude', name: 'Claude Code' },
      { id: 'alpha', name: 'Alpha' },
    ];
    const [popular, all] = providerChoices(entries);
    expect(popular.group).toBe('Popular');
    expect(popular.items.map((item) => item.label)).toEqual(['Claude Code', 'OpenAI Codex']);
    expect(all.group).toBe('All providers');
    expect(all.items.map((item) => item.value)).toEqual(['alpha', 'claude', 'codex', 'zeta']);
    expect(new Set([...popular.items, ...all.items].map((item) => item.value)).size).toBe(6);
    expect(providerChoiceId(popular.items[0].value)).toBe('claude');
    expect(providerChoiceId('zeta')).toBe('zeta');
    expect(providerChoiceId(null)).toBeNull();
    expect(POPULAR_PROVIDERS).toContain('claude');
    expect(POPULAR_PROVIDERS).toContain('codex');
  });
});
