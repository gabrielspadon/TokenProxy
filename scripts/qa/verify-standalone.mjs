#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

export function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    if (equals !== -1) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) fail(`missing value for ${argument}`);
    options[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

export function gitSha(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !SHA_PATTERN.test(result.stdout.trim())) fail("cannot resolve the exact candidate Git SHA");
  return result.stdout.trim();
}

export function packageVersion(packagePath) {
  const value = JSON.parse(readFileSync(packagePath, "utf8"))?.version;
  if (typeof value !== "string" || !value.trim()) fail(`package version is missing: ${packagePath}`);
  return value.trim();
}

export function prepareArtifacts(artifacts) {
  if (existsSync(artifacts)) {
    if (!lstatSync(artifacts).isDirectory()) fail(`artifact path must be a real directory: ${artifacts}`);
    if (readdirSync(artifacts).length > 0) fail(`artifact directory must be empty: ${artifacts}`);
    chmodSync(artifacts, 0o700);
  } else {
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  }
  const runRoot = join(artifacts, "run");
  for (const child of [runRoot, join(runRoot, "home"), join(runRoot, "tmp"), join(runRoot, "data"), join(runRoot, "xdg")]) {
    mkdirSync(child, { recursive: true, mode: 0o700 });
  }
  return runRoot;
}

function boundedAppend(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_OUTPUT_BYTES);
}

function spawnSyncResult(command, args, { cwd, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get code() { return child.exitCode; },
  };
}

export async function runCommand(command, args, { cwd, env, timeoutMs = 60_000 } = {}) {
  const running = spawnSyncResult(command, args, { cwd, env });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    let timedOut = false;
    const timeout = setTimeout(async () => {
      timedOut = true;
      const root = procIdentity(running.child.pid);
      const captured = root ? processTree(root) : [];
      try {
        for (const identity of captured.toReversed()) {
          if (sameIdentity(procIdentity(identity.pid), identity)) {
            try { process.kill(identity.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        }
        await waitForExit(running.child, 1000);
        for (const identity of captured.toReversed()) {
          if (sameIdentity(procIdentity(identity.pid), identity)) {
            try { process.kill(identity.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        }
        await waitForExit(running.child, 1000);
      } catch (error) {
        rejectPromise(new Error(`command timeout cleanup failed: ${error.message}`));
        return;
      }
      rejectPromise(new Error(`command timed out after ${timeoutMs} ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    running.child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    running.child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return;
      resolvePromise({ code, signal, stdout: running.stdout, stderr: running.stderr });
    });
  });
  return result;
}

export async function reservePort() {
  const server = net.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return port;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readSchemaVersion(database, key = "schemaVersion") {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(key);
    const version = Number.parseInt(row?.value, 10);
    if (!Number.isSafeInteger(version) || version < 0) fail(`database has no valid ${key}`);
    return version;
  } finally {
    db.close();
  }
}

export function schemaSha256(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  } finally { db.close(); }
}

export async function resolveExpectedSchemaVersion(value) {
  let version = Number.parseInt(value, 10);
  if (value === undefined) {
    const migrations = await import(pathToFileURL(join(SCRIPT_ROOT, "src/lib/db/migrations/index.js")).href);
    version = migrations.latestVersion();
  }
  if (!Number.isSafeInteger(version) || version < 1 || String(version) !== String(value ?? version)) {
    fail(`invalid expected schema version: ${value ?? version}`);
  }
  return version;
}

export async function resolveExpectedLayoutVersion(value) {
  const version = value === undefined
    ? (await import(pathToFileURL(join(SCRIPT_ROOT, "src/lib/db/schema.js")).href)).SCHEMA_VERSION
    : Number(value);
  if (!Number.isSafeInteger(version) || version < 1 || String(version) !== String(value ?? version)) fail(`invalid expected layout version: ${value}`);
  return version;
}

// Forwarding the host PATH verbatim lets a version manager on it re-elect the
// interpreter for any child that spawns a bare `node` or `npm`, so a qualification
// run could package and install under a different runtime than the one it is
// reporting on. Put this process own binary directory first, which makes the
// runtime it verifies the runtime it is actually using. The rest of PATH is kept
// as-is: the child still needs the host toolchain, and narrowing that is a
// separate isolation question.
function runtimeFirstPath() {
  const host = process.env.PATH || "/usr/bin:/bin";
  const own = dirname(process.execPath);
  return host.split(delimiter)[0] === own ? host : `${own}${delimiter}${host}`;
}

export function privateEnvironment(runRoot, extra = {}) {
  return {
    PATH: runtimeFirstPath(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: join(runRoot, "home"),
    USERPROFILE: join(runRoot, "home"),
    TMPDIR: join(runRoot, "tmp"),
    TMP: join(runRoot, "tmp"),
    TEMP: join(runRoot, "tmp"),
    XDG_CONFIG_HOME: join(runRoot, "xdg", "config"),
    XDG_DATA_HOME: join(runRoot, "xdg", "data"),
    XDG_CACHE_HOME: join(runRoot, "xdg", "cache"),
    XDG_STATE_HOME: join(runRoot, "xdg", "state"),
    DATA_DIR: join(runRoot, "data"),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    TOKENPROXY_NO_UPDATE: "1",
    MODEL_CATALOG_SYNC: "off",
    MODEL_CAPABILITY_OVERRIDES: JSON.stringify({ "fixture-model": { vision: true, reasoning: true } }),
    JWT_SECRET: "artifact-fixture-jwt-secret-000000000000",
    API_KEY_SECRET: "artifact-fixture-api-secret-111111111111",
    MACHINE_ID_SALT: "artifact-fixture-machine-salt-22222222",
    DB_ENCRYPTION_KEY: "artifact-fixture-db-encryption-key",
    INITIAL_PASSWORD: "artifact-fixture-password",
    ...extra,
    TOKENPROXY_TELEMETRY_ORIGIN: "test",
  };
}

function procIdentity(pid) {
  if (process.platform !== "linux") return { pid, platform: process.platform };
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    return {
      pid,
      pgid: Number(fields[2]),
      startTime: fields[19],
      cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8"),
    };
  } catch {
    return null;
  }
}

function sameIdentity(actual, expected) {
  if (!actual || !expected || actual.pid !== expected.pid) return false;
  if (process.platform !== "linux") return true;
  return actual.startTime === expected.startTime && actual.pgid === expected.pgid && actual.cgroup === expected.cgroup;
}

function childPids(pid) {
  if (process.platform !== "linux") return [];
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/u).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function processTree(root) {
  const values = [];
  const pending = [root.pid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const identity = procIdentity(pid);
    if (!identity) continue;
    values.push(identity);
    pending.push(...childPids(pid));
  }
  return values;
}

function listeningInodes(port) {
  if (process.platform !== "linux") return new Set();
  const suffix = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const result = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = readFileSync(table, "utf8"); } catch {}
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields[1]?.endsWith(suffix) && fields[3] === "0A" && fields[9]) result.add(fields[9]);
    }
  }
  return result;
}

function ownsPort(identity, port) {
  if (!identity) return false;
  if (process.platform !== "linux") return sameIdentity(procIdentity(identity.pid), identity);
  if (!sameIdentity(procIdentity(identity.pid), identity)) return false;
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return false;
  let descriptors = [];
  try { descriptors = readdirSync(`/proc/${identity.pid}/fd`); } catch { return false; }
  return descriptors.some((descriptor) => {
    try {
      const target = readlinkSync(`/proc/${identity.pid}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/u.exec(target);
      return Boolean(match && inodes.has(match[1]));
    } catch {
      return false;
    }
  });
}

async function captureOwnership(child, port) {
  const root = procIdentity(child.pid);
  if (!root) fail("spawned artifact exited before process identity capture");
  if (process.platform !== "linux") return { root, listener: root, port, verified: false, method: "child-and-port" };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const tree = processTree(root);
    const listener = tree.find((identity) => ownsPort(identity, port));
    if (listener) return { root, listener, port, verified: true, method: "proc-child-socket" };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  fail("started artifact listener is not owned by its captured process tree");
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolvePromise) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(null);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function portIsClosed(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const closed = await new Promise((resolvePromise) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolvePromise(false); });
      socket.once("error", () => { socket.destroy(); resolvePromise(true); });
    });
    if (closed) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return false;
}

async function cleanupOwned(child, ownership) {
  const result = { graceful: false, forced: false, listenerGone: false, exitCode: child.exitCode, signal: child.signalCode };
  const ownedTree = processTree(ownership.root);
  if (child.exitCode === null && child.signalCode === null) {
    if (!sameIdentity(procIdentity(ownership.root.pid), ownership.root)) fail("refusing cleanup because the spawned process identity changed");
    child.kill("SIGTERM");
    let exit = await waitForExit(child, 5_000);
    if (!exit) {
      if (!sameIdentity(procIdentity(ownership.root.pid), ownership.root)) fail("refusing forced cleanup because the spawned process identity changed");
      child.kill("SIGKILL");
      result.forced = true;
      exit = await waitForExit(child, 3_000);
    }
    result.graceful = Boolean(exit && !result.forced);
    result.exitCode = exit?.code ?? null;
    result.signal = exit?.signal ?? null;
  }
  result.listenerGone = await portIsClosed(ownership.port);
  result.processesGone = ownedTree.every((identity) => !sameIdentity(procIdentity(identity.pid), identity));
  return result;
}

async function readJson(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) fail(`artifact exited before ${url} became ready with code ${child.exitCode} signal ${child.signalCode}`);
    try {
      const response = await fetch(url, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(1_000),
      });
      const text = await response.text();
      if (text.length > 65_536) fail(`oversized JSON response from ${url}`);
      if (response.status === 200) return { status: response.status, body: JSON.parse(text) };
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  fail(`timed out waiting for ${url}: ${lastError?.message || "no response"}`);
}

export async function startOwnedArtifact({ launch, env, candidate, port, label }) {
  if (!/^[A-Za-z0-9_-]+$/u.test(label || "")) fail("artifact label must be a safe log basename");
  const running = spawnSyncResult(launch.command, launch.args(port), { cwd: launch.cwd, env: { ...env, PORT: String(port), HOSTNAME: "127.0.0.1" } });
  const receipt = { label, command: [launch.command, ...launch.args(port)], pid: running.child.pid };
  const spawnedRoot = running.child.pid ? procIdentity(running.child.pid) : null;
  let spawnError;
  running.child.once("error", (error) => { spawnError = error; });
  let ownership;
  let closing;
  const close = () => closing ||= (async () => {
    const captured = ownership || (spawnedRoot ? { root: spawnedRoot, port } : null);
    try {
      receipt.cleanup = captured ? await cleanupOwned(running.child, captured) : { listenerGone: await portIsClosed(port), unverified: true };
    } catch (error) { receipt.cleanup = { listenerGone: false, error: error.message }; }
    writeFileSync(join(env.TOKENPROXY_ARTIFACT_LOG_DIR, `${label}-stdout.log`), running.stdout, { mode: 0o600 });
    writeFileSync(join(env.TOKENPROXY_ARTIFACT_LOG_DIR, `${label}-stderr.log`), running.stderr, { mode: 0o600 });
    return receipt.cleanup;
  })();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await readJson(`${baseUrl}/api/health`, running.child);
    ownership = await captureOwnership(running.child, port);
    const readiness = await readJson(`${baseUrl}/api/ready`, running.child);
    const version = await readJson(`${baseUrl}/api/version`, running.child);
    receipt.ownership = ownership;
    receipt.healthStatus = health.status;
    receipt.health = health.body;
    receipt.readinessStatus = readiness.status;
    receipt.readiness = readiness.body;
    receipt.versionStatus = version.status;
    receipt.version = version.body;
    if (health.body?.ok !== true) fail("artifact liveness response is not {ok:true}");
    if (readiness.body?.ready !== true) fail("artifact readiness response is not ready");
    if (readiness.body?.buildSha !== candidate.sha) fail(`served readiness SHA ${readiness.body?.buildSha || "null"} does not match candidate ${candidate.sha}`);
    if (version.body?.buildSha !== candidate.sha) fail(`served build SHA ${version.body?.buildSha || "null"} does not match candidate ${candidate.sha}`);
    if (version.body?.currentVersion !== candidate.version) fail(`served version ${version.body?.currentVersion || "null"} does not match candidate ${candidate.version}`);
    return { baseUrl, ownership, receipt, close };
  } catch (error) {
    receipt.error = (spawnError || error).message;
    await close();
    throw Object.assign(error, { receipt });
  }
}

export async function startAndProbe({ during, ...options }) {
  let running;
  try {
    running = await startOwnedArtifact(options);
    if (during) running.receipt.during = await during(running.baseUrl);
  } catch (error) {
    if (!running) return error.receipt || { label: options.label, error: error.message };
    running.receipt.error = error.message;
  } finally { if (running) await running.close(); }
  return running.receipt;
}

export function validateManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(manifest.cells) || manifest.cells.length !== 121) fail("capability manifest must contain exactly 121 format cells");
  if (!Array.isArray(manifest.primaryEndpoints) || manifest.primaryEndpoints.length !== 36) fail("capability manifest must contain exactly 36 primary endpoint cells");
  if (!Array.isArray(manifest.binaryProtocols)) fail("capability manifest must declare binary protocol cells");
  if (!Array.isArray(manifest.modalityRoutes)) fail("capability manifest must declare modality route cells");
  return manifest;
}

export async function runCapabilityMatrix({ matrixScript, baseUrl, providerControlUrl, authorization, env }) {
  const authName = "CAPABILITY_GATEWAY_AUTH";
  const args = [
    matrixScript,
    `--gateway-base-url=${baseUrl}`,
    `--provider-control-url=${providerControlUrl}`,
    `--authorization-env=${authName}`,
    "--model=fixture/fixture-model",
  ];
  const result = await runCommand(process.execPath, args, {
    cwd: SCRIPT_ROOT,
    env: { ...env, [authName]: authorization },
    timeoutMs: 10 * 60_000,
  });
  if (result.code !== 0) fail(`capability matrix exited ${result.code}: ${result.stderr.slice(-2_000)}`);
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { fail("capability matrix did not emit one JSON report"); }
  if (report?.primary?.passed !== 36) fail(`capability matrix passed ${report?.primary?.passed ?? "unknown"} of 36 primary cells`);
  if ((report.primary.dispatched || 0) + (report.primary.rejectedBeforeUpstream || 0) !== 36) fail("capability matrix dispatch accounting is incomplete");
  return report;
}

export async function startFixtureProvider(providerModule) {
  if (typeof providerModule.startProviderStub !== "function") fail("provider stub module does not export startProviderStub");
  for (let port = 20210; port <= 20219; port += 1) {
    try { return await providerModule.startProviderStub({ host: "127.0.0.1", port }); }
    catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  fail("all reserved capability provider ports 20210-20219 are occupied");
}

export function capabilityOptions(options, root = SCRIPT_ROOT) {
  return {
    manifest: requiredPath(options["capability-manifest"] || join(root, "tests/contracts/capabilities.json"), "capability manifest"),
    providerStubModule: requiredPath(options["provider-stub-module"] || join(root, "tests/contracts/provider-stub.mjs"), "provider stub module"),
    seedScript: requiredPath(options["seed-script"] || join(root, "tests/contracts/capability-gateway-seed.mjs"), "capability seed script"),
    matrixScript: requiredPath(options["matrix-script"] || join(root, "tests/contracts/run-capability-matrix.mjs"), "capability matrix script"),
  };
}

export async function qualifyStartedArtifact({
  artifacts,
  candidate,
  launch,
  capability,
  expectedSchemaVersion,
  expectedLayoutVersion,
  preparedRunRoot = null,
}) {
  const receipt = {
    schema: "tokenproxy-started-artifact-qualification-v1",
    state: "failed",
    candidate,
    runtime: { node: process.version, modulesAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    startedAt: new Date().toISOString(),
    starts: [],
    artifactsPrepared: false,
  };
  let provider;
  try {
    const runRoot = preparedRunRoot || prepareArtifacts(artifacts);
    receipt.artifactsPrepared = true;
    const logDir = join(runRoot, "logs");
    mkdirSync(logDir, { mode: 0o700 });
    const env = privateEnvironment(runRoot, { TOKENPROXY_ARTIFACT_LOG_DIR: logDir });
    const manifest = validateManifest(capability.manifest);
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      if (existsSync(join(launch.cwd, name))) fail(`artifact verifier refuses implicit environment file ${name}`);
    }
    const providerModule = await import(pathToFileURL(capability.providerStubModule).href);
    provider = await startFixtureProvider(providerModule);
    const guardPath = join(SCRIPT_ROOT, "tests/qa/gateway-performance/guard.cjs");
    if (!existsSync(guardPath)) fail("artifact runtime I/O guard is missing");
    const guardEnv = {
      NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`,
      BENCH_RUN_ID: "t09-started-artifact",
      BENCH_ALLOWED_PORTS: new URL(provider.baseUrl).port,
      // The packaged launcher owns a server child; both inherit the guard.
      BENCH_BUILD: "1",
    };
    const authFile = join(runRoot, "authorization");
    const seed = await runCommand(process.execPath, [capability.seedScript], {
      cwd: SCRIPT_ROOT,
      env: privateEnvironment(runRoot, {
        ...guardEnv,
        CAPABILITY_PROVIDER_BASE_URL: `${provider.baseUrl}/v1`,
        CAPABILITY_AUTH_FILE: authFile,
      }),
      timeoutMs: 60_000,
    });
    writeFileSync(join(logDir, "seed-stdout.log"), seed.stdout, { mode: 0o600 });
    writeFileSync(join(logDir, "seed-stderr.log"), seed.stderr, { mode: 0o600 });
    if (seed.code !== 0) fail(`capability seed exited ${seed.code}: ${seed.stderr.slice(-2_000)}`);
    const database = join(runRoot, "data", "db", "data.sqlite");
    if (!existsSync(database) || statSync(database).size === 0) fail("capability seed did not create a nonempty database");
    const authorization = readFileSync(authFile, "utf8").trim();
    if (!authorization) fail("capability seed did not create authorization");
    const seededSchemaVersion = readSchemaVersion(database);
    const seededLayoutVersion = readSchemaVersion(database, "backupSchemaVersion");
    const seededSchemaSha256 = schemaSha256(database);
    if (seededSchemaVersion > expectedSchemaVersion || seededLayoutVersion > expectedLayoutVersion) fail("fixture schema is newer than the candidate");
    const schemaVersions = [];
    const layoutVersions = [];

    for (let index = 0; index < 2; index += 1) {
      const port = await reservePort();
      const run = await startAndProbe({
        launch,
        env: privateEnvironment(runRoot, {
          ...guardEnv,
          BENCH_ALLOWED_PORTS: `${new URL(provider.baseUrl).port},${port}`,
          TOKENPROXY_ARTIFACT_LOG_DIR: logDir,
          CAPABILITY_GATEWAY_AUTH: authorization,
          CAPABILITY_PROVIDER_BASE_URL: `${provider.baseUrl}/v1`,
          TOKENPROXY_EXPECTED_SCHEMA_VERSION: String(expectedSchemaVersion),
          TOKENPROXY_EXPECTED_LAYOUT_VERSION: String(expectedLayoutVersion),
        }),
        candidate,
        port,
        label: `start-${index + 1}`,
        during: index === 1
          ? (baseUrl) => runCapabilityMatrix({
            matrixScript: capability.matrixScript,
            baseUrl,
            providerControlUrl: provider.controlUrl,
            authorization,
            env,
          })
          : null,
      });
      receipt.starts.push(run);
      if (run.error) fail(run.error);
      if (run.cleanup?.listenerGone !== true || run.cleanup?.processesGone !== true || run.cleanup?.graceful !== true || run.cleanup?.forced === true || run.cleanup?.exitCode !== 0) {
        fail(`artifact ${run.label} did not stop cleanly`);
      }
      const schemaVersion = readSchemaVersion(database);
      const layoutVersion = readSchemaVersion(database, "backupSchemaVersion");
      schemaVersions.push(schemaVersion);
      layoutVersions.push(layoutVersion);
      if (schemaVersion !== expectedSchemaVersion) {
        fail(`artifact ${run.label} left schemaVersion ${schemaVersion}; expected ${expectedSchemaVersion}`);
      }
      if (layoutVersion !== expectedLayoutVersion) fail(`artifact ${run.label} left backupSchemaVersion ${layoutVersion}; expected ${expectedLayoutVersion}`);
    }

    const matrix = receipt.starts[1].during;
    receipt.capability = {
      manifest: basename(capability.manifest),
      manifestSha256: sha256File(capability.manifest),
      manifestCells: manifest.cells.length,
      primaryCells: manifest.primaryEndpoints.length,
      binaryProtocolCells: manifest.binaryProtocols.length,
      modalityRoutes: manifest.modalityRoutes.length,
      modalityCases: manifest.modalityRoutes.reduce((count, route) => count + (Array.isArray(route.cases) ? route.cases.length : 0), 0),
      passed: matrix.primary.passed,
      report: matrix,
    };
    receipt.persistence = {
      seeded: true,
      seededSchemaVersion,
      seededLayoutVersion,
      seedSchemaVersion: seededSchemaVersion,
      seedScriptSha256: sha256File(capability.seedScript),
      seededSchemaSha256,
      reopenedSchemaSha256: schemaSha256(database),
      migrationExercised: (seededSchemaVersion < expectedSchemaVersion || seededLayoutVersion < expectedLayoutVersion) && seededSchemaSha256 !== schemaSha256(database),
      migratedSchemaVersion: schemaVersions[0],
      reopenedSchemaVersion: schemaVersions[1],
      reopenedLayoutVersion: layoutVersions[1],
      reopened: schemaVersions.length === 2 && schemaVersions.every((version) => version === expectedSchemaVersion),
      databaseBytes: statSync(database).size,
      databaseSha256: sha256File(database),
    };
    receipt.state = "passed";
    receipt.reason = "built artifact passed exact identity, restart, persistence, capability, and owned cleanup checks";
  } catch (error) {
    receipt.reason = error.message;
  } finally {
    if (provider) {
      try { await provider.close(); }
      catch (error) { receipt.providerCleanupError = error.message; receipt.state = "failed"; }
    }
    receipt.finishedAt = new Date().toISOString();
  }
  return receipt;
}

function requiredPath(value, label) {
  if (!value) fail(`${label} is required`);
  const path = resolve(value);
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  return path;
}

export async function standaloneMain(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (!options.artifacts) fail("usage: verify-standalone.mjs --artifacts <empty-directory>");
  const artifacts = resolve(options.artifacts);
  const standaloneRoot = requiredPath(options["standalone-root"] || join(SCRIPT_ROOT, ".next", "standalone"), "standalone root");
  const entry = requiredPath(options.entry || join(standaloneRoot, "custom-server.js"), "standalone entry");
  const candidate = {
    sha: options["candidate-sha"] || gitSha(SCRIPT_ROOT),
    version: options["candidate-version"] || packageVersion(join(SCRIPT_ROOT, "package.json")),
  };
  if (!SHA_PATTERN.test(candidate.sha)) fail(`invalid candidate SHA: ${candidate.sha}`);
  const expectedSchemaVersion = await resolveExpectedSchemaVersion(options["expected-schema-version"]);
  const expectedLayoutVersion = await resolveExpectedLayoutVersion(options["expected-layout-version"]);
  const capability = capabilityOptions(options);
  const receipt = await qualifyStartedArtifact({
    artifacts,
    candidate,
    launch: { command: process.execPath, args: () => [entry], cwd: standaloneRoot },
    capability,
    expectedSchemaVersion,
    expectedLayoutVersion,
  });
  receipt.schema = "tokenproxy-standalone-qualification-v1";
  if (receipt.artifactsPrepared) {
    writeFileSync(join(artifacts, "standalone-evidence.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(`${receipt.state.toUpperCase()} ${receipt.reason}; evidence=${receipt.artifactsPrepared ? join(artifacts, "standalone-evidence.json") : "none"}`);
  return receipt.state === "passed" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  standaloneMain().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`FAILED ${error.message}`);
    process.exitCode = 1;
  });
}
