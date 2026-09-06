// Round-trip no-loss invariants for compressMessages on composed bodies.
// Covers the module contract stated in open-sse/rtk/headroom.js:1-2:
// tool ids, is_error flags and cache_control blocks must survive compression.
import { describe, it, expect } from "vitest";
import { compressMessages as compressWithPolicy } from "../../open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });

// --- fixtures ---------------------------------------------------------------

const PAD = "x".repeat(90);

// Compressible git-log output: fat commit bodies the git-log filter drops.
function makeGitLog() {
  return Array.from({ length: 40 }, (_, i) =>
    `commit abc123${i}def\nAuthor: Dev ${i} <dev${i}@example.com>\nDate:   Sun Jul 6 10:00:0${i % 10} 2026 +0700\n\n    subject line number ${i}\n\n${PAD}\n${PAD}\n${PAD}\n`
  ).join("\n");
}

// Compressible grep output: file:lineno:content rows.
function makeGrepOutput() {
  return Array.from({ length: 60 }, (_, i) =>
    `src/module/file${i % 3}.js:${i + 1}:const value${i} = "padding padding padding padding"`
  ).join("\n");
}

// Long plain prose that no filter may touch.
const LONG_USER_TEXT =
  "The quick brown fox jumps over the lazy dog. ".repeat(40);
const LONG_ASSISTANT_TEXT =
  "I will inspect the repository and report back shortly. ".repeat(40);

function makeClaudeBody() {
  return {
    system: [
      { type: "text", text: "You are a helpful agent.", cache_control: { type: "ephemeral", ttl: "5m" } },
    ],
    tools: [
      { name: "bash", description: "run shell commands", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [
      { role: "user", content: LONG_USER_TEXT },
      {
        role: "assistant",
        content: [
          { type: "text", text: LONG_ASSISTANT_TEXT },
          { type: "thinking", thinking: "step one, step two, step three. ".repeat(30), signature: "EqABC123sig==" },
          { type: "redacted_thinking", data: "redacted-material-blob" },
          { type: "tool_use", id: "toolu_bash_1", name: "bash", input: { command: "git log" } },
          { type: "tool_use", id: "toolu_grep_1", name: "grep", input: { pattern: "foo" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_bash_1", content: makeGitLog(), cache_control: { type: "ephemeral", ttl: "5m" } },
          {
            type: "tool_result",
            tool_use_id: "toolu_grep_1",
            content: [
              { type: "text", text: makeGrepOutput() },
              { type: "text", text: "short trailing note" },
            ],
          },
        ],
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "First pass done, reading the file now." },
          { type: "tool_use", id: "toolu_read_1", name: "read", input: { path: "/tmp/a.log" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read_1", content: "boom: file vanished", is_error: true },
          { type: "tool_result", tool_use_id: "toolu_stat_1", isError: true, content: [{ type: "text", text: makeGitLog() }] },
          { type: "tool_result", tool_use_id: "toolu_list_1", status: "error", content: makeGrepOutput() },
          { type: "tool_result", tool_use_id: "toolu_empty_1", content: "" },
        ],
      },
    ],
  };
}

function makeOpenAiBody() {
  return {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: LONG_USER_TEXT },
      {
        role: "assistant",
        content: LONG_ASSISTANT_TEXT,
        tool_calls: [
          { id: "call_bash_1", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "call_grep_1", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_bash_1", content: makeGitLog() },
      { role: "tool", tool_call_id: "call_grep_1", content: [{ type: "text", text: makeGrepOutput() }] },
      { role: "tool", tool_call_id: "call_err_1", content: makeGitLog(), is_error: true },
      { role: "tool", tool_call_id: "call_err_2", content: makeGrepOutput(), isError: true },
      { role: "tool", tool_call_id: "call_err_3", content: makeGitLog(), status: "error" },
    ],
  };
}

function makeResponsesBody() {
  return {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: LONG_USER_TEXT }] },
      { type: "function_call", id: "fc_bash_1", call_id: "call_bash_1", name: "bash", arguments: "{}" },
      { type: "function_call", id: "fc_grep_1", call_id: "call_grep_1", name: "grep", arguments: "{}" },
      { type: "function_call_output", call_id: "call_bash_1", output: makeGitLog() },
      { type: "function_call_output", call_id: "call_grep_1", output: [{ type: "input_text", text: makeGrepOutput() }] },
      { type: "function_call_output", call_id: "call_err_1", output: makeGitLog(), is_error: true },
      { type: "function_call_output", call_id: "call_err_2", output: makeGrepOutput(), isError: true },
      { type: "function_call_output", call_id: "call_err_3", output: makeGitLog(), status: "error" },
    ],
  };
}

// --- generic collectors over the pre-compression clone ----------------------

function collectByKey(node, key, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectByKey(item, key, out);
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") collectByKey(v, key, out);
  }
  return out;
}

// All tool-result text fields compressMessages can rewrite (non-Kiro formats).
function collectToolResultTexts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectToolResultTexts(item, out);
    return out;
  }
  if (node.type === "tool_result" && typeof node.content === "string") out.push(node.content);
  if (node.type === "tool_result" && Array.isArray(node.content)) {
    for (const part of node.content) {
      if (part && part.type === "text" && typeof part.text === "string") out.push(part.text);
    }
  }
  if (node.type === "function_call_output") {
    if (typeof node.output === "string") out.push(node.output);
    if (Array.isArray(node.output)) {
      for (const part of node.output) {
        if (part && part.type === "input_text" && typeof part.text === "string") out.push(part.text);
      }
    }
  }
  if (node.role === "tool") {
    if (typeof node.content === "string") out.push(node.content);
    if (Array.isArray(node.content)) {
      for (const part of node.content) {
        if (part && part.type === "text" && typeof part.text === "string") out.push(part.text);
      }
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") collectToolResultTexts(v, out);
  }
  return out;
}

const json = (v) => JSON.stringify(v);

// --- invariants -------------------------------------------------------------

describe("round-trip invariants: Claude format", () => {
  const body = makeClaudeBody();
  const before = structuredClone(body);
  const stats = compressMessages(body, true);

  it("reports savings (body actually carried compressible blocks)", () => {
    expect(stats).not.toBeNull();
    expect(stats.hits.length).toBeGreaterThan(0);
  });

  it("invariant a: message count, order, and roles unchanged", () => {
    expect(body.messages.length).toBe(before.messages.length);
    expect(body.messages.map((m) => m.role)).toEqual(before.messages.map((m) => m.role));
    expect(json(body.system)).toBe(json(before.system));
    expect(json(body.tools)).toBe(json(before.tools));
  });

  it("invariant b: every tool_use id pairs with exactly one tool_result, ids unchanged", () => {
    const blocksByType = (root, type) => {
      const out = [];
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.type === type) out.push(n);
        Object.values(n).forEach(walk);
      };
      walk(root);
      return out;
    };
    const usesBefore = blocksByType(before, "tool_use");
    const usesAfter = blocksByType(body, "tool_use");
    expect(usesAfter.map((b) => b.id)).toEqual(usesBefore.map((b) => b.id));
    expect(json(usesAfter)).toBe(json(usesBefore));

    const resultIds = blocksByType(body, "tool_result").map((b) => b.tool_use_id);
    for (const b of usesBefore) {
      expect(resultIds.filter((r) => r === b.id)).toHaveLength(1);
    }
  });

  it("invariant c: all three block-level error flags keep content byte-identical", () => {
    const flagged = [];
    const walk = (blocks) => {
      for (const b of blocks) {
        if (b && b.type === "tool_result" && (b.is_error === true || b.isError === true || b.status === "error")) {
          flagged.push(b);
        }
      }
    };
    for (const m of before.messages) if (Array.isArray(m.content)) walk(m.content);
    expect(flagged).toHaveLength(3);

    const afterById = new Map();
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b && b.type === "tool_result") afterById.set(b.tool_use_id + json([b.is_error, b.isError, b.status]), b);
      }
    }
    for (const b of flagged) {
      const key = b.tool_use_id + json([b.is_error, b.isError, b.status]);
      expect(json(afterById.get(key).content)).toBe(json(b.content));
      expect(afterById.get(key).is_error).toBe(b.is_error);
      expect(afterById.get(key).isError).toBe(b.isError);
      expect(afterById.get(key).status).toBe(b.status);
    }
  });

  it("invariant d: every cache_control block byte-identical (type + ttl)", () => {
    expect(collectByKey(body, "cache_control").map(json)).toEqual(
      collectByKey(before, "cache_control").map(json)
    );
  });

  it("invariant e: thinking and redacted_thinking blocks untouched, signatures unchanged", () => {
    const thinking = (root) =>
      collectByKey(root, "type")
        .filter((t) => t === "thinking" || t === "redacted_thinking")
        .length;
    expect(thinking(body)).toBe(thinking(before));
    expect(json(collectByKey(body, "signature"))).toEqual(json(collectByKey(before, "signature")));
    // full block-level comparison
    const blocks = (root) => {
      const out = [];
      for (const m of root.messages) {
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b && (b.type === "thinking" || b.type === "redacted_thinking")) out.push(b);
          }
        }
      }
      return out;
    };
    expect(json(blocks(body))).toBe(json(blocks(before)));
  });

  it("invariant f: no tool_result text becomes empty unless it started empty", () => {
    const after = collectToolResultTexts(body);
    const emptyBefore = collectToolResultTexts(before).filter((t) => t.length === 0).length;
    const emptyAfter = after.filter((t) => t.length === 0).length;
    expect(emptyAfter).toBe(emptyBefore);
    for (const t of after) {
      if (t.length === 0) continue; // originally-empty block keeps its exception
      expect(t.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("invariant g: long user and assistant text blocks survive verbatim", () => {
    expect(body.messages[0].content).toBe(LONG_USER_TEXT);
    const assistantTexts = [];
    for (const m of body.messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === "text") assistantTexts.push(b.text);
      }
    }
    expect(assistantTexts[0]).toBe(LONG_ASSISTANT_TEXT);
  });
});

describe("round-trip invariants: OpenAI format", () => {
  const body = makeOpenAiBody();
  const before = structuredClone(body);
  const stats = compressMessages(body, true);

  it("reports savings", () => {
    expect(stats.hits.length).toBeGreaterThan(0);
  });

  it("invariant a: message count, order, and roles unchanged", () => {
    expect(body.messages.length).toBe(before.messages.length);
    expect(body.messages.map((m) => m.role)).toEqual(before.messages.map((m) => m.role));
  });

  it("invariant b: tool_call ids unchanged, each call id pairs with exactly one tool message", () => {
    const callsBefore = before.messages.find((m) => m.tool_calls).tool_calls;
    const callsAfter = body.messages.find((m) => m.tool_calls).tool_calls;
    expect(json(callsAfter)).toBe(json(callsBefore));
    const toolIds = body.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    for (const call of callsBefore) {
      expect(toolIds.filter((id) => id === call.id)).toHaveLength(1);
    }
  });

  it("invariant c: all three error flag shapes keep content byte-identical", () => {
    for (const m of before.messages.filter((m) => m.role === "tool" && (m.is_error || m.isError || m.status === "error"))) {
      const after = body.messages.find((x) => x.tool_call_id === m.tool_call_id);
      expect(json(after.content)).toBe(json(m.content));
    }
  });

  it("invariant f: no tool text becomes empty", () => {
    for (const m of body.messages.filter((m) => m.role === "tool")) {
      const texts = typeof m.content === "string" ? [m.content] : m.content.map((p) => p.text);
      for (const t of texts) expect(t.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("invariant g: long user and assistant text survive verbatim", () => {
    expect(body.messages.find((m) => m.role === "user").content).toBe(LONG_USER_TEXT);
    expect(body.messages.find((m) => m.role === "assistant").content).toBe(LONG_ASSISTANT_TEXT);
  });
});

describe("round-trip invariants: OpenAI Responses format", () => {
  const body = makeResponsesBody();
  const before = structuredClone(body);
  const stats = compressMessages(body, true);

  it("reports savings", () => {
    expect(stats.hits.length).toBeGreaterThan(0);
  });

  it("invariant a: item count, order, and item types unchanged", () => {
    expect(body.input.length).toBe(before.input.length);
    expect(body.input.map((i) => i.type)).toEqual(before.input.map((i) => i.type));
    expect(body.input.map((i) => i.role)).toEqual(before.input.map((i) => i.role));
  });

  it("invariant b: function_call ids and call_ids unchanged, outputs still paired", () => {
    const callsBefore = before.input.filter((i) => i.type === "function_call");
    const callsAfter = body.input.filter((i) => i.type === "function_call");
    expect(json(callsAfter)).toBe(json(callsBefore));
    const outputCallIds = body.input.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
    for (const call of callsBefore) {
      expect(outputCallIds.filter((id) => id === call.call_id)).toHaveLength(1);
    }
  });

  it("invariant c: all three error flag shapes keep output byte-identical", () => {
    for (const m of before.input.filter((i) => i.type === "function_call_output" && (i.is_error || i.isError || i.status === "error"))) {
      const after = body.input.find((x) => x.call_id === m.call_id && x.type === "function_call_output");
      expect(json(after.output)).toBe(json(m.output));
    }
  });

  it("invariant f: no output text becomes empty", () => {
    for (const m of body.input.filter((i) => i.type === "function_call_output")) {
      const texts = typeof m.output === "string" ? [m.output] : m.output.map((p) => p.text);
      for (const t of texts) expect(t.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("invariant g: long user text survives verbatim", () => {
    const user = body.input.find((i) => i.type === "message");
    expect(user.content[0].text).toBe(LONG_USER_TEXT);
  });
});
