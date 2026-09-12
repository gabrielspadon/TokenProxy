#!/usr/bin/env node
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, loadRiskScope, requireThat, SHA, SHA256, validateCoverage, validateMutation, validatePythonCoverage } from "./risk-scope.mjs";

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

function validateNativeArtifact(value, identities) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const sha of [value.gitSha, value.candidate?.sha, value.applicationSha]) {
    if (sha !== undefined) requireThat(sha === identities.applicationSha, "raw evidence belongs to another application revision");
  }
  if (value.state !== undefined) requireThat(value.state === "passed", "raw evidence is not passed");
  if (/tokenproxy-(standalone|cli-package|started-artifact)-qualification-v1/u.test(value.schema || "")) {
    requireThat(value.persistence?.reopened === true && value.persistence?.seeded === true && value.starts?.length === 2, "started artifact lacks persistence or restart proof");
    requireThat(value.capability?.passed === 36 && value.capability?.manifestCells === 121, "started artifact capability inventory incomplete");
    for (const run of value.starts) {
      requireThat(!run.error && run.readiness?.buildSha === identities.applicationSha && run.version?.buildSha === identities.applicationSha, "started artifact serves an incorrect identity");
      requireThat(run.cleanup?.listenerGone === true && run.cleanup?.graceful === true && run.cleanup?.forced === false && run.cleanup?.exitCode === 0, "started artifact cleanup incomplete");
    }
  }
}

function validateMeasurements(id, receipt) {
  const metrics = receipt.metrics || {};
  if (id === "analytics-250k") {
    requireThat(metrics.requestRows >= 250000 && metrics.usageRows >= 250000, "analytics fixture is below 250k rows per table");
    requireThat(Array.isArray(metrics.populations) && metrics.populations.length >= 4, "analytics populations missing");
    for (const concurrency of [1, 5]) for (const temperature of ["cold", "warm"]) {
      const populations = metrics.populations.filter((population) => population.concurrency === concurrency && population.temperature === temperature);
      requireThat(populations.length > 0, `analytics population missing: ${concurrency}/${temperature}`);
      for (const population of populations) {
        integer(population.samples, temperature === "cold" ? 50 : 200, "analytics samples");
        below(population.p95Ms, 2000, "Economics p95 ms");
        below(population.p99Ms, 5000, "Economics p99 ms");
        requireThat(population.failures === 0 && population.http503s === 0 && population.syntheticWrites > 0, "analytics failures or missing concurrent writes");
      }
    }
  }
  if (["analytics-250k", "analytics-1m"].includes(id)) below(metrics.workerPeakRssBytes, 512 * 1024 * 1024, "analytics worker RSS bytes");
  if (id === "analytics-1m") {
    requireThat(metrics.requestRows >= 1000000 && metrics.usageRows >= 1000000, "growth fixture is below one million rows per table");
    integer(metrics.samples, 1, "growth samples");
    requireThat(metrics.failures === 0, "growth failures remain");
  }
  if (["risk-coverage", "front-risk-coverage", "deploy-driver-coverage"].includes(id)) requireThat(Number.isFinite(metrics.branchPercentage) && metrics.branchPercentage >= 90 && metrics.branchPercentage <= 100, "risk branch coverage below 90% or invalid");
  if (["risk-mutation", "front-risk-mutation"].includes(id)) {
    requireThat(Number.isFinite(metrics.mutationScore) && metrics.mutationScore >= 60 && metrics.mutationScore <= 100, "mutation score below 60% or invalid");
    requireThat(metrics.unreviewedSurvivors === 0, "unreviewed mutation survivors remain");
  }
  if (id === "failure-matrix") integer(metrics.requests, 10000, "deterministic requests");
  if (id === "soak") {
    requireThat(interval(receipt, id) >= 3600000, "mixed-traffic soak is shorter than 60 minutes");
    integer(metrics.requests, 1, "soak requests");
    integer(metrics.cutovers, 2, "soak cutovers");
    requireThat(metrics.backlogSlope <= 0 && Number.isFinite(metrics.rssSlopeBytesPerMinute), "soak resource slopes missing or backlog growing");
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

export function validateGate(root, id, reference, identities) {
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
  validateMeasurements(id, receipt);
  return receipt;
}

export function assembleRelease(root, manifest, { repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..") } = {}) {
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
  for (const id of required) gates[id] = validateGate(root, id, manifest.gates[id], manifest);
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
  const capabilityManifest = JSON.parse(readArtifact(root, manifest.capabilityManifest).bytes);
  requireThat(capabilityManifest.formats?.length === 11 && new Set(capabilityManifest.formats).size === 11 && capabilityManifest.cells?.length === 121 && capabilityManifest.primaryEndpoints?.length === 36, "capability manifest has an incomplete format or primary inventory");
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

function main(argv) {
  requireThat(argv.length === 4 && argv[0] === "--input" && argv[2] === "--output", "usage: assemble-release-evidence.mjs --input <directory> --output <new-file>");
  const root = resolve(argv[1]);
  const manifest = json(resolve(root, "release-input.json"));
  const result = assembleRelease(root, manifest);
  writeFileSync(resolve(argv[3]), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`${result.state} ${result.applicationSha}; ${Object.keys(result.gates).length} required gates verified`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`release evidence rejected: ${error.message}`); process.exitCode = 1; }
}
