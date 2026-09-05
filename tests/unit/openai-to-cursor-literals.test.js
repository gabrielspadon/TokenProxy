// Kills remaining literal/guard mutants in openai-to-cursor.js not covered by
// openai-to-cursor-mutation.test.js: exact tool_result block layout, the
// non-object/non-string-type content filter guard, normalizeToolCallId's
// newline-split dedup, and the several "content or empty" fallbacks. Pure
// function, no I/O.
import { describe, expect, it } from 'vitest';
import { openaiToCursorRequest } from '../../open-sse/translator/request/openai-to-cursor.js';
import { ROLE } from '../../open-sse/translator/schema/index.js';

const run = (body) => openaiToCursorRequest('m', body, true, null);

describe('extractContent: array-of-blocks filter guard (AND, not OR)', () => {
  it('drops null/non-object entries without throwing (would throw if the guard let them through)', () => {
    const out = run({
      messages: [{ role: ROLE.USER, content: [null, 5, { type: 'text', text: 'ok' }] }],
    });
    expect(out.messages).toEqual([{ role: ROLE.USER, content: 'ok' }]);
  });

  it('requires both type===text AND text typeof string; either alone is dropped', () => {
    const out = run({
      messages: [
        {
          role: ROLE.SYSTEM,
          content: [
            { type: 'text', text: 42 }, // right type, wrong text type
            { type: 'other', text: 'x' }, // right text type, wrong type
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([{ role: ROLE.USER, content: '[System Instructions]\nkeep' }]);
  });

  it('joins multiple text blocks with no separator, including an empty-text block', () => {
    const out = run({
      messages: [
        {
          role: ROLE.SYSTEM,
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: '' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    });
    expect(out.messages[0].content).toBe('[System Instructions]\nab');
  });

  it('a content value that is neither string nor array yields empty text, not a crash', () => {
    const out = run({ messages: [{ role: ROLE.SYSTEM, content: 42 }] });
    expect(out.messages).toEqual([{ role: ROLE.USER, content: '[System Instructions]\n' }]);
  });
});

describe('buildToolResultBlock: exact five-line layout, newline-joined', () => {
  it('renders every literal segment and separator exactly, with all fallbacks empty', () => {
    const out = run({ messages: [{ role: ROLE.TOOL, content: '' }] });
    expect(out.messages[0].content).toBe(
      ['<tool_result>', '<tool_name>tool</tool_name>', '<tool_call_id></tool_call_id>', '<result></result>', '</tool_result>'].join(
        '\n'
      )
    );
  });
});

describe('normalizeToolCallId: newline-suffixed ids dedupe to the base id', () => {
  it('a tool result referencing the base id still resolves the name recorded under the newline-suffixed id', () => {
    const out = run({
      messages: [
        {
          role: ROLE.ASSISTANT,
          content: '',
          tool_calls: [{ id: 'call1\nextra-garbage', function: { name: 'search' } }],
        },
        { role: ROLE.TOOL, tool_call_id: 'call1', content: 'r' },
      ],
    });
    expect(out.messages[1].content).toContain('<tool_name>search</tool_name>');
  });
});

describe('user tool_result block: missing tool_use_id metadata lookup', () => {
  it('falls back to "tool" when the referenced tool_use_id has no recorded meta, tries both raw and normalized', () => {
    const out = run({
      messages: [{ role: ROLE.USER, content: [{ type: 'tool_result', tool_use_id: '', content: 'x' }] }],
    });
    expect(out.messages[0].content).toBe(
      ['<tool_result>', '<tool_name>tool</tool_name>', '<tool_call_id></tool_call_id>', '<result>x</result>', '</tool_result>'].join(
        '\n'
      )
    );
  });
});

describe('assistant tool_calls length guard is strictly >0, not >=0', () => {
  it('an empty tool_calls array falls through to the plain-content branch, not the tool_calls branch', () => {
    const out = run({
      messages: [{ role: ROLE.ASSISTANT, content: 'hi', tool_calls: [] }],
    });
    expect(out.messages[0]).toEqual({ role: ROLE.ASSISTANT, content: 'hi' });
  });
});

describe('top-level request shape: exact key set survives, none extra', () => {
  it('rest-spread carries through only non-stripped fields with no injected ones', () => {
    const out = run({ n: 1, messages: [{ role: ROLE.USER, content: 'hi' }] });
    expect(Object.keys(out).sort()).toEqual(['max_tokens', 'messages', 'n']);
  });
});
