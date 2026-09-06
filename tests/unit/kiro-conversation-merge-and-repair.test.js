/**
 * kiroConversation.js gap coverage: same-role turn merging, tool-name
 * collision suffixing, circular-content serialization, stripping stale tools
 * from history context, and the flatten-everything retry taken when the
 * reconciled conversation still fails validation.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalizeKiroConversation,
  normalizeKiroToolSpecs,
  validateKiroConversation,
} from '../../open-sse/translator/concerns/kiroConversation.js';
import { KIRO_TOOL_NAME_MAX_LENGTH } from '../../open-sse/config/kiroConstants.js';

const modelId = 'model-under-test';

const user = (content, extra = {}) => ({
  userInputMessage: { content, modelId, ...extra },
});
const assistant = (content, extra = {}) => ({
  assistantResponseMessage: { content, ...extra },
});

describe('normalizeKiroToolSpecs collisions and limits', () => {
  it('two names sanitizing to the same identifier get a numeric suffix', () => {
    const { specs, nameMap } = normalizeKiroToolSpecs([
      { name: 'read file', description: 'a', input_schema: {} },
      { name: 'read.file', description: 'b', input_schema: {} },
    ]);
    const names = specs.map((s) => s.toolSpecification.name);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe('read_file');
    expect(names[1]).toMatch(/^read_file_\d+$/);
    expect(nameMap.get('read file')).toBe(names[0]);
    expect(nameMap.get('read.file')).toBe(names[1]);
  });

  it('collision on a name at the length cap re-trims so the suffix still fits', () => {
    const long = 'x'.repeat(KIRO_TOOL_NAME_MAX_LENGTH + 10);
    const { specs } = normalizeKiroToolSpecs([
      { name: long, description: 'a', input_schema: {} },
      { name: `${long}y`, description: 'b', input_schema: {} },
    ]);
    const names = specs.map((s) => s.toolSpecification.name);
    expect(names[0]).toHaveLength(KIRO_TOOL_NAME_MAX_LENGTH);
    expect(names[1]).toHaveLength(KIRO_TOOL_NAME_MAX_LENGTH);
    expect(names[1].endsWith('_2')).toBe(true);
  });
});

describe('same-role turn merging', () => {
  it('consecutive user turns merge content, images and tool results', () => {
    const out = canonicalizeKiroConversation({
      history: [
        user('first'),
        user('second', {
          images: [{ format: 'png', source: { bytes: 'AA==' } }],
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'r1', status: 'success', content: [{ text: 'res' }] }],
          },
        }),
        assistant('reply'),
      ],
      currentMessage: user('go'),
      modelId,
    });
    expect(out.history[0].userInputMessage.content).toContain('first');
    expect(out.history[0].userInputMessage.content).toContain('second');
    expect(out.history[0].userInputMessage.images).toHaveLength(1);
    // First-turn tool results have no producing call: flattened into text.
    expect(out.history[0].userInputMessage.content).toContain('[Tool result: res]');
    expect(out.repairs.orphanResults).toBeGreaterThanOrEqual(1);
    expect(out.valid).toBe(true);
  });

  it('consecutive assistant turns merge content and toolUses', () => {
    const { specs, nameMap } = normalizeKiroToolSpecs([
      { name: 'probe', description: 'd', input_schema: {} },
    ]);
    const out = canonicalizeKiroConversation({
      history: [
        user('hi'),
        assistant('part one'),
        assistant('part two', {
          toolUses: [{ toolUseId: 'c1', name: 'probe', input: {} }],
        }),
        user('', {
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'c1', status: 'success', content: [{ text: 'ok' }] }],
          },
        }),
      ],
      currentMessage: user('next'),
      modelId,
      toolSpecs: specs,
      nameMap,
    });
    const merged = out.history[1].assistantResponseMessage;
    expect(merged.content).toContain('part one');
    expect(merged.content).toContain('part two');
    expect(merged.toolUses).toHaveLength(1);
    expect(out.valid).toBe(true);
  });

  it('stale tools on a history user turn are removed', () => {
    const out = canonicalizeKiroConversation({
      history: [
        user('hi', {
          userInputMessageContext: { tools: [{ toolSpecification: { name: 'old' } }] },
        }),
        assistant('ok'),
      ],
      currentMessage: user('go'),
      modelId,
    });
    expect(out.history[0].userInputMessage.userInputMessageContext?.tools).toBeUndefined();
    expect(out.valid).toBe(true);
  });
});

describe('flatten-everything retry on post-reconcile validation failure', () => {
  it('a spec set that drifts between reconcile and validate flattens all structured tools', () => {
    const { specs } = normalizeKiroToolSpecs([
      { name: 'real', description: 'd', input_schema: {} },
    ]);
    // Simulate spec-set drift: the first read (reconcile) sees the real spec,
    // every later read (validation) sees none, so the reconciled conversation
    // fails validation and the flatten-everything retry has to run.
    let reads = 0;
    const drifting = {
      length: specs.length,
      map: (fn) => (++reads === 1 ? specs.map(fn) : []),
    };
    const out = canonicalizeKiroConversation({
      history: [
        user('hi'),
        assistant('working', {
          toolUses: [{ toolUseId: 'c1', name: 'real', input: { a: 1 } }],
        }),
        user('follow', {
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'c1', status: 'success', content: [{ text: 'done' }] }],
          },
        }),
        assistant('summary'),
      ],
      currentMessage: user('go'),
      modelId,
      toolSpecs: drifting,
      nameMap: new Map([['real', 'real']]),
    });
    // Retry demoted structure to text on both sides of the pair.
    expect(out.history[1].assistantResponseMessage.toolUses).toBeUndefined();
    expect(out.history[1].assistantResponseMessage.content).toContain('[Tool call: real(');
    expect(out.history[2].userInputMessage.content).toContain('[Tool result: done]');
    expect(out.repairs.invalidToolUses).toBeGreaterThanOrEqual(1);
    expect(out.repairs.orphanResults).toBeGreaterThanOrEqual(1);
    expect(out.valid).toBe(true);
  });
});

describe('validateKiroConversation direct checks', () => {
  it('flags a call without a matching result and a missing current content', () => {
    const { specs } = normalizeKiroToolSpecs([
      { name: 'real', description: 'd', input_schema: {} },
    ]);
    const verdict = validateKiroConversation(
      [user('hi'), assistant('run', { toolUses: [{ toolUseId: 'c1', name: 'real', input: {} }] })],
      { userInputMessage: { content: '' } },
      specs
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.errors).toContain('pair:1');
    expect(verdict.errors).toContain('current');
  });
});
