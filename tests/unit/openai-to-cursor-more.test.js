// Kills remaining openai-to-cursor.js survivors: normalizeToolCallId dedup
// guard when the raw id has no trailing newline, TOOL role's toolMeta
// fallback chain, ASSISTANT tool_calls' index-stripping map, ASSISTANT
// content-array tool_use id-filter, content-array text-join with a falsy
// part skipped, plain-string message empty-content guard, and the top-level
// rest-spread stripping every named OpenAI/Anthropic-only field.
import { describe, it, expect } from 'vitest';
import { openaiToCursorRequest } from 'open-sse/translator/request/openai-to-cursor.js';

function run(messages, extra = {}) {
  return openaiToCursorRequest('m', { messages, ...extra }, false, {});
}

describe('normalizeToolCallId: no dedup entry when the id has no newline suffix', () => {
  it('a tool_call_id with no newline registers only under its raw id, not twice', () => {
    const out = run([
      {
        role: 'assistant',
        tool_calls: [{ id: 'call-1', function: { name: 'search' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'result-text' },
    ]);
    expect(out.messages[1].content).toContain('<tool_name>search</tool_name>');
  });
});

describe('TOOL role toolName fallback chain', () => {
  it('msg.name wins over the recorded tool meta name', () => {
    const out = run([
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'recorded' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'explicit', content: 'x' },
    ]);
    expect(out.messages[1].content).toContain('<tool_name>explicit</tool_name>');
  });

  it('an unrecognized tool_call_id with no msg.name falls all the way to "tool"', () => {
    const out = run([{ role: 'tool', tool_call_id: 'unknown', content: 'x' }]);
    expect(out.messages[0].content).toContain('<tool_name>tool</tool_name>');
  });
});

describe('ASSISTANT tool_calls: index stripped, every other field kept', () => {
  it('a tool_calls entry with an index field emits without it but keeps id/type/function', () => {
    const out = run([
      {
        role: 'assistant',
        content: 'thinking',
        tool_calls: [
          { index: 3, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
        ],
      },
    ]);
    expect(out.messages[0].tool_calls[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'f', arguments: '{}' },
    });
  });
});

describe('ASSISTANT content-array to tool_calls conversion', () => {
  it('a tool_use block with an empty id is dropped by the tc.id truthy filter', () => {
    const out = run([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '', name: 'f', input: { a: 1 } }],
      },
    ]);
    expect(out.messages).toEqual([]);
  });

  it('a text block plus a tool_use block: joined text goes to content, tool_use becomes tool_calls', () => {
    const out = run([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reasoning' },
          { type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } },
        ],
      },
    ]);
    expect(out.messages[0].content).toBe('reasoning');
    expect(out.messages[0].tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
    ]);
  });

  it('a content array with no tool_use blocks and no text falls through without pushing a message', () => {
    const out = run([{ role: 'assistant', content: [{ type: 'image', source: {} }] }]);
    expect(out.messages).toEqual([]);
  });
});

describe('plain-string message empty-content guard', () => {
  it('a user message with an empty string content is dropped, not pushed as empty', () => {
    const out = run([{ role: 'user', content: '' }]);
    expect(out.messages).toEqual([]);
  });

  it('a user message with non-empty string content is pushed with role and content intact', () => {
    const out = run([{ role: 'user', content: 'hello' }]);
    expect(out.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

describe('top-level rest-spread strips exactly the named OpenAI/Anthropic-only fields', () => {
  it('user, metadata, tool_choice, stream_options, system are removed; everything else survives', () => {
    const out = openaiToCursorRequest(
      'm',
      {
        messages: [{ role: 'user', content: 'hi' }],
        user: 'u1',
        metadata: { a: 1 },
        tool_choice: 'auto',
        stream_options: { include_usage: true },
        system: 'sys',
        temperature: 0.5,
        top_p: 0.9,
      },
      false,
      {}
    );
    expect(out.user).toBeUndefined();
    expect(out.metadata).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.stream_options).toBeUndefined();
    expect(out.system).toBeUndefined();
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
  });
});
