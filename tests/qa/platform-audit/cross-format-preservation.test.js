import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressMessages } from '../../../open-sse/rtk/index.js';
import { jsonCompact } from '../../../open-sse/rtk/filters/jsonCompact.js';
import { applyMemoryEnhancements } from '../../../open-sse/services/memory/index.js';
import { JSON_TEXT, PROTECTED, jsonLexemes, semanticFixture, preservationViolations } from './semantic-fixture.mjs';

const formats = ['claude', 'openai', 'responses', 'gemini'];
function fixture(format) {
  const message = (role, text) => format === 'gemini'
    ? { role: role === 'assistant' ? 'model' : role, parts: [{ text }] }
    : format === 'responses' ? { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }
      : format === 'claude' ? { role, content: [{ type: 'text', text }] } : { role, content: text };
  const pair = (id, text, error = false) => {
    if (format === 'claude') return [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path: '/fixture' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(error ? { is_error: true } : {}) }] },
    ];
    if (format === 'openai') return [
      { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: '{"path":"/fixture"}' } }] },
      { role: 'tool', tool_call_id: id, content: text, ...(error ? { isError: true } : {}) },
    ];
    if (format === 'responses') return [
      { type: 'function_call', call_id: id, name: 'Read', arguments: '{"path":"/fixture"}' },
      { type: 'function_call_output', call_id: id, output: text, ...(error ? { status: 'failed' } : {}) },
    ];
    return [
      { role: 'model', parts: [{ functionCall: { id, name: 'Read', args: { path: '/fixture' } } }] },
      { role: 'user', parts: [{ functionResponse: { id, name: 'Read', response: { output: text, ...(error ? { error: true } : {}) } } }] },
    ];
  };
  const history = Array.from({ length: 8 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `Historical entry ${i}. ${'Prior analysis retained in an explicitly requested summary. '.repeat(100)}`));
  const tail = [
    ...pair('error-anchor', 'Exact failure at /fixture:59.\n'.repeat(100), true),
    ...pair('json-anchor', JSON_TEXT),
    message('assistant', 'Preserve the pending recovery task.'),
    message('user', `Current request. ${PROTECTED}`),
  ];
  const key = format === 'responses' ? 'input' : format === 'gemini' ? 'contents' : 'messages';
  const instructions = format === 'gemini' ? { systemInstruction: { parts: [{ text: PROTECTED }] } }
    : format === 'responses' ? { instructions: PROTECTED } : { system: [{ type: 'text', text: PROTECTED, cache_control: { type: 'ephemeral', ttl: '1h' } }] };
  return { body: { ...instructions, [key]: [...history, ...tail] }, key, instructions, tail };
}

afterEach(() => vi.unstubAllGlobals());

describe('independent cross-format and adversarial semantic contracts', () => {
  it.each(formats)('preserves %s current instructions, errors and complete tool transactions across both RTK/pressure subsets', async (format) => {
    vi.stubGlobal('fetch', () => { throw new Error('Cross-format audit must remain offline'); });
    for (let mask = 0; mask < 4; mask++) {
      const { body, key, instructions, tail } = fixture(format);
      const expected = structuredClone(tail);
      if (mask & 1) {
        compressMessages(body, true, { allowLossy: false });
        if (format === 'claude') expected[3].content[0].content = jsonCompact(JSON_TEXT);
        if (format === 'openai') expected[3].content = jsonCompact(JSON_TEXT);
        if (format === 'responses') expected[3].output = jsonCompact(JSON_TEXT);
      }
      if (mask & 2) {
        const result = await applyMemoryEnhancements(body, {
          targetFormat: format,
          settings: { memoryContextWindowOverride: 2000, memoryToolPruningEnabled: false, memoryMediaPruningEnabled: false, memoryCompactionEnabled: true, memoryCompactionThresholdTokens: 100, memoryRecentTurnsToKeep: 2 },
        });
        // Native Gemini contents are currently an unsupported compactor shape.
        // Passthrough preserves its contents; no Gemini compaction claim is made.
        expect(result.stats.compaction.applied).toBe(format !== 'gemini');
      }
      for (const [name, value] of Object.entries(instructions)) expect(body[name]).toEqual(value);
      expect(body[key].slice(-tail.length)).toEqual(expected);
    }
  });

  it('preserves numeric lexemes, duplicate keys, escapes and Unicode over 256 seeded whitespace layouts', () => {
    let state = 0x5eedc0de;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    const spaces = ['', ' ', '\t', '\r\n', '  \n\t'];
    const tokens = jsonLexemes(JSON_TEXT);
    for (let sample = 0; sample < 256; sample++) {
      const input = spaces[random() % spaces.length] + tokens.map((token) => token + spaces[random() % spaces.length]).join('');
      const compact = jsonCompact(input);
      expect(jsonLexemes(compact)).toEqual(tokens);
      expect(compact).toContain('9007199254740993');
      expect(compact).toContain('"n":-0,"n":1.00e+2');
      expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(input));
      expect(jsonCompact(compact)).toBe(compact);
    }
  });

  it('rejects malformed JSON without a partial rewrite', () => {
    for (const input of ['{"a": 1,}', '{"a": "unterminated}', '[NaN]', '{"a": 01}', '{"a": true}\u00a0']) {
      expect(jsonCompact(input)).toBeNull();
      const body = { messages: [{ role: 'tool', content: input.repeat(500) }] };
      const before = structuredClone(body);
      compressMessages(body, true, { allowLossy: false });
      expect(body).toEqual(before);
    }
  });

  it('detects deliberate corruption instead of accepting parse-equivalent or anchor-losing rewrites', () => {
    const original = semanticFixture();
    const corruptions = [
      (body) => { body.system[0].text = 'constraint deleted'; },
      (body) => { body.system[0].cache_control.ttl = '5m'; },
      (body) => { body.messages[2].content[0].content = JSON.stringify(JSON.parse(JSON_TEXT)); },
      (body) => { body.messages[2].content[0].tool_use_id = 'orphan'; },
      (body) => { body.messages[4].content[0].is_error = false; },
      (body) => { delete body.tools[0].input_schema.properties.payload.const.default; },
      (body) => { body.messages.pop(); },
    ];
    for (const corrupt of corruptions) {
      const changed = structuredClone(original);
      corrupt(changed);
      expect(preservationViolations(original, changed).length).toBeGreaterThan(0);
    }
  });
});
