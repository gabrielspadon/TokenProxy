import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeRequest } from "open-sse/translator/formats/claude.js";
import { FORMATS } from "open-sse/translator/formats.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: mocks.execute }),
}));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function fixture() {
  return {
    model: "MiniMax-M3", stream: false, max_tokens: 256,
    system: [{ type: "text", text: "Keep exact file paths and error evidence." }],
    tools: [{
      type: "custom", name: "Read", description: "Read a file without modifying it.",
      input_schema: {
        type: "object", properties: { path: { type: "string", enum: ["a  b.txt", "c.txt"] } },
        required: ["path"], additionalProperties: false,
      },
    }],
    tool_choice: { type: "tool", name: "Read" },
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the file." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "Read", input: { path: "a  b.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", is_error: true, content: "ENOENT a  b.txt" }] },
    ],
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function args(body, extra = {}) {
  return {
    body, sourceFormatOverride: FORMATS.CLAUDE,
    modelInfo: { provider: "minimax", model: "MiniMax-M3" },
    credentials: { apiKey: "fixture", sessionHash: "e".repeat(32) },
    connectionId: "custom-tool-fixture", clientRawRequest: {
      endpoint: "/v1/messages", headers: { "user-agent": "claude-cli/1.0.0" }, body,
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    rtkEnabled: false, schemaDistillEnabled: false, headroomEnabled: false,
    cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    ...extra,
  };
}

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.execute.mockImplementation(async () => ({
    response: Response.json({
      id: "fixture", type: "message", role: "assistant", model: "MiniMax-M3",
      content: [{ type: "text", text: "The file is missing." }], stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 6 },
    }),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("Claude custom tools through compatible-provider preparation", () => {
  it.each(["minimax", "glm", "kimi"])("preserves custom tool schema and choice for %s", (provider) => {
    const original = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = prepareClaudeRequest(structuredClone(original), provider);
    expect(output.tools?.[0]).toMatchObject(original.tools[0]);
    expect(output.tool_choice).toEqual(original.tool_choice);
    expect(output.messages[1].content[0]).toMatchObject(original.messages[1].content[0]);
    expect(output.messages[2].content[0]).toMatchObject(original.messages[2].content[0]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retains the typed schema and its complete call/result transaction at dispatch", async () => {
    const body = fixture();
    const original = structuredClone(body);
    const result = await handleChatCore(args(body));
    await result.response.text();
    expect(result.success).toBe(true);
    const sent = mocks.execute.mock.calls[0][0].body;
    expect(sent.tools?.[0]).toMatchObject(original.tools[0]);
    expect(sent.tool_choice).toEqual(original.tool_choice);
    expect(sent.messages[1].content[0]).toMatchObject(original.messages[1].content[0]);
    expect(sent.messages[2].content[0]).toMatchObject(original.messages[2].content[0]);
  });

  it.each([false, true])("isolates caller containers before translation with RTK enabled=%s", async (rtkEnabled) => {
    const body = deepFreeze(fixture());
    const original = JSON.stringify(body);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await handleChatCore(args(body, { rtkEnabled }));
      await result.response.text();
      expect(result.success).toBe(true);
    }
    expect(JSON.stringify(body)).toBe(original);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.execute.mock.calls) {
      expect(call.body).not.toBe(body);
      expect(call.body.messages).not.toBe(body.messages);
      expect(call.body.system).not.toBe(body.system);
      expect(call.body.tools).not.toBe(body.tools);
    }
  });

  it("isolates nested containers around opaque direct-engine handles", async () => {
    const body = fixture();
    const callback = () => {};
    const signal = new AbortController().signal;
    body.conversationState = { history: [{ role: "user", content: "private history" }], callback };
    body.signal = signal;
    const result = await handleChatCore(args(body));
    await result.response.text();
    expect(result.success).toBe(true);
    const sent = mocks.execute.mock.calls[0][0].body;
    expect(sent.conversationState).not.toBe(body.conversationState);
    expect(sent.conversationState.history).not.toBe(body.conversationState.history);
    expect(sent.conversationState.callback).toBe(callback);
    expect(sent.signal).toBe(signal);
  });
});
