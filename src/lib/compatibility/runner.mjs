import { translateRequest, translateResponse, initState, describeTranslationRoute } from '../../../open-sse/translator/index.js';
import { validateDefinition, boundedJson, LIMITS, CompatibilityError, IMPLEMENTATION_VERSION } from './model.mjs';

function envelope(format, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (format === 'openai' || format === 'claude') return Array.isArray(value.messages);
  if (format === 'gemini') return Array.isArray(value.contents);
  return typeof value.input === 'string' || Array.isArray(value.input);
}
function toolSchemaCheck(value) {
  if (!value?.tools) return true;
  if (!Array.isArray(value.tools)) return false;
  return value.tools.every(tool => {
    const entries = tool.functionDeclarations || [tool.function || tool];
    return entries.every(entry => {
      const schema = entry.parameters || entry.input_schema;
      return !schema || (typeof schema === 'object' && !Array.isArray(schema));
    });
  });
}
function terminalEvent(event) {
  return event?.type === 'message_stop' || event?.type === 'response.completed' || event?.done === true
    || event?.choices?.some(choice => choice.finish_reason != null) || event?.candidates?.some(candidate => candidate.finishReason != null);
}
function checksForRequest(input, output) {
  return [
    { id: 'source-envelope', label: 'Source message envelope', outcome: envelope(input.sourceFormat, input.payload) ? 'passed' : 'failed', basis: 'Required message collection exists in the declared source shape.' },
    { id: 'target-envelope', label: 'Target message envelope', outcome: envelope(input.targetFormat, output) ? 'passed' : 'failed', basis: 'Required message collection exists in the translated target shape.' },
    { id: 'tool-schema', label: 'Tool schema object shape', outcome: toolSchemaCheck(output) ? 'passed' : 'failed', basis: 'Declared tool schema values are objects. This is not full provider schema validation.' },
  ];
}
export function executeLocalFixture(definition) {
  const input = validateDefinition(definition);
  const route = describeTranslationRoute(input.sourceFormat, input.targetFormat, input.operation === 'stream' ? 'response' : 'request');
  if (!route.supported) throw new CompatibilityError('A complete registered conversion path is unavailable. No passthrough was substituted.', 422, 'route_unavailable');
  const started = performance.now();
  let output, checks;
  if (input.operation === 'request') {
    output = translateRequest(input.sourceFormat, input.targetFormat, input.model, structuredClone(input.payload), true);
    checks = checksForRequest(input, output);
  } else {
    const state = initState(input.targetFormat); state.model = input.model;
    output = [];
    for (const event of [...input.payload, null]) {
      const converted = translateResponse(input.sourceFormat, input.targetFormat, structuredClone(event), state);
      // Some translators (openai-responses) frame each event as { event, data }
      // SSE transport pairs. Retain the typed event body; framing is transport.
      output.push(...converted.map(item => item && typeof item === 'object' && typeof item.event === 'string' && item.data !== undefined ? item.data : item));
      boundedJson(output, LIMITS.resultBytes);
    }
    checks = [
      { id: 'event-output', label: 'Translated event objects', outcome: output.length && output.every(event => event && typeof event === 'object') ? 'passed' : 'failed', basis: 'Ordered JSON events returned by the maintained stream translator, including one final flush.' },
      { id: 'terminal-event', label: 'Recognized completion event', outcome: output.some(terminalEvent) ? 'passed' : 'unknown', basis: 'A recognized terminal event was observed. Missing completion is unknown, not successful transport termination.' },
    ];
  }
  const inputJson = JSON.stringify(input.payload), outputJson = JSON.stringify(output);
  const result = {
    scope: 'local-translation', model: input.model, implementationVersion: IMPLEMENTATION_VERSION, sourceFormat: input.sourceFormat, targetFormat: input.targetFormat,
    operation: input.operation, route, checks, input: input.payload, output,
    quantities: { inputBytes: new TextEncoder().encode(inputJson).byteLength, outputBytes: new TextEncoder().encode(outputJson).byteLength, inputEvents: input.operation === 'stream' ? input.payload.length : null, outputEvents: input.operation === 'stream' ? output.length : null, translatorDurationMs: performance.now() - started },
    comparison: input.operation === 'request' ? { addedKeys: Object.keys(output).filter(key => !Object.hasOwn(input.payload, key)), removedKeys: Object.keys(input.payload).filter(key => !Object.hasOwn(output, key)), changedKeys: Object.keys(output).filter(key => Object.hasOwn(input.payload, key) && JSON.stringify(input.payload[key]) !== JSON.stringify(output[key])) } : { eventTypes: [...new Set(output.map(event => event.type || event.object || 'untyped'))] },
    coverage: { providerCalls: 0, credentialsRead: false, semanticEquivalence: 'not-established', providerSchema: 'not-validated', transport: 'not-exercised', modelReadiness: 'unknown' },
  };
  boundedJson(result, LIMITS.resultBytes);
  return result;
}
