import { describe, expect, it } from 'vitest';
import {
  claudeToOpenAIRequest,
  PASSTHROUGH_REQUEST_FIELDS,
} from 'open-sse/translator/request/claude-to-openai.js';
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from 'open-sse/translator/schema/index.js';

const MODEL = 'test-model';

describe('claudeToOpenAIRequest system handling', () => {
  it('keeps block shape when a cache_control marker is present, dropping empty blocks', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        system: [
          { type: CLAUDE_BLOCK.TEXT, text: 'cached part', cache_control: { type: 'ephemeral' } },
          { type: CLAUDE_BLOCK.TEXT, text: 'plain part' },
          { type: CLAUDE_BLOCK.TEXT, text: '' },
        ],
        messages: [],
      },
      false
    );
    const sys = out.messages[0];
    expect(sys.role).toBe(ROLE.SYSTEM);
    expect(sys.content).toEqual([
      { type: OPENAI_BLOCK.TEXT, text: 'cached part', cache_control: { type: 'ephemeral' } },
      { type: OPENAI_BLOCK.TEXT, text: 'plain part' },
    ]);
  });

  it('joins blocks to a string without markers, and strips the billing header line', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        system: [
          { type: CLAUDE_BLOCK.TEXT, text: 'x-anthropic-billing-header: v\nreal text' },
          { type: CLAUDE_BLOCK.TEXT, text: 'second' },
        ],
        messages: [],
      },
      false
    );
    expect(out.messages[0].content).toBe('real text\nsecond');
  });

  it('emits no system message when every block is empty, and accepts a plain string', () => {
    const empty = claudeToOpenAIRequest(MODEL, { system: [{ text: '' }], messages: [] }, false);
    expect(empty.messages).toHaveLength(0);
    const str = claudeToOpenAIRequest(MODEL, { system: 'sys str', messages: [] }, false);
    expect(str.messages[0].content).toBe('sys str');
  });

  it('skips a system prompt whose blocks all collapse when a marker sits on an empty block', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        system: [{ type: CLAUDE_BLOCK.TEXT, text: '', cache_control: { type: 'ephemeral' } }],
        messages: [],
      },
      false
    );
    expect(out.messages).toHaveLength(0);
  });
});

describe('claudeToOpenAIRequest top-level fields', () => {
  it('carries temperature, reasoning_effort (both spellings), reasoning and passthrough fields', () => {
    const body = {
      messages: [],
      temperature: 0.3,
      reasoning: { effort: 'high' },
    };
    for (const key of PASSTHROUGH_REQUEST_FIELDS) body[key] = `${key}-v`;
    const out = claudeToOpenAIRequest(MODEL, body, true);
    expect(out.stream).toBe(true);
    expect(out.temperature).toBe(0.3);
    expect(out.reasoning_effort).toBe('high');
    expect(out.reasoning).toEqual({ effort: 'high' });
    for (const key of PASSTHROUGH_REQUEST_FIELDS) expect(out[key]).toBe(`${key}-v`);

    const direct = claudeToOpenAIRequest(MODEL, { messages: [], reasoning_effort: 'low' }, false);
    expect(direct.reasoning_effort).toBe('low');
  });

  it('normalizes tool schemas: missing, malformed, and object-without-properties', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [],
        tools: [
          { name: 'a', description: 'd' },
          { name: 'b', input_schema: [1, 2] },
          { name: 'c', input_schema: { properties: { x: {} } } },
          { name: 'd', input_schema: { type: 'object' } },
          { name: 'e', input_schema: { type: 'string' } },
        ],
        tool_choice: { type: 'tool', name: 'a' },
      },
      false
    );
    const params = out.tools.map((t) => t.function.parameters);
    expect(params[0]).toEqual({ type: 'object', properties: {} });
    expect(params[1]).toEqual({ type: 'object', properties: {} });
    expect(params[2]).toEqual({ type: 'object', properties: { x: {} } });
    expect(params[3]).toEqual({ type: 'object', properties: {} });
    expect(params[4]).toEqual({ type: 'string' });
    expect(out.tool_choice).toEqual({ type: OPENAI_BLOCK.FUNCTION, function: { name: 'a' } });
  });

  it('maps tool_choice any/auto/string/unknown', () => {
    const mk = (tool_choice) =>
      claudeToOpenAIRequest(MODEL, { messages: [], tool_choice }, false).tool_choice;
    expect(mk({ type: 'any' })).toBe('required');
    expect(mk({ type: 'auto' })).toBe('auto');
    expect(mk('none')).toBe('none');
    expect(mk({ type: 'mystery' })).toBe('auto');
  });
});

describe('message conversion', () => {
  it('wraps a mid-conversation system message as instructions, dropping an empty one', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          { role: ROLE.SYSTEM, content: 'be brief' },
          { role: ROLE.SYSTEM, content: [{ type: CLAUDE_BLOCK.TEXT, text: '' }] },
        ],
      },
      false
    );
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe(ROLE.USER);
    expect(out.messages[0].content).toContain('<instructions>');
    expect(out.messages[0].content).toContain('be brief');
  });

  it('converts thinking blocks to reasoning_content on tool-call, text and thinking-only turns', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          {
            role: ROLE.ASSISTANT,
            content: [
              { type: CLAUDE_BLOCK.THINKING, thinking: 'hmm' },
              { type: CLAUDE_BLOCK.TOOL_USE, id: 't1', name: 'f', input: { a: 1 } },
            ],
          },
          {
            role: ROLE.USER,
            content: [{ type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: 't1', content: 'ok' }],
          },
          {
            role: ROLE.ASSISTANT,
            content: [
              { type: CLAUDE_BLOCK.THINKING, thinking: 'later ' },
              { type: CLAUDE_BLOCK.TEXT, text: 'answer' },
            ],
          },
          { role: ROLE.ASSISTANT, content: [{ type: CLAUDE_BLOCK.THINKING, thinking: 'only' }] },
        ],
      },
      false
    );
    const [asst, toolMsg, textMsg, thinkOnly] = out.messages;
    expect(asst.reasoning_content).toBe('hmm');
    expect(asst.tool_calls[0]).toEqual({
      id: 't1',
      type: OPENAI_BLOCK.FUNCTION,
      function: { name: 'f', arguments: JSON.stringify({ a: 1 }) },
    });
    expect(toolMsg).toEqual({ role: ROLE.TOOL, tool_call_id: 't1', content: 'ok' });
    expect(textMsg.reasoning_content).toBe('later ');
    expect(thinkOnly).toEqual({ role: ROLE.ASSISTANT, content: '', reasoning_content: 'only' });
  });

  it('tool-call turn without thinking still carries empty reasoning_content (#1480)', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          { role: ROLE.ASSISTANT, content: [{ type: CLAUDE_BLOCK.TOOL_USE, id: 't1', name: 'f' }] },
        ],
      },
      false
    );
    expect(out.messages[0].reasoning_content).toBe('');
    expect(out.messages[0].content).toBeUndefined();
  });

  it('lifts images out of tool_result content and keeps the text in the tool turn', () => {
    const src = { type: 'base64', media_type: 'image/png', data: 'AAAA' };
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          {
            role: ROLE.USER,
            content: [
              {
                type: CLAUDE_BLOCK.TOOL_RESULT,
                tool_use_id: 't1',
                content: [
                  { type: CLAUDE_BLOCK.TEXT, text: 'caption' },
                  { type: CLAUDE_BLOCK.IMAGE, source: src },
                ],
              },
            ],
          },
        ],
      },
      false
    );
    const [toolMsg, userMsg] = out.messages;
    expect(toolMsg.role).toBe(ROLE.TOOL);
    expect(toolMsg.content).toBe('caption');
    expect(userMsg.role).toBe(ROLE.USER);
    const parts = Array.isArray(userMsg.content) ? userMsg.content : [userMsg.content];
    expect(JSON.stringify(parts)).toContain('data:image/png;base64,AAAA');
  });

  it('an image-only tool_result gets a placeholder, and non-string non-array content is stringified', () => {
    const src = { type: 'base64', media_type: 'image/png', data: 'BBBB' };
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          {
            role: ROLE.USER,
            content: [
              {
                type: CLAUDE_BLOCK.TOOL_RESULT,
                tool_use_id: 't1',
                content: [{ type: CLAUDE_BLOCK.IMAGE, source: src }],
              },
              { type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: 't2', content: { deep: 1 } },
              { type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: 't3', content: [{ type: 'weird' }] },
            ],
          },
        ],
      },
      false
    );
    const tool = out.messages.filter((m) => m.role === ROLE.TOOL);
    expect(tool[0].content).toBe('[tool returned an image; see attached]');
    expect(tool[1].content).toBe(JSON.stringify({ deep: 1 }));
    expect(tool[2].content).toBe(JSON.stringify([{ type: 'weird' }]));
  });

  it('converts a user image block and drops a non-base64 one', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          {
            role: ROLE.USER,
            content: [
              {
                type: CLAUDE_BLOCK.IMAGE,
                source: { type: 'base64', media_type: 'image/jpeg', data: 'CCCC' },
              },
              { type: CLAUDE_BLOCK.IMAGE, source: { type: 'url', url: 'https://x' } },
            ],
          },
        ],
      },
      false
    );
    const parts = out.messages[0].content;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe(OPENAI_BLOCK.IMAGE_URL);
  });

  it('empty content array yields an empty message, and unknown message shapes are dropped', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          { role: ROLE.USER, content: [] },
          { role: ROLE.USER, content: 42 },
        ],
      },
      false
    );
    expect(out.messages).toEqual([{ role: ROLE.USER, content: '' }]);
  });
});

describe('fixMissingToolResponsesOpenAI behaviour', () => {
  it('inserts [No response received] for tool calls without a following tool reply', () => {
    const out = claudeToOpenAIRequest(
      MODEL,
      {
        messages: [
          {
            role: ROLE.ASSISTANT,
            content: [
              { type: CLAUDE_BLOCK.TOOL_USE, id: 't1', name: 'f' },
              { type: CLAUDE_BLOCK.TOOL_USE, id: 't2', name: 'g' },
            ],
          },
          {
            role: ROLE.USER,
            content: [{ type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: 't1', content: 'done' }],
          },
          { role: ROLE.USER, content: 'next turn' },
        ],
      },
      false
    );
    const toolMsgs = out.messages.filter((m) => m.role === ROLE.TOOL);
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(['t1', 't2']);
    expect(toolMsgs.find((m) => m.tool_call_id === 't2').content).toBe('[No response received]');
    // The synthetic reply sits before the following user turn
    const idxSynthetic = out.messages.findIndex((m) => m.tool_call_id === 't2');
    const idxNext = out.messages.findIndex((m) => m.content === 'next turn');
    expect(idxSynthetic).toBeLessThan(idxNext);
  });
});

describe('max_tokens', () => {
  it('is present only when the body carries it', () => {
    expect(claudeToOpenAIRequest(MODEL, { messages: [] }, false).max_tokens).toBeUndefined();
    const out = claudeToOpenAIRequest(MODEL, { messages: [], max_tokens: 128 }, false);
    expect(typeof out.max_tokens).toBe('number');
    expect(out.max_tokens).toBeGreaterThan(0);
  });
});
