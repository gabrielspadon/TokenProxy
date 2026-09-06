/**
 * Edge coverage for open-sse/executors/codex.js beyond the existing codex
 * suites: transformRequest's normalization guards (non-array input, null
 * items, stored-id stripping, tool filtering, tool_choice pruning, model
 * suffix stripping, allowlist filter), parseError's usage_limit_reached
 * parsing, refreshCredentials/prefetchImages guards, the SSE peek's
 * account-fallback and retry-exhausted verdicts, the reassembled
 * replacement stream, and the ciphertext-400 paths that must NOT retry.
 *
 * All upstream traffic is stubbed by spying on BaseExecutor.prototype;
 * nothing leaves the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BaseExecutor } from '../../open-sse/executors/base.js';
import { CodexExecutor } from '../../open-sse/executors/codex.js';
import { HTTP_STATUS } from '../../open-sse/config/runtimeConfig.js';

function sseResponse(text) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

function stubUpstream(makeResponse) {
  return vi
    .spyOn(BaseExecutor.prototype, 'execute')
    .mockImplementation(async () => ({ response: makeResponse(), transformedBody: {} }));
}

// Executor with a tight SSE retry budget so retry-exhaustion tests run in ms.
function fastRetryExecutor() {
  const executor = new CodexExecutor();
  executor.config = { ...executor.config, retry: { 503: { attempts: 1, delayMs: 1 } } };
  return executor;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('transformRequest normalization guards', () => {
  it('restores the typed placeholder when input normalizes to nothing', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.5',
      { model: 'gpt-5.5', input: null },
      true,
      {}
    );
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] },
    ]);
  });

  it('converts system role to developer, skipping null items', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: [null, { role: 'system', content: 'be terse' }],
      },
      true,
      {}
    );
    const msg = body.input.find((i) => i?.role === 'developer');
    expect(msg).toBeTruthy();
    expect(msg.content).toEqual([{ type: 'input_text', text: 'be terse' }]);
  });

  it('leaves a role-bearing non-message item and typed assistant parts repaired', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: [
          { role: 'assistant', type: 'reasoning', summary: [] },
          { role: 'assistant', content: [{ type: 'input_text', text: 'prior' }, null] },
        ],
      },
      true,
      {}
    );
    const assistantMsg = body.input.find((i) => i?.role === 'assistant' && i.type === 'message');
    expect(assistantMsg.content[0].type).toBe('output_text');
  });

  it('strips server-generated ids: string refs, item_reference objects, and embedded ids', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: [
          'rs_abc123',
          { type: 'item_reference', id: 'msg_1' },
          { role: 'user', id: 'msg_2', content: 'keep me' },
        ],
      },
      true,
      {}
    );
    expect(body.input.some((i) => i === 'rs_abc123')).toBe(false);
    expect(body.input.some((i) => i?.type === 'item_reference')).toBe(false);
    const kept = body.input.find((i) => i?.role === 'user');
    expect(kept).not.toHaveProperty('id');
  });

  it('keeps a paired tool output while tolerating null input items', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: [
          null,
          { type: 'function_call', call_id: 'c1', name: 'sh', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        ],
      },
      true,
      {}
    );
    expect(body.input.filter((i) => i?.type === 'function_call_output')).toHaveLength(1);
  });

  it('filters null tools, unknown named types, and nameless function tools; keeps hosted types', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: 'hi',
        tools: [
          null,
          { type: 'made_up_type', name: 'x' },
          { type: 'made_up_type' },
          { type: 'web_search' },
          { type: 'function', function: { name: '   ' } },
          { type: 'function', function: { name: 'real_tool', parameters: { type: 'object' } } },
        ],
      },
      true,
      {}
    );
    const types = body.tools.map((t) => t.type);
    expect(types).toEqual(['web_search', 'function']);
    expect(body.tools[1].name).toBe('real_tool');
  });

  it('drops tool_choice referencing an unknown function and keeps a known one', () => {
    const executor = new CodexExecutor();
    const dropped = executor.transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: 'hi',
        tools: [{ type: 'function', name: 'known', parameters: {} }],
        tool_choice: { type: 'function', name: 'unknown' },
      },
      true,
      {}
    );
    expect(dropped).not.toHaveProperty('tool_choice');

    const kept = executor.transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: 'hi',
        tools: [{ type: 'function', name: 'known', parameters: {} }],
        tool_choice: { type: 'function', name: 'known' },
      },
      true,
      {}
    );
    expect(kept.tool_choice).toEqual({ type: 'function', name: 'known' });
  });

  it('strips a recognized effort suffix off the model and applies it as reasoning effort', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.3-codex-high',
      {
        model: 'gpt-5.3-codex-high',
        input: 'hi',
      },
      true,
      {}
    );
    expect(body.model.endsWith('-high')).toBe(false);
    expect(body.reasoning.effort).toBe('high');
  });

  it('returns an unrecognized effort value unchanged for a model with no thinking levels', () => {
    const body = new CodexExecutor().transformRequest(
      'no-such-model-zzz',
      {
        model: 'no-such-model-zzz',
        input: 'hi',
        reasoning: { effort: 'bespoke-effort' },
      },
      true,
      {}
    );
    expect(body.reasoning.effort).toBe('bespoke-effort');
    expect(body.reasoning.summary).toBe('auto');
  });

  it('removes any field outside the Responses allowlist', () => {
    const body = new CodexExecutor().transformRequest(
      'gpt-5.5',
      {
        model: 'gpt-5.5',
        input: 'hi',
        totally_unknown_field: 'junk',
      },
      true,
      {}
    );
    expect(body).not.toHaveProperty('totally_unknown_field');
  });
});

describe('headers and credential plumbing', () => {
  it('injects the default originator when the base headers lack one', () => {
    vi.spyOn(BaseExecutor.prototype, 'buildHeaders').mockReturnValue({});
    const headers = new CodexExecutor().buildHeaders({ connectionId: 'conn-1' });
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers.session_id).toBe('conn-1');
  });

  it('refreshCredentials returns null without a refreshToken', async () => {
    expect(await new CodexExecutor().refreshCredentials({}, null)).toBeNull();
    expect(await new CodexExecutor().refreshCredentials(null, null)).toBeNull();
  });

  it('prefetchImages leaves an image part with no resolvable url untouched', async () => {
    const body = {
      input: [
        {
          content: [
            { type: 'image_url', image_url: {} },
            { type: 'input_text', text: 'x' },
          ],
        },
      ],
    };
    await new CodexExecutor().prefetchImages(body);
    expect(body.input[0].content[0]).toEqual({ type: 'image_url', image_url: {} });
  });
});

describe('parseError usage_limit_reached', () => {
  const executor = new CodexExecutor();

  it('uses resets_at when it is in the future', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const body = JSON.stringify({
      error: { type: 'usage_limit_reached', message: 'limit', resets_at: resetsAt },
    });
    const parsed = executor.parseError({ status: 429 }, body);
    expect(parsed.resetsAtMs).toBe(resetsAt * 1000);
    expect(parsed.message).toBe('limit');
  });

  it('falls back to resets_in_seconds when resets_at is stale', () => {
    const before = Date.now();
    const body = JSON.stringify({
      error: { type: 'usage_limit_reached', message: 'limit', resets_at: 1, resets_in_seconds: 60 },
    });
    const parsed = executor.parseError({ status: 429 }, body);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('defers to the base parser when no reset hint, on bad JSON, and on non-429', () => {
    const noHint = executor.parseError(
      { status: 429 },
      JSON.stringify({ error: { type: 'usage_limit_reached', message: 'm' } })
    );
    expect(noHint.resetsAtMs ?? null).toBeNull();
    const badJson = executor.parseError({ status: 429 }, 'not-json{');
    expect(badJson.status).toBe(429);
    const non429 = executor.parseError(
      { status: 500 },
      JSON.stringify({ error: { message: 'boom' } })
    );
    expect(non429.message).toBe('boom');
  });
});

describe('execute SSE verdicts', () => {
  const baseArgs = () => ({
    model: 'gpt-5.5',
    body: { model: 'gpt-5.5', input: 'hi' },
    credentials: {},
    log: null,
  });

  it('converts an SSE account-capacity error into a 503 with the extracted message', async () => {
    stubUpstream(() =>
      sseResponse(
        'event: error\ndata: {"type":"error","error":{"message":"Selected model is at capacity. Please try a different model."}}\n\n'
      )
    );
    const { response } = await new CodexExecutor().execute(baseArgs());
    expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    const parsed = await response.json();
    expect(parsed.error.message).toMatch(/at capacity/);
  });

  it('retries an SSE overloaded error then returns 503 when the budget is spent', async () => {
    const spy = stubUpstream(() =>
      sseResponse(
        'data: [DONE]\ndata: not-json\ndata: {"wrapped":[{"response":{"error":{"message":"server_is_overloaded"}}}]}\n\n'
      )
    );
    const { response } = await fastRetryExecutor().execute(baseArgs());
    expect(spy).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    const parsed = await response.json();
    expect(parsed.error.message).toBe('server_is_overloaded');
  });

  it('returns the 400 untouched when the error body cannot be read', async () => {
    const spy = stubUpstream(() => ({
      status: HTTP_STATUS.BAD_REQUEST,
      clone: () => ({ text: () => Promise.reject(new Error('unreadable')) }),
    }));
    const { response } = await new CodexExecutor().execute(baseArgs());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it('does not retry a ciphertext 400 when the body carries no strippable input', async () => {
    const spy = stubUpstream(
      () =>
        new Response(
          JSON.stringify({ error: { message: 'the encrypted content could not be decrypted' } }),
          { status: HTTP_STATUS.BAD_REQUEST }
        )
    );
    const args = baseArgs();
    args.body = { model: 'gpt-5.5', input: 'hi' }; // string input: nothing to strip
    const { response } = await new CodexExecutor().execute(args);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});

describe('_peekSseTransientError stream mechanics', () => {
  it('survives a body that errors mid-read and reassembles what it saw', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('upstream died'));
        },
      }),
      { status: 200 }
    );
    const peek = await new CodexExecutor()._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.replacementBody).toBeInstanceOf(ReadableStream);
  });

  it('reassembles peeked bytes plus the unread remainder into the replacement body', async () => {
    const encoder = new TextEncoder();
    const first = 'event: response.output_text.delta\ndata: {"delta":"a"}\n\n';
    const second = 'data: {"delta":"b"}\n\n';
    let pushRest;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(first)); // user-output pattern stops the peek here
        pushRest = () => {
          controller.enqueue(encoder.encode(second));
          controller.close();
        };
      },
    });
    const response = new Response(body, { status: 200 });
    const peek = await new CodexExecutor()._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    pushRest();
    const text = await new Response(peek.replacementBody).text();
    expect(text).toBe(first + second);
  });

  it('propagates cancel through the replacement body to the upstream reader', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 200 });
    const peek = await new CodexExecutor()._peekSseTransientError(response);
    const reader = peek.replacementBody.getReader();
    await reader.read(); // drain the peeked prefix so the upstream reader attaches
    await reader.cancel('client gone');
    expect(cancelled).toBe(true);
  });
});
