import { describe, it, expect } from 'vitest';
import { validateDefinition, validateFixture, LIMITS } from '../../src/lib/compatibility/model.mjs';
import { executeLocalFixture } from '../../src/lib/compatibility/runner.mjs';
import { describeTranslationRoute } from '../../open-sse/translator/index.js';
import { SAMPLE_FIXTURES } from '../../src/shared/compatibility/samples.js';

describe('retained local input boundary', () => {
  it('requires explicit suitable provenance and rejects unsupported scopes', () => {
    expect(() => validateDefinition({ ...SAMPLE_FIXTURES[0].definition, suitable: false })).toThrow(/Confirm/);
    expect(() => validateDefinition({ ...SAMPLE_FIXTURES[0].definition, sourceFormat: 'kiro' })).toThrow(/supported/);
    expect(() => validateFixture({ ...SAMPLE_FIXTURES[0], credentials: {} })).toThrow(/Unknown/);
  });
  it.each(['authorization', 'refresh_token', 'apiKey', '__proto__'])('refuses nested sensitive key %s', key => {
    const value = structuredClone(SAMPLE_FIXTURES[0].definition);
    value.payload = JSON.parse(`{"nested":{"${key}":"fixture-value"}}`);
    expect(() => validateDefinition(value)).toThrow(/Credential/);
  });
  it('refuses credential-like text and complete byte overflow without truncation', () => {
    const value = structuredClone(SAMPLE_FIXTURES[0].definition);
    value.payload.messages[0].content = 'Bearer synthetic-sensitive-value';
    expect(() => validateDefinition(value)).toThrow(/credential/);
    value.payload.messages[0].content = 'é'.repeat(LIMITS.definitionBytes);
    expect(() => validateDefinition(value)).toThrow(/exceeds/);
  });
  it('bounds stream event count and nesting', () => {
    expect(() => validateDefinition({ ...SAMPLE_FIXTURES[1].definition, payload: Array(257).fill({ type: 'fixture' }) })).toThrow(/256/);
    const value = structuredClone(SAMPLE_FIXTURES[0].definition);
    let deep = {}; for (let i = 0; i < 26; i++) deep = { child: deep }; value.payload.deep = deep;
    expect(() => validateDefinition(value)).toThrow(/nesting/);
  });
});
describe('maintained translator evidence', () => {
  it('reports registered direct/pivot/passthrough and missing edges truthfully', () => {
    expect(describeTranslationRoute('openai', 'claude')).toMatchObject({ supported: true, mode: 'direct' });
    expect(describeTranslationRoute('claude', 'gemini')).toMatchObject({ supported: true, mode: 'pivot', edges: [{ from: 'claude', to: 'openai' }, { from: 'openai', to: 'gemini' }] });
    expect(describeTranslationRoute('openai', 'openai')).toMatchObject({ supported: true, mode: 'passthrough' });
    expect(describeTranslationRoute('ollama', 'claude')).toMatchObject({ supported: false, mode: 'unavailable', missing: [{ from: 'ollama', to: 'openai' }] });
    expect(describeTranslationRoute('absent', 'absent')).toMatchObject({ supported: false });
  });
  it('actually converts tool request, retains exact source, and distinguishes schema limits', () => {
    const input = structuredClone(SAMPLE_FIXTURES[0].definition), before = JSON.stringify(input);
    const result = executeLocalFixture(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.output.messages.some(message => message.content?.some?.(block => block.type === 'tool_result'))).toBe(true);
    expect(result.checks.every(check => check.outcome === 'passed')).toBe(true);
    expect(result.coverage).toMatchObject({ providerCalls: 0, credentialsRead: false, semanticEquivalence: 'not-established', providerSchema: 'not-validated' });
    expect(result.quantities.inputBytes).toBe(Buffer.byteLength(JSON.stringify(input.payload)));
  });
  it('actually converts ordered stream chunks with final flush and completion', () => {
    const result = executeLocalFixture(SAMPLE_FIXTURES[1].definition);
    expect(result.output.some(event => event.type === 'response.completed')).toBe(true);
    expect(result.output.find(event => event.type === 'response.output_text.delta')?.delta).toContain('synthetic');
    expect(result.quantities.inputEvents).toBe(3);
    expect(result.coverage.transport).toBe('not-exercised');
  });
  it('a malformed source envelope cannot become a passed check', () => {
    const fixture = { ...SAMPLE_FIXTURES[0].definition, sourceFormat: 'openai', targetFormat: 'openai', payload: { content: 'synthetic' } };
    expect(executeLocalFixture(fixture).checks.some(check => check.outcome === 'failed')).toBe(true);
  });
});
