// Registry rows for models the vendors shipped but the registry did not carry,
// plus the grok-4.6 capability pattern. Without the pattern, grok-4.6 falls to
// the generic *grok-4* glob and is capped at 256k instead of the 500k x.ai
// serves. Upstream 9c650e1d5 (registry rows + grok-4.6 pattern only).
import { describe, expect, it } from 'vitest';
import { PROVIDER_MODELS } from '../../open-sse/config/providerModels.js';
import { getCapabilitiesForModel } from '../../open-sse/providers/capabilities.js';

const idsFor = (alias) => (PROVIDER_MODELS[alias] || []).map((m) => m.id);

describe('vendor model rows resolve on their providers', () => {
  it.each([
    ['glm', 'glm-5.3-flash'],
    ['glm-cn', 'glm-5.3-flash'],
    ['glm-cn', 'glm-4.6v'],
    ['opencode-go', 'glm-5.3-flash'],
    ['opencode-go', 'deepseek-v4-flash-vision-exp'],
  ])('%s lists %s', (alias, model) => {
    expect(idsFor(alias)).toContain(model);
  });

  it('opencode-go keeps its chat-only transport pin on the new GLM row', () => {
    const row = (PROVIDER_MODELS['opencode-go'] || []).find((m) => m.id === 'glm-5.3-flash');
    expect(row?.supportedFormats).toEqual(['openai']);
  });

  // getDefaultModel returns models[0], so an insert must not land at the top.
  it.each(['glm', 'glm-cn', 'opencode-go'])(
    '%s default model is unchanged by the inserts',
    (alias) => {
      expect(idsFor(alias)[0]).not.toBe('glm-5.3-flash');
      expect(idsFor(alias)[0]).not.toBe('deepseek-v4-flash-vision-exp');
    }
  );
});

describe('grok-4.6 capability window', () => {
  it('reports the 500k context x.ai documents, not the *grok-4* 256k default', () => {
    const caps = getCapabilitiesForModel('xai', 'grok-4.6');
    expect(caps.contextWindow).toBe(500000);
    expect(caps.maxOutput).toBe(500000);
    expect(caps.vision).toBe(true);
    expect(caps.search).toBe(true);
  });

  it('leaves grok-4.5 and the generic grok-4 glob alone', () => {
    const g45 = getCapabilitiesForModel('xai', 'grok-4.5');
    expect(g45.contextWindow).toBe(500000);
    expect(g45.maxOutput).toBe(64000);
    expect(getCapabilitiesForModel('xai', 'grok-4').contextWindow).toBe(256000);
  });
});
