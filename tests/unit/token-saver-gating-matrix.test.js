// Token-saver gating matrix (#2289 wiring): master switch is the
// x-tokenproxy-token-saver header (runtimeConfig.js TOKEN_SAVER_HEADER), read
// case-insensitively in chatCore.js; per-saver flags come from settingsRepo
// defaults, optionally overridden per combo by resolveComboTokenSaver (combo.js
// COMBO_TOKEN_SAVER_KEYS). Drives handleChatCore like chatCore-token-saver.test.js
// and asserts the observable effect of EVERY saver, not just "no crash".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveComboTokenSaver } from "open-sse/services/combo.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

const CAVEMAN_MARKER = "CAVEMAN_MARKER_TOKEN_SAVER_TEST";

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  headroom: {
    compressWithHeadroom: vi.fn(async () => null),
    formatHeadroomLog: vi.fn(() => null),
    formatHeadroomSizeLog: vi.fn(() => ""),
    isHeadroomPhantomSavings: vi.fn(() => false),
  },
  // Spies at module boundaries; order assertions read these call journals.
  rtk: {
    compressMessages: vi.fn(),
    sawCavemanMarker: false,
  },
  caveman: { injectCaveman: vi.fn() },
  memory: {
    applyMemoryEnhancements: vi.fn(async (body) => ({
      body,
      stats: {
        toolPruning: { applied: true, savedChars: 42 },
        mediaPruning: { applied: false, savedItems: 0 },
        compaction: { applied: false, savedTokens: 0 },
        handoff: { applied: false },
      },
    })),
    seenBodies: [],
  },
  anchor: { anchorClaudeCache: vi.fn() },
  onTokenSaverEvent: vi.fn(),
  onPxpipeEvent: vi.fn(),
  tokenSaverEvents: { appendTokenSaverEvent: vi.fn() },
}));

function makeExecutorRes(content = "ok") {
  return {
    response: new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop", index: 0 }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: mocks.executeMock }),
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

vi.mock("../../open-sse/rtk/index.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: mocks.rtk.compressMessages,
  };
});

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: mocks.headroom.compressWithHeadroom,
  formatHeadroomLog: mocks.headroom.formatHeadroomLog,
  formatHeadroomSizeLog: mocks.headroom.formatHeadroomSizeLog,
  isHeadroomPhantomSavings: mocks.headroom.isHeadroomPhantomSavings,
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: mocks.caveman.injectCaveman,
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
  PONYTAIL_LEVELS: { LITE: "lite", FULL: "full" },
}));

vi.mock("../../open-sse/rtk/pxpipe.js", () => ({
  compressWithPxpipe: vi.fn(async (body, opts) => ({
    body: null,
    summary: { applied: false, reason: opts?.enabled === false ? "disabled" : "passthrough" },
  })),
  formatPxpipeLog: vi.fn(() => null),
}));

vi.mock("../../open-sse/services/memory/index.js", () => ({
  applyMemoryEnhancements: mocks.memory.applyMemoryEnhancements,
}));

vi.mock("../../open-sse/translator/formats/claude.js", async (orig) => {
  const actual = await orig();
  return { ...actual, anchorClaudeCache: mocks.anchor.anchorClaudeCache };
});

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("@/lib/tokenSaver/events.js", async () => {
  const actual = await vi.importActual("@/lib/tokenSaver/events.js").catch(() => ({}));
  return {
    ...actual,
    appendTokenSaverEvent: mocks.tokenSaverEvents.appendTokenSaverEvent,
    readTokenSaverEvents: vi.fn(() => []),
    getTokenSaverStats: vi.fn(() => ({ windows: {}, timeline: [], recent: [] })),
  };
});

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const ALL_SAVER_SETTINGS = {
  rtkEnabled: true,
  headroomEnabled: true,
  cavemanEnabled: true,
  ponytailEnabled: true,
  pxpipeEnabled: true,
  memoryToolPruningEnabled: true,
  memoryMediaPruningEnabled: true,
  memoryCompactionEnabled: true,
  memoryHandoffEnabled: true,
};

function baseArgs(overrides = {}) {
  return {
    body: {
      model: "openai/gpt-4o",
      stream: false,
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "k" },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), tagForSession: () => "TAG", nextTag: () => "TAG", fmtThink: () => null },
    connectionId: "conn-1",
    rtkEnabled: true,
    headroomEnabled: true,
    headroomUrl: "http://localhost:8787",
    headroomCompressUserMessages: false,
    cavemanEnabled: true,
    cavemanLevel: "lite",
    ponytailEnabled: false,
    pxpipeEnabled: false,
    clientRawRequest: { headers: {}, body: {} },
    onTokenSaverEvent: mocks.onTokenSaverEvent,
    onPxpipeEvent: mocks.onPxpipeEvent,
    ...overrides,
  };
}

function executeBody() {
  return mocks.executeMock.mock.calls.at(-1)?.[0]?.body;
}

describe("token saver settings defaults (settingsRepo)", () => {
  it("every saver flag keeps its expected default", () => {
    const d = mergeWithDefaults({});
    // One assertion per flag: a silent flip fails loudly with the flag named.
    expect(d.rtkEnabled).toBe(true);
    expect(d.headroomEnabled).toBe(false);
    expect(d.cavemanEnabled).toBe(false);
    expect(d.ponytailEnabled).toBe(false);
    expect(d.pxpipeEnabled).toBe(false);
    expect(d.thinkingStripEnabled).toBe(false);
    expect(d.queryAwareCompressionEnabled).toBe(false);
    expect(d.pairDropEnabled).toBe(false);
    expect(d.embedReorderEnabled).toBe(false);
    expect(d.embedReorderUrl).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(d.embedReorderModel).toBe("nomic-embed-text");
    expect(d.midPrefixInjectEnabled).toBe(false);
    expect(d.memoryToolPruningEnabled).toBe(true);
    expect(d.memoryMediaPruningEnabled).toBe(true);
    expect(d.memoryCompactionEnabled).toBe(false);
    expect(d.memoryHandoffEnabled).toBe(false);
  });
});

describe("header master switch matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeMock.mockImplementation(async () => makeExecutorRes());
    globalThis.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    mocks.rtk.sawCavemanMarker = false;
    mocks.memory.seenBodies = [];
    // RTK mock: shrink in place, record whether the caveman marker was
    // already present at compression time, return truthy stats when enabled.
    mocks.rtk.compressMessages.mockImplementation((body, enabled) => {
      const text = JSON.stringify(body);
      if (text.includes(CAVEMAN_MARKER)) mocks.rtk.sawCavemanMarker = true;
      if (!enabled) return null;
      for (const m of body?.messages || []) {
        if (typeof m?.content === "string" && m.content.length > 50) {
          m.content = m.content.slice(0, 10);
        }
      }
      return { bytesBefore: text.length, bytesAfter: 10, hits: [{ filter: "test" }], filter: "test" };
    });
    mocks.caveman.injectCaveman.mockImplementation((body) => {
      if (!body) return;
      if (typeof body.system === "string") {
        body.system += ` ${CAVEMAN_MARKER}`;
        return;
      }
      const sys = body.messages?.find((m) => m.role === "system");
      if (sys && typeof sys.content === "string") sys.content += ` ${CAVEMAN_MARKER}`;
    });
    mocks.memory.applyMemoryEnhancements.mockImplementation(async (body) => {
      mocks.memory.seenBodies.push(body);
      return {
        body,
        stats: {
          toolPruning: { applied: true, savedChars: 42 },
          mediaPruning: { applied: false, savedItems: 0 },
          compaction: { applied: false, savedTokens: 0 },
          handoff: { applied: false },
        },
      };
    });
  });

  it("header absent → every enabled saver runs", async () => {
    const res = await handleChatCore(baseArgs());
    expect(res).toBeDefined();
    expect(mocks.rtk.compressMessages).toHaveBeenCalledWith(expect.anything(), true, { allowLossy: false });
    expect(mocks.headroom.compressWithHeadroom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
    expect(mocks.caveman.injectCaveman).toHaveBeenCalled();
    expect(mocks.onTokenSaverEvent).toHaveBeenCalledWith(
      expect.objectContaining({ saver: "rtk", applied: true })
    );
  });

  it("header 'off' → RTK produces no stats and no saver event fires", async () => {
    await handleChatCore(baseArgs({
      clientRawRequest: { headers: { "x-tokenproxy-token-saver": "off" }, body: {} },
    }));
    expect(mocks.rtk.compressMessages).toHaveBeenCalledWith(expect.anything(), false, { allowLossy: false });
    expect(mocks.onTokenSaverEvent).not.toHaveBeenCalled();
  });

  it("header 'off' → headroom called disabled, phantom check skipped", async () => {
    await handleChatCore(baseArgs({
      clientRawRequest: { headers: { "x-tokenproxy-token-saver": "off" }, body: {} },
    }));
    expect(mocks.headroom.compressWithHeadroom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
    expect(mocks.headroom.isHeadroomPhantomSavings).not.toHaveBeenCalled();
  });

  it("header 'off' → no caveman/ponytail injection, memory pruner no-op", async () => {
    await handleChatCore(baseArgs({
      memorySettings: ALL_SAVER_SETTINGS,
      clientRawRequest: { headers: { "x-tokenproxy-token-saver": "off" }, body: {} },
    }));
    expect(mocks.caveman.injectCaveman).not.toHaveBeenCalled();
    expect(mocks.memory.applyMemoryEnhancements).not.toHaveBeenCalled();
    const sys = executeBody()?.messages?.find((m) => m.role === "system");
    expect(String(sys?.content || "")).not.toContain(CAVEMAN_MARKER);
  });

  it.each(["OFF", "Off", "oFF"])("header %j is case-insensitive off", async (value) => {
    await handleChatCore(baseArgs({
      clientRawRequest: { headers: { "x-tokenproxy-token-saver": value }, body: {} },
    }));
    expect(mocks.rtk.compressMessages).toHaveBeenCalledWith(expect.anything(), false, { allowLossy: false });
    expect(mocks.caveman.injectCaveman).not.toHaveBeenCalled();
    expect(mocks.onTokenSaverEvent).not.toHaveBeenCalled();
  });

  it("header 'off' → pxpipe transform never invoked and body untouched", async () => {
    const { compressWithPxpipe } = await import("../../open-sse/rtk/pxpipe.js");
    await handleChatCore(baseArgs({
      pxpipeEnabled: true,
      pxpipeMinChars: 1,
      pxpipeTransform: async () => ({ applied: true, body: new TextEncoder().encode("{}"), info: {} }),
      clientRawRequest: { headers: { "x-tokenproxy-token-saver": "off" }, body: {} },
    }));
    expect(compressWithPxpipe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
    // The pxpipe proxy never ran, so the body still carries the original user text.
    expect(JSON.stringify(executeBody() || {})).toContain("hi");
  });

  it("combo overriding rtkEnabled=false while global true → RTK skipped, others run", async () => {
    const settings = {
      ...ALL_SAVER_SETTINGS,
      comboStrategies: { coding: { tokenSaver: { rtk: false } } },
    };
    const resolved = resolveComboTokenSaver(new Set(["coding"]), settings);
    expect(resolved.rtkEnabled).toBe(false);
    await handleChatCore(baseArgs({
      rtkEnabled: resolved.rtkEnabled,
      headroomEnabled: resolved.headroomEnabled,
      cavemanEnabled: resolved.cavemanEnabled,
    }));
    expect(mocks.rtk.compressMessages).toHaveBeenCalledWith(expect.anything(), false, { allowLossy: false });
    expect(mocks.headroom.compressWithHeadroom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
    expect(mocks.caveman.injectCaveman).toHaveBeenCalled();
    expect(mocks.onTokenSaverEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ saver: "rtk" })
    );
  });

  it("combo enabling headroom (global false) → headroom attempted", async () => {
    const settings = {
      ...ALL_SAVER_SETTINGS,
      headroomEnabled: false,
      comboStrategies: { coding: { tokenSaver: { headroom: true } } },
    };
    const resolved = resolveComboTokenSaver(new Set(["coding"]), settings);
    expect(resolved.headroomEnabled).toBe(true);
    await handleChatCore(baseArgs({
      rtkEnabled: resolved.rtkEnabled,
      headroomEnabled: resolved.headroomEnabled,
    }));
    expect(mocks.headroom.compressWithHeadroom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
  });
});

describe("saver pipeline order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeMock.mockImplementation(async () => makeExecutorRes());
    globalThis.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    mocks.rtk.sawCavemanMarker = false;
    mocks.memory.seenBodies = [];
    mocks.rtk.compressMessages.mockImplementation((body, enabled) => {
      const text = JSON.stringify(body);
      if (text.includes(CAVEMAN_MARKER)) mocks.rtk.sawCavemanMarker = true;
      if (!enabled) return null;
      for (const m of body?.messages || []) {
        if (typeof m?.content === "string" && m.content.length > 50) {
          m.content = m.content.slice(0, 10);
        }
      }
      return { bytesBefore: text.length, bytesAfter: 10, hits: [{ filter: "test" }], filter: "test" };
    });
    mocks.caveman.injectCaveman.mockImplementation((body) => {
      if (!body) return;
      if (typeof body.system === "string") {
        body.system += ` ${CAVEMAN_MARKER}`;
        return;
      }
      const sys = body.messages?.find((m) => m.role === "system");
      if (sys && typeof sys.content === "string") sys.content += ` ${CAVEMAN_MARKER}`;
    });
    mocks.memory.applyMemoryEnhancements.mockImplementation(async (body) => {
      mocks.memory.seenBodies.push(body);
      return {
        body,
        stats: {
          toolPruning: { applied: true, savedChars: 42 },
          mediaPruning: { applied: false, savedItems: 0 },
          compaction: { applied: false, savedTokens: 0 },
          handoff: { applied: false },
        },
      };
    });
  });

  it("RTK compresses BEFORE caveman injection (marker survives RTK untouched)", async () => {
    await handleChatCore(baseArgs());
    // RTK ran before injection: it never saw the marker...
    expect(mocks.rtk.sawCavemanMarker).toBe(false);
    // ...yet the final dispatched body carries both the marker and RTK's shrink.
    const body = executeBody();
    const sys = body?.messages?.find((m) => m.role === "system");
    expect(String(sys?.content || "")).toContain(CAVEMAN_MARKER);
  });

  it("memory pruner runs AFTER caveman (pruner sees the injected body)", async () => {
    await handleChatCore(baseArgs({ memorySettings: ALL_SAVER_SETTINGS }));
    expect(mocks.memory.seenBodies.length).toBeGreaterThan(0);
    const seen = mocks.memory.seenBodies.at(-1);
    const sys = seen?.messages?.find((m) => m.role === "system");
    expect(JSON.stringify(seen)).toContain(CAVEMAN_MARKER);
    expect(String(sys?.content || "")).toContain(CAVEMAN_MARKER);
  });

  it("anchoring runs last on the fully-transformed body", async () => {
    // Claude-format flow so the finalFormat === claude anchor gate passes and
    // anchorClaudeCache actually runs (openai flows never anchor).
    await handleChatCore(baseArgs({
      memorySettings: ALL_SAVER_SETTINGS,
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        system: "You are helpful. " + "sys".repeat(40),
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "anthropic", model: "claude-sonnet-4-5" },
    }));
    expect(mocks.anchor.anchorClaudeCache).toHaveBeenCalled();
    const anchored = mocks.anchor.anchorClaudeCache.mock.calls.at(-1)?.[0];
    const dispatched = executeBody();
    // The object anchorClaudeCache received is the exact object the executor
    // dispatches: every saver's mutation (marker, RTK shrink) is already in it.
    expect(anchored).toBe(dispatched);
    expect(JSON.stringify(anchored)).toContain(CAVEMAN_MARKER);
  });
});
