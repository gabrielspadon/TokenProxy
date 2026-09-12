import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startProviderStub } from "../contracts/provider-stub.mjs";
import { assertSemanticPreserved, semanticReceipt } from "../contracts/provider-semantic.mjs";
import {
  captureGatewayOwnership,
  startCapabilityGateway,
  stopOwnedGateway,
} from "../contracts/capability-gateway-fixture.mjs";

function startOwnedHttpProcess(name) {
  const script = [
    'const http = require("node:http");',
    'const server = http.createServer((_request, response) => response.end("fixture"));',
    'server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\\n`));',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script, name], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const port = Number(output.trim());
      if (Number.isInteger(port) && port > 0) resolve({ child, port });
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`${name} exited before ready: ${code}`)));
  });
}

async function stopExactChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
}

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

describe("capability matrix runner", () => {
  it("binds roles, content order, and control values in semantic receipts", () => {
    const source = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second", reasoning_content: "because" },
      ],
      reasoning_effort: "high",
    };
    expect(() => assertSemanticPreserved(source, semanticReceipt({
      messages: [
        { role: "assistant", content: "first", reasoning_content: "because" },
        { role: "user", content: "second" },
      ],
      reasoning_effort: "low",
    }), "swapped-semantic-fixture")).toThrow();
    expect(() => assertSemanticPreserved(source, semanticReceipt({ messages: source.messages }), "missing-control-fixture")).toThrow();
    expect(() => assertSemanticPreserved({ reasoning: { effort: "high" } }, semanticReceipt({ reasoning_effort: "low" }), "mapped-control-fixture")).toThrow();
  });

  it("cleanup targets only its captured child group when an unrelated next-server exists", async () => {
    const owned = await startOwnedHttpProcess("capability-owned-gateway");
    const unrelated = await startOwnedHttpProcess("next-server");
    try {
      const ownership = await captureGatewayOwnership(owned.child, owned.port);
      await stopOwnedGateway(owned.child, ownership);
      expect(owned.child.exitCode).toBe(0);
      expect(unrelated.child.exitCode).toBeNull();
    } finally {
      await stopExactChild(owned.child);
      await stopExactChild(unrelated.child);
    }
  });

  it("runs all fixtures through a started TokenProxy gateway with env-provided fake auth", async () => {
    const stub = await startProviderStub({ port: 20210 });
    const gatewayPort = await reserveLoopbackPort();
    let gateway;
    let cleanup;
    try {
      gateway = await startCapabilityGateway({ providerBaseUrl: `${stub.baseUrl}/v1`, port: gatewayPort });
      const runner = fileURLToPath(new URL("../contracts/run-capability-matrix.mjs", import.meta.url));
      const output = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          runner,
          `--gateway-base-url=${gateway.baseUrl}`,
          `--provider-control-url=${stub.controlUrl}`,
          "--authorization-env=CAPABILITY_GATEWAY_AUTH",
          "--model=fixture/fixture-model",
        ], {
          env: { ...process.env, CAPABILITY_GATEWAY_AUTH: gateway.authorization },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`matrix CLI exited ${code}: ${stderr}`)));
      });
      const report = JSON.parse(output.trim());
      expect(report.primary).toEqual({ passed: 36, dispatched: 30, rejectedBeforeUpstream: 6 });
      expect(report.outcomes.success).toBe(1);
      expect(report.outcomes.providerError).toEqual({ status: 529, type: "server_error", code: "internal_server_error" });
      expect(report.outcomes.transportAbrupt).toEqual({ status: 502, type: "server_error", code: "bad_gateway" });
      expect(report.receipts).toMatchObject({
        nextGatewayResponses: 39,
        providerIngress: { before: 0, after: 33, delta: 33 },
        providerDispatch: { before: 0, after: 33, delta: 33 },
      });
      expect(Object.keys(report.receipts.providerSemantic)).toHaveLength(33);
      expect(Object.values(report.receipts.providerSemantic).every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(true);
      expect(stub.requests).toHaveLength(33);
      expect(stub.ingress).toHaveLength(33);
      expect(stub.requests.every((entry) => !Object.hasOwn(entry, "body"))).toBe(true);
      expect(stub.requests.every((entry) => entry.label !== "unspecified")).toBe(true);
      expect(stub.requests.every((entry) => entry.model === "fixture-model")).toBe(true);
      expect(stub.requests.every((entry) => entry.semantic?.digest && entry.semantic?.shape)).toBe(true);
      cleanup = await gateway.close();
      gateway = null;
      expect(cleanup).toMatchObject({
        processExitCode: 0,
        listenerGone: true,
        dataDirRemoved: true,
        buildOutputRemoved: true,
        ownership: {
          child: { pid: expect.any(Number), startTime: expect.any(String), pgid: expect.any(Number), cgroup: expect.any(String) },
          listener: { pid: expect.any(Number), startTime: expect.any(String), pgid: expect.any(Number), cgroup: expect.any(String) },
          port: gatewayPort,
        },
      });
    } finally {
      await gateway?.close();
      await stub.close();
    }
  });
});
