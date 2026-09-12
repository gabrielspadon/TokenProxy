import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleRelease, DELIVERY_GATES, GATE_CHECKS, readArtifact, validateGate } from "../../scripts/qa/assemble-release-evidence.mjs";
import { createRiskScope, hash, loadRiskScope, mutantFingerprint, riskCategory, validateCoverage, validateMutation, validatePythonCoverage } from "../../scripts/qa/risk-scope.mjs";

const roots = [];
const source = "export const admit = (available) => available ? true : false;\n";
const path = "src/sse/services/auth.js";
const time = { startedAt: "2026-09-09T00:00:00.000Z", finishedAt: "2026-09-10T01:00:00.000Z" };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tokenproxy-release-gate-")); roots.push(root);
  const repo = join(root, "repo"); const evidence = join(root, "evidence");
  mkdirSync(repo); mkdirSync(evidence);
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid.example", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid.example" },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q"); git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "chore: fixture baseline");
  const baseSha = git("rev-parse", "HEAD");
  mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), source);
  mkdirSync(join(repo, "scripts/deploy"), { recursive: true }); writeFileSync(join(repo, "scripts/deploy/deploy_driver.py"), "def admit(value):\n    return 1 if value else 0\n");
  git("add", path, "scripts/deploy/deploy_driver.py"); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fix: fixture admission");
  const applicationSha = git("rev-parse", "HEAD");
  const identities = { applicationSha, frontSha: applicationSha, deploySha: applicationSha, baseSha };
  const put = (name, value) => {
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    writeFileSync(join(evidence, name), bytes);
    return { path: name, sha256: hash(bytes) };
  };
  const scope = createRiskScope(repo, baseSha, applicationSha);
  const riskScope = put("risk-scope.json", scope);
  const logs = put("command.log", "fixture finished\n");
  const raw = put("raw.json", { state: "passed", gitSha: applicationSha });
  const coverage = {
    [join(repo, path)]: {
      branchMap: { 0: { type: "cond-expr", locations: [{ start: { line: 1 }, end: { line: 1 } }, { start: { line: 1 }, end: { line: 1 } }] } },
      b: { 0: [1, 1] }, s: { 0: 1 }, statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } },
    },
  };
  const mutant = { id: "0", mutatorName: "BooleanLiteral", location: { start: { line: 1, column: 47 }, end: { line: 1, column: 51 } }, replacement: "false", status: "Killed" };
  const mutation = { schemaVersion: "3.4", files: { [path]: { source, mutants: [mutant] } } };
  const mutationReport = put("mutation.json", mutation);
  const reviews = { candidateSha: applicationSha, reportSha256: mutationReport.sha256, mutants: [] };
  const gate = (id) => ({
    schema: "tokenproxy-release-gate-v1", gate: id, state: "passed", ...identities, taskId: `fixture-${id}`,
    runtime: { node: process.version }, dependencies: { fixture: "1.0.0" }, ...time,
    commands: [{ argv: ["node", "fixture.mjs"], exitCode: 0, signal: null, ...time, stdout: logs, stderr: logs }],
    artifacts: [raw], fixtures: [], checks: Object.fromEntries(GATE_CHECKS[id].map((check) => [check, true])), skips: [],
    metrics: {
      requestRows: 1000000, usageRows: 1000000, workerPeakRssBytes: 1024,
      populations: [1, 5].flatMap((concurrency) => ["cold", "warm"].map((temperature) => ({ concurrency, temperature, samples: 200, p95Ms: 1000, p99Ms: 1500, failures: 0, http503s: 0, syntheticWrites: 1 }))),
      samples: 32, failures: 0, branchPercentage: 100, mutationScore: 100, unreviewedSurvivors: 0,
      requests: 10000, cutovers: 2, backlogSlope: 0, rssSlopeBytesPerMinute: 0, pauseMs: 1000,
      logicalRequests: 1000, syntheticGenerationRequests: 0, proxyUnexpectedFailures: 0,
    },
    ...(["risk-coverage", "front-risk-coverage"].includes(id) ? { report: put("coverage.json", coverage) } : {}),
    ...(["risk-mutation", "front-risk-mutation"].includes(id) ? { report: mutationReport, reviews: put("reviews.json", reviews) } : {}),
    ...(id === "offline-suite" ? { testReport: put("tests.json", { testResults: [{ name: "tests/unit/admission.test.js", status: "passed", assertionResults: [{ fullName: "admission rejects expired request", status: "passed" }] }] }) } : {}),
    ...(id === "deploy-driver-coverage" ? { report: put("python-coverage.json", { meta: { branch_coverage: true }, files: { "scripts/deploy/deploy_driver.py": { executed_branches: [[2, -1], [2, 3]], missing_branches: [] } } }) } : {}),
  });
  const gates = Object.fromEntries(Object.keys(GATE_CHECKS).map((id) => [id, put(`${id}.json`, gate(id))]));
  const formats = Array.from({ length: 11 }, (_, id) => `format-${id}`);
  const capabilityManifest = {
    formats, cells: formats.flatMap((source) => formats.map((target) => ({ source, target }))),
    primaryEndpoints: Array.from({ length: 36 }, (_, id) => ({ id: `primary-${id}` })), binaryProtocols: [], modalityRoutes: [],
  };
  const localCapabilities = [...capabilityManifest.cells.map(({ source, target }) => `format:${source}->${target}`), ...capabilityManifest.primaryEndpoints.map(({ id }) => `endpoint:${id}`)];
  const manifest = {
    schema: "tokenproxy-release-input-v1", stage: "delivery", taskId: "T09", ...identities, riskScope, gates,
    frontRiskScope: riskScope, frontRepositoryRoot: repo,
    packages: [{ ...put("standalone.tgz", "standalone fixture"), kind: "standalone", applicationSha }, { ...put("cli.tgz", "cli fixture"), kind: "cli", applicationSha }],
    capabilityManifest: put("capabilities.json", capabilityManifest),
    namedFailureCases: put("failure-cases.json", { schema: "tokenproxy-named-failure-cases-v1", applicationSha, cases: [{ id: "expired-request", file: "tests/unit/admission.test.js", fullName: "admission rejects expired request" }] }),
    qualification: [{ id: "linux-x64-node24", owner: "release", state: "qualified", required: true, gates: ["standalone", "cli", "container"] }, { id: "paid-provider", owner: "operator", state: "live-inference-unqualified", required: false, reason: "no paid generation authorization" }, ...localCapabilities.map((id) => ({ id, owner: "protocol", state: "qualified", required: true, gates: ["protocol-matrix"] }))],
  };
  return { root, repo, evidence, identities, scope, riskScope, put, gate, gates, manifest, coverage, mutation, mutant, reviews };
}

describe("release evidence gate", () => {
  it("joins the complete exact-revision inventory and preserves live inference qualification", () => {
    const f = fixture();
    const report = assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo });
    expect(report.state).toBe("delivery-qualified");
    expect(Object.keys(report.gates)).toHaveLength(Object.keys(GATE_CHECKS).length);
    expect(report.qualification[1].state).toBe("live-inference-unqualified");
  });
  it("labels offline qualification without claiming deployment or observation", () => {
    const f = fixture(); f.manifest.stage = "offline";
    for (const gate of DELIVERY_GATES) delete f.manifest.gates[gate];
    const report = assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo });
    expect(report.state).toBe("offline-qualified"); expect(report.outstandingGates).toEqual(DELIVERY_GATES);
  });
  it.each(["browser", "risk-mutation", "production-observation"])("rejects a missing required %s gate", (id) => {
    const f = fixture(); delete f.manifest.gates[id];
    expect(() => assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo })).toThrow();
  });
  it.each(["failed", "skipped", "blocked", "running"])("rejects a %s gate even with passing checks", (state) => {
    const f = fixture(); const gate = f.gate("cli"); gate.state = state;
    expect(() => validateGate(f.evidence, "cli", f.put("rejected.json", gate), f.identities)).toThrow(/required gate/u);
  });
  it.each(["applicationSha", "frontSha", "deploySha"])("rejects mixed %s", (key) => {
    const f = fixture(); const gate = f.gate("cli"); gate[key] = "b".repeat(40);
    expect(() => validateGate(f.evidence, "cli", f.put("mixed.json", gate), f.identities)).toThrow(/mismatched/u);
  });
  it("rejects failed subprocesses, missing checks, and required skips", () => {
    const f = fixture(); const gate = f.gate("browser"); gate.commands[0].exitCode = 1;
    expect(() => validateGate(f.evidence, "browser", f.put("exit.json", gate), f.identities)).toThrow(/terminate/u);
    gate.commands[0].exitCode = 0; delete gate.checks.accessibility;
    expect(() => validateGate(f.evidence, "browser", f.put("check.json", gate), f.identities)).toThrow(/accessibility/u);
    gate.checks.accessibility = true; gate.skips = [{ id: "a11y", owner: "qa", reason: "disabled", state: "unsupported-platform-unqualified", required: true }];
    expect(() => validateGate(f.evidence, "browser", f.put("skip.json", gate), f.identities)).toThrow(/required case/u);
  });
  it("rejects hash tampering and symlink traversal", () => {
    const f = fixture(); const artifact = f.put("value.txt", "before"); writeFileSync(join(f.evidence, "value.txt"), "after");
    expect(() => readArtifact(f.evidence, artifact)).toThrow(/hash mismatch/u);
    writeFileSync(join(f.root, "outside.txt"), "outside"); symlinkSync(join(f.root, "outside.txt"), join(f.evidence, "escape.txt"));
    expect(() => readArtifact(f.evidence, { path: "escape.txt", sha256: hash("outside") })).toThrow(/escapes/u);
  });
  it("rejects raw failure receipt hidden under a successful envelope", () => {
    const f = fixture(); const gate = f.gate("cli"); gate.artifacts = [f.put("failure.json", { state: "failed", gitSha: f.identities.applicationSha })];
    expect(() => validateGate(f.evidence, "cli", f.put("hidden.json", gate), f.identities)).toThrow(/raw evidence/u);
  });
  it.each([
    ["analytics-250k", "p95Ms", 2000], ["analytics-250k", "samples", 49],
    ["production-observation", "logicalRequests", 999], ["production-observation", "proxyUnexpectedFailures", 1],
    ["deployment", "pauseMs", 4000], ["soak", "backlogSlope", 1],
  ])("enforces %s %s boundary", (id, key, value) => {
    const f = fixture(); const gate = f.gate(id);
    if (id === "analytics-250k") gate.metrics.populations[0][key] = value; else gate.metrics[key] = value;
    expect(() => validateGate(f.evidence, id, f.put("boundary.json", gate), f.identities)).toThrow();
  });
  it("rejects incomplete observation time even when request count passes", () => {
    const f = fixture(); const gate = f.gate("production-observation"); gate.finishedAt = "2026-09-09T01:00:00.000Z";
    expect(() => validateGate(f.evidence, "production-observation", f.put("short.json", gate), f.identities)).toThrow(/24 hours/u);
  });
  it("rejects a skipped named failure case despite a green suite headline", () => {
    const f = fixture(); const gate = f.gate("offline-suite");
    gate.testReport = f.put("skipped-assertion.json", { testResults: [{ name: "tests/unit/admission.test.js", status: "passed", assertionResults: [{ fullName: "admission rejects expired request", status: "pending" }] }] });
    f.manifest.gates["offline-suite"] = f.put("skipped-case.json", gate);
    expect(() => assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo })).toThrow(/named failure case did not pass/u);
  });
});

describe("risk coverage and mutation inventory", () => {
  it("derives full changed risk files from Git and rejects shortened or altered scope", () => {
    const f = fixture(); expect(f.scope.files).toEqual([{ path, category: "admission-retry-credentials", sha256: hash(source), changedLines: [{ start: 1, end: 1 }] }]);
    expect(loadRiskScope(join(f.evidence, f.riskScope.path), f.repo)).toEqual(f.scope);
    const shortened = { ...f.scope, files: [] }; f.put("shortened.json", shortened);
    expect(() => loadRiskScope(join(f.evidence, "shortened.json"), f.repo)).toThrow(/inventory/u);
    writeFileSync(join(f.repo, path), "changed\n");
    expect(() => loadRiskScope(join(f.evidence, f.riskScope.path), f.repo)).toThrow(/source differs/u);
  });
  it.each(["src/lib/db/migrations/004-new.js", "src/lib/auth/dashboardSession.js", "src/app/api/ready/route.js", "src/sse/services/budget.js", "open-sse/utils/replaySafety.js", "scripts/qa/new-gate.mjs", "scripts/deploy/deploy_driver.py"])("includes %s in risk ownership", (file) => {
    expect(riskCategory(file)).not.toBeNull();
  });
  it("rejects missing coverage, low changed branches, and malformed counters", () => {
    const f = fixture(); expect(validateCoverage(f.coverage, f.scope, f.repo).percentage).toBe(100);
    expect(() => validateCoverage({}, f.scope, f.repo)).toThrow(/missing/u);
    f.coverage[join(f.repo, path)].b[0] = [1, 0]; expect(() => validateCoverage(f.coverage, f.scope, f.repo)).toThrow(/below 90/u);
    f.coverage[join(f.repo, path)].b[0] = [NaN, 1]; expect(() => validateCoverage(f.coverage, f.scope, f.repo)).toThrow(/invalid coverage/u);
  });
  it("reports unrelated legacy branches without adding a whole-file threshold", () => {
    const f = fixture(); const report = f.coverage[join(f.repo, path)];
    report.b[1] = [0, 0]; report.branchMap[1] = { locations: [{ start: { line: 20 }, end: { line: 20 } }, { start: { line: 20 }, end: { line: 20 } }] };
    const result = validateCoverage(f.coverage, f.scope, f.repo);
    expect(result.percentage).toBe(100); expect(result.files[0].wholeFile).toEqual({ branches: 4, covered: 2 });
    expect(result.files[0].selectedBranchIds).toEqual(["0"]);
  });
  it("requires review of every survivor bound to its exact report", () => {
    const f = fixture(); f.mutation.files[path].mutants.push({ ...f.mutant, id: "1", status: "Survived" }, { ...f.mutant, id: "2" });
    const digest = hash(JSON.stringify(f.mutation)); f.reviews.reportSha256 = digest;
    expect(() => validateMutation(f.mutation, f.scope, f.reviews, digest, f.repo)).toThrow(/unreviewed/u);
    f.reviews.mutants = [{ fingerprint: mutantFingerprint(path, f.mutation.files[path].mutants[1]), reviewer: "independent", reason: "both branches return the same contractual value", disposition: "equivalent" }];
    expect(validateMutation(f.mutation, f.scope, f.reviews, digest, f.repo).score).toBeCloseTo(66.6667);
    expect(() => validateMutation(f.mutation, f.scope, f.reviews, "f".repeat(64), f.repo)).toThrow(/exact report/u);
  });
  it("does not improve the mutation score by declaring a survivor equivalent", () => {
    const f = fixture(); f.mutant.status = "Survived";
    const digest = hash(JSON.stringify(f.mutation)); f.reviews.reportSha256 = digest;
    f.reviews.mutants = [{ fingerprint: mutantFingerprint(path, f.mutant), reviewer: "reviewer", reason: "equivalence reasoning", disposition: "equivalent" }];
    expect(() => validateMutation(f.mutation, f.scope, f.reviews, digest, f.repo)).toThrow(/below 60/u);
  });
  it.each(["Pending", "RuntimeError", "unknown"])("rejects %s mutants", (status) => {
    const f = fixture(); f.mutant.status = status;
    const digest = hash(JSON.stringify(f.mutation)); f.reviews.reportSha256 = digest;
    expect(() => validateMutation(f.mutation, f.scope, f.reviews, digest, f.repo)).toThrow(/mutant status/u);
  });
  it("rejects a coverage headline that contradicts raw counters", () => {
    const f = fixture(); const gate = f.gate("risk-coverage"); gate.metrics.branchPercentage = 99;
    f.manifest.gates["risk-coverage"] = f.put("contradiction.json", gate);
    expect(() => assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo })).toThrow(/headline/u);
  });
  it("recomputes Python changed branch coverage instead of trusting combined line coverage", () => {
    const f = fixture();
    const report = { meta: { branch_coverage: true }, files: { "scripts/deploy/deploy_driver.py": { executed_branches: [[2, -1]], missing_branches: [[2, 3]], summary: { percent_covered: 99 } } } };
    expect(() => validatePythonCoverage(report, f.scope, f.repo)).toThrow(/below 90/u);
  });
});
