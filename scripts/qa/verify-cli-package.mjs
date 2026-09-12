#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  capabilityOptions,
  gitSha,
  packageVersion,
  parseOptions,
  prepareArtifacts,
  privateEnvironment,
  qualifyStartedArtifact,
  resolveExpectedSchemaVersion,
  resolveExpectedLayoutVersion,
  runCommand,
  sha256File,
} from "./verify-standalone.mjs";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(message);
}

function requiredPath(value, label) {
  if (!value) fail(`${label} is required`);
  const path = resolve(value);
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  return path;
}

function npmInvocation(args) {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function parsePackReport(stdout) {
  let report;
  try { report = JSON.parse(stdout); }
  catch { fail("npm pack did not emit structured JSON"); }
  if (!Array.isArray(report) || report.length !== 1) fail(`npm pack must produce exactly one tarball, received ${Array.isArray(report) ? report.length : "invalid"}`);
  const [entry] = report;
  if (typeof entry?.filename !== "string" || basename(entry.filename) !== entry.filename) fail("npm pack reported an unsafe tarball filename");
  if (typeof entry?.name !== "string" || typeof entry?.version !== "string") fail("npm pack report is missing package identity");
  return entry;
}

async function packCli(cliDir, packDir, env) {
  const invocation = npmInvocation(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]);
  const result = await runCommand(invocation.command, invocation.args, { cwd: cliDir, env, timeoutMs: 5 * 60_000 });
  if (result.code !== 0) fail(`npm pack exited ${result.code}: ${result.stderr.slice(-2_000)}`);
  const report = parsePackReport(result.stdout);
  const tarball = join(packDir, report.filename);
  if (!existsSync(tarball)) fail(`npm pack report names a missing tarball: ${report.filename}`);
  return { result, report, tarball };
}

async function installCli(tarball, prefix, env) {
  const invocation = npmInvocation([
    "install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--prefer-offline", tarball,
  ]);
  const result = await runCommand(invocation.command, invocation.args, { cwd: prefix, env, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) fail(`npm install of packed CLI exited ${result.code}: ${result.stderr.slice(-2_000)}`);
  return result;
}

function installedPackageRoot(prefix, packageName) {
  return join(prefix, "lib", "node_modules", ...packageName.split("/"));
}

export async function cliMain(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (!options.artifacts) fail("usage: verify-cli-package.mjs --artifacts <empty-directory>");
  const artifacts = resolve(options.artifacts);
  const cliDir = requiredPath(options["cli-dir"] || join(SCRIPT_ROOT, "cli"), "CLI source directory");
  const candidate = {
    sha: options["candidate-sha"] || gitSha(SCRIPT_ROOT),
    version: options["candidate-version"] || packageVersion(join(cliDir, "package.json")),
  };
  if (!SHA_PATTERN.test(candidate.sha)) fail(`invalid candidate SHA: ${candidate.sha}`);
  const expectedSchemaVersion = await resolveExpectedSchemaVersion(options["expected-schema-version"]);
  const expectedLayoutVersion = await resolveExpectedLayoutVersion(options["expected-layout-version"]);
  const capability = capabilityOptions(options);
  const runRoot = prepareArtifacts(artifacts);
  const packDir = join(runRoot, "pack");
  const prefix = join(runRoot, "install");
  const npmCache = join(runRoot, "npm-cache");
  mkdirSync(packDir, { mode: 0o700 });
  mkdirSync(prefix, { mode: 0o700 });
  mkdirSync(npmCache, { mode: 0o700 });
  const npmEnv = privateEnvironment(runRoot, {
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  });
  let receipt = {
    schema: "tokenproxy-cli-package-qualification-v1",
    state: "failed",
    candidate,
    startedAt: new Date().toISOString(),
    starts: [],
  };
  try {
    const packed = await packCli(cliDir, packDir, npmEnv);
    writeFileSync(join(runRoot, "pack-stdout.log"), packed.result.stdout, { mode: 0o600 });
    writeFileSync(join(runRoot, "pack-stderr.log"), packed.result.stderr, { mode: 0o600 });
    if (packed.report.version !== candidate.version) fail(`packed CLI version ${packed.report.version} does not match candidate ${candidate.version}`);
    receipt.pack = {
      packageName: packed.report.name,
      packageVersion: packed.report.version,
      filename: packed.report.filename,
      npmShasum: packed.report.shasum || null,
      npmIntegrity: packed.report.integrity || null,
      sha256: sha256File(packed.tarball),
      bytes: packed.report.size || null,
    };

    const installed = await installCli(packed.tarball, prefix, npmEnv);
    writeFileSync(join(runRoot, "install-stdout.log"), installed.stdout, { mode: 0o600 });
    writeFileSync(join(runRoot, "install-stderr.log"), installed.stderr, { mode: 0o600 });
    const installedRoot = installedPackageRoot(prefix, packed.report.name);
    const installedCli = requiredPath(join(installedRoot, "cli.js"), "installed CLI entry");
    const installedShaFile = requiredPath(join(installedRoot, "BUILD_SHA"), "installed BUILD_SHA");
    const installedSha = readFileSync(installedShaFile, "utf8").trim();
    if (installedSha !== candidate.sha) fail(`installed BUILD_SHA ${installedSha || "empty"} does not match candidate ${candidate.sha}`);
    const versionResult = await runCommand(process.execPath, [installedCli, "--version"], {
      cwd: installedRoot,
      env: privateEnvironment(runRoot),
      timeoutMs: 30_000,
    });
    if (versionResult.code !== 0 || versionResult.stdout.trim() !== candidate.version) {
      fail(`installed CLI version output does not match candidate ${candidate.version}`);
    }
    receipt.install = {
      privateHome: true,
      prefix,
      packageRoot: installedRoot,
      buildSha: installedSha,
      version: versionResult.stdout.trim(),
      scriptsExecuted: true,
    };

    const started = await qualifyStartedArtifact({
      artifacts,
      preparedRunRoot: runRoot,
      candidate,
      launch: {
        command: process.execPath,
        args: (port) => [installedCli, "--port", String(port), "--host", "127.0.0.1", "--no-browser", "--skip-update"],
        cwd: installedRoot,
      },
      capability,
      expectedSchemaVersion,
      expectedLayoutVersion,
    });
    receipt = {
      ...receipt,
      runtime: started.runtime,
      starts: started.starts,
      capability: started.capability,
      persistence: started.persistence,
      providerCleanupError: started.providerCleanupError,
      finishedAt: started.finishedAt,
    };
    if (started.state !== "passed") fail(started.reason);
    receipt.state = "passed";
    receipt.reason = "packed CLI passed structured pack, private install, exact identity, restart, capability, and owned cleanup checks";
  } catch (error) {
    receipt.reason = error.message;
    receipt.finishedAt = new Date().toISOString();
  }
  writeFileSync(join(artifacts, "cli-evidence.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`${receipt.state.toUpperCase()} ${receipt.reason}; evidence=${join(artifacts, "cli-evidence.json")}`);
  return receipt.state === "passed" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  cliMain().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`FAILED ${error.message}`);
    process.exitCode = 1;
  });
}
