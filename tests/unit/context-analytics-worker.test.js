import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../../src/lib/db/driver.js";
import { DATA_FILE } from "../../src/lib/db/paths.js";
import { saveRequestStats } from "../../src/lib/db/repos/requestStatsRepo.js";
import { getContextOverview, getContextSession } from "../../src/lib/db/repos/contextRepo.js";
import { parseContextFilter, readContextOverview, validateAnalyticsQuery } from "../../src/lib/db/analytics/contextQueries.mjs";
import { openAnalyticsReadOnly } from "../../src/lib/db/analytics/readOnly.mjs";
import { createContextAnalyticsClient, ContextAnalyticsError } from "../../src/lib/db/analytics/client.js";

let db;
beforeAll(async () => {
  db = await getAdapter();
  await saveRequestStats({ id: "worker-fixture", timestamp: "2026-09-06T12:00:00.000Z", provider: "fixture", model: "model", connectionId: "account", status: "success",
    tokens: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 0 },
    contextTelemetry: { sessionHash: "a".repeat(32), stages: [{ stage: "rtk", in: 100, out: 90 }] } });
});
afterAll(async () => { await globalThis._contextAnalytics?.client.close(); });

describe("read-only Context analytics", () => {
  it("returns identical filtered totals and explicit projection/freshness", async () => {
    const filter = { connectionId: "account", view: "summary", from: "2026-09-06T00:00:00.000Z" };
    const expected = readContextOverview(db, filter);
    const result = await getContextOverview(filter);
    expect(result.summary).toEqual(expected.summary);
    expect(result.view).toBe("summary");
    for (const key of ["sessions", "stages", "projects", "dimensions", "pagination"]) expect(result).not.toHaveProperty(key);
    expect(result.freshness).toMatchObject({ source: "committed-sqlite", persistedAt: null });
    expect(Date.parse(result.freshness.snapshotCompletedAt)).toBeGreaterThanOrEqual(Date.parse(result.freshness.snapshotStartedAt));
    const queried = [];
    readContextOverview({ get: (sql, args) => { queried.push(sql); return db.get(sql, args); }, all: () => { throw new Error("Unneeded grouped query"); } }, filter);
    expect(queried.every((sql) => !sql.includes("contextStages"))).toBe(true);
  });
  it("invalidates the same completed projection on committed WAL writes", async () => {
    const filter = { provider: "version-fixture", view: "summary" };
    expect((await getContextOverview(filter)).recording.totalRetainedAttempts).toBe(0);
    db.run("INSERT INTO requestStats(id,timestamp,provider) VALUES(?,?,?)", ["version-fixture", "2026-09-08T12:00:00.000Z", "version-fixture"]);
    expect((await getContextOverview(filter)).recording.totalRetainedAttempts).toBe(1);
    db.run("DELETE FROM requestStats WHERE id=?", ["version-fixture"]);
    expect((await getContextOverview(filter)).recording.totalRetainedAttempts).toBe(0);
  });
  it("holds a consistent WAL snapshot while the writer continues and rejects mutation", async () => {
    const reader = await openAnalyticsReadOnly(DATA_FILE, db.driver);
    try {
      reader.exec("BEGIN");
      const before = reader.get("SELECT COUNT(*) AS n FROM requestStats").n;
      db.run("INSERT INTO requestStats(id,timestamp) VALUES(?,?)", ["concurrent", "2026-09-06T13:00:00.000Z"]);
      expect(reader.get("SELECT COUNT(*) AS n FROM requestStats").n).toBe(before);
      expect(() => reader.exec("DELETE FROM requestStats")).toThrow();
      reader.exec("ROLLBACK");
      expect(reader.get("SELECT COUNT(*) AS n FROM requestStats").n).toBe(before + 1);
    } finally { reader.close(); }
  });
  it("reports filtered unattributed coverage without manufacturing sessions", async () => {
    db.run("INSERT INTO requestStats(id,timestamp,provider) VALUES(?,?,?)", ["history", "2026-09-05T12:00:00.000Z", "legacy"]);
    db.run("INSERT INTO requestStats(id,timestamp,provider,contextTelemetryError) VALUES(?,?,?,?)", ["rejected", "2026-09-05T13:00:00.000Z", "legacy", "invalid-metrics"]);
    const result = await getContextOverview({ provider: "legacy", view: "summary" });
    expect(result.recording).toMatchObject({ totalRetainedAttempts: 2, attributedAttempts: 0, rejectedAttempts: 1, unattributedAttempts: 1, scope: "filtered retained attempts" });
    expect(result.summary.sessions).toBe(0);
    expect((await getContextOverview({ provider: "legacy", from: "2026-09-06T00:00:00.000Z" })).recording.totalRetainedAttempts).toBe(0);
  });
  it("aggregates an entire long session into bounded buckets independent of turn pages", async () => {
    const sessionId = db.get("SELECT id FROM contextSessions LIMIT 1").id;
    db.transaction(() => {
      for (let i = 0; i < 300; i++) db.run(`INSERT INTO requestStats(id,timestamp,provider,contextSessionId,usageSource,usageInputPresent,promptTokens,bodyBeforeBytes,bodyAfterBytes,contextEstimate)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [`trend-${i}`, new Date(Date.UTC(2026,0,1)+i*86400000).toISOString(), "trend", sessionId, i%2 ? "estimated" : "provider", 1, 10, 100, 110, i]);
    });
    const first = await getContextSession(sessionId, { provider: "trend", pageSize: 1 });
    const second = await getContextSession(sessionId, { provider: "trend", pageSize: 1, page: 2 });
    expect(first.turns).toHaveLength(1); expect(first.trend).toEqual(second.trend);
    expect(first.trend.points.length).toBeLessThanOrEqual(120);
    expect(first.trend.points.reduce((n,p) => n+p.attempts, 0)).toBe(300);
    expect(first.trend.points.reduce((n,p) => n+(p.providerInputTokens || 0), 0)).toBe(1500);
    expect(first.trend.points.reduce((n,p) => n+p.savedBytes, 0)).toBe(-3000);
    expect(first.trend.points.every((p) => p.cacheReadTokens === null)).toBe(true);
    expect(first.trend.points[0].firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    db.run("DELETE FROM requestStats WHERE provider='trend'");
  });
  it("reads fresh sql.js snapshots after atomic replacement without writing them", async () => {
    db.checkpoint();
    const file = join(process.env.DATA_DIR, "snapshot.sqlite");
    writeFileSync(file, readFileSync(DATA_FILE));
    const first = await openAnalyticsReadOnly(file, "sql.js");
    const n = first.get("SELECT COUNT(*) AS n FROM requestStats").n;
    expect(first.source).toBe("last-persisted-snapshot");
    expect(Number.isFinite(Date.parse(first.persistedAt))).toBe(true);
    expect(() => first.exec("CREATE TABLE forbidden(id)")).toThrow();
    first.close();
    db.run("INSERT INTO requestStats(id,timestamp) VALUES(?,?)", ["replacement", "2026-09-06T14:00:00.000Z"]);
    db.checkpoint();
    writeFileSync(file + ".new", readFileSync(DATA_FILE)); renameSync(file + ".new", file);
    const next = await openAnalyticsReadOnly(file, "sql.js");
    expect(next.get("SELECT COUNT(*) AS n FROM requestStats").n).toBe(n + 1);
    next.close();
  });
  it("partitions adjacent time scopes without duplicating boundary attempts", async () => {
    const sessionId = db.get("SELECT id FROM contextSessions LIMIT 1").id;
    for (let i = 0; i < 3; i++) db.run("INSERT INTO requestStats(id,timestamp,provider,contextSessionId) VALUES(?,?,?,?)",
      [`boundary-${i}`, `2026-09-06T1${i}:00:00.000Z`, "boundary", sessionId]);
    try {
      const first = { provider: "boundary", from: "2026-09-06T10:00:00.000Z", until: "2026-09-06T11:00:00.000Z", pageSize: 1 };
      const next = { ...first, from: first.until, until: "2026-09-06T12:00:00.000Z" };
      for (const [filter, expected] of [[first, "boundary-0"], [next, "boundary-1"]]) {
        const overview = await getContextOverview(filter);
        const session = await getContextSession(sessionId, filter);
        expect(overview.summary.attempts).toBe(1);
        expect(overview.recording.totalRetainedAttempts).toBe(1);
        expect(session.turns.map((turn) => turn.id)).toEqual([expected]);
        expect(session.pagination.totalItems).toBe(1);
        expect(session.trend.points.reduce((total, point) => total + point.attempts, 0)).toBe(1);
      }
      const { until, ...inclusive } = first;
      expect((await getContextOverview({ ...inclusive, to: until })).summary.attempts).toBe(2);
    } finally { db.run("DELETE FROM requestStats WHERE provider=?", ["boundary"]); }
  });
  it("requires unambiguous valid timestamps and mutually exclusive end bounds", () => {
    expect(parseContextFilter(new URLSearchParams({ from: "2026-09-06T07:00:00-03:00", until: "2026-09-06T11:00:00Z" })))
      .toMatchObject({ from: "2026-09-06T10:00:00.000Z", until: "2026-09-06T11:00:00.000Z" });
    for (const filter of [
      { until: "2026-09-06T11:00:00" }, { from: "2026-02-30T10:00:00Z" },
      { to: "2026-09-06T11:00:00Z", until: "2026-09-06T12:00:00Z" },
      { from: "2026-09-06T11:00:00Z", until: "2026-09-06T11:00:00Z" },
    ]) expect(() => parseContextFilter(new URLSearchParams(filter))).toThrow();
  });
  it("accepts projections only and never caller SQL, paths or unbounded filters", () => {
    for (const query of [
      { operation: "sql", sql: "SELECT * FROM apiKeys", filter: {} },
      { operation: "overview", filter: { view: "summary" }, retainedDays: 45, file: "/private" },
      { operation: "overview", filter: { pageSize: 100000 }, retainedDays: 45 },
      { operation: "overview", filter: { sql: "anything" }, retainedDays: 45 },
    ]) expect(() => validateAnalyticsQuery(query)).toThrow();
  });
  it("returns a controlled failure and recovers for the next valid query", async () => {
    const client = createContextAnalyticsClient({ file: DATA_FILE, driver: db.driver });
    try {
      await expect(client.run({ operation: "not-supported", filter: {} })).rejects.toBeInstanceOf(ContextAnalyticsError);
      expect((await client.run({ operation: "overview", filter: { view: "summary" }, retainedDays: 45 })).summary.attempts).toBe(1);
    } finally { await client.close(); }
  });
});

class HeldWorker extends EventEmitter {
  messages = [];
  ref() {}
  unref() {}
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
  respond(index = 0) { this.emit("message", { id: this.messages[index].id, result: { ready: true } }); }
}
const query = (name) => ({ operation: "overview", filter: { model: name }, retainedDays: 45 });
describe("bounded analytics admission", () => {
  it("coalesces identical reads and rejects excess queued work", async () => {
    const worker = new HeldWorker();
    const client = createContextAnalyticsClient({ maxQueued: 1, workerFactory: () => worker });
    const first = client.run(query("first")), shared = client.run(query("first")), second = client.run(query("second"));
    await expect(client.run(query("third"))).rejects.toBeInstanceOf(ContextAnalyticsError);
    expect(worker.messages).toHaveLength(1);
    worker.respond(); await expect(first).resolves.toEqual({ ready: true }); await shared;
    expect(worker.messages).toHaveLength(2); worker.respond(1); await second;
    await client.close();
  });
  it("removes cancelled queued jobs without cancelling a shared active reader", async () => {
    const worker = new HeldWorker(), abort = new AbortController(), queuedAbort = new AbortController();
    const client = createContextAnalyticsClient({ workerFactory: () => worker });
    const active = client.run(query("active")), cancelled = client.run(query("active"), { signal: abort.signal });
    const queued = client.run(query("queued"), { signal: queuedAbort.signal });
    abort.abort(); queuedAbort.abort();
    await expect(cancelled).rejects.toBeInstanceOf(ContextAnalyticsError); await expect(queued).rejects.toBeInstanceOf(ContextAnalyticsError);
    worker.respond(); await active;
    expect(worker.messages).toHaveLength(1); await client.close();
  });
  it("terminates a timed-out worker before restarting and closes pending work", async () => {
    const workers = [];
    const client = createContextAnalyticsClient({ timeoutMs: 20, workerFactory: () => { const w = new HeldWorker(); workers.push(w); return w; } });
    await expect(client.run(query("timeout"))).rejects.toBeInstanceOf(ContextAnalyticsError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workers[0].terminated).toBe(true);
    const next = client.run(query("restart")); workers[1].respond(); await next;
    const pending = client.run(query("shutdown")); await client.close();
    await expect(pending).rejects.toBeInstanceOf(ContextAnalyticsError);
    await expect(client.run(query("closed"))).rejects.toBeInstanceOf(ContextAnalyticsError);
  });
});
