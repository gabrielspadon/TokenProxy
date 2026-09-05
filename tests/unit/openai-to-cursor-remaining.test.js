// Kills remaining openai-to-cursor.js survivors: extractContent's non-object
// array-entry guard, normalizeToolCallId's newline split, rememberToolMeta's
// name-empty-string-to-"tool" fallback, USER content-array non-object block
// guard, TOOL_RESULT's normalized-id fallback lookup, an all-falsy parts join
// producing no pushed message, and ASSISTANT tool_calls' empty-content
// default.
import { describe, it, expect } from 'vitest';
import { openaiToCursorRequest } from 'open-sse/translator/request/openai-to-cursor.js';

function run(messages, extra = {}) {
  return openaiToCursorRequest('m', { messages, ...extra }, false, {});
}

describe('extractContent array filtering', () => {
  it('a non-object entry (e.g. a bare string) in the content array is skipped, not thrown on', () => {
    const out = run([{ role: 'user', content: ['not-an-object', { type: 'text', text: 'hi' }] }]);
    expect(out.messages[0].content).toBe('hi');
  });
});

describe('normalizeToolCallId splits on newline and keeps only the first segment', () => {
  it('an id with a newline-appended suffix registers both the raw and normalized form', () => {
    const out = run([
      {
        role: 'assistant',
        tool_calls: [{ id: 'call-1\nextra', function: { name: 'search' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' },
    ]);
    expect(out.messages[1].content).toContain('<tool_name>search</tool_name>');
  });
});

describe('rememberToolMeta name fallback', () => {
  it('an empty-string function name falls back to "tool" in the meta map', () => {
    const out = run([
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: '' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'x' },
    ]);
    expect(out.messages[1].content).toContain('<tool_name>tool</tool_name>');
  });
});

describe('USER content-array non-object block guard', () => {
  it('a bare string block in a user content array is skipped, not thrown on', () => {
    const out = run([{ role: 'user', content: ['bare-string', { type: 'text', text: 'ok' }] }]);
    expect(out.messages[0].content).toBe('ok');
  });
});

describe('TOOL_RESULT toolMeta lookup falls back to the normalized id', () => {
  it('a tool_use_id with a newline suffix still resolves the tool name via normalization', async () => {
    const out = run([
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search' } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1\nsuffix', content: 'r' }],
      },
    ]);
    expect(out.messages[1].content).toContain('<tool_name>search</tool_name>');
  });
});

describe('an all-empty parts array produces no pushed user message', () => {
  it('a content array with a text block of empty string and no tool_result contributes no message', () => {
    const out = run([{ role: 'user', content: [{ type: 'text', text: '' }] }]);
    expect(out.messages).toEqual([]);
  });
});

describe('ASSISTANT tool_calls with no content defaults to empty string, not undefined', () => {
  it('an assistant message with tool_calls and no content field gets content: ""', () => {
    const out = run([
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
    ]);
    expect(out.messages[0].content).toBe('');
  });
});
