import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const seedPath = fileURLToPath(new URL("./capability-gateway-seed.mjs", import.meta.url));
const guardPath = fileURLToPath(new URL("../qa/gateway-performance/guard.cjs", import.meta.url));

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseProcStat(pid, stat) {
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error(`cannot parse /proc/${pid}/stat`);
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return {
    pid,
    pgid: Number(fields[2]),
    startTime: fields[19],
  };
}

async function readProcessIdentity(pid) {
  try {
    const [stat, cgroup] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cgroup`, "utf8"),
    ]);
    return { ...parseProcStat(pid, stat), cgroup };
  } catch {
    return null;
  }
}

function sameIdentity(actual, expected) {
  return actual?.pid === expected.pid
    && actual.startTime === expected.startTime
    && actual.pgid === expected.pgid
    && actual.cgroup === expected.cgroup;
}

async function listeningSocketInodes(port) {
  const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map(async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }));
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[1]?.endsWith(`:${expectedPort}`) && fields[3] === "0A" && fields[9]) inodes.add(fields[9]);
    }
  }
  return inodes;
}

async function listeningProcessIdentities(port) {
  const inodes = await listeningSocketInodes(port);
  if (!inodes.size) return [];
  const processes = await readdir("/proc", { withFileTypes: true });
  const listeners = [];
  for (const process of processes) {
    if (!process.isDirectory() || !/^\d+$/.test(process.name)) continue;
    const pid = Number(process.name);
    let fds;
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    let ownsListeningSocket = false;
    for (const fd of fds) {
      try {
        const link = await readlink(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(link);
        if (match && inodes.has(match[1])) {
          ownsListeningSocket = true;
          break;
        }
      } catch {}
    }
    if (!ownsListeningSocket) continue;
    const identity = await readProcessIdentity(pid);
    if (identity) listeners.push(identity);
  }
  return listeners;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return Promise.race([exit, sleep(timeoutMs).then(() => null)]);
}

async function assertOwnedGateway(ownership, { requireChild = true } = {}) {
  const currentChild = await readProcessIdentity(ownership.child.pid);
  if (requireChild && !sameIdentity(currentChild, ownership.child)) {
    throw new Error("refusing to signal gateway because the spawned child identity changed");
  }
  const listeners = await listeningProcessIdentities(ownership.port);
  if (!listeners.some((listener) => sameIdentity(listener, ownership.listener))) {
    throw new Error("refusing to signal gateway because its captured listener no longer owns the port");
  }
  return { currentChild, listeners };
}

/**
 * Capture the process tree that this fixture itself spawned. No process name
 * lookup participates in this receipt. The gateway lead must own a fresh
 * process group and the listener must be in that group and cgroup.
 */
export async function captureGatewayOwnership(child, port, expectedChild = null) {
  if (!child?.pid) throw new Error("gateway child PID is required");
  const identity = await readProcessIdentity(child.pid);
  if (!identity) throw new Error("gateway child exited before ownership capture");
  if (expectedChild && !sameIdentity(identity, expectedChild)) {
    throw new Error("gateway child identity changed before ownership capture");
  }
  if (identity.pgid !== identity.pid) throw new Error("gateway child must lead its own process group");
  const listeners = await listeningProcessIdentities(port);
  const listener = listeners.find((candidate) => candidate.pgid === identity.pgid && candidate.cgroup === identity.cgroup);
  if (!listener) throw new Error("gateway listener is not owned by the spawned child group");
  return { child: identity, listener, port };
}

/**
 * Signal only the detached group whose child, start time, cgroup and listener
 * were captured above. A changed PID, group or port owner is a hard refusal.
 */
export async function stopOwnedGateway(child, ownership) {
  await assertOwnedGateway(ownership);
  process.kill(-ownership.child.pgid, "SIGTERM");
  let exitCode = await waitForExit(child, 3000);
  const activeListeners = await listeningProcessIdentities(ownership.port);
  if (exitCode === null || activeListeners.some((listener) => sameIdentity(listener, ownership.listener))) {
    await assertOwnedGateway(ownership, { requireChild: exitCode === null });
    process.kill(-ownership.child.pgid, "SIGKILL");
    exitCode = await waitForExit(child, 3000);
  }
  if (exitCode === null) throw new Error("owned gateway group did not exit after SIGKILL");
  if ((await listeningProcessIdentities(ownership.port)).length) {
    throw new Error("gateway port remains occupied after owned group cleanup");
  }
  return exitCode;
}

async function waitForChildIdentity(child) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const identity = await readProcessIdentity(child.pid);
    if (identity) return identity;
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  throw new Error("gateway child exited before identity capture");
}

async function waitForReady(url, child, expectedChild, port, output) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`capability gateway exited ${child.exitCode}: ${output()}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return captureGatewayOwnership(child, port, expectedChild);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`capability gateway did not become ready: ${output()}`);
}

export async function startCapabilityGateway({ providerBaseUrl, port = 20211 } = {}) {
  if (!providerBaseUrl) throw new Error("providerBaseUrl is required");
  const dataDir = await mkdtemp(join(tmpdir(), "tokenproxy-capability-gateway-"));
  const authFile = join(dataDir, "fixture-authorization");
  const nextDistDir = join(dataDir, "next-dist");
  const env = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    NODE_ENV: "development",
    DATA_DIR: dataDir,
    NEXT_DIST_DIR: nextDistDir,
    CAPABILITY_PROVIDER_BASE_URL: providerBaseUrl,
    CAPABILITY_AUTH_FILE: authFile,
    BENCH_RUN_ID: "capability-gateway-fixture",
    BENCH_ALLOWED_PORTS: String(new URL(providerBaseUrl).port),
    DB_ENCRYPTION_KEY: "capability-gateway-fixture-db-key",
    JWT_SECRET: "capability-fixture-jwt-secret",
    INITIAL_PASSWORD: "capability-fixture-password",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const seed = spawn(process.execPath, ["--require", guardPath, seedPath], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let seedStderr = "";
  seed.stderr.on("data", (chunk) => { seedStderr = `${seedStderr}${chunk}`.slice(-8000); });
  const seedExit = await new Promise((resolve, reject) => {
    seed.once("error", reject);
    seed.once("exit", resolve);
  });
  if (seedExit !== 0) {
    await rm(dataDir, { recursive: true, force: true });
    throw new Error(`capability gateway seed exited ${seedExit}: ${seedStderr}`);
  }
  let stderr = "";
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const spawnedChild = await waitForChildIdentity(child);
  try {
    const ownership = await waitForReady(`${baseUrl}/api/version`, child, spawnedChild, port, () => stderr);
    const authorization = (await readFile(authFile, "utf8")).trim();
    return {
      baseUrl,
      authorization,
      ownership,
      async close() {
        const processExitCode = child.exitCode === null ? await stopOwnedGateway(child, ownership) : child.exitCode;
        await rm(dataDir, { recursive: true, force: true });
        return { processExitCode, dataDirRemoved: !existsSync(dataDir), ownership };
      },
    };
  } catch (error) {
    // Before ownership capture, do not guess from a process name or a port.
    // A child that has already exited is safe to clean up; a still-running
    // unverified child is deliberately left untouched for diagnosis.
    if (child.exitCode !== null) await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
