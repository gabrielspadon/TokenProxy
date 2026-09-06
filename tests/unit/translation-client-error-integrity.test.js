import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { TranslationInputError } from "../../open-sse/translator/concerns/translationError.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), pending: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: mocks.execute }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: mocks.pending,
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const user = (content) => ({ messages: [{ role: "user", content }] });
const toolResult = (block) => ({ messages: [
  { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "shot", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", ...block }] },
] });
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "PRIVATE_IMAGE" } };
const cases = [
  ["audio", FORMATS.OPENAI, "claude", FORMATS.CLAUDE, user([{ type: "input_audio", input_audio: { data: "PRIVATE_AUDIO", format: "wav" } }])],
  ["tool image", FORMATS.CLAUDE, "openai", FORMATS.OPENAI, toolResult({ content: [image] })],
  ["tool error", FORMATS.CLAUDE, "openai", FORMATS.OPENAI, toolResult({ is_error: true, content: "PRIVATE_ERROR" })],
  ["opaque thinking", FORMATS.CLAUDE, "openai", FORMATS.OPENAI, { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "PRIVATE_THINKING" }, { type: "text", text: "answer" }] }, { role: "user", content: "next" }] }],
  ["file reference", FORMATS.OPENAI_RESPONSES, "claude", FORMATS.CLAUDE, { input: [{ role: "user", content: [{ type: "input_image", file_id: "PRIVATE_FILE_ID" }] }] }],
  ["nameless call", FORMATS.OPENAI_RESPONSES, "claude", FORMATS.CLAUDE, { input: [{ type: "function_call", call_id: "PRIVATE_CALL_ID", name: "", arguments: "{}" }] }],
  ["Cursor image", FORMATS.OPENAI, "cursor", FORMATS.CURSOR, user([{ type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE_IMAGE" } }])],
  ["Kiro URL", FORMATS.OPENAI, "kiro", FORMATS.KIRO, user([{ type: "image_url", image_url: { url: "https://private.invalid/image.png?secret=PRIVATE_URL" } }])],
  ["Kiro Claude URL", FORMATS.CLAUDE, "kiro", FORMATS.KIRO, user([{ type: "image", source: { type: "url", url: "https://private.invalid/PRIVATE_URL" } }])],
  ["Kiro Responses URL", FORMATS.OPENAI_RESPONSES, "kiro", FORMATS.KIRO, { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://private.invalid/PRIVATE_URL" }] }] }],
  ["malformed JSON", FORMATS.OPENAI, "commandcode", FORMATS.COMMANDCODE, { messages: [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{PRIVATE_ARGUMENTS" } }] }, { role: "tool", tool_call_id: "call_1", content: "ok" }] }],
];

describe("translation failures are local, terminal, and payload-safe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected fetch"); }));
  });

  it.each(cases)("%s fails without changing the source", (_name, source, _provider, target, fixture) => {
    const body = structuredClone(fixture);
    let caught;
    try { translateRequest(source, target, "test-model", body, false); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TranslationInputError);
    expect(caught.status).toBe(400);
    expect(caught.path).toMatch(/^(messages|input)\[/);
    expect(caught.message).not.toContain("PRIVATE_");
    expect(body).toEqual(fixture);
    expect(fetch).not.toHaveBeenCalled();
  });

  // The current CommandCode provider uses ordinary Chat Completions. Its legacy
  // converter is tested above, but is not presented as the live transport.
  it.each(cases.filter((row) => row[3] !== FORMATS.COMMANDCODE))("%s returns400 before fetch or executor dispatch", async (_name, source, provider, _target, fixture) => {
    const body = { ...structuredClone(fixture), model: "test-model", stream: false };
    const original = structuredClone(body);
    const result = await handleChatCore({
      body,
      sourceFormatOverride: source,
      modelInfo: { provider, model: "test-model" },
      credentials: { apiKey: "mock-key", providerSpecificData: {} },
      connectionId: "mock-account",
      clientRawRequest: { headers: {}, body },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false,
    });
    expect(result.status).toBe(400);
    expect(result.response.status).toBe(400);
    expect(result.failureMetadata).toEqual({ safeToReplay: false, failurePhase: "translation" });
    expect((await result.response.json()).error).toMatchObject({ type: "invalid_request_error" });
    expect(result.error).not.toContain("PRIVATE_");
    expect(result.response.headers.get("retry-after")).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(body).toEqual(original);
  });

  it("keeps CommandCode's current Chat Completions argument string intact", async () => {
    const fixture = cases.find((row) => row[3] === FORMATS.COMMANDCODE)[4];
    mocks.execute.mockImplementation(async () => ({
      response: Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
      url: "https://upstream.invalid/chat/completions", headers: {}, transformedBody: null,
    }));
    const result = await handleChatCore({
      body: { ...structuredClone(fixture), model: "test-model", stream: false },
      modelInfo: { provider: "commandcode", model: "test-model" },
      credentials: { apiKey: "mock-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false,
    });
    expect(result.success).toBe(true);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0][0].body.messages[0].tool_calls[0].function.arguments).toBe("{PRIVATE_ARGUMENTS");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes the opaque and tool media blocks unchanged on a native Claude route", () => {
    const body = { ...toolResult({ is_error: true, content: [image] }), model: "claude-opus-5", max_tokens: 100 };
    body.messages[0].content.unshift({ type: "redacted_thinking", data: "PRIVATE_THINKING" });
    const result = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-opus-5", structuredClone(body), false);
    const blocks = result.messages.flatMap((msg) => msg.content);
    expect(blocks).toContainEqual({ type: "redacted_thinking", data: "PRIVATE_THINKING" });
    expect(blocks.find((block) => block.type === "tool_result")).toMatchObject(body.messages[1].content[0]);
  });
});
