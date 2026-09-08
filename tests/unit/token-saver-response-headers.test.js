import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// HEADERS finding: model-self-sizing response headers (x-tp-ctx-tokens,
// x-tp-save-bytes, x-tp-ce-bytes, x-tp-compact-hint) on every gateway-built
// response path — non-streaming JSON, streaming SSE, and forced SSE→JSON —
// all derived from the already-computed saver telemetry. x-tp-rid stays as-is.

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  dispatched: null,
}));

vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: (...args) => {
      // capture the body the pipeline dispatched (post-saver, pre-wire)
      mocks.dispatched = JSON.stringify(args[0]?.body);
      return mocks.executeMock(...args);
    },
  }),
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
  // passthrough mock with a real flush: completion is recorded in the
  // transform's flush (see stream-terminal-contract), so the REQ.ok summary
  // only fires if the mock calls onStreamComplete (arg 5) there
  createPassthroughStreamWithLogger: vi.fn((...args) => {
    const onStreamComplete = args[5];
    return new TransformStream({
      flush() {
        onStreamComplete?.(
          { content: "ok", thinking: "" },
          { prompt_tokens: 8, completion_tokens: 4 },
          Date.now(),
          {},
        );
      },
    });
  }),
}));

// RTK stand-in: shrinks one fat tool message by an exact, known amount.
vi.mock("../../open-sse/rtk/index.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: vi.fn((body, enabled) => {
      if (!enabled || !body?.messages) return null;
      let shrunk = false;
      const target = body.messages.find(
        (m) => m?.role === "tool" && typeof m.content === "string" && m.content.length === 900,
      );
      if (target) {
        target.content = "x".repeat(100);
        shrunk = true;
      }
      // Claude shape: a fat tool_result block
      for (const m of body.messages || []) {
        if (!Array.isArray(m?.content)) continue;
        for (const block of m.content) {
          if (block?.type === "tool_result" && typeof block.content === "string" && block.content.length === 2000) {
            block.content = "f".repeat(200);
            shrunk = true;
          }
        }
      }
      return { bytesBefore: 0, bytesAfter: 0, hits: shrunk ? [{ filter: "fat" }] : [] };
    }),
  };
});

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => null),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/rtk/pxpipe.js", () => ({
  compressWithPxpipe: vi.fn(async () => ({ body: null, summary: { applied: false, reason: "disabled" } })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore, sessionCalibrationFor } = await import("../../open-sse/handlers/chatCore.js");
const { estimateRequestTokens, calibrationFactor } = await import("../../open-sse/services/memory/contextBudget.js");

// x-tp-ctx-tokens is the CALIBRATED ESTIMATE, the same number the pruning
// ladder measures pressure with, never the old bytes/4. Measured live on
// Haiku over an 18-turn tool-heavy session, bytes/4 ran 26% to 34% under the
// provider's own count on every turn; the calibrated estimate landed within
// 2.8%. An agent that self-sizes from this header and a ladder that decides
// whether to cut history now read one number.
// The calibration is snapshotted BEFORE the request under test, because the
// request's own REQ.ok summary feeds the provider's billed count back into it
// and the header was already written by then.
function expectedCtxTokens(calBefore) {
  return String(Math.ceil(estimateRequestTokens(JSON.parse(mocks.dispatched)) * calBefore));
}

function calNow(sid) {
  return calibrationFactor(sessionCalibrationFor(sid));
}

// openai is forceStream upstream: this SSE body feeds both the streaming and
// the forced SSE→JSON paths.
const SSE_BODY =
  `data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n` +
  'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n' +
  "data: [DONE]\n\n";

function sseExecutorRes() {
  return {
    response: new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
  };
}

function anthropicExecutorRes() {
  return {
    response: new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    transformedBody: null,
  };
}

let consoleLines;
let consoleSpy;

beforeEach(() => {
  mocks.executeMock.mockReset();
  mocks.dispatched = null;
  consoleLines = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    consoleLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

function reqLines() {
  return consoleLines.filter((l) => l.includes(" REQ."));
}

function fatToolBody() {
  return {
    model: "openai/gpt-4o",
    stream: false,
    messages: [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a".repeat(900) },
    ],
  };
}

async function drive(overrides = {}) {
  const result = await handleChatCore({
    body: fatToolBody(),
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "TAG", nextTag: () => "TAG", fmtThink: () => null },
    connectionId: "hdr-conn",
    rtkEnabled: true,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    memorySettings: null,
    requestId: overrides.requestId || "hdr0001",
    ...overrides,
  });
  await result.response.text();
  return result;
}

describe("x-tp saver response headers", () => {
  it("non-streaming JSON path carries ctx-tokens and save-bytes from the saver ledger", async () => {
    mocks.executeMock.mockImplementation(async () => anthropicExecutorRes());
    const calBefore = calNow(null);
    const result = await drive({
      body: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        stream: false,
        messages: [
          { role: "user", content: "inspect this" },
          { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "read_file", input: { path: "x" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "F".repeat(2000) }] },
        ],
      },
      modelInfo: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      requestId: "hdr0100",
    });
    expect(result.success).toBe(true);
    const headers = result.response.headers;
    expect(headers.get("x-tp-ctx-tokens")).toBe(expectedCtxTokens(calBefore));
    // and it is NOT the bytes/4 figure this replaced
    expect(headers.get("x-tp-ctx-tokens")).not.toBe(String(Math.round(mocks.dispatched.length / 4)));
    // save-bytes = signed sum of stage deltas, same arithmetic as save_tok=*4
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    const save = reqs[0].match(/ save=([^\s]+)/)[1];
    const sum = save.split(",").reduce((a, kv) => a + Number(kv.split(":")[1]), 0);
    expect(headers.get("x-tp-save-bytes")).toBe(String(sum));
    // no sid: ce unknown, so no ce-bytes and no compact hint
    expect(headers.get("x-tp-ce-bytes")).toBeNull();
    expect(headers.get("x-tp-compact-hint")).toBeNull();
    // x-tp-rid untouched
    expect(headers.get("x-tp-rid")).toBe("hdr0100");
  });

  it("streaming SSE path sets the headers on the initial response headers", async () => {
    mocks.executeMock.mockImplementation(async () => sseExecutorRes());
    const base = { model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "first question" }] };
    await drive({ body: structuredClone(base), sid: "hdr-sid-1", requestId: "hdr0200" });
    const appended = structuredClone(base);
    appended.messages.push({ role: "assistant", content: "answer" });
    appended.messages.push({ role: "user", content: "second question" });
    const calBefore = calNow("hdr-sid-1");
    const result = await drive({ body: appended, sid: "hdr-sid-1", requestId: "hdr0201" });
    const headers = result.response.headers;
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(headers.get("x-tp-ctx-tokens")).toBe(expectedCtxTokens(calBefore));
    // rtk ran but found nothing to shrink: no stage deltas, so no save-bytes
    expect(headers.get("x-tp-save-bytes")).toBeNull();
    const reqs = reqLines();
    expect(reqs).toHaveLength(2);
    const ce = Number(reqs[1].match(/ ce=(\d+)/)[1]);
    expect(ce).toBeGreaterThan(60);
    expect(headers.get("x-tp-ce-bytes")).toBe(String(ce));
    expect(headers.get("x-tp-compact-hint")).toBeNull();
    expect(headers.get("x-tp-rid")).toBe("hdr0201");
  });

  it("forced SSE→JSON path fires x-tp-compact-hint only when ce collapses >50%", async () => {
    mocks.executeMock.mockImplementation(async () => sseExecutorRes());
    const base = {
      model: "openai/gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "q".repeat(2000) }],
    };
    const first = await drive({ body: structuredClone(base), sid: "hdr-sid-2", requestId: "hdr0300" });
    expect(first.response.headers.get("x-tp-compact-hint")).toBeNull();
    expect(first.response.headers.get("x-tp-ce-bytes")).toBeNull();

    const rewritten = structuredClone(base);
    rewritten.messages[0] = { role: "user", content: "an entirely different opening question" };
    const calBefore = calNow("hdr-sid-2");
    const second = await drive({ body: rewritten, sid: "hdr-sid-2", requestId: "hdr0301" });
    const headers = second.response.headers;
    const reqs = reqLines();
    const ce = Number(reqs[1].match(/ ce=(\d+)/)[1]);
    expect(ce).toBeLessThan(1000); // full rewrite: only the envelope survives
    expect(headers.get("x-tp-ce-bytes")).toBe(String(ce));
    expect(headers.get("x-tp-compact-hint")).toBe("1");
    expect(headers.get("x-tp-ctx-tokens")).toBe(expectedCtxTokens(calBefore));
    expect(headers.get("x-tp-rid")).toBe("hdr0301");
  });

  it("savers off and no sid: no x-tp saver headers are invented", async () => {
    mocks.executeMock.mockImplementation(async () => sseExecutorRes());
    const result = await drive({ rtkEnabled: false, requestId: "hdr0400" });
    const headers = result.response.headers;
    expect(headers.get("x-tp-ctx-tokens")).toBeNull();
    expect(headers.get("x-tp-save-bytes")).toBeNull();
    expect(headers.get("x-tp-ce-bytes")).toBeNull();
    expect(headers.get("x-tp-compact-hint")).toBeNull();
    expect(headers.get("x-tp-rid")).toBe("hdr0400");
  });

  it("gateway-built error responses carry the saver headers too", async () => {
    mocks.executeMock.mockImplementation(async () => ({
      response: new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    }));
    const calBefore = calNow("hdr-sid-3");
    const result = await drive({ sid: "hdr-sid-3", requestId: "hdr0500" });
    expect(result.success).toBe(false);
    const headers = result.response.headers;
    expect(headers.get("x-tp-ctx-tokens")).toBe(expectedCtxTokens(calBefore));
    expect(headers.get("x-tp-save-bytes")).toBe("-800");
    expect(headers.get("x-tp-rid")).toBe("hdr0500");
  });
});
