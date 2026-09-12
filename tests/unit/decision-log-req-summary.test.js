import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Wave 2 of docs/logging-design.md: the REQ one-liner, its rid<->ledger join,
// the x-tp-rid echo, the boot line, and the UP/STREAM/XFORM/ACCT lines that
// explain a request's path. Emissions come from the real decide.js sink, so
// every assertion here reads the actual rendered line.

const harness = vi.hoisted(() => ({
  executeMock: vi.fn(),
  closeRequestLog: vi.fn(async () => {}),
  cancelRequestLog: vi.fn(),
  saveRequestDetailMock: vi.fn(),
  headroom: {
    compressWithHeadroom: vi.fn(async () => null),
    formatHeadroomLog: vi.fn(() => null),
    formatHeadroomSizeLog: vi.fn(() => ""),
    isHeadroomPhantomSavings: vi.fn(() => false),
  },
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: harness.saveRequestDetailMock,
  trackActiveSession: vi.fn(),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: harness.executeMock }),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => harness.headroom);

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    close: harness.closeRequestLog,
    cancel: harness.cancelRequestLog,
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

vi.mock("../../open-sse/utils/pxpipe.js", () => ({
  isPxpipeEnabled: vi.fn(() => false),
  runPxpipeHook: vi.fn(async () => null),
}));

vi.mock("../../open-sse/rtk/index.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: vi.fn(() => null),
    tokenRecovery: { ...actual.tokenRecovery, enabled: false },
  };
});

vi.mock("@/lib/tokenSaver/events.js", async () => {
  const actual = await vi.importActual("@/lib/tokenSaver/events.js").catch(() => ({}));
  return {
    ...actual,
    appendTokenSaverEvent: vi.fn(),
  };
});


import { __decide, notePath, pathFor, reqSummary, RID_HEADER } from "@/shared/observability/decide.js";
import { errorResponse, unavailableResponse, createErrorResult } from "../../open-sse/utils/error.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { countCacheAnchors } from "../../open-sse/translator/formats/claude.js";
import {
  buildOnStreamComplete,
  handleStreamingResponse,
} from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { getModelInfo } from "../../open-sse/config/models.js";

const AT = Date.parse("2026-09-04T00:00:00.000Z");
let lines;
let consoleSpy;

beforeEach(() => {
  __decide.resetState();
  __decide.disableSink();
  lines = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((l) => {
    if (typeof l === "string") lines.push(l);
  });
  harness.saveRequestDetailMock.mockReset();
  harness.saveRequestDetailMock.mockImplementation(async (d) => {
    d.id ||= "row-123";
  });
  harness.executeMock.mockReset();
  harness.closeRequestLog.mockClear();
  harness.cancelRequestLog.mockClear();
});

afterEach(() => {
  consoleSpy.mockRestore();
});

const reqLines = () => lines.filter((l) => l.includes(" REQ."));
const classLines = (cls) => lines.filter((l) => l.includes(` ${cls}.`));

describe("reqSummary path= assembly", () => {
  it("omits path= when the request took no annotated forks", () => {
    reqSummary("ok", { rid: "r-no-path" }, AT);
    expect(reqLines()).toHaveLength(1);
    expect(reqLines()[0]).not.toContain("path=");
  });

  it("joins fork codes in order and clears them after the emit", () => {
    notePath("r-pathed", "XFORM.headroom-skip");
    notePath("r-pathed", "XFORM.cache-keep");
    reqSummary("ok", { rid: "r-pathed" }, AT);
    expect(reqLines()[0]).toContain("path=XFORM.headroom-skip,XFORM.cache-keep");
    // codes are consumed, not accumulated: a second summary on the same rid
    // must not see them again
    reqSummary("ok", { rid: "r-pathed" }, AT + 1);
    expect(reqLines()[1]).not.toContain("path=");
    expect(pathFor("r-pathed")).toEqual([]);
  });

  it("a 7-code saver path retains cache-keep under the widened render budget", () => {
    for (const code of [
      "XFORM.rtk-applied",
      "XFORM.headroom-applied",
      "XFORM.mem-pruned",
      "XFORM.compact-applied",
      "XFORM.tool-distill",
      "XFORM.injected",
      "XFORM.cache-keep",
    ]) {
      notePath("r-wide", code);
    }
    reqSummary("ok", { rid: "r-wide" }, AT);
    expect(reqLines()[0]).toContain(
      "path=XFORM.rtk-applied,XFORM.headroom-applied,XFORM.mem-pruned,XFORM.compact-applied,XFORM.tool-distill,XFORM.injected,XFORM.cache-keep",
    );
  });

  it("an 8-stage save list renders complete, not mid-delta cut", () => {
    const save = "rtk:-100,headroom:-200,schema:-300,inject:3952,mem:-42400,privacy:30,pxpipe:-15,final:12";
    reqSummary("ok", { rid: "r-save", save }, AT);
    expect(reqLines()[0]).toContain(`save=${save}`);
  });

  it("countCacheAnchors counts only valid ephemeral breakpoints", () => {
    const body = {
      system: [
        { type: "text", text: "a", cache_control: { type: "ephemeral" } },
        { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "c", cache_control: { type: "ephemeral", ttl: "bogus" } },
        { type: "text", text: "d" },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "e", cache_control: { type: "ephemeral" } }] },
      ],
    };
    expect(countCacheAnchors(body)).toBe(3);
    expect(countCacheAnchors({ messages: [] })).toBe(0);
  });
});

describe("x-tp-rid header echo", () => {
  it("errorResponse stamps the rid when given one", () => {
    expect(errorResponse(502, "x", { rid: "abc" }).headers.get(RID_HEADER)).toBe("abc");
    expect(errorResponse(502, "x").headers.get(RID_HEADER)).toBeNull();
  });

  it("unavailableResponse stamps the rid when given one", () => {
    const res = unavailableResponse(503, "x", 30, "30s", { rid: "abc" });
    expect(res.headers.get(RID_HEADER)).toBe("abc");
  });

  it("createErrorResult carries rid through to the response", () => {
    expect(createErrorResult(502, "x", null, null, "abc").response.headers.get(RID_HEADER)).toBe("abc");
  });
});

describe("ACCT telemetry for cache aliases the resolver supports", () => {
  // CACHE_WRITE_KEYS carries `cache_write_tokens`, so resolveCacheTokens reads
  // the spelling. A dropped-alias line here would report a loss that did not
  // happen; the quantity assertion is what proves the silence is earned.
  it("stays silent on a flat cache_write_tokens and keeps its quantity", () => {
    const out = canonicalizeUsage({ cache_write_tokens: 12, prompt_tokens: 5 });
    expect(out.cache_creation_input_tokens).toBe(12);
    expect(classLines("ACCT")).toHaveLength(0);
  });

  it("stays silent on the nested input_tokens_details spelling", () => {
    const out = canonicalizeUsage({ input_tokens: 20, input_tokens_details: { cache_write_tokens: 6 } });
    expect(out.cache_creation_input_tokens).toBe(6);
    expect(classLines("ACCT")).toHaveLength(0);
  });

  it("stays silent on a reported zero and on a genuine absence alike", () => {
    expect(canonicalizeUsage({ prompt_tokens: 5, cache_write_tokens: 0 }).cache_creation_input_tokens).toBe(0);
    expect(canonicalizeUsage({ prompt_tokens: 5 }).cache_creation_input_tokens).toBe(0);
    expect(classLines("ACCT")).toHaveLength(0);
  });
});

describe("handleChatCore REQ.ok one-liner", () => {
  it("emits exactly one REQ.ok with rid, route, conn, tokens and row=", async () => {
    const result = await handleChatCore(baseArgs({ requestId: "abcdef1234" }));
    // the openai drive answers through the forced-SSE path; completion (and
    // therefore the REQ.ok summary) fires only once the body is consumed
    await result.response.text();
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z REQ\.ok rid=abcdef1234 conn=test-con route=openai\/gpt-4o>openai\/gpt-4o fmt=openai>openai row=[a-f0-9-]{36} t=\d+ in=8 out=4 cr=0 cw=0 ctx=8 ttft=\d+( path=\S+)?$/
    );
  });

  it("echoes x-tp-rid on the success response", async () => {
    const result = await handleChatCore(baseArgs({ requestId: "abcdef1234" }));
    expect(result.response.headers.get(RID_HEADER)).toBe("abcdef1234");
  });

  it("carries the rid into the request detail and usage rows", async () => {
    const result = await handleChatCore(baseArgs({ requestId: "abcdef1234" }));
    await result.response.text();
    const detailArg = harness.saveRequestDetailMock.mock.calls.at(-1)[0];
    expect(detailArg.rid).toBe("abcdef1234");
    expect(reqLines()[0]).toContain(`row=${detailArg.id}`);
  });
});

describe("handleChatCore REQ.failed at terminal provider errors", () => {
  it("emits REQ.failed with status and upstream why, and no REQ.ok", async () => {
    harness.executeMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    const result = await handleChatCore(baseArgs({ requestId: "abcdef1234" }));
    expect(result.response.status).toBe(500);
    expect(harness.closeRequestLog).toHaveBeenCalledTimes(1);
    expect(result.response.headers.get(RID_HEADER)).toBe("abcdef1234");
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain("REQ.failed");
    expect(reqs[0]).toContain("rid=abcdef1234");
    expect(reqs[0]).toContain("status=500");
    expect(reqs[0]).toContain("why=upstream");
  });
});

describe("handleChatCore XFORM cache fork notes", () => {
  it("notes cache-keep when existing claude anchors survive re-anchoring", async () => {
    await handleChatCore(claudeArgs({ requestId: "rid-keep-1", anchors: 2 }));
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatch(/path=.*XFORM\.cache-keep$/);
  });

  it("notes cache-legacy when the body carried no valid anchors", async () => {
    await handleChatCore(claudeArgs({ requestId: "rid-legacy-1", anchors: 0 }));
    expect(reqLines()[0]).toMatch(/path=.*XFORM\.cache-legacy$/);
  });
});

describe("handleChatCore XFORM.headroom-phantom", () => {
  it("emits delta and shrunk_pct when savings are phantom", async () => {
    harness.headroom.compressWithHeadroom.mockImplementation(async (body, { diagnostics }) => {
      diagnostics.before = { bodyBytes: 10000 };
      diagnostics.after = { bodyBytes: 9600 };
      return { tokens_before: 5000, tokens_after: 4000, tokens_saved: 1000 };
    });
    harness.headroom.isHeadroomPhantomSavings.mockReturnValue(true);
    harness.headroom.formatHeadroomLog.mockReturnValue("saved 1000 tokens");
    await handleChatCore(baseArgs({ requestId: "rid-phantom-1" }));
    const xf = classLines("XFORM");
    expect(xf).toHaveLength(1);
    expect(xf[0]).toContain("XFORM.headroom-phantom");
    expect(xf[0]).toContain("rid=rid-phantom-1");
    expect(xf[0]).toContain("delta=1000");
    expect(xf[0]).toContain("shrunk_pct=4");
  });
});

describe("streaming: buildOnStreamComplete emissions", () => {
  const streamCtx = (over = {}) => ({
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    connectionId: "conn-x",
    apiKey: "k",
    requestStartTime: Date.now(),
    body: { model: "m", messages: [] },
    stream: true,
    finalBody: {},
    translatedBody: {},
    clientRawRequest: { endpoint: "/v1/messages", body: { model: "m" } },
    reqTag: "T",
    log: { warn: vi.fn(), line: vi.fn(), info: vi.fn(), error: vi.fn() },
    onEmptyStream: vi.fn(),
    sourceFormat: "claude",
    rid: "rid-stream-1",
    route: "m>anthropic/claude-3-5-sonnet-20241022",
    fmt: "claude>claude",
    sel: "win",
    ...over,
  });

  it("flags estimated usage, locks the empty stream, and keeps missing terminal proof unknown", () => {
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(streamCtx());
    onStreamComplete({ content: "", thinking: "" }, { estimated: true, prompt_tokens: 3, completion_tokens: 0 }, null, {});
    const streams = classLines("STREAM");
    expect(streams.some((l) => l.includes("STREAM.usage-estimated") && l.includes("rid=rid-stream-1"))).toBe(true);
    expect(streams.some((l) => l.includes("STREAM.empty") && l.includes("lock=true"))).toBe(true);
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain("REQ.unknown");
    expect(reqs[0]).toContain(`row=${streamDetailId}`);
    expect(reqs[0]).toContain("in=3");
  });

  it("emits REQ.failed status=499 why=aborted on caller abort", () => {
    const { onStreamComplete } = buildOnStreamComplete(streamCtx());
    onStreamComplete(
      { content: "partial", thinking: "" },
      { prompt_tokens: 3, completion_tokens: 1 },
      Date.now(),
      { aborted: true, terminalEvidence: { state: "cancelled", reason: "caller-cancelled", source: "gateway-stream" } }
    );
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain("REQ.failed");
    expect(reqs[0]).toContain("status=499");
    expect(reqs[0]).toContain("why=aborted");
    expect(reqs[0]).toContain("conn=conn-x");
  });

  it("stall abandonment locks and reports STREAM.stalled", () => {
    const { onStreamAbandoned } = buildOnStreamComplete(streamCtx());
    onStreamAbandoned("stall_timeout");
    const streams = classLines("STREAM");
    expect(streams.some((l) => l.includes("STREAM.stalled") && l.includes("action=lock"))).toBe(true);
    expect(reqLines()[0]).toContain("REQ.unknown");
    expect(reqLines()[0]).not.toContain("status=502");
  });

  it("routes detail-write failures to ACCT with phases save-stream/update/finalize", async () => {
    harness.saveRequestDetailMock.mockRejectedValue(new Error("db down"));
    const a = buildOnStreamComplete(streamCtx({ rid: "rid-acct-1" }));
    a.onStreamComplete({ content: "hi", thinking: "" }, { prompt_tokens: 2, completion_tokens: 1 }, Date.now(), {});
    const b = buildOnStreamComplete(streamCtx({ rid: "rid-acct-2" }));
    b.onStreamAbandoned("upstream_error");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const acct = classLines("ACCT");
    const phases = acct.map((l) => l.match(/phase=(\S+)/)?.[1]);
    for (const l of acct) expect(l).toContain("ACCT.detail-write-failed");
    expect(phases).toContain("update");
    expect(phases).toContain("finalize");
  });
});

describe("streaming: handleStreamingResponse non-SSE guard", () => {
  it("rejects a 200 HTML upstream as STREAM.non-sse and echoes rid", async () => {
    const result = await handleStreamingResponse({
      providerResponse: new Response("<html><title>err</title></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      sourceFormat: "claude",
      targetFormat: "claude",
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      stream: true,
      translatedBody: { model: "m", messages: [{ role: "user", content: "hi" }] },
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "conn-x",
      apiKey: "k",
      clientRawRequest: { endpoint: "/v1/messages", body: { model: "m" } },
      rid: "rid-nonsse-1",
      reqTag: "T",
      log: { warn: vi.fn(), line: vi.fn(), info: vi.fn(), errorLine: vi.fn() },
    });
    expect(result.response.headers.get(RID_HEADER)).toBe("rid-nonsse-1");
    const streams = classLines("STREAM");
    expect(streams).toHaveLength(1);
    expect(streams[0]).toContain("STREAM.non-sse");
    expect(streams[0]).toContain("rid=rid-nonsse-1");
    expect(streams[0]).toContain("why=non-sse-content-type");
    expect(streams[0]).toContain("conn=conn-x");
  });
});

describe("streaming: placeholder detail write", () => {
  it("routes the placeholder write failure to ACCT phase=save-stream", async () => {
    harness.saveRequestDetailMock.mockRejectedValue(new Error("db down"));
    const result = await handleStreamingResponse({
      providerResponse: new Response(
        'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      ),
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      sourceFormat: "claude",
      targetFormat: "claude",
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      stream: true,
      translatedBody: { model: "m", messages: [{ role: "user", content: "hi" }] },
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "conn-x",
      apiKey: "k",
      clientRawRequest: { endpoint: "/v1/messages", body: { model: "m" } },
      rid: "rid-stream-save-1",
      reqTag: "T",
      log: { warn: vi.fn(), line: vi.fn(), info: vi.fn(), errorLine: vi.fn() },
    });
    expect(result.success).toBe(true);
    expect(result.response.headers.get(RID_HEADER)).toBe("rid-stream-save-1");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const acct = classLines("ACCT");
    expect(acct.some((l) => l.includes("ACCT.detail-write-failed") && l.includes("phase=save-stream"))).toBe(true);
    result.response.body?.cancel?.();
  });
});

describe("detail-write ACCT phases on the non-stream handlers", () => {
  const nsArgs = (over = {}) => ({
    providerResponse: new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
    provider: "openai",
    model: "gpt-4o",
    sourceFormat: "openai",
    targetFormat: "openai",
    body: { model: "gpt-4o", messages: [] },
    stream: false,
    translatedBody: { model: "gpt-4o", messages: [] },
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: "conn-x",
    apiKey: "k",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: { model: "gpt-4o" } },
    rid: "rid-ns-1",
    route: "gpt-4o>openai/gpt-4o",
    fmt: "openai>openai",
    sel: "win",
    reqTag: "T",
    log: { warn: vi.fn(), line: vi.fn(), info: vi.fn() },
    trackDone: vi.fn(),
    appendLog: vi.fn(async () => {}),
    reqLogger: {
      logProviderResponse: vi.fn(),
      logConvertedResponse: vi.fn(),
      logError: vi.fn(),
    },
    ...over,
  });

  it("non-stream success: REQ.ok with row= and x-tp-rid header", async () => {
    const result = await handleNonStreamingResponse(nsArgs());
    expect(result.success).toBe(true);
    expect(result.response.headers.get(RID_HEADER)).toBe("rid-ns-1");
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain("REQ.ok");
    expect(reqs[0]).toContain("row=row-123");
  });

  it("non-stream detail-write failure: ACCT phase=save", async () => {
    harness.saveRequestDetailMock.mockRejectedValue(new Error("db down"));
    await handleNonStreamingResponse(nsArgs());
    expect(classLines("ACCT").some((l) => l.includes("phase=save"))).toBe(true);
  });

  it("forced-SSE detail-write failure: ACCT phase=save-json", async () => {
    harness.saveRequestDetailMock.mockRejectedValue(new Error("db down"));
    const sseBody = 'data: {"id":"chatcmpl-x","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const result = await handleForcedSSEToJson(
      nsArgs({
        providerResponse: new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
        rid: "rid-s2j-1",
      })
    );
    expect(classLines("ACCT").some((l) => l.includes("phase=save-json"))).toBe(true);
    const echoed = result?.response?.headers?.get?.(RID_HEADER) ?? result?.headers?.get?.(RID_HEADER);
    expect(echoed).toBe("rid-s2j-1");
  });
});

describe("LOG.boot (custom-server)", () => {
  it("emits a boot line with sha/version/node/db/logdecisions and never throws", () => {
    const serverDir = path.resolve(__dirname, "../..");
    // A child boot must not write into the real ~/.tokenproxy sink: point
    // DATA_DIR at a scratch dir and expect db= to name it.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tp-boot-"));
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `process.env.TOKENPROXY_LOG_DECISIONS='1';
         const http = require('http');
         require(${JSON.stringify(path.join(serverDir, "custom-server.js"))});
         const s = http.createServer((req, res) => { res.writeHead(404); res.end('{}'); });
         s.listen(0, () => setTimeout(() => process.exit(0), 800));`,
      ],
      { encoding: "utf8", timeout: 20000, env: { ...process.env, TOKENPROXY_LOG_DECISIONS: "1", DATA_DIR: scratch } }
    );
    expect(child.error).toBeUndefined();
    const boot = child.stdout.split("\n").filter((l) => l.includes("LOG.boot"));
    expect(boot).toHaveLength(1);
    // sha resolves BUILD_SHA when the pack wrote one, 'unknown' in a bare checkout.
    expect(boot[0]).toMatch(/sha=([0-9a-f]{12}|unknown)/);
    expect(boot[0]).toMatch(/version=\S+/);
    expect(boot[0]).toMatch(/node=\d+\.\d+/);
    expect(boot[0]).toContain(`db=${path.basename(scratch)}`);
    expect(boot[0]).toContain("logdecisions=on");
  });
});

describe("REQ.ok save=/ce= with a composed saver pipeline", () => {
  // The RTK mock (wired above as vi.fn(() => null)) stands in for the real
  // compressor: it shrinks message text in place and reports honest
  // before/after char counts with one hit, exactly like compressMessages.
  const shrinkRtk = () =>
    compressMessages.mockImplementation((body, enabled) => {
      if (!enabled || !body?.messages) return null;
      const bytesBefore = JSON.stringify(body).length;
      for (const m of body.messages) {
        if (typeof m.content === "string") m.content = "hi";
      }
      const bytesAfter = JSON.stringify(body).length;
      return { hits: ["m0"], bytesBefore, bytesAfter };
    });

  it("save=/save_tok= appear with the rtk stage delta; ce= silent on first sight of a sid", async () => {
    shrinkRtk();
    const result = await handleChatCore(
      baseArgs({ requestId: "saver-0001", rtkEnabled: true, sid: "cesess-01" })
    );
    await result.response.text();
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    // "hello" → "hi" is a 3-byte shrink; save_tok rounds /4 toward -1.
    expect(reqs[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z REQ\.ok rid=saver-0001 conn=test-con save=rtk:-3 save_tok=-1 route=openai\/gpt-4o>openai\/gpt-4o fmt=openai>openai row=[a-f0-9-]{36} t=\d+ in=8 out=4 cr=0 cw=0 ctx=8 ttft=\d+( path=\S+)?$/
    );
    // first request of the session: no previous body to compare against
    expect(reqs[0]).not.toContain("ce=");
    // the rtk path code speaks where the stage ran
    expect(reqs[0]).toMatch(/path=\S*XFORM\.rtk-applied\S*$/);
  });

  it("ce= reports the shared prefix on a repeat request of the same sid", async () => {
    shrinkRtk();
    const first = await handleChatCore(
      baseArgs({ requestId: "saver-0002", rtkEnabled: true, sid: "cesess-02" })
    );
    await first.response.text();
    const second = await handleChatCore(
      baseArgs({ requestId: "saver-0003", rtkEnabled: true, sid: "cesess-02" })
    );
    await second.response.text();
    const reqs = reqLines();
    expect(reqs).toHaveLength(2);
    const ce = reqs[1].match(/ ce=(\d+)/);
    expect(ce).toBeTruthy();
    // identical request bodies share everything but the tail after RTK
    // already ran on the stored body; the prefix must be a large, positive
    // share of the body, not zero
    expect(Number(ce[1])).toBeGreaterThan(50);
  });

  it("no saver running keeps the line byte-identical to the pre-telemetry shape", async () => {
    const result = await handleChatCore(baseArgs({ requestId: "saver-0004" }));
    await result.response.text();
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toContain("save=");
    expect(reqs[0]).not.toContain("save_tok=");
    expect(reqs[0]).not.toContain("ce=");
  });
});

// ---- handleChatCore drive harness (mirrors chatCore-token-saver.test.js) ----

function makeExecutorRes(content = "ok") {
  const sse =
    `data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":null}]}\n\n` +
    'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n' +
    "data: [DONE]\n\n";
  return {
    response: new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

beforeEach(() => {
  harness.executeMock.mockResolvedValue(makeExecutorRes());
});

function baseArgs(over = {}) {
  const modelInfo = { ...getModelInfo("openai/gpt-4o"), provider: "openai", model: "gpt-4o" };
  return {
    body: { model: "openai/gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
    stream: false,
    tokenSaverEnabled: true,
    rawCredentials: { connectionId: "test-conn", apiKey: "sk-test", providerSpecificData: { projectId: "p" } },
    modelInfo,
    providerSpecificData: {},
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {} },
    apiKey: "sk-test",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn() },
    getModelInfo,
    connectionId: "test-conn",
    onTokenSaverEvent: vi.fn(),
    ...over,
  };
}

function claudeArgs({ requestId, anchors }) {
  const system = anchors
    ? [
        { type: "text", text: "s1", cache_control: { type: "ephemeral" } },
        { type: "text", text: "s2", cache_control: { type: "ephemeral" } },
      ]
    : [{ type: "text", text: "s1" }, { type: "text", text: "s2" }];
  harness.executeMock.mockResolvedValue({
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
      { status: 200, headers: { "content-type": "application/json" } }
    ),
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    transformedBody: null,
  });
  const modelInfo = {
    ...getModelInfo("anthropic/claude-3-5-sonnet"),
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
  };
  return {
    body: {
      model: "claude-3-5-sonnet",
      max_tokens: 16,
      stream: false,
      system,
      messages: [{ role: "user", content: "hi" }],
    },
    stream: false,
    tokenSaverEnabled: false,
    rawCredentials: { connectionId: "test-conn", apiKey: "sk-test", providerSpecificData: {} },
    modelInfo,
    providerSpecificData: {},
    clientRawRequest: { endpoint: "/v1/messages", body: {} },
    apiKey: "sk-test",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn() },
    getModelInfo,
    connectionId: "test-conn",
    onTokenSaverEvent: vi.fn(),
    requestId,
  };
}

// Schema/folding tests capture admitted lines; bounded asynchronous transport has its own suite.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));


describe('request-log lifecycle integration', () => {
  it('closes bounded retention after forced-stream JSON completion', async () => {
    const result = await handleChatCore(baseArgs());
    await result.response.text();
    expect(harness.closeRequestLog).toHaveBeenCalledTimes(1);
  });
  it('keeps retention open while an SSE response lives and closes on consumption', async () => {
    const result = await handleChatCore(baseArgs({ body: { model: 'openai/gpt-4o', stream: true, messages: [{ role: 'user', content: 'hello' }] }, stream: true }));
    expect(harness.closeRequestLog).not.toHaveBeenCalled();
    await result.response.text();
    expect(harness.closeRequestLog).toHaveBeenCalledTimes(1);
  });
  it('does not turn asynchronous logger failure into a failed request', async () => {
    harness.closeRequestLog.mockRejectedValueOnce(new Error('controlled log failure'));
    const result = await handleChatCore(baseArgs());
    expect(result.success).toBe(true);
    await result.response.text();
    await new Promise(setImmediate);
  });
});
