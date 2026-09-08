import { expect, it } from 'vitest';
import { normalizeEvaluationFixtures, evaluationSetHash } from '../../src/lib/shaping/evaluationSets.mjs';
import { evaluateSettings } from '../../src/lib/shaping/evaluate.mjs';

const fixture = () => ({ id: 'selected-case', contextWindow: 200000,
  body: { model: 'fixture', messages: [{ role: 'user', content: 'Retain exact user request.' }], max_tokens: 16 } });

it('validates an explicitly selected corpus and hashes exact inputs deterministically', () => {
  const input = [fixture()], normalized = normalizeEvaluationFixtures(input);
  expect(normalized).toEqual(input);
  expect(evaluationSetHash(normalized)).toBe(evaluationSetHash(structuredClone(input)));
  input[0].body.messages[0].content = 'different';
  expect(evaluationSetHash(normalized)).not.toBe(evaluationSetHash(input));
});

it('refuses empty, duplicate, oversized and unsupported-format evaluation inputs', () => {
  for (const input of [[], [fixture(), fixture()], [{ ...fixture(), contextWindow: 0 }],
    [{ ...fixture(), body: { input: 'responses format' } }],
    [{ ...fixture(), body: { ...fixture().body, messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] } }]]) {
    expect(() => normalizeEvaluationFixtures(input)).toThrow();
  }
});

it('evaluates valid simple messages without manufacturing thinking or task outcome evidence', async () => {
  const result = await evaluateSettings({ rtkEnabled: false }, 'selected', { fixtures: [fixture()] });
  expect(result.results).toHaveLength(1);
  expect(result.results[0].validity).toMatchObject({ currentPreserved: true, toolTransactionsValid: true, liveThinkingPreserved: true });
  expect(result.results[0].validity.liveThinkingCount).toBe(0);
  expect(result.coverage.taskQuality).toBeNull();
  expect(result.coverage.cost).toBeNull();
});
