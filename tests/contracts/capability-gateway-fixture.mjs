import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const seedPath = fileURLToPath(new URL("./capability-gateway-seed.mjs", import.meta.url));
const guardPath = fileURLToPath(new URL("../qa/gateway-performance/guard.cjs", import.meta.url));

async function waitForReady(url, child, output) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`capability gateway exited ${child.exitCode}: ${output()}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
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
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(`${baseUrl}/api/version`, child, () => stderr);
    const authorization = (await readFile(authFile, "utf8")).trim();
    return {
      baseUrl,
      authorization,
      async close() {
        if (child.exitCode === null) {
          const exited = new Promise((resolve) => child.once("exit", resolve));
          child.kill("SIGTERM");
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
          if (child.exitCode === null) {
            const killed = new Promise((resolve) => child.once("exit", resolve));
            child.kill("SIGKILL");
            await killed;
          }
        }
        await rm(dataDir, { recursive: true, force: true });
        return { processExitCode: child.exitCode, dataDirRemoved: !existsSync(dataDir) };
      },
    };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
