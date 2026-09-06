// Structural validator tests for open-sse/rtk/headroom.js compressWithHeadroom.
// Fetch is stubbed the way tests/unit/headroom.test.js does it; every case
// asserts both the verdict and that the caller's body is either committed
// (content swapped in place) or left byte-identical.

import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom as compressWithPolicy } from "../../open-sse/rtk/headroom.js";
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });

const PROXY = "http://127.0.0.1:8787";
const BIG = "x".repeat(2000);

function okRes(messages, stats = {}) {
  return new Response(
    JSON.stringify({
      messages,
      tokens_before: 100000,
      tokens_after: 5000,
      tokens_saved: 95000,
      ...stats,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function run(body, format, fetchImpl) {
  global.fetch = vi.fn(fetchImpl);
  const before = JSON.parse(JSON.stringify(body));
  const diagnostics = {};
  const result = await compressWithHeadroom(body, {
    enabled: true,
    url: PROXY,
    model: "m",
    format,
    diagnostics,
  });
  return { body, before, result, diagnostics, fetchMock: global.fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openai chat.completions validator: tool pairing identity", () => {
  const sourceBody = () => ({
    model: "m",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: BIG },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: BIG },
      { role: "user", content: "next" },
    ],
  });

  it("commits when tool_call_id and tool_calls ids are preserved", async () => {
    const candidate = [
      { role: "system", content: "sys" },
      { role: "user", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "user", content: "ok" },
    ];
    const { body, result } = await run(sourceBody(), "openai", async () => okRes(candidate));
    expect(result).not.toBeNull();
    expect(body.messages[1].content).toBe("ok");
    expect(body.messages[2].tool_calls[0].id).toBe("call_1");
    expect(body.messages[3].tool_call_id).toBe("call_1");
  });

  it("rejects a response that rewrites a tool_call_id", async () => {
    const candidate = [
      { role: "system", content: "sys" },
      { role: "user", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_EVIL", content: "ok" },
      { role: "user", content: "ok" },
    ];
    const { body, before, result, diagnostics } = await run(sourceBody(), "openai", async () => okRes(candidate));
    expect(result).toBeNull();
    expect(body).toEqual(before);
    // NOTE: a rewritten tool_call_id reports the generic count/order
    // diagnostic; the specific "tool pairing identity" text is reserved for
    // tool_calls array mismatches (validator :113-141).
    expect(JSON.stringify(diagnostics)).toContain("message count or order");
  });

  it("rejects a response that rewrites tool_calls ids", async () => {
    const candidate = [
      { role: "system", content: "sys" },
      { role: "user", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_EVIL", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "user", content: "ok" },
    ];
    const { body, before, result, diagnostics } = await run(sourceBody(), "openai", async () => okRes(candidate));
    expect(result).toBeNull();
    expect(body).toEqual(before);
    expect(JSON.stringify(diagnostics)).toContain("tool pairing identity");
  });

  it("rejects a response that reorders messages", async () => {
    const candidate = [
      { role: "system", content: "sys" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "user", content: "ok" },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "user", content: "ok" },
    ];
    const { body, before, result } = await run(sourceBody(), "openai", async () => okRes(candidate));
    expect(result).toBeNull();
    expect(body).toEqual(before);
  });

  it("rejects a response that drops a message", async () => {
    const candidate = [
      { role: "system", content: "sys" },
      { role: "user", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ];
    const { body, before, result, diagnostics } = await run(sourceBody(), "openai", async () => okRes(candidate));
    expect(result).toBeNull();
    expect(body).toEqual(before);
    expect(JSON.stringify(diagnostics)).toContain("message count");
  });
});

describe("claude shape validator", () => {
  const claudeBody = () => ({
    model: "claude",
    system: "be helpful " + BIG,
    tools: [{ name: "t", description: "d" }],
    messages: [
      { role: "user", content: BIG },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: BIG }] },
    ],
  });

  it("commits when count/order/role/content-shape hold; system and tools stay local", async () => {
    const candidate = [
      { role: "user", content: "ok" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ];
    const original = claudeBody();
    const { body, result } = await run(original, "claude", async () => okRes(candidate));
    expect(result).not.toBeNull();
    expect(body.messages[0].content).toBe("ok");
    // system + tools are never sent to the proxy and survive untouched
    expect(body.system).toBe(original.system);
    expect(body.tools).toEqual(original.tools);
  });

  it("rejects reordered claude messages", async () => {
    const candidate = [
      { role: "user", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] },
    ];
    const { body, before, result, diagnostics } = await run(claudeBody(), "claude", async () => okRes(candidate));
    expect(result).toBeNull();
    expect(body).toEqual(before);
    expect(JSON.stringify(diagnostics)).toContain("protected content");
  });

  it("rejects a dropped claude message", async () => {
    const candidate = [
      { role: "user", content: "ok" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] },
    ];
    const { body, before, result } = await run(claudeBody(), "claude", async () => okRes(candidate));
    expect(result).toBeNull();
    expect(body).toEqual(before);
  });

  it("rejects a candidate with a malformed content shape", async () => {
    const candidate = [
      { role: "user", content: 42 },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ];
    const { body, before, result } = await run(claudeBody(), "claude", async () => okRes(candidate));
    expect(result).toBeNull();
    expect(body).toEqual(before);
  });

  // DEFECT hh-cld-1: the claude branch validates message count, ordered roles,
  // and content shape ONLY. It never checks tool_use/tool_result id pairing,
  // so a proxy that swaps or rewrites ids commits a body whose tool_result can
  // no longer be matched to its tool_use. The openai branch rejects this exact
  // candidate ("proxy response did not preserve tool pairing identity");
  // the claude branch accepts it.
  it("rejects a proxy that swaps tool_use/tool_result ids", async () => {
    const candidate = [
      { role: "user", content: "ok" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_EVIL", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_EVIL", content: "ok" }] },
    ];
    const { result } = await run(claudeBody(), "claude", async () => okRes(candidate));
    expect(result).toBeNull();
  });
});

describe("empty messages array", () => {
  it("round-trips safely: no throw, no mutation, null result", async () => {
    const body = { model: "m", messages: [] };
    const { body: after, before, result, fetchMock } = await run(body, "openai", async () =>
      okRes([], { tokens_before: 100, tokens_after: 5, tokens_saved: 95 }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull(); // nothing to save → phantom gate keeps original
    expect(after).toEqual(before);
    expect(after.messages).toEqual([]);
  });
});

describe("error tool block skips compression entirely", () => {
  it("claude is_error tool_result: fetch never called", async () => {
    const body = {
      model: "claude",
      messages: [
        { role: "user", content: BIG },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true }] },
      ],
    };
    const { result, fetchMock, diagnostics, before } = await run(body, "claude", async () => {
      throw new Error("fetch must not be called");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(body).toEqual(before);
    expect(JSON.stringify(diagnostics)).toContain("error tool result");
  });

  it("openai-responses function_call_output with status error: fetch never called", async () => {
    const body = {
      model: "m",
      input: [
        { type: "function_call", id: "fc_1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "fc_1", status: "error", output: "boom" },
      ],
    };
    const { result, fetchMock } = await run(body, "openai-responses", async () => {
      throw new Error("fetch must not be called");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("openai-responses: instruction items kept (fix #2132 shape)", () => {
  const PAD = "z".repeat(1500);
  const mk = (role, text) => ({ type: "message", role, content: [{ type: "input_text", text }] });
  const body2132 = () => ({
    model: "m",
    instructions: "You are Codex, based on GPT-5." + PAD,
    input: [
      mk("developer", `first directive${PAD}`),
      mk("user", `hello${PAD}`),
      mk("system", `second directive${PAD}`),
      mk("assistant", `hi${PAD}`),
      mk("user", `now do it${PAD}`),
    ],
  });

  it("developer/system items in input[] survive compression in place", async () => {
    const body = body2132();
    const { result, fetchMock } = await run(body, "openai-responses", async (url, init) => {
      const sent = JSON.parse(init.body);
      // proxy echoes the projection with content swapped out
      return okRes(
        sent.messages.map((m) => m.role === "system" || m.role === "developer" ? m : ({ ...m, content: "s" })),
        { tokens_before: 50000, tokens_after: 500, tokens_saved: 49500 },
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(body.instructions).toBe(`You are Codex, based on GPT-5.${PAD}`);
    const roles = body.input.map((i) => `${i.type}:${i.role}`);
    expect(roles).toEqual([
      "message:developer",
      "message:user",
      "message:system",
      "message:assistant",
      "message:user",
    ]);
    const directive = (role) =>
      body.input.find((i) => i.role === role)?.content?.[0]?.text ?? "";
    expect(directive("developer")).toContain("first directive");
    expect(directive("system")).toContain("second directive");
  });
});

describe("openai-responses pivot guard (3571)", () => {
  it("function_call / function_call_output items: refused before any fetch", async () => {
    const body = {
      model: "m",
      input: [
        { type: "function_call", id: "fc_1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "fc_1", output: "result" + BIG },
      ],
    };
    const { result, fetchMock } = await run(body, "openai-responses", async () => {
      throw new Error("fetch must not be called");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("reasoning items: refused before any fetch", async () => {
    const body = {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q" + BIG }] },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought" }] },
      ],
    };
    const { result, fetchMock } = await run(body, "openai-responses", async () => {
      throw new Error("fetch must not be called");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("message-only input proceeds to the proxy", async () => {
    const body = {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q" + BIG }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" + BIG }] },
      ],
    };
    const { result, fetchMock } = await run(body, "openai-responses", async (url, init) => {
      const sent = JSON.parse(init.body);
      return okRes(
        sent.messages.map((m) => m.role === "system" || m.role === "developer" ? m : ({ ...m, content: "s" })),
        { tokens_before: 50000, tokens_after: 500, tokens_saved: 49500 },
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
  });

  // DEFECT hh-rsp-1: an assistant message item with content: [] passes the
  // type:"message" guard and the count/order validator (the Chat projection
  // keeps it as an empty message), but the way-back translator emits NOTHING
  // for it — the merged input has one fewer item. Verified against the real
  // translators: openaiResponsesToOpenAIRequest projects 2 messages,
  // openaiToOpenAIResponsesRequest rebuilds 1. The item is silently deleted
  // from body.input whenever the proxy reports a real shrink.
  it("keeps an assistant message item with empty content[]", async () => {
    const body = {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: BIG }] },
        { type: "message", role: "assistant", content: [] },
      ],
    };
    const { result } = await run(body, "openai-responses", async (url, init) => {
      const sent = JSON.parse(init.body);
      return okRes(
        sent.messages.map((m) => m.role === "system" || m.role === "developer" ? m : ({ ...m, content: "s" })),
        { tokens_before: 50000, tokens_after: 500, tokens_saved: 49500 },
      );
    });
    expect(result).toBeNull(); // rejected rather than committing a dropped item
  });

  // DEFECT hh-rsp-2: message-item fields the Chat projection has no slot for
  // are dropped on the way back. `name` on a message item (Responses API
  // custom-role/eval identity) survives neither direction. cache_control on a
  // content part (prompt-caching directive) is also discarded — that one
  // changes cost/latency behavior, not text. Both pass every guard.
  it("preserves message-item fields with no chat projection slot (name, cache_control)", async () => {
    const body = {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: BIG }] },
        { type: "message", role: "user", name: "alice", content: [{ type: "input_text", text: "small" }] },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "cache me", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    const { result } = await run(body, "openai-responses", async (url, init) => {
      const sent = JSON.parse(init.body);
      return okRes(
        sent.messages.map((m) => m.role === "system" || m.role === "developer" ? m : ({ ...m, content: "s" })),
        { tokens_before: 50000, tokens_after: 500, tokens_saved: 49500 },
      );
    });
    expect(result).not.toBeNull();
    expect(body.input[1].name).toBe("alice");
    expect(body.input[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
