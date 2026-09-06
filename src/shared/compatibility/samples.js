export const SAMPLE_FIXTURES = [
  { name: 'Synthetic tool round trip', definition: { version: 1, origin: 'synthetic', suitable: true, operation: 'request', sourceFormat: 'openai', targetFormat: 'claude', model: 'synthetic-model', payload: {
    model: 'synthetic-model', messages: [
      { role: 'system', content: 'This is a synthetic compatibility fixture. Report the measured water temperature.' },
      { role: 'user', content: 'Read the synthetic sensor.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_synthetic_1', type: 'function', function: { name: 'read_sensor', arguments: '{"station":"synthetic-A"}' } }] },
      { role: 'tool', tool_call_id: 'call_synthetic_1', content: '{"temperatureC":12.4,"fixture":true}' },
    ], tools: [{ type: 'function', function: { name: 'read_sensor', description: 'Read a synthetic sensor.', parameters: { type: 'object', properties: { station: { type: 'string' } }, required: ['station'] } } }], max_tokens: 128,
  } } },
  { name: 'Synthetic streamed answer', definition: { version: 1, origin: 'synthetic', suitable: true, operation: 'stream', sourceFormat: 'openai', targetFormat: 'openai-responses', model: 'synthetic-model', payload: [
    { id: 'synthetic-stream', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'The synthetic temperature is ' }, finish_reason: null }] },
    { id: 'synthetic-stream', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta: { content: '12.4°C.' }, finish_reason: null }] },
    { id: 'synthetic-stream', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 10, total_tokens: 42 } },
  ] } },
];
