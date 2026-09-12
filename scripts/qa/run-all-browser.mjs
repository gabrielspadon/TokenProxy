#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserWorkflowScenario, prepareBrowserWorkflow } from "./browser-workflow-fixtures.mjs";
import { gitSha, packageVersion, parseOptions, prepareArtifacts, privateEnvironment, runCommand, sha256File } from "./verify-standalone.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

export function browserInventory(root = ROOT) {
  const tracked = spawnSync("git", ["ls-files", "-z", "tests/e2e"], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0) fail("cannot enumerate tracked browser inventory");
  const files = tracked.stdout.split("\0").filter((file) => file.endsWith(".mjs")).sort();
  const playwright = files.filter((file) => file.endsWith(".spec.mjs") && /from\s*["'](?:@playwright\/test|playwright\/test)["']/u.test(readFileSync(join(root, file), "utf8")));
  const scripts = files.filter((file) => /^tests\/e2e\/[^/]+\.mjs$/u.test(file) && /from\s*["']playwright["']/u.test(readFileSync(join(root, file), "utf8")));
  if (!playwright.length) fail("tracked Playwright inventory is empty");
  return {
    playwright,
    scripts: scripts.map((file) => ({ file, owner: "T09", disposition: "execute", reason: "Run its existing assertions against owned production fixtures; history adapters create only synthetic retained rows" })),
    supportingModules: files.filter((file) => !playwright.includes(file) && !scripts.includes(file)).map((file) => ({ file, owner: "tests/e2e", disposition: "support", reason: "Fixture, configuration, seed, native-client tooling or orchestration module; direct browser entry points and all Playwright specs are inventoried separately" })),
    manifestSha256: sha256(JSON.stringify(files.map((file) => [file, sha256File(join(root, file))]))),
  };
}

export function assessScriptReport(report) {
  const rows = Array.isArray(report) ? report : [report];
  if (!rows.length || rows.some((row) => !row || typeof row !== "object" || !Object.keys(row).length)) return false;
  const hasErrors = (value) => Array.isArray(value) ? value.length > 0 : Boolean(value);
  return rows.every((row) => row.passed !== false && !row.failure && !hasErrors(row.errors) && !hasErrors(row.pageErrors) && !hasErrors(row.outboundFailures) && (row.status === undefined || row.status === 200) && !row.overflow && !row.mobileOverflow);
}


export function verifyBrowserBuild(dist, receiptPath, manifestPath, candidate) {
  const build = json(receiptPath);
  const manifest = json(manifestPath);
  if (build.buildExit !== 0 || build.sourceStable !== true || build.base !== candidate.sha || !/^[a-f0-9]{64}$/u.test(build.sourceManifest || "")) fail("browser requires a successful, source-stable build receipt for this candidate");
  const files = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`browser artifact has an unbound symlink: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push([relative(dist, path), sha256File(path)]);
      else fail(`browser artifact contains a non-file entry: ${path}`);
    }
  }
  walk(dist);
  files.sort(([a], [b]) => a.localeCompare(b));
  const digest = sha256(JSON.stringify(files));
  if (digest !== build.artifactManifestHash || digest !== manifest.artifactManifestHash || JSON.stringify(Object.fromEntries(files)) !== JSON.stringify(manifest.files)) fail("browser artifact does not match its retained build manifest");
  if (build.buildId !== readFileSync(join(dist, "BUILD_ID"), "utf8").trim() || build.buildId !== readFileSync(join(dist, "standalone/.next/BUILD_ID"), "utf8").trim()) fail("browser artifact BUILD_ID mismatch");
  return { sha: build.base, buildId: build.buildId, artifactManifestHash: digest, artifactFiles: files.length, buildReceiptSha256: sha256File(receiptPath) };
}

export function reportTests(report) {
  const tests = [];
  function walk(suite) {
    for (const spec of suite.specs || []) for (const test of spec.tests || []) tests.push({
      id: test.testId || `${spec.file}:${spec.line}:${spec.title}:${test.projectName || ""}`,
      file: spec.file,
      title: spec.title,
      expectedStatus: test.expectedStatus,
      status: test.status,
      results: test.results || [],
    });
    for (const child of suite.suites || []) walk(child);
  }
  for (const suite of report.suites || []) walk(suite);
  return tests;
}

export function assessBrowserReport(report, expected) {
  const actual = reportTests(report);
  const expectedIds = expected.map((test) => test.id).sort();
  const actualIds = actual.map((test) => test.id).sort();
  const complete = expectedIds.length > 0 && JSON.stringify(expectedIds) === JSON.stringify(actualIds);
  const failures = actual.filter((test) => test.expectedStatus !== "passed" || test.status !== "expected" || test.results.length !== 1 || test.results[0].status !== "passed");
  return { passed: complete && failures.length === 0 && !(report.errors || []).length, complete, expected: expected.length, executed: actual.length, failures, errors: report.errors || [] };
}

async function identity(baseUrl, candidate) {
  const values = {};
  for (const path of ["health", "ready", "version"]) {
    const response = await fetch(`${baseUrl}/api/${path}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) fail(`browser ${path} returned ${response.status}`);
    values[path] = await response.json();
  }
  if (values.health.ok !== true || values.ready.ready !== true || values.ready.buildSha !== candidate.sha || values.version.buildSha !== candidate.sha || values.version.currentVersion !== candidate.version) fail("browser served health, readiness or candidate identity mismatch");
  return values;
}

export async function browserMain(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (!options.artifacts || !options.dist || !options["build-receipt"] || !options["artifact-manifest"]) fail("require --artifacts, --dist, --build-receipt and --artifact-manifest");
  const candidate = { sha: options["candidate-sha"] || gitSha(ROOT), version: options["candidate-version"] || packageVersion(join(ROOT, "package.json")) };
  if (!/^[a-f0-9]{40}$/u.test(candidate.sha)) fail("candidate SHA must contain all 40 hex characters");
  const artifacts = resolve(options.artifacts);
  const runRoot = prepareArtifacts(artifacts);
  const env = privateEnvironment(runRoot, {
    PLAYWRIGHT_BROWSERS_PATH: resolve(options["browsers-path"] || process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright")),
  });
  const receipt = { schema: "tokenproxy-browser-qualification-v1", state: "failed", candidate, startedAt: new Date().toISOString(), cases: [] };
  const launch = async (...args) => {
    const result = await runCommand(process.execPath, [join(ROOT, "scripts/redesign-preview.mjs"), ...args], { cwd: ROOT, env, timeoutMs: 120_000 });
    if (result.code !== 0) fail(`owned preview ${args[0]} failed: ${result.stderr.slice(-2000)}`);
    return JSON.parse(result.stdout);
  };
  const seedHistory = async (root, variant) => {
    const auth = json(join(root, "preview-auth.json"));
    const result = await runCommand(process.execPath, [join(ROOT, "scripts/qa/browser-fixture-seed.mjs"), root, variant], {
      cwd: ROOT,
      env: { ...env, DATA_DIR: join(root, "runtime"), DB_ENCRYPTION_KEY: auth.dbEncryptionKey, JWT_SECRET: auth.jwtSecret, INITIAL_PASSWORD: auth.initialPassword },
      timeoutMs: 60_000,
    });
    if (result.code !== 0) fail(`dedicated browser history seed failed: ${result.stderr.slice(-2000)}`);
    return json(join(root, "browser-history-seed.json"));
  };
  try {
    receipt.build = verifyBrowserBuild(resolve(options.dist), resolve(options["build-receipt"]), resolve(options["artifact-manifest"]), candidate);
    receipt.inventory = browserInventory();
    const cli = join(ROOT, "node_modules/playwright/cli.js");
    if (!existsSync(cli)) fail("install the pinned root Playwright dependency before browser qualification");
    const common = [cli, "test", "--config", join(ROOT, "tests/e2e/playwright.config.mjs"), "--workers=1", "--retries=0", "--forbid-only", "--reporter=json"];
    const listing = await runCommand(process.execPath, [...common, "--list"], { cwd: ROOT, env, timeoutMs: 120_000 });
    writeFileSync(join(artifacts, "inventory-stdout.json"), listing.stdout, { mode: 0o600 });
    writeFileSync(join(artifacts, "inventory-stderr.log"), listing.stderr, { mode: 0o600 });
    if (listing.code !== 0) fail("Playwright inventory collection failed");
    const listedReport = JSON.parse(listing.stdout);
    if (listedReport.errors?.length) fail("Playwright inventory contains collection errors");
    const listed = reportTests(listedReport);
    const resolveFile = (file) => isAbsolute(file) ? relative(ROOT, file) : file.startsWith("tests/") ? file : `tests/e2e/${file}`;
    const collectedFiles = [...new Set(listed.map((test) => resolveFile(test.file)))].sort();
    if (JSON.stringify(collectedFiles) !== JSON.stringify(receipt.inventory.playwright)) fail("Playwright configuration did not collect every tracked Playwright spec");

    const cases = [...receipt.inventory.playwright.map((file) => ({ file, kind: "spec" })), ...receipt.inventory.scripts.filter((entry) => entry.disposition === "execute").map((entry) => ({ file: entry.file, kind: "script" }))];
    for (const [index, item] of cases.entries()) {
      const { file, kind } = item;
      const caseRoot = join(artifacts, `case-${String(index + 1).padStart(2, "0")}`);
      mkdirSync(caseRoot, { mode: 0o700 });
      const entry = { file, kind, state: "failed" };
      receipt.cases.push(entry);
      let seed;
      let secondary;
      let secondaryStarted = false;
      let startAttempted = false;
      try {
        const historyVariant = file.endsWith("/operator-persistence.mjs") ? "operator-persistence" : file.endsWith("/context-workspace-synthetic.mjs") ? "context-history" : /\/(?:capacity-snapshot|workspace-interactions|investigations|investigation-records)\.mjs$/u.test(file) ? "legacy-workspace" : null;
        const scenario = historyVariant === "legacy-workspace" ? "empty" : historyVariant ? "single" : kind === "script" ? browserWorkflowScenario(file) : "representative";
        seed = await launch("seed", "--mode", "production", "--scenario", scenario);
        const marker = json(join(seed.root, "owner.json"));
        if (marker.kind !== "tokenproxy-redesign-preview-v1" || realpathSync(seed.root) !== marker.root || marker.runId !== seed.runId) fail("browser fixture ownership mismatch");
        entry.fixture = { root: seed.root, runId: seed.runId, scenario: seed.scenario };
        if (historyVariant) entry.fixture.history = await seedHistory(seed.root, historyVariant);
        const scriptArgs = kind === "script" ? prepareBrowserWorkflow(file, seed, caseRoot) : [];
        const dualHistory = file.endsWith("/investigation-records.mjs");
        if (dualHistory) {
          secondary = await launch("seed", "--mode", "production", "--scenario", "single");
          entry.secondaryFixture = { ...secondary, history: await seedHistory(secondary.root, "context-history") };
          secondaryStarted = true;
          const runtime = await launch("start", "--mode", "production", "--run", secondary.root, "--dist", resolve(options.dist), "--build-receipt", resolve(options["build-receipt"]), "--port", "20311");
          entry.secondaryFixture.runtime = runtime;
          entry.secondaryFixture.identity = await identity(runtime.url, candidate);
        }
        startAttempted = true;
        const runtime = await launch("start", "--mode", "production", "--run", seed.root, "--dist", resolve(options.dist), "--build-receipt", resolve(options["build-receipt"]), "--port", dualHistory ? "20310" : "20360");
        if (runtime.sourceRevision !== candidate.sha || runtime.buildId !== receipt.build.buildId) fail("browser runtime attribution mismatch");
        entry.runtime = runtime;
        entry.identity = await identity(runtime.url, candidate);
        const auth = json(join(seed.root, "preview-auth.json"));
        const args = kind === "spec" ? [...common, "--output", join(caseRoot, "test-results"), file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")] : [join(ROOT, file), seed.root, caseRoot, ...scriptArgs];
        const result = await runCommand(process.execPath, args, {
          cwd: ROOT,
          env: { ...env, E2E_BASE: file.endsWith("/operator-persistence.mjs") ? runtime.url.replace("127.0.0.1", "localhost") : runtime.url, E2E_FIXTURE_ROOT: seed.root, TOKENPROXY_PRIVATE_PREVIEW: seed.root, EVIDENCE_DIR: caseRoot, SMOKE_PASSWORD: auth.initialPassword, ...(secondary ? { REAL_PREVIEW: seed.root, SYNTHETIC_PREVIEW: secondary.root } : {}) },
          timeoutMs: 30 * 60_000,
        });
        writeFileSync(join(caseRoot, "playwright.json"), result.stdout, { mode: 0o600 });
        writeFileSync(join(caseRoot, "playwright-stderr.log"), result.stderr, { mode: 0o600 });
        if (kind === "spec") entry.report = assessBrowserReport(JSON.parse(result.stdout), listed.filter((test) => resolveFile(test.file) === file));
        else {
          let scriptReport;
          try { scriptReport = JSON.parse(result.stdout); }
          catch {
            const reportFile = ["receipt.json", "browser-receipt.json", "accessibility-report.json"].map((name) => join(caseRoot, name)).find(existsSync);
            if (reportFile) scriptReport = json(reportFile);
          }
          entry.report = { passed: assessScriptReport(scriptReport), report: scriptReport };
        }
        entry.exitCode = result.code;
        if (result.code !== 0 || !entry.report.passed) fail("browser file has failures, skips, retries, or incomplete execution");
        entry.state = "passed";
      } catch (error) { entry.reason = error.message; }
      finally {
        if (secondary && secondaryStarted) {
          try {
            entry.secondaryStop = await launch("stop", "--run", secondary.root);
            if (entry.secondaryStop.stopped !== true || entry.secondaryStop.ownershipEndpointClosed !== true) fail("secondary owned preview did not prove its stop");
          }
          catch (error) { entry.state = "failed"; entry.cleanupError = error.message; }
        }
        if (seed && startAttempted) {
          try {
            entry.stop = await launch("stop", "--run", seed.root);
            if (entry.stop.stopped !== true || entry.stop.ownershipEndpointClosed !== true) fail("owned preview did not prove its stop");
          } catch (error) { entry.state = "failed"; entry.cleanupError = error.message; }
        }
        save(join(caseRoot, "case-evidence.json"), entry);
      }
      if (entry.cleanupError) fail("browser cleanup was not proven; refusing another owned server");
    }
    if (receipt.cases.some((entry) => entry.state !== "passed")) fail("one or more tracked browser specs failed");
    receipt.state = "passed";
    receipt.reason = "all tracked browser entry points passed against owned production artifacts";
  } catch (error) { receipt.reason = error.message; }
  receipt.finishedAt = new Date().toISOString();
  save(join(artifacts, "browser-evidence.json"), receipt);
  console.log(`${receipt.state.toUpperCase()} ${receipt.reason}; evidence=${join(artifacts, "browser-evidence.json")}`);
  return receipt.state === "passed" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) browserMain().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
