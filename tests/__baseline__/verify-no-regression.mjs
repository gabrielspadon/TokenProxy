#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const defaults = {
  baseline: resolve(here, "regression-baseline.json"),
  manifest: resolve(here, "test-manifest.json"),
};

function parseArguments(argv) {
  const args = [...argv];
  const report = args.shift();
  const options = { report, ...defaults, runnerExit: null, evidence: null };
  while (args.length) {
    const flag = args.shift();
    if (!["--runner-exit", "--manifest", "--baseline", "--evidence"].includes(flag)) {
      throw new Error(`Unknown option ${flag}`);
    }
    if (!args.length) throw new Error(`Missing value for ${flag}`);
    const value = args.shift();
    if (flag === "--runner-exit") {
      if (!/^\d+$/u.test(value)) throw new Error("--runner-exit must be a non-negative integer");
      options.runnerExit = Number(value);
    } else {
      options[flag.slice(2).replace("-", "")] = resolve(value);
    }
  }
  return options;
}

function reason(code, message, details = {}) {
  return { code, message, ...details };
}

function readJson(path, label) {
  if (!existsSync(path)) {
    const error = new Error(`${label} is missing at ${path}`);
    error.code = `${label.toUpperCase()}_MISSING`;
    throw error;
  }
  if (statSync(path).size === 0) {
    const error = new Error(`${label} is empty at ${path}`);
    error.code = `${label.toUpperCase()}_EMPTY`;
    throw error;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    const error = new Error(`${label} is malformed JSON at ${path}: ${cause.message}`);
    error.code = `${label.toUpperCase()}_MALFORMED`;
    throw error;
  }
}

function normalizeTestPath(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  const normalized = name.replaceAll("\\", "/");
  const marker = "/tests/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex !== -1) return `tests/${normalized.slice(markerIndex + marker.length)}`;
  if (normalized.startsWith("tests/")) return normalized;
  if (isAbsolute(name)) {
    const fromRepo = relative(repoRoot, name).split(sep).join("/");
    if (!fromRepo.startsWith("../")) return fromRepo.startsWith("tests/") ? fromRepo : `tests/${fromRepo}`;
  }
  return normalized.startsWith("unit/") || normalized.startsWith("translator/")
    ? `tests/${normalized}`
    : normalized;
}

function validateReport(report) {
  const requiredCounts = [
    "numFailedTestSuites", "numFailedTests", "numPassedTestSuites", "numPassedTests",
    "numPendingTestSuites", "numPendingTests", "numTodoTests", "numTotalTestSuites", "numTotalTests",
  ];
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("report root must be an object");
  if (!Array.isArray(report.testResults)) throw new Error("report.testResults must be an array");
  if (typeof report.success !== "boolean") throw new Error("report.success must be boolean");
  for (const key of requiredCounts) {
    if (!Number.isInteger(report[key]) || report[key] < 0) throw new Error(`report.${key} must be a non-negative integer`);
  }
  if (!report.snapshot || typeof report.snapshot !== "object" || Array.isArray(report.snapshot)) {
    throw new Error("report.snapshot must be an object");
  }
  if (typeof report.snapshot.failure !== "boolean"
      || !Number.isInteger(report.snapshot.unchecked)
      || !Number.isInteger(report.snapshot.unmatched)
      || !Number.isInteger(report.snapshot.filesRemoved)) {
    throw new Error("report.snapshot has invalid failure or inventory fields");
  }
  for (const file of report.testResults) {
    if (!file || typeof file !== "object" || !normalizeTestPath(file.name)) throw new Error("each test result needs a valid name");
    if (!Array.isArray(file.assertionResults)) throw new Error(`test result ${file.name} has no assertionResults array`);
    for (const assertion of file.assertionResults) {
      if (typeof assertion?.fullName !== "string" || !assertion.fullName) throw new Error(`test result ${file.name} has an assertion without fullName`);
      if (typeof assertion.status !== "string") throw new Error(`assertion ${assertion.fullName} has no status`);
    }
  }
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("manifest must use schemaVersion 1 and an object-valued files field");
  }
  for (const [file, assertions] of Object.entries(manifest.files)) {
    if (!file.startsWith("tests/") || !Array.isArray(assertions) || assertions.some((name) => typeof name !== "string" || !name)) {
      throw new Error(`invalid manifest entry ${file}`);
    }
  }
}

function validateBaseline(baseline) {
  if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.acceptedFailures)
      || !Array.isArray(baseline.fixedFailures) || !Array.isArray(baseline.classifiedSkips)) {
    throw new Error("baseline must use schemaVersion 1 with acceptedFailures, fixedFailures and classifiedSkips arrays");
  }
  for (const entry of baseline.acceptedFailures) {
    if (!entry || typeof entry.id !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expires)
        || typeof entry.reason !== "string" || !entry.reason.trim()
        || typeof entry.externalPrerequisite !== "string" || !entry.externalPrerequisite.trim()) {
      throw new Error("each accepted failure needs id, YYYY-MM-DD expiry, reason and externalPrerequisite");
    }
  }
  if (baseline.fixedFailures.some((id) => typeof id !== "string" || !id)) throw new Error("fixedFailures must contain assertion ids");
  for (const entry of baseline.classifiedSkips) {
    if (!entry || typeof entry.id !== "string"
        || !["not-run", "unsupported-by-contract"].includes(entry.state)
        || typeof entry.scope !== "string" || !entry.scope.trim()
        || typeof entry.reason !== "string" || !entry.reason.trim()
        || typeof entry.owner !== "string" || !entry.owner.trim()
        || typeof entry.externalPrerequisite !== "string" || !entry.externalPrerequisite.trim()
        || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.reviewAfter)) {
      throw new Error("each classified skip needs id, state, scope, reason, owner, externalPrerequisite and YYYY-MM-DD reviewAfter");
    }
  }
}

function reportInventory(report) {
  const files = new Map();
  const assertions = new Map();
  const occurrences = new Map();
  for (const result of report.testResults) {
    const file = normalizeTestPath(result.name);
    const fileAssertions = files.get(file) ?? [];
    files.set(file, fileAssertions);
    for (const assertion of result.assertionResults) {
      const base = `${file} :: ${assertion.fullName}`;
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      const id = `${base} :: occurrence ${occurrence}`;
      fileAssertions.push(assertion.fullName);
      assertions.set(id, assertion);
    }
  }
  return { files, assertions };
}

function evaluate(report, runnerExit, manifest, baseline) {
  const reasons = [];
  const inventory = reportInventory(report);
  const accepted = new Map(baseline.acceptedFailures.map((entry) => [entry.id, entry]));
  const fixed = new Set(baseline.fixedFailures);
  const classifiedSkips = new Map(baseline.classifiedSkips.map((entry) => [entry.id, entry]));
  const today = new Date().toISOString().slice(0, 10);
  let acceptedFailures = 0;
  let skippedAssertions = 0;

  for (const entry of accepted.values()) {
    const assertion = inventory.assertions.get(entry.id);
    if (entry.expires < today) reasons.push(reason("EXPIRED_EXCEPTION", `Accepted exception expired on ${entry.expires}`, { assertion: entry.id }));
    if (assertion?.status !== "failed") reasons.push(reason("PASSING_EXCEPTION", "Accepted exception is no longer failing and must be removed", { assertion: entry.id }));
  }

  for (const entry of classifiedSkips.values()) {
    const assertion = inventory.assertions.get(entry.id);
    if (entry.reviewAfter < today) {
      reasons.push(reason("SKIP_REVIEW_EXPIRED", `Skip classification review expired on ${entry.reviewAfter}`, { assertion: entry.id }));
    }
    if (assertion && !["skipped", "pending", "todo"].includes(assertion.status)) {
      reasons.push(reason("STALE_SKIP_CLASSIFICATION", "A classified skip is no longer skipped and must be reviewed", { assertion: entry.id }));
    }
  }

  for (const [id, assertion] of inventory.assertions) {
    if (["skipped", "pending", "todo"].includes(assertion.status)) {
      skippedAssertions += 1;
      if (!classifiedSkips.has(id)) {
        reasons.push(reason("UNCLASSIFIED_SKIP", "A skipped assertion has no explicit qualification state and owner", { assertion: id }));
      }
    } else if (assertion.status === "failed" && fixed.has(id)) {
      reasons.push(reason("FIXED_ASSERTION_REGRESSION", "A formerly fixed assertion failed again", { assertion: id }));
    } else if (assertion.status === "failed" && accepted.has(id)) {
      if (accepted.get(id).expires >= today) acceptedFailures += 1;
    } else if (assertion.status === "failed") {
      reasons.push(reason("UNKNOWN_ASSERTION_FAILURE", "A failed assertion has no active reviewed exception", { assertion: id }));
    }
  }

  for (const [file, expectedAssertions] of Object.entries(manifest.files)) {
    if (!inventory.files.has(file)) {
      reasons.push(reason("INVENTORY_FILE_REMOVED", "A reviewed test file is absent from the report", { file }));
      continue;
    }
    const actualCounts = new Map();
    for (const name of inventory.files.get(file)) actualCounts.set(name, (actualCounts.get(name) ?? 0) + 1);
    const expectedCounts = new Map();
    for (const name of expectedAssertions) expectedCounts.set(name, (expectedCounts.get(name) ?? 0) + 1);
    for (const [name, expectedCount] of expectedCounts) {
      const actualCount = actualCounts.get(name) ?? 0;
      for (let occurrence = actualCount + 1; occurrence <= expectedCount; occurrence += 1) {
        reasons.push(reason("INVENTORY_ASSERTION_REMOVED", "A reviewed assertion is absent from the report", { assertion: `${file} :: ${name} :: occurrence ${occurrence}` }));
      }
    }
  }
  for (const [file, actualAssertions] of inventory.files) {
    if (!Object.hasOwn(manifest.files, file)) {
      reasons.push(reason("INVENTORY_FILE_ADDED", "A new test file requires a reviewed manifest update", { file }));
      continue;
    }
    const expectedCounts = new Map();
    for (const name of manifest.files[file]) expectedCounts.set(name, (expectedCounts.get(name) ?? 0) + 1);
    const actualCounts = new Map();
    for (const name of actualAssertions) actualCounts.set(name, (actualCounts.get(name) ?? 0) + 1);
    for (const [name, actualCount] of actualCounts) {
      const expectedCount = expectedCounts.get(name) ?? 0;
      for (let occurrence = expectedCount + 1; occurrence <= actualCount; occurrence += 1) {
        reasons.push(reason("INVENTORY_ASSERTION_ADDED", "A new assertion requires a reviewed manifest update", { assertion: `${file} :: ${name} :: occurrence ${occurrence}` }));
      }
    }
  }

  const snapshot = report.snapshot;
  if (snapshot.unchecked > 0 || snapshot.filesRemoved > 0) {
    reasons.push(reason("OBSOLETE_SNAPSHOT", "The runner reported obsolete or removed snapshots", {
      unchecked: snapshot.unchecked ?? 0,
      filesRemoved: snapshot.filesRemoved ?? 0,
    }));
  }
  if (snapshot.failure || snapshot.unmatched > 0) {
    reasons.push(reason("SNAPSHOT_FAILURE", "The runner reported snapshot mismatches", { unmatched: snapshot.unmatched ?? 0 }));
  }

  const assertionFailures = [...inventory.assertions.values()].filter((entry) => entry.status === "failed").length;
  for (const result of report.testResults) {
    const fileFailures = result.assertionResults.filter((entry) => entry.status === "failed").length;
    const classifiedSnapshotTeardown = result.status === "failed"
      && fileFailures === 0
      && reasons.some((entry) => entry.code === "OBSOLETE_SNAPSHOT" || entry.code === "SNAPSHOT_FAILURE")
      && /snapshot/iu.test(String(result.message || ""));
    if (result.status === "failed" && fileFailures === 0 && !classifiedSnapshotTeardown) {
      reasons.push(reason("SUITE_ERROR", "A file failed outside an assertion, including collection, import, setup or snapshot teardown", {
        file: normalizeTestPath(result.name),
        message: String(result.message || "").slice(0, 500),
      }));
    }
  }
  if (report.numFailedTestSuites > 0 && assertionFailures === 0
      && !reasons.some((entry) => ["SUITE_ERROR", "OBSOLETE_SNAPSHOT", "SNAPSHOT_FAILURE"].includes(entry.code))) {
    reasons.push(reason("SUITE_ERROR", "The report records failed suites without a failed assertion"));
  }
  if (report.numTotalTests === 0) reasons.push(reason("NO_TESTS_COLLECTED", "The runner collected no tests"));

  if (report.numTotalTests !== inventory.assertions.size) {
    reasons.push(reason("REPORT_COUNT_MISMATCH", "numTotalTests differs from the exact assertion inventory", { declared: report.numTotalTests, actual: inventory.assertions.size }));
  }
  if (report.numFailedTests !== assertionFailures) {
    reasons.push(reason("REPORT_COUNT_MISMATCH", "numFailedTests differs from failed assertion inventory", { declared: report.numFailedTests, actual: assertionFailures }));
  }
  const declaredTestTotal = report.numPassedTests + report.numFailedTests
    + report.numPendingTests + report.numTodoTests;
  if (declaredTestTotal !== report.numTotalTests) {
    reasons.push(reason("REPORT_COUNT_MISMATCH", "passed, failed, pending and todo counts do not equal numTotalTests", {
      declared: report.numTotalTests, actual: declaredTestTotal,
    }));
  }
  if (report.success && (assertionFailures > 0 || report.numFailedTestSuites > 0)) {
    reasons.push(reason("REPORT_STATUS_INCONSISTENT", "The report claims success while recording failures"));
  }
  if (!report.success && report.numFailedTestSuites === 0 && assertionFailures === 0 && acceptedFailures === 0
      && !reasons.some((entry) => entry.code.includes("SNAPSHOT") || entry.code === "SUITE_ERROR")) {
    reasons.push(reason("REPORT_STATUS_INCONSISTENT", "The report claims failure without a recorded cause"));
  }
  if (runnerExit === 0 && !report.success) reasons.push(reason("RUNNER_EXIT_INCONSISTENT", "Runner exited zero but the report says success=false"));
  if (runnerExit !== 0 && report.success) reasons.push(reason("RUNNER_EXIT_UNEXPLAINED", `Runner exited ${runnerExit} while the report says success=true`));

  return {
    state: reasons.length ? "failed" : "passed",
    scope: "offline-test-regression-gate",
    reason: reasons.length ? `${reasons.length} regression gate condition(s) failed` : "report, inventory and runner outcome agree",
    reasons,
    counts: {
      files: inventory.files.size,
      assertions: inventory.assertions.size,
      failedAssertions: assertionFailures,
      acceptedFailures,
      skippedAssertions,
      classifiedSkips: classifiedSkips.size,
    },
  };
}

let options;
let evidence;
let exitCode = 0;
try {
  options = parseArguments(process.argv.slice(2));
  if (!options.report) {
    const error = new Error("Missing results.json path");
    error.code = "REPORT_MISSING";
    throw error;
  }
  options.report = resolve(options.report);
  const report = readJson(options.report, "report");
  let manifest;
  let baseline;
  try {
    manifest = readJson(options.manifest, "manifest");
    baseline = readJson(options.baseline, "baseline");
    validateReport(report);
    validateManifest(manifest);
    validateBaseline(baseline);
  } catch (error) {
    if (!error.code) error.code = "CONFIG_OR_REPORT_INVALID";
    throw error;
  }
  const runnerExit = options.runnerExit ?? (report.success ? 0 : 1);
  evidence = { ...evaluate(report, runnerExit, manifest, baseline), runnerExit, report: options.report };
  exitCode = evidence.state === "passed" ? 0 : 1;
} catch (error) {
  evidence = {
    state: "failed",
    scope: "offline-test-regression-gate",
    reason: error.message,
    reasons: [reason(error.code || "CONFIG_OR_REPORT_INVALID", error.message)],
    counts: {
      files: 0, assertions: 0, failedAssertions: 0, acceptedFailures: 0, skippedAssertions: 0, classifiedSkips: 0,
    },
  };
  exitCode = 2;
}

if (options?.evidence) writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const output = `${evidence.state.toUpperCase()} ${evidence.reason}`;
if (exitCode === 0) console.log(output);
else console.error(output);
process.exit(exitCode);
