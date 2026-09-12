import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const serverPath = fileURLToPath(new URL("./capability-gateway-server.mjs", import.meta.url));
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
  let stderr = "";
  const child = spawn(process.execPath, ["--require", guardPath, serverPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      CAPABILITY_GATEWAY_PORT: String(port),
      CAPABILITY_PROVIDER_BASE_URL: providerBaseUrl,
      CAPABILITY_AUTH_FILE: authFile,
      BENCH_RUN_ID: "capability-gateway-fixture",
      BENCH_ALLOWED_PORTS: String(new URL(providerBaseUrl).port),
      JWT_SECRET: "capability-fixture-jwt-secret",
      INITIAL_PASSWORD: "capability-fixture-password",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(`${baseUrl}/__ready`, child, () => stderr);
    const authorization = (await readFile(authFile, "utf8")).trim();
    return {
      baseUrl,
      controlUrl: `${baseUrl}/__tokenproxy_fixture/gateway-control`,
      authorization,
      async close() {
        if (child.exitCode === null) {
          const exited = new Promise((resolve) => child.once("exit", resolve));
          child.kill("SIGTERM");
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
