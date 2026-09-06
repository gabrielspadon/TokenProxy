import { describe, expect, it } from 'vitest';
import { compactContextWindow } from '../../../open-sse/services/memory/contextCompactor.js';

const history = () => Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Historical entry ${i}. ${'Preserve the request and constraints. '.repeat(30)}` }));
const options = { enabled: true, thresholdTokens: 100, recentTurnsToKeep: 2, format: 'claude' };
const tools = {
  claude: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-a', name: 'Read', input: { file: '/fixture' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'exact tool result' }] }],
  openai: [{ role: 'assistant', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-a', content: 'exact tool result' }],
  responses: [{ type: 'function_call', call_id: 'call-a', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'call-a', output: 'exact tool result' }],
  gemini: [{ role: 'model', parts: [{ functionCall: { name: 'Read', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { output: 'exact tool result' } } }] }],
};

describe('independent compactor transaction preservation', () => {
  it.each(Object.entries(tools))('retains the complete %s transaction across a recent-window cut', (_name, pair) => {
    const body = { messages: [...history(), ...structuredClone(pair), { role: 'user', content: 'Continue.' }] };
    const result = compactContextWindow(body, options);
    expect(result.compacted).toBe(true);
    expect(body.messages.slice(-3)).toEqual([...pair, { role: 'user', content: 'Continue.' }]);
  });

  it.each(['is_error', 'isError', 'error', 'status'])('retains old %s error evidence together with its tool call', (flag) => {
    const pair = structuredClone(tools.claude);
    pair[1].content[0][flag] = flag === 'status' ? 'failed' : true;
    pair[1].content[0].content = 'Exact error at line 59.\n'.repeat(100);
    const tail = history();
    const body = { messages: [...history(), ...pair, ...tail] };
    const result = compactContextWindow(body, options);
    expect(result.compacted).toBe(true);
    expect(body.messages.slice(-pair.length - tail.length)).toEqual([...pair, ...tail]);
  });

  it('retains unresolved historical calls rather than summarizing away their transaction identity', () => {
    const call = structuredClone(tools.responses[0]);
    const tail = history();
    const body = { input: [...history(), call, ...tail] };
    compactContextWindow(body, options);
    expect(body.input.slice(-tail.length - 1)).toEqual([call, ...tail]);
  });

  it('does not mutate when preserving an early error leaves no useful prefix to compact', () => {
    const pair = structuredClone(tools.claude);
    pair[1].content[0].is_error = true;
    const body = { messages: [...pair, ...history()] };
    const before = JSON.stringify(body);
    const result = compactContextWindow(body, options);
    expect(result.compacted).toBe(false);
    expect(JSON.stringify(body)).toBe(before);
  });
});
