import { describe, expect, it } from "vitest";
import { startProviderStub } from "../contracts/provider-stub.mjs";
import { runCapabilityMatrix } from "../contracts/run-capability-matrix.mjs";

describe("offline capability provider", () => {
  it("executes every valid primary cell and rejects malformed input before dispatch", async () => {
    const stub = await startProviderStub({ port: 20210 });
    try {
      const report = await runCapabilityMatrix({ baseUrl: stub.baseUrl });
      expect(report.primary).toEqual({ passed: 36, dispatched: 30, rejectedLocally: 6 });
      expect(report.outcomes).toEqual({ success: 1, providerError: 1, transportAbrupt: 1 });
      expect(stub.requests).toHaveLength(33);
      expect(stub.requests.every((entry) => !Object.hasOwn(entry, "body"))).toBe(true);
    } finally {
      await stub.close();
    }
  });
});
