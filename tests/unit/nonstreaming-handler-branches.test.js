// Branch coverage for open-sse/handlers/chatCore/nonStreamingHandler.js paths
// the existing suites miss: the per-client projections in
// translateNonStreamingResponse (no-choice guards, custom tool input, inline
// image data, thinking blocks), the antigravity validation gates, forced-SSE
// parsing and its failure modes, the data unwrap, classifier validation, the
// upstream-error-in-content and empty-content failures, and finish_reason
// repair. All provider responses are local Response objects; nothing leaves
// the process.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/usageDb.js', () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock('../../open-sse/handlers/chatCore/requestDetail.js', () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn(() => ({})),
  extractUsageFromResponse: vi.fn((response) => response?.usage || {}),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => 'done'),
  doneFields: vi.fn(() => ({ t: 1 })),
}));

const { FORMATS } = await import('../../open-sse/translator/formats.js');
const { handleNonStreamingResponse, translateNonStreamingResponse, hasUsefulContent } =
  await import('../../open-sse/handlers/chatCore/nonStreamingHandler.js');

function completion(message, finish = 'stop', extra = {}) {
  return {
    id: 'chatcmpl-x',
    object: 'chat.completion',
    created: 1700000000,
    model: 'm',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...extra,
  };
}

describe('translateNonStreamingResponse projections', () => {
  it('no-choice bodies pass through every fromOpenAICompletion projection unchanged', () => {
    const empty = { object: 'chat.completion' };
    for (const src of [FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, FORMATS.OLLAMA]) {
      expect(translateNonStreamingResponse(empty, FORMATS.OPENAI, src)).toBe(empty);
    }
  });

  it('openai -> claude: bad tool arguments parse to {}, object arguments kept, cache usage subtracted', () => {
    const out = translateNonStreamingResponse(
      completion(
        {
          role: 'assistant',
          content: 'txt',
          reasoning_content: 'why',
          tool_calls: [
            { id: 't1', function: { name: 'a', arguments: 'not-json{' } },
            { id: 't2', function: { name: 'b', arguments: { k: 1 } } },
            { function: { name: 'c' } },
          ],
        },
        'tool_calls',
        { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }
      ),
      FORMATS.OPENAI,
      FORMATS.CLAUDE
    );
    expect(out.type).toBe('message');
    const tools = out.content.filter((b) => b.type === 'tool_use');
    expect(tools[0].input).toEqual({});
    expect(tools[1].input).toEqual({ k: 1 });
    expect(tools[2].id).toMatch(/^toolu_/);
    expect(out.content[0]).toEqual({ type: 'thinking', thinking: 'why' });
    expect(out.usage.input_tokens).toBe(6); // 10 - 4 cached
    expect(out.usage.cache_read_input_tokens).toBe(4);
  });

  it('openai -> claude: fully empty message yields a single empty text block', () => {
    const out = translateNonStreamingResponse(
      completion({ role: 'assistant' }),
      FORMATS.OPENAI,
      FORMATS.CLAUDE
    );
    expect(out.content).toEqual([{ type: 'text', text: '' }]);
    expect(hasUsefulContent(out, true, false)).toBe(false);
  });

  it('openai -> responses: custom tool input unwrap, raw freeform fallback, reasoning tokens', () => {
    const out = translateNonStreamingResponse(
      completion(
        {
          role: 'assistant',
          reasoning_content: 'thought',
          tool_calls: [
            { id: 'c1', function: { name: 'cust', arguments: '{"input":"payload"}' } },
            { id: 'c2', function: { name: 'cust', arguments: 'raw not json' } },
            { id: 'f1', function: { name: 'fn', arguments: { a: 1 } } },
          ],
        },
        'tool_calls',
        {
          usage: {
            prompt_tokens: 5,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        }
      ),
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      ['cust']
    );
    expect(out.object).toBe('response');
    const custom = out.output.filter((i) => i.type === 'custom_tool_call');
    expect(custom[0].input).toBe('payload');
    expect(custom[1].input).toBe('raw not json');
    const fn = out.output.find((i) => i.type === 'function_call');
    expect(fn.arguments).toBe('{"a":1}');
    expect(out.output[0].type).toBe('reasoning');
    expect(out.usage.input_tokens_details.cached_tokens).toBe(2);
    expect(out.usage.output_tokens_details.reasoning_tokens).toBe(1);
    expect(hasUsefulContent(out, false, true)).toBe(true);
  });

  it('openai -> ollama: object arguments, thinking, and done_reason mapping', () => {
    const out = translateNonStreamingResponse(
      completion(
        {
          role: 'assistant',
          content: 'hi',
          reasoning_content: 'r',
          tool_calls: [{ function: { name: 'f', arguments: '{"x":2}' } }],
        },
        'length'
      ),
      FORMATS.OPENAI,
      FORMATS.OLLAMA
    );
    expect(out.done).toBe(true);
    expect(out.done_reason).toBe('length');
    expect(out.message.thinking).toBe('r');
    expect(out.message.tool_calls[0].function.arguments).toEqual({ x: 2 });
    expect(hasUsefulContent(out, false, false)).toBe(true);
  });

  it('gemini -> openai: no-candidates body passes through; inlineData becomes a markdown image', () => {
    const bare = { response: {} };
    expect(translateNonStreamingResponse(bare, FORMATS.GEMINI, FORMATS.OPENAI)).toBe(bare);

    const out = translateNonStreamingResponse(
      {
        response: {
          responseId: 'r1',
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'thinking...' },
                  { inlineData: { data: 'AAAA', mimeType: 'image/png' } },
                  { functionCall: { name: 'act', args: { q: 1 } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5, thoughtsTokenCount: 1 },
        },
      },
      FORMATS.GEMINI,
      FORMATS.OPENAI
    );
    const msg = out.choices[0].message;
    expect(msg.content).toContain('data:image/png;base64,AAAA');
    expect(msg.reasoning_content).toBe('thinking...');
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.usage.completion_tokens_details.reasoning_tokens).toBe(1);
  });

  it('gemini -> openai: candidate with no usable parts yields empty content string', () => {
    const out = translateNonStreamingResponse(
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
      FORMATS.GEMINI,
      FORMATS.OPENAI
    );
    expect(out.choices[0].message.content).toBe('');
  });

  it('claude -> openai: early return on choices, thinking and tool_use blocks, fence strip', () => {
    const already = { choices: [{ message: { content: 'x' } }] };
    expect(translateNonStreamingResponse(already, FORMATS.CLAUDE, FORMATS.OPENAI)).toBe(already);
    const nonClaude = { content: 'a plain string body' };
    expect(translateNonStreamingResponse(nonClaude, FORMATS.CLAUDE, FORMATS.OPENAI)).toBe(nonClaude);

    const out = translateNonStreamingResponse(
      {
        id: 'msg_1',
        model: 'c',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: '```json\n{"a":1}\n```' },
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', id: 'tu1', name: 'do', input: { k: 2 } },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      FORMATS.CLAUDE,
      FORMATS.OPENAI
    );
    const msg = out.choices[0].message;
    expect(msg.content).toBe('{"a":1}');
    expect(msg.reasoning_content).toBe('hmm');
    expect(msg.tool_calls[0].function.arguments).toBe('{"k":2}');
    expect(out.choices[0].finish_reason).toBe('tool_calls');
  });

  it('provider responded in Responses shape: output[] normalizes to chat.completion first', () => {
    const out = translateNonStreamingResponse(
      {
        id: 'resp_9',
        model: 'm',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'th' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'body' }] },
          { type: 'custom_tool_call', call_id: 'c9', name: 'ct', input: 'free' },
          { type: 'function_call', call_id: 'f9', name: 'fn', arguments: { z: 1 } },
        ],
        usage: { input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 1 } },
      },
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    );
    const msg = out.choices[0].message;
    expect(msg.content).toBe('body');
    expect(msg.reasoning_content).toBe('th');
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ input: 'free' });
    expect(msg.tool_calls[1].function.arguments).toBe('{"z":1}');
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(1);
  });

  it('unknown target with a choices array still projects; without one passes through', () => {
    const body = completion({ role: 'assistant', content: 'k' });
    expect(translateNonStreamingResponse(body, 'mystery', FORMATS.OPENAI)).toBe(body);
    const opaque = { weird: true };
    expect(translateNonStreamingResponse(opaque, 'mystery', FORMATS.OPENAI)).toBe(opaque);
  });
});

function jsonProviderResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

function sseProviderResponse(text) {
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function handlerParams(overrides = {}) {
  return {
    provider: 'genericprov',
    model: 'm',
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { model: 'm', stream: false },
    stream: false,
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: 'conn-ns-branch',
    apiKey: 'k',
    clientRawRequest: { endpoint: '/v1/chat/completions', body: { model: 'm' } },
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    toolNameMap: null,
    customToolNames: null,
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    pxpipe: null,
    reqTag: 'NSB',
    log: { line: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

const VALIDATION_ERROR_BODY = {
  error: {
    code: 403,
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        domain: 'daily-cloudcode-pa.googleapis.com',
        reason: 'VALIDATION_REQUIRED',
        metadata: { validation_link: 'https://accounts.google.com/verify?x=1' },
      },
    ],
  },
};

describe('handleNonStreamingResponse antigravity gates', () => {
  it('JSON validation-required triggers callback (its throw is swallowed) and 403', async () => {
    const params = handlerParams({
      provider: 'antigravity',
      providerResponse: jsonProviderResponse(VALIDATION_ERROR_BODY, { status: 403 }),
      onValidationRequired: vi.fn(async () => {
        throw new Error('cb blew up');
      }),
      verificationContext: { observationId: 'obs1' },
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.success).toBe(false);
    expect(res.status).toBe(403);
    expect(params.log.warn).toHaveBeenCalledWith(
      'VERIFICATION',
      expect.stringContaining('validation callback failed')
    );
  });

  it('SSE validation-required takes the SSE gate and 403s, callback throw swallowed', async () => {
    const frame = 'data: ' + JSON.stringify(VALIDATION_ERROR_BODY) + '\n\n';
    const params = handlerParams({
      provider: 'antigravity',
      providerResponse: sseProviderResponse(frame),
      onValidationRequired: vi.fn(async () => {
        throw new Error('cb blew up');
      }),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(403);
    expect(params.log.warn).toHaveBeenCalledWith(
      'VERIFICATION',
      expect.stringContaining('validation callback failed')
    );
  });

  it('generic antigravity error payload fails with the safe message', async () => {
    const params = handlerParams({
      provider: 'antigravity',
      providerResponse: jsonProviderResponse({ error: { message: 'internal detail leaks' } }),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(502);
    expect(res.error).not.toContain('internal detail leaks');
    expect(params.trackDone).toHaveBeenCalledTimes(1);
  });

  it('antigravity SSE success notifies terminal verification and swallows its rejection', async () => {
    const frames =
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'live' }, index: 0 }] }) + '\n\n' +
      'data: [DONE]\n\n';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notify = vi.fn(async () => {
      throw new Error('verify fail');
    });
    const onRequestSuccess = vi.fn().mockRejectedValue(new Error('late fail'));
    const params = handlerParams({
      provider: 'antigravity',
      providerResponse: sseProviderResponse(frames),
      notifyTerminalVerificationSuccess: notify,
      onRequestSuccess,
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.success).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(params.log.warn).toHaveBeenCalledWith(
      'VERIFICATION',
      expect.stringContaining('success callback failed')
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(onRequestSuccess).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('antigravity SSE to a Responses client converts through the stream-to-JSON path', async () => {
    const frames =
      'data: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }) + '\n\n' +
      'data: ' +
      JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'conv' }] },
      }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
      }) +
      '\n\n';
    const params = handlerParams({
      provider: 'antigravity',
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      providerResponse: sseProviderResponse(frames),
      notifyTerminalVerificationSuccess: vi.fn(async () => {}),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.success).toBe(true);
    const body = await res.response.json();
    expect(JSON.stringify(body)).toContain('conv');
  });
});

describe('handleNonStreamingResponse SSE and body-read failures', () => {
  it('unparseable forced SSE fails 502 with the invalid-SSE message', async () => {
    const params = handlerParams({
      providerResponse: sseProviderResponse('garbage that is not sse'),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/Invalid SSE response/);
    expect(params.appendLog).toHaveBeenCalledWith({ status: 'FAILED 502' });
  });

  it('forced SSE to a Claude client is parsed then re-translated from OpenAI', async () => {
    const frames =
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'claude sees this' }, index: 0 }] }) + '\n\n' +
      'data: [DONE]\n\n';
    const params = handlerParams({
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: 'kiro',
      providerResponse: sseProviderResponse(frames),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.success).toBe(true);
    const body = await res.response.json();
    expect(body.type).toBe('message');
    expect(body.content[0].text).toBe('claude sees this');
  });

  it('a JSON body reader that throws fails 502 invalid-response', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenBody = new ReadableStream({
      pull() {
        throw new Error('conn reset');
      },
    });
    const params = handlerParams({
      providerResponse: {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: brokenBody,
      },
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/Invalid response from/);
    errSpy.mockRestore();
  });

  it('a Responses-client SSE stream that throws mid-convert fails 502', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenBody = new ReadableStream({
      pull() {
        throw new Error('mid-convert reset');
      },
    });
    const params = handlerParams({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      providerResponse: {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: brokenBody,
      },
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(502);
    errSpy.mockRestore();
  });
});

describe('handleNonStreamingResponse post-processing gates', () => {
  it('unwraps { data: { choices } }, repairs finish_reason, logs onRequestSuccess rejection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = {
      success: true,
      data: completion(
        {
          role: 'assistant',
          content: 'w',
          tool_calls: [{ id: 't', function: { name: 'f', arguments: '{}' } }],
        },
        'other'
      ),
    };
    const onRequestSuccess = vi.fn().mockRejectedValue(new Error('hook fail'));
    const params = handlerParams({
      providerResponse: jsonProviderResponse(wrapped),
      onRequestSuccess,
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.success).toBe(true);
    const body = await res.response.json();
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    await new Promise((r) => setTimeout(r, 10));
    expect(onRequestSuccess).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('an upstream error framed as content fails 502 with the detected reason', async () => {
    const params = handlerParams({
      providerResponse: jsonProviderResponse(
        completion({ role: 'assistant', content: '[qoder error 429: rate limited]' })
      ),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(502);
    expect(params.log.warn).toHaveBeenCalled();
    expect(res.resetsAtMs).toBeGreaterThan(Date.now());
  });

  it('HTTP 200 with empty content fails 502 and leaves the account in rotation', async () => {
    const params = handlerParams({
      providerResponse: jsonProviderResponse(completion({ role: 'assistant', content: '   ' })),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/Empty response content/);
    // 35784e11 removed the forced EMPTY_CONTENT_COOLDOWN_MS here: a 200 carrying
    // no content block is a property of THAT response, not evidence the account
    // is broken, and the lock was measured concentrating on the seats still
    // serving. No forced deadline goes back, so classifyAccountFailure decides.
    // The case above it, an upstream error framed AS content, still carries one,
    // and that difference is the whole point of the pair.
    expect(res.resetsAtMs).toBeNull();
  });
});

const CLASSIFIER_BODY = {
  model: 'm',
  stream: false,
  system: 'You are a security monitor for autonomous AI coding agents. Decide.',
  messages: [{ role: 'user', content: 'judge this' }],
  stop_sequences: ['</block>'],
};

describe('handleNonStreamingResponse classifier mode', () => {
  it('valid decision passes and the message is normalized to the bare decision', async () => {
    const params = handlerParams({
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.CLAUDE,
      body: CLASSIFIER_BODY,
      providerResponse: jsonProviderResponse({
        type: 'message',
        role: 'assistant',
        model: 'c',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: ' <block>no</block> ' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.success).toBe(true);
    const body = await res.response.json();
    expect(body.content).toEqual([{ type: 'text', text: '<block>no</block>' }]);
  });

  it('an invalid decision fails 502 with the classifier error', async () => {
    const params = handlerParams({
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.CLAUDE,
      body: CLASSIFIER_BODY,
      providerResponse: jsonProviderResponse({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'maybe?' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const res = await handleNonStreamingResponse(params);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/classifier/i);
  });

  it('a legacy function_call or multiple alternatives fail before validation', async () => {
    const legacy = handlerParams({
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI,
      body: CLASSIFIER_BODY,
      providerResponse: jsonProviderResponse(
        completion({ role: 'assistant', content: '<block>no</block>', function_call: { name: 'x' } })
      ),
    });
    const legacyRes = await handleNonStreamingResponse(legacy);
    expect(legacyRes.status).toBe(502);

    const multi = handlerParams({
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI,
      body: CLASSIFIER_BODY,
      providerResponse: jsonProviderResponse({
        ...completion({ role: 'assistant', content: '<block>no</block>' }),
        choices: [
          { index: 0, message: { role: 'assistant', content: '<block>no</block>' }, finish_reason: 'stop' },
          { index: 1, message: { role: 'assistant', content: '<block>yes</block>' }, finish_reason: 'stop' },
        ],
      }),
    });
    const multiRes = await handleNonStreamingResponse(multi);
    expect(multiRes.status).toBe(502);
  });
});
