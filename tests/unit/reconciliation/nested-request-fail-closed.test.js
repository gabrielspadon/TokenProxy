import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { createLeaseRegistry } from '@/shared/utils/accountLease.js';
import { effectiveCapacity } from '@/shared/utils/accountCapacity.js';
import { selectAndReserve } from '@/sse/services/accountScheduler.js';
import { matchesAllowedModel } from '@/lib/db/repos/apiKeysRepo.js';

// RECONCILIATION.md "Workflow Contract": "Every nested call still passes normal
// lane, credential, and host-resource checks." The lane and credential checks
// and the request-admission check are TokenProxy's per the Ownership Boundary
// table; the depth ceiling around them is not.
//
// THIS IS NOT THE RETIRED `Nested delegation` ACCEPTANCE ROW, and it is
// deliberately not mapped to it. That row turned on "up to the configured
// depth", a harness number (`max_subagent_spawn_depth` in the routing.json
// `budgets` block, enforced by shared/bin/agent-admission.py). Commit 6c8e9ac1
// removed both and ai-dotfiles tests/routing-test.sh:172 keeps them removed, so
// the row is retired with a receipt
// (gates/evidence/e1-acceptance-row-scope-6c8e9ac1.md). Writing a depth ceiling
// into TokenProxy would invent a gateway limit the source document places at
// the edge, and scoring it under the retired row's name would be a false green.
//
// What follows is the gateway side, which is live and had no test:
//
//   1. NORMAL ROUTING. A descendant is admitted through the same
//      select-and-reserve transaction as its root, with no depth-aware branch,
//      no exemption and no discount: it costs exactly one slot like anything
//      else, and at the ceiling it waits like anything else.
//   2. FAIL CLOSED. A disallowed lane is refused with a 403 BEFORE any capacity
//      is taken, and a malformed identity takes no slot and frees no other
//      request's slot.
//
// REAL MODULES throughout. Fake clock, in-memory persistence, no socket, no
// provider, no completion bought.

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const MODEL = 'anthropic/claude-sonnet-4';

// A chain length, used as a fixture and never as an assertion: this file proves
// the SHAPE of a nested admission is the same at every depth. It asserts no
// ceiling, because the gateway has none and the harness one was withdrawn.
const CHAIN_DEPTH = 5;

const w = (scope, remaining, limit, resetAt) => ({
  scope,
  remaining,
  limit,
  resetAt,
  observedAt: iso(0),
  confidence: 'fresh',
});

const account = (id, priority, maxConcurrent) => ({
  id,
  priority,
  maxConcurrent,
  windows: [w('session (5h)', 120, 300, iso(HOUR)), w('weekly (7d)', 4000, 5000, iso(6 * DAY))],
});

function fakeRepos() {
  const pins = new Map();
  const switches = [];
  const key = (sessionHash, model) => `${sessionHash} ${model}`;
  return {
    switches,
    pins,
    transaction: (fn) => fn(),
    getPin: ({ sessionHash, model }) => pins.get(key(sessionHash, model)) ?? null,
    setPin: ({ sessionHash, model, connectionId, at }) =>
      pins.set(key(sessionHash, model), { connectionId, at }),
    touchPin: () => {},
    recordSwitch: (receipt) => switches.push(receipt),
  };
}

const registryFor = (accounts) =>
  createLeaseRegistry({
    capacityOf: (id) => effectiveCapacity(accounts.find((a) => a.id === id) ?? null).limit,
  });

const dispatch = ({ registry, repos, accounts, sessionHash, model = MODEL }) =>
  selectAndReserve({ sessionHash, model, accounts, now: NOW, registry, repos });

// "root", "root/c1", "root/c1/c2", ... one identity per generation.
const chainIdentities = (depth) => {
  const out = [];
  let path = 'root';
  out.push(path);
  for (let d = 1; d < depth; d += 1) {
    path = `${path}/c${d}`;
    out.push(path);
  }
  return out;
};

describe('Nested requests traverse normal routing, with no depth-aware branch', () => {
  it('every generation of a five-deep chain is admitted by the same path as its root', () => {
    const accounts = [account('acct-a', 1, 8), account('acct-b', 2, 8)];
    const registry = registryFor(accounts);
    const repos = fakeRepos();

    const results = chainIdentities(CHAIN_DEPTH).map((sessionHash) =>
      dispatch({ registry, repos, accounts, sessionHash })
    );

    expect(results).toHaveLength(CHAIN_DEPTH);
    for (const r of results) {
      expect(r.unavailable).toBeUndefined();
      expect(r.lease).toBeTruthy();
      expect(r.reason).toBe('first-pin');
    }

    // The deepest descendant's admission is the same SHAPE as the root's. A
    // depth-aware branch that returned a different envelope, or skipped the
    // receipt, breaks here.
    const root = results[0];
    const deepest = results[CHAIN_DEPTH - 1];
    expect(Object.keys(deepest).sort()).toEqual(Object.keys(root).sort());
    expect(Boolean(deepest.receipt)).toBe(Boolean(root.receipt));

    // Every generation got its own pin, written like any other first pin.
    expect(repos.pins.size).toBe(CHAIN_DEPTH);
  });

  it('depth buys no discount: a child at depth 5 costs exactly one slot, like the root', () => {
    const accounts = [account('acct-a', 1, 8), account('acct-b', 2, 8)];
    const registry = registryFor(accounts);
    const repos = fakeRepos();

    const perGeneration = [];
    for (const sessionHash of chainIdentities(CHAIN_DEPTH)) {
      const before = registry.inFlight();
      dispatch({ registry, repos, accounts, sessionHash });
      perGeneration.push(registry.inFlight() - before);
    }

    expect(perGeneration).toEqual(Array(CHAIN_DEPTH).fill(1));
    expect(registry.inFlight()).toBe(CHAIN_DEPTH);
  });

  it('a nested child is not exempt from host-resource checks: at the ceiling it waits', () => {
    // One account, two slots. The root and its first child fill them; the
    // grandchild is a WAIT with a retry hint, not an exemption and not a
    // silent over-admission.
    const accounts = [account('acct-solo', 1, 2)];
    const registry = registryFor(accounts);
    const repos = fakeRepos();
    const [root, child, grandchild] = chainIdentities(3);

    expect(dispatch({ registry, repos, accounts, sessionHash: root }).lease).toBeTruthy();
    expect(dispatch({ registry, repos, accounts, sessionHash: child }).lease).toBeTruthy();

    const refused = dispatch({ registry, repos, accounts, sessionHash: grandchild });
    expect(refused.unavailable).toBe(true);
    expect(refused.reason).toBe('at-capacity');
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(registry.inFlight()).toBe(2);
  });
});

describe('A disallowed lane or a malformed identity fails closed before capacity is taken', () => {
  it('refuseDisallowedModel answers 403 when a child asks outside its key allowlist', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db/repos/apiKeysRepo.js', () => ({
      isModelAllowed: async (_key, model) => matchesAllowedModel(['anthropic/*'], model),
    }));
    const { refuseDisallowedModel: refuse } = await import('@/sse/services/modelAccess.js');

    // The lane the child is entitled to.
    expect(await refuse('sk-fake-testonly-child', 'anthropic/claude-sonnet-4', null)).toBeNull();

    // A lane it is not. Refused, not downgraded and not silently rerouted.
    const barred = await refuse('sk-fake-testonly-child', 'openai/gpt-4o', null);
    expect(barred?.status).toBe(403);

    vi.doUnmock('@/lib/db/repos/apiKeysRepo.js');
    vi.resetModules();
  });

  it('the lane check runs BEFORE account selection, so a refused child leaks no capacity', () => {
    // Ordering is the property, and it is read from the shipping handler rather
    // than restated by a mock. Refuse first, then reserve: swap them and a
    // forbidden request takes a slot on the way to its own 403.
    const chat = fs.readFileSync(
      fileURLToPath(new URL('../../../src/sse/handlers/chat.js', import.meta.url)),
      'utf8'
    );
    const refusalAt = chat.indexOf('await prepare(() => refuseDisallowedModel(');
    const selectionAt = chat.indexOf('() => getProviderCredentials(');

    expect(refusalAt, 'refuseDisallowedModel call site not found').toBeGreaterThan(-1);
    expect(selectionAt, 'getProviderCredentials call site not found').toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(selectionAt);
  });

  it('a malformed model identity fails closed rather than matching by guess', () => {
    // "" and null name no lane at all. An allowlist that answered true for them
    // would open every scoped key.
    expect(matchesAllowedModel(['anthropic/*'], '')).toBe(false);
    expect(matchesAllowedModel(['anthropic/*'], null)).toBe(false);
    expect(matchesAllowedModel(['anthropic/*'], undefined)).toBe(false);
    // An unqualified name names no provider; guessing one at an authorization
    // boundary is how a scope leaks.
    expect(matchesAllowedModel(['anthropic/*'], 'claude-sonnet-4')).toBe(false);
    // A lookalike provider prefix is a different provider.
    expect(matchesAllowedModel(['anthropic/*'], 'anthropic-compatible-xyz/claude-sonnet-4')).toBe(
      false
    );
  });

  it('a malformed connection identity takes no slot, and a forged lease frees nobody', () => {
    const accounts = [account('acct-a', 1, 2)];
    const registry = registryFor(accounts);

    for (const bad of ['', null, undefined, 0, {}]) {
      expect(registry.reserve(bad)).toBeNull();
    }
    expect(registry.inFlight()).toBe(0);

    const real = registry.reserve('acct-a');
    expect(real).toBeTruthy();
    // A fabricated lease, and one carrying a plausible seq, free nothing.
    expect(registry.release({ connectionId: 'acct-a', seq: real.seq })).toBe(false);
    expect(registry.release({ connectionId: 'acct-a' })).toBe(false);
    expect(registry.release(null)).toBe(false);
    expect(registry.inFlight('acct-a')).toBe(1);
    expect(registry.release(real)).toBe(true);
  });

  it('an unknown identity with no eligible account is refused, never admitted by default', () => {
    const registry = registryFor([]);
    const repos = fakeRepos();
    const nothing = dispatch({ registry, repos, accounts: [], sessionHash: 'root/c1/c2' });
    expect(nothing.unavailable).toBe(true);
    expect(nothing.reason).toBe('no-accounts');
    expect(registry.inFlight()).toBe(0);
  });
});
