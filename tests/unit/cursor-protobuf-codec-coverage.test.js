// cursorProtobuf codec coverage: encode/decode round-trips for the wire
// primitives (varint, FIXED32/64, unknown wire types), tool-result request
// framing, MCP tool/result encoding branches, mixed assistant message
// normalization inside encodeRequest, gzip frame parsing, and the decode
// failure fallback. Pure codec, no network. Expectations are derived from the
// module's own exports (encode then decode), not provider literals.
import { describe, it, expect } from 'vitest';
import zlib from 'zlib';

import protobuf, {
  encodeVarint,
  encodeField,
  encodeMessage,
  encodeInstruction,
  encodeToolResult,
  encodeMcpTool,
  encodeMcpTools,
  encodeMcpToolDefinition,
  encodeAgentValue,
  decodeAgentValue,
  decodeMcpArgs,
  encodeMcpResultSuccess,
  encodeMcpResultError,
  encodeMcpResultToolNotFound,
  buildChatRequest,
  buildToolResultRequest,
  generateCursorBody,
  generateToolResultBody,
  wrapConnectRPCFrame,
  parseConnectRPCFrame,
  decodeVarint,
  decodeField,
  decodeMessage,
  extractTextFromResponse,
} from '../../open-sse/utils/cursorProtobuf.js';

const LEN = 2;
const VARINT = 0;
const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');

describe('wire primitives', () => {
  it('round-trips varints across the multi-byte boundary', () => {
    for (const n of [0, 1, 127, 128, 300, 16384, 2 ** 21, 2 ** 28 - 1]) {
      const [decoded] = decodeVarint(encodeVarint(n), 0);
      expect(decoded).toBe(n);
    }
  });

  it('decodes FIXED64 and FIXED32 wire types as raw byte slices', () => {
    const f64 = new Uint8Array(2 + 8);
    f64.set(encodeVarint((7 << 3) | 1), 0);
    let [fieldNum, wireType, value] = decodeField(f64, 0);
    expect(fieldNum).toBe(7);
    expect(wireType).toBe(1);
    expect(value.length).toBe(8);

    const f32 = new Uint8Array(1 + 4);
    f32.set(encodeVarint((3 << 3) | 5), 0);
    [fieldNum, wireType, value] = decodeField(f32, 0);
    expect(wireType).toBe(5);
    expect(value.length).toBe(4);
  });

  it('returns a null value for an unknown wire type and null field at end of buffer', () => {
    const unknown = encodeVarint((2 << 3) | 4); // wire type 4: deprecated group
    const [fieldNum, wireType, value] = decodeField(unknown, 0);
    expect(fieldNum).toBe(2);
    expect(wireType).toBe(4);
    expect(value).toBeNull();
    expect(decodeField(new Uint8Array(0), 0)[0]).toBeNull();
  });

  it('encodeField returns empty for unsupported wire types and handles Buffer/garbage values', () => {
    expect(encodeField(1, 5, 1).length).toBe(0);
    const fromBuffer = encodeField(1, LEN, Buffer.from('buf'));
    expect(utf8(decodeMessage(fromBuffer).get(1)[0].value)).toBe('buf');
    const fromGarbage = encodeField(1, LEN, 12345); // non-string non-bytes -> empty payload
    expect(decodeMessage(fromGarbage).get(1)[0].value.length).toBe(0);
  });

  it('encodeInstruction of empty text is empty', () => {
    expect(encodeInstruction('').length).toBe(0);
    expect(decodeMessage(encodeInstruction('x')).has(1)).toBe(true);
  });
});

describe('ConnectRPC framing', () => {
  it('round-trips a compressed frame', () => {
    const payload = new TextEncoder().encode('payload-bytes');
    const frame = wrapConnectRPCFrame(payload, true);
    expect(frame[0]).toBe(0x01);
    const parsed = parseConnectRPCFrame(frame);
    expect(utf8(parsed.payload)).toBe('payload-bytes');
    expect(parsed.consumed).toBe(frame.length);
  });

  it('keeps the raw payload when gzip decompression fails', () => {
    const frame = wrapConnectRPCFrame(new TextEncoder().encode('not-gzip'), false);
    frame[0] = 0x01; // lie about compression
    const parsed = parseConnectRPCFrame(Buffer.from(frame));
    expect(utf8(parsed.payload)).toBe('not-gzip');
  });

  it('returns null on truncated headers and short frames', () => {
    expect(parseConnectRPCFrame(Buffer.from([0, 0]))).toBeNull();
    const short = Buffer.from([0, 0, 0, 0, 9, 1]); // claims 9 bytes, has 1
    expect(parseConnectRPCFrame(short)).toBeNull();
  });
});

describe('agent Value codec', () => {
  it('round-trips every JSON shape', () => {
    const shapes = [
      null,
      true,
      false,
      3.25,
      -1e9,
      'text',
      [],
      [1, 'two', null],
      {},
      { a: 1, b: { c: [true, 'd'] } },
    ];
    for (const shape of shapes) {
      expect(decodeAgentValue(encodeAgentValue(shape))).toEqual(shape);
    }
    expect(decodeAgentValue(encodeAgentValue(undefined))).toBeNull();
  });

  it('decodeMcpArgs round-trips a struct-of-values argument map', () => {
    const argEntry = (key, value) =>
      encodeField(
        2,
        LEN,
        Buffer.concat([
          Buffer.from(encodeField(1, LEN, key)),
          Buffer.from(encodeField(2, LEN, encodeAgentValue(value))),
        ])
      );
    const msg = Buffer.concat([
      Buffer.from(encodeField(1, LEN, 'mcp_x_tool')),
      Buffer.from(argEntry('path', '/tmp/f')),
      Buffer.from(argEntry('count', 2)),
      Buffer.from(encodeField(3, LEN, 'call-9')),
      Buffer.from(encodeField(5, LEN, 'tool')),
    ]);
    const parsed = decodeMcpArgs(msg);
    expect(parsed).toEqual({
      name: 'mcp_x_tool',
      toolName: 'tool',
      toolCallId: 'call-9',
      args: { path: '/tmp/f', count: 2 },
    });
  });
});

describe('MCP tool definition encoding', () => {
  it('encodes the OpenAI wrapper shape and the flat MCP shape identically per contract', () => {
    const wrapped = encodeMcpToolDefinition({
      function: { name: 't', description: 'd', parameters: { type: 'object' } },
    });
    const flat = encodeMcpToolDefinition({
      name: 't',
      description: 'd',
      inputSchema: { type: 'object' },
    });
    expect(Buffer.from(wrapped).equals(Buffer.from(flat))).toBe(true);
    const fields = decodeMessage(wrapped);
    expect(utf8(fields.get(1)[0].value)).toBe('t');
    expect(decodeAgentValue(fields.get(3)[0].value)).toEqual({ type: 'object' });
  });

  it('encodeMcpTools returns empty for no tools and concatenates entries otherwise', () => {
    expect(encodeMcpTools([]).length).toBe(0);
    expect(encodeMcpTools(null).length).toBe(0);
    const two = encodeMcpTools([{ name: 'a' }, { name: 'b' }]);
    expect(decodeMessage(two).get(1)).toHaveLength(2);
  });

  it('encodeMcpTool omits absent name/desc/schema and always sets a server', () => {
    const minimal = decodeMessage(encodeMcpTool({}));
    expect(minimal.has(1)).toBe(false);
    expect(minimal.has(2)).toBe(false);
    expect(minimal.has(3)).toBe(false);
    expect(utf8(minimal.get(4)[0].value)).toBe('custom');

    const full = decodeMessage(
      encodeMcpTool({
        name: 'n',
        description: 'd',
        input_schema: { a: 1 },
      })
    );
    expect(utf8(full.get(1)[0].value)).toBe('n');
    expect(JSON.parse(utf8(full.get(3)[0].value))).toEqual({ a: 1 });
  });
});

describe('MCP result encoding', () => {
  it('success carries text and image items plus an explicit is_error', () => {
    const encoded = encodeMcpResultSuccess({
      textItems: ['hello'],
      imageItems: [{ data: new TextEncoder().encode('img'), mimeType: 'image/png' }],
      isError: true,
    });
    const success = decodeMessage(decodeMessage(encoded).get(1)[0].value);
    expect(success.get(1)).toHaveLength(2);
    expect(success.get(2)[0].value).toBe(1);
    // default: no items, is_error 0
    const empty = decodeMessage(decodeMessage(encodeMcpResultSuccess()).get(1)[0].value);
    expect(empty.get(2)[0].value).toBe(0);
  });

  it('error and tool-not-found variants use their own fields', () => {
    expect(decodeMessage(encodeMcpResultError('boom')).has(2)).toBe(true);
    expect(decodeMessage(encodeMcpResultError()).has(2)).toBe(true);
    expect(decodeMessage(encodeMcpResultToolNotFound('ghost')).has(5)).toBe(true);
    expect(decodeMessage(encodeMcpResultToolNotFound()).has(5)).toBe(true);
  });
});

describe('tool result requests', () => {
  it('buildToolResultRequest strips name prefixes and splits the model_call_id delimiter', () => {
    const frame = buildToolResultRequest({
      tool_call_id: 'call-1\nmc_model-77',
      tool_name: 'mcp_custom_Write',
      result_content: 'ok',
    });
    const outer = decodeMessage(frame);
    const cv2 = decodeMessage(outer.get(2)[0].value);
    expect(utf8(cv2.get(35)[0].value)).toBe('call-1');
    expect(utf8(cv2.get(48)[0].value)).toBe('model-77');
    const mcpResult = decodeMessage(cv2.get(28)[0].value);
    expect(utf8(mcpResult.get(1)[0].value)).toBe('Write');
    expect(utf8(mcpResult.get(2)[0].value)).toBe('ok');
    expect(cv2.has(49)).toBe(false); // tool_index intentionally omitted
  });

  it('strips a bare mcp_ prefix and passes raw names through', () => {
    const selected = (name) => {
      const outer = decodeMessage(buildToolResultRequest({ tool_call_id: 'c', tool_name: name }));
      const cv2 = decodeMessage(outer.get(2)[0].value);
      return utf8(decodeMessage(cv2.get(28)[0].value).get(1)[0].value);
    };
    expect(selected('mcp_server_thing')).toBe('server_thing');
    expect(selected('Bare')).toBe('Bare');
  });

  it('generateToolResultBody frames the request', () => {
    const framed = generateToolResultBody({ tool_call_id: 'c', tool_name: 'T' });
    const parsed = parseConnectRPCFrame(Buffer.from(framed));
    expect(decodeMessage(parsed.payload).has(2)).toBe(true);
  });

  it('encodeToolResult defaults name/args/result and formats mcp__ names', () => {
    const fields = decodeMessage(encodeToolResult({ tool_call_id: 'c1' }));
    expect(utf8(fields.get(2)[0].value)).toBe('mcp_custom_tool');
    expect(utf8(fields.get(5)[0].value)).toBe('{}');
    const named = decodeMessage(
      encodeToolResult({
        tool_call_id: 'c2',
        tool_name: 'mcp__srv__do_thing',
        raw_args: '{"x":1}',
        result: 'r',
      })
    );
    expect(utf8(named.get(2)[0].value)).toBe('mcp_srv_do_thing');
    const noSplit = decodeMessage(encodeToolResult({ tool_call_id: 'c3', tool_name: 'mcp__solo' }));
    expect(utf8(noSplit.get(2)[0].value)).toBe('mcp_custom_solo');
  });
});

describe('encodeRequest mixed-assistant normalization', () => {
  const toolCallMsg = (ids) => ({
    role: 'assistant',
    content: '',
    tool_calls: ids.map((id) => ({ id })),
    tool_results: ids.map((id) => ({ tool_call_id: id, tool_name: 'T', result: 'r' })),
  });

  function messageCount(messages) {
    const req = decodeMessage(decodeMessage(buildChatRequest(messages, 'm')).get(1)[0].value);
    return req.get(1).length;
  }

  it('splits a mixed assistant message into call + result messages', () => {
    const count = messageCount([
      { role: 'user', content: 'q' },
      toolCallMsg(['a']),
      { role: 'user', content: 'next' },
    ]);
    expect(count).toBe(4); // user, assistant-call, assistant-results, user
  });

  it('does not duplicate results when the next message already carries the same ids', () => {
    const count = messageCount([
      toolCallMsg(['a', 'b']),
      {
        role: 'assistant',
        content: '',
        tool_results: [
          { tool_call_id: 'a', tool_name: 'T', result: 'r' },
          { tool_call_id: 'b', tool_name: 'T', result: 'r' },
        ],
      },
    ]);
    expect(count).toBe(2);
  });

  it('splits when the next message carries different result ids', () => {
    const count = messageCount([
      toolCallMsg(['a']),
      {
        role: 'assistant',
        content: '',
        tool_results: [{ tool_call_id: 'z', tool_name: 'T', result: 'r' }],
      },
    ]);
    expect(count).toBe(3);
  });
});

describe('generateCursorBody', () => {
  it('emits one uncompressed frame whose payload is the chat request', () => {
    const framed = generateCursorBody(
      [{ role: 'user', content: 'hi' }],
      'model-x',
      [{ function: { name: 't', parameters: { a: 1 } } }],
      'high',
      true
    );
    const parsed = parseConnectRPCFrame(Buffer.from(framed));
    expect(parsed.flags).toBe(0);
    const req = decodeMessage(decodeMessage(parsed.payload).get(1)[0].value);
    expect(req.has(34)).toBe(true); // MCP tools present
    expect(req.get(49)[0].value).toBe(2); // thinking level high
  });
});

describe('extractTextFromResponse', () => {
  it('falls back to raw_args when mcp params carry no nested args', () => {
    const toolCall = Buffer.concat([
      Buffer.from(encodeField(3, LEN, 'id-1\nsecond-line')),
      Buffer.from(encodeField(9, LEN, 'Outer')),
      Buffer.from(encodeField(10, LEN, '{"raw":1}')),
      Buffer.from(encodeField(11, VARINT, 1)),
      Buffer.from(encodeField(27, LEN, new Uint8Array(0))), // empty MCPParams
    ]);
    const result = extractTextFromResponse(new Uint8Array(encodeField(1, LEN, toolCall)));
    expect(result.toolCall).toEqual({
      id: 'id-1',
      type: 'function',
      function: { name: 'Outer', arguments: '{"raw":1}' },
      isLast: true,
    });
  });

  it('prefers the nested MCP tool name and params when present', () => {
    const nestedTool = Buffer.concat([
      Buffer.from(encodeField(1, LEN, 'Inner')),
      Buffer.from(encodeField(3, LEN, '{"nested":true}')),
    ]);
    const toolCall = Buffer.concat([
      Buffer.from(encodeField(3, LEN, 'id-2')),
      Buffer.from(encodeField(9, LEN, 'Outer')),
      Buffer.from(encodeField(27, LEN, encodeField(1, LEN, nestedTool))),
    ]);
    const result = extractTextFromResponse(new Uint8Array(encodeField(1, LEN, toolCall)));
    expect(result.toolCall.function.name).toBe('Inner');
    expect(result.toolCall.function.arguments).toBe('{"nested":true}');
    expect(result.toolCall.isLast).toBe(false);
  });

  it('returns null toolCall when the id or name is missing, then falls through', () => {
    const noName = encodeField(1, LEN, encodeField(3, LEN, 'only-id'));
    expect(extractTextFromResponse(new Uint8Array(noName)).toolCall).toBeNull();
  });

  it('extracts thinking text and empty results', () => {
    const thinking = encodeField(25, LEN, encodeField(1, LEN, 'hmm'));
    const result = extractTextFromResponse(new Uint8Array(encodeField(2, LEN, thinking)));
    expect(result.thinking).toBe('hmm');
    expect(result.text).toBeNull();
    const empty = extractTextFromResponse(new Uint8Array(encodeField(2, LEN, new Uint8Array(0))));
    expect(empty).toEqual({ text: null, error: null, toolCall: null, thinking: null });
  });
});

describe('encodeMessage', () => {
  it('carries tool results, server bubble id, and agent-mode markers', () => {
    const fields = decodeMessage(
      encodeMessage(
        'content',
        2,
        'msg-id',
        null,
        true,
        true,
        [{ tool_call_id: 'c', tool_name: 'T', result: 'r' }],
        'bubble-1'
      )
    );
    expect(utf8(fields.get(32)[0].value)).toBe('bubble-1');
    expect(fields.has(18)).toBe(true);
    expect(fields.get(29)[0].value).toBe(1);
    expect(fields.has(51)).toBe(true); // supported tools on last agent message
  });
});

describe('default export', () => {
  it('exposes the codec surface used by the executor', () => {
    for (const name of [
      'encodeVarint',
      'encodeField',
      'buildChatRequest',
      'wrapConnectRPCFrame',
      'generateCursorBody',
      'decodeMessage',
      'parseConnectRPCFrame',
      'extractTextFromResponse',
    ]) {
      expect(typeof protobuf[name]).toBe('function');
    }
  });
});
