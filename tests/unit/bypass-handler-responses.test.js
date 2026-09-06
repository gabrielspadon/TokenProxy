// Response-construction coverage for handleBypassRequest: streaming vs
// non-streaming, OpenAI vs Claude source formats, skip patterns, and the
// ccFilterNaming title path. Pure in-process; no network.
import { describe, expect, it } from 'vitest';
import { handleBypassRequest } from 'open-sse/utils/bypassHandler.js';
import { SKIP_PATTERNS } from 'open-sse/config/runtimeConfig.js';
import { FORMATS } from 'open-sse/translator/formats.js';

const MODEL = 'test-model';

function warmupBody(extra = {}) {
  return { messages: [{ role: 'user', content: 'Warmup' }], ...extra };
}

async function sseEvents(response) {
  const text = await response.text();
  expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  return text;
}

describe('bypass detection patterns', () => {
  it('returns null when messages are absent or empty', () => {
    expect(handleBypassRequest({}, MODEL)).toBeNull();
    expect(handleBypassRequest({ messages: [] }, MODEL)).toBeNull();
  });

  it("bypasses a title-extraction probe (trailing assistant '{')", async () => {
    const body = {
      messages: [
        { role: 'user', content: 'real question' },
        { role: 'assistant', content: [{ type: 'text', text: '{' }] },
      ],
      stream: false,
    };
    const result = handleBypassRequest(body, MODEL);
    expect(result?.success).toBe(true);
    const json = await result.response.json();
    expect(json.model).toBe(MODEL);
  });

  it('bypasses on every configured SKIP_PATTERN', () => {
    // Derived from the module's own config, not a hardcoded phrase.
    for (const pattern of SKIP_PATTERNS) {
      const body = {
        messages: [{ role: 'user', content: `prefix ${pattern} suffix` }],
        stream: false,
      };
      expect(handleBypassRequest(body, MODEL)?.success).toBe(true);
    }
  });

  it('ignores non-text and non-array content shapes when extracting text', () => {
    const body = {
      messages: [{ role: 'user', content: { weird: true } }],
    };
    expect(handleBypassRequest(body, MODEL)).toBeNull();
  });
});

describe('streaming response construction', () => {
  it('emits SSE chunks ending with [DONE] for an OpenAI-shaped request', async () => {
    const result = handleBypassRequest(warmupBody({ n: 1 }), MODEL); // n → detects openai
    expect(result.success).toBe(true);
    const text = await sseEvents(result.response);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    // First data chunk carries the model and assistant role.
    const first = JSON.parse(text.split('\n\n')[0].replace(/^data: /, ''));
    expect(first.model).toBe(MODEL);
    expect(first.object).toBe('chat.completion.chunk');
  });

  it('translates chunks to the Claude event stream when the body is Claude-shaped', async () => {
    const body = {
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Warmup' }] }],
    };
    const result = handleBypassRequest(body, MODEL);
    const text = await sseEvents(result.response);
    expect(text).toContain('message_start');
    expect(text).toContain('message_stop');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('non-streaming response construction', () => {
  it('returns a direct OpenAI JSON body when source format is OpenAI', async () => {
    const result = handleBypassRequest(warmupBody({ stream: false, n: 1 }), MODEL);
    const json = await result.response.json();
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].finish_reason).toBe('stop');
    expect(json.usage.total_tokens).toBe(json.usage.prompt_tokens + json.usage.completion_tokens);
    expect(result.response.headers.get('Content-Type')).toBe('application/json');
  });

  it('merges translated chunks into a complete Claude message with usage', async () => {
    const body = {
      system: 'sys',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Warmup' }] }],
    };
    const result = handleBypassRequest(body, MODEL);
    const json = await result.response.json();
    // Claude non-streaming merge path: reconstructed from message_start,
    // with usage merged from start + delta.
    expect(json.role).toBe('assistant');
    expect(json.model).toBe(MODEL);
    expect(json.usage).toBeTruthy();
    expect(typeof json.usage.output_tokens).toBe('number');
  });
});

describe('ccFilterNaming title path', () => {
  const naming = (system, userText, stream) => ({
    system,
    stream,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  it('does nothing without the ccFilterNaming flag', () => {
    expect(
      handleBypassRequest(naming('contains isNewTopic marker', 'hello world', false), MODEL, false)
    ).toBeNull();
  });

  it('builds a 3-word title from the user message (non-streaming, OpenAI shape)', async () => {
    const body = {
      stream: false,
      n: 1, // OpenAI-specific marker → detectFormat returns openai
      system: 'please respond with isNewTopic json',
      messages: [{ role: 'user', content: 'alpha beta gamma delta' }],
    };
    const result = handleBypassRequest(body, MODEL, true);
    const json = await result.response.json();
    const parsed = JSON.parse(json.choices[0].message.content);
    expect(parsed).toEqual({ isNewTopic: true, title: 'alpha beta gamma' });
  });

  it('builds a Claude-format naming response without throwing (non-streaming)', async () => {
    const result = handleBypassRequest(
      naming('please respond with isNewTopic json', 'alpha beta gamma delta', false),
      MODEL,
      true
    );
    expect(result?.success).toBe(true);
    const json = await result.response.json();
    expect(json.model).toBe(MODEL);
  });

  it('streams the naming payload when stream is not disabled', async () => {
    const result = handleBypassRequest(naming('isNewTopic', 'one two', undefined), MODEL, true);
    const text = await sseEvents(result.response);
    expect(text).toContain('isNewTopic');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('reads the system prompt from an in-messages system role too', async () => {
    const body = {
      stream: false,
      messages: [
        { role: 'system', content: 'the isNewTopic contract' },
        { role: 'user', content: 'just checking in' },
      ],
      n: 1,
    };
    const result = handleBypassRequest(body, MODEL, true);
    const json = await result.response.json();
    expect(JSON.parse(json.choices[0].message.content).title).toBe('just checking in');
  });

  it('reads an array-of-blocks body.system (Claude shape)', async () => {
    const body = {
      stream: false,
      system: [{ type: 'text', text: 'isNewTopic' }, null],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'topic title here' }] }],
    };
    const result = handleBypassRequest(body, MODEL, true);
    expect(result?.success).toBe(true);
  });
});
