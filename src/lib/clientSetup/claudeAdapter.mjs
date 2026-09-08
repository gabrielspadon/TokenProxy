import { isAbsolute } from 'node:path';

export function eventEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use the gateway origin without credentials, query or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS or loopback HTTP');
  return new URL('/api/v1/context/events', url).href;
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function claudeClientSettings(current, { scriptPath, nodePath, baseUrl, clientId, autoCompactWindow, model, contextTokens, capabilityContextTokens }) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Settings must be an object');
  if (current.env !== undefined && (!current.env || typeof current.env !== 'object' || Array.isArray(current.env))) throw new Error('Existing environment settings are malformed');
  if (![scriptPath, nodePath].every(p => typeof p === 'string' && isAbsolute(p) && !/[\r\n\0]/.test(p))) throw new Error('Use absolute executable and adapter paths');
  if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 128 || /[\r\n\0]/.test(clientId)) throw new Error('An explicit client identity is required');
  eventEndpoint(baseUrl);
  if (autoCompactWindow !== undefined && (!Number.isSafeInteger(autoCompactWindow) || autoCompactWindow < 100000 || autoCompactWindow > 1000000)) throw new Error('autoCompactWindow must be 100000 through 1000000 tokens');
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\s\0]/.test(model) || ![contextTokens, capabilityContextTokens].every(value => Number.isSafeInteger(value) && value >= 1000000))) throw new Error('An explicit 1m model selection requires both exact gateway and capability declarations of at least 1000000 tokens');
  if (current.hooks !== undefined && (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks))) throw new Error('Existing hooks are malformed');
  const hooks = { ...current.hooks }, command = `${quote(nodePath)} ${quote(scriptPath)} hook`;
  const previous = hooks.PostCompact ?? [];
  if (!Array.isArray(previous)) throw new Error('Existing PostCompact hooks are malformed');
  hooks.PostCompact = previous.some(group => group.hooks?.some(hook => hook.type === 'command' && hook.command === command)) ? previous : [...previous, { hooks: [{ type: 'command', command, timeout: 5 }] }];
  return { ...current, ...(model === undefined ? {} : { model: /\[1m\]$/i.test(model) ? model : `${model}[1m]` }), ...(autoCompactWindow === undefined ? {} : { autoCompactWindow }), env: { ...current.env, TOKENPROXY_BASE_URL: new URL(baseUrl).origin, TOKENPROXY_CLIENT_ID: clientId }, hooks };
}
