import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANALYTICS_OPERATIONS, assembleRelease, DELIVERY_GATES, GATE_CHECKS, readArtifact, validateGate, validateAnalyticsNative, validateNativeArtifact, validateSafetyClosure, validateSoakNative } from "../../scripts/qa/assemble-release-evidence.mjs";
import { createRiskScope, hash, loadRiskScope, mutantFingerprint, riskCategory, validateCoverage, validateMutation, validatePythonCoverage } from "../../scripts/qa/risk-scope.mjs";

const roots = [];
const source = "export const admit = (available) => available ? true : false;\n";
const path = "src/sse/services/auth.js";
const time = { startedAt: "2026-09-09T00:00:00.000Z", finishedAt: "2026-09-10T01:00:00.000Z" };
const clean = { listenerGone: true, processesGone: true, graceful: true, forced: false, exitCode: 0 };
const primary = () => ({ primary: { passed: 36, dispatched: 30, rejectedBeforeUpstream: 6 }, receipts: { nextGatewayResponses: 39, providerIngress: { delta: 33 }, providerDispatch: { delta: 33 } } });
function analyticsNative(growth = false) {
  const rows = growth ? 1000000 : 250000;
  const parity = { requestRows: rows, usageRows: rows, sourceRows: rows, projectionRows: rows, missingRows: 0, orphanRows: 0 };
  const profiles = [], samples = [], computationCoverage = [];
  for (const operation of ANALYTICS_OPERATIONS) for (const concurrency of [1, 5]) for (const [cacheState, writer, count] of [["result-cache-cold", false, 50], ["result-cache-warm", false, 200], ["result-cache-cold", true, 50]]) {
    profiles.push({ operation, concurrency, cacheState, writer, count, latencyQualified: operation.startsWith("economics-"), p95Ms: 1000, p99Ms: 1000 });
    for (let index = 0; index < count; index++) samples.push({ operation, concurrency, cacheState, writer, durationMs: 1000, delivery: cacheState === "result-cache-warm" ? "cache-hit" : "computed" });
    if (writer) for (let index = 0; index < 50 / concurrency; index++) computationCoverage.push({ operation, concurrency, snapshotStartedAt: time.startedAt, snapshotCompletedAt: time.finishedAt, committedWritesWithinWorkerSnapshot: 1 });
  }
  const value = { fixture: { version: "economics-analytics-v1", rowsPerTable: rows, requestRows: rows, usageRows: rows, completed: true, freshProcessOnly: true }, settings: { affinityPreflight: { accepted: true, busyThresholdPercent: 20, busyCores: [], cores: [{ cpu: 1, busyPercent: 0 }], selectedCores: [1], allowedCores: [1] } }, isolatedTemporaryData: true, progress: { status: "qualification-passed", completedSamples: 2400, scheduledSamples: 2400, completedProfiles: 24, scheduledProfiles: 24 }, qualification: { passed: true, violations: [] }, failures: [], peakAnalyticsProcessRssBytes: 1024,
    plans: ANALYTICS_OPERATIONS.map((operation) => ({ operation, steps: ["SEARCH index"] })), profiles, samples,
    syntheticWriteHealth: { writes: 240, failures: 0, computationCoverage, computations: 240, minimumCommittedWritesWithinWorkerSnapshot: 1, projectionParity: parity } };
  if (growth) {
    value.latencyQualified = false; value.labels = ["growth-smoke"];
    value.deliveries = ANALYTICS_OPERATIONS.flatMap((operation) => [...[1, 2, 3].map((iteration) => ({ operation, concurrency: 1, writer: false, iteration })), ...[1, 2, 3, 4, 5].map((deliveryOrdinal) => ({ operation, concurrency: 5, writer: true, deliveryOrdinal }))]);
    value.computations = ANALYTICS_OPERATIONS.flatMap((operation) => [...[1, 2, 3].map((iteration) => ({ operation, concurrency: 1, writer: false, iteration, durationMs: 6000 })), { operation, concurrency: 5, writer: true, durationMs: 6000 }]);
    value.correctnessOracles = ANALYTICS_OPERATIONS.map((operation) => ({ operation }));
    value.progress = { status: "qualification-passed", completedDeliveries: 32, scheduledDeliveries: 32, completedComputations: 16, scheduledComputations: 16 };
    value.syntheticWriteHealth.computationCoverage = ANALYTICS_OPERATIONS.map((operation) => ({ operation, committedWritesWithinWorkerSnapshot: 1 }));
    value.syntheticWriteHealth.parity = { before: parity, after: parity };
  }
  return value;
}
function soakNative(identities) {
  const cases = ["json", "stream", "sustained", "cancel", "provider-reject", "stream-reset", "malformed", "unauthorized", "unknown-model"];
  const zero = { phase: "mixed", queued: 0, active: 0, dispatching: 0, providerActive: 0, frontRssBytes: 1000, gatewayRssBytes: 1000, frontFdCount: 10, gatewayFdCount: 10 };
  return { schema: "tokenproxy-reliability-soak-v1", state: "passed", mode: "full", errors: [], ...time,
    candidate: { sha: identities.applicationSha, artifactSha256: "a".repeat(64) }, front: { sha: identities.frontSha }, artifactUnchanged: true,
    deterministicCompleted: 10000, mixedDurationMs: 3600000,
    clients: [...Array.from({ length: 10000 }, (_, index) => ({ id: `deterministic-${index}`, state: "passed", phase: "deterministic", case: cases[index % cases.length] })), { id: "mixed-0", state: "passed", phase: "mixed", case: "sustained", durationMs: 30001, receivedContent: true, terminalFrame: true }],
    cutovers: Array.from({ length: 6 }, () => ({ state: "passed", kind: "same-artifact-quiet-restart", artifactSha: identities.applicationSha, pauseMs: 1000 })),
    dashboard: [{ state: "passed" }], cleanup: { front: clean, gateway: clean, provider: true },
    reconciliation: { state: "passed", violations: [], unsafeReplay: 0, stalePending: 0, clients: 10001 },
    resources: [zero, zero], quiescentResources: Array.from({ length: 6 }, (_, index) => ({ ...zero, elapsedMs: index * 60000 })),
    quiescentSummary: Object.fromEntries(["frontRssBytes", "gatewayRssBytes", "frontFdCount", "gatewayFdCount", "queued"].map((field) => [field, { samples: 6, slopePerMinute: 0, monotonicallyGrowing: false }])) };
}
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
  const formats = Array.from({ length: 11 }, (_, id) => `format-${id}`);
  const capabilityManifest = {
    formats, cells: formats.flatMap((source) => formats.map((target) => ({ source, target }))),
    primaryEndpoints: Array.from({ length: 36 }, (_, id) => ({ id: `primary-${id}` })), binaryProtocols: [], modalityRoutes: [],
  };
  mkdirSync(join(repo, "tests/contracts"), { recursive: true }); writeFileSync(join(repo, "tests/contracts/capabilities.json"), JSON.stringify(capabilityManifest));
  git("add", path, "scripts/deploy/deploy_driver.py", "tests/contracts/capabilities.json"); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fix: fixture admission");
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
  const nativeFor = (id) => {
    if (id.startsWith("analytics-")) return analyticsNative(id === "analytics-1m");
    if (["failure-matrix", "soak"].includes(id)) return soakNative(identities);
    if (id === "offline-suite") return { state: "passed", gitSha: applicationSha, scope: "offline-tests-full", runnerExit: 0, gateExit: 0, runnerSignal: null, canaryUnchanged: true, networkBoundary: { verified: true }, tests: [] };
    if (id === "protocol-matrix") return primary();
    if (["standalone", "cli"].includes(id)) return { schema: id === "cli" ? "tokenproxy-cli-package-qualification-v1" : "tokenproxy-standalone-qualification-v1", state: "passed", candidate: { sha: applicationSha }, starts: [1, 2].map(() => ({ readiness: { buildSha: applicationSha }, version: { buildSha: applicationSha }, cleanup: clean })),
      persistence: { seeded: true, reopened: true, migrationExercised: true, seededSchemaSha256: "a".repeat(64), reopenedSchemaSha256: "b".repeat(64), seededSchemaVersion: 1, reopenedSchemaVersion: 2 }, capability: { passed: 36, manifestCells: 121, report: primary() }, pack: { file: "cli.tgz" }, install: { scriptsExecuted: true, privateHome: true, buildSha: applicationSha } };
    if (id === "browser") return { schema: "tokenproxy-browser-qualification-v1", state: "passed", candidate: { sha: applicationSha }, build: { sha: applicationSha, artifactManifestHash: "a".repeat(64) }, inventory: { manifestSha256: "a".repeat(64), playwright: ["tests/e2e/one.spec.mjs"], scripts: [{ file: "tests/e2e/direct.mjs", disposition: "execute", owner: "fixture", reason: "assertions" }], supportingModules: [] }, cases: ["tests/e2e/one.spec.mjs", "tests/e2e/direct.mjs"].map((file) => ({ file, kind: file.includes(".spec.") ? "spec" : "script", state: "passed", exitCode: 0, report: { passed: true, complete: true, expected: 1, executed: 1, failures: [], errors: [] }, identity: { ready: { buildSha: applicationSha }, version: { buildSha: applicationSha } }, stop: { stopped: true, ownershipEndpointClosed: true } })) };
    if (id === "container") return { schema: "tokenproxy-container-qualification-v1", state: "passed", candidate: { sha: applicationSha }, image: { id: `sha256:${"a".repeat(64)}` }, network: { internal: true, removed: true }, starts: [1, 2].map((index) => ({ startedAt: `2026-09-09T00:00:0${index}.000Z`, readiness: { buildSha: applicationSha }, version: { buildSha: applicationSha }, dockerHealth: "healthy", stop: { clean: true }, capability: primary() })), persistence: { reopened: true, fixtureAuthorizationWorkedAfterRestart: true }, cleanup: [1, 2].map(() => ({ removed: true, stopped: true, clean: true, exitCode: 0, oomKilled: false })) };
    if (id === "production-observation") return { schemaVersion: 1, kind: "production-observation-result", outcomeGatePassed: true, liveQualificationComplete: false, remainingReleaseGates: ["unsafe-replay", "secret-exposure", "acknowledged-data-loss", "deployment-eviction"] };
    return { state: "passed", gitSha: applicationSha };
  };
  const gate = (id) => ({
    schema: "tokenproxy-release-gate-v1", gate: id, state: "passed", ...identities, taskId: `fixture-${id}`,
    runtime: { node: process.version }, dependencies: { fixture: "1.0.0" }, ...time,
    commands: [{ argv: ["node", "fixture.mjs"], exitCode: 0, signal: null, ...time, stdout: logs, stderr: logs }],
    artifacts: [put(`${id}-native.json`, nativeFor(id))], native: put(`${id}-native.json`, nativeFor(id)), fixtures: [], checks: Object.fromEntries(GATE_CHECKS[id].map((check) => [check, true])), skips: [],
    metrics: {
      requestRows: id === "analytics-250k" ? 250000 : 1000000, usageRows: id === "analytics-250k" ? 250000 : 1000000, workerPeakRssBytes: 1024,
      ...(id === "analytics-250k" ? { populations: analyticsNative().profiles } : {}),
      samples: 32, failures: 0, branchPercentage: 100, mutationScore: 100, unreviewedSurvivors: 0,
      requests: id === "soak" ? 10001 : 10000, cutovers: 6, backlogSlope: 0, rssSlopeBytesPerMinute: 0, pauseMs: 1000,
      logicalRequests: 1000, syntheticGenerationRequests: 0, proxyUnexpectedFailures: 0,
    },
    ...(["risk-coverage", "front-risk-coverage"].includes(id) ? { report: put("coverage.json", coverage) } : {}),
    ...(["risk-mutation", "front-risk-mutation"].includes(id) ? { report: mutationReport, reviews: put("reviews.json", reviews) } : {}),
    ...(id === "offline-suite" ? { testReport: put("tests.json", { testResults: [{ name: "tests/unit/admission.test.js", status: "passed", assertionResults: [{ fullName: "admission rejects expired request", status: "passed" }] }] }) } : {}),
    ...(id === "deploy-driver-coverage" ? { report: put("python-coverage.json", { meta: { branch_coverage: true }, files: { "scripts/deploy/deploy_driver.py": { executed_branches: [[2, -1], [2, 3]], missing_branches: [] } } }) } : {}),
  });
  const gates = Object.fromEntries(Object.keys(GATE_CHECKS).map((id) => [id, put(`${id}.json`, gate(id))]));
  const localCapabilities = [...capabilityManifest.cells.map(({ source, target }) => `format:${source}->${target}`), ...capabilityManifest.primaryEndpoints.map(({ id }) => `endpoint:${id}`)];
  const manifest = {
    schema: "tokenproxy-release-input-v1", stage: "delivery", taskId: "T09", ...identities, riskScope, gates,
    frontRiskScope: riskScope, frontRepositoryRoot: repo,
    packages: [{ ...put("standalone.tgz", "standalone fixture"), kind: "standalone", applicationSha }, { ...put("cli.tgz", "cli fixture"), kind: "cli", applicationSha }],
    capabilityManifest: put("capabilities.json", capabilityManifest),
    namedFailureCases: put("failure-cases.json", { schema: "tokenproxy-named-failure-cases-v1", applicationSha, cases: [{ id: "expired-request", file: "tests/unit/admission.test.js", fullName: "admission rejects expired request" }] }),
    qualification: [{ id: "linux-x64-node24", owner: "release", state: "qualified", required: true, gates: ["standalone", "cli", "container"] }, { id: "paid-provider", owner: "operator", state: "live-inference-unqualified", required: false, reason: "no paid generation authorization" }, ...localCapabilities.map((id) => ({ id, owner: "protocol", state: "qualified", required: true, gates: ["protocol-matrix"] }))],
  };
  return { root, repo, evidence, identities, scope, riskScope, put, gate, gates, manifest, coverage, mutation, mutant, reviews, raw, git };
}

describe("release evidence gate", () => {
  it("joins the offline exact-revision inventory and preserves live inference qualification", async () => {
    const f = fixture(); f.manifest.stage = "offline";
    const report = await assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo });
    expect(report.state).toBe("offline-qualified");
    expect(Object.keys(report.gates)).toHaveLength(Object.keys(GATE_CHECKS).length - DELIVERY_GATES.length);
    expect(report.qualification[1].state).toBe("live-inference-unqualified");
  });
  it("labels offline qualification without claiming deployment or observation", async () => {
    const f = fixture(); f.manifest.stage = "offline";
    for (const gate of DELIVERY_GATES) delete f.manifest.gates[gate];
    const report = await assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo });
    expect(report.state).toBe("offline-qualified"); expect(report.outstandingGates).toEqual(DELIVERY_GATES);
  });
  it.each(["browser", "risk-mutation", "production-observation"])("rejects a missing required %s gate", async (id) => {
    const f = fixture(); delete f.manifest.gates[id];
    await expect(assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo })).rejects.toThrow();
  });
  it.each(["failed", "skipped", "blocked", "running"])("rejects a %s gate even with passing checks", async (state) => {
    const f = fixture(); const gate = f.gate("cli"); gate.state = state;
    await expect(validateGate(f.evidence, "cli", f.put("rejected.json", gate), f.identities)).rejects.toThrow(/required gate/u);
  });
  it.each(["applicationSha", "frontSha", "deploySha"])("rejects mixed %s", async (key) => {
    const f = fixture(); const gate = f.gate("cli"); gate[key] = "b".repeat(40);
    await expect(validateGate(f.evidence, "cli", f.put("mixed.json", gate), f.identities)).rejects.toThrow(/mismatched/u);
  });
  it("rejects failed subprocesses, missing checks, and required skips", async () => {
    const f = fixture(); const gate = f.gate("browser"); gate.commands[0].exitCode = 1;
    await expect(validateGate(f.evidence, "browser", f.put("exit.json", gate), f.identities)).rejects.toThrow(/terminate/u);
    gate.commands[0].exitCode = 0; delete gate.checks.accessibility;
    await expect(validateGate(f.evidence, "browser", f.put("check.json", gate), f.identities)).rejects.toThrow(/accessibility/u);
    gate.checks.accessibility = true; gate.skips = [{ id: "a11y", owner: "qa", reason: "disabled", state: "unsupported-platform-unqualified", required: true }];
    await expect(validateGate(f.evidence, "browser", f.put("skip.json", gate), f.identities)).rejects.toThrow(/required case/u);
  });
  it("rejects hash tampering and symlink traversal", async () => {
    const f = fixture(); const artifact = f.put("value.txt", "before"); writeFileSync(join(f.evidence, "value.txt"), "after");
    expect(() => readArtifact(f.evidence, artifact)).toThrow(/hash mismatch/u);
    writeFileSync(join(f.root, "outside.txt"), "outside"); symlinkSync(join(f.root, "outside.txt"), join(f.evidence, "escape.txt"));
    expect(() => readArtifact(f.evidence, { path: "escape.txt", sha256: hash("outside") })).toThrow(/escapes/u);
  });
  it("rejects raw failure receipt hidden under a successful envelope", async () => {
    const f = fixture(); const gate = f.gate("cli"); gate.artifacts = [f.put("failure.json", { state: "failed", gitSha: f.identities.applicationSha })];
    await expect(validateGate(f.evidence, "cli", f.put("hidden.json", gate), f.identities)).rejects.toThrow(/raw evidence/u);
  });
  it.each([
    ["analytics-250k", "p95Ms", 2000], ["analytics-250k", "samples", 49],
    ["production-observation", "logicalRequests", 999], ["production-observation", "proxyUnexpectedFailures", 1],
    ["deployment", "pauseMs", 4000], ["soak", "backlogSlope", 1],
  ])("enforces %s %s boundary", async (id, key, value) => {
    const f = fixture(); const gate = f.gate(id);
    if (id === "analytics-250k") gate.metrics.populations[0][key] = value; else gate.metrics[key] = value;
    await expect(validateGate(f.evidence, id, f.put("boundary.json", gate), f.identities)).rejects.toThrow();
  });
  it("rejects an outcome-only observation without signed sources and safety closure", async () => {
    const f = fixture(); const gate = f.gate("production-observation");
    await expect(validateGate(f.evidence, "production-observation", f.put("short.json", gate), f.identities)).rejects.toThrow(/artifact requires/u);
  });
  it("rejects a skipped named failure case despite a green suite headline", async () => {
    const f = fixture(); f.manifest.stage = "offline"; const gate = f.gate("offline-suite");
    gate.testReport = f.put("skipped-assertion.json", { testResults: [{ name: "tests/unit/admission.test.js", status: "passed", assertionResults: [{ fullName: "admission rejects expired request", status: "pending" }] }] });
    f.manifest.gates["offline-suite"] = f.put("skipped-case.json", gate);
    await expect(assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo })).rejects.toThrow(/named failure case did not pass/u);
  });
  it("rejects a same-size capability manifest substituted after the candidate commit", async () => {
    const f = fixture(); f.manifest.stage = "offline";
    const manifest = JSON.parse(readFileSync(join(f.evidence, f.manifest.capabilityManifest.path)));
    manifest.source = "different producer";
    f.manifest.capabilityManifest = f.put("substituted-capabilities.json", manifest);
    await expect(assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo })).rejects.toThrow(/differs from candidate source/u);
  });
});

describe("risk coverage and mutation inventory", () => {
  it("derives full changed risk files from Git and rejects shortened or altered scope", async () => {
    const f = fixture(); expect(f.scope.files).toEqual([{ path, category: "admission-retry-credentials", sha256: hash(source), changedLines: [{ start: 1, end: 1 }] }]);
    expect(loadRiskScope(join(f.evidence, f.riskScope.path), f.repo)).toEqual(f.scope);
    const shortened = { ...f.scope, files: [] }; f.put("shortened.json", shortened);
    expect(() => loadRiskScope(join(f.evidence, "shortened.json"), f.repo)).toThrow(/inventory/u);
    writeFileSync(join(f.repo, path), "changed\n");
    expect(() => loadRiskScope(join(f.evidence, f.riskScope.path), f.repo)).toThrow(/source differs/u);
  });
  it.each(["src/lib/db/migrations/004-new.js", "src/lib/auth/dashboardSession.js", "src/lib/antigravityVerification.js", "src/lib/network/connector.js", "src/app/api/ready/route.js", "src/app/api/version/route.js", "src/sse/services/budget.js", "open-sse/utils/replaySafety.js", "open-sse/utils/streamTerminal.js", "open-sse/services/qoderModels.js", "open-sse/executors/cursor.js", "open-sse/translator/formats/openai.js", "next.config.mjs", "cli/src/index.js", "scripts/qa/new-gate.mjs", "tests/qa/context-analytics-benchmark.mjs", "scripts/deploy/deploy_driver.py"])("includes %s in risk ownership", (file) => {
    expect(riskCategory(file)).not.toBeNull();
  });
  it("rejects missing coverage, low changed branches, and malformed counters", async () => {
    const f = fixture(); expect(validateCoverage(f.coverage, f.scope, f.repo).percentage).toBe(100);
    expect(() => validateCoverage({}, f.scope, f.repo)).toThrow(/missing/u);
    f.coverage[join(f.repo, path)].b[0] = [1, 0]; expect(() => validateCoverage(f.coverage, f.scope, f.repo)).toThrow(/below 90/u);
    f.coverage[join(f.repo, path)].b[0] = [NaN, 1]; expect(() => validateCoverage(f.coverage, f.scope, f.repo)).toThrow(/invalid coverage/u);
  });
  it("reports unrelated legacy branches without adding a whole-file threshold", async () => {
    const f = fixture(); const report = f.coverage[join(f.repo, path)];
    report.b[1] = [0, 0]; report.branchMap[1] = { locations: [{ start: { line: 20 }, end: { line: 20 } }, { start: { line: 20 }, end: { line: 20 } }] };
    const result = validateCoverage(f.coverage, f.scope, f.repo);
    expect(result.percentage).toBe(100); expect(result.files[0].wholeFile).toEqual({ branches: 4, covered: 2 });
    expect(result.files[0].selectedBranchIds).toEqual(["0"]);
  });
  it("requires review of every survivor bound to its exact report", async () => {
    const f = fixture(); f.mutation.files[path].mutants.push({ ...f.mutant, id: "1", status: "Survived" }, { ...f.mutant, id: "2" });
    const digest = hash(JSON.stringify(f.mutation)); f.reviews.reportSha256 = digest;
    expect(() => validateMutation(f.mutation, f.scope, f.reviews, digest, f.repo)).toThrow(/unreviewed/u);
    f.reviews.mutants = [{ fingerprint: mutantFingerprint(path, f.mutation.files[path].mutants[1]), reviewer: "independent", reason: "both branches return the same contractual value", disposition: "equivalent" }];
    expect(validateMutation(f.mutation, f.scope, f.reviews, digest, f.repo).score).toBeCloseTo(66.6667);
    expect(() => validateMutation(f.mutation, f.scope, f.reviews, "f".repeat(64), f.repo)).toThrow(/exact report/u);
  });
  it("does not improve the mutation score by declaring a survivor equivalent", async () => {
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
  it("rejects a coverage headline that contradicts raw counters", async () => {
    const f = fixture(); f.manifest.stage = "offline"; const gate = f.gate("risk-coverage"); gate.metrics.branchPercentage = 99;
    f.manifest.gates["risk-coverage"] = f.put("contradiction.json", gate);
    await expect(assembleRelease(f.evidence, f.manifest, { repositoryRoot: f.repo })).rejects.toThrow(/headline/u);
  });
  it("recomputes Python changed branch coverage instead of trusting combined line coverage", async () => {
    const f = fixture();
    const report = { meta: { branch_coverage: true }, files: { "scripts/deploy/deploy_driver.py": { executed_branches: [[2, -1]], missing_branches: [[2, 3]], summary: { percent_covered: 99 } } } };
    expect(() => validatePythonCoverage(report, f.scope, f.repo)).toThrow(/below 90/u);
  });
});

describe("source-native qualification contracts", () => {
  it("retains separate cold, warm, writer and Activity control populations", () => {
    const value = analyticsNative();
    for (const row of value.profiles.filter((row) => !row.latencyQualified)) { row.p95Ms = 6000; row.p99Ms = 6000; }
    for (const row of value.samples.filter((row) => row.operation === "activity-summary-groups")) row.durationMs = 6000;
    expect(validateAnalyticsNative(value, "analytics-250k").populations).toHaveLength(24);
    expect(value.profiles.filter((row) => row.cacheState === "result-cache-warm").every((row) => row.writer === false)).toBe(true);
  });
  it.each(["operation", "profile", "sample", "cache", "writer", "headline", "latency-scope", "progress", "qualification"])("rejects incomplete or contradictory analytics %s evidence", (fault) => {
    const value = analyticsNative();
    if (fault === "operation") value.plans[0].operation = "arbitrary-substitute";
    if (fault === "profile") value.profiles[0] = value.profiles[1];
    if (fault === "sample") value.samples.pop();
    if (fault === "cache") value.samples.find((row) => row.cacheState === "result-cache-warm").delivery = "computed";
    if (fault === "writer") value.syntheticWriteHealth.computationCoverage[0].committedWritesWithinWorkerSnapshot = 0;
    if (fault === "headline") value.profiles[0].p95Ms = 100;
    if (fault === "latency-scope") value.profiles[0].latencyQualified = false;
    if (fault === "progress") value.progress.status = "running";
    if (fault === "qualification") value.qualification.passed = false;
    expect(() => validateAnalyticsNative(value, "analytics-250k")).toThrow();
  });
  it("enforces Economics cold percentiles from actual samples", () => {
    const value = analyticsNative();
    const target = value.profiles[0]; target.p95Ms = 2000; target.p99Ms = 2000;
    for (const sample of value.samples.filter((row) => row.operation === target.operation && row.cacheState === target.cacheState && row.concurrency === target.concurrency && row.writer === target.writer)) sample.durationMs = 2000;
    expect(() => validateAnalyticsNative(value, "analytics-250k")).toThrow(/p95/u);
  });
  it("qualifies the distinct growth smoke without inventing percentile claims", () => {
    const value = analyticsNative(true);
    expect(validateAnalyticsNative(value, "analytics-1m").samples).toBe(32);
    value.deliveries[0].operation = "arbitrary-substitute";
    expect(() => validateAnalyticsNative(value, "analytics-1m")).toThrow(/delivery profiles/u);
  });
  it("refuses native checkpoints or failed qualifications hidden in green envelopes", () => {
    for (const value of [{ qualification: { passed: false, violations: [] } }, { progress: { status: "running" } }]) expect(() => validateNativeArtifact(value, {})).toThrow(/native/u);
  });
  it.each(["smoke", "mixed-duration", "missing-case", "restart", "cleanup", "backlog", "identity"])("rejects incomplete soak %s", (fault) => {
    const identities = { applicationSha: "a".repeat(40), frontSha: "b".repeat(40) };
    const value = soakNative(identities);
    expect(validateSoakNative(value, identities).deterministicRequests).toBe(10000);
    if (fault === "smoke") { value.mode = "smoke"; value.smokeState = "passed"; }
    if (fault === "mixed-duration") value.mixedDurationMs = 300000;
    if (fault === "missing-case") for (const row of value.clients) if (row.case === "stream-reset") row.case = "json";
    if (fault === "restart") value.cutovers[0].state = "failed";
    if (fault === "cleanup") value.cleanup.gateway = { ...clean, processesGone: false };
    if (fault === "backlog") value.quiescentResources = [{ ...value.quiescentResources[0], queued: 1 }, ...value.quiescentResources.slice(1)];
    if (fault === "identity") value.front.sha = "c".repeat(40);
    expect(() => validateSoakNative(value, identities)).toThrow();
  });
  it.each(["browser", "cli", "container", "soak"])("rejects a generic green object as native %s proof", async (id) => {
    const f = fixture(); const gate = f.gate(id);
    gate.native = f.raw; gate.artifacts = [f.raw];
    await expect(validateGate(f.evidence, id, f.put("generic.json", gate), f.identities)).rejects.toThrow(/native/u);
  });
  it("refuses metadata-only migration and omitted browser scripts", async () => {
    const f = fixture();
    const cli = f.gate("cli"); const native = JSON.parse(readFileSync(join(f.evidence, cli.native.path)));
    native.persistence.seededSchemaSha256 = native.persistence.reopenedSchemaSha256;
    cli.native = f.put("stamp-only.json", native); cli.artifacts = [cli.native];
    await expect(validateGate(f.evidence, "cli", f.put("stamp-gate.json", cli), f.identities)).rejects.toThrow(/actual older schema/u);
    const browser = f.gate("browser"); const report = JSON.parse(readFileSync(join(f.evidence, browser.native.path)));
    report.cases.pop(); browser.native = f.put("omitted-script.json", report); browser.artifacts = [browser.native];
    await expect(validateGate(f.evidence, "browser", f.put("omitted-gate.json", browser), f.identities)).rejects.toThrow(/inventory incomplete/u);
  });
  it("requires four exact-window safety audits backed by retained source hashes", () => {
    const f = fixture(); const window = { start: time.startedAt, end: time.finishedAt, durationMs: 90000000 };
    const observation = { releaseId: "a".repeat(64), window, counts: { naturalLogicalRequests: 1000 } };
    const audit = (scope, measurements) => ({ scope, source: f.put(`${scope}-audit.json`, { schema: `tokenproxy-live-${scope}-audit-v1`, state: "passed", ...f.identities, releaseId: observation.releaseId, window, unobservable: [], inputs: [f.raw], ...measurements }) });
    const closure = { schema: "tokenproxy-live-safety-closure-v1", state: "passed", ...f.identities, releaseId: observation.releaseId, window, audits: [
      audit("replay", { logicalRequests: 1000, physicalAttempts: 1100, unsafeReplays: [], unresolvedAttempts: [] }),
      audit("secret-scan", { scannedFiles: 1, scannedBytes: readFileSync(join(f.evidence, f.raw.path)).length, sinks: ["api", "exception", "log", "trace"], findings: [], omittedSources: [] }),
      audit("acknowledged-writes", { acknowledged: 1000, reconciled: 1000, missing: [], unreadable: [] }),
      audit("front-evictions", { beginCounter: 5, endCounter: 5, delta: 0, counterEpoch: "retained-front-process" }),
    ] };
    expect(() => validateSafetyClosure(f.evidence, closure, observation, f.identities)).not.toThrow();
    const wrongWindow = { ...closure, window: { ...window, durationMs: 1 } };
    expect(() => validateSafetyClosure(f.evidence, wrongWindow, observation, f.identities)).toThrow(/exact observation window/u);
    closure.audits.pop();
    expect(() => validateSafetyClosure(f.evidence, closure, observation, f.identities)).toThrow(/inventory incomplete/u);
  });
  it("invokes the candidate observer and propagates authentication rejection despite a green summary", async () => {
    const f = fixture();
    mkdirSync(join(f.repo, "scripts/qa"), { recursive: true });
    writeFileSync(join(f.repo, "scripts/qa/observe-production.mjs"), "export function assembleObservation(){throw new Error('native snapshot authentication rejected');}\n");
    f.git("add", "scripts/qa/observe-production.mjs"); f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "test: native observer fixture");
    const identities = { ...f.identities, applicationSha: f.git("rev-parse", "HEAD") };
    const gate = { ...f.gate("production-observation"), ...identities };
    gate.observation = { begin: f.put("begin.json", { status: { backend_build_sha: identities.applicationSha } }), end: f.put("end.json", { status: { backend_build_sha: identities.applicationSha } }), keyring: f.put("keyring.json", {}) };
    await expect(validateGate(f.evidence, "production-observation", f.put("observation-auth.json", gate), identities, { repositoryRoot: f.repo })).rejects.toThrow("native snapshot authentication rejected");
    writeFileSync(join(f.repo, "scripts/qa/observe-production.mjs"), "export function assembleObservation(){return {outcomeGatePassed:true};}\n");
    await expect(validateGate(f.evidence, "production-observation", f.put("observation-drift.json", gate), identities, { repositoryRoot: f.repo })).rejects.toThrow("uncommitted changes");
  });
});
