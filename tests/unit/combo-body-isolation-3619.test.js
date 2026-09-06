import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";

// The translators mutate what they are handed, because for a single request the
// body is theirs to consume: prepareClaudeRequest rewrites msg.content in place,
// stamps cache_control onto blocks, de-prefixes a model sitting on a tool. A
// combo handed the SAME object to every model in turn, so provider two saw a
// history already rewritten for provider one — and a chain that works model by
// model fails as a combo (#3619).
const log = { info: () => {}, warn: () => {}, error: () => {}, line: () => {} };

const freshBody = () => ({
  model: "combo",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [{ name: "Bash", model: "cc/claude-opus-4-8", input_schema: { type: "object" } }],
});

const fail = () => new Response(JSON.stringify({ error: { message: "nope" } }), {
  status: 500, headers: { "Content-Type": "application/json", "x-tokenproxy-replay-safe": "true" },
});
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
  status: 200, headers: { "Content-Type": "application/json" },
});

describe("each combo attempt gets its own body (#3619)", () => {
  it("a translator that mutates the first attempt does not reach the second", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (b, m) => {
      seen.push({ model: m, blocks: b.messages[0].content.length, toolModel: b.tools[0].model });
      // What a real translator does to the body it is given.
      b.messages[0].content = [{ type: "text", text: "rewritten for provider one" }];
      b.tools[0].model = "claude-opus-4-8";
      b.messages[0].content[0].cache_control = { type: "ephemeral" };
      return m === "b/second" ? ok() : fail();
    });

    await handleComboChat({
      body: freshBody(), models: ["a/first", "b/second"], handleSingleModel,
      log, comboName: "combo", comboStrategy: "fallback",
    });

    expect(seen).toHaveLength(2);
    // The second attempt must see the client's original history, not the first
    // provider's rewrite of it.
    expect(seen[1].toolModel).toBe("cc/claude-opus-4-8");
    expect(seen[1].blocks).toBe(seen[0].blocks);
    expect(seen[1].toolModel).toBe(seen[0].toolModel);
  });

  it("the caller's own body is left untouched, so a retry above this layer is clean", async () => {
    const body = freshBody();
    const handleSingleModel = vi.fn(async (b) => {
      b.messages.push({ role: "assistant", content: "injected" });
      b.tools.length = 0;
      return ok();
    });
    await handleComboChat({
      body, models: ["a/first"], handleSingleModel, log,
      comboName: "combo", comboStrategy: "fallback",
    });
    expect(body.messages).toHaveLength(1);
    expect(body.tools).toHaveLength(1);
  });

  it("the copy still carries everything the attempt needs", async () => {
    let got = null;
    await handleComboChat({
      body: freshBody(), models: ["a/first"],
      handleSingleModel: async (b) => { got = b; return ok(); },
      log, comboName: "combo", comboStrategy: "fallback",
    });
    expect(got.model).toBe("combo");
    expect(got.messages[0].content[0].text).toBe("hello");
    expect(got.tools[0].name).toBe("Bash");
  });

  it("a body that cannot be cloned is passed through rather than failing the request", async () => {
    // structuredClone throws on a function; the sharing bug is worse than the
    // clone, but neither is worse than a 500.
    const body = { ...freshBody(), onSomething: () => {} };
    let called = false;
    const res = await handleComboChat({
      body, models: ["a/first"],
      handleSingleModel: async () => { called = true; return ok(); },
      log, comboName: "combo", comboStrategy: "fallback",
    });
    expect(called).toBe(true);
    expect(res.status).toBe(200);
  });
});
