import { expect, it } from 'vitest';
import { parseBulkOverrides, reviewBulkOverrides, bulkReadbackMatches } from '../../src/app/dashboard/model-context/bulkModel.js';
it('prepares scoped exact keys and preserves absent versus observed values', () => {
  const patch = parseBulkOverrides(' openai/fixture = 128000\nfixture-* = 64000 ', 'old-rule');
  const reviewed = reviewBulkOverrides(patch, { 'openai/fixture': 32000, 'old-rule': 16000, sibling: 12345 });
  expect(reviewed).toEqual({ set: [{ key: 'openai/fixture', contextWindow: 128000 }, { key: 'fixture-*', contextWindow: 64000 }], deleteKeys: ['old-rule'], expectedOverrides: { 'openai/fixture': 32000, 'fixture-*': null, 'old-rule': 16000 } });
  expect(bulkReadbackMatches(reviewed, { 'openai/fixture': 128000, 'fixture-*': 64000, sibling: 5000 })).toBe(true);
  expect(bulkReadbackMatches(reviewed, { 'openai/fixture': 128000, 'fixture-*': 64000, 'old-rule': 16000 })).toBe(false);
});
it('refuses partial parsing, ambiguous repeated keys, unsafe numbers and empty input', () => {
  for (const [set, remove] of [['', ''], ['a=0', ''], ['a=1.5', ''], ['a=9007199254740992', ''], ['a=1\na=2', ''], ['a=1', 'a'], ['bad', '']]) expect(() => parseBulkOverrides(set, remove)).toThrow();
  expect(() => parseBulkOverrides(Array.from({ length: 1001 }, (_, i) => `model-${i}=1`).join('\n'), '')).toThrow();
});
