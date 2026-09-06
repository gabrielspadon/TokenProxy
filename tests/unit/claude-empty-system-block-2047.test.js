// #2047 — MiniMax-M3 via an OpenAI-format client.
//
// providers/registry/minimax{,-cn}.js pins MiniMax-M3 to targetFormat "claude",
// so an OpenAI client is translated onto the Anthropic-compatible endpoint
// while M2.x stays on the OpenAI transport — which is why only M3 regressed.
// The body in the issue opens with { role: "system", content: "" }, and that
// reached the upstream as a { type: "text", text: "" } system block carrying
// the cache anchor. Message content is filtered by hasValidContent; system
// blocks were not.
import { describe, it, expect } from 'vitest';
import { translateRequest } from '../../open-sse/translator/index.js';
import { FORMATS } from '../../open-sse/translator/formats.js';

// The exact body from the issue's curl.
const reportedBody = () => ({
  stream: true,
  model: 'minimax-cn/MiniMax-M3',
  messages: [
    { role: 'system', content: '' },
    { role: 'user', content: 'ping' },
  ],
});

const toClaude = (body, provider = 'minimax-cn') =>
  translateRequest(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    'MiniMax-M3',
    body,
    true,
    { apiKey: 'k' },
    provider
  );

const systemBlocks = (out) => (Array.isArray(out.system) ? out.system : []);

describe('empty system block on the Claude request path (#2047)', () => {
  it('does not send a system block with empty text', () => {
    const out = toClaude(reportedBody());

    for (const block of systemBlocks(out)) {
      expect(block.type === 'text' ? block.text.trim() : 'x').not.toBe('');
    }
  });

  it('does not anchor the prompt cache on the empty block', () => {
    const out = toClaude(reportedBody());
    const anchored = systemBlocks(out).filter((b) => b.cache_control);

    expect(anchored).toHaveLength(0);
    expect(out.system).toBeUndefined();
  });

  it('keeps a system prompt that actually has text', () => {
    const out = toClaude({
      stream: true,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'ping' },
      ],
    });

    expect(systemBlocks(out).map((b) => b.text)).toContain('be terse');
  });

  it('leaves the rest of the reported request intact', () => {
    const out = toClaude(reportedBody());

    expect(out.stream).toBe(true);
    expect(out.model).toBe('MiniMax-M3');
    expect(JSON.stringify(out.messages)).toContain('ping');
  });

  it('drops system entirely when every block was empty', () => {
    // No provider prompt is injected for a plain anthropic-compatible target,
    // so the client's empty system block is the only one there is.
    const out = toClaude(
      {
        stream: true,
        messages: [
          { role: 'system', content: '   ' },
          { role: 'user', content: 'ping' },
        ],
      },
      'anthropic-compatible-x'
    );

    expect(systemBlocks(out).some((b) => b.type === 'text' && !b.text.trim())).toBe(false);
  });
});
