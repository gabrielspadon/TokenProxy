import { describe, it, expect } from 'vitest';
import { createLeaseRegistry } from '@/shared/utils/accountLease.js';
import { effectiveCapacity } from '@/shared/utils/accountCapacity.js';
import { selectAndReserve } from '@/sse/services/accountScheduler.js';

// RECONCILIATION.md "Workflow Contract", the clauses its Ownership Boundary
// table assigns to TokenProxy ("HTTP request admission | TokenProxy"):
//
//   "Only currently active children consume host admission and gateway
//    capacity."
//   "Fairness is enforced over active work. One large workflow cannot reserve
//    the host against other sessions merely because its plan names many future
//    agents."
//
// THIS IS NOT THE RETIRED `Workflow accounting` ACCEPTANCE ROW, and it is
// deliberately not mapped to it. That row tested HOST-level agent admission in
// ai-dotfiles, the reservation ledger kept by shared/bin/agent-admission.py
// against the routing.json `budgets` block, which commit 6c8e9ac1 removed and
// ai-dotfiles tests/routing-test.sh:172 keeps removed. It is retired with a
// receipt (gates/evidence/e1-acceptance-row-scope-6c8e9ac1.md), never
// re-pointed at a gateway check wearing its name.
//
// What follows is the GATEWAY side of the Workflow Contract, which is live, is
// TokenProxy's own, and had no test: the gateway takes one slot per ADMITTED
// REQUEST and none per DECLARED AGENT, so a plan naming many future agents
// holds nothing at all and another session is admitted while those waves remain
// unstarted.
//
// REAL MODULES. selectAndReserve, createLeaseRegistry and effectiveCapacity are
// the shipping ones; only persistence is faked, in memory, so nothing here
// opens a database or a socket and no completion is ever bought. Fake clock
// throughout: `now` is injected and nothing sleeps.

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const MODEL = 'claude-sonnet-4';

// The three numbers the source document names, used verbatim so a reader can
// match them against RECONCILIATION.md rather than against a rounded retelling.
const DECLARED_AGENTS = 180; // Workflow Contract: "20, 120, 180, or more"
const ACTIVE_BATCH = 8; // Workflow Contract: "Eight active children per workflow"
const WAVES = 5; // Workflow Contract: "and five semantic waves"

const w = (scope, remaining, limit, resetAt) => ({
  scope,
  remaining,
  limit,
  resetAt,
  observedAt: iso(0),
  confidence: 'fresh',
});

// Three healthy accounts of four slots each: twelve slots total, which is more
// than one active batch and far less than the declared 180. That gap is the
// whole point — a gateway that pre-reserved the declared total could not admit
// this workflow at all, and every assertion below would go red.
const CAPACITY_PER_ACCOUNT = 4;
const makeAccounts = () =>
  [
    { id: 'acct-a', priority: 1 },
    { id: 'acct-b', priority: 2 },
    { id: 'acct-c', priority: 3 },
  ].map((a) => ({
    ...a,
    maxConcurrent: CAPACITY_PER_ACCOUNT,
    windows: [w('session (5h)', 120, 300, iso(HOUR)), w('weekly (7d)', 4000, 5000, iso(6 * DAY))],
  }));

const TOTAL_SLOTS = 3 * CAPACITY_PER_ACCOUNT;

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
    capacityOf: (id) =>
      effectiveCapacity(accounts.find((a) => a.id === id) ?? null).limit,
  });

// One agent's one request. `extra` exists so a test can hand the scheduler a
// field it does not declare and prove the outcome is unchanged.
const dispatch = ({ registry, repos, accounts, sessionHash, extra = {} }) =>
  selectAndReserve({
    sessionHash,
    model: MODEL,
    accounts,
    now: NOW,
    registry,
    repos,
    ...extra,
  });

const admitted = (result) => !result.unavailable && Boolean(result.lease);
const heldTotal = (registry) =>
  Object.values(registry.snapshot()).reduce((sum, n) => sum + n, 0);

describe('Workflow Contract, gateway side: one slot per admitted request, none per declared agent', () => {
  it('a workflow declaring 180 agents and running a batch of 8 holds exactly 8 leases', () => {
    const accounts = makeAccounts();
    const registry = registryFor(accounts);
    const repos = fakeRepos();

    for (let i = 0; i < ACTIVE_BATCH; i += 1) {
      const r = dispatch({ registry, repos, accounts, sessionHash: `wf-1/agent-${i}` });
      expect(admitted(r)).toBe(true);
    }

    // The load-bearing comparison of this whole row: 8, not 180.
    expect(registry.inFlight()).toBe(ACTIVE_BATCH);
    expect(heldTotal(registry)).toBe(ACTIVE_BATCH);
    expect(registry.inFlight()).toBeLessThan(DECLARED_AGENTS);

    // Spread, not fill-first: a fresh pin goes to the account with the fewest
    // open leases, so one batch touches every account, drives none to its
    // ceiling, and stops at its own size.
    const snapshot = registry.snapshot();
    expect(Object.keys(snapshot)).toHaveLength(3);
    const held = Object.values(snapshot);
    for (const n of held) expect(n).toBeLessThan(CAPACITY_PER_ACCOUNT);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(1);
  });

  it('the declared lifetime total is not an input: declaring 180 and declaring 20 are identical', () => {
    // selectAndReserve has no parameter expressing a workflow's lifetime size,
    // and this test is what keeps that true. Wire one into the reservation path
    // and the two runs diverge on the first assertion.
    const run = (declared) => {
      const accounts = makeAccounts();
      const registry = registryFor(accounts);
      const repos = fakeRepos();
      const placements = [];
      for (let i = 0; i < ACTIVE_BATCH; i += 1) {
        const r = dispatch({
          registry,
          repos,
          accounts,
          sessionHash: `wf/agent-${i}`,
          extra: { declaredAgents: declared, workflowSize: declared, plannedWaves: WAVES },
        });
        placements.push(r.connection?.id ?? `unavailable:${r.reason}`);
      }
      return { placements, inFlight: registry.inFlight(), snapshot: registry.snapshot() };
    };

    const big = run(DECLARED_AGENTS);
    const small = run(20);

    expect(big.inFlight).toBe(small.inFlight);
    expect(big.snapshot).toEqual(small.snapshot);
    expect(big.placements).toEqual(small.placements);
    expect(big.inFlight).toBe(ACTIVE_BATCH);
  });

  it('another session acquires capacity while the future waves remain unstarted', () => {
    const accounts = makeAccounts();
    const registry = registryFor(accounts);
    const repos = fakeRepos();

    for (let i = 0; i < ACTIVE_BATCH; i += 1) {
      expect(admitted(dispatch({ registry, repos, accounts, sessionHash: `wf-1/agent-${i}` }))).toBe(
        true
      );
    }
    const workflowFootprint = registry.snapshot();

    // A different session, arriving with 172 of the workflow's agents still
    // unstarted. It is admitted, on the account carrying the fewest of the
    // batch's leases.
    const lightest = Math.min(...Object.values(workflowFootprint));
    const foreign = dispatch({ registry, repos, accounts, sessionHash: 'other-session' });
    expect(admitted(foreign)).toBe(true);
    expect(foreign.reason).toBe('first-pin');
    expect(workflowFootprint[foreign.connection.id] ?? 0).toBe(lightest);
    expect(registry.inFlight()).toBe(ACTIVE_BATCH + 1);
    expect(registry.inFlight(foreign.connection.id)).toBe(lightest + 1);
  });

  it('five waves of eight: peak concurrency stays at the batch while 40 requests are served', () => {
    const accounts = makeAccounts();
    const registry = registryFor(accounts);
    const repos = fakeRepos();

    let served = 0;
    let peak = 0;
    for (let wave = 0; wave < WAVES; wave += 1) {
      const leases = [];
      for (let i = 0; i < ACTIVE_BATCH; i += 1) {
        const r = dispatch({
          registry,
          repos,
          accounts,
          sessionHash: `wf-1/wave-${wave}/agent-${i}`,
        });
        expect(admitted(r)).toBe(true);
        leases.push(r.lease);
        served += 1;
      }
      peak = Math.max(peak, registry.inFlight());
      for (const lease of leases) expect(registry.release(lease)).toBe(true);
      expect(registry.inFlight()).toBe(0);
    }

    expect(served).toBe(WAVES * ACTIVE_BATCH);
    expect(peak).toBe(ACTIVE_BATCH);
    // Fewer slots exist than the workflow declares agents, and the workflow
    // still completed: proof the declaration never became a reservation.
    expect(TOTAL_SLOTS).toBeLessThan(DECLARED_AGENTS);
    // No leaked lease. An empty snapshot IS the assertion.
    expect(registry.snapshot()).toEqual({});
  });

  it('a saturated host makes the next child WAIT with a retry hint; it never evicts a live session', () => {
    const accounts = makeAccounts();
    const registry = registryFor(accounts);
    const repos = fakeRepos();

    const foreign = dispatch({ registry, repos, accounts, sessionHash: 'other-session' });
    expect(admitted(foreign)).toBe(true);

    // Fill every remaining slot with workflow children.
    for (let i = 0; i < TOTAL_SLOTS - 1; i += 1) {
      expect(admitted(dispatch({ registry, repos, accounts, sessionHash: `wf-1/agent-${i}` }))).toBe(
        true
      );
    }
    expect(registry.inFlight()).toBe(TOTAL_SLOTS);

    const overflow = dispatch({ registry, repos, accounts, sessionHash: 'wf-1/agent-overflow' });
    expect(overflow.unavailable).toBe(true);
    expect(overflow.reason).toBe('at-capacity');
    expect(overflow.retryAfter).toBeGreaterThan(0);
    expect(overflow.lease).toBeUndefined();

    // The refusal took nothing and displaced nobody.
    expect(registry.inFlight()).toBe(TOTAL_SLOTS);
    expect(registry.inFlight(foreign.connection.id)).toBeGreaterThan(0);
    expect(registry.release(foreign.lease)).toBe(true);
  });

  it('no account is ever admitted past its own configured ceiling', () => {
    const accounts = makeAccounts();
    const registry = registryFor(accounts);
    const repos = fakeRepos();

    for (let i = 0; i < TOTAL_SLOTS + ACTIVE_BATCH; i += 1) {
      dispatch({ registry, repos, accounts, sessionHash: `wf-1/agent-${i}` });
    }

    for (const [id, n] of Object.entries(registry.snapshot())) {
      expect(n, `${id} over its ceiling`).toBeLessThanOrEqual(CAPACITY_PER_ACCOUNT);
    }
    expect(registry.inFlight()).toBe(TOTAL_SLOTS);
  });
});
