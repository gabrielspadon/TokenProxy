import { describe, expect, it } from "vitest";
import { projectEligibility } from "../../src/lib/admin/eligibility.js";

const node = { id: "openai-compatible-fixture-node", prefix: "fixture-proxy", type: "openai-compatible", baseUrl: "https://user:SYNTHETIC_SECRET@example.invalid", token: "SYNTHETIC_SECRET" };
const model = "vendor/model";
const account = (id, provider = node.id) => ({ id, provider, isActive: true, providerSpecificData: { enabledModels: [model] } });
const project = (provider, extra = {}) => projectEligibility({ connections: [account("one")], providerNodes: [node], windowsByConnection: new Map(), provider, model, ...extra });

describe("passive eligibility follows configured provider-node routing", () => {
  it.each([node.id, node.prefix])("uses the verified node prefix's disable policy for %s", (provider) => {
    const result = project(provider, { disabledModels: { "fixture-proxy::one": [model] } });
    expect(result.requested.provider).toBe(node.id);
    expect(result.accounts[0].reasons.some((r) => r.code === "provider-mismatch")).toBe(false);
    expect(result.accounts[0].verdict).toBe("blocked");
    expect(result.accounts[0].reasons.some((r) => r.code === "model-disabled")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
  });
  it("honors account empty overrides across node-id and prefix spellings", () => {
    const result = project(node.prefix, { connections: [account("one"), account("two")], disabledModels: { "fixture-proxy": [model], [`${node.id}::one`]: [] } });
    expect(result.accounts.map((a) => a.verdict)).toEqual(["admissible", "blocked"]);
  });
  it("gives configured prefixes precedence over built-in aliases without admitting built-in accounts", () => {
    const result = project("cc", { providerNodes: [{ ...node, prefix: "cc" }], connections: [account("node"), account("builtin", "claude")] });
    expect(result.requested.provider).toBe(node.id);
    expect(result.accounts.map((a) => a.verdict)).toEqual(["admissible", "blocked"]);
  });
  it("keeps a node's global disable separate from the built-in provider whose alias it shadows", () => {
    const extra = { providerNodes: [{ ...node, prefix: 'cc' }],
      connections: [account('node'), account('builtin', 'claude')], disabledModels: { cc: [model] } };
    const builtin = project('claude', extra);
    expect(builtin.accounts[1].verdict).toBe('admissible');
    expect(builtin.accounts[1].reasons.some((r) => r.code === 'model-disabled')).toBe(false);
    const configured = project('cc', extra);
    expect(configured.accounts[0].verdict).toBe('blocked');
    expect(configured.accounts[0].reasons.some((r) => r.code === 'model-disabled')).toBe(true);
  });
  it("uses the selector's node-type precedence when multiple nodes share a prefix", () => {
    const nodes = [{ ...node, id: "anthropic-fixture", type: "anthropic-compatible" }, node];
    expect(project(node.prefix, { providerNodes: nodes }).requested.provider).toBe(node.id);
  });
  it("does not invent a node alias from model names or unrecognized node types", () => {
    const result = project("vendor", { providerNodes: [{ ...node, prefix: "vendor", type: "not-a-routed-node" }] });
    expect(result.requested.provider).toBe("vendor");
    expect(result.accounts[0].reasons.some((r) => r.code === "provider-mismatch")).toBe(true);
  });
  it("resolves additional static aliases through the actual engine registry", () => {
    const result = project("ocg", { providerNodes: [], connections: [account("one", "opencode-go")], disabledModels: { "opencode-go::one": [model] } });
    expect(result.requested.provider).toBe("opencode-go");
    expect(result.accounts[0].reasons.some((r) => r.code === "provider-mismatch")).toBe(false);
    expect(result.accounts[0].verdict).toBe("blocked");
  });
});
