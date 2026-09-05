// Anti-revert guard for cbc1dc5c: Anthropic `input_tokens` is cache-EXCLUSIVE.
// Both Claude-SSE emitters (kiro-to-claude direct route, openai-to-claude
// pivot) must subtract BOTH cache subsets (cache_read + cache_creation) from
// the OpenAI-inclusive prompt_tokens, or a client summing the three fields
// double-counts the cached prefix and every economics dashboard reads wrong.
//
// kiro-usage-and-tool-integrity.test.js §D pins the kiro spellings; this file
// pins the openai-to-claude side (previously uncovered) and the PARITY between
// the two translators, so a revert in either one fails loudly here.
import { describe, it, expect } from 'vitest';
import { openaiToClaudeResponse } from '../../open-sse/translator/response/openai-to-claude.js';
import { kiroToClaudeResponse } from '../../open-sse/translator/response/kiro-to-claude.js';
import { initState } from '../../open-sse/translator/index.js';
import { FORMATS } from '../../open-sse/translator/formats.js';

// Drive one translator through a minimal stream carrying `usage`, return the
// usage object of the terminal message_delta — what the Claude client prices.
function finalUsage(translate, usage) {
  const state = initState(FORMATS.CLAUDE);
  const events = [];
  const push = (out) => out && events.push(...out);
  push(
    translate(
      {
        id: 'chatcmpl-abcdefgh',
        model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
      },
      state
    )
  );
  push(
    translate(
      {
        id: 'chatcmpl-abcdefgh',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      },
      state
    )
  );
  push(translate(null, state)); // flush
  const delta = events.find((e) => e.type === 'message_delta');
  expect(delta, 'stream never emitted a terminal message_delta').toBeDefined();
  return delta.usage;
}

const FLAT = {
  prompt_tokens: 103_000,
  completion_tokens: 640,
  cache_read_input_tokens: 98_000,
  cache_creation_input_tokens: 1_912,
};

const NESTED = {
  prompt_tokens: 500,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 480, cache_creation_tokens: 20 },
};

describe('openai-to-claude: input_tokens is cache-exclusive', () => {
  it('subtracts both cache subsets from the inclusive prompt_tokens (flat Anthropic spelling)', () => {
    const u = finalUsage(openaiToClaudeResponse, FLAT);
    expect(u.input_tokens).toBe(103_000 - 98_000 - 1_912);
    expect(u.cache_read_input_tokens).toBe(98_000);
    expect(u.cache_creation_input_tokens).toBe(1_912);
    expect(u.output_tokens).toBe(640);
  });

  it('subtracts the nested prompt_tokens_details spelling too', () => {
    const u = finalUsage(openaiToClaudeResponse, NESTED);
    expect(u.input_tokens).toBe(0);
    expect(u.cache_read_input_tokens).toBe(480);
    expect(u.cache_creation_input_tokens).toBe(20);
  });

  it("reads a gateway's top-level cached_tokens when no details block exists", () => {
    const u = finalUsage(openaiToClaudeResponse, {
      prompt_tokens: 1_000,
      completion_tokens: 5,
      cached_tokens: 900,
    });
    expect(u.input_tokens).toBe(100);
    expect(u.cache_read_input_tokens).toBe(900);
  });

  it('no cache reported: input_tokens stays the full prompt', () => {
    const u = finalUsage(openaiToClaudeResponse, { prompt_tokens: 42, completion_tokens: 3 });
    expect(u.input_tokens).toBe(42);
    expect(u).not.toHaveProperty('cache_read_input_tokens');
    expect(u).not.toHaveProperty('cache_creation_input_tokens');
  });
});

describe('conservation: input + cache_read + cache_creation === prompt_tokens', () => {
  // The property a client relies on when summing the three fields — the exact
  // double-count cbc1dc5c removed. Pinned per translator so a revert in either
  // subtraction breaks it.
  for (const [name, translate] of [
    ['openai-to-claude', openaiToClaudeResponse],
    ['kiro-to-claude', kiroToClaudeResponse],
  ]) {
    it(`${name}: flat spelling conserves prompt_tokens`, () => {
      const u = finalUsage(translate, FLAT);
      expect(
        u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      ).toBe(FLAT.prompt_tokens);
    });

    it(`${name}: nested spelling conserves prompt_tokens`, () => {
      const u = finalUsage(translate, NESTED);
      expect(
        u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      ).toBe(NESTED.prompt_tokens);
    });
  }
});

describe('translator parity on identical usage payloads', () => {
  // The two emitters serve the same clients on different routes; their
  // accounting must never drift apart again (kiro shipped inclusive
  // input_tokens while openai subtracted — the bug cbc1dc5c fixed).
  it.each([
    ['flat Anthropic spelling', FLAT],
    ['nested details spelling', NESTED],
    ['cache-free stream', { prompt_tokens: 42, completion_tokens: 3 }],
  ])('identical final usage: %s', (_label, usage) => {
    const a = finalUsage(openaiToClaudeResponse, usage);
    const b = finalUsage(kiroToClaudeResponse, usage);
    expect(b).toEqual(a);
  });
});
