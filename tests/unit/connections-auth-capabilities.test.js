import { describe, expect, it } from 'vitest';
import REGISTRY from 'open-sse/providers/registry/index.js';
import { AI_PROVIDERS } from '@/shared/constants/providers';

describe('connection authentication choices', () => {
  it.each(REGISTRY.filter(entry => entry.oauth || entry.category === 'oauth' || entry.hasOAuth))(
    'exposes the registered OAuth mechanism for $id',
    entry => {
      expect(AI_PROVIDERS[entry.id].hasOAuth).toBe(true);
      expect(AI_PROVIDERS[entry.id].authModes).toContain('oauth');
    },
  );
  it.each(REGISTRY.filter(entry => entry.authModes))('preserves declared modes for $id', entry => {
    expect(AI_PROVIDERS[entry.id].authModes).toEqual(entry.authModes);
  });
  it.each(REGISTRY.filter(entry => entry.noAuth))('does not invent a credential for $id', entry => {
    expect(AI_PROVIDERS[entry.id].authModes).toEqual(['none']);
  });
});
