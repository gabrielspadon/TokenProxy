/**
 * openai-responses.js request translator gap coverage: namespaced tool-name
 * resolution, duplicate declarations, tool_choice passthrough shapes,
 * reasoning text carried in content[], structured-output mapping in both
 * directions, image conversions, and token-field precedence.
 */
import { describe, expect, it } from 'vitest';
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from '../../open-sse/translator/request/openai-responses.js';
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from '../../open-sse/translator/schema/index.js';

const MODEL = 'model-under-test';

describe('Responses → Chat: tool name mapping', () => {
  it('duplicate declarations of the same tool resolve to one safe name', () => {
    const tool = {
      type: 'function',
      name: 'do.work',
      description: 'd',
      parameters: { type: 'object', properties: {} },
    };
    const out = openaiResponsesToOpenAIRequest(MODEL, {
      input: [{ role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'hi' }] }],
      tools: [tool, { ...tool }],
    });
    const names = out.tools.map((t) => t.function.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).not.toContain('.');
  });

  it('a call without a namespace resolves to the single namespaced declaration', () => {
    const out = openaiResponsesToOpenAIRequest(MODEL, {
      input: [
        {
          type: RESPONSES_ITEM.FUNCTION_CALL,
          call_id: 'c1',
          name: 'lookup',
          arguments: '{}',
        },
        {
          type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
          call_id: 'c1',
          output: 'done',
        },
      ],
      tools: [
        {
          type: RESPONSES_ITEM.TOOL_NAMESPACE,
          name: 'ns',
          tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        },
      ],
    });
    const declared = out.tools[0].function.name;
    expect(declared).toBe('ns__lookup');
    const assistantMsg = out.messages.find((m) => m.tool_calls);
    expect(assistantMsg.tool_calls[0].function.name).toBe(declared);
  });

  it('a call name with no declaration at all passes through unchanged', () => {
    const out = openaiResponsesToOpenAIRequest(MODEL, {
      input: [
        { type: RESPONSES_ITEM.FUNCTION_CALL, call_id: 'c1', name: 'ghost', arguments: '{}' },
        { role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'next' }] },
      ],
      tools: [
        {
          type: RESPONSES_ITEM.TOOL_NAMESPACE,
          name: 'ns',
          tools: [{ type: 'function', name: 'other', parameters: {} }],
        },
      ],
    });
    // function_call flushed when the following message item arrives
    expect(out.messages[0].tool_calls[0].function.name).toBe('ghost');
    expect(out.messages[1].role).toBe(ROLE.USER);
  });
});

describe('Responses → Chat: tool_choice and misc shapes', () => {
  it('a hosted-tool tool_choice shape passes through untouched', () => {
    const choice = { type: 'web_search' };
    const out = openaiResponsesToOpenAIRequest(MODEL, {
      input: [{ role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'q' }] }],
      tool_choice: choice,
    });
    expect(out.tool_choice).toEqual(choice);
  });

  it('unknown content block types inside a message pass through as-is', () => {
    const weird = { type: 'refusal', refusal: 'no' };
    const out = openaiResponsesToOpenAIRequest(MODEL, {
      input: [
        {
          role: ROLE.USER,
          content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'a' }, weird],
        },
      ],
    });
    expect(out.messages[0].content[1]).toEqual(weird);
  });

  it('reasoning item text carried in content[] attaches to the next assistant message', () => {
    const out = openaiResponsesToOpenAIRequest(MODEL, {
      input: [
        { role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'q' }] },
        { type: RESPONSES_ITEM.REASONING, content: [{ type: 'reasoning_text', text: 'because' }] },
        { role: ROLE.ASSISTANT, content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text: 'ans' }] },
      ],
    });
    const assistant = out.messages.find((m) => m.role === ROLE.ASSISTANT);
    expect(assistant.reasoning_content).toBe('because');
  });

  it('max_output_tokens maps to max_tokens and text.format maps to response_format', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const out = openaiResponsesToOpenAIRequest(MODEL, {
      input: [{ role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'q' }] }],
      max_output_tokens: 321,
      text: { format: { type: 'json_schema', name: 'shape', schema, strict: false } },
    });
    expect(out.max_tokens).toBe(321);
    expect(out.max_output_tokens).toBeUndefined();
    expect(out.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'shape', schema, strict: false },
    });
    expect(out.text).toBeUndefined();
  });

  it('text.format json_object maps, and a formatless text field is just dropped', () => {
    const base = {
      input: [{ role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'q' }] }],
    };
    const jsonObject = openaiResponsesToOpenAIRequest(MODEL, {
      ...base,
      text: { format: { type: 'json_object' } },
    });
    expect(jsonObject.response_format).toEqual({ type: 'json_object' });

    const formatless = openaiResponsesToOpenAIRequest(MODEL, {
      ...base,
      text: { verbosity: 'low' },
    });
    expect(formatless.response_format).toBeUndefined();
    expect(formatless.text).toBeUndefined();
  });
});

describe('Chat → Responses: reasoning continuity fields', () => {
  it('string msg.reasoning becomes the summary text', () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, {
      messages: [
        { role: ROLE.USER, content: 'q' },
        { role: ROLE.ASSISTANT, content: 'a', reasoning: 'thought' },
      ],
    });
    const item = out.input.find((entry) => entry.type === RESPONSES_ITEM.REASONING);
    expect(item.summary).toEqual([{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: 'thought' }]);
  });

  it('reasoning_details array joins text and content entries', () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, {
      messages: [
        { role: ROLE.USER, content: 'q' },
        {
          role: ROLE.ASSISTANT,
          content: 'a',
          reasoning_details: [{ text: 'one' }, { content: 'two' }, { other: true }],
        },
      ],
    });
    const item = out.input.find((entry) => entry.type === RESPONSES_ITEM.REASONING);
    expect(item.summary[0].text).toBe('one\ntwo');
  });
});

describe('Chat → Responses: content and tool conversions', () => {
  it('image blocks convert: object url, string url, input_image passthrough, AI SDK image', () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, {
      messages: [
        {
          role: ROLE.USER,
          content: [
            {
              type: OPENAI_BLOCK.IMAGE_URL,
              image_url: { url: 'https://a/img.png', detail: 'low' },
            },
            { type: OPENAI_BLOCK.IMAGE_URL, image_url: 'https://b/img.png' },
            { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: 'https://c/img.png' },
            { type: 'image', image: 'data:image/png;base64,AA==' },
            { type: 'tool_result', content: 'legacy' },
          ],
        },
      ],
    });
    const content = out.input[0].content;
    expect(content[0]).toEqual({
      type: RESPONSES_ITEM.INPUT_IMAGE,
      image_url: 'https://a/img.png',
      detail: 'low',
    });
    expect(content[1]).toEqual({
      type: RESPONSES_ITEM.INPUT_IMAGE,
      image_url: 'https://b/img.png',
      detail: 'auto',
    });
    expect(content[2]).toEqual({
      type: RESPONSES_ITEM.INPUT_IMAGE,
      image_url: 'https://c/img.png',
    });
    expect(content[3]).toEqual({
      type: RESPONSES_ITEM.INPUT_IMAGE,
      image_url: 'data:image/png;base64,AA==',
      detail: 'auto',
    });
    expect(content[4]).toEqual({ type: RESPONSES_ITEM.INPUT_TEXT, text: 'legacy' });
  });

  it('tool message with array content joins its text parts', () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, {
      messages: [{ role: ROLE.TOOL, tool_call_id: 'c1', content: [{ text: 'a' }, { other: 1 }] }],
    });
    const item = out.input.find((entry) => entry.type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT);
    expect(item.output).toBe('a{"other":1}');
  });

  it('a non-function tool declaration passes through untouched', () => {
    const hosted = { type: 'web_search_preview' };
    const out = openaiToOpenAIResponsesRequest(MODEL, {
      messages: [{ role: ROLE.USER, content: 'q' }],
      tools: [hosted],
    });
    expect(out.tools[0]).toEqual(hosted);
  });

  it('unknown tool_choice object shape passes through', () => {
    const choice = { type: 'web_search' };
    const out = openaiToOpenAIResponsesRequest(MODEL, {
      messages: [{ role: ROLE.USER, content: 'q' }],
      tool_choice: choice,
    });
    expect(out.tool_choice).toEqual(choice);
  });

  it('response_format converts: json_schema, schemaless json_schema, json_object', () => {
    const schema = { type: 'object' };
    const base = { messages: [{ role: ROLE.USER, content: 'q' }] };
    const withSchema = openaiToOpenAIResponsesRequest(MODEL, {
      ...base,
      response_format: { type: 'json_schema', json_schema: { schema } },
    });
    expect(withSchema.text).toEqual({
      format: { type: 'json_schema', name: 'response', schema, strict: true },
    });

    const schemaless = openaiToOpenAIResponsesRequest(MODEL, {
      ...base,
      response_format: { type: 'json_schema', json_schema: {} },
    });
    expect(schemaless.text).toBeUndefined();

    const jsonObject = openaiToOpenAIResponsesRequest(MODEL, {
      ...base,
      response_format: { type: 'json_object' },
    });
    expect(jsonObject.text).toEqual({ format: { type: 'json_object' } });
  });
});
