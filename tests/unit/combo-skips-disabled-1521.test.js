import { describe, expect, it, vi, beforeEach } from "vitest";

// getDisabledModels was consulted only by /v1/models, so a disabled model
// vanished from the listing and kept being routed to as a combo member. The
// dashboard control is labelled "Disable", not "Hide".
let disabled = {};
let throws = false;
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: async () => { if (throws) throw new Error("db down"); return disabled; },
}));

const load = async () => (await import("../../src/sse/services/model.js")).filterDisabledComboMembers;

describe("a combo skips members the operator disabled (#1521)", () => {
  beforeEach(() => { disabled = {}; throws = false; });

  it("drops a disabled member", async () => {
    disabled = { ds: ["deepseek-v4-pro"] };
    expect(await (await load())(["ds/deepseek-v4-pro", "cx/gpt-5.5"], "c"))
      .toEqual(["cx/gpt-5.5"]);
  });

  it("returns the list untouched when nothing is disabled", async () => {
    disabled = { other: ["x"] };
    const models = ["ds/deepseek-v4-pro", "cx/gpt-5.5"];
    expect(await (await load())(models, "c")).toEqual(models);
  });

  it("does not resurrect disabled members when the entire combo is disabled", async () => {
    disabled = { ds: ["deepseek-v4-pro"] };
    expect(await (await load())(["ds/deepseek-v4-pro"], "c")).toEqual([]);
  });

  it("matches the exact provider alias, not a prefix or a superstring", async () => {
    disabled = { d: ["deepseek-v4-pro"], dsx: ["deepseek-v4-pro"] };
    expect(await (await load())(["ds/deepseek-v4-pro", "cx/gpt-5.5"], "c"))
      .toEqual(["ds/deepseek-v4-pro", "cx/gpt-5.5"]);
  });

  it("resolves a bare model name before checking its provider policy", async () => {
    disabled = { ds: ["deepseek-v4-pro"] };
    expect(await (await load())(["deepseek-v4-pro", "cx/gpt-5.5"], "c"))
      .toEqual(["cx/gpt-5.5"]);
  });

  it("never fails a route because the disabled list is unreadable", async () => {
    throws = true;
    const models = ["ds/deepseek-v4-pro"];
    expect(await (await load())(models, "c")).toEqual(models);
  });

  it("survives a malformed disabled map", async () => {
    disabled = null;
    const models = ["ds/deepseek-v4-pro"];
    expect(await (await load())(models, "c")).toEqual(models);
  });
});
