// The trigger against the REAL evaluator and a real database, so the semantics
// the rules already define are shown to survive the wiring rather than being
// re-asserted against a stub. Nothing here reimplements duration, cooldown or
// duplicate suppression; each test drives onStatsUpdate() and reads the alert
// rows the evaluator wrote.
//
// FIXTURE TIMES ARE RELATIVE TO THE REAL CLOCK. The production path passes no
// time window, so the evaluator's own default applies: the trailing
// NOTIFICATION_DEFAULT_DAYS = 30 measured from Date.now() at query time
// (notificationRuleQueries.mjs:38). A fixed calendar fixture would fall outside
// that window and read as no evidence, which is exactly what this file must not
// silently assert. The throttle clock passed to onStatsUpdate() is separate and
// stays synthetic.
//
// The emitter is mocked and the only I/O is the temp SQLite file plus the
// analytics worker thread that reads it. Zero network, zero provider traffic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repos/usageRepo.js", () => ({ statsEmitter: new EventEmitter() }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: async () => [],
  isConnectionDegraded: () => false,
}));
vi.mock("@/lib/db/repos/requestStatsRepo.js", () => ({ getTrafficWindow: async () => null }));
vi.mock("@/lib/notifications/webhooks.js", () => ({
  emit: () => {},
  getNotificationsConfig: async () => ({ enabled: false, endpoints: [] }),
}));

const MINUTE = 60_000;
// Minute 0 of the fixture sits an hour in the past, so every sample lands inside
// the evaluator's default trailing window and before its default `end`.
let base;
const at = (minutes) => new Date(base + minutes * MINUTE).toISOString();

// Headroom at or below 10% held for 10 minutes, at most once an hour.
const RULE = {
  name: "Session quota low",
  conditionKind: "quota_risk",
  scopeKind: "connection",
  scopeId: "conn-1",
  threshold: 10,
  durationSeconds: 600,
  cooldownSeconds: 3600,
};

let tempDir;
let db;
let repo;
let watcher;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  base = Math.floor((Date.now() - 60 * MINUTE) / 1000) * 1000;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-trigger-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete globalThis._contextAnalytics;
  delete global.__notificationWatcher;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
  repo = await import("@/lib/db/repos/notificationRulesRepo.js");
  watcher = await import("@/lib/notifications/watcher.js");
});

afterEach(async () => {
  try {
    await globalThis._contextAnalytics?.client?.close();
  } catch {}
  delete globalThis._contextAnalytics;
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global.__notificationWatcher;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// One observed quota sample. remaining/limit gives the headroom percentage.
function observe(id, { minutes, remaining }) {
  db.run(
    `INSERT INTO quotaObservations(id, connectionId, provider, scope, source, observationKind,
       unit, remaining, "limit", percentage, observedAt, capturedAt, confidence)
     VALUES(?, 'conn-1', 'anthropic', 'session (5h)', 'headers', 'observed',
       'requests', ?, 100, NULL, ?, ?, 'fresh')`,
    [`obs-${id}`, remaining, at(minutes), at(minutes)],
  );
}

// Samples every two minutes, so the cadence-derived gap allowance never breaks
// the sustain on its own.
function series(values, { from = 0 } = {}) {
  values.forEach((remaining, index) =>
    observe(`${from}-${index}`, { minutes: from + index * 2, remaining }),
  );
}

// The throttle clocks onStatsUpdate() mutates. startedAt is the restart boundary
// handed to the evaluator; a day back means "nothing suppressed".
function state(overrides = {}) {
  return {
    lastRunAt: 0,
    running: false,
    degraded: new Map(),
    errorRateFiring: false,
    lastRuleRunAt: 0,
    ruleRunning: false,
    startedAt: at(-1440),
    ...overrides,
  };
}

const alerts = () => repo.listRuleEvents({});
const tick = 1_000_000;

describe("firing through the trigger", () => {
  it("fires when the condition has held for the full duration", async () => {
    // 5% headroom across 9 samples spanning 16 minutes, past the 10-minute
    // duration.
    series([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    await repo.createRule(RULE);

    await watcher.onStatsUpdate({ state: state(), now: tick });

    const fired = await alerts();
    expect(fired).toHaveLength(1);
    expect(fired[0].observedValue).toBe(5);
    expect(fired[0].breachStartedAt).toBe(at(0));
  });

  it("does not fire for a blip shorter than the duration", async () => {
    // Breaches at minutes 4 and 6 only, so 2 minutes of sustain against 10.
    series([50, 50, 5, 5, 50, 50, 50]);
    await repo.createRule(RULE);

    await watcher.onStatsUpdate({ state: state(), now: tick });

    expect(await alerts()).toHaveLength(0);
  });

  it("does not fire again inside the cooldown", async () => {
    series([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    const rule = await repo.createRule(RULE);
    await watcher.onStatsUpdate({ state: state(), now: tick });
    const [opened] = await alerts();
    expect(opened).toBeDefined();

    // Acknowledge, which frees the rule+scope slot the partial unique index
    // holds. Cooldown, not that index, is what has to keep the next scan quiet.
    await repo.acknowledgeEvent(opened.id);
    // More breaching evidence, still inside the 60-minute cooldown that started
    // at the firing.
    series([5, 5, 5, 5], { from: 18 });

    await watcher.onStatsUpdate({ state: state(), now: tick });

    const after = await alerts();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(opened.id);
    expect(after[0].ruleId).toBe(rule.id);
  });

  it("produces one alert when two triggers race", async () => {
    series([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    await repo.createRule(RULE);
    // Two scans on separate state snapshots, so the watcher's own in-flight
    // flag cannot be what serializes them. What keeps this to one row is the
    // partial unique index on (ruleId, scopeKey) WHERE outcome='firing'.
    await Promise.all([
      watcher.onStatsUpdate({ state: state(), now: tick }),
      watcher.onStatsUpdate({ state: state(), now: tick }),
    ]);

    expect(await alerts()).toHaveLength(1);
  });
});

describe("restart", () => {
  it("does not replay a condition that was already true before the process started", async () => {
    series([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    await repo.createRule(RULE);

    // The process started after the last of that evidence, so every firing the
    // evaluator can derive from it predates the boundary.
    await watcher.onStatsUpdate({ state: state({ startedAt: at(30) }), now: tick });

    expect(await alerts()).toHaveLength(0);
  });

  it("still alerts on a breach that keeps producing evidence after the restart", async () => {
    // Cooldown at its 60-second floor, because cooldown is what paces the
    // firings a sustained breach yields: with the 3600s cooldown above, a breach
    // running since before the restart produces its NEXT eligible firing one
    // cooldown after the last one, so the alert is delayed by up to that
    // cooldown rather than lost. Here the pacing is short enough to observe.
    series([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    await repo.createRule({ ...RULE, cooldownSeconds: 60 });
    // One more observation after the boundary, so the sustain reaches an instant
    // this process can honestly claim to have observed.
    series([5], { from: 18 });

    await watcher.onStatsUpdate({ state: state({ startedAt: at(17) }), now: tick });

    const fired = await alerts();
    expect(fired).toHaveLength(1);
    expect(fired[0].firedAt).toBe(at(18));
    // The alert is dated after the restart but still reports when the breach
    // actually began, which was before it.
    expect(fired[0].breachStartedAt).toBe(at(0));
  });
});
