// Field-level fidelity of the Antigravity → OpenAI request translator.
// Every mapping here is money- or context-relevant: maxOutputTokens naming,
// tool-call preservation, reasoning content, and the thinkingBudget → effort
// tiers. A silent drop in any of these either loses tool_calls (broken agent
// loop, retries, extra cost) or mis-sizes the context window.
import { describe, it, expect, vi } from 'vitest';

const thoughtSig = vi.hoisted(() => ({ remember: vi.fn() }));
vi.mock('../../open-sse/translator/concerns/thoughtSignature.js', () => ({
  rememberThoughtSignature: thoughtSig.remember,
}));

import { antigravityToOpenAIRequest } from '../../open-sse/translator/request/antigravity-to-openai.js';
import { DEFAULT_MIN_TOKENS } from '../../open-sse/config/runtimeConfig.js';

const wrap = (request) => ({ project: 'p', model: 'm', userAgent: 'antigravity', request });

describe('generationConfig → OpenAI sampling and token fields', () => {
  it('maps maxOutputTokens to max_tokens verbatim when no tools are present', () => {
    const out = antigravityToOpenAIRequest(
      'gpt-x',
      wrap({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.3, topP: 0.9, topK: 40 },
      }),
      true
    );
    expect(out.max_tokens).toBe(4096);
    expect(out.temperature).toBe(0.3);
    expect(out.top_p).toBe(0.9);
    expect(out.top_k).toBe(40);
    expect(out.stream).toBe(true);
    expect(out.model).toBe('gpt-x');
  });

  it('temperature 0 survives (falsy value must not be dropped)', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { temperature: 0, topP: 0, maxOutputTokens: 100 },
      }),
      false
    );
    expect(out.temperature).toBe(0);
    expect(out.top_p).toBe(0);
  });

  it('bumps max_tokens to DEFAULT_MIN_TOKENS when tools are in play (truncated tool args cost a retry)', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1000 },
        tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'OBJECT' } }] }],
      }),
      false
    );
    expect(out.max_tokens).toBe(DEFAULT_MIN_TOKENS);
  });

  it('maps thinkingBudget tiers to reasoning_effort and omits it at budget 0', () => {
    const build = (thinkingBudget) =>
      antigravityToOpenAIRequest(
        'm',
        wrap({
          contents: [{ role: 'user', parts: [{ text: 'q' }] }],
          generationConfig: { thinkingConfig: { thinkingBudget } },
        }),
        false
      );
    expect(build(1024).reasoning_effort).toBe('low');
    expect(build(8192).reasoning_effort).toBe('medium');
    expect(build(30000).reasoning_effort).toBe('high');
    expect(build(0)).not.toHaveProperty('reasoning_effort');
  });
});

describe('system instruction and contents', () => {
  it('string and parts-shaped systemInstruction both land as a system message first', () => {
    const a = antigravityToOpenAIRequest(
      'm',
      wrap({
        systemInstruction: 'be terse',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      }),
      false
    );
    expect(a.messages[0]).toEqual({ role: 'system', content: 'be terse' });

    const b = antigravityToOpenAIRequest(
      'm',
      wrap({
        systemInstruction: { parts: [{ text: 'be ' }, { text: 'terse' }] },
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      }),
      false
    );
    expect(b.messages[0]).toEqual({ role: 'system', content: 'be terse' });
  });

  it('accepts an unwrapped body (no request envelope)', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      {
        contents: [{ role: 'user', parts: [{ text: 'bare' }] }],
      },
      false
    );
    expect(out.messages).toEqual([{ role: 'user', content: 'bare' }]);
  });

  it('maps model role to assistant and keeps user as user', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [
          { role: 'user', parts: [{ text: 'q' }] },
          { role: 'model', parts: [{ text: 'a' }] },
        ],
      }),
      false
    );
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('thought parts become reasoning_content, never silently dropped', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [
          { role: 'model', parts: [{ thought: true, text: 'let me think' }, { text: 'answer' }] },
        ],
      }),
      false
    );
    const msg = out.messages[0];
    expect(msg.reasoning_content).toBe('let me think');
    expect(msg.content).toBe('answer');
  });

  it('inlineData becomes an image_url data URI part', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [
          {
            role: 'user',
            parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
          },
        ],
      }),
      false
    );
    const content = out.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const img = content.find((p) => p.type === 'image_url');
    expect(img.image_url.url).toBe('data:image/png;base64,AAAA');
  });
});

describe('tool calls and tool results', () => {
  it('functionCall becomes an assistant tool_call with args serialized, id preserved', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'call_9', name: 'get_weather', args: { city: 'NYC' } } }],
          },
        ],
      }),
      false
    );
    expect(out.messages[0].tool_calls).toEqual([
      {
        id: 'call_9',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ]);
  });

  it('derives a deterministic id from the name when upstream sent none, so the functionResponse pairs', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'f', response: { result: 'ok' } } }],
          },
        ],
      }),
      false
    );
    expect(out.messages[0].tool_calls[0].id).toBe('call_f');
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 'call_f', content: '"ok"' });
  });

  it('remembers the thoughtSignature keyed on the upstream id (#3646)', () => {
    thoughtSig.remember.mockClear();
    antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'abc', name: 'f', args: {} }, thoughtSignature: 'sig1' }],
          },
        ],
      }),
      false
    );
    expect(thoughtSig.remember).toHaveBeenCalledWith('abc', 'sig1');
  });

  it('a content mixing functionResponses with text and calls yields tool messages plus one assistant message', () => {
    const converted = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [
          {
            role: 'model',
            parts: [
              { functionResponse: { id: 'c1', name: 'f', response: { result: 42 } } },
              { text: 'and then' },
              { functionCall: { id: 'c2', name: 'g', args: { x: 1 } } },
            ],
          },
        ],
      }),
      false
    );
    const [toolMsg, assistantMsg] = converted.messages;
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'c1', content: '42' });
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].id).toBe('c2');
  });

  it('a content with no parts is skipped without throwing', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [{ role: 'user' }, { role: 'user', parts: [{ text: 'ok' }] }],
      }),
      false
    );
    expect(out.messages).toHaveLength(1);
  });
});

describe('tool declarations → OpenAI tools', () => {
  it('lowercases Gemini schema types recursively and strips enumDescriptions', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'f',
                description: 'd',
                parameters: {
                  type: 'OBJECT',
                  enumDescriptions: ['x'],
                  properties: {
                    a: { type: 'STRING', enumDescriptions: ['y'] },
                    b: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  },
                },
              },
            ],
          },
        ],
      }),
      false
    );
    const params = out.tools[0].function.parameters;
    expect(params.type).toBe('object');
    expect(params).not.toHaveProperty('enumDescriptions');
    expect(params.properties.a.type).toBe('string');
    expect(params.properties.a).not.toHaveProperty('enumDescriptions');
    expect(params.properties.b.items.type).toBe('integer');
  });

  it('a declaration without parameters gets the empty-object schema, not undefined', () => {
    const out = antigravityToOpenAIRequest(
      'm',
      wrap({
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools: [{ functionDeclarations: [{ name: 'f' }] }],
      }),
      false
    );
    expect(out.tools[0].function.parameters).toEqual({ type: 'object', properties: {} });
    expect(out.tools[0].function.description).toBe('');
  });
});
