import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assessBenchmarkAffinity,
  benchmarkReceiptSettings,
  evaluateEconomicsLatencyQualification,
  evaluateGrowthQualification,
  explainAnalyticsPopulation,
  parseCpuList,
  prepareWarmProfile,
  validateGrowthMarker,
} from "../qa/context-analytics-benchmark.mjs";

// Anchor on this file, not on the working directory. Vitest pins its root to
// tests/ (tests/vitest.config.js), so the worker working directory IS tests/ and
// joining "tests/qa/..." onto it resolved to tests/tests/qa/..., which never
// loaded: each assertion then read a Node module-resolution stack instead of the
// script own stderr.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const benchmark = join(repoRoot, "tests/qa/context-analytics-benchmark.mjs");
const seed = join(repoRoot, "tests/qa/economics-analytics-seed.mjs");

describe("context analytics growth benchmark", () => {
  it("compiles the population plan without executing an unmeasured population query", () => {
    const query = { facets: ["summary", "groups"] };
    const sql = "WITH population AS MATERIALIZED (SELECT id FROM requestStats WHERE id=?) SELECT id FROM population UNION ALL SELECT id FROM population";
    const db = {
      get: vi.fn(),
      all: vi.fn((statement, args) => {
        expect(statement).toBe(`EXPLAIN QUERY PLAN ${sql}`);
        expect(args).toEqual(["example"]);
        return [{ detail: "SCAN requestStats" }];
      }),
    };
    expect(explainAnalyticsPopulation(db, query, (connection, input) => {
      expect(input).toBe(query);
      connection.all(sql, ["example"]);
      throw new Error("population execution must stop before result hydration");
    })).toEqual(["SCAN requestStats"]);
    expect(db.all).toHaveBeenCalledTimes(1);
    expect(() => explainAnalyticsPopulation(db, query, () => {})).toThrow("not captured");
    const failure = new Error("query construction failed");
    expect(() => explainAnalyticsPopulation(db, query, () => { throw failure; })).toThrow(failure);
  });
  const operations = ["economics-page-population", "economics-filtered-provider", "economics-items", "activity-summary-groups"];
  const deliveries = operations.flatMap(operation => [
    ...Array.from({ length: 3 }, (_, index) => ({ operation, concurrency: 1, writer: false, iteration: index + 1, durationMs: 1000 })),
    ...Array.from({ length: 5 }, (_, index) => ({ operation, concurrency: 5, writer: true, deliveryOrdinal: index + 1, durationMs: 1000 })),
  ]);
  const computations = operations.flatMap(operation => [
    ...Array.from({ length: 3 }, (_, index) => ({ operation, concurrency: 1, writer: false, iteration: index + 1, durationMs: 900 })),
    { operation, concurrency: 5, writer: true, iteration: 1, durationMs: 900 },
  ]);

  it("requires a completed external one-million-row fixture", () => {
    const result = spawnSync(process.execPath, [benchmark, "--economics", "--growth-only", `--data-dir=/tmp/tokenproxy-growth-missing-${process.pid}`, "--rows=1000000"], {
      cwd: repoRoot, encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("growth-only requires a completed external 1000000-row synthetic fixture");
  });

  it("parses the kernel affinity list and rejects a selected core at twenty percent busy", () => {
    expect(parseCpuList("0-2,5,7-8")).toEqual([0, 1, 2, 5, 7, 8]);
    const before = `cpu  0 0 0 0 0 0 0 0\ncpu0 10 0 10 80 0 0 0 0\ncpu1 20 0 10 70 0 0 0 0\n`;
    const after = `cpu  0 0 0 0 0 0 0 0\ncpu0 20 0 20 161 0 0 0 0\ncpu1 25 0 10 90 0 0 0 0\n`;

    expect(assessBenchmarkAffinity({ allowedList: "0", selectedList: "0", before, after })).toMatchObject({ accepted: true, selectedCores: [0] });
    expect(assessBenchmarkAffinity({ allowedList: "1", selectedList: "1", before, after })).toMatchObject({ accepted: false, selectedCores: [1], busyCores: [{ cpu: 1, busyPercent: 20 }] });
    expect(() => assessBenchmarkAffinity({ allowedList: "0-1", selectedList: "0", before, after })).toThrow("must match process affinity");
    expect(() => assessBenchmarkAffinity({ allowedList: "0-1", selectedList: "2", before, after })).toThrow("outside process affinity");
  });

  it("accepts only a completed external one-million-row synthetic marker", () => {
    const marker = { kind: "tokenproxy-economics-synthetic-fixture", version: 1, rowsPerTable: 1000000, synthetic: true, productionDataAccess: false, completed: true };
    expect(validateGrowthMarker(marker)).toEqual(marker);
    expect(() => validateGrowthMarker({ ...marker, rowsPerTable: 999999 })).toThrow("1000000-row");
    expect(() => validateGrowthMarker({ ...marker, completed: false })).toThrow("completed external");
  });

  it("publishes the completed marker only after the fixture parity checks", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tokenproxy-growth-seed-test-"));
    const receipt = join(dataDir, "seed.json");
    try {
      const result = spawnSync(process.execPath, [seed, `--data-dir=${dataDir}`, "--rows=1", receipt], {
        cwd: repoRoot, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(dataDir, ".tokenproxy-economics-fixture.json"), "utf8"))).toMatchObject({
        rowsPerTable: 1, synthetic: true, productionDataAccess: false, completed: true,
      });
      expect(JSON.parse(readFileSync(receipt, "utf8")).fixture).toMatchObject({ requestRows: 1, usageRows: 1, projectionRows: 1, missingRows: 0, orphanRows: 0 });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects every occupied data directory before opening its database", () => {
    for (const occupiedPath of ["sentinel.txt", join("db", "data.sqlite")]) {
      const dataDir = mkdtempSync(join(tmpdir(), "tokenproxy-growth-occupied-test-"));
      const existing = join(dataDir, occupiedPath);
      const receipt = join(dataDir, "receipt.json");
      try {
        mkdirSync(join(existing, ".."), { recursive: true });
        writeFileSync(existing, "preserve-me");
        const result = spawnSync(process.execPath, [seed, `--data-dir=${dataDir}`, "--rows=1", receipt], {
          cwd: repoRoot, encoding: "utf8",
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("seed data directory must be empty or absent");
        expect(readFileSync(existing, "utf8")).toBe("preserve-me");
        expect(existsSync(receipt)).toBe(false);
        expect(existsSync(join(dataDir, ".tokenproxy-economics-fixture.json"))).toBe(false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  it("retains affinity evidence in standard benchmark receipt settings", () => {
    const affinityPreflight = { accepted: true, allowedCores: [4, 5], selectedCores: [4, 5], busyCores: [] };
    expect(benchmarkReceiptSettings(affinityPreflight)).toEqual({ cacheTtlMs: 1000, serviceDeadlineMs: 15000, affinityPreflight });
  });

  it("checkpoints pending fixture writes before priming and refuses an uncached prime", async () => {
    const order = [];
    const db = { checkpoint: () => order.push("checkpoint") };
    const client = { invalidate: () => order.push("invalidate"), status: () => ({ cached: 1 }) };
    await prepareWarmProfile(db, client, async () => order.push("prime"));
    expect(order).toEqual(["checkpoint", "invalidate", "prime"]);
    await expect(prepareWarmProfile(db, { ...client, status: () => ({ cached: 0 }) }, vi.fn()))
      .rejects.toThrow("warm profile prime did not populate the result cache");
  });

  it("qualifies Economics latency profiles while retaining Activity as a reported control", () => {
    const profiles = [
      { operation: "economics-page-population", cacheState: "result-cache-cold", concurrency: 1, writer: false, latencyQualified: true, p95Ms: 1999, p99Ms: 4999 },
      { operation: "activity-summary-groups", cacheState: "result-cache-cold", concurrency: 1, writer: false, latencyQualified: false, p95Ms: 9000, p99Ms: 12000 },
      { operation: "economics-items", cacheState: "result-cache-warm", concurrency: 1, writer: false, latencyQualified: true, p95Ms: 9000, p99Ms: 12000 },
    ];

    expect(evaluateEconomicsLatencyQualification(profiles)).toEqual([]);
    expect(evaluateEconomicsLatencyQualification([
      ...profiles,
      { operation: "economics-filtered-provider", cacheState: "result-cache-cold", concurrency: 5, writer: true, latencyQualified: true, p95Ms: 2000, p99Ms: 4000 },
    ])).toEqual([{ operation: "economics-filtered-provider", concurrency: 5, writer: true, p95Ms: 2000, p99Ms: 4000 }]);
  });

  it("qualifies exactly thirty-two deliveries and sixteen bounded computations", () => {
    const parity = { requestRows: 1000000, usageRows: 1000000, projectionRows: 1000000, missingRows: 0, orphanRows: 0 };
    const qualification = evaluateGrowthQualification({
      deliveries, computations,
      writerCoverage: operations.map(operation => ({ operation, committedWritesWithinWorkerSnapshot: 1 })),
      failures: [], writerFailures: 0, beforeParity: parity, afterParity: parity,
      plans: operations.map(operation => ({ operation, steps: ["SEARCH indexed"] })),
      rowsPerTable: 1000000, peakRssBytes: 536870911, deadlineMs: 15000,
    });

    expect(qualification).toEqual({ passed: true, labels: ["growth-smoke"], latencyQualified: false, violations: [] });
    expect(evaluateGrowthQualification({
      deliveries: Array.from({ length: 31 }, () => ({ durationMs: 1000 })), computations: Array.from({ length: 15 }, () => ({ durationMs: 900 })),
      writerCoverage: [], failures: [{}], writerFailures: 1, beforeParity: parity, afterParity: { ...parity, projectionRows: 999999 },
      plans: [], rowsPerTable: 1000000, peakRssBytes: 536870912, deadlineMs: 15000,
    }).violations.map(({ kind }) => kind)).toEqual([
      "delivery-count", "computation-count", "writer-snapshot-count", "read-failures", "writer-failures", "projection-parity-after", "plan-count", "rss",
    ]);
  });

  it("rejects thirty-two deliveries that do not cover the four required operation profiles", () => {
    const parity = { requestRows: 1000000, usageRows: 1000000, projectionRows: 1000000, missingRows: 0, orphanRows: 0 };
    const result = evaluateGrowthQualification({
      deliveries: deliveries.map(row => ({ ...row, operation: operations[0] })), computations,
      writerCoverage: operations.map(operation => ({ operation, committedWritesWithinWorkerSnapshot: 1 })), failures: [], writerFailures: 0,
      beforeParity: parity, afterParity: parity, plans: operations.map(operation => ({ operation, steps: ["SEARCH indexed"] })),
      rowsPerTable: 1000000, peakRssBytes: 100000000, deadlineMs: 15000,
    });

    expect(result.violations.map(({ kind }) => kind)).toContain("operation-profile-coverage");
  });

  it("fails a writer snapshot without a commit and a computation at the deadline", () => {
    const parity = { requestRows: 1000000, usageRows: 1000000, projectionRows: 1000000, missingRows: 0, orphanRows: 0 };
    const result = evaluateGrowthQualification({
      deliveries, computations: computations.map((row, index) => ({ ...row, durationMs: index ? 900 : 15000 })),
      writerCoverage: operations.map((operation, index) => ({ operation, committedWritesWithinWorkerSnapshot: index ? 1 : 0 })),
      failures: [], writerFailures: 0, beforeParity: { ...parity, requestRows: 999999 }, afterParity: parity,
      plans: operations.map(operation => ({ operation, steps: ["SEARCH indexed"] })), rowsPerTable: 1000000, peakRssBytes: 100000000, deadlineMs: 15000,
    });

    expect(result.violations.map(({ kind }) => kind)).toEqual(["writer-snapshot-commit", "projection-parity-before", "computation-deadline"]);
  });
});
