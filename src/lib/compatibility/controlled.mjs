import { validateDefinition, CompatibilityError, IMPLEMENTATION_VERSION, boundedJson, LIMITS } from './model.mjs';

// Installed before importing proxyFetch, which captures fetch at module load.
// This module runs only in a disposable permission-restricted worker. No URL
// supplied by a fixture can escape this in-memory transport.
export async function executeControlledFixture(definition) {
  const input = validateDefinition(definition);
  if (input.scope === 'local-translation' || !input.scope) throw new CompatibilityError('A controlled scope is required.');
  const started = performance.now(), calls = [], controller = new AbortController();
  const streaming = ['sse-terminal', 'slow-consumer', 'interrupted-stream'].includes(input.scenario);
  const nativeUsage = input.provider === 'claude'
    ? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 6, cache_creation_input_tokens: 4 }
    : { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, prompt_tokens_details: { cached_tokens: 6 } };
  const responseBody = input.provider === 'claude'
    ? { id: 'controlled-answer', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Synthetic compatibility answer.' }], stop_reason: 'end_turn', usage: nativeUsage }
    : { id: 'controlled-answer', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic compatibility answer.' }, finish_reason: 'stop' }], usage: nativeUsage };
  const frames = input.provider === 'claude'
    ? [{ type: 'message_start', message: { id: 'controlled-answer', type: 'message', role: 'assistant', content: [], usage: nativeUsage } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic compatibility answer.' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
    : [{ id: 'controlled-answer', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic compatibility answer.' }, finish_reason: null }] }, { id: 'controlled-answer', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: nativeUsage }, '[DONE]'];
  const encoded = frames.map(frame => new TextEncoder().encode(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`));
  globalThis.fetch = async (url, options) => {
    options.signal?.throwIfAborted();
    if (new URL(url).hostname !== 'compatibility.invalid' || options.method !== 'POST') throw new Error('Controlled transport refused unexpected target.');
    calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body), proxyDispatcher: options.dispatcher?.constructor?.name || null });
    if (!streaming) return Response.json(responseBody);
    let index = 0;
    return new Response(new ReadableStream({ pull(stream) {
      if (input.scenario === 'interrupted-stream' && index === 1) { stream.error(new Error('controlled_stream_interruption')); return; }
      if (index === encoded.length) stream.close(); else stream.enqueue(encoded[index++]);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const [{ DefaultExecutor }, { resolveUpstreamRoute }, translator, { toOpenAIUsage }] = await Promise.all([
    import('../../../open-sse/executors/default.js'), import('../../../open-sse/handlers/chatCore/upstreamRoute.js'),
    import('../../../open-sse/translator/index.js'), import('../../../open-sse/translator/concerns/usage.js'),
  ]);
  const credentials = { providerSpecificData: { baseUrl: 'https://compatibility.invalid/v1' } };
  // Built-in executors use endpointUrl for a per-connection override.
  credentials.providerSpecificData.endpointUrl = 'https://compatibility.invalid/v1';
  const resolved = resolveUpstreamRoute({ provider: input.provider, alias: input.provider === 'claude' ? 'cc' : 'oai', model: input.model, sourceFormat: input.sourceFormat, credentials });
  if (input.scope === 'controlled-gateway-routing' && resolved.targetFormat !== input.targetFormat) throw new CompatibilityError('Declared target differs from the gateway routing decision.', 422, 'target_mismatch');
  if (resolved.transport) credentials.runtimeTransport = resolved.transport;
  let body = structuredClone(input.payload);
  if (input.scope === 'controlled-gateway-routing') body = translator.translateRequest(input.sourceFormat, input.targetFormat, input.model, body, streaming);
  const executor = new DefaultExecutor(input.provider);
  // Real endpoint/header/body construction is retained. Override only the
  // destination origin so unexpected helper calls fail the transport boundary.
  const buildUrl = executor.buildUrl.bind(executor);
  executor.buildUrl = (...args) => { const url = new URL(buildUrl(...args)); return `https://compatibility.invalid${url.pathname}`; };
  if (input.scenario === 'abort-before-dispatch') controller.abort(new DOMException('Controlled cancellation', 'AbortError'));
  const checks = [], check = (id, passed, basis) => checks.push({ id, label: id.replaceAll('-', ' '), outcome: passed ? 'passed' : 'failed', basis });
  let output = null, transportError = null, chunks = 0;
  try {
    const result = await executor.execute({ model: input.model, body, stream: streaming, credentials, signal: controller.signal, sourceFormat: input.sourceFormat, targetFormat: input.targetFormat,
      proxyOptions: input.scenario === 'proxy-configuration' ? { connectionProxyEnabled: true, connectionProxyUrl: 'http://127.0.0.1:9', strictProxy: true } : null });
    if (streaming) {
      const reader = result.response.body.getReader(), decoder = new TextDecoder(); let text = '';
      try { while (true) { const next = await reader.read(); if (next.done) break; chunks++; text += decoder.decode(next.value, { stream: true }); if (input.scenario === 'slow-consumer') await new Promise(resolve => setTimeout(resolve, 5)); } }
      finally { reader.releaseLock(); }
      output = text;
    } else output = await result.response.json();
  } catch (error) { transportError = error.name === 'AbortError' ? 'aborted' : 'interrupted'; }
  check('single-dispatch', calls.length === (input.scenario === 'abort-before-dispatch' ? 0 : 1), 'Actual maintained executor dispatch count. Interrupted generations must never be replayed.');
  if (input.scenario === 'abort-before-dispatch') check('abort-before-dispatch', transportError === 'aborted' && calls.length === 0, 'A pre-aborted signal reaches the actual executor.');
  else if (input.scenario === 'interrupted-stream') check('interruption-retained', transportError === 'interrupted' && chunks === 1 && calls.length === 1, 'Partial body consumption failed with no automatic generation replay.');
  else {
    check('transport-completed', transportError === null && output !== null, 'The fixed in-memory upstream body was fully consumed. No external socket was opened.');
    if (streaming) check('sse-terminal', typeof output === 'string' && (input.provider === 'claude' ? output.match(/"type":"message_stop"/g)?.length === 1 : output.match(/data: \[DONE\]/g)?.length === 1), 'Exactly one native terminal frame survived complete stream consumption.');
    if (input.scenario === 'slow-consumer') check('slow-consumption', chunks === encoded.length, 'Every native frame was read with a 5 ms consumer pause, including the terminal frame.');
    if (input.scenario === 'proxy-configuration') check('proxy-dispatcher', calls[0]?.proxyDispatcher === 'ProxyAgent', 'Maintained proxy selection constructed a ProxyAgent; proxy connection and credentials were not exercised.');
    if (input.scenario === 'native-fields') {
      const selected = ['messages', 'tools', 'system', 'thinking'];
      const keys = selected.filter(key => Object.hasOwn(body, key));
      check('native-fields', keys.length > 0 && keys.every(key => JSON.stringify(calls[0]?.body[key]) === JSON.stringify(body[key])), 'Exact native message/tool/system/thinking values including supplied signatures survived executor preparation.');
    }
    if (input.scenario === 'tool-ordering') {
      const messages = calls[0]?.body.messages || [];
      const declared = new Set(); let count = 0, valid = true;
      for (const message of messages) {
        for (const call of message.tool_calls || []) declared.add(call.id);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'tool_use') declared.add(block.id);
          if (block.type === 'tool_result') { count++; if (!declared.has(block.tool_use_id)) valid = false; }
        }
        if (message.role === 'tool') { count++; if (!declared.has(message.tool_call_id)) valid = false; }
      }
      check('tool-ordering', valid && count > 0, 'Each retained tool result follows a matching declared tool call after executor preparation.');
    }
    if (input.scenario === 'cache-accounting') {
      const usage = input.provider === 'claude' ? toOpenAIUsage(output?.usage, 'claude') : output?.usage;
      check('cache-accounting', usage?.prompt_tokens === 20 && usage?.completion_tokens === 2 && usage?.total_tokens === 22 && usage?.prompt_tokens_details?.cached_tokens === 6, 'Maintained usage normalization preserves fixed 20 prompt, 2 completion and 6 cached tokens; these are synthetic quantities.');
      output = { native: output, normalizedUsage: usage };
    }
  }
  const result = { scope: input.scope, implementationVersion: IMPLEMENTATION_VERSION, fixtureVersion: input.fixtureVersion, provider: input.provider, model: input.model, scenario: input.scenario,
    sourceFormat: input.sourceFormat, targetFormat: input.targetFormat, operation: input.operation,
    route: { mode: input.scope === 'controlled-gateway-routing' ? 'gateway-router' : 'executor', resolvedTarget: resolved.targetFormat }, input: input.payload, output, checks,
    quantities: { inputBytes: Buffer.byteLength(JSON.stringify(input.payload)), outputBytes: Buffer.byteLength(JSON.stringify(output)), translatorDurationMs: performance.now() - started, upstreamDispatches: calls.length, consumedChunks: chunks },
    comparison: { wire: calls, transportError }, coverage: { providerCalls: 0, credentialsRead: false, semanticEquivalence: 'not-established', providerSchema: 'not-validated', transport: 'controlled-in-memory', modelReadiness: 'unknown', httpAdmission: 'not-exercised', gatewayRouter: input.scope === 'controlled-gateway-routing' ? 'exercised' : 'not-exercised' } };
  boundedJson(result, LIMITS.resultBytes); return result;
}
