// PXPIPE behavior beyond the gate tests in pxpipe.test.js:
//  - threshold boundary (exactly minChars chars → proxy runs, one char less → not)
//  - fail-open integrity: proxy error/timeout leaves the request byte-identical
//  - estimated-tokens suffix accounting (chars/4 before, text+image-tokens after)
//  - chatCore wiring: header 'off' never invokes the proxy; applied swaps the body
//  - tokenSaver events allowlist: no prompt content ever reaches the event store
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressWithPxpipe as compressVisual, formatPxpipeLog } from "../../open-sse/rtk/pxpipe.js";
// These visual compression fixtures explicitly accept lossy conversion.
const compressWithPxpipe = (body, options) => compressVisual(body, { ...options, allowLossy: true });
import {
  __setTokenSaverEventsDirForTest,
  appendTokenSaverEvent,
  readTokenSaverEvents,
} from "../../src/lib/tokenSaver/events.js";

function claudeBody(chars = 30000) {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: "Preserve these instructions exactly.",
    messages: [{ role: "user", content: "u".repeat(chars) }],
  };
}

const encoder = new TextEncoder();

const chatCoreMocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  onPxpipeEvent: vi.fn(),
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

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("compressWithPxpipe threshold boundary", () => {
  it("one char below minChars → proxy never called, request untouched", async () => {
    const body = claudeBody(99); // JSON-serialised length is > 99, so pin exact length
    const threshold = JSON.stringify(body).length + 1;
    const transform = vi.fn();
    const { body: out, summary } = await compressWithPxpipe(body, {
      enabled: true, format: "claude", minChars: threshold, transform,
    });
    expect(transform).not.toHaveBeenCalled();
    expect(out).toBeNull();
    expect(summary).toMatchObject({ applied: false, reason: "below_threshold", threshold });
  });

  it("exactly minChars chars → proxy invoked", async () => {
    const body = claudeBody(99);
    const threshold = JSON.stringify(body).length;
    const compressed = { ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "offline-fixture" } }] }] };
    const transform = vi.fn(async () => ({
      applied: true,
      body: encoder.encode(JSON.stringify(compressed)),
      info: { imageCount: 1, imagePixels: 750, compressedChars: 99 },
    }));
    const { body: out, summary } = await compressWithPxpipe(body, {
      enabled: true, format: "claude", minChars: threshold, transform,
    });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(out).toEqual(compressed);
    expect(summary.applied).toBe(true);
  });
});

describe("compressWithPxpipe fail-open integrity", () => {
  const frozen = claudeBody(30000);

  it("proxy error → body null, input request byte-identical, reason recorded", async () => {
    const before = JSON.stringify(frozen);
    const transform = vi.fn(async () => {
      throw new Error("pxpipe-proxy exploded");
    });
    const { body, summary } = await compressWithPxpipe(frozen, {
      enabled: true, format: "claude", minChars: 100, transform,
    });
    expect(body).toBeNull();
    expect(JSON.stringify(frozen)).toBe(before); // request untouched
    expect(summary.applied).toBe(false);
    expect(summary.reason).toBe("transform_error"); // recorded per code, not free-form text
    expect(summary.originalChars).toBe(before.length);
    expect(String(summary.reason)).not.toContain("exploded");
  });

  it("timeout → body null, input request byte-identical, reason 'timeout'", async () => {
    const before = JSON.stringify(frozen);
    const transform = vi.fn(() => new Promise(() => {})); // never settles
    const { body, summary } = await compressWithPxpipe(frozen, {
      enabled: true, format: "claude", minChars: 100, timeoutMs: 30, transform,
    });
    expect(body).toBeNull();
    expect(JSON.stringify(frozen)).toBe(before);
    expect(summary).toMatchObject({ applied: false, reason: "timeout" });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("compressWithPxpipe estimated-token accounting", () => {
  it("tokensBeforeEst = chars/4; after = remaining text + image pixels/750", async () => {
    const body = claudeBody(30000); // JSON length = L
    const L = JSON.stringify(body).length;
    const compressedChars = 4000;
    const imagePixels = 150000; // → 200 image tokens
    const compressed = { ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "offline-fixture" } }, { type: "image", source: { type: "base64", media_type: "image/png", data: "offline-fixture" } }] }] };
    const transform = vi.fn(async () => ({
      applied: true,
      body: encoder.encode(JSON.stringify(compressed)),
      info: { imageCount: 2, imagePixels, compressedChars },
    }));
    const { summary } = await compressWithPxpipe(body, {
      enabled: true, format: "claude", minChars: 100, transform,
    });
    expect(summary.originalChars).toBe(L);
    expect(summary.tokensBeforeEst).toBe(Math.round(L / 4));
    // after = est tokens of the text NOT imaged (chars - compressedChars) + image tokens,
    // never chars/4 of the new (base64-bloated) body
    expect(summary.tokensAfterEst).toBe(
      Math.round(Math.max(0, L - compressedChars) / 4) + Math.round(imagePixels / 750)
    );
    expect(summary.imageCount).toBe(2);
    expect(summary.savedPct).toBeGreaterThan(0);
    expect(summary.tokensBeforeEst).toBeGreaterThan(summary.tokensAfterEst);
    // suffix line reports est tokens, not provider tokens
    const line = formatPxpipeLog(summary);
    expect(line).toContain(`est ${summary.tokensBeforeEst}→${summary.tokensAfterEst} tokens`);
  });

  it("falls back to 4761 tokens/image when the proxy reports no pixel count", async () => {
    const body = claudeBody(30000);
    const transform = vi.fn(async () => ({
      applied: true,
      body: encoder.encode(JSON.stringify({ ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "offline-fixture" } }] }] })),
      info: { imageCount: 1 },
    }));
    const { summary } = await compressWithPxpipe(body, {
      enabled: true, format: "claude", minChars: 100, transform,
    });
    // no compressedChars reported → nothing counted as imaged text; imageCount fallback 4761/img
    expect(summary.tokensAfterEst).toBe(Math.round(summary.originalChars / 4) + 4761);
  });
});

describe("chatCore pxpipe wiring", () => {
  const executeMock = chatCoreMocks.executeMock;
  const onPxpipeEvent = chatCoreMocks.onPxpipeEvent;

  function makeExecutorRes() {
    return {
      response: new Response(
        JSON.stringify({
          id: "chatcmpl-x",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
      url: "https://api.openai.com/v1/chat/completions",
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
        messages: [{ role: "user", content: "s".repeat(30000) }],
      },
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
          messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "PNG-IMAGE-PLACEHOLDER" } }] }],
        })),
        info: { imageCount: 1, imagePixels: 750, compressedChars: 30000 },
      }),
      clientRawRequest: { headers: {}, body: {} },
      onPxpipeEvent,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async () => makeExecutorRes());
    globalThis.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
  });

  it("header off → proxy never invoked, dispatched body byte-identical", async () => {
    const transform = vi.fn();
    const original = JSON.stringify(pxpipeArgs().body);
    await handleChatCore(pxpipeArgs({
      pxpipeTransform: transform,
      clientRawRequest: { headers: { "x-tokenproxy-token-saver": "off" }, body: {} },
    }));
    expect(transform).not.toHaveBeenCalled();
    const dispatched = executeMock.mock.calls.at(-1)?.[0]?.body;
    expect(JSON.stringify(dispatched)).toBe(original);
    // a skip summary is still surfaced (applied:false), never a savings event
    expect(onPxpipeEvent).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
  });

  it("header absent + pxpipeEnabled → transformed body dispatched, event fired", async () => {
    await handleChatCore(pxpipeArgs());
    const dispatched = executeMock.mock.calls.at(-1)?.[0]?.body;
    expect(JSON.stringify(dispatched)).toContain("PNG-IMAGE-PLACEHOLDER");
    // payload is { provider, model, ...summary }: applied + proxy-reported fields
    expect(onPxpipeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", applied: true, imageCount: 1 })
    );
  });

  it("pxpipeEnabled false (default) → proxy never invoked even with header absent", async () => {
    const transform = vi.fn();
    await handleChatCore(pxpipeArgs({ pxpipeEnabled: false, pxpipeTransform: transform }));
    expect(transform).not.toHaveBeenCalled();
  });
});

describe("tokenSaver events allowlist (no prompt content leaks)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "token-saver-events-"));
    __setTokenSaverEventsDirForTest(dir);
  });
  afterEach(() => {
    __setTokenSaverEventsDirForTest(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pxpipe event persists only allowlisted fields; poisoned extras dropped", () => {
    appendTokenSaverEvent({
      saver: "pxpipe",
      applied: true,
      ts: Date.now(),
      model: "claude-sonnet-4-5",
      tokensBeforeEst: 8000,
      tokensAfterEst: 1000,
      imageCount: 2,
      durationMs: 42,
      // poison: prompt content, free-form diagnostics, unknown fields
      prompt: "SECRET SYSTEM PROMPT BODY",
      messages: [{ role: "user", content: "SECRET USER TEXT" }],
      body: "SECRET REQUEST JSON",
      reason: "phantom",
      error: "stack trace with SECRET context",
    });
    const rows = readTokenSaverEvents();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.saver).toBe("pxpipe");
    expect(row.tokensBeforeEst).toBe(8000);
    expect(row.tokensAfterEst).toBe(1000);
    expect(row.imageCount).toBe(2);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("SECRET");
    // no free-form reason either: only the vetted enum survives
    expect(row.reason).toBe("phantom");
    expect(serialised).not.toContain("error");
    expect(row).not.toHaveProperty("prompt");
    expect(row).not.toHaveProperty("messages");
    expect(row).not.toHaveProperty("body");
  });

  it("non-vetted saver label is rejected (saver field is a closed set)", () => {
    appendTokenSaverEvent({ saver: "caveman", applied: true, ts: Date.now() });
    expect(readTokenSaverEvents()).toHaveLength(0);
  });
});
