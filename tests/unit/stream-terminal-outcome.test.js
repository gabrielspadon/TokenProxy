import { expect, it, vi } from 'vitest';
import { FORMATS } from '../../open-sse/translator/formats.js';
import { createSseTerminalObserver } from '../../open-sse/utils/streamTerminal.js';
const saved = vi.hoisted(() => ({ detail: vi.fn(async () => {}), usage: vi.fn(async () => {}) }));
vi.mock('@/lib/usageDb.js', () => ({ saveRequestDetail: saved.detail, saveRequestUsage: saved.usage,
  appendRequestLog: vi.fn(async () => {}), trackPendingRequest: vi.fn() }));
import { buildOnStreamComplete, handleStreamingResponse } from '../../open-sse/handlers/chatCore/streamingHandler.js';
import { onReqSummary } from '../../src/shared/observability/decide.js';

const encoder = new TextEncoder();
it('persists an unknown terminal when the upstream closes without a successful terminal', async () => {
  saved.detail.mockClear();
  let connected = true;
  let callbacks;
  const base = { provider: 'codex', model: 'fixture', sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES, userAgent: 'codex-cli', body: { stream: true, input: 'test' },
    stream: true, requestStartTime: Date.now(), reqLogger: { appendProviderChunk() {}, appendConvertedChunk() {} },
    streamController: { signal: new AbortController().signal, isConnected: () => connected,
      handleComplete: () => { connected = false; }, handleError: () => { connected = false; callbacks.onStreamAbandoned('stream_error'); },
      handleDisconnect: () => { connected = false; }, abort() {} } };
  callbacks = buildOnStreamComplete(base);
  const result = await handleStreamingResponse({ ...base, ...callbacks,
    providerResponse: new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } }) });
  await result.response.text();
  const final = saved.detail.mock.calls.map(([row]) => row).filter((row) => row.status !== 'pending');
  expect(final).toHaveLength(1);
  expect(final[0].status).not.toBe('success');
  expect(final[0].terminalEvidence).toEqual({ state: 'unknown', reason: 'stream-interrupted', source: 'gateway-stream' });
});
it.each(['response.failed', 'response.incomplete'])('records HTTP 200 %s after partial output as an error', async (type) => {
  saved.detail.mockClear();
  const onRequestSuccess = vi.fn();
  let connected = true;
  const base = { provider: 'codex', model: 'fixture', sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES, userAgent: 'codex-cli', body: { stream: true, input: 'test' },
    stream: true, requestStartTime: Date.now(), reqLogger: { appendProviderChunk() {}, appendConvertedChunk() {} },
    streamController: { signal: new AbortController().signal, isConnected: () => connected,
      handleComplete: () => { connected = false; }, handleError: () => { connected = false; },
      handleDisconnect: () => { connected = false; }, abort() {} } };
  const callbacks = buildOnStreamComplete(base);
  const stream = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
    + `event: ${type}\ndata: ${JSON.stringify({ type, response: { status: type.split('.')[1], error: { message: 'canary' } } })}\n\n`;
  const result = await handleStreamingResponse({ ...base, ...callbacks, onRequestSuccess,
    providerResponse: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  expect(result.response.status).toBe(200);
  expect(await result.response.text()).toContain(type);
  const final = saved.detail.mock.calls.map(([row]) => row).filter((row) => row.status !== 'pending');
  expect(final).toHaveLength(1);
  expect(final[0].status).toBe('error');
  expect(final[0].terminalEvidence).toEqual({ state: 'failed', reason: 'upstream-error-event', source: 'provider-stream' });
  expect(onRequestSuccess).not.toHaveBeenCalled();
});

it('keeps uncertain stream completion out of success and failure diagnostics and account health', async () => {
  saved.detail.mockClear();
  const onRequestSuccess = vi.fn(), summaries = [];
  const unsubscribe = onReqSummary((verdict, fields) => summaries.push({ verdict, fields }));
  let connected = true;
  const base = { provider: 'openai', model: 'fixture', sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
    body: { stream: true, messages: [] }, stream: true, requestStartTime: Date.now(),
    reqLogger: { appendProviderChunk() {}, appendConvertedChunk() {} },
    streamController: { signal: new AbortController().signal, isConnected: () => connected,
      handleComplete: () => { connected = false; }, handleError: () => { connected = false; },
      handleDisconnect: () => { connected = false; }, abort() {} } };
  try {
    const result = await handleStreamingResponse({ ...base, ...buildOnStreamComplete(base), onRequestSuccess,
      providerResponse: new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: broken-json\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }) });
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(result.response.status).toBe(200);
    await result.response.text();
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(saved.detail.mock.calls.at(-1)[0].status).toBe('unknown');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ verdict: 'unknown', fields: { status: 200, why: 'terminal-evidence-malformed' } });
  } finally { unsubscribe(); }
});
it.each(['response.failed', 'response.incomplete'])('does not classify %s as successful completion', (type) => {
  const observer = createSseTerminalObserver(FORMATS.OPENAI_RESPONSES);
  observer.observe(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, response: { status: type.split('.')[1] } })}\n\n`));
  expect(observer.sawTerminal()).toBe(true);
  expect(observer.outcome()).toEqual({ state: 'failed', reason: 'upstream-error-event' });
});

it('retains failure before and after a success marker across transport chunks', () => {
  for (const chunks of [
    ['data: {"error":{"message":"canary"}}\n\n', 'data: [DONE]\n\n'],
    ['data: [DONE]\n\n', 'data: {"error":{"message":"canary"}}\n\n'],
  ]) {
    const observer = createSseTerminalObserver(FORMATS.OPENAI);
    for (const chunk of chunks) observer.observe(encoder.encode(chunk));
    expect(observer.outcome()).toEqual({ state: 'failed', reason: 'upstream-error-event' });
  }
});

it('retains unknown when a bounded parser discards an oversized record', () => {
  const observer = createSseTerminalObserver(FORMATS.OPENAI);
  observer.observe(encoder.encode(`data: ${'x'.repeat(70000)}\n\ndata: [DONE]\n\n`));
  expect(observer.outcome()).toEqual({ state: 'unknown', reason: 'terminal-evidence-overflow' });
});

it('does not let a later DONE erase an unparseable data record', () => {
  const observer = createSseTerminalObserver(FORMATS.OPENAI);
  observer.observe(encoder.encode('data: broken-json\n\ndata: [DONE]\n\n'));
  expect(observer.outcome()).toEqual({ state: 'unknown', reason: 'terminal-evidence-malformed' });
});

it('distinguishes a successful terminal and payload text mentioning failure', () => {
  const observer = createSseTerminalObserver(FORMATS.OPENAI_RESPONSES);
  observer.observe(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","text":"response.failed"}}\n\n'));
  expect(observer.outcome()).toEqual({ state: 'succeeded', reason: 'stream-complete' });
  observer.release();
  expect(observer.outcome().state).toBe('succeeded');
});
