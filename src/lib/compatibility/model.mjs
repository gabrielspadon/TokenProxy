export const OWNER_SCOPE = 'installation-operator';
export const IMPLEMENTATION_VERSION = 'local-compatibility-v1';
export const LIMITS = Object.freeze({ definitionBytes: 65536, resultBytes: 524288, events: 256, depth: 24, fixtureIds: 200, revisions: 2000, runs: 2000, queued: 4, timeoutMs: 3000 });
export const FORMATS = ['openai', 'claude', 'gemini', 'openai-responses'];
export const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted'];
export class CompatibilityError extends Error {
  constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw new CompatibilityError('A valid record ID is required.');
  return value;
}
export function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new CompatibilityError('The exact fixture revision is required.');
  return value;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompatibilityError(`${label} must be a JSON object.`);
}
function keys(value, allowed) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new CompatibilityError('Unknown fields are not accepted.'); }
export function boundedJson(value, maxBytes) {
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).byteLength > maxBytes) throw new CompatibilityError('The complete value exceeds the retained byte limit. Narrow this fixture; nothing was truncated.', 413, 'too_large');
  return json;
}
export function validateDefinition(input) {
  object(input, 'Fixture definition');
  keys(input, ['version', 'origin', 'suitable', 'operation', 'sourceFormat', 'targetFormat', 'model', 'payload']);
  if (input.version !== 1 || !['synthetic', 'operator-submitted'].includes(input.origin) || input.suitable !== true) throw new CompatibilityError('Confirm this is synthetic or suitable operator-submitted test content with no credentials or private production traffic.');
  if (!['request', 'stream'].includes(input.operation) || !FORMATS.includes(input.sourceFormat) || !FORMATS.includes(input.targetFormat)) throw new CompatibilityError('Choose a supported local operation and format.');
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160 || /[\x00-\x1f]/.test(input.model)) throw new CompatibilityError('A model label of1–160 characters is required. It does not select an account.');
  if (input.operation === 'request') object(input.payload, 'Request payload');
  else if (!Array.isArray(input.payload) || input.payload.length < 1 || input.payload.length > LIMITS.events || input.payload.some(event => !event || typeof event !== 'object' || Array.isArray(event))) throw new CompatibilityError('Stream fixtures require1–256 ordered JSON event objects. Flush is added once after the list.');
  const visit = (value, depth = 0) => {
    if (depth > LIMITS.depth) throw new CompatibilityError('Fixture nesting exceeds24 levels.');
    if (typeof value === 'string' && /(?:Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(value)) throw new CompatibilityError('A possible credential was found. Remove it before retaining this fixture.', 400, 'credential_content');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|client[-_]?secret|__proto__|constructor|prototype)$/i.test(key)) throw new CompatibilityError('Credential and prototype fields are not accepted in retained fixtures.', 400, 'credential_content');
      visit(child, depth + 1);
    }
  };
  visit(input.payload);
  boundedJson(input, LIMITS.definitionBytes);
  return structuredClone(input);
}
export function validateFixture(input, updating = false) {
  object(input, 'Fixture'); keys(input, updating ? ['name', 'definition', 'revision', 'archived'] : ['name', 'definition']);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120 || /[\x00-\x1f]/.test(input.name)) throw new CompatibilityError('A fixture name of1–120 characters is required.');
  if (updating) revision(input.revision);
  if (input.archived !== undefined && typeof input.archived !== 'boolean') throw new CompatibilityError('Archived must be a boolean.');
  return { name: input.name.trim(), definition: validateDefinition(input.definition), ...(updating ? { revision: input.revision, archived: input.archived === true } : {}) };
}
export function pagination(params) {
  const parse = (name, fallback, max) => { const raw = params.get(name); if (raw === null) return fallback; if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) throw new CompatibilityError(`Invalid ${name}.`); return Number(raw); };
  return { page: parse('page', 1, 10000), pageSize: parse('pageSize', 25, 100) };
}
