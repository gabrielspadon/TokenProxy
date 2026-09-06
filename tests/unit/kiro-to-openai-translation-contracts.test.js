/**
 * Contract tests for open-sse/translator/response/kiro-to-openai.js:
 * SSE string parsing, per-event translation shape (content, reasoning,
 * tool use, stop, usage), state initialization and passthrough. Pure
 * translation — no network involved.
 */
import { describe, expect, it } from 'vitest';

const { kiroToOpenAIResponse } = await import('open-sse/translator/response/kiro-to-openai.js');
const { toOpenAIUsage } = await import('open-sse/translator/concerns/usage.js');

const CHUNK_SHAPE = {
  object: 'chat.completion.chunk',
  choices: [expect.objectContaining({ index: 0 })],
};

describe('passthrough and guards', () => {
  it('null/empty chunk returns null', () => {
    expect(kiroToOpenAIResponse(null, {})).toBeNull();
    expect(kiroToOpenAIResponse('', {})).toBeNull();
  });

  it('already-OpenAI chunks pass through untouched', () => {
    const chunk = { object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }] };
    expect(kiroToOpenAIResponse(chunk, {})).toBe(chunk);
  });

  it('unknown event type is skipped', () => {
    expect(kiroToOpenAIResponse({ somethingElse: true }, {})).toBeNull();
  });
});

describe('assistant content events', () => {
  it('object event: first chunk carries the role, later chunks do not', () => {
    const state = {};
    const first = kiroToOpenAIResponse({ assistantResponseEvent: { content: 'Hel' } }, state);
    expect(first).toMatchObject(CHUNK_SHAPE);
    expect(first.choices[0].delta).toEqual({ role: 'assistant', content: 'Hel' });
    expect(first.id).toBe(state.responseId);
    expect(first.created).toBe(state.created);

    const second = kiroToOpenAIResponse({ assistantResponseEvent: { content: 'lo' } }, state);
    expect(second.choices[0].delta).toEqual({ content: 'lo' });
    expect(second.id).toBe(first.id);
  });

  it('empty content yields null', () => {
    expect(kiroToOpenAIResponse({ assistantResponseEvent: { content: '' } }, {})).toBeNull();
  });

  it('SSE string form with event: and data: lines parses', () => {
    const state = {};
    const raw = 'event:assistantResponseEvent\ndata:{"content":"hi"}';
    const out = kiroToOpenAIResponse(raw, state);
    expect(out.choices[0].delta.content).toBe('hi');
  });

  it(':event-type: header form and raw JSON line form parse', () => {
    const state = {};
    const raw =
      ':event-type:assistantResponseEvent\n:content-type:application/json\n{"content":"hi"}';
    expect(kiroToOpenAIResponse(raw, state).choices[0].delta.content).toBe('hi');
  });

  it('non-JSON SSE data falls back to raw text and needs a typed event to emit', () => {
    // Text payload lands as { text } which assistantResponseEvent path ignores → null.
    expect(kiroToOpenAIResponse('event:assistantResponseEvent\ndata:plain words', {})).toBeNull();
    // With no data at all, null.
    expect(kiroToOpenAIResponse('event:assistantResponseEvent', {})).toBeNull();
  });

  it('state seeds a chatcmpl id and created seconds on first event', () => {
    const state = {};
    kiroToOpenAIResponse({ assistantResponseEvent: { content: 'x' } }, state);
    expect(state.responseId).toMatch(/^chatcmpl-/);
    expect(state.created).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(state.chunkIndex).toBe(1);
  });

  it('model in state flows into the chunk, defaulting otherwise', () => {
    const named = kiroToOpenAIResponse(
      { assistantResponseEvent: { content: 'x' } },
      { model: 'm-1' }
    );
    expect(named.model).toBe('m-1');
    const anon = kiroToOpenAIResponse({ assistantResponseEvent: { content: 'x' } }, {});
    expect(typeof anon.model).toBe('string');
  });
});

describe('reasoning events', () => {
  it('surfaces reasoning_content with a leading role on the first chunk', () => {
    const state = {};
    const out = kiroToOpenAIResponse({ reasoningContentEvent: { text: 'because' } }, state);
    expect(out.choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'because' });
    const next = kiroToOpenAIResponse({ reasoningContentEvent: { content: 'so' } }, state);
    expect(next.choices[0].delta).toEqual({ reasoning_content: 'so' });
  });

  it('string reasoning payload and empty payload', () => {
    const viaEventType = kiroToOpenAIResponse('event:reasoningContentEvent\ndata:{"text":"t"}', {});
    expect(viaEventType.choices[0].delta.reasoning_content).toBe('t');
    expect(kiroToOpenAIResponse({ reasoningContentEvent: { text: '' } }, {})).toBeNull();
  });
});

describe('tool use events', () => {
  it('emits an OpenAI tool_calls delta with stringified arguments', () => {
    const state = { toolNameMap: new Map([['shortName', 'original_tool_name']]) };
    const out = kiroToOpenAIResponse(
      {
        toolUseEvent: { toolUseId: 'tu-1', name: 'shortName', input: { a: 1 } },
      },
      state
    );
    const call = out.choices[0].delta.tool_calls[0];
    expect(call.id).toBe('tu-1');
    expect(call.function.name).toBe('original_tool_name');
    expect(JSON.parse(call.function.arguments)).toEqual({ a: 1 });
    expect(state.hadToolUse).toBe(true);
  });

  it('falls back to a generated call id and empty input', () => {
    const out = kiroToOpenAIResponse({ toolUseEvent: { name: 't' } }, {});
    const call = out.choices[0].delta.tool_calls[0];
    expect(call.id).toMatch(/^call_/);
    expect(call.function.arguments).toBe('{}');
  });
});

describe('usage and stop events', () => {
  it('usage event stashes OpenAI-shaped usage on state and emits nothing', () => {
    const state = {};
    const raw = { inputTokens: 10, outputTokens: 5 };
    expect(kiroToOpenAIResponse({ usageEvent: raw }, state)).toBeNull();
    expect(state.usage).toEqual(toOpenAIUsage(raw, 'kiro'));
    expect(state.usage.total_tokens).toBe(15);
  });

  it('stop after tool use finishes tool_calls; plain stop finishes stop', () => {
    const toolState = { hadToolUse: true };
    const toolStop = kiroToOpenAIResponse({ messageStopEvent: {} }, toolState);
    expect(toolStop.choices[0].finish_reason).toBe('tool_calls');
    expect(toolState.finishReason).toBe('tool_calls');

    const plain = kiroToOpenAIResponse('event:messageStopEvent\ndata:{}', {});
    expect(plain.choices[0].finish_reason).toBe('stop');
  });

  it('final chunk carries stashed usage', () => {
    const state = {};
    kiroToOpenAIResponse({ usageEvent: { inputTokens: 3, outputTokens: 4 } }, state);
    const stop = kiroToOpenAIResponse({ messageStopEvent: {} }, state);
    expect(stop.usage).toBe(state.usage);
    expect(stop.usage.prompt_tokens).toBe(3);
  });

  it('round-trip: content then stop share id/model and end well-formed', () => {
    const state = { model: 'kiro-model' };
    const chunks = [
      kiroToOpenAIResponse({ assistantResponseEvent: { content: 'hi' } }, state),
      kiroToOpenAIResponse({ messageStopEvent: {} }, state),
    ];
    for (const c of chunks) {
      expect(c).toMatchObject(CHUNK_SHAPE);
      expect(c.id).toBe(state.responseId);
      expect(c.model).toBe('kiro-model');
    }
    expect(chunks.at(-1).choices[0].delta).toEqual({});
  });
});
