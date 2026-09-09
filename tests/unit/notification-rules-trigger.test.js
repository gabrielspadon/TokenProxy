// The trigger. evaluateEnabledRules() is implemented and tested elsewhere; what
// these tests establish is that something CALLS it, on the right cadence, with a
// failure mode that cannot reach a routed request or wedge the next scan.
//
// The clock and the emitter are both injected. Zero network calls and zero
// provider traffic: the evaluator itself is a stub here, because these tests are
// about the wiring, and the semantics it wraps (duration, cooldown, the unique
// index) are asserted against the real evaluator in
// notification-rules-evaluate.test.js and notification-rules-repo.test.js.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statsEmitter = new EventEmitter();
statsEmitter.setMaxListeners(50);

vi.mock("@/lib/db/repos/usageRepo.js", () => ({ statsEmitter }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: async () => [],
  isConnectionDegraded: () => false,
}));
vi.mock("@/lib/db/repos/requestStatsRepo.js", () => ({ getTrafficWindow: async () => null }));
vi.mock("@/lib/notifications/webhooks.js", () => ({
  emit: () => {},
  getNotificationsConfig: async () => ({ enabled: false, endpoints: [] }),
}));

const { evaluateRules, onStatsUpdate, ensureWatcher } = await import(
  "@/lib/notifications/watcher.js"
);

const RULE_INTERVAL_MS = 300000;
const START = "2026-01-01T00:00:00.000Z";

// A watcher state snapshot, as onStatsUpdate() mutates it. Same shape as the
// module-level singleton; injected so each test starts from a known clock.
function freshState(overrides = {}) {
  return {
    subscribed: false,
    lastRunAt: 0,
    running: false,
    degraded: new Map(),
    errorRateFiring: false,
    lastRuleRunAt: 0,
    ruleRunning: false,
    startedAt: START,
    ...overrides,
  };
}

const noFirings = { evaluated: 1, fired: 0, events: [] };

let rules;
beforeEach(() => {
  rules = vi.fn(async () => noFirings);
});

describe("the trigger", () => {
  it("evaluates rules when the traffic tick fires", async () => {
    const state = freshState();
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    await onStatsUpdate({ state, now, rules });

    expect(rules).toHaveBeenCalledTimes(1);
    expect(state.lastRuleRunAt).toBe(now);
  });

  it("keeps one traffic listener alongside the idle trigger", async () => {
    // ensureWatcher() installs exactly one listener for both scans; the emitter
    // is a process-wide singleton with a 50-listener cap that the dashboard's
    // usage stream already spends two of per connected client.
    const before = statsEmitter.listenerCount("update");
    expect(ensureWatcher()).toBe(true);
    expect(statsEmitter.listenerCount("update") - before).toBe(1);
    // Idempotent: a second call adds nothing.
    expect(ensureWatcher()).toBe(false);
    expect(statsEmitter.listenerCount("update") - before).toBe(1);
  });

  it("pays one scan per interval, not one per traffic tick", async () => {
    const state = freshState();
    const first = Date.parse("2026-01-01T00:10:00.000Z");
    await onStatsUpdate({ state, now: first, rules });
    // Ten more ticks inside the interval — a busy gateway emits "update" as
    // often as every 150ms.
    for (let tick = 1; tick <= 10; tick += 1) {
      await onStatsUpdate({ state, now: first + tick * 1000, rules });
    }
    expect(rules).toHaveBeenCalledTimes(1);

    await onStatsUpdate({ state, now: first + RULE_INTERVAL_MS, rules });
    expect(rules).toHaveBeenCalledTimes(2);
  });

  it("does not run concurrently with itself", async () => {
    const state = freshState();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await held;
      return noFirings;
    });

    const inFlight = onStatsUpdate({
      state,
      now: Date.parse("2026-01-01T00:10:00.000Z"),
      rules: slow,
    });
    // A tick a full interval later, while the first scan is still on the worker.
    await onStatsUpdate({
      state,
      now: Date.parse("2026-01-01T00:20:00.000Z"),
      rules: slow,
    });
    expect(slow).toHaveBeenCalledTimes(1);

    release();
    await inFlight;
    expect(state.ruleRunning).toBe(false);
    // Only once the first has landed does the next tick get through.
    await onStatsUpdate({ state, now: Date.parse("2026-01-01T00:30:00.000Z"), rules: slow });
    expect(slow).toHaveBeenCalledTimes(2);
  });
});

describe("fail-open", () => {
  it("swallows an evaluation throw instead of propagating it", async () => {
    const state = freshState();
    const thrower = vi.fn(async () => {
      throw new Error("analytics worker unavailable");
    });
    const result = await evaluateRules({ state, rules: thrower });
    expect(result.skipped).toBe("error");
    expect(result.fired).toBe(0);
  });

  it("does not wedge the throttle when an evaluation throws", async () => {
    const state = freshState();
    const thrower = vi.fn(async () => {
      throw new Error("analytics worker unavailable");
    });
    const first = Date.parse("2026-01-01T00:10:00.000Z");

    // The throw must not escape the statsEmitter handler either — that handler
    // runs on a listener the request path's own writes ultimately trigger.
    await expect(onStatsUpdate({ state, now: first, rules: thrower })).resolves.toBeUndefined();
    expect(state.ruleRunning).toBe(false);

    await onStatsUpdate({ state, now: first + RULE_INTERVAL_MS, rules });
    expect(rules).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection scan running when the rule scan throws", async () => {
    // Two throttles, one listener: neither scan may take the other down.
    const state = freshState();
    const thrower = async () => {
      throw new Error("analytics worker unavailable");
    };
    await onStatsUpdate({ state, now: Date.parse("2026-01-01T00:10:00.000Z"), rules: thrower });
    // The connection scan stamped its own clock and cleared its own flag.
    expect(state.lastRunAt).toBe(Date.parse("2026-01-01T00:10:00.000Z"));
    expect(state.running).toBe(false);
  });
});

describe("restart", () => {
  it("hands the evaluator the process start instant as its replay boundary", async () => {
    const state = freshState({ startedAt: "2026-02-01T12:00:00.000Z" });
    await onStatsUpdate({ state, now: Date.parse("2026-02-01T12:05:00.000Z"), rules });
    expect(rules).toHaveBeenCalledWith({ notBefore: "2026-02-01T12:00:00.000Z" });
  });

  it("passes no time window, so a long duration keeps the history it needs", async () => {
    const state = freshState();
    await evaluateRules({ state, rules });
    const [args] = rules.mock.calls[0];
    expect(args.start).toBeUndefined();
    expect(args.end).toBeUndefined();
  });
});
