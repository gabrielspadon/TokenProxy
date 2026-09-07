import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ROLE } from "../../open-sse/translator/schema/index.js";
import { CONTEXT_ROLES } from "../../open-sse/config/contextEvidence.js";
import { measureContextStructure, normalizeContextStructure } from "../../open-sse/utils/contextStructure.js";

const key = Buffer.alloc(32, 7);
const size = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const capture = (body) => measureContextStructure(body, "client-received", key);

describe("content-free structural evidence", () => {
  it("keeps the versioned role DTO aligned with protocol roles", () => {
    expect(CONTEXT_ROLES).toEqual([...Object.values(ROLE), "other"]);
  });
  it("partitions UTF-8 JSON bytes exactly and preserves the caller", () => {
    const body = { model: "fixture", system: "private café 🐋", tools: [{ name: "secret-tool", input_schema: { type: "object" } }], messages: [{ role: "user", content: "última pergunta" }] };
    const before = structuredClone(body), result = capture(body);
    expect(result.bodyBytes).toBe(size(body));
    expect(result.bodyBytes).toBe(result.messageBytes + result.instructionBytes + result.toolSchemaBytes + result.envelopeBytes);
    expect(result.roles.user).toEqual({ count: 1, bytes: size(body.messages[0]) });
    expect(result.messageBytes).toBe(result.roles.user.bytes + result.messageContainerBytes);
    expect(JSON.stringify(result)).not.toMatch(/private|café|secret-tool|pergunta/);
    expect(body).toEqual(before);
    expect(normalizeContextStructure(result)).toEqual(result);
  });
  it("separates overlapping tool and attachment subsets without double-counting nested results", () => {
    const image = { type: "image", source: { type: "base64", data: "private-image" } };
    const resultBlock = { type: "tool_result", tool_use_id: "id", content: [image, { type: "text", text: "private-result" }] };
    const body = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "id", name: "read", input: {} }] }, { role: "user", content: [resultBlock] }] };
    const result = capture(body);
    expect(result.subsets.toolCalls.count).toBe(1);
    expect(result.subsets.toolResults).toEqual({ count: 1, bytes: size(resultBlock) });
    expect(result.subsets.attachments).toEqual({ count: 1, bytes: size(image) });
    expect(result.roles.user.bytes).toBeGreaterThan(result.subsets.toolResults.bytes);
  });
  it.each([
    { input: [{ type: "function_call", name: "read", arguments: "{}" }, { type: "function_call_output", output: "answer" }, { role: "user", content: "next" }] },
    { messages: [{ role: "assistant", tool_calls: [{ type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", content: "answer" }, { role: "user", content: "next" }] },
    { contents: [{ role: "model", parts: [{ functionCall: { name: "read", args: {} } }] }, { role: "user", parts: [{ functionResponse: { name: "read", response: { result: "answer" } } }] }] },
  ])("captures compatible tool transactions from each JSON protocol", (body) => {
    const result = capture(body);
    expect(result.subsets.toolCalls.count).toBe(1);
    expect(result.subsets.toolResults.count).toBe(1);
    expect(normalizeContextStructure(result).bodyBytes).toBe(size(body));
  });
  it("keeps history-prefix fingerprints stable when only the latest user message changes", () => {
    const body = { instructions: "instruction", input: [{ role: "user", content: "prior" }, { role: "assistant", content: "answer" }, { role: "user", content: "current" }] };
    const first = capture(body);
    body.input[2].content = "changed current";
    const second = capture(body);
    expect(second.fingerprints.historyPrefix).toBe(first.fingerprints.historyPrefix);
    expect(second.fingerprints.body).not.toBe(first.fingerprints.body);
    expect(measureContextStructure(body, "client-received", Buffer.alloc(32, 8)).fingerprints.body).not.toBe(second.fingerprints.body);
  });
  it("retains explicit zeros for an observed empty body and refuses unbounded capture", () => {
    const result = capture({});
    expect(result.bodyBytes).toBe(2); expect(result.messageBytes).toBe(0);
    expect(result.subsets.attachments).toEqual({ count: 0, bytes: 0 });
    expect(() => capture({ messages: [{ role: "user", content: "x".repeat(8 * 1024 * 1024) }] })).toThrow(/capture limits/);
  });
  it("strips unknown fields at persistence and rejects contradictory boundaries", () => {
    const result = capture({ messages: [] });
    expect(normalizeContextStructure({ ...result, prompt: "must not persist" })).not.toHaveProperty("prompt");
    expect(() => normalizeContextStructure({ ...result, envelopeBytes: 1 })).toThrow();
    expect(() => normalizeContextStructure({ ...result, roles: { ...result.roles, user: { count: 1, bytes: Infinity } } })).toThrow();
  });
  it("does not classify schema examples and tool-argument data as attachments", () => {
    const body = { tools: [{ name: "read", input_schema: { examples: [{ type: "image", source: "not-media" }] } }], messages: [{ role: "assistant", content: [{ type: "tool_use", name: "read", input: { type: "image", source: "argument-data" } }] }] };
    const result = capture(body);
    expect(result.subsets.attachments.count).toBe(0);
    expect(result.subsets.toolCalls.count).toBe(1);
  });
  it("reuses an internal serialized body and handles JSON-omitted optional fields", () => {
    const body = { tools: undefined, messages: [undefined, { role: "user", content: "message" }] };
    const serialized = JSON.stringify(body), stringify = vi.spyOn(JSON, "stringify");
    try {
      const result = measureContextStructure(body, "gateway-shaped", key, { serialized });
      expect(stringify.mock.calls.filter(([value]) => value === body)).toHaveLength(0);
      expect(result.bodyBytes).toBe(Buffer.byteLength(serialized));
      expect(normalizeContextStructure(result).messageBytes).toBe(size(body.messages));
    } finally { stringify.mockRestore(); }
  });
  // The body and history-prefix digests are streamed through a fixed 65536-char
  // scratch buffer. A slice boundary landing between a surrogate pair, or a lone
  // surrogate landing on one, would change the bytes hashed without changing any
  // count, so pin the digests against whole-string encoding across the boundary.
  it("streams multi-chunk bodies to the same digest as whole-string encoding", () => {
    const filler = "a".repeat(65530);
    for (const piece of ["a", "é", "日", "🧭", "\ud800", "\udfff"]) {
      const body = { messages: [{ role: "user", content: filler + piece + "🧭".repeat(40000) }] };
      const serialized = JSON.stringify(body);
      const result = measureContextStructure(body, "physical-dispatch", key, { serialized });
      expect(result.bodyBytes).toBe(Buffer.byteLength(serialized, "utf8"));
      expect(result.fingerprints.body).toBe(
        createHmac("sha256", key).update("context-v1:body\0").update(Buffer.from(serialized, "utf8")).digest("hex"));
      expect(result.historyPrefixBytes).toBe(Buffer.byteLength('{"instructions":{},"tools":{},"history":{"messages":[]}}', "utf8"));
    }
  });
});
