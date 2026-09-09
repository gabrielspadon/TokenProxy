import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pipeline wiring for the prefix token-saver stages through chatCore
// (#token-savers): thinking strip, query-aware compression, pair dropping,
// embedding reorder, and the mid-prefix note. Each stage is default-off,
// Claude-target only, gated on tokenSaverEnabled like the other savers, and
// lands between the schema-distill stage and the privacy stage (midinject
// after the mem stage, before the cache-keep anchor).

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
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("../../open-sse/rtk/index.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: vi.fn((body, enabled) => {
      if (!enabled) return null;
      return { hits: [], bytesBefore: 0, bytesAfter: 0 };
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

// The mem stage is irrelevant to every case here; keep it a passthrough so a
// memorySettings bag (needed for the pairs deficit override) never reshapes
// the body. chatCore reads measureContextPressure from contextBudget directly,
// so the pairs stage still sees the real deficit.
vi.mock("../../open-sse/services/memory/index.js", () => ({
  applyMemoryEnhancements: vi.fn(async (body) => ({ body, stats: {} })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DEFAULT_THINKING_CLAUDE_SIGNATURE } = await import(
  "../../open-sse/config/defaultThinkingSignature.js"
);

// Translation drops thinking blocks whose signature is not Claude's
// (translator/formats/claude.js), so fixture thinking blocks carry the
// default signature a real client would send.
const signedThinking = (text) => ({
  type: "thinking",
  thinking: text,
  signature: DEFAULT_THINKING_CLAUDE_SIGNATURE,
});

// String content or concatenated text blocks: translation normalizes string
// content into block arrays on the claude route.
function textOf(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
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

function openaiExecutorRes() {
  return {
    response: new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion",
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

function claudeBody(messages) {
  return {
    model: "anthropic/claude-3-5-sonnet-20241022",
    max_tokens: 64,
    stream: false,
    messages,
  };
}

let consoleLines;
let consoleSpy;

beforeEach(() => {
  mocks.executeMock.mockReset();
  mocks.dispatched = null;
  mocks.executeMock.mockImplementation(async () => anthropicExecutorRes());
  globalThis.fetch = vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
  consoleLines = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    consoleLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

async function drive(overrides = {}) {
  const result = await handleChatCore({
    body: claudeBody([{ role: "user", content: "hello there" }]),
    modelInfo: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "TAG", nextTag: () => "TAG", fmtThink: () => null },
    connectionId: "pf-conn",
    rtkEnabled: false,
    schemaDistillEnabled: false,
    thinkingStripEnabled: false,
    queryAwareCompressionEnabled: false,
    pairDropEnabled: false,
    embedReorderEnabled: false,
    embedReorderUrl: "http://127.0.0.1:11434/v1/embeddings",
    embedReorderModel: "nomic-embed-text",
    midPrefixInjectEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    memorySettings: null,
    clientRawRequest: { headers: {}, body: {} },
    requestId: "pf000001",
    ...overrides,
  });
  await result.response.text();
  return result;
}

function reqLines() {
  return consoleLines.filter((l) => l.includes(" REQ."));
}

function dispatchedBody() {
  return JSON.parse(mocks.dispatched);
}

function saveRows() {
  const reqs = reqLines();
  expect(reqs).toHaveLength(1);
  const m = reqs[0].match(/ save=([^\s]+)/);
  return m ? m[1].split(",") : [];
}

describe("thinking strip stage (chatCore pipeline)", () => {
  const thinkingMessages = [
    { role: "user", content: "first question about the parser" },
    {
      role: "assistant",
      content: [
        signedThinking("historical reasoning one"),
        { type: "text", text: "answer one" },
      ],
    },
    { role: "user", content: "second question about the parser" },
    {
      role: "assistant",
      content: [
        signedThinking("live reasoning chain"),
        { type: "text", text: "answer two" },
      ],
    },
  ];

  it("flag on, Anthropic-native upstream: nothing stripped (the provider does not bill historical thinking)", async () => {
    const result = await drive({
      body: claudeBody(thinkingMessages),
      thinkingStripEnabled: true,
      requestId: "a1000021",
    });
    expect(result.success).toBe(true);
    const blocks = dispatchedBody().messages.filter((m) => m.role === "assistant")
      .flatMap((m) => m.content).filter((b) => b.type === "thinking");
    expect(blocks).toHaveLength(2);
    expect(reqLines()[0]).not.toContain("XFORM.thinking-stripped");
  });

  it("flag on: historical thinking blocks stripped, live turn keeps its chain", async () => {
    const onTokenSaverEvent = vi.fn();
    const result = await drive({
      body: claudeBody(thinkingMessages),
      thinkingStripEnabled: true,
      // A Claude-compatible third-party upstream bills what it receives.
      modelInfo: { provider: "anthropic-compatible-audit", model: "claude-3-5-sonnet-20241022" },
      requestId: "a1000001",
      onTokenSaverEvent,
    });
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    const assistants = dispatched.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    // First (historical) assistant turn: reasoning gone, text survived.
    expect(
      assistants[0].content.some((b) => b.type === "thinking" || b.type === "redacted_thinking"),
    ).toBe(false);
    expect(assistants[0].content.some((b) => b.type === "text" && b.text === "answer one")).toBe(true);
    // Last assistant turn keeps its live reasoning chain.
    expect(assistants[1].content.some((b) => b.type === "thinking")).toBe(true);

    // Ledger attributes the shrink to the thinking stage; path carries the code.
    const row = saveRows().find((kv) => kv.startsWith("thinking:"));
    expect(row).toBeDefined();
    expect(Number(row.split(":")[1])).toBeLessThan(0);
    expect(reqLines()[0]).toContain("XFORM.thinking-stripped");

    // Event row with rid, and the growth anomaly stays silent.
    const eventRow = onTokenSaverEvent.mock.calls.find((c) => c[0]?.saver === "thinking")?.[0];
    expect(eventRow).toBeDefined();
    expect(eventRow.applied).toBe(true);
    expect(eventRow.rid).toBe("a1000001");
    expect(eventRow.bytesSaved).toBeLessThan(0);
    expect(consoleLines.join("\n")).not.toContain("XFORM.saver-guard");
  });
});

describe("query-aware compression stage (chatCore pipeline)", () => {
  const qacMessages = [
    {
      role: "user",
      content:
        "banana logistics harvest planning notes for the cooperative warehouse spreadsheet review "
          .repeat(6),
    },
    { role: "assistant", content: "banana harvest notes summarized for the warehouse" },
    {
      role: "user",
      content: "how do I configure the retry backoff for the api client when the gateway times out",
    },
  ];

  it("flag on: low-relevance historical turn collapses to a placeholder", async () => {
    const onTokenSaverEvent = vi.fn();
    const result = await drive({
      body: claudeBody(qacMessages),
      queryAwareCompressionEnabled: true,
      // Fresh scoring is a pressure rung: a request inside its window keeps
      // its history verbatim (the prefix stays cacheable). With the memory
      // ladder off, qac is the ladder and may decide on any over-budget turn.
      memorySettings: { memoryContextWindowOverride: 100, memoryToolPruningEnabled: false, memoryMediaPruningEnabled: false },
      requestId: "a1000002",
      onTokenSaverEvent,
    });
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    const flat = JSON.stringify(dispatched.messages);
    expect(flat).toContain("compressed, low relevance to the current query");
    expect(flat).not.toContain("cooperative warehouse spreadsheet review");

    const row = saveRows().find((kv) => kv.startsWith("qac:"));
    expect(row).toBeDefined();
    expect(Number(row.split(":")[1])).toBeLessThan(0);
    expect(reqLines()[0]).toContain("XFORM.qac-applied");

    // The event row names WHICH turns were compressed, bounded integers.
    const eventRow = onTokenSaverEvent.mock.calls.find((c) => c[0]?.saver === "qac")?.[0];
    expect(eventRow).toBeDefined();
    // (the assistant turn scores just above the 0.04 default and survives)
    expect(eventRow.turns).toEqual([0]);
  });

  it("flag on, inside the window: history is left verbatim (prefix stays cacheable)", async () => {
    const result = await drive({
      body: claudeBody(qacMessages),
      queryAwareCompressionEnabled: true,
      requestId: "a1000012",
    });
    expect(result.success).toBe(true);
    const flat = JSON.stringify(dispatchedBody().messages);
    expect(flat).not.toContain("compressed, low relevance to the current query");
    expect(flat).toContain("cooperative warehouse spreadsheet review");
    expect(reqLines()[0]).not.toContain("XFORM.qac-applied");
  });

  it("memo replay: a tool_result turn (no query) reproduces the previous turn's compression", async () => {
    const sid = "ab12cd34";
    const first = await drive({
      body: claudeBody(qacMessages),
      queryAwareCompressionEnabled: true,
      memorySettings: { memoryContextWindowOverride: 100, memoryToolPruningEnabled: false, memoryMediaPruningEnabled: false },
      requestId: "a1000013",
      sid,
    });
    expect(first.success).toBe(true);
    const firstFlat = JSON.stringify(dispatchedBody().messages[0]);
    expect(firstFlat).toContain("compressed, low relevance to the current query");

    // Next request of the same session: the live turn is a tool_result, so
    // there is no query to score against and the request is back inside its
    // window. The block compressed on the previous turn must still be a
    // placeholder, byte for byte, or the cached prefix is rewritten.
    const second = await drive({
      body: claudeBody([
        ...qacMessages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      ]),
      queryAwareCompressionEnabled: true,
      requestId: "a1000014",
      sid,
    });
    expect(second.success).toBe(true);
    expect(JSON.stringify(dispatchedBody().messages[0])).toBe(firstFlat);
  });
});
describe("pair dropping stage (chatCore pipeline)", () => {
  // Five text-only pairs, each long enough that the request overruns a tiny
  // overridden window. First user message is protected by the dropper; the
  // oldest DROPPABLE pair is entries 2-3.
  function pairsMessages() {
    const msgs = [];
    const topics = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (const t of topics) {
      msgs.push({
        role: "user",
        content: `question about ${t} ` + `${t} context padding`.repeat(40),
      });
      msgs.push({
        role: "assistant",
        content: `answer about ${t} ` + `${t} response padding`.repeat(40),
      });
    }
    // Trailing user message keeps the translator from appending its
    // continuation turn, so the array shape stays predictable.
    msgs.push({ role: "user", content: "final question about echo routing" });
    return msgs;
  }

  it("flag on under a deficit: oldest droppable pair is gone", async () => {
    const result = await drive({
      body: claudeBody(pairsMessages()),
      pairDropEnabled: true,
      memorySettings: { memoryContextWindowOverride: 500, memoryToolPruningEnabled: false, memoryMediaPruningEnabled: false },
      requestId: "a1000003",
    });
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    const flat = JSON.stringify(dispatched.messages);
    // Protected task statement stays; the two oldest droppable pairs went
    // under the deficit (the first user message is never dropped).
    expect(flat).toContain("question about alpha");
    expect(flat).not.toContain("question about bravo");
    expect(flat).not.toContain("question about charlie");
    expect(flat).toContain("question about delta");
    expect(flat).toContain("question about echo");

    const row = saveRows().find((kv) => kv.startsWith("pairs:"));
    expect(row).toBeDefined();
    expect(Number(row.split(":")[1])).toBeLessThan(0);
    expect(reqLines()[0]).toContain("XFORM.pairs-dropped");
  });

  it("flag on with no deficit: prefix untouched", async () => {
    await drive({
      body: claudeBody(pairsMessages()),
      pairDropEnabled: true,
      requestId: "a1000004",
    });
    const dispatched = dispatchedBody();
    expect(dispatched.messages).toHaveLength(11);
    expect(JSON.stringify(dispatched.messages)).toContain("question about bravo");
    expect(reqLines()[0]).not.toContain("XFORM.pairs-dropped");
    expect(saveRows().find((kv) => kv.startsWith("pairs:"))).toBeUndefined();
  });
});

describe("embedding reorder stage (chatCore pipeline)", () => {
  function reorderMessages() {
    return [
      {
        role: "user",
        content: "setup notes about postgres index tuning for the api service layer",
      },
      { role: "assistant", content: "postgres index tuning notes for the service layer" },
      {
        role: "user",
        content: "unrelated banana bread recipe with walnuts and dark chocolate chunks",
      },
      { role: "assistant", content: "banana bread answer with walnuts and chocolate" },
      {
        role: "user",
        content: "now how do I tune the postgres index for the api gateway under load",
      },
    ];
  }

  function stubEmbeddings() {
    globalThis.fetch = vi.fn(async (_url, opts) => {
      const { input } = JSON.parse(opts.body);
      const vecFor = (t) => (String(t).includes("postgres") ? [1, 0] : [0, 1]);
      return new Response(
        JSON.stringify({
          data: input.map((t, i) => ({ index: i, embedding: vecFor(t) })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  }

  it("flag on with embeddings answering: relevant turn moves next to the tail", async () => {
    stubEmbeddings();
    const result = await drive({
      body: claudeBody(reorderMessages()),
      embedReorderEnabled: true,
      requestId: "a1000005",
    });
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    const lastUser = dispatched.messages.filter((m) => m.role === "user").at(-1);
    expect(textOf(lastUser)).toContain("postgres index for the api gateway");
    const pgIdx = dispatched.messages.findIndex(
      (m) => m.role === "user" && textOf(m).includes("setup notes about postgres"),
    );
    const bananaIdx = dispatched.messages.findIndex(
      (m) => m.role === "user" && textOf(m).includes("banana bread"),
    );
    expect(pgIdx).toBeGreaterThan(bananaIdx);

    // Reorder is byte-neutral (same messages, new order), so the ledger has
    // no "reorder" row; the path code is the observable.
    expect(reqLines()[0]).toContain("XFORM.reorder-applied");
  });

  it("embed endpoint 500: stage silent, request still succeeds", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("boom", { status: 500 }),
    );
    const result = await drive({
      body: claudeBody(reorderMessages()),
      embedReorderEnabled: true,
      // A distinct model defeats the util's module-level embedding cache,
      // which the success test above just primed with these exact texts.
      embedReorderModel: "nomic-embed-text-unreachable",
      requestId: "a1000006",
    });
    expect(result.success).toBe(true);
    const dispatched = dispatchedBody();
    expect(dispatched.messages).toHaveLength(5);
    expect(reqLines()[0]).not.toContain("XFORM.reorder-applied");
    expect(saveRows().find((kv) => kv.startsWith("reorder:"))).toBeUndefined();
    // The failure used to be DEBUG-gated and invisible in production: it now
    // speaks as a folded XFORM row carrying the rid.
    expect(consoleLines.join("\n")).toContain("XFORM.reorder-degraded");
    expect(consoleLines.join("\n")).toContain("rid=a1000006");
  });
});

describe("mid-prefix note stage (chatCore pipeline)", () => {
  it("flag on with qac on: boundary note injected, guard stays silent", async () => {
    const result = await drive({
      body: claudeBody([
        {
          role: "user",
          content:
            "banana logistics harvest planning notes for the cooperative warehouse spreadsheet review "
              .repeat(6),
        },
        { role: "assistant", content: "banana harvest notes summarized for the warehouse" },
        {
          role: "user",
          content: "how do I configure the retry backoff for the api client when the gateway times out",
        },
      ]),
      queryAwareCompressionEnabled: true,
      midPrefixInjectEnabled: true,
      memorySettings: { memoryContextWindowOverride: 100, memoryToolPruningEnabled: false, memoryMediaPruningEnabled: false },
      requestId: "a1000007",
    });
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    expect(JSON.stringify(dispatched.messages)).toContain("[tokenproxy context note]");
    expect(JSON.stringify(dispatched.messages)).toContain("qac: compressed 1 low-relevance turn(s)");

    // midinject is intentionally additive: the ledger records growth and the
    // saver-guard must NOT fire on it.
    const row = saveRows().find((kv) => kv.startsWith("midinject:"));
    expect(row).toBeDefined();
    expect(Number(row.split(":")[1])).toBeGreaterThan(0);
    expect(reqLines()[0]).toContain("XFORM.midinject-applied");
    expect(consoleLines.join("\n")).not.toContain("XFORM.saver-guard");
  });

  it("flag on with no earlier prefix stage: nothing to summarize, note absent", async () => {
    await drive({
      midPrefixInjectEnabled: true,
      requestId: "a1000008",
    });
    expect(JSON.stringify(dispatchedBody().messages)).not.toContain("[tokenproxy context note]");
    expect(reqLines()[0]).not.toContain("XFORM.midinject-applied");
  });
});

describe("prefix stages and the target format", () => {
  const thinkingMessages = [
    { role: "user", content: "first question about the parser" },
    {
      role: "assistant",
      content: [
        signedThinking("historical reasoning one"),
        { type: "text", text: "answer one" },
      ],
    },
    { role: "user", content: "second question about the parser" },
    {
      role: "assistant",
      content: [
        signedThinking("live reasoning chain"),
        { type: "text", text: "answer two" },
      ],
    },
  ];

  it("openai target: every prefix stage stays off the wire and the ledger", async () => {
    mocks.executeMock.mockImplementation(async () => openaiExecutorRes());
    const result = await handleChatCore({
      body: {
        model: "openai/gpt-4o",
        stream: false,
        messages: thinkingMessages,
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "sk-test" },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "TAG", nextTag: () => "TAG", fmtThink: () => null },
      connectionId: "pf-conn",
      rtkEnabled: false,
      schemaDistillEnabled: false,
      thinkingStripEnabled: true,
      queryAwareCompressionEnabled: true,
      pairDropEnabled: true,
      embedReorderEnabled: true,
      midPrefixInjectEnabled: true,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: false,
      memorySettings: null,
      clientRawRequest: { headers: {}, body: {} },
      requestId: "a1000009",
    });
    await result.response.text();
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    // The four original turns survive; no prefix stage ran on this target.
    expect(dispatched.messages).toHaveLength(4);
    expect(JSON.stringify(dispatched.messages)).not.toContain(
      "[tokenproxy: prior reasoning stripped",
    );
    expect(reqLines()[0]).not.toMatch(/ save=/);
    expect(reqLines()[0]).not.toContain("XFORM.thinking-stripped");
    expect(reqLines()[0]).not.toContain("XFORM.qac-applied");
  });
});

describe("all prefix flags off", () => {
  it("save= is absent entirely and the ledger is silent", async () => {
    const result = await drive({ requestId: "a1000010" });
    expect(result.success).toBe(true);
    expect(reqLines()).toHaveLength(1);
    expect(reqLines()[0]).not.toMatch(/ save=/);
    expect(result.response.headers.get("x-tp-save-bytes")).toBeNull();
  });
});

describe("tools normalization stage (audit finding 7)", () => {
  const CLAUDE_HEADERS = { "user-agent": "claude-cli/1.0.0 (external, cli)" };

  function toolsBody() {
    return {
      ...claudeBody([{ role: "user", content: "hello there" }]),
      tools: [
        { name: "mcp__exa__web_search_exa", description: "exa search" },
        { name: "WebSearch", description: "built-in search" },
        { name: "WebFetch", description: "built-in fetch" },
        { name: "read_file", description: "read a file" },
      ],
    };
  }

  it("duplicate built-ins stripped by dedupe: save= carries a tools stage, path carries tool-strip, event row lands", async () => {
    const onTokenSaverEvent = vi.fn();
    const result = await drive({
      body: toolsBody(),
      clientRawRequest: { headers: CLAUDE_HEADERS, body: {} },
      requestId: "a1000011",
      onTokenSaverEvent,
    });
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    const names = dispatched.tools.map((t) => t.name);
    expect(names).not.toContain("WebSearch");
    expect(names).not.toContain("WebFetch");
    expect(names).toContain("mcp__exa__web_search_exa");

    const row = saveRows().find((kv) => kv.startsWith("tools:"));
    expect(row).toBeDefined();
    expect(Number(row.split(":")[1])).toBeLessThan(0);
    expect(reqLines()[0]).toContain("XFORM.tool-strip");

    const eventRow = onTokenSaverEvent.mock.calls.find((c) => c[0]?.saver === "tools")?.[0];
    expect(eventRow).toBeDefined();
    expect(eventRow.rid).toBe("a1000011");
    expect(eventRow.bytesSaved).toBeLessThan(0);
  });

  it("no duplicates: no tools stage entry and no tool-strip code", async () => {
    const body = toolsBody();
    body.tools = body.tools.filter((t) => !["WebSearch", "WebFetch"].includes(t.name));
    await drive({
      body,
      clientRawRequest: { headers: CLAUDE_HEADERS, body: {} },
      requestId: "a1000012",
    });
    expect(saveRows().find((kv) => kv.startsWith("tools:"))).toBeUndefined();
    expect(reqLines()[0]).not.toContain("XFORM.tool-strip");
  });
});

describe("mid-prefix note placement after pairs (audit finding 6)", () => {
  // qac compresses historical turns (recording their indices), then pairs
  // DELETES a pair and shifts the array: the recorded indices used to point
  // at whatever slid into those slots, landing the note on a live recent
  // turn. After the fix the stale indices are cleared and the last-user
  // fallback applies.
  function qacPairsMessages() {
    const msgs = [];
    const topics = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (const t of topics) {
      msgs.push({
        role: "user",
        content: `question about ${t} ` + `${t} context padding`.repeat(40),
      });
      msgs.push({
        role: "assistant",
        content: `answer about ${t} ` + `${t} response padding`.repeat(40),
      });
    }
    msgs.push({
      role: "user",
      content:
        "how do I configure the retry backoff for the api client when the gateway times out",
    });
    return msgs;
  }

  it("qac+pairs+midinject: the note lands on a real user turn at or before the live boundary, never on a compressed placeholder", async () => {
    const result = await drive({
      body: claudeBody(qacPairsMessages()),
      queryAwareCompressionEnabled: true,
      pairDropEnabled: true,
      midPrefixInjectEnabled: true,
      memorySettings: { memoryContextWindowOverride: 100, memoryToolPruningEnabled: false, memoryMediaPruningEnabled: false },
      requestId: "a1000013",
    });
    expect(result.success).toBe(true);

    const dispatched = dispatchedBody();
    const flat = JSON.stringify(dispatched.messages);
    expect(flat).toContain("[tokenproxy context note]");
    expect(flat).toContain("qac: compressed");
    expect(flat).toContain("pairs: dropped");

    // Locate the note block and its message.
    let noteMsgIdx = -1;
    for (let i = 0; i < dispatched.messages.length; i++) {
      const m = dispatched.messages[i];
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (blocks.some((b) => b?.type === "text" && b.text.includes("[tokenproxy context note]"))) {
        noteMsgIdx = i;
      }
    }
    expect(noteMsgIdx).toBeGreaterThanOrEqual(0);

    // The note rides a USER message...
    expect(dispatched.messages[noteMsgIdx].role).toBe("user");
    // ...that is not a compressed placeholder turn...
    expect(JSON.stringify(dispatched.messages[noteMsgIdx].content)).not.toContain(
      "compressed, low relevance",
    );
    // ...and nothing AFTER the last user message carries the note (the note
    // never lands past the live boundary into turns that follow it).
    const lastUserIdx = dispatched.messages.reduce(
      (acc, m, i) => (m.role === "user" ? i : acc),
      -1,
    );
    expect(noteMsgIdx).toBeLessThanOrEqual(lastUserIdx);
  });
});
