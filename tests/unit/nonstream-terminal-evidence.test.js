import { beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { FORMATS } from '../../open-sse/translator/formats.js';
import { classifyHttpTerminalEvidence, classifyJsonTerminalEvidence } from '../../src/lib/db/terminalEvidence.js';

const saved = vi.hoisted(() => ({ detail: vi.fn(async () => {}), failure: vi.fn() }));
vi.mock('@/lib/usageDb.js', () => ({ saveRequestDetail: saved.detail, saveRequestUsage: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}) }));
vi.mock('../../open-sse/handlers/chatCore/contextTelemetry.js', () => ({ recordContextFailure: saved.failure }));
import { handleNonStreamingResponse } from '../../open-sse/handlers/chatCore/nonStreamingHandler.js';
import { handleForcedSSEToJson } from '../../open-sse/handlers/chatCore/sseToJsonHandler.js';
import { onReqSummary } from '../../src/shared/observability/decide.js';

const base = () => ({ provider: 'openai', model: 'fixture', sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
  body: { messages: [{ role: 'user', content: 'hello' }], stream: false }, stream: false,
  requestStartTime: Date.now(), reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
  trackDone() {}, appendLog() {}, log: { info() {}, warn() {}, debug() {} }, contextTelemetry: { requestId: 'fixture' } });
beforeEach(() => { saved.detail.mockClear(); saved.failure.mockClear(); });

it('records a parsed successful nonstreaming completion with provider JSON terminal evidence', async () => {
  const payload = { choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] };
  const result = await handleNonStreamingResponse({ ...base(), providerResponse: Response.json(payload) });
  expect(result.success).toBe(true);
  expect(saved.detail.mock.calls[0][0]).toMatchObject({ status: 'success', terminalEvidence: { state: 'succeeded', source: 'provider-json', reason: 'json-complete' } });
});

it('records a Responses failed JSON body with partial output as failed evidence even under HTTP200', async () => {
  const onRequestSuccess = vi.fn();
  const payload = { object: 'response', status: 'failed', error: { message: 'canary' },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }] };
  await handleNonStreamingResponse({ ...base(), sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
    providerResponse: Response.json(payload), onRequestSuccess });
  expect(saved.detail.mock.calls[0][0]).toMatchObject({ status: 'error', terminalEvidence: { state: 'failed', source: 'provider-json', reason: 'upstream-error-response' } });
  expect(onRequestSuccess).not.toHaveBeenCalled();
});

it('records parsed error JSON and unreadable JSON through the existing failure producer', async () => {
  await handleNonStreamingResponse({ ...base(), providerResponse: Response.json({ error: { message: 'provider-error' } }) });
  expect(saved.failure.mock.calls.at(-1)[1]).toMatchObject({ terminalEvidence: { state: 'failed', source: 'provider-json', reason: 'upstream-error-response' } });
  await handleNonStreamingResponse({ ...base(), providerResponse: new Response('bad-json', { headers: { 'content-type': 'application/json' } }) });
  expect(saved.failure.mock.calls.at(-1)[1]).toMatchObject({ terminalEvidence: { state: 'unknown', source: 'gateway-response', reason: 'response-rejected' } });
});

it('records forced SSE to JSON completion from raw stream terminal evidence', async () => {
  const body = 'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const result = await handleForcedSSEToJson({ ...base(), providerResponse: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  expect(result.success).toBe(true);
  expect(saved.detail.mock.calls[0][0]).toMatchObject({ status: 'success', terminalEvidence: { state: 'succeeded', source: 'provider-stream', reason: 'stream-complete' } });
});

it('retains provider failure when a forced Responses stream emits response.failed', async () => {
  const body = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"canary"}}}\n\n';
  const result = await handleForcedSSEToJson({ ...base(), provider: 'codex', targetFormat: FORMATS.OPENAI_RESPONSES,
    providerResponse: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  expect(result.success).toBe(false);
  expect(saved.failure.mock.calls.at(-1)[1]).toMatchObject({ terminalEvidence: { state: 'failed', source: 'provider-stream', reason: 'upstream-error-event' } });
});

it('retains raw Responses failure when dynamic nonstream SSE conversion rejects the body', async () => {
  const body = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"canary"}}}\n\n';
  await handleNonStreamingResponse({ ...base(), targetFormat: FORMATS.OPENAI_RESPONSES,
    providerResponse: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  expect(saved.failure.mock.calls.at(-1)[1]).toMatchObject({
    terminalEvidence: { state: 'failed', source: 'provider-stream', reason: 'upstream-error-event' },
  });
});

it('requires a fetched response URL before attributing an HTTP rejection to the provider', async () => {
  const server = createServer((_request, response) => { response.writeHead(429); response.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    await response.text();
    expect(classifyHttpTerminalEvidence(response)).toEqual({ state: 'failed', source: 'provider-http', reason: 'upstream-http-error' });
    expect(classifyHttpTerminalEvidence(new Response('{}', { status: 429 }))).toEqual({ state: 'unknown', source: 'gateway-response', reason: 'response-rejected' });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

it('does not invent a JSON terminal for unfinished choices or unsupported formats', () => {
  expect(classifyJsonTerminalEvidence({ choices: [{ finish_reason: null }] }, FORMATS.OPENAI).state).toBe('unknown');
  expect(classifyJsonTerminalEvidence({ type: 'message', stop_reason: 'end_turn' }, FORMATS.CLAUDE).state).toBe('succeeded');
  expect(classifyJsonTerminalEvidence({ choices: [{ finish_reason: 'stop' }] }, 'unsupported').state).toBe('unknown');
});

it('retains uncertain JSON output as REQ.unknown and leaves account health unchanged', async () => {
  const onRequestSuccess = vi.fn(), summaries = [];
  const unsubscribe = onReqSummary((verdict, fields) => summaries.push({ verdict, fields }));
  try {
    const result = await handleNonStreamingResponse({ ...base(), onRequestSuccess,
      providerResponse: Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: null }] }) });
    expect(result.response.status).toBe(200);
    expect(saved.detail.mock.calls.at(-1)[0].status).toBe('unknown');
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ verdict: 'unknown', fields: { status: 200, why: 'json-terminal-unconfirmed' } });
  } finally { unsubscribe(); }
});
