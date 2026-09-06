import { beforeEach, describe, expect, it, vi } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";
import { kiroToOpenAIResponse } from "../../open-sse/translator/response/kiro-to-openai.js";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");

const originalName = "codex_app__send_message_to_thread";
const kiroName = "codex_app_send_message_to_thread";
const toolNameMap = new Map([[kiroName, originalName]]);
const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function frame(eventType, payload) {
  const name = encoder.encode(":event-type");
  const value = encoder.encode(eventType);
  const header = new Uint8Array(1 + name.byteLength + 3 + value.byteLength);
  let offset = 0;
  header[offset++] = name.byteLength;
  header.set(name, offset);
  offset += name.byteLength;
  header[offset++] = 7;
  new DataView(header.buffer).setUint16(offset, value.byteLength, false);
  offset += 2;
  header.set(value, offset);

  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const output = new Uint8Array(12 + header.byteLength + payloadBytes.byteLength + 4);
  const view = new DataView(output.buffer);
  view.setUint32(0, output.byteLength, false);
  view.setUint32(4, header.byteLength, false);
  output.set(header, 12);
  output.set(payloadBytes, 12 + header.byteLength);
  view.setUint32(8, crc32(output.subarray(0, 8)), false);
  view.setUint32(output.byteLength - 4, crc32(output.subarray(0, output.byteLength - 4)), false);
  return output;
}

function response(frames) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const item of frames) controller.enqueue(item);
      controller.close();
    },
  }), { status: 200 });
}

async function runExecutor(frames, overrides = {}) {
  fetchMock.mockResolvedValueOnce(response(frames));
  const result = await new KiroExecutor().execute({
    model: "kr/claude-opus-4.8",
    body: {
      conversationState: {
        history: [],
        currentMessage: { userInputMessage: { content: "base", modelId: "claude-opus-4.8" } },
      },
    },
    stream: true,
    credentials: { accessToken: "test-token", providerSpecificData: { kiroToolCallRepair: true } },
    toolNameMap,
    ...overrides,
  });
  return result.response.text();
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("PR #3107 Kiro normalized tool-name restoration", () => {
  it.each([
    ["OpenAI", () => openaiToKiroRequest("claude-sonnet-4.6", {
      messages: [{ role: "user", content: "Send the update" }],
      tools: [{
        type: "function",
        function: { name: originalName, description: "Send input", parameters: { type: "object", properties: {} } },
      }],
    }, true, {})],
    ["Claude", () => claudeToKiroRequest("claude-sonnet-4.6", {
      messages: [{ role: "user", content: "Send the update" }],
      tools: [{ name: originalName, description: "Send input", input_schema: { type: "object", properties: {} } }],
    }, true, {})],
  ])("keeps a reverse map when %s tools are normalized", (_source, translate) => {
    const payload = translate();
    const declared = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;

    expect(declared[0].toolSpecification.name).toBe(kiroName);
    expect(payload._toolNameMap).toEqual(toolNameMap);
  });

  it("restores only a mapped EventStream tool name while preserving arguments and the tool_call wrapper", async () => {
    const body = await runExecutor([
      frame("toolUseEvent", { toolUseId: "send-message", name: kiroName, input: { thread_id: "thread-1", message: "continue" } }),
      frame("toolUseEvent", { toolUseId: "wrapper", name: "tool_call", input: { name: "mcp_search", arguments: { q: "router" } } }),
      frame("messageStopEvent", { stopReason: "end_turn" }),
    ]);

    expect(body).toContain(`"name":"${originalName}"`);
    expect(body).not.toContain(`"name":"${kiroName}"`);
    expect(body).toContain('\\"thread_id\\":\\"thread-1\\"');
    expect(body).toContain('"name":"tool_call"');
    expect(body).toContain('\\"name\\":\\"mcp_search\\"');
  });

  it("rejects an invalid mapped tool call without a replacement generation", async () => {
    fetchMock
      .mockResolvedValueOnce(response([
        frame("toolUseEvent", { toolUseId: 123, name: kiroName, input: { thread_id: "bad" } }),
      ]))
      .mockResolvedValueOnce(response([
        frame("toolUseEvent", { toolUseId: "send-message", name: kiroName, input: { thread_id: "thread-1" } }),
        frame("messageStopEvent", { stopReason: "end_turn" }),
      ]));

    const result = await new KiroExecutor().execute({
      model: "kr/claude-opus-4.8",
      body: {
        conversationState: {
          history: [],
          currentMessage: { userInputMessage: { content: "base", modelId: "claude-opus-4.8" } },
        },
      },
      stream: true,
      credentials: { accessToken: "test-token", providerSpecificData: { kiroToolCallRepair: true } },
      toolNameMap,
    });
    const body = await result.response.text();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("invalid_kiro_tool_call");
    expect(body).not.toContain(`"name":"${originalName}"`);
    expect(body).not.toContain('"id":123');
  });

  it("restores mapped names in the raw Kiro response translator", () => {
    const chunk = kiroToOpenAIResponse({
      _eventType: "toolUseEvent",
      toolUseEvent: { toolUseId: "send-message", name: kiroName, input: { thread_id: "thread-1" } },
    }, { toolNameMap });

    expect(chunk.choices[0].delta.tool_calls[0].function.name).toBe(originalName);
  });
});
