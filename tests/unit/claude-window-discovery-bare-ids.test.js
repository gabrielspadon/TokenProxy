// Anti-revert guard for 30e9e3dd: the /v1/models rewrite MUST list one bare
// official Anthropic id per official model in the catalog, each carrying the
// widest context_length any provider serves. Claude Code matches its session
// model id VERBATIM against this listing; a missing or narrowed bare row makes
// it fall back to the built-in 200k window and auto-compact at ~160k while the
// gateway serves 1M (measured: compactMetadata preTokens 168172 against
// context_served 1000000). claude-compat-layer.test.js pins the base case;
// this file pins the regression corners, including today's fleet outage
// (claude-fable-5-1 absent from the catalog → no bare row → fleet compacted).
import { describe, it, expect } from 'vitest';
import { rewriteModelsListForClaude } from '@/lib/claudeCompat.js';

const compat = { enabled: true, suffixMode: 'auto', keywords: [] };
const entry = (id, context_length, owned_by = 'cc') => ({
  id,
  object: 'model',
  owned_by,
  ...(context_length ? { context_length } : {}),
});

const bareRows = (out, name) => out.filter((m) => m?.id === name);

describe('bare official Anthropic ids in the /v1/models rewrite (#compaction)', () => {
  it('bare id survives prefixed and thinking/effort variants crowding the catalog', () => {
    const out = rewriteModelsListForClaude(
      [
        entry('cc/claude-sonnet-5', 1_000_000),
        entry('cc/claude-sonnet-5(high)', 1_000_000),
        entry('cc/claude-sonnet-5(thinking)', 1_000_000),
        entry('other/claude-sonnet-5', 200_000, 'other'),
      ],
      compat
    );
    const bare = bareRows(out, 'claude-sonnet-5');
    expect(bare).toHaveLength(1);
    expect(bare[0].context_length).toBe(1_000_000);
    // variant spellings are provider-side, never client model ids
    expect(out.some((m) => /\(/.test(m?.id ?? '') && !m.id.startsWith('claude-cc/'))).toBe(false);
    expect(bareRows(out, 'claude-sonnet-5(high)')).toHaveLength(0);
    // the bare row must not carry the [1m] marker — Claude Code matches verbatim
    expect(bare[0].id.endsWith('[1m]')).toBe(false);
    expect(bare[0].display_name).toBe('claude-sonnet-5');
  });

  it('widest window wins across duplicate entries, regardless of catalog order', () => {
    const forward = rewriteModelsListForClaude(
      [
        entry('a/claude-fable-5', 200_000, 'a'),
        entry('b/claude-fable-5', 1_000_000, 'b'),
        entry('c/claude-fable-5', 400_000, 'c'),
      ],
      compat
    );
    const backward = rewriteModelsListForClaude(
      [
        entry('b/claude-fable-5', 1_000_000, 'b'),
        entry('c/claude-fable-5', 400_000, 'c'),
        entry('a/claude-fable-5', 200_000, 'a'),
      ],
      compat
    );
    for (const out of [forward, backward]) {
      const bare = bareRows(out, 'claude-fable-5');
      expect(bare).toHaveLength(1);
      expect(bare[0].context_length).toBe(1_000_000);
    }
  });

  it('an entry with no context_length never outranks one with a real window', () => {
    const out = rewriteModelsListForClaude(
      [entry('a/claude-sonnet-5', 1_000_000, 'a'), entry('b/claude-sonnet-5', undefined, 'b')],
      compat
    );
    expect(bareRows(out, 'claude-sonnet-5')[0].context_length).toBe(1_000_000);
  });

  it('does not duplicate the bare row when the input already lists a bare id', () => {
    const out = rewriteModelsListForClaude(
      [entry('claude-sonnet-5', 1_000_000), entry('cc/claude-sonnet-5', 1_000_000)],
      compat
    );
    // The input bare id gets the claude- prefix treatment like every entry;
    // exactly one bare claude-sonnet-5 row may remain in the output.
    expect(bareRows(out, 'claude-sonnet-5')).toHaveLength(1);
  });

  it('a catalog carrying claude-fable-5-1 yields a bare claude-fable-5-1 row (fleet outage pin)', () => {
    const out = rewriteModelsListForClaude(
      [
        entry('cc/claude-fable-5-1', 1_000_000),
        entry('cc/claude-fable-5-1(max)', 1_000_000),
        entry('cc/claude-fable-5', 1_000_000),
      ],
      compat
    );
    const bare = bareRows(out, 'claude-fable-5-1');
    expect(bare).toHaveLength(1);
    expect(bare[0].context_length).toBe(1_000_000);
    expect(bare[0].display_name).toBe('claude-fable-5-1');
    // the sibling official id gets its own bare row, not merged
    expect(bareRows(out, 'claude-fable-5')).toHaveLength(1);
  });

  it('non-official ids never gain a bare row', () => {
    const out = rewriteModelsListForClaude(
      [
        entry('bai/deepseek-v4-flash', 1_000_000, 'bai'),
        entry('glm/glm-4.7', 200_000, 'glm'),
        entry('cc/CLAUDE-SONNET-5', 1_000_000), // case must not match
        entry('my-combo', 1_000_000, 'combo'),
      ],
      compat
    );
    expect(bareRows(out, 'deepseek-v4-flash')).toHaveLength(0);
    expect(bareRows(out, 'glm-4.7')).toHaveLength(0);
    expect(bareRows(out, 'CLAUDE-SONNET-5')).toHaveLength(0);
    expect(bareRows(out, 'my-combo')).toHaveLength(0);
  });

  it('every prefixed row still ships alongside the bare rows', () => {
    const out = rewriteModelsListForClaude(
      [entry('cc/claude-sonnet-5', 1_000_000), entry('bai/deepseek-v4-flash', undefined, 'bai')],
      compat
    );
    expect(out.some((m) => m.id === 'claude-cc/claude-sonnet-5[1m]')).toBe(true);
    expect(out.some((m) => m.id === 'claude-bai/deepseek-v4-flash')).toBe(true);
    expect(bareRows(out, 'claude-sonnet-5')).toHaveLength(1);
  });
});
