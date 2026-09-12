import { describe, expect, it } from "vitest";
import { startProviderStub } from "../contracts/provider-stub.mjs";
import { runCapabilityMatrix } from "../contracts/run-capability-matrix.mjs";

describe("offline capability provider", () => {
  it("executes every valid primary cell and rejects malformed input before dispatch", async () => {
    const stub = await startProviderStub({ port: 20210 });
    try {
      const report = await runCapabilityMatrix({
        baseUrl: stub.baseUrl,
        controlUrl: stub.controlUrl,
        requestHeaders: { authorization: "Bearer fixture-client-key" },
        model: "fixture-model-override",
      });
      expect(report.primary).toEqual({ passed: 36, dispatched: 30, rejectedBeforeUpstream: 6 });
      expect(report.outcomes.success).toBe(1);
      expect(report.outcomes.providerError).toBe(1);
      expect(report.outcomes.transportAbrupt).toEqual({ fetchRejected: true });
      expect(stub.requests).toHaveLength(33);
      expect(stub.requests.every((entry) => !Object.hasOwn(entry, "body"))).toBe(true);
      expect(stub.requests.every((entry) => entry.label !== "unspecified")).toBe(true);
      expect(stub.requests.every((entry) => entry.model === "fixture-model-override")).toBe(true);
    } finally {
      await stub.close();
    }
  });
});
