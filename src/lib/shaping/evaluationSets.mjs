import { createHash } from 'node:crypto';

export const EVALUATION_LIMITS = Object.freeze({ fixtures: 64, bodyBytes: 1024 * 1024, setBytes: 8 * 1024 * 1024 });
export function evaluationSetHash(fixtures) {
  return createHash('sha256').update(JSON.stringify(fixtures)).digest('hex');
}
function refuse(code) { throw Object.assign(new Error(code), { code, status: 422 }); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value);

export function normalizeEvaluationFixtures(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length < 1 || fixtures.length > EVALUATION_LIMITS.fixtures) refuse('evaluation_case_count_invalid');
  let encoded;
  try { encoded = JSON.stringify(fixtures); } catch { refuse('evaluation_input_invalid'); }
  if (Buffer.byteLength(encoded) > EVALUATION_LIMITS.setBytes) refuse('evaluation_set_too_large');
  const normalized = JSON.parse(encoded), ids = new Set();
  for (const item of normalized) {
    if (!object(item) || Object.keys(item).some(key => !['id', 'contextWindow', 'body', 'description'].includes(key)) || !identifier(item.id) || ids.has(item.id)) refuse('evaluation_case_invalid');
    ids.add(item.id);
    if (!Number.isSafeInteger(item.contextWindow) || item.contextWindow < 1 || item.contextWindow > 10_000_000) refuse('evaluation_context_window_invalid');
    if (item.description != null && (typeof item.description !== 'string' || item.description.length > 240)) refuse('evaluation_description_invalid');
    const body = item.body;
    if (!object(body) || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 2000 ||
      ['input', 'contents', 'headers', 'credentials', 'apiKey', 'authorization'].some(key => Object.hasOwn(body, key))) refuse('evaluation_format_unsupported');
    if (Buffer.byteLength(JSON.stringify(body)) > EVALUATION_LIMITS.bodyBytes) refuse('evaluation_case_too_large');
    if (body.messages.some(message => !object(message) || !['user', 'assistant'].includes(message.role) ||
      !(typeof message.content === 'string' || Array.isArray(message.content))) || !body.messages.some(message => message.role === 'user')) refuse('evaluation_messages_invalid');
    if (body.messages.some(message => Array.isArray(message.content) && message.content.some(block => !object(block) || typeof block.type !== 'string' ||
      (block.type === 'text' && typeof block.text !== 'string') ||
      (block.type === 'tool_use' && (typeof block.id !== 'string' || typeof block.name !== 'string' || !object(block.input))) ||
      (block.type === 'tool_result' && typeof block.tool_use_id !== 'string')))) refuse('evaluation_blocks_invalid');
    if (body.tools != null && (!Array.isArray(body.tools) || body.tools.some(tool => !object(tool) || typeof tool.name !== 'string' || !object(tool.input_schema)))) refuse('evaluation_tools_invalid');
  }
  return normalized;
}
