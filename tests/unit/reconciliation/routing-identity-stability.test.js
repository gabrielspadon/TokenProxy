import { describe, expect, it } from 'vitest';
import { resolveRoutingSessionHash } from '@/sse/services/routingIdentity.js';

const user = { role: 'user', content: 'Initial task for this agent' };
const hash = (body, headers = {}) => resolveRoutingSessionHash({ clientBody: body, clientHeaders: headers }, 'claude');

describe('agent routing identity', () => {
  it('keeps an anonymous conversation stable when assistant history appears', () => {
    const first = hash({ messages: [user] });
    const next = hash({ messages: [user, { role: 'assistant', content: 'a'.repeat(100) }, { role: 'user', content: 'Next turn' }] });
    expect(next).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
  });
  it('separates anonymous initial tasks and authenticated clients', () => {
    expect(hash({ messages: [user] })).not.toBe(hash({ messages: [{ ...user, content: 'Different task' }] }));
    expect(hash({ messages: [user] }, { 'x-api-key': 'fake-client-one' })).not.toBe(hash({ messages: [user] }, { 'x-api-key': 'fake-client-two' }));
  });
  it('ignores per-request ids and moving cache breakpoints', () => {
    const first = hash({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Task', cache_control: { type: 'ephemeral' } }] }] }, { 'x-client-request-id': 'one' });
    const next = hash({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Task' }] }, { role: 'assistant', content: 'Answer' }] }, { 'x-client-request-id': 'two' });
    expect(next).toBe(first);
  });
  it('uses explicit session identity when history is compacted', () => {
    const headers = { 'x-session-id': 'same-agent' };
    expect(hash({ messages: [user] }, headers)).toBe(hash({ messages: [{ ...user, content: 'Compacted' }] }, headers));
  });
  it('separates inherited sessions when agent cache prefixes differ', () => {
    const headers = { 'x-claude-code-session-id': 'parent-session' };
    const body = (text) => ({ system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }], messages: [user] });
    expect(hash(body('agent one'), headers)).not.toBe(hash(body('agent two'), headers));
    expect(hash(body('agent one'), headers)).toBe(hash(body('agent one'), headers));
  });
});
