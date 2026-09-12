// pxpipe event shape: the object chatCore hands to onPxpipeEvent must carry
// saver:'pxpipe' on BOTH the applied and fail-open paths, otherwise the
// closed-set tokenSaver events store would drop the row at ingest
// (src/lib/tokenSaver/events.js: SAVERS.has(event.saver)).
import { describe, it, expect, vi, beforeEach } from "vitest";

const chatCoreMocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  onPxpipeEvent: vi.fn(),
}));

vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: chatCoreMocks.executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

const encoder = new TextEncoder();

function makeExecutorRes() {
  return {
    response: new Response(
      JSON.stringify({
        id: "msg-x",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    transformedBody: null,
  };
}

function pxpipeArgs(overrides = {}) {
  return {
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: "base",
      messages: [{ role: "assistant", content: [{ type: "text", text: "s".repeat(30000), cache_control: { type: "ephemeral" } }] }, { role: "user", content: [{ type: "text", text: "Current request." }] }],
    },
    sourceFormatOverride: "claude",
    modelInfo: { provider: "anthropic", model: "claude-sonnet-4-5" },
    credentials: { apiKey: "k" },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), tagForSession: () => "TAG", nextTag: () => "TAG", fmtThink: () => null },
    connectionId: "conn-1",
    pxpipeEnabled: true,
      pxpipeAllowLossy: true,
    pxpipeMinChars: 100,
    pxpipeTimeoutMs: 5000,
    pxpipeTransform: async () => ({
      applied: true,
      body: encoder.encode(JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: "base",
        messages: [{ role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "PNG-IMAGE-PLACEHOLDER" } }] }, { role: "user", content: [{ type: "text", text: "Current request." }] }],
      })),
      info: { imageCount: 1, imagePixels: 750, compressedChars: 30000 },
    }),
    onPxpipeEvent: chatCoreMocks.onPxpipeEvent,
    ...overrides,
  };
}

describe("pxpipe event payload carries saver:'pxpipe'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatCoreMocks.executeMock.mockResolvedValue(makeExecutorRes());
  });

  it("applied path: emitted event has saver:'pxpipe'", async () => {
    await handleChatCore(pxpipeArgs());
    const event = chatCoreMocks.onPxpipeEvent.mock.calls.at(-1)?.[0];
    expect(event).toBeTruthy();
    expect(event.saver).toBe("pxpipe");
    expect(event.applied).toBe(true);
  });

  it("fail-open path (transform throws): emitted event still has saver:'pxpipe'", async () => {
    await handleChatCore(pxpipeArgs({
      pxpipeTransform: async () => {
        throw new Error("proxy down");
      },
    }));
    const event = chatCoreMocks.onPxpipeEvent.mock.calls.at(-1)?.[0];
    expect(event).toBeTruthy();
    expect(event.saver).toBe("pxpipe");
    expect(event.applied).toBe(false);
    expect(event.reason).toBe("transform_error");
  });
});

// Audit finding 9: pxpipe used to emit only to its own sink (onPxpipeEvent),
// never joining the main token-saver stage table. It now ALSO emits a row the
// dashboard stage table and the rid-join read, and folds XFORM.pxpipe-applied
// into the REQ path.
describe("pxpipe joins the main token-saver sink", () => {
  // Fresh executor Response per test: a Response body can be consumed once,
  // and this describe has no access to the sibling describe's beforeEach.
  beforeEach(() => {
    vi.clearAllMocks();
    chatCoreMocks.executeMock.mockResolvedValue(makeExecutorRes());
  });

  it("applied path: main-sink row with rid, bytesSaved, imageCount, and the path code", async () => {
    const onTokenSaverEvent = vi.fn();
    const consoleLines = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLines.push(args.map(String).join(" "));
    });
    try {
      await handleChatCore(pxpipeArgs({ onTokenSaverEvent, requestId: "ppx00001" }));
    } finally {
      spy.mockRestore();
    }
    const row = onTokenSaverEvent.mock.calls.find((c) => c[0]?.saver === "pxpipe")?.[0];
    expect(row).toBeDefined();
    expect(row.rid).toBe("ppx00001");
    expect(row.applied).toBe(true);
    expect(typeof row.bytesSaved).toBe("number");
    expect(row.imageCount).toBe(1);
    // The native pxpipe UI emit still fires alongside the main-sink row.
    expect(chatCoreMocks.onPxpipeEvent.mock.calls.at(-1)?.[0]?.saver).toBe("pxpipe");
    // Path code rides the REQ.ok line.
    const reqLine = consoleLines.find((l) => l.includes(" REQ.ok "));
    expect(reqLine).toBeTruthy();
    expect(reqLine).toContain("XFORM.pxpipe-applied");
  });
});
