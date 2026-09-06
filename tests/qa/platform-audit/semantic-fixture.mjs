export const PROTECTED = 'Never delete the source dataset. Preserve 0.125 Pa calibration, UTC timestamps, and the pending reviewer request.';
export const JSON_TEXT = '{\n  "id": 9007199254740993,\n  "n": -0,\n  "n": 1.00e+2,\n  "path": "a  b\\tfile",\n  "items": [\n' + Array.from({ length: 48 }, (_, i) => `    { "index": ${i}, "label": "ação  ${i}  🐋", "active": true }`).join(',\n') + '\n  ]\n}';

export function semanticFixture() {
  const schema = {
    type: 'object', required: ['title', 'payload'], additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Literal  spacing  matters in returned titles.' },
      payload: { enum: [{ title: 'keep', default: 'literal data', examples: ['A', 'B'], description: 'two  spaces' }], const: { title: 'keep', default: 'literal data', examples: ['A', 'B'], description: 'two  spaces' } },
    },
    description: ('An annotation documents behavior and is read by the model.  ').repeat(150),
    default: { title: 'fallback title', payload: { title: 'keep' } },
  };
  return {
    model: 'claude-sonnet-4-6', stream: false, max_tokens: 128,
    system: [{ type: 'text', text: PROTECTED, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ type: 'custom', name: 'Read', description: 'Read bytes, preserving exact values.', input_schema: schema, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: `Original requirement. ${PROTECTED} ${'Historical notes about signal units. '.repeat(25)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Read the source before changing anything.' }, { type: 'tool_use', id: 'read-json', name: 'Read', input: { path: '/fixtures/data.json' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-json', content: JSON_TEXT }] },
      { role: 'assistant', content: [{ type: 'text', text: 'The requested edit is still pending.' }, { type: 'tool_use', id: 'read-error', name: 'Read', input: { path: '/fixtures/missing' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-error', is_error: true, content: 'Permission denied.\n'.repeat(100) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Need the exact recovery instructions.' }] },
      { role: 'user', content: [{ type: 'text', text: `Keep the pending task. ${PROTECTED}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Waiting for approval before deletion.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue the analysis without changing the dataset.' }] },
    ],
  };
}

// This oracle compares the JSON lexical token stream, avoiding a parse/stringify
// oracle that would itself erase duplicate keys or round the large integer.
export function jsonLexemes(text) {
  if (typeof text !== 'string') return null;
  try { JSON.parse(text); } catch { return null; }
  return text.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g);
}

export function preservationViolations(entry, output) {
  const violations = [];
  if (!output || !Array.isArray(output.messages)) return ['missing-messages'];
  const originalSystem = output.system?.find((block) => block.text === entry.system[0].text);
  if (!originalSystem) violations.push('system-anchor');
  if (JSON.stringify(originalSystem?.cache_control) !== JSON.stringify(entry.system[0].cache_control)) violations.push('explicit-system-cache');
  if (JSON.stringify(output.tools?.[0]?.input_schema) !== JSON.stringify(entry.tools[0].input_schema)) violations.push('schema-semantics');
  if (output.messages.length !== entry.messages.length) violations.push('message-count');
  for (let i = 0; i < entry.messages.length; i++) {
    const original = entry.messages[i];
    const actual = output.messages[i];
    if (actual?.role !== original.role) { violations.push(`role-${i}`); continue; }
    for (let j = 0; j < original.content.length; j++) {
      const before = original.content[j];
      const after = actual.content?.[j];
      if (!after) { violations.push(`block-missing-${i}-${j}`); continue; }
      if (before.type === 'tool_result' && before.tool_use_id === 'read-json') {
        if (JSON.stringify(jsonLexemes(before.content)) !== JSON.stringify(jsonLexemes(after.content ?? ''))) violations.push('json-lexemes');
        if (after.tool_use_id !== before.tool_use_id || after.type !== before.type) violations.push('tool-result-identity');
      } else {
        // A newly assigned breakpoint is transport metadata, while all caller
        // content, error bits, transaction IDs and explicit breakpoints remain.
        const copy = { ...after };
        if (!Object.hasOwn(before, 'cache_control')) delete copy.cache_control;
        if (JSON.stringify(copy) !== JSON.stringify(before)) violations.push(`semantic-block-${i}-${j}`);
      }
    }
    if (actual.content?.length !== original.content.length) violations.push(`extra-block-${i}`);
  }
  return violations;
}
