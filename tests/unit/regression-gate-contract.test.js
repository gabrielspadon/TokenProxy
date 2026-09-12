import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const testsDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(testsDir, "..");
const verifier = join(testsDir, "__baseline__", "verify-no-regression.mjs");
const fixtures = join(testsDir, "fixtures", "regression-gate");
const scratch = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    execFileSync(process.execPath, ["-e", "require('fs').rmSync(process.argv[1], {recursive:true,force:true})", dir]);
  }
});

function run(name, {
  runnerExit = ["clean", "removed-file", "removed-assertion", "unclassified-skip"].includes(name) ? 0 : 1,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tokenproxy-gate-contract-"));
  scratch.push(dir);
  const evidence = join(dir, "evidence.json");
  const manifest = join(fixtures, `${name}.manifest.json`);
  const baseline = join(fixtures, `${name}.baseline.json`);
  const args = [
    verifier,
    join(fixtures, `${name}.json`),
    "--manifest", existsSync(manifest) ? manifest : join(fixtures, "manifest.json"),
    "--baseline", existsSync(baseline) ? baseline : join(fixtures, "baseline.json"),
    "--evidence", evidence,
  ];
  if (runnerExit !== null) args.splice(2, 0, "--runner-exit", String(runnerExit));
  const result = spawnSync(process.execPath, args, { cwd: repoDir, encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(evidence, "utf8")); } catch {}
  return { ...result, evidence: parsed };
}

describe("canonical regression gate", () => {
  it("accepts a valid report with an exact assertion inventory", () => {
    const result = run("clean");
    expect(result.status).toBe(0);
    expect(result.evidence).toMatchObject({ state: "passed", reasons: [] });
  });

  it.each([
    ["obsolete-snapshot", "OBSOLETE_SNAPSHOT"],
    ["import-failure", "SUITE_ERROR"],
    ["setup-failure", "SUITE_ERROR"],
    ["removed-file", "INVENTORY_FILE_REMOVED"],
    ["removed-assertion", "INVENTORY_ASSERTION_REMOVED"],
    ["unknown-failed-assertion", "UNKNOWN_ASSERTION_FAILURE"],
    ["expired-exemption", "EXPIRED_EXCEPTION"],
    ["formerly-fixed-recurrence", "FIXED_ASSERTION_REGRESSION"],
    ["unclassified-skip", "UNCLASSIFIED_SKIP"],
  ])("rejects %s independently", (fixture, code) => {
    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.evidence?.state).toBe("failed");
    expect(result.evidence?.reasons.map((reason) => reason.code)).toContain(code);
  });

  it.each([
    ["empty-report", "REPORT_EMPTY"],
    ["malformed-report", "REPORT_MALFORMED"],
    ["missing-report", "REPORT_MISSING"],
  ])("classifies invalid input %s", (fixture, code) => {
    const result = run(fixture);
    expect(result.status).toBe(2);
    expect(result.evidence?.state).toBe("failed");
    expect(result.evidence?.reasons.map((reason) => reason.code)).toContain(code);
  });

  it("does not let zero failed assertions override a failed suite", () => {
    const result = run("import-failure");
    expect(result.evidence?.counts.failedAssertions).toBe(0);
    expect(result.evidence?.reasons.map((reason) => reason.code)).toContain("SUITE_ERROR");
  });

  it("rejects an unexplained nonzero runner exit even when the report is green", () => {
    const result = run("clean", { runnerExit: 9 });
    expect(result.status).toBe(1);
    expect(result.evidence?.reasons.map((reason) => reason.code)).toContain("RUNNER_EXIT_UNEXPLAINED");
  });

  it("requires the raw runner exit instead of reconstructing it from the report", () => {
    const result = run("clean", { runnerExit: null });
    expect(result.status).toBe(2);
    expect(result.evidence?.reasons.map((reason) => reason.code)).toContain("RUNNER_EXIT_MISSING");
  });

  it("rejects assertion statuses outside the Vitest report contract", () => {
    const result = run("unknown-status", { runnerExit: 0 });
    expect(result.status).toBe(2);
    expect(result.evidence?.reasons.map((reason) => reason.code)).toContain("CONFIG_OR_REPORT_INVALID");
  });

  it("compares every declared assertion-status count with the inventory", () => {
    const result = run("status-count-mismatch", { runnerExit: 0 });
    expect(result.status).toBe(1);
    expect(result.evidence?.reasons.map((reason) => reason.code)).toContain("REPORT_COUNT_MISMATCH");
  });
});
