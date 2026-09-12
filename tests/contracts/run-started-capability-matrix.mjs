#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startCapabilityGateway } from "./capability-gateway-fixture.mjs";
import { startProviderStub } from "./provider-stub.mjs";
import { cleanOwnedTreeBinding } from "./receipt-tree-binding.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const matrixRunner = fileURLToPath(new URL("./run-capability-matrix.mjs", import.meta.url));
const treeBinding = cleanOwnedTreeBinding(root);

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startIsolatedProviderStub() {
  let lastError;
  for (let port = 20210; port <= 20219; port++) {
    try {
      return await startProviderStub({ port });
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("no fixture provider port is available");
}

function runMatrixCli(gateway, stub) {
  const args = [
    matrixRunner,
    `--gateway-base-url=${gateway.baseUrl}`,
    `--provider-control-url=${stub.controlUrl}`,
    "--authorization-env=CAPABILITY_GATEWAY_AUTH",
    "--model=fixture/fixture-model",
  ];
  const command = [process.execPath, ...args].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, CAPABILITY_GATEWAY_AUTH: gateway.authorization },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ command, report: JSON.parse(stdout) });
      else reject(new Error(`matrix CLI exited ${code}: ${stderr}`));
    });
  });
}

const startedAt = new Date().toISOString();
const stub = await startIsolatedProviderStub();
const gatewayPort = await reserveLoopbackPort();
let gateway;
try {
  gateway = await startCapabilityGateway({ providerBaseUrl: `${stub.baseUrl}/v1`, port: gatewayPort });
  const { command, report } = await runMatrixCli(gateway, stub);
  const cleanup = await gateway.close();
  gateway = null;
  process.stdout.write(`${JSON.stringify({
    schema: "tokenproxy-t07-started-next-matrix-v3",
    startedAt,
    treeBinding,
    command,
    node: process.version,
    report,
    cleanup,
    providerStub: { ingress: stub.ingress.length, dispatches: stub.requests.length },
  })}\n`);
} finally {
  await gateway?.close();
  await stub.close();
}
