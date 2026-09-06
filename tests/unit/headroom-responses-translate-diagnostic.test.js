// Regression: the openai-responses branch of compressWithHeadroom returned null
// without recording a reason when the Responses -> OpenAI translation produced
// no messages[], so the diagnostics panel stayed blank and a Codex translation
// failure looked identical to a successful compression.
import { describe, expect, it, vi, afterEach } from 'vitest';

import { compressWithHeadroom as compressWithPolicy } from '../../open-sse/rtk/headroom.js';
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });

describe('compressWithHeadroom openai-responses translation failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records why it bailed instead of returning a bare null', async () => {
    // openaiResponsesToOpenAIRequest() returns the body untouched when there is
    // no input to translate, so oai.messages is undefined.
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const diagnostics = {};
    const data = await compressWithHeadroom(
      { instructions: 'system prompt'.repeat(20) },
      {
        enabled: true,
        url: 'http://headroom.test',
        model: 'gpt-5',
        format: 'openai-responses',
        diagnostics,
      }
    );

    expect(data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(diagnostics.reason).toMatch(/did not translate to messages/);
  });
});
