import { createHash } from 'node:crypto';
import { resolveSessionIdentity } from 'open-sse/utils/sessionManager.js';
import { cachePrefixDigest } from './cachePrefixDigest.js';

// Breakpoints move each turn; they are not conversation identity.
const stableJson = (value) => JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item);

/** Resolve routing identity before choosing an account, without raw data persistence. */
export function resolveRoutingSessionHash(options, providerId) {
  const headers = new Headers(options?.clientHeaders || {});
  // This identifies a request, so treating it as a session repins each turn.
  headers.delete('x-client-request-id');
  const body = options?.clientBody || {};
  // The engine owns client identity parsing. Exclude assistant history from
  // that resolver so its turn-two fallback cannot replace our initial anchor.
  const args = { headers: Object.fromEntries(headers), body: { ...body, messages: [], input: [] }, scope: providerId };
  const resolved = resolveSessionIdentity(args);
  const sessionId = !resolved.ephemeral && resolved.sessionId === resolveSessionIdentity(args).sessionId
    ? resolved.sessionId : null;
  const client = options?.clientApiKey || headers.get('authorization') || headers.get('x-api-key')
    || headers.get('x-goog-api-key') || '';
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const firstUser = messages.find((message) => message?.role === 'user');
  // Anonymous clients need no new field. Their first user content survives
  // appended history, unlike the old assistant-text fallback, which appeared
  // only on turn two. Identical evidence necessarily shares this locality key.
  const anchor = sessionId ? null : firstUser?.content ?? body.prompt
    ?? (typeof body.input === 'string' ? body.input : null);
  const identity = sessionId || stableJson([body.system ?? null, body.tools ?? null, anchor]);
  return createHash('sha256')
    .update(stableJson([providerId, client, identity, cachePrefixDigest(body)]))
    .digest('hex').slice(0, 32);
}
