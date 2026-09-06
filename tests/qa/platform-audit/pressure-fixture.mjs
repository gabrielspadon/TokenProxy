import { semanticFixture, PROTECTED } from './semantic-fixture.mjs';

const text = (role, value) => ({ role, content: [{ type: 'text', text: value }] });
const CURRENT = `Analyze source dataset calibration reviewer requirements. ${PROTECTED}`;
export function pressureFixture() {
  const body = semanticFixture();
  body.model = 'MiniMax-M3';
  body.max_tokens = 32;
  body.tools.push(
    { name: 'WebFetch', type: 'custom', input_schema: { type: 'object' } },
    { name: 'mcp__exa__web_fetch_exa', type: 'custom', input_schema: { type: 'object' } },
  );
  // Exercise the accepted legacy Claude schema shape here. A separate real-core
  // regression covers typed custom tools crossing compatible-provider translation.
  body.tools = body.tools.map(({ type, ...tool }) => tool);
  const pair = (id, content) => [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path: `/fixture/${id}`, exact: 'two  spaces' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ];
  const json = '{\n' + ' '.repeat(300) + '"id": 9007199254740993,\n' + ' '.repeat(300) + '"payload": [\n' + Array.from({ length: 20 }, (_, i) => ' '.repeat(300) + `{ "id": ${i}, "label": "ação  🐋" }`).join(',\n') + '\n]}';
  const historicalPairs = (start, count) => Array.from({ length: count }, (_, i) => [
    text('user', `Historical pair ${start + i}. ${i % 2 ? 'orchard copper festival colors '.repeat(25) : 'source dataset calibration reviewer '.repeat(25)}`),
    text('assistant', `Historical answer ${start + i}. ${'The old analysis concerns unrelated orchard conditions. '.repeat(18)}`),
  ]).flat();
  body.messages = [
    text('user', CURRENT),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Historical reasoning. '.repeat(80), signature: 'historical-signature' }, { type: 'text', text: 'The durable requirements are recorded.' }] },
    ...pair('json-history', json),
    ...historicalPairs(0, 4),
    ...pair('visual-history', 'VISUAL_SLOT '.repeat(500)),
    ...historicalPairs(4, 8),
    text('user', 'Historical contact fixture.person@example.invalid. ' + 'The contact is no longer part of the current request. '.repeat(12)),
    text('assistant', 'Recorded historical contact.'),
    ...pair('current-evidence', 'Exact current tool evidence. Never edit this result.'),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Live reasoning must remain exact.', signature: 'live-signature' }, { type: 'text', text: 'Ready to continue from the current evidence.' }] },
    text('user', CURRENT),
  ];
  return body;
}

export function pressureViolations(before, after, { allowLossy }) {
  const issues = [];
  if (!after?.messages) return ['missing-messages'];
  const system = after.system?.find((block) => block.text === before.system[0].text);
  if (!system) issues.push('system-anchor');
  if (JSON.stringify(system?.cache_control) !== JSON.stringify(before.system[0].cache_control)) issues.push('explicit-system-cache');
  const readTool = after.tools?.find((tool) => tool.name === 'Read');
  const actualSchema = readTool?.input_schema;
  const originalSchema = before.tools[0].input_schema;
  if (!actualSchema) issues.push('live-tool-schema');
  if (JSON.stringify(readTool?.cache_control) !== JSON.stringify(before.tools[0].cache_control)) issues.push('explicit-tool-cache');
  for (const key of ['enum', 'const']) if (JSON.stringify(actualSchema?.properties?.payload?.[key]) !== JSON.stringify(originalSchema.properties.payload[key])) issues.push(`schema-literal-${key}`);
  if (!allowLossy && JSON.stringify(actualSchema) !== JSON.stringify(originalSchema)) issues.push('safe-schema-annotations');
  const current = after.messages.at(-1);
  if (current.role !== 'user' || !current.content?.some((block) => block.type === 'text' && block.text === CURRENT)) issues.push('current-user');
  const beforeCalls = new Map();
  for (const message of before.messages) for (const block of message.content || []) if (block.type === 'tool_use') beforeCalls.set(block.id, block);
  const retainedCalls = new Map();
  const retainedResults = new Set();
  const currentEvidence = before.messages.flatMap((message) => message.content || []).find((block) => block.type === 'tool_result' && block.tool_use_id === 'current-evidence');
  for (const message of after.messages) for (const block of message.content || []) {
    if (block.type === 'tool_use') {
      const copy = { ...block }; delete copy.cache_control;
      if (JSON.stringify(copy) !== JSON.stringify(beforeCalls.get(block.id))) issues.push(`tool-call-mutation-${block.id}`);
      if (retainedCalls.has(block.id)) issues.push(`duplicated-call-${block.id}`);
      retainedCalls.set(block.id, true);
    }
    if (block.type === 'tool_result') {
      if (!retainedCalls.has(block.tool_use_id)) issues.push(`orphan-result-${block.tool_use_id}`);
      if (retainedResults.has(block.tool_use_id)) issues.push(`duplicated-result-${block.tool_use_id}`);
      retainedResults.add(block.tool_use_id);
      if (block.tool_use_id === 'current-evidence') {
        const copy = { ...block }; delete copy.cache_control;
        if (JSON.stringify(copy) !== JSON.stringify(currentEvidence)) issues.push('current-tool-result-mutation');
      }
    }
  }
  for (const id of retainedCalls.keys()) if (!retainedResults.has(id)) issues.push(`orphan-call-${id}`);
  if (!retainedCalls.has('current-evidence')) issues.push('current-tool-evidence');
  const latest = before.messages.at(-2).content[0];
  if (!after.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => JSON.stringify(block) === JSON.stringify(latest)))) issues.push('live-thinking');
  return issues;
}

export function mockVisualTransform({ body }) {
  const parsed = JSON.parse(new TextDecoder().decode(body));
  let compressedChars = 0;
  for (const message of parsed.messages) for (const block of message.content || []) {
    if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.startsWith('VISUAL_SLOT ')) {
      compressedChars += block.content.length;
      block.content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=' } }];
    }
  }
  return compressedChars ? { applied: true, body: new TextEncoder().encode(JSON.stringify(parsed)), info: { imageCount: 1, compressedChars, imageTokens: 1, imagePixels: 1 } } : { applied: false, reason: 'no-visual-fixture' };
}
