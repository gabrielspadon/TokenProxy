/**
 * The routing key pins on the CACHE PREFIX, not on the session alone.
 *
 * Live production, 2026-09-06, last 4000 successful requests: sel=pin-hit 3975
 * against sel=win 25, so 99.4% of requests never reached the ranker, and the
 * whole load sat on five connections with the busiest taking 1702. The cause is
 * upstream of any ranking: Claude Code hands every subagent its parent's
 * session uuid (`x-claude-code-session-id`, and the `_session_<uuid>` inside
 * metadata.user_id), sessionAffinity is keyed by (sessionHash, model), and
 * sessionHash was sha256(providerId : sessionId) — so thirty concurrent agents
 * of one session shared ONE pin per model and queued on one account.
 *
 * Two properties have to hold together, and they pull in opposite directions:
 * different agents of one session must separate (or the pin still collapses),
 * and the turns of ONE agent must NOT separate (or the pin never hits, every
 * request re-primes the provider-side prompt cache, and sessionAffinity gains a
 * dead row per request).
 *
 * Mocked end to end: no provider call, no live DB, no quota spent.
 */
import { describe, expect, it } from 'vitest';
import { cachePrefixDigest } from '@/sse/services/cachePrefixDigest.js';

const EPHEMERAL = { type: 'ephemeral' };

// The shape Claude Code actually sends: a static harness block, then an
// environment block carrying the breakpoint, then the tools.
const systemFor = (agent) => [
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { type: 'text', text: `Agent: ${agent}. Environment: linux.`, cache_control: EPHEMERAL },
];

const bodyFor = (agent, turn) => ({
  model: 'claude-fable-5',
  system: systemFor(agent),
  tools: [{ name: 'Bash' }, { name: 'Read' }],
  messages: Array.from({ length: turn }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    // The last message of every turn carries a breakpoint too — that is the
    // one the digest must NOT see, and this fixture would catch it if it did.
    content: [{ type: 'text', text: `turn ${i}`, cache_control: EPHEMERAL }],
  })),
});

describe('cache-prefix routing key', () => {
  it('is stable across the turns of one agent', () => {
    const digests = [1, 2, 3, 4, 5, 12].map((t) => cachePrefixDigest(bodyFor('explorer', t)));
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('separates two subagents that inherit one session id', () => {
    expect(cachePrefixDigest(bodyFor('explorer', 3))).not.toBe(
      cachePrefixDigest(bodyFor('reviewer', 3))
    );
  });

  // Only reachable when the system carries no breakpoint of its own, because
  // the walk stops at the first one it meets. `system` is deliberately ahead of
  // `tools`: measured on the isolated instance, walking tools first collapsed
  // two subagents back onto ONE key, since Claude Code anchors its last tool
  // and hands every subagent the same tool list.
  it('separates agents that differ only in their tool set', () => {
    const plain = [{ type: 'text', text: 'no breakpoint here' }];
    const a = { system: plain, tools: [{ name: 'Bash', cache_control: EPHEMERAL }] };
    const b = { system: plain, tools: [{ name: 'Read', cache_control: EPHEMERAL }] };
    expect(cachePrefixDigest(a)).not.toBe(cachePrefixDigest(b));
  });

  it('reads the system block even when the tools carry a breakpoint too', () => {
    const tools = [{ name: 'Bash', cache_control: EPHEMERAL }];
    expect(cachePrefixDigest({ system: systemFor('explorer'), tools })).not.toBe(
      cachePrefixDigest({ system: systemFor('reviewer'), tools })
    );
  });

  // Byte-identical to the old key for everything that does not cache: the
  // OpenAI format has no cache_control at all, and neither does a plain client.
  it('returns the empty string when the body carries no breakpoint', () => {
    expect(cachePrefixDigest({ messages: [{ role: 'user', content: 'hi' }] })).toBe('');
    expect(cachePrefixDigest({ system: [{ type: 'text', text: 'plain' }] })).toBe('');
    expect(cachePrefixDigest(null)).toBe('');
    expect(cachePrefixDigest('a string')).toBe('');
  });

  // The message-level breakpoint moves every turn. Keying on it would give each
  // turn its own pin, which is worse than the collapse it replaces.
  it('ignores a breakpoint that only appears in messages', () => {
    expect(
      cachePrefixDigest({
        messages: [{ role: 'user', content: [{ type: 'text', cache_control: EPHEMERAL }] }],
      })
    ).toBe('');
  });

  // Everything AFTER the first breakpoint is outside the cached prefix, so it
  // must not move the key: a per-turn suffix block would defeat the stability
  // the first case asserts.
  it('stops at the first breakpoint and ignores what follows it', () => {
    const base = systemFor('x');
    expect(cachePrefixDigest({ system: [...base, { type: 'text', text: 'later' }] })).toBe(
      cachePrefixDigest({ system: [...base, { type: 'text', text: 'different' }] })
    );
  });

  it('never returns anything but a digest', () => {
    const secret = 'ssh-rsa AAAA-not-a-real-key gabriel@example.com';
    const out = cachePrefixDigest({
      system: [{ type: 'text', text: secret, cache_control: EPHEMERAL }],
    });
    expect(out).toMatch(/^[0-9a-f]{32}$/);
    expect(out).not.toContain('gabriel');
  });

  it('survives a body it cannot serialize instead of throwing', () => {
    const block = { type: 'text', cache_control: EPHEMERAL };
    block.self = block;
    expect(cachePrefixDigest({ system: [block] })).toBe('');
  });
});
