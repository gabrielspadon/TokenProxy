import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessBenchmarkAffinity,
  evaluateGrowthQualification,
  parseCpuList,
  validateGrowthMarker,
} from "../qa/context-analytics-benchmark.mjs";

const benchmark = join(process.cwd(), "tests/qa/context-analytics-benchmark.mjs");

describe("context analytics growth benchmark", () => {
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
      cwd: process.cwd(), encoding: "utf8",
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
      const result = spawnSync(process.execPath, [join(process.cwd(), "tests/qa/economics-analytics-seed.mjs"), `--data-dir=${dataDir}`, "--rows=1", receipt], {
        cwd: process.cwd(), encoding: "utf8",
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
