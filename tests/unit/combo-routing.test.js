import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function successfulResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fallbackResponse() {
  return new Response(JSON.stringify({ error: { message: "context length" } }), {
    status: 400,
    headers: { "Content-Type": "application/json", "x-tokenproxy-replay-safe": "true" },
  });
}

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("continues after the model that succeeds through a round-robin fallback", async () => {
    const models = ["provider/model-a", "provider/model-b", "provider/model-c"];
    const comboName = "fallback-cycle";
    const attempted = [];

    // Advance the normal round-robin state so this request begins c -> a -> b.
    getRotatedModels(models, comboName, "round-robin");
    getRotatedModels(models, comboName, "round-robin");

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel: async (_body, modelStr) => {
        attempted.push(modelStr);
        return modelStr === "provider/model-b"
          ? successfulResponse()
          : fallbackResponse();
      },
      log: silentLog,
      comboName,
      comboStrategy: "round-robin",
      autoSwitch: false,
    });

    expect(response.ok).toBe(true);
    expect(attempted).toEqual([
      "provider/model-c",
      "provider/model-a",
      "provider/model-b",
    ]);
    expect(getRotatedModels(models, comboName, "round-robin")[0]).toBe("provider/model-c");
  });

  it("continues after the successful duplicate model occurrence", async () => {
    const models = ["provider/model-a", "provider/model-b", "provider/model-a", "provider/model-c"];
    const comboName = "duplicate-fallback-cycle";
    const attempted = [];

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel: async (_body, modelStr) => {
        attempted.push(modelStr);
        return attempted.length === 3 ? successfulResponse() : fallbackResponse();
      },
      log: silentLog,
      comboName,
      comboStrategy: "round-robin",
      autoSwitch: false,
    });

    expect(response.ok).toBe(true);
    expect(attempted).toEqual(["provider/model-a", "provider/model-b", "provider/model-a"]);
    expect(getRotatedModels(models, comboName, "round-robin")[0]).toBe("provider/model-c");
  });

  it("uses the successful model's original position after auto-switch reorders fallbacks", async () => {
    const models = [
      "deepseek/deepseek-chat",
      "anthropic/claude-sonnet-4.6",
      "deepseek/deepseek-reasoner",
    ];
    const comboName = "auto-switch-fallback-cycle";
    const attempted = [];

    // This makes the unmodified rotation begin c -> a -> b. Auto-switch moves
    // the vision-capable b to the front, yielding b -> c -> a for this request.
    getRotatedModels(models, comboName, "round-robin");
    getRotatedModels(models, comboName, "round-robin");

    const response = await handleComboChat({
      body: {
        messages: [{
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }],
        }],
      },
      models,
      handleSingleModel: async (_body, modelStr) => {
        attempted.push(modelStr);
        return modelStr === "deepseek/deepseek-reasoner"
          ? successfulResponse()
          : fallbackResponse();
      },
      log: silentLog,
      comboName,
      comboStrategy: "round-robin",
    });

    expect(response.ok).toBe(true);
    expect(attempted).toEqual([
      "anthropic/claude-sonnet-4.6",
      "deepseek/deepseek-reasoner",
    ]);
    expect(getRotatedModels(models, comboName, "round-robin")[0]).toBe("deepseek/deepseek-chat");
  });

  it("resets sticky rotation after a successful fallback", async () => {
    const models = ["provider/model-a", "provider/model-b", "provider/model-c"];
    const comboName = "sticky-fallback-cycle";

    // Consume a's sticky turn, leaving b as this request's first candidate.
    getRotatedModels(models, comboName, "round-robin", 2);
    getRotatedModels(models, comboName, "round-robin", 2);

    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel: async (_body, modelStr) => (
        modelStr === "provider/model-c" ? successfulResponse() : fallbackResponse()
      ),
      log: silentLog,
      comboName,
      comboStrategy: "round-robin",
      comboStickyLimit: 2,
      autoSwitch: false,
    });

    expect(getRotatedModels(models, comboName, "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, comboName, "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("keeps normal round-robin advancement when the first model succeeds", async () => {
    const models = ["provider/model-a", "provider/model-b", "provider/model-c"];
    const comboName = "first-success";
    const attempted = [];

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel: async (_body, modelStr) => {
        attempted.push(modelStr);
        return successfulResponse();
      },
      log: silentLog,
      comboName,
      comboStrategy: "round-robin",
      autoSwitch: false,
    });

    expect(response.ok).toBe(true);
    expect(attempted).toEqual(["provider/model-a"]);
    expect(getRotatedModels(models, comboName, "round-robin")[0]).toBe("provider/model-b");
  });
});
