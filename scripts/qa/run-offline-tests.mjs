#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testsDir = join(repoRoot, "tests");
const verifier = join(testsDir, "__baseline__", "verify-no-regression.mjs");
const canonicalManifest = join(testsDir, "__baseline__", "test-manifest.json");
const canonicalBaseline = join(testsDir, "__baseline__", "regression-baseline.json");
const vitest = join(testsDir, "node_modules", "vitest", "vitest.mjs");
const liveFlags = ["RUN_REAL", "RUN_E2E", "RUN_LIVE_MIMO", "REAL_PROVIDERS", "NV_E2E_KEY", "RTK_E2E_KEY"];
const secretPattern = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY/u;

function fail(message) {
  console.error(`offline test runner: ${message}`);
  process.exit(2);
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const tests = separator === -1 ? [] : argv.slice(separator + 1);
  if (options.length !== 2 || options[0] !== "--artifacts" || !options[1]) {
    fail("usage: run-offline-tests.mjs --artifacts <empty-directory> -- [test paths]");
  }
  return { artifacts: resolve(options[1]), tests };
}

function enabled(value) {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function assertSupportedRuntime() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const supported22 = major === 22 && (minor > 22 || (minor === 22 && patch >= 2));
  const supported24 = major === 24 && minor >= 15;
  if (!(supported22 || supported24 || major >= 26)) {
    fail(`tests require Node ^22.22.2, ^24.15.0 or >=26.0.0; received ${process.version}`);
  }
}

function prepareArtifacts(path) {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) fail(`artifact path is not a directory: ${path}`);
    if (readdirSync(path).length) fail(`artifact directory must be empty: ${path}`);
    chmodSync(path, 0o700);
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const child of ["home", "tmp", "data", "fake-production-home"]) mkdirSync(join(path, child), { mode: 0o700 });
  mkdirSync(join(path, "fake-production-home", ".tokenproxy"), { mode: 0o700 });
  writeFileSync(join(path, "fake-production-home", ".tokenproxy", "data.sqlite"), "production-canary\n", { mode: 0o600 });
}

function sanitizedEnvironment(artifacts) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (secretPattern.test(key.toUpperCase())
        || ["HOME", "TMPDIR", "DATA_DIR", "NODE_ENV", "CI", "NODE_OPTIONS", "NODE_PATH", "XDG_CONFIG_HOME"].includes(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: join(artifacts, "home"),
    TMPDIR: join(artifacts, "tmp"),
    DATA_DIR: join(artifacts, "data"),
    NODE_ENV: "test",
    CI: "1",
    TOKENPROXY_TEST_RUN_ROOT: artifacts,
    ISOLATION_CANARY_PATH: process.env.ISOLATION_CANARY_PATH
      || join(artifacts, "fake-production-home", ".tokenproxy", "data.sqlite"),
  };
}

function networkBoundary(env) {
  if (process.env.TOKENPROXY_NETWORK_BOUNDARY === "linux-user-netns") {
    return { kind: "inherited-linux-user-netns", verified: true, commandPrefix: [] };
  }
  if (process.platform !== "linux") {
    return { kind: "unavailable", verified: false, reason: "Linux user network namespaces are unavailable on this platform", commandPrefix: [] };
  }
  const probe = spawnSync("unshare", ["--user", "--map-root-user", "--net", "/bin/true"], {
    env, encoding: "utf8", timeout: 5_000,
  });
  if (probe.status !== 0) {
    return { kind: "unavailable", verified: false, reason: String(probe.stderr || probe.error?.message || "unshare probe failed").trim(), commandPrefix: [] };
  }
  return {
    kind: "linux-user-netns",
    verified: true,
    commandPrefix: [
      "unshare", "--user", "--map-root-user", "--net", "--",
      "/bin/sh", "-c", "/usr/sbin/ip link set lo up && exec \"$@\"", "tokenproxy-offline",
    ],
  };
}

function testPath(name) {
  const normalized = String(name).replaceAll("\\", "/");
  const marker = "/tests/";
  const index = normalized.lastIndexOf(marker);
  if (index !== -1) return `tests/${normalized.slice(index + marker.length)}`;
  if (normalized.startsWith("tests/")) return normalized;
  return `tests/${normalized}`;
}

function writeScopedManifest(reportPath, outputPath) {
  const canonical = JSON.parse(readFileSync(canonicalManifest, "utf8"));
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const reportedFiles = new Set(report.testResults.map((entry) => testPath(entry.name)));
  const files = Object.fromEntries(
    Object.entries(canonical.files).filter(([file]) => reportedFiles.has(file)),
  );
  writeFileSync(outputPath, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, { mode: 0o600 });
}

assertSupportedRuntime();
const { artifacts, tests } = parseArguments(process.argv.slice(2));
for (const flag of liveFlags) {
  if (enabled(process.env[flag])) fail(`live-test flag ${flag} is enabled; offline execution refuses paid or credentialed probes`);
}
prepareArtifacts(artifacts);
if (!existsSync(vitest)) fail(`local Vitest binary is missing: ${vitest}; run a clean tests-package install first`);

const env = sanitizedEnvironment(artifacts);
const boundary = networkBoundary(env);
if (!boundary.verified) {
  writeFileSync(join(artifacts, "evidence.json"), `${JSON.stringify({
    state: "blocked", scope: "offline-test-runner", reason: boundary.reason, networkBoundary: boundary,
  }, null, 2)}\n`, { mode: 0o600 });
  fail(`verified network boundary unavailable: ${boundary.reason}`);
}
env.TOKENPROXY_NETWORK_BOUNDARY = "linux-user-netns";

const maxWorkers = Number.parseInt(process.env.TOKENPROXY_TEST_MAX_WORKERS || "2", 10);
if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) fail("TOKENPROXY_TEST_MAX_WORKERS must be an integer from 1 through 4");
const resultsPath = join(artifacts, "results.json");
const vitestArgs = [
  vitest, "run", "--config", join(testsDir, "vitest.config.js"),
  `--maxWorkers=${maxWorkers}`, "--reporter=json", `--outputFile=${resultsPath}`, ...tests,
];
const command = [...boundary.commandPrefix, process.execPath, ...vitestArgs];
const startedAt = new Date().toISOString();
const run = spawnSync(command[0], command.slice(1), {
  cwd: testsDir,
  env,
  encoding: "utf8",
  timeout: 30 * 60 * 1_000,
  maxBuffer: 256 * 1024 * 1024,
});
const runnerExit = Number.isInteger(run.status) ? run.status : 125;
writeFileSync(join(artifacts, "stdout.log"), run.stdout || "", { mode: 0o600 });
writeFileSync(join(artifacts, "stderr.log"), `${run.stderr || ""}${run.error ? `${run.error.stack || run.error.message}\n` : ""}`, { mode: 0o600 });
writeFileSync(join(artifacts, "runner-exit.txt"), `${runnerExit}\n`, { mode: 0o600 });

let gateExit = 2;
let gateStdout = "";
let gateStderr = "";
if (existsSync(resultsPath)) {
  try {
    const manifest = tests.length ? join(artifacts, "scope-manifest.json") : canonicalManifest;
    if (tests.length) writeScopedManifest(resultsPath, manifest);
    const gate = spawnSync(process.execPath, [
      verifier, resultsPath, "--runner-exit", String(runnerExit),
      "--manifest", manifest, "--baseline", canonicalBaseline,
      "--evidence", join(artifacts, "gate-evidence.json"),
    ], { cwd: repoRoot, env, encoding: "utf8", timeout: 30_000 });
    gateExit = Number.isInteger(gate.status) ? gate.status : 125;
    gateStdout = gate.stdout || "";
    gateStderr = `${gate.stderr || ""}${gate.error ? `${gate.error.stack || gate.error.message}\n` : ""}`;
  } catch (error) {
    gateStderr = `${error.stack || error.message}\n`;
  }
}
writeFileSync(join(artifacts, "gate-stdout.log"), gateStdout, { mode: 0o600 });
writeFileSync(join(artifacts, "gate-stderr.log"), gateStderr, { mode: 0o600 });
writeFileSync(join(artifacts, "gate-exit.txt"), `${gateExit}\n`, { mode: 0o600 });

const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", env });
const evidence = {
  state: runnerExit === 0 && gateExit === 0 ? "passed" : "failed",
  scope: tests.length ? "offline-tests-targeted" : "offline-tests-full",
  reason: runnerExit === 0 && gateExit === 0 ? "runner and canonical regression gate passed" : "runner or canonical regression gate failed",
  startedAt,
  finishedAt: new Date().toISOString(),
  gitSha: git.status === 0 ? git.stdout.trim() : null,
  runtime: { node: process.version, modulesAbi: process.versions.modules },
  networkBoundary: { kind: boundary.kind, verified: boundary.verified },
  command: command.map((part) => part.includes(" ") ? JSON.stringify(part) : part).join(" "),
  maxWorkers,
  runnerExit,
  runnerSignal: run.signal || null,
  runnerError: run.error?.message || null,
  gateExit,
  tests,
  artifacts: relative("/", artifacts).startsWith("..") ? artifacts : `/${relative("/", artifacts)}`,
};
writeFileSync(join(artifacts, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(`${evidence.state.toUpperCase()} ${evidence.reason}; evidence=${join(artifacts, "evidence.json")}`);
process.exit(evidence.state === "passed" ? 0 : 1);
