// Branch coverage for open-sse/handlers/chatCore/streamingHandler.js paths the
// existing suites miss: caller aborts at each gate, console/log fallbacks when
// log.errorLine is absent, upstream-error-as-content, peek read errors, the
// bounded antigravity JSON reader (throw and exceeded), the codex source-format
// fallback, responses-passthrough abort terminal, onRequestSuccess rejection,
// and buildOnStreamComplete's lock/verification guards. All streams are local
// ReadableStreams; nothing leaves the process.
import { describe, expect, it, vi } from 'vitest';
import { FORMATS } from 'open-sse/translator/formats.js';
import { PROVIDERS } from 'open-sse/config/providers.js';
import {
  handleStreamingResponse,
  buildOnStreamComplete,
} from 'open-sse/handlers/chatCore/streamingHandler.js';

// Provider-agnostic: derive a Responses-API provider from the registry instead
// of hardcoding one.
const RESPONSES_PROVIDER = Object.keys(PROVIDERS).find(
  (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES
);
const ANTIGRAVITY_PROVIDER = Object.keys(PROVIDERS).find(
  (p) => PROVIDERS[p]?.format === FORMATS.ANTIGRAVITY
);

const enc = (s) => new TextEncoder().encode(s);

function sseStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc(c));
      controller.close();
    },
  });
}

function mockResponse({ contentType = 'text/event-stream', body, status = 200 } = {}) {
  const headers = new Map([['content-type', contentType]]);
  headers.get = (k) => (k.toLowerCase() === 'content-type' ? contentType : null);
  return { status, headers, body };
}

function baseParams(overrides = {}) {
  return {
    provider: 'genericprov',
    model: 'test-model',
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    userAgent: 'test-agent',
    body: { stream: true },
    stream: true,
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: 'conn-branch-1',
    apiKey: 'key',
    clientRawRequest: null,
    reqLogger: {
      logTargetRequest: () => {},
      logError: () => {},
      logProviderResponse: () => {},
      logConvertedResponse: () => {},
    },
    toolNameMap: null,
    customToolNames: null,
    responsesToolNameMap: null,
    streamController: {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    },
    onStreamComplete: vi.fn(),
    streamDetailId: 'detail-branch',
    streamState: { usage: null, content: '', thinking: '', ttftAt: null },
    pxpipe: null,
    reqTag: 'REQ_BRANCH',
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn(), line: vi.fn() },
    ...overrides,
  };
}

describe('handleStreamingResponse abort and fallback-logging branches', () => {
  it('caller already aborted at entry returns the abort result immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await handleStreamingResponse(
      baseParams({
        providerResponse: mockResponse({ body: sseStream('data: x\n\n') }),
        callerSignal: ac.signal,
      })
    );
    expect(res.status).toBe(499);
    expect(res.success).toBe(false);
  });

  it('non-SSE HTML page without log.errorLine falls back to console.warn and uses the upstream status', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const params = baseParams({
      providerResponse: {
        ...mockResponse({ contentType: 'text/html', status: 521, body: null }),
        // the handler reads the body via response.text(), not the stream
        text: async () => '<html><title>Origin Down</title></html>',
      },
      log: { warn: vi.fn() }, // no errorLine
    });
    const res = await handleStreamingResponse(params);
    expect(res.success).toBe(false);
    expect(res.status).toBe(521);
    expect(res.error).toContain('Origin Down');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('caller abort observed right after the non-SSE body read returns 499', async () => {
    let polled = 0;
    const lateAbort = {
      get aborted() {
        return ++polled > 1;
      },
    };
    const res = await handleStreamingResponse(
      baseParams({
        providerResponse: mockResponse({ contentType: 'text/plain', body: sseStream('boom') }),
        callerSignal: lateAbort,
      })
    );
    expect(res.status).toBe(499);
  });

  it('missing response body fails with no-body', async () => {
    const res = await handleStreamingResponse(
      baseParams({ providerResponse: mockResponse({ body: null }) })
    );
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/no response body/i);
  });

  it('peek read error fails the stream with the reader error message', async () => {
    const body = new ReadableStream({
      pull() {
        throw new Error('socket reset mid-peek');
      },
    });
    const params = baseParams({ providerResponse: mockResponse({ body }) });
    const res = await handleStreamingResponse(params);
    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toContain('socket reset mid-peek');
    expect(params.streamController.handleError).toHaveBeenCalled();
  });

  it('upstream error framed as content fails with its status and warns without errorLine', async () => {
    const frame =
      'data: ' +
      JSON.stringify({
        choices: [{ delta: { content: '[qoder error 413: request too large]' } }],
      }) +
      '\n\n';
    const log = { warn: vi.fn() }; // no errorLine -> log.warn fallback path
    const res = await handleStreamingResponse(
      baseParams({ providerResponse: mockResponse({ body: sseStream(frame) }), log })
    );
    expect(res.success).toBe(false);
    expect(res.status).toBe(413);
    expect(log.warn).toHaveBeenCalled();
  });

  it('caller abort observed right after the first reader read returns 499', async () => {
    let polled = 0;
    // aborted=false at entry and through the peek, true at the first-read check
    const lateAbort = {
      get aborted() {
        return ++polled > 2;
      },
    };
    const frame = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n';
    const res = await handleStreamingResponse(
      baseParams({
        providerResponse: mockResponse({ body: sseStream(frame) }),
        callerSignal: lateAbort,
      })
    );
    expect(res.status).toBe(499);
  });
});

describe('handleStreamingResponse antigravity JSON-RPC branches', () => {
  it('a bounded-read overflow (>64KB JSON) fails with the safe antigravity message', async () => {
    const big = '{"pad":"' + 'x'.repeat(70 * 1024) + '"}';
    const res = await handleStreamingResponse(
      baseParams({
        provider: ANTIGRAVITY_PROVIDER,
        providerResponse: mockResponse({ contentType: 'application/json', body: sseStream(big) }),
      })
    );
    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
  });

  it('a reader that throws mid-JSON fails with the safe antigravity message', async () => {
    let first = true;
    const body = new ReadableStream({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(enc('{"partial":'));
          return;
        }
        throw new Error('mid-body reset');
      },
    });
    const res = await handleStreamingResponse(
      baseParams({
        provider: ANTIGRAVITY_PROVIDER,
        providerResponse: mockResponse({ contentType: 'application/json', body }),
      })
    );
    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
  });
});

describe('handleStreamingResponse success-path branches', () => {
  it('codex source-format fallback: unknown client format on a Responses provider still streams', async () => {
    const frames =
      'data: ' +
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ type: 'response.completed', response: { usage: { output_tokens: 1 } } }) +
      '\n\n';
    const onRequestSuccess = vi.fn().mockRejectedValue(new Error('success hook failed'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleStreamingResponse(
      baseParams({
        provider: RESPONSES_PROVIDER,
        // a sourceFormat with no CODEX_SOURCE_TO_TARGET entry -> falls back to openai
        sourceFormat: FORMATS.KIRO,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        providerResponse: mockResponse({ body: sseStream(frames) }),
        onRequestSuccess,
      })
    );
    expect(res.success).toBe(true);
    const text = await res.response.text();
    expect(text).toContain('hello');
    // onRequestSuccess rejection is swallowed and logged, never thrown
    await new Promise((r) => setTimeout(r, 10));
    expect(onRequestSuccess).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('cancelling the returned stream propagates to the upstream reader', async () => {
    let cancelled = null;
    const frame = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n';
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(enc(frame));
        // never closes: forces the composite stream to rely on cancel
      },
      cancel(reason) {
        cancelled = reason || 'cancelled';
      },
    });
    const res = await handleStreamingResponse(
      baseParams({ providerResponse: mockResponse({ body }) })
    );
    expect(res.success).toBe(true);
    await res.response.body.cancel('client gone');
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).not.toBeNull();
  });

  it('responses passthrough synthesizes a failed terminal when upstream ends without one', async () => {
    // The upstream closes after a non-terminal frame; terminateIncomplete then
    // emits the synthesized response.failed + [DONE] terminal.
    const frame =
      'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }) + '\n\n';
    const res = await handleStreamingResponse(
      baseParams({
        provider: RESPONSES_PROVIDER,
        userAgent: 'codex-cli', // droid/codex CLI skips translation -> responses passthrough
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        providerResponse: mockResponse({ body: sseStream(frame) }),
      })
    );
    expect(res.success).toBe(true);
    const out = await res.response.text();
    expect(out).toContain('partial');
    expect(out).toContain('response.failed');
    expect(out).toContain('[DONE]');
  });

  it('antigravity buffered JSON is replayed through the pipe and success notified on content', async () => {
    const payload = JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: 'buffered answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 1 },
      },
    });
    const onRequestSuccess = vi.fn().mockResolvedValue();
    const res = await handleStreamingResponse(
      baseParams({
        provider: ANTIGRAVITY_PROVIDER,
        sourceFormat: FORMATS.ANTIGRAVITY,
        targetFormat: FORMATS.ANTIGRAVITY,
        providerResponse: mockResponse({
          contentType: 'application/json',
          body: sseStream(payload),
        }),
        onRequestSuccess,
      })
    );
    expect(res.success).toBe(true);
    const text = await res.response.text();
    expect(text).toContain('buffered answer');
  });
});

describe('buildOnStreamComplete guards', () => {
  const buildArgs = (overrides = {}) => ({
    provider: 'genericprov',
    model: 'm',
    connectionId: 'conn-guard',
    apiKey: 'k',
    requestStartTime: Date.now(),
    body: { stream: true },
    stream: true,
    finalBody: null,
    translatedBody: null,
    clientRawRequest: null,
    pxpipe: null,
    reqTag: 'REQ_G',
    log: { warn: vi.fn(), line: vi.fn() },
    sourceFormat: FORMATS.OPENAI,
    rid: 'rid-guard',
    ...overrides,
  });

  it('a synchronously-throwing onEmptyStream is caught, and completion is one-shot', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onEmptyStream = vi.fn(() => {
      throw new Error('lock blew up');
    });
    const { onStreamComplete } = buildOnStreamComplete(buildArgs({ onEmptyStream }));
    onStreamComplete({ content: '', thinking: '' }, null, null, {});
    expect(onEmptyStream).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    // one-shot: a second completion is ignored
    onStreamComplete({ content: '', thinking: '' }, null, null, {});
    expect(onEmptyStream).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('antigravity terminal verification: non-function callback ignored, throwing callback warned', () => {
    const log = { warn: vi.fn(), line: vi.fn() };
    const nonFn = buildOnStreamComplete(
      buildArgs({ provider: ANTIGRAVITY_PROVIDER, log, notifyTerminalVerificationSuccess: 42 })
    );
    // Verification is published only on a consumed successful terminal; an
    // unknown terminal must never reach the callback.
    nonFn.onStreamComplete({ content: 'real answer' }, { completion_tokens: 2 }, null, { terminalEvidence: { state: 'succeeded', reason: 'stream-complete', source: 'provider-stream' } });
    expect(log.warn).not.toHaveBeenCalledWith('VERIFICATION', expect.anything());

    const throwing = buildOnStreamComplete(
      buildArgs({
        provider: ANTIGRAVITY_PROVIDER,
        log,
        notifyTerminalVerificationSuccess: () => {
          throw new Error('verify sync throw');
        },
      })
    );
    throwing.onStreamComplete({ content: 'real answer' }, { completion_tokens: 2 }, null, { terminalEvidence: { state: 'succeeded', reason: 'stream-complete', source: 'provider-stream' } });
    expect(log.warn).toHaveBeenCalledWith(
      'VERIFICATION',
      expect.stringContaining('success callback failed')
    );
  });

  it('a rejecting verification callback is also swallowed and warned', async () => {
    const log = { warn: vi.fn(), line: vi.fn() };
    const { onStreamComplete } = buildOnStreamComplete(
      buildArgs({
        provider: ANTIGRAVITY_PROVIDER,
        log,
        notifyTerminalVerificationSuccess: () => Promise.reject(new Error('verify async fail')),
      })
    );
    onStreamComplete({ content: 'real answer' }, { completion_tokens: 2 }, null, { terminalEvidence: { state: 'succeeded', reason: 'stream-complete', source: 'provider-stream' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      'VERIFICATION',
      expect.stringContaining('success callback failed')
    );
  });

  it('onStreamAbandoned after completion is a no-op; stall with no content locks', () => {
    const onEmptyStream = vi.fn();
    const first = buildOnStreamComplete(buildArgs({ onEmptyStream }));
    first.onStreamAbandoned('stall_timeout');
    expect(onEmptyStream).toHaveBeenCalledTimes(1); // stall lock fired
    first.onStreamAbandoned('stall_timeout'); // completed guard
    expect(onEmptyStream).toHaveBeenCalledTimes(1);

    const second = buildOnStreamComplete(buildArgs({ onEmptyStream: vi.fn() }));
    second.onStreamComplete({ content: 'done' }, { completion_tokens: 1 }, null, {});
    second.onStreamAbandoned('client_disconnect'); // ignored after completion
  });
});
