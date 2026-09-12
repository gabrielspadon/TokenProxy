import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startProviderStub } from "../contracts/provider-stub.mjs";
import { startCapabilityGateway } from "../contracts/capability-gateway-fixture.mjs";

describe("capability matrix runner", () => {
  it("runs all fixtures through a started TokenProxy gateway with env-provided fake auth", async () => {
    const stub = await startProviderStub({ port: 20210 });
    let gateway;
    let cleanup;
    try {
      gateway = await startCapabilityGateway({ providerBaseUrl: `${stub.baseUrl}/v1`, port: 20211 });
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
      expect(report.receipts).toEqual({
        nextGatewayResponses: 39,
        providerIngress: { before: 0, after: 33, delta: 33 },
        providerDispatch: { before: 0, after: 33, delta: 33 },
      });
      expect(stub.requests).toHaveLength(33);
      expect(stub.ingress).toHaveLength(33);
      expect(stub.requests.every((entry) => !Object.hasOwn(entry, "body"))).toBe(true);
      expect(stub.requests.every((entry) => entry.label !== "unspecified")).toBe(true);
      expect(stub.requests.every((entry) => entry.model === "fixture-model")).toBe(true);
      cleanup = await gateway.close();
      gateway = null;
      expect(cleanup).toEqual({ processExitCode: 0, dataDirRemoved: true });
    } finally {
      await gateway?.close();
      await stub.close();
    }
  });
});
