import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildProviderSpecificData } from "../../src/shared/utils/providerSpecificData.js";
import googlePse from "../../open-sse/providers/registry/google-pse.js";
import { getProviderSetting } from "../../open-sse/handlers/search/callers.js";

// buildGooglePseRequest reads the search engine id from providerSpecificData.cx
// and throws "requires both apiKey and cx" without it, but the API-key form only
// ever collected a key, so every Google PSE connection failed its own test.
describe("Google PSE can be given its search engine id (#3402)", () => {
  it("declares the field on the registry entry", () => {
    const cx = googlePse.extraFields?.find((f) => f.key === "cx");
    expect(cx, "google-pse declares no cx field").toBeTruthy();
    expect(cx.label).toMatch(/cx/i);
    expect(cx.required).toBe(true);
  });

  it("stores a typed value where the search caller reads it", () => {
    const data = buildProviderSpecificData({ extraValues: { cx: "a1b2c3" } });
    expect(data).toEqual({ cx: "a1b2c3" });
    expect(getProviderSetting({ providerSpecificData: data }, "cx")).toBe("a1b2c3");
  });

  it("trims, and drops an empty value rather than saving a blank credential", () => {
    expect(buildProviderSpecificData({ extraValues: { cx: "  padded  " } })).toEqual({ cx: "padded" });
    expect(buildProviderSpecificData({ extraValues: { cx: "   " } })).toBeUndefined();
    expect(buildProviderSpecificData({ extraValues: {} })).toBeUndefined();
  });

  it("does not disturb the other shapes the builder produces", () => {
    expect(buildProviderSpecificData({ hasBaseUrlField: true, baseUrl: "http://h" })).toEqual({ baseUrl: "http://h" });
    expect(buildProviderSpecificData({ isCloudflareAi: true, cloudflareData: { accountId: "acc" } })).toEqual({ accountId: "acc" });
    expect(buildProviderSpecificData({ hasRegions: true, region: "eu" })).toEqual({ region: "eu" });
    expect(buildProviderSpecificData({})).toBeUndefined();
  });

  it("composes with a base URL rather than replacing it", () => {
    expect(buildProviderSpecificData({ hasBaseUrlField: true, baseUrl: "http://h", extraValues: { cx: "x" } }))
      .toEqual({ baseUrl: "http://h", cx: "x" });
  });
});
