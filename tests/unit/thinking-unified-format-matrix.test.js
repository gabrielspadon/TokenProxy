/**
 * thinkingUnified.js gap coverage: suffix parsing fallthroughs, extractThinking
 * shapes (ollama/gemini/qwen), format derivation from targetFormat, and the
 * applyFormat branches (disable paths, hunyuan, step, kiro, level clamps).
 * Provider-agnostic: model ids are derived from the exported capability tables,
 * never hardcoded against a provider's registry literals.
 */
import { describe, expect, it } from 'vitest';
import {
  applyThinking,
  extractThinking,
  parseSuffix,
  stripThinkingSuffix,
} from '../../open-sse/translator/concerns/thinkingUnified.js';
import { LEVEL_TO_BUDGET } from '../../open-sse/translator/concerns/thinking.js';
import {
  DEFAULT_CAPABILITIES,
  MODEL_CAPABILITIES,
  PATTERN_CAPABILITIES,
  getCapabilitiesForModel,
} from '../../open-sse/providers/capabilities.js';
import { getThinkingLevels } from '../../open-sse/providers/thinkingLevels.js';
import { PROVIDERS } from '../../open-sse/providers/index.js';
import { FORMATS } from '../../open-sse/translator/formats.js';

// Find a model id whose resolved capabilities satisfy `pred`, scanning the
// exact table first, then synthesizing candidates from glob patterns. Each
// candidate is re-verified through getCapabilitiesForModel so pattern
// precedence cannot hand back a different resolution than the scan assumed.
function modelWhere(pred, provider = null) {
  for (const model of Object.keys(MODEL_CAPABILITIES)) {
    if (pred(getCapabilitiesForModel(provider, model))) return model;
  }
  for (const entry of PATTERN_CAPABILITIES) {
    const candidate = entry.pattern.replaceAll('*', '');
    if (candidate && pred(getCapabilitiesForModel(provider, candidate))) return candidate;
  }
  return null;
}

const modelForFormat = (fmt, extra = () => true) =>
  modelWhere((caps) => caps.reasoning && caps.thinkingFormat === fmt && extra(caps));

// A model that reasons but declares no thinkingFormat: format derives from the
// target wire format (FORMAT_TO_NATIVE fallback path).
const derivedModel = modelWhere(
  (caps) => caps.reasoning && !caps.thinkingFormat && !caps.thinkingRange
);

describe('parseSuffix / stripThinkingSuffix fallthroughs', () => {
  it('unrecognized suffix value yields a null override', () => {
    const { cleanModel, override } = parseSuffix('some-model(not-a-level)');
    expect(cleanModel).toBe('some-model');
    expect(override).toBeNull();
  });

  it('stripThinkingSuffix is a no-op on non-strings and plain names', () => {
    expect(stripThinkingSuffix(null)).toBeNull();
    expect(stripThinkingSuffix('plain')).toBe('plain');
    expect(stripThinkingSuffix('m(high)')).toBe('m');
  });
});

describe('extractThinking shapes', () => {
  it('ollama think: unknown non-empty string becomes a level', () => {
    expect(extractThinking({ think: 'verylevel' })).toEqual({
      mode: 'level',
      level: 'verylevel',
    });
  });

  it('ollama think: truthy number is auto, zero is none', () => {
    expect(extractThinking({ think: 1 })).toEqual({ mode: 'auto' });
    expect(extractThinking({ think: 0 })).toEqual({ mode: 'none' });
  });

  it('gemini thinkingConfig.thinkingLevel lowercases into a level', () => {
    expect(extractThinking({ thinkingConfig: { thinkingLevel: 'HIGH' } })).toEqual({
      mode: 'level',
      level: 'high',
    });
  });

  it('qwen enable_thinking with and without a positive budget', () => {
    expect(extractThinking({ enable_thinking: true, thinking_budget: 2048 })).toEqual({
      mode: 'budget',
      budget: 2048,
    });
    expect(extractThinking({ enable_thinking: true })).toEqual({ mode: 'auto' });
    expect(extractThinking({ enable_thinking: true, thinking_budget: 'nan' })).toEqual({
      mode: 'auto',
    });
  });
});

describe('format derivation from targetFormat (no capability format)', () => {
  it('claude target derives claude-budget and auto maps to the fixed auto budget', () => {
    expect(derivedModel).toBeTruthy();
    const body = {};
    applyThinking(FORMATS.CLAUDE, derivedModel, body, null, { mode: 'auto' });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
  });

  it('claude target with a level uses the shared level-to-budget map', () => {
    const body = {};
    applyThinking(FORMATS.CLAUDE, derivedModel, body, null, {
      mode: 'level',
      level: 'medium',
    });
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: LEVEL_TO_BUDGET.medium,
    });
  });

  it('unknown target format falls back to the openai wire', () => {
    const body = {};
    applyThinking('no-such-format', derivedModel, body, null, {
      mode: 'level',
      level: 'high',
    });
    expect(body.reasoning_effort).toBe('high');
  });

  it('kiro target is a body no-op (thinking travels via system tag)', () => {
    const body = { messages: [] };
    applyThinking(FORMATS.KIRO, derivedModel, body, null, { mode: 'level', level: 'high' });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it('gemini target: large budget raises maxOutputTokens to the top floor capped by maxOutput', () => {
    const body = {};
    applyThinking(FORMATS.GEMINI, derivedModel, body, null, {
      mode: 'budget',
      budget: 30000,
    });
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 30000,
      includeThoughts: true,
    });
    const caps = getCapabilitiesForModel(null, derivedModel);
    const cap = Number.isFinite(caps.maxOutput) ? caps.maxOutput : DEFAULT_CAPABILITIES.maxOutput;
    expect(body.generationConfig.maxOutputTokens).toBe(Math.min(65535, cap));
  });

  it('gemini-cli envelope: a non-object request.generationConfig is replaced', () => {
    const body = { request: { generationConfig: 'corrupt' } };
    applyThinking(FORMATS.GEMINI_CLI, derivedModel, body, null, { mode: 'auto' });
    expect(body.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    });
  });
});

describe('disable paths per capability-declared format', () => {
  const disableCases = [
    ['claude-adaptive', (b) => expect(b.thinking).toEqual({ type: 'disabled' })],
    ['deepseek', (b) => expect(b.thinking).toEqual({ type: 'disabled' })],
    ['qwen', (b) => expect(b.enable_thinking).toBe(false)],
    ['kimi', (b) => expect(b.thinking).toEqual({ type: 'disabled' })],
  ];

  for (const [fmt, check] of disableCases) {
    it(`${fmt}: mode none disables on a model that can disable`, () => {
      const model = modelForFormat(fmt, (caps) => caps.thinkingCanDisable !== false);
      expect(model).toBeTruthy();
      const body = {};
      applyThinking('any', model, body, null, { mode: 'none' });
      check(body);
    });
  }
});

describe('hunyuan and step branches', () => {
  const hunyuanModel = modelForFormat('hunyuan', (caps) => caps.thinkingCanDisable !== false);
  const stepModel = modelForFormat('step', (caps) => caps.thinkingCanDisable !== false);

  it('hunyuan: none disables, auto enables without budget, level carries the mapped budget', () => {
    expect(hunyuanModel).toBeTruthy();
    const off = {};
    applyThinking('any', hunyuanModel, off, null, { mode: 'none' });
    expect(off.thinking).toEqual({ type: 'disabled' });

    const auto = {};
    applyThinking('any', hunyuanModel, auto, null, { mode: 'auto' });
    expect(auto.thinking).toEqual({ type: 'enabled' });

    const leveled = {};
    applyThinking('any', hunyuanModel, leveled, null, { mode: 'level', level: 'medium' });
    const range = getCapabilitiesForModel(null, hunyuanModel).thinkingRange;
    let expected = LEVEL_TO_BUDGET.medium;
    if (range?.min != null && expected < range.min) expected = range.min;
    if (range?.max != null && expected > range.max) expected = range.max;
    expect(leveled.thinking).toEqual({ type: 'enabled', budget_tokens: expected });
  });

  it('step: none omits the field, levels clamp xhigh/max down to high', () => {
    expect(stepModel).toBeTruthy();
    const off = {};
    applyThinking('any', stepModel, off, null, { mode: 'none' });
    expect(off.reasoning_effort).toBeUndefined();

    const low = {};
    applyThinking('any', stepModel, low, null, { mode: 'level', level: 'low' });
    expect(low.reasoning_effort).toBe('low');

    const xhigh = {};
    applyThinking('any', stepModel, xhigh, null, { mode: 'level', level: 'xhigh' });
    expect(xhigh.reasoning_effort).toBe('high');
  });

  it('step: an unusable intent mode sends no field at all', () => {
    const body = {};
    applyThinking('any', stepModel, body, null, { mode: 'unknown-mode' });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('level-set clamps', () => {
  it('openai format: level below every supported entry takes the lowest on offer', () => {
    // Enum order of the OpenAI reasoning_effort ladder as thinkingUnified
    // walks it (internal ordering, not a provider registry literal).
    const ladder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    // Direct scan: an openai-format model whose declared set excludes both
    // "none" and "minimal", so a "minimal" request cannot clamp downward.
    let picked = null;
    const candidates = [
      ...Object.keys(MODEL_CAPABILITIES),
      ...PATTERN_CAPABILITIES.map((entry) => entry.pattern.replaceAll('*', '')),
    ];
    for (const candidate of candidates) {
      const caps = getCapabilitiesForModel(null, candidate);
      if (!caps.reasoning || caps.thinkingFormat !== 'openai') continue;
      const levels = getThinkingLevels(null, candidate);
      if (
        Array.isArray(levels) &&
        levels.length > 0 &&
        !levels.includes('none') &&
        !levels.includes('minimal')
      ) {
        picked = { model: candidate, levels };
        break;
      }
    }
    expect(picked).toBeTruthy();
    const body = {};
    applyThinking('any', picked.model, body, null, { mode: 'level', level: 'minimal' });
    const lowestOffered = ladder.find((level) => picked.levels.includes(level));
    expect(body.reasoning_effort).toBe(lowestOffered);
  });

  it('kimi format: a level outside the kimi enum sends no effort field', () => {
    const model = modelForFormat('kimi', (caps) => caps.thinkingCanDisable !== false);
    expect(model).toBeTruthy();
    const body = {};
    applyThinking('any', `${model}(ultra)`, body, null);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('ollama provider format: unknown level defaults think to medium', () => {
    const ollamaProvider = Object.entries(PROVIDERS).find(
      ([, p]) => p.thinkingFormat === 'ollama'
    )?.[0];
    expect(ollamaProvider).toBeTruthy();
    const model = modelWhere((caps) => caps.reasoning, ollamaProvider);
    expect(model).toBeTruthy();
    const body = {};
    applyThinking('any', model, body, ollamaProvider, { mode: 'level', level: 'ultra' });
    expect(body.think).toBe('medium');
  });
});
