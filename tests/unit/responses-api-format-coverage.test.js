import { describe, expect, it } from 'vitest';
import {
  stripUnsupportedSchemaKeywords,
  normalizeToolParameters,
  normalizePassthroughToolSchemas,
  normalizeResponsesInput,
  hoistAdditionalTools,
  typeResponsesInputItems,
  convertResponsesApiFormat,
} from 'open-sse/translator/formats/responsesApi.js';
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from 'open-sse/translator/schema/index.js';

describe('stripUnsupportedSchemaKeywords', () => {
  it('removes lookaround patterns and encrypted flags recursively, including arrays', () => {
    const node = {
      properties: {
        email: { type: 'string', pattern: '(?=.*@).*' },
        plain: { type: 'string', pattern: '^a+$' },
        secret: { type: 'string', encrypted: true },
      },
      anyOf: [{ pattern: '(?<!x)y' }],
    };
    stripUnsupportedSchemaKeywords(node);
    expect(node.properties.email.pattern).toBeUndefined();
    expect(node.properties.plain.pattern).toBe('^a+$');
    expect(node.properties.secret.encrypted).toBeUndefined();
    expect(node.anyOf[0].pattern).toBeUndefined();
  });

  it('tolerates null and primitive nodes', () => {
    expect(() => stripUnsupportedSchemaKeywords(null)).not.toThrow();
    expect(() => stripUnsupportedSchemaKeywords('x')).not.toThrow();
  });
});

describe('normalizeToolParameters', () => {
  it('returns an empty object schema for falsy input', () => {
    expect(normalizeToolParameters(null)).toEqual({ type: 'object', properties: {} });
  });

  it('returns the same reference when nothing needs stripping', () => {
    const params = { type: 'object', properties: { a: { type: 'string' } } };
    expect(normalizeToolParameters(params)).toBe(params);
  });

  it("returns a fresh object when a strip is needed, leaving the caller's schema intact", () => {
    const params = { type: 'object', properties: { e: { type: 'string', encrypted: true } } };
    const out = normalizeToolParameters(params);
    expect(out).not.toBe(params);
    expect(out.properties.e.encrypted).toBeUndefined();
    expect(params.properties.e.encrypted).toBe(true);
  });
});

describe('normalizePassthroughToolSchemas', () => {
  it('ignores a body without a tools array', () => {
    const body = {};
    normalizePassthroughToolSchemas(body);
    expect(body.tools).toBeUndefined();
  });

  it('leaves non-function and parameterless tools untouched by identity', () => {
    const custom = { type: 'custom', name: 'c' };
    const fn = {
      type: OPENAI_BLOCK.FUNCTION,
      name: 'f',
      parameters: { type: 'object', properties: { p: { type: 'string', encrypted: true } } },
    };
    const clean = {
      type: OPENAI_BLOCK.FUNCTION,
      name: 'g',
      parameters: { type: 'object', properties: {} },
    };
    const body = { tools: [custom, fn, clean] };
    normalizePassthroughToolSchemas(body);
    expect(body.tools[0]).toBe(custom);
    expect(body.tools[2]).toBe(clean);
    expect(body.tools[1]).not.toBe(fn);
    expect(body.tools[1].parameters.properties.p.encrypted).toBeUndefined();
    expect(fn.parameters.properties.p.encrypted).toBe(true);
  });
});

describe('normalizeResponsesInput', () => {
  it('wraps a string as a user message and replaces an empty string with a placeholder', () => {
    const out = normalizeResponsesInput('hello');
    expect(out).toEqual([
      {
        type: RESPONSES_ITEM.MESSAGE,
        role: ROLE.USER,
        content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'hello' }],
      },
    ]);
    expect(normalizeResponsesInput('  ')[0].content[0].text).toBe('...');
  });

  it('injects a placeholder for an empty array and passes a populated array through', () => {
    const empty = normalizeResponsesInput([]);
    expect(empty).toHaveLength(1);
    expect(empty[0].content[0].text).toBe('...');
    const arr = [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: 'x' }];
    expect(normalizeResponsesInput(arr)).toBe(arr);
  });

  it('returns null for anything else', () => {
    expect(normalizeResponsesInput(42)).toBeNull();
    expect(normalizeResponsesInput(undefined)).toBeNull();
  });
});

describe('hoistAdditionalTools', () => {
  it('no-ops without an input array or without additional_tools items', () => {
    const noInput = {};
    hoistAdditionalTools(noInput);
    expect(noInput.tools).toBeUndefined();
    const plain = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: 'x' }] };
    const before = plain.input;
    hoistAdditionalTools(plain);
    expect(plain.input).toBe(before);
    expect(plain.tools).toBeUndefined();
  });

  it('hoists tools, unwraps namespaces, drops the item, and merges into existing tools[]', () => {
    const t1 = { type: OPENAI_BLOCK.FUNCTION, name: 'a' };
    const t2 = { type: OPENAI_BLOCK.FUNCTION, name: 'b' };
    const existing = { type: OPENAI_BLOCK.FUNCTION, name: 'pre' };
    const body = {
      tools: [existing],
      input: [
        { type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: 'x' },
        {
          type: RESPONSES_ITEM.ADDITIONAL_TOOLS,
          tools: [t1, { type: RESPONSES_ITEM.TOOL_NAMESPACE, tools: [t2, null] }],
        },
      ],
    };
    hoistAdditionalTools(body);
    expect(body.input).toHaveLength(1);
    expect(body.tools).toEqual([existing, t1, t2]);
  });

  it('bounds namespace recursion depth so a hostile body cannot loop', () => {
    let nested = { type: OPENAI_BLOCK.FUNCTION, name: 'deep' };
    for (let i = 0; i < 12; i++) nested = { type: RESPONSES_ITEM.TOOL_NAMESPACE, tools: [nested] };
    const body = { input: [{ type: RESPONSES_ITEM.ADDITIONAL_TOOLS, tools: [nested] }] };
    hoistAdditionalTools(body);
    expect(body.input).toEqual([]);
    expect(body.tools).toBeUndefined(); // over-deep tool never reached, none hoisted
  });
});

describe('typeResponsesInputItems', () => {
  it('types an untyped role item and converts a string content to a typed part array', () => {
    const body = {
      input: [
        { role: ROLE.USER, content: 'hi' },
        { role: ROLE.ASSISTANT, content: 'reply' },
        { type: RESPONSES_ITEM.FUNCTION_CALL, name: 'f', call_id: 'c', arguments: '{}' },
        null,
        'junk',
      ],
    };
    typeResponsesInputItems(body);
    expect(body.input[0]).toEqual({
      role: ROLE.USER,
      type: RESPONSES_ITEM.MESSAGE,
      content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'hi' }],
    });
    expect(body.input[1].content[0].type).toBe(RESPONSES_ITEM.OUTPUT_TEXT);
    expect(body.input[2].content).toBeUndefined();
  });

  it('is idempotent on already-typed items and no-ops without input', () => {
    const typed = {
      role: ROLE.USER,
      type: RESPONSES_ITEM.MESSAGE,
      content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: 'x' }],
    };
    const body = { input: [typed] };
    typeResponsesInputItems(body);
    expect(body.input[0].content).toHaveLength(1);
    expect(() => typeResponsesInputItems({})).not.toThrow();
  });
});

describe('convertResponsesApiFormat', () => {
  it('returns the body untouched without input, or when input is invalid', () => {
    const body = { messages: [{ role: ROLE.USER, content: 'x' }] };
    expect(convertResponsesApiFormat(body)).toBe(body);
    const bad = { input: 42 };
    expect(convertResponsesApiFormat(bad)).toBe(bad);
  });

  it('converts instructions, messages, function calls and outputs into chat shape', () => {
    const body = {
      input: [
        {
          type: RESPONSES_ITEM.MESSAGE,
          role: ROLE.USER,
          content: [
            { type: RESPONSES_ITEM.INPUT_TEXT, text: 'ask' },
            { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: 'https://i', detail: 'low' },
          ],
        },
        { type: RESPONSES_ITEM.FUNCTION_CALL, name: 'tool_a', call_id: 'c1', arguments: '{}' },
        { type: RESPONSES_ITEM.FUNCTION_CALL, name: ' ', call_id: 'c2', arguments: '{}' },
        { type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, call_id: 'c1', output: { ok: true } },
        { type: RESPONSES_ITEM.REASONING, summary: [] },
        { role: ROLE.ASSISTANT, content: 'typed by role fallback' },
      ],
      instructions: 'sys',
      include: [],
      prompt_cache_key: 'pck',
      store: true,
      reasoning: { effort: 'low' },
    };
    const out = convertResponsesApiFormat(body);
    expect(out.messages[0]).toEqual({ role: ROLE.SYSTEM, content: 'sys' });
    expect(out.messages[1].content).toEqual([
      { type: OPENAI_BLOCK.TEXT, text: 'ask' },
      { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: 'https://i', detail: 'low' } },
    ]);
    // assistant tool-call turn keeps only the named call (#444)
    const asst = out.messages[2];
    expect(asst.role).toBe(ROLE.ASSISTANT);
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0].id).toBe('c1');
    // tool result stringified
    expect(out.messages[3]).toEqual({
      role: ROLE.TOOL,
      tool_call_id: 'c1',
      content: JSON.stringify({ ok: true }),
    });
    // role-only item treated as a message
    expect(out.messages[4]).toEqual({ role: ROLE.ASSISTANT, content: 'typed by role fallback' });
    // Responses-specific fields removed
    for (const k of [
      'input',
      'instructions',
      'include',
      'prompt_cache_key',
      'store',
      'reasoning',
    ]) {
      expect(out[k]).toBeUndefined();
    }
  });

  it('flushes a trailing assistant tool-call turn and trailing tool results', () => {
    const out = convertResponsesApiFormat({
      input: [{ type: RESPONSES_ITEM.FUNCTION_CALL, name: 'f', call_id: 'c9', arguments: '{}' }],
    });
    expect(out.messages.at(-1).tool_calls[0].id).toBe('c9');

    const out2 = convertResponsesApiFormat({
      input: [{ type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, call_id: 'c1', output: 'text result' }],
    });
    expect(out2.messages.at(-1)).toEqual({
      role: ROLE.TOOL,
      tool_call_id: 'c1',
      content: 'text result',
    });
  });

  it('flushes pending tool results before a following message and passes unknown content parts through', () => {
    const out = convertResponsesApiFormat({
      input: [
        { type: RESPONSES_ITEM.FUNCTION_CALL, name: 'f', call_id: 'c1', arguments: '{}' },
        { type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, call_id: 'c1', output: 'done' },
        {
          type: RESPONSES_ITEM.MESSAGE,
          role: ROLE.USER,
          content: [{ type: 'mystery', text: 'kept' }],
        },
      ],
    });
    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual([ROLE.ASSISTANT, ROLE.TOOL, ROLE.USER]);
    expect(out.messages[2].content[0]).toEqual({ type: 'mystery', text: 'kept' });
  });
});
