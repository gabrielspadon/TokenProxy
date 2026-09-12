#!/usr/bin/env node
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidateFileHash, hash, loadRiskScope, requireThat, SHA, SHA256, validateCoverage, validateMutation, validatePythonCoverage, verifyCandidateSource } from "./risk-scope.mjs";

export const GATE_CHECKS = Object.freeze({
  "offline-suite": ["fullInventory", "zeroUnexpectedFailures", "zeroUnresolvedExemptions", "isolationCanary"],
  "front-lifecycle": ["resetCleanup", "healthyStreamLifetime", "quietWindow", "controllerFailure", "noEvictions"],
  "deploy-rollback": ["allPhasesInjected", "postResumeRollback", "schemaCompatibility", "dataPreserved"],
  "analytics-250k": ["correctness", "projectionParity", "writerOverlap", "responsiveHealth", "loadIsolation"],
  "analytics-1m": ["correctness", "projectionParity", "writerOverlap", "loadIsolation"],
  "protocol-matrix": ["allFormats", "streaming", "nonstreaming", "binaryProtocols", "modalities", "sourceImmutable", "saverSemantics"],
  standalone: ["exactIdentity", "capabilities", "migration", "reopen", "cleanShutdown"],
  cli: ["pack", "install", "exactIdentity", "capabilities", "migration", "reopen", "cleanShutdown"],
  browser: ["trackedInventory", "specializedWorkflows", "keyboardFocus", "accessibility", "authenticatedDashboard"],
  container: ["exactIdentity", "capabilities", "volumeRestart", "cleanShutdown", "sbom", "provenance"],
  "risk-coverage": ["completeScope", "threshold"],
  "risk-mutation": ["completeScope", "threshold", "survivorsReviewed"],
  "front-risk-coverage": ["completeScope", "threshold"],
  "front-risk-mutation": ["completeScope", "threshold", "survivorsReviewed"],
  "deploy-driver-coverage": ["completeScope", "threshold"],
  "failure-matrix": ["noProxyLoss", "noUnsafeReplay", "noStalePending", "resourcesReleased"],
  soak: ["noProxyLoss", "noUnsafeReplay", "noStalePending", "resourceSlopes", "repeatedCutovers"],
  "independent-review": ["independentReviewer", "allFindingsResolved", "crossRepositoryCompatibility"],
  "hosted-ci": ["allRequiredChecks", "zeroUnresolvedReviewThreads"],
  "backup-restore": ["readableBackup", "restoredDatabase", "criticalWritesPreserved"],
  "migration-compatibility": ["oldPackageReopen", "newPackageReopen", "preservedWrites"],
  deployment: ["exactInstalledPair", "pauseBudget", "noDroppedRequests", "noEvictions", "authenticatedDashboard"],
  "production-observation": ["completeOutcomes", "providerFailuresSeparated", "callerCancellationsSeparated", "noUnsafeReplay", "noSecretExposure", "noDataLoss", "noEvictions"],
});
export const DELIVERY_GATES = ["deployment", "production-observation"];

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function nonempty(value, label) { requireThat(typeof value === "string" && value.trim().length > 0, `${label} is required`); }
function integer(value, minimum, label) { requireThat(Number.isInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`); }
function below(value, maximum, label) { requireThat(Number.isFinite(value) && value >= 0 && value < maximum, `${label} must be below ${maximum}`); }
function interval(value, label) {
  const start = Date.parse(value.startedAt);
  const finish = Date.parse(value.finishedAt);
  requireThat(typeof value.startedAt === "string" && value.startedAt.endsWith("Z") && typeof value.finishedAt === "string" && value.finishedAt.endsWith("Z") && Number.isFinite(start) && Number.isFinite(finish) && finish >= start, `${label} has no terminal UTC interval`);
  requireThat(finish <= Date.now() + 60_000, `${label} finishes in the future`);
  return finish - start;
}

export function readArtifact(root, reference) {
  requireThat(reference && typeof reference.path === "string" && !isAbsolute(reference.path) && SHA256.test(reference.sha256), "artifact requires relative path and SHA256");
  const base = realpathSync(root);
  const path = realpathSync(resolve(base, reference.path));
  const rel = relative(base, path);
  requireThat(rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel), "artifact escapes evidence directory");
  requireThat(statSync(path).isFile(), "artifact must be a regular file");
  const bytes = readFileSync(path);
  requireThat(hash(bytes) === reference.sha256, `artifact hash mismatch: ${reference.path}`);
  return { path, bytes };
}

export const ANALYTICS_OPERATIONS = Object.freeze(["economics-page-population", "economics-filtered-provider", "economics-items", "activity-summary-groups"]);
const SOAK_CASES = ["json", "stream", "sustained", "cancel", "provider-reject", "stream-reset", "malformed", "unauthorized", "unknown-model"];
const empty = (value) => Array.isArray(value) && value.length === 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const clean = (value) => value?.listenerGone === true && value.processesGone === true && value.graceful === true && value.forced === false && value.exitCode === 0;
const profileKey = (value) => `${value.operation}/${value.cacheState}/${value.concurrency}/${value.writer}`;
function resourceSlope(samples, field) {
  requireThat(samples.length >= 6 && samples.every((row) => Number.isFinite(row.elapsedMs) && Number.isFinite(row[field]) && row[field] >= 0), `native ${field} samples missing`);
  const xs = samples.map((row) => (row.elapsedMs - samples[0].elapsedMs) / 60000);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = samples.reduce((sum, row) => sum + row[field], 0) / samples.length;
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  requireThat(denominator > 0, "native resource sample interval is empty");
  const slopePerMinute = samples.reduce((sum, row, index) => sum + (xs[index] - mx) * (row[field] - my), 0) / denominator;
  const growing = samples.at(-1)[field] > samples[0][field] && samples.every((row, index) => index === 0 || row[field] >= samples[index - 1][field]);
  return { samples: samples.length, slopePerMinute, monotonicallyGrowing: growing };
}

export function validateAnalyticsNative(value, id) {
  requireThat(value.fixture?.version === "economics-analytics-v1" && value.isolatedTemporaryData === true, "analytics native synthetic fixture missing");
  const minimum = id === "analytics-1m" ? 1000000 : 250000;
  for (const field of ["rowsPerTable", "requestRows", "usageRows"]) integer(value.fixture[field], minimum, `analytics ${field}`);
  requireThat(value.progress?.status === "qualification-passed" && value.qualification?.passed === true && empty(value.qualification.violations) && empty(value.failures), "analytics native qualification is incomplete or failed");
  const affinity = value.settings?.affinityPreflight;
  requireThat(affinity?.accepted === true && affinity.busyThresholdPercent === 20 && empty(affinity.busyCores) && affinity.cores?.length > 0 && same(affinity.allowedCores, affinity.selectedCores) && same(affinity.cores.map((row) => row.cpu), affinity.selectedCores) && affinity.cores.every((row) => Number.isFinite(row.busyPercent) && row.busyPercent >= 0 && row.busyPercent < 20), "analytics load isolation preflight missing or contradictory");
  below(value.peakAnalyticsProcessRssBytes, 512 * 1024 * 1024, "analytics native RSS bytes");
  const writer = value.syntheticWriteHealth;
  integer(writer?.writes, 1, "analytics synthetic writes");
  requireThat(writer.failures === 0, "analytics writer failures remain");
  requireThat(Array.isArray(value.plans) && same(value.plans.map((row) => row.operation).sort(), [...ANALYTICS_OPERATIONS].sort()) && value.plans.every((row) => row.steps?.length > 0), "analytics required operation plans missing");
  const parity = (row, growth = false) => requireThat(row && (growth ? row.requestRows === value.fixture.requestRows && row.usageRows === value.fixture.usageRows : row.sourceRows === value.fixture.usageRows) && row.projectionRows === value.fixture.usageRows && row.missingRows === 0 && row.orphanRows === 0, "analytics projection parity failed");
  if (id === "analytics-1m") {
    requireThat(value.latencyQualified === false && value.fixture.completed === true && value.fixture.freshProcessOnly === true && value.labels?.includes("growth-smoke"), "growth native qualification scope missing");
    requireThat(value.progress.completedDeliveries === 32 && value.progress.scheduledDeliveries === 32 && value.progress.completedComputations === 16 && value.progress.scheduledComputations === 16 && value.deliveries?.length === 32 && value.computations?.length === 16 && writer.computationCoverage?.length === 4, "growth operation inventory incomplete");
    requireThat(value.settings?.affinityPreflight?.accepted === true, "growth load isolation preflight missing");
    parity(writer.parity?.before, true); parity(writer.parity?.after, true);
    const ordinals = (rows, field) => rows.map((row) => row[field]).sort((a, b) => a - b).join(",");
    for (const operation of ANALYTICS_OPERATIONS) {
      const deliveries = value.deliveries.filter((row) => row.operation === operation);
      const computations = value.computations.filter((row) => row.operation === operation);
      requireThat(deliveries.length === 8 && ordinals(deliveries.filter((row) => row.concurrency === 1 && row.writer === false), "iteration") === "1,2,3" && ordinals(deliveries.filter((row) => row.concurrency === 5 && row.writer === true), "deliveryOrdinal") === "1,2,3,4,5", "growth required delivery profiles incomplete");
      requireThat(computations.length === 4 && ordinals(computations.filter((row) => row.concurrency === 1 && row.writer === false), "iteration") === "1,2,3" && computations.filter((row) => row.concurrency === 5 && row.writer === true).length === 1, "growth required computation profiles incomplete");
      const coverage = writer.computationCoverage.filter((row) => row.operation === operation);
      requireThat(coverage.length === 1 && coverage[0].committedWritesWithinWorkerSnapshot >= 1, "growth worker snapshot write overlap missing");
    }
    requireThat(value.correctnessOracles?.length === 4 && same(value.correctnessOracles.map((row) => row.operation).sort(), [...ANALYTICS_OPERATIONS].sort()), "growth independent correctness inventory missing");
    for (const row of value.computations) below(row.durationMs, 15000, "growth computation deadline ms");
    return { requestRows: value.fixture.requestRows, usageRows: value.fixture.usageRows, workerPeakRssBytes: value.peakAnalyticsProcessRssBytes, samples: 32, failures: 0 };
  }
  requireThat(Array.isArray(value.profiles) && value.profiles.length === 24 && Array.isArray(value.samples) && value.samples.length === 2400, "analytics requires all 24 profiles and 2400 samples");
  requireThat(value.progress.completedSamples === 2400 && value.progress.scheduledSamples === 2400 && value.progress.completedProfiles === 24 && value.progress.scheduledProfiles === 24, "analytics native progress is incomplete");
  parity(writer.projectionParity);
  requireThat(Array.isArray(writer.computationCoverage) && writer.computationCoverage.length === 240 && writer.computations === 240 && writer.minimumCommittedWritesWithinWorkerSnapshot >= 1, "analytics worker snapshot coverage incomplete");
  const seen = new Set();
  for (const operation of ANALYTICS_OPERATIONS) for (const concurrency of [1, 5]) for (const [cacheState, writing, count] of [["result-cache-cold", false, 50], ["result-cache-warm", false, 200], ["result-cache-cold", true, 50]]) {
    const key = profileKey({ operation, cacheState, concurrency, writer: writing });
    const profiles = value.profiles.filter((row) => profileKey(row) === key);
    const rows = value.samples.filter((row) => profileKey(row) === key);
    requireThat(profiles.length === 1 && rows.length === count, `analytics required profile missing or duplicated: ${key}`);
    const profile = profiles[0]; seen.add(key);
    requireThat(profile.count === count && profile.latencyQualified === operation.startsWith("economics-"), "analytics sample count or latency scope changed");
    requireThat(rows.every((row) => Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.delivery === (cacheState === "result-cache-warm" ? "cache-hit" : "computed")), "analytics samples have invalid timing or cache delivery");
    requireThat(profile.p95Ms === percentile(rows.map((row) => row.durationMs), 0.95) && profile.p99Ms === percentile(rows.map((row) => row.durationMs), 0.99), "analytics headline disagrees with raw samples");
    if (profile.latencyQualified && cacheState === "result-cache-cold") { below(profile.p95Ms, 2000, "Economics p95 ms"); below(profile.p99Ms, 5000, "Economics p99 ms"); }
    if (writing) {
      const coverage = writer.computationCoverage.filter((row) => row.operation === operation && row.concurrency === concurrency);
      requireThat(coverage.length === 50 / concurrency && coverage.every((row) => row.committedWritesWithinWorkerSnapshot >= 1 && Number.isFinite(Date.parse(row.snapshotStartedAt)) && Date.parse(row.snapshotCompletedAt) >= Date.parse(row.snapshotStartedAt)), "analytics worker snapshot write overlap missing");
    }
  }
  requireThat(seen.size === 24 && value.samples.every((row) => seen.has(profileKey(row))), "analytics profile inventory changed");
  return { requestRows: value.fixture.requestRows, usageRows: value.fixture.usageRows, workerPeakRssBytes: value.peakAnalyticsProcessRssBytes, populations: value.profiles };
}

export function validateSoakNative(value, identities) {
  requireThat(value.schema === "tokenproxy-reliability-soak-v1" && value.state === "passed" && value.mode === "full" && empty(value.errors), "soak native full qualification missing or failed");
  requireThat(value.candidate?.sha === identities.applicationSha && value.front?.sha === identities.frontSha && SHA256.test(value.candidate.artifactSha256) && value.artifactUnchanged === true, "soak native candidate/front/artifact identity mismatch");
  integer(value.deterministicCompleted, 10000, "native deterministic requests");
  requireThat(value.mixedDurationMs >= 3600000 && interval(value, "native soak") >= value.mixedDurationMs, "native mixed phase is shorter than 60 minutes");
  requireThat(Array.isArray(value.clients) && value.clients.every((row) => row.state === "passed") && value.clients.filter((row) => row.phase === "deterministic").length === value.deterministicCompleted, "soak client inventory incomplete");
  requireThat(new Set(value.clients.map((row) => row.id)).size === value.clients.length && value.clients.every((row) => typeof row.id === "string" && row.id.length > 0), "soak client identities missing or duplicated");
  requireThat(value.clients.some((row) => row.phase === "mixed" && row.case === "sustained" && row.durationMs >= 30000 && row.receivedContent === true && row.terminalFrame === true), "soak sustained mixed traffic missing");
  requireThat(SOAK_CASES.every((name) => value.clients.some((row) => row.phase === "deterministic" && row.case === name)), "soak failure case inventory incomplete");
  requireThat(value.cutovers?.length >= 6 && value.cutovers.every((row) => row.state === "passed" && row.kind === "same-artifact-quiet-restart" && row.artifactSha === identities.applicationSha && row.pauseMs < 4000), "soak quiet restart evidence incomplete");
  requireThat(value.dashboard?.length > 0 && value.dashboard.every((row) => row.state === "passed") && clean(value.cleanup?.front) && clean(value.cleanup?.gateway) && value.cleanup?.provider === true, "soak dashboard or owned cleanup incomplete");
  requireThat(value.reconciliation?.state === "passed" && empty(value.reconciliation.violations) && value.reconciliation.unsafeReplay === 0 && value.reconciliation.stalePending === 0 && value.reconciliation.clients === value.clients.length, "soak terminal reconciliation failed");
  requireThat(value.resources?.length > 1 && value.quiescentResources?.length >= 6 && value.quiescentResources.every((row) => ["queued", "active", "dispatching", "providerActive"].every((key) => row[key] === 0)), "soak resource inventory incomplete or backlog remains");
  const quiescent = value.quiescentResources.filter((row) => row.phase === "mixed");
  for (const key of ["frontRssBytes", "gatewayRssBytes", "frontFdCount", "gatewayFdCount", "queued"]) {
    const measured = resourceSlope(quiescent, key), summary = value.quiescentSummary?.[key];
    requireThat(summary?.samples === measured.samples && summary.slopePerMinute === measured.slopePerMinute && summary.monotonicallyGrowing === measured.monotonicallyGrowing && !measured.monotonicallyGrowing, `soak ${key} resource proof missing, contradictory or growing`);
  }
  return { requests: value.clients.length, deterministicRequests: value.deterministicCompleted, mixedRequests: value.clients.filter((row) => row.phase === "mixed").length, mixedElapsedMs: value.mixedDurationMs, cutovers: value.cutovers.length, backlogSlope: value.quiescentSummary.queued.slopePerMinute, rssSlopeBytesPerMinute: value.quiescentSummary.frontRssBytes.slopePerMinute };
}

export function validateNativeArtifact(value, identities) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const sha of [value.gitSha, value.candidate?.sha, value.applicationSha]) {
    if (sha !== undefined) requireThat(sha === identities.applicationSha, "raw evidence belongs to another application revision");
  }
  if (value.state !== undefined) requireThat(value.state === "passed", "raw evidence is not passed");
  if (value.passed !== undefined) requireThat(value.passed !== false, "raw evidence reports a failed assertion");
  if (value.qualification !== undefined) requireThat(value.qualification.passed === true && empty(value.qualification.violations), "raw native qualification is incomplete or failed");
  if (value.progress?.status !== undefined) requireThat(value.progress.status === "qualification-passed", "raw native progress is incomplete");
  if (/tokenproxy-(standalone|cli-package|started-artifact)-qualification-v1/u.test(value.schema || "")) {
    requireThat(value.persistence?.reopened === true && value.persistence?.seeded === true && value.starts?.length === 2, "started artifact lacks persistence or restart proof");
    requireThat(value.capability?.passed === 36 && value.capability?.manifestCells === 121, "started artifact capability inventory incomplete");
    for (const run of value.starts) {
      requireThat(!run.error && run.readiness?.buildSha === identities.applicationSha && run.version?.buildSha === identities.applicationSha, "started artifact serves an incorrect identity");
      requireThat(clean(run.cleanup), "started artifact cleanup incomplete");
    }
  }
}

function validateMeasurements(id, receipt) {
  const metrics = receipt.metrics || {};
  if (["risk-coverage", "front-risk-coverage", "deploy-driver-coverage"].includes(id)) requireThat(Number.isFinite(metrics.branchPercentage) && metrics.branchPercentage >= 90 && metrics.branchPercentage <= 100, "risk branch coverage below 90% or invalid");
  if (["risk-mutation", "front-risk-mutation"].includes(id)) {
    requireThat(Number.isFinite(metrics.mutationScore) && metrics.mutationScore >= 60 && metrics.mutationScore <= 100, "mutation score below 60% or invalid");
    requireThat(metrics.unreviewedSurvivors === 0, "unreviewed mutation survivors remain");
  }
  if (id === "failure-matrix") integer(metrics.requests, 10000, "deterministic requests");
  if (id === "soak") {
    requireThat(interval(receipt, id) >= 3600000, "mixed-traffic soak is shorter than 60 minutes");
    integer(metrics.requests, 1, "soak requests");
    integer(metrics.cutovers, 6, "soak cutovers");
    requireThat(Number.isFinite(metrics.backlogSlope) && metrics.backlogSlope <= 0 && Number.isFinite(metrics.rssSlopeBytesPerMinute), "soak resource slopes missing or backlog growing");
  }
  if (id === "deployment") below(metrics.pauseMs, 4000, "admission pause ms");
  if (id === "production-observation") {
    requireThat(interval(receipt, id) >= 86400000, "production observation is shorter than 24 hours");
    integer(metrics.logicalRequests, 1000, "natural logical requests");
    requireThat(metrics.syntheticGenerationRequests === 0, "production observation includes synthetic generation requests");
    integer(metrics.proxyUnexpectedFailures, 0, "proxy unexpected failures");
    below(metrics.proxyUnexpectedFailures / metrics.logicalRequests, 0.001, "proxy-attributable failure rate");
  }
}

function validateNamedFailureCases(root, manifest, gate) {
  const inventory = JSON.parse(readArtifact(root, manifest.namedFailureCases).bytes);
  requireThat(inventory.schema === "tokenproxy-named-failure-cases-v1" && inventory.applicationSha === manifest.applicationSha && Array.isArray(inventory.cases) && inventory.cases.length > 0, "named failure case inventory is missing or belongs to another candidate");
  const report = JSON.parse(readArtifact(root, gate.testReport).bytes);
  requireThat(Array.isArray(report.testResults), "named failure cases require the raw test runner report");
  const ids = new Set();
  for (const required of inventory.cases) {
    nonempty(required.id, "failure case ID"); nonempty(required.file, "failure case file"); nonempty(required.fullName, "failure case assertion");
    requireThat(!ids.has(required.id), "duplicate named failure case"); ids.add(required.id);
    const matchingFiles = report.testResults.filter((result) => typeof result.name === "string" && (result.name === required.file || result.name.replaceAll("\\", "/").endsWith(`/${required.file}`)));
    requireThat(matchingFiles.length === 1 && matchingFiles[0].status === "passed", `named failure case file did not pass: ${required.id}`);
    const assertions = matchingFiles[0].assertionResults?.filter((assertion) => assertion.fullName === required.fullName);
    requireThat(assertions?.length === 1 && assertions[0].status === "passed", `named failure case did not pass: ${required.id}`);
  }
  return { cases: ids.size, inventory: manifest.namedFailureCases };
}

function validatePrimaryMatrix(value) {
  requireThat(value?.primary?.passed === 36 && value.primary.dispatched + value.primary.rejectedBeforeUpstream === 36, "native primary capability inventory incomplete");
  requireThat(value.receipts?.nextGatewayResponses === 39 && value.receipts.providerIngress?.delta === value.primary.dispatched + 3 && value.receipts.providerDispatch?.delta === value.primary.dispatched + 3, "native capability dispatch accounting incomplete");
}

function validateProductNative(value, id, identities) {
  const schema = { standalone: "tokenproxy-standalone-qualification-v1", cli: "tokenproxy-cli-package-qualification-v1", browser: "tokenproxy-browser-qualification-v1", container: "tokenproxy-container-qualification-v1" }[id];
  requireThat(value.schema === schema && value.state === "passed" && value.candidate?.sha === identities.applicationSha, `${id} native qualification or identity missing`);
  if (["standalone", "cli"].includes(id)) {
    validatePrimaryMatrix(value.capability?.report);
    const persisted = value.persistence;
    requireThat(persisted?.migrationExercised === true && SHA256.test(persisted.seededSchemaSha256) && SHA256.test(persisted.reopenedSchemaSha256) && persisted.seededSchemaSha256 !== persisted.reopenedSchemaSha256 && (persisted.seededSchemaVersion < persisted.reopenedSchemaVersion || persisted.seededLayoutVersion < persisted.reopenedLayoutVersion), "native artifact migration requires an actual older schema fixture");
    if (id === "cli") requireThat(value.install?.scriptsExecuted === true && value.install.privateHome === true && value.install.buildSha === identities.applicationSha && value.pack, "CLI native pack/install evidence incomplete");
  }
  if (id === "browser") {
    const inventory = value.inventory;
    requireThat(SHA256.test(inventory?.manifestSha256) && inventory.playwright?.length > 0 && inventory.scripts?.length > 0 && Array.isArray(inventory.supportingModules), "browser native tracked inventory missing");
    requireThat(inventory.scripts.every((row) => row.disposition === "execute" && row.owner && row.reason), "browser executable script was excluded");
    const expected = [...inventory.playwright, ...inventory.scripts.map((row) => row.file)].sort();
    requireThat(value.cases?.length === expected.length && new Set(expected).size === expected.length && same(value.cases.map((row) => row.file).sort(), expected), "browser native execution inventory incomplete");
    requireThat(value.build?.sha === identities.applicationSha && SHA256.test(value.build.artifactManifestHash), "browser native build binding missing");
    for (const row of value.cases) {
      requireThat(row.state === "passed" && row.exitCode === 0 && row.report?.passed === true && row.identity?.ready?.buildSha === identities.applicationSha && row.identity.version?.buildSha === identities.applicationSha && row.stop?.stopped === true && row.stop.ownershipEndpointClosed === true && !row.cleanupError, "browser native case failed or cleanup missing");
      if (row.kind === "spec") requireThat(row.report.complete === true && row.report.expected > 0 && row.report.expected === row.report.executed && empty(row.report.failures) && empty(row.report.errors), "browser native spec collection incomplete");
      if (row.secondaryFixture) requireThat(row.secondaryStop?.stopped === true && row.secondaryStop.ownershipEndpointClosed === true, "browser secondary fixture cleanup missing");
    }
  }
  if (id === "container") {
    requireThat(/^sha256:[a-f0-9]{64}$/u.test(value.image?.id || "") && value.network?.internal === true && value.network.removed === true && value.starts?.length === 2 && value.starts[0].startedAt !== value.starts[1].startedAt, "container immutable image or restart/network proof missing");
    requireThat(value.persistence?.reopened === true && value.persistence.fixtureAuthorizationWorkedAfterRestart === true && value.cleanup?.length === 2 && value.cleanup.every((row) => row.removed === true && row.stopped === true && row.clean === true && row.exitCode === 0 && !row.oomKilled), "container persistence or cleanup incomplete");
    for (const row of value.starts) {
      requireThat(row.readiness?.buildSha === identities.applicationSha && row.version?.buildSha === identities.applicationSha && row.dockerHealth === "healthy" && row.stop?.clean === true, "container native health or identity mismatch");
      validatePrimaryMatrix(row.capability);
    }
  }
}

export function validateSafetyClosure(root, value, observation, identities) {
  requireThat(value.schema === "tokenproxy-live-safety-closure-v1" && value.state === "passed" && value.releaseId === observation.releaseId && same(value.window, observation.window), "live safety closure must bind the exact observation window and release");
  for (const key of ["applicationSha", "frontSha", "deploySha"]) requireThat(value[key] === identities[key], "live safety closure revision mismatch");
  const expected = ["replay", "secret-scan", "acknowledged-writes", "front-evictions"];
  requireThat(Array.isArray(value.audits) && same(value.audits.map((audit) => audit.scope).sort(), expected.sort()), "live safety closure audit inventory incomplete");
  for (const audit of value.audits) {
    const source = JSON.parse(readArtifact(root, audit.source).bytes);
    requireThat(source.schema === `tokenproxy-live-${audit.scope}-audit-v1` && source.state === "passed" && source.releaseId === observation.releaseId && same(source.window, observation.window) && empty(source.unobservable), "live safety source is failed, unobservable or outside the observation window");
    for (const key of ["applicationSha", "frontSha", "deploySha"]) requireThat(source[key] === identities[key], "live safety source revision mismatch");
    requireThat(source.inputs?.length > 0, "live safety raw source references missing");
    const sources = source.inputs.map((input) => readArtifact(root, input));
    if (audit.scope === "replay") {
      integer(source.logicalRequests, observation.counts.naturalLogicalRequests, "audited natural requests");
      integer(source.physicalAttempts, 1, "audited physical attempts");
      requireThat(empty(source.unsafeReplays) && empty(source.unresolvedAttempts), "live replay safety remains unresolved");
    } else if (audit.scope === "secret-scan") {
      integer(source.scannedFiles, 1, "scanned log/API/trace files"); integer(source.scannedBytes, 1, "scanned bytes");
      requireThat(source.scannedFiles === sources.length && source.scannedBytes === sources.reduce((sum, input) => sum + input.bytes.length, 0), "live credential scan inventory disagrees with retained bytes");
      requireThat(same(source.sinks?.slice().sort(), ["api", "exception", "log", "trace"]) && empty(source.findings) && empty(source.omittedSources), "live credential scan has findings or missing sinks");
    } else if (audit.scope === "acknowledged-writes") {
      integer(source.acknowledged, 1, "acknowledged writes");
      requireThat(source.reconciled === source.acknowledged && empty(source.missing) && empty(source.unreadable), "acknowledged live writes did not reconcile");
    } else {
      integer(source.beginCounter, 0, "initial eviction counter"); integer(source.endCounter, 0, "final eviction counter");
      requireThat(source.counterEpoch && source.endCounter === source.beginCounter && source.delta === 0, "live deployment evictions occurred or counter epoch missing");
    }
  }
}

async function validateObservationNative(root, receipt, native, identities, repositoryRoot) {
  requireThat(native.kind === "production-observation-result" && native.schemaVersion === 1, "native production outcome result missing");
  const refs = receipt.observation;
  const begin = JSON.parse(readArtifact(root, refs?.begin).bytes);
  const end = JSON.parse(readArtifact(root, refs?.end).bytes);
  const keyringPath = readArtifact(root, refs?.keyring).path;
  requireThat(begin.status?.backend_build_sha === identities.applicationSha && end.status?.backend_build_sha === identities.applicationSha, "observation backend identity mismatch");
  verifyCandidateSource(repositoryRoot, identities.applicationSha);
  const { assembleObservation } = await import(pathToFileURL(resolve(repositoryRoot, "scripts/qa/observe-production.mjs")).href);
  const derived = assembleObservation({ begin, end, keyringPath });
  requireThat(same(native, derived), "observation result does not match the authenticated source snapshots");
  requireThat(derived.outcomeGatePassed === true && empty(derived.failures) && derived.counts.unknown === 0 && derived.exclusions.untrustedOriginOrClass === 0, "native observation outcome gate failed");
  requireThat(same(derived.remainingReleaseGates?.slice().sort(), ["acknowledged-data-loss", "deployment-eviction", "secret-exposure", "unsafe-replay"]), "native observation safety scope changed and requires an explicit closure contract");
  requireThat(Date.parse(receipt.startedAt) <= Date.parse(derived.window.start) && Date.parse(receipt.finishedAt) >= Date.parse(derived.window.end), "observation gate interval does not cover authenticated window");
  validateSafetyClosure(root, JSON.parse(readArtifact(root, receipt.safetyClosure).bytes), derived, identities);
  const syntheticGenerationRequests = end.segments.flatMap((segment) => segment.events).filter((event) => event.kind === "start" && ["test", "import"].includes(event.dataOrigin) && event.requestClass === "inference" && event.firstObservedAt >= derived.window.start && event.firstObservedAt < derived.window.end).length;
  return { logicalRequests: derived.counts.naturalLogicalRequests, proxyUnexpectedFailures: derived.counts.proxyFailure, syntheticGenerationRequests };
}

export async function validateGate(root, id, reference, identities, { repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..") } = {}) {
  const { bytes } = readArtifact(root, reference);
  const receipt = JSON.parse(bytes);
  requireThat(receipt.schema === "tokenproxy-release-gate-v1" && receipt.gate === id, `wrong gate receipt: ${id}`);
  requireThat(receipt.state === "passed", `required gate ${id} is ${receipt.state || "missing state"}`);
  for (const key of ["applicationSha", "frontSha", "deploySha"]) requireThat(receipt[key] === identities[key], `gate ${id} has a mismatched ${key}`);
  nonempty(receipt.taskId, `${id} task ID`);
  nonempty(receipt.runtime?.node, `${id} runtime version`);
  requireThat(receipt.dependencies && Object.keys(receipt.dependencies).length > 0 && Object.values(receipt.dependencies).every((version) => typeof version === "string" && version.length > 0), `${id} dependency versions missing`);
  interval(receipt, id);
  requireThat(Array.isArray(receipt.commands) && receipt.commands.length > 0, `${id} commands missing`);
  for (const command of receipt.commands) {
    requireThat(Array.isArray(command.argv) && command.argv.length > 0 && command.argv.every((arg) => typeof arg === "string"), `${id} command argv missing`);
    requireThat(command.exitCode === 0 && command.signal === null, `${id} command did not terminate successfully`);
    interval(command, `${id} command`);
    requireThat(Date.parse(command.startedAt) >= Date.parse(receipt.startedAt) && Date.parse(command.finishedAt) <= Date.parse(receipt.finishedAt), `${id} command lies outside gate interval`);
    readArtifact(root, command.stdout);
    readArtifact(root, command.stderr);
  }
  requireThat(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, `${id} raw artifacts missing`);
  for (const artifact of receipt.artifacts) {
    const { bytes: raw } = readArtifact(root, artifact);
    if (artifact.path.endsWith(".json")) validateNativeArtifact(JSON.parse(raw), { ...identities, applicationSha: id.startsWith("front-") ? identities.frontSha : identities.applicationSha });
  }
  requireThat(Array.isArray(receipt.fixtures), `${id} fixture/profile inventory missing`);
  for (const fixture of receipt.fixtures) readArtifact(root, fixture);
  for (const check of GATE_CHECKS[id] || []) requireThat(receipt.checks?.[check] === true, `${id} missing successful check ${check}`);
  requireThat(Array.isArray(receipt.skips), `${id} skip inventory missing`);
  for (const skip of receipt.skips) {
    nonempty(skip.id, "skip ID"); nonempty(skip.owner, "skip owner"); nonempty(skip.reason, "skip reason");
    requireThat(skip.required === false && ["live-inference-unqualified", "unsupported-platform-unqualified"].includes(skip.state), `${id} contains an unqualified required case`);
  }
  const nativeGates = ["offline-suite", "analytics-250k", "analytics-1m", "protocol-matrix", "standalone", "cli", "browser", "container", "failure-matrix", "soak", "production-observation"];
  if (nativeGates.includes(id)) {
    requireThat(receipt.native && receipt.artifacts.some((artifact) => same(artifact, receipt.native)), `${id} requires a retained native producer receipt`);
    const native = JSON.parse(readArtifact(root, receipt.native).bytes);
    let derived = {};
    if (id.startsWith("analytics-")) derived = validateAnalyticsNative(native, id);
    else if (["soak", "failure-matrix"].includes(id)) {
      derived = validateSoakNative(native, identities);
      if (id === "failure-matrix") derived.requests = derived.deterministicRequests;
    } else if (id === "production-observation") derived = await validateObservationNative(root, receipt, native, identities, repositoryRoot);
    else if (id === "offline-suite") requireThat(native.scope === "offline-tests-full" && native.state === "passed" && native.gitSha === identities.applicationSha && native.runnerExit === 0 && native.gateExit === 0 && native.runnerSignal === null && !native.runnerError && native.canaryUnchanged === true && native.networkBoundary?.verified === true && empty(native.tests), "offline native full-suite isolation or execution failed");
    else if (id === "protocol-matrix") validatePrimaryMatrix(native);
    else validateProductNative(native, id, identities);
    for (const [key, value] of Object.entries(derived)) {
      if (receipt.metrics?.[key] !== undefined) requireThat(same(receipt.metrics[key], value), `${id} metric ${key} contradicts native evidence`);
    }
    receipt.metrics = { ...receipt.metrics, ...derived };
  }
  validateMeasurements(id, receipt);
  return receipt;
}

export async function assembleRelease(root, manifest, { repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..") } = {}) {
  requireThat(manifest.schema === "tokenproxy-release-input-v1", "unknown release manifest schema");
  requireThat(["offline", "delivery"].includes(manifest.stage), "stage must be offline or delivery");
  nonempty(manifest.taskId, "release task ID");
  for (const key of ["applicationSha", "frontSha", "deploySha", "baseSha"]) requireThat(SHA.test(manifest[key]), `full ${key} required`);
  const scopeArtifact = readArtifact(root, manifest.riskScope);
  const scope = loadRiskScope(scopeArtifact.path, repositoryRoot, { verifyWorktree: false });
  requireThat(scope.candidateSha === manifest.applicationSha && scope.baseSha === manifest.baseSha, "risk scope belongs to another release or baseline");
  const required = Object.keys(GATE_CHECKS).filter((gate) => manifest.stage === "delivery" || !DELIVERY_GATES.includes(gate));
  requireThat(manifest.gates && Object.keys(manifest.gates).every((gate) => gate in GATE_CHECKS), "unknown release gate");
  const gates = {};
  for (const id of required) gates[id] = await validateGate(root, id, manifest.gates[id], manifest, { repositoryRoot });
  const namedFailureCases = validateNamedFailureCases(root, manifest, gates["offline-suite"]);
  const coverage = JSON.parse(readArtifact(root, gates["risk-coverage"].report).bytes);
  const coverageResult = validateCoverage(coverage, scope, repositoryRoot);
  requireThat(gates["risk-coverage"].metrics.branchPercentage === coverageResult.percentage, "coverage headline disagrees with raw branch counters");
  const mutationArtifact = readArtifact(root, gates["risk-mutation"].report);
  const mutationReviews = JSON.parse(readArtifact(root, gates["risk-mutation"].reviews).bytes);
  const mutationResult = validateMutation(JSON.parse(mutationArtifact.bytes), scope, mutationReviews, hash(mutationArtifact.bytes), repositoryRoot);
  requireThat(gates["risk-mutation"].metrics.mutationScore === mutationResult.score, "mutation headline disagrees with raw mutant states");
  nonempty(manifest.frontRepositoryRoot, "front source repository path");
  const frontScopeArtifact = readArtifact(root, manifest.frontRiskScope);
  const frontScope = loadRiskScope(frontScopeArtifact.path, manifest.frontRepositoryRoot, { verifyWorktree: false });
  requireThat(frontScope.candidateSha === manifest.frontSha, "front risk scope belongs to another revision");
  const frontCoverage = validateCoverage(JSON.parse(readArtifact(root, gates["front-risk-coverage"].report).bytes), frontScope, manifest.frontRepositoryRoot);
  const frontMutationArtifact = readArtifact(root, gates["front-risk-mutation"].report);
  const frontMutation = validateMutation(JSON.parse(frontMutationArtifact.bytes), frontScope, JSON.parse(readArtifact(root, gates["front-risk-mutation"].reviews).bytes), hash(frontMutationArtifact.bytes), manifest.frontRepositoryRoot);
  requireThat(gates["front-risk-coverage"].metrics.branchPercentage === frontCoverage.percentage && gates["front-risk-mutation"].metrics.mutationScore === frontMutation.score, "front risk headline contradicts raw evidence");
  const deployCoverage = validatePythonCoverage(JSON.parse(readArtifact(root, gates["deploy-driver-coverage"].report).bytes), scope, repositoryRoot);
  requireThat(gates["deploy-driver-coverage"].metrics.branchPercentage === deployCoverage.percentage, "deploy-driver coverage headline contradicts raw branches");
  requireThat(Array.isArray(manifest.packages) && manifest.packages.length >= 2, "application/CLI artifact inventory missing");
  for (const kind of ["standalone", "cli"]) requireThat(manifest.packages.filter((artifact) => artifact.kind === kind).length === 1, `exactly one ${kind} artifact required`);
  for (const artifact of manifest.packages) {
    requireThat(artifact.applicationSha === manifest.applicationSha, "package belongs to another revision");
    readArtifact(root, artifact);
  }
  requireThat(Array.isArray(manifest.qualification) && manifest.qualification.length > 0, "capability qualification inventory missing");
  const capabilityIds = new Set();
  for (const capability of manifest.qualification) {
    nonempty(capability.id, "capability ID"); nonempty(capability.owner, "capability owner");
    requireThat(!capabilityIds.has(capability.id), "duplicate capability ID"); capabilityIds.add(capability.id);
    requireThat(["qualified", "live-inference-unqualified", "unsupported-platform-unqualified"].includes(capability.state), "invalid capability qualification state");
    if (capability.state !== "qualified") {
      requireThat(capability.required === false, "required capability is unqualified");
      nonempty(capability.reason, "unqualified capability reason");
    } else requireThat(Array.isArray(capability.gates) && capability.gates.length > 0 && capability.gates.every((gate) => gates[gate]), "qualified capability has no passing evidence");
  }
  const capabilityArtifact = readArtifact(root, manifest.capabilityManifest);
  requireThat(hash(capabilityArtifact.bytes) === candidateFileHash(repositoryRoot, manifest.applicationSha, "tests/contracts/capabilities.json"), "capability manifest differs from candidate source");
  const capabilityManifest = JSON.parse(capabilityArtifact.bytes);
  requireThat(capabilityManifest.formats?.length === 11 && new Set(capabilityManifest.formats).size === 11 && capabilityManifest.cells?.length === 121 && capabilityManifest.primaryEndpoints?.length === 36, "capability manifest has an incomplete format or primary inventory");
  requireThat(new Set(capabilityManifest.primaryEndpoints.map((cell) => cell.id)).size === 36, "capability manifest has duplicate primary endpoint IDs");
  const expectedCells = capabilityManifest.formats.flatMap((source) => capabilityManifest.formats.map((target) => `${source}->${target}`));
  const declaredCells = new Set(capabilityManifest.cells.map((cell) => `${cell.source}->${cell.target}`));
  requireThat(expectedCells.every((id) => declaredCells.has(id)), "capability manifest omits a format pair");
  const capabilityKeys = [
    ...expectedCells.map((id) => `format:${id}`),
    ...capabilityManifest.primaryEndpoints.map(({ id }) => `endpoint:${id}`),
    ...(capabilityManifest.binaryProtocols || []).map(({ id }) => `binary:${id}`),
    ...(capabilityManifest.modalityRoutes || []).flatMap(({ id, cases }) => cases.map(({ variant }) => `modality:${id}:${variant}`)),
  ];
  for (const key of capabilityKeys) requireThat(manifest.qualification.some((capability) => capability.id === key && capability.state === "qualified" && capability.required === true && capability.gates.includes("protocol-matrix")), `local capability qualification missing: ${key}`);
  return {
    schema: "tokenproxy-release-evidence-v1", taskId: manifest.taskId,
    state: manifest.stage === "delivery" ? "delivery-qualified" : "offline-qualified",
    applicationSha: manifest.applicationSha, frontSha: manifest.frontSha, deploySha: manifest.deploySha,
    assembledAt: new Date().toISOString(), riskScope: manifest.riskScope,
    gates: Object.fromEntries(required.map((id) => [id, manifest.gates[id]])),
    coverage: coverageResult, mutation: mutationResult, frontCoverage, frontMutation, deployCoverage, namedFailureCases,
    packages: manifest.packages, capabilityManifest: manifest.capabilityManifest, qualification: manifest.qualification,
    outstandingGates: manifest.stage === "offline" ? DELIVERY_GATES : [],
  };
}

async function main(argv) {
  requireThat(argv.length === 4 && argv[0] === "--input" && argv[2] === "--output", "usage: assemble-release-evidence.mjs --input <directory> --output <new-file>");
  const root = resolve(argv[1]);
  const manifest = json(resolve(root, "release-input.json"));
  const result = await assembleRelease(root, manifest);
  writeFileSync(resolve(argv[3]), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`${result.state} ${result.applicationSha}; ${Object.keys(result.gates).length} required gates verified`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`release evidence rejected: ${error.message}`); process.exitCode = 1; });
}
