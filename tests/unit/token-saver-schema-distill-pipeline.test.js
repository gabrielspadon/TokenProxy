import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pipeline wiring for the schema-distillation token-saver through chatCore:
// flag off → the stage never runs and no "schema" row exists in the save=
// ledger; flag on with a tools array past the 8KB floor → the dispatched body
// carries distilled schemas, the ledger attributes the delta to the "schema"
// stage, the saver-guard stays silent (a distiller only shrinks), and the
// sid-keyed context_status snapshot lands in the store.

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  dispatched: null,
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
      for (const m of body.messages || []) {
        if (m?.role === "tool" && typeof m.content === "string" && m.content.length > 500) {
          m.content = "x".repeat(100);
        }
      }
      return { hits: [{ filter: "fat" }], bytesBefore: 900, bytesAfter: 100 };
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

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { readContextStatus } = await import(
  "../../open-sse/handlers/chatCore/contextStatusStore.js"
);

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

function fatToolsBody() {
  return {
    model: "anthropic/claude-3-5-sonnet-20241022",
    max_tokens: 64,
    stream: false,
    messages: [{ role: "user", content: "inspect this" }],
    tools: [
      {
        name: "read_file",
        description: "Reads a file  from disk",
        input_schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          title: "ReadFileArgs",
          properties: {
            path: {
              type: "string",
              description: "The file   path\n\nto read",
              title: "PathArg",
              default: "x".repeat(9000),
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
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
    body: fatToolsBody(),
    modelInfo: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "TAG", nextTag: () => "TAG", fmtThink: () => null },
    connectionId: "sd-conn",
    rtkEnabled: false,
    schemaDistillEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    memorySettings: null,
    clientRawRequest: { headers: {}, body: {} },
    requestId: "sd000001",
    ...overrides,
  });
  await result.response.text();
  return result;
}

function reqLines() {
  return consoleLines.filter((l) => l.includes(" REQ."));
}

describe("schema distillation saver stage (chatCore pipeline)", () => {
  it("flag on: dispatched tools are distilled, ledger records the schema stage", async () => {
    const result = await drive({ schemaDistillEnabled: true, requestId: "sd000101" });
    expect(result.success).toBe(true);

    const dispatched = JSON.parse(mocks.dispatched);
    expect(dispatched.tools[0].name).toBe("read_file");
    expect(dispatched.tools[0].description).toBe("Reads a file  from disk");
    expect(JSON.stringify(dispatched.tools[0].input_schema)).not.toContain('"default"');
    expect(JSON.stringify(dispatched.tools[0].input_schema)).not.toContain('"title"');
    expect(JSON.stringify(dispatched.tools[0].input_schema)).not.toContain('"$schema"');
    expect(dispatched.tools[0].input_schema.properties.path.description).toBe(
      "The file path to read",
    );
    expect(dispatched.tools[0].input_schema.required).toEqual(["path"]);
    expect(dispatched.tools[0].input_schema.additionalProperties).toBe(false);

    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    const saveMatch = reqs[0].match(/ save=([^\s]+)/);
    expect(saveMatch).not.toBeNull();
    const schemaRow = saveMatch[1].split(",").find((kv) => kv.startsWith("schema:"));
    expect(schemaRow).toBeDefined();
    expect(Number(schemaRow.split(":")[1])).toBeLessThan(0);
    expect(Number(schemaRow.split(":")[1])).toBeGreaterThan(-9300); // 9000-byte default + title + whitespace

    const sum = saveMatch[1]
      .split(",")
      .reduce((a, kv) => a + Number(kv.split(":")[1]), 0);
    expect(result.response.headers.get("x-tp-save-bytes")).toBe(String(sum));

    // a distiller only shrinks: the growth anomaly must stay silent
    expect(consoleLines.join("\n")).not.toContain("XFORM.saver-guard");
  });

  it("flag off: schemas dispatch verbatim and the ledger has no schema stage", async () => {
    const result = await drive({ schemaDistillEnabled: false, requestId: "sd000102" });
    expect(result.success).toBe(true);
    const dispatched = JSON.parse(mocks.dispatched);
    expect(dispatched.tools[0].input_schema.properties.path.default).toHaveLength(9000);
    expect(dispatched.tools[0].input_schema.$schema).toBeTruthy();
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toMatch(/ save=/);
    expect(result.response.headers.get("x-tp-save-bytes")).toBeNull();
  });

  it("token-saver header off suppresses the stage even when the flag is on", async () => {
    await drive({
      schemaDistillEnabled: true,
      requestId: "sd000103",
      clientRawRequest: { headers: { "x-tokenproxy-token-saver": "off" }, body: {} },
    });
    const dispatched = JSON.parse(mocks.dispatched);
    expect(dispatched.tools[0].input_schema.properties.path.default).toHaveLength(9000);
  });

  it("sid-keyed context_status snapshot is written with the final telemetry", async () => {
    const result = await drive({ schemaDistillEnabled: true, sid: "0badf00d", requestId: "0d000104" });
    expect(result.success).toBe(true);
    const entry = await readContextStatus("0badf00d");
    expect(entry).not.toBeNull();
    expect(entry.rid).toBe("0d000104");
    expect(entry.ctxTokens).toBe(
      Number(result.response.headers.get("x-tp-ctx-tokens")),
    );
    expect(entry.saveBytes).toBe(
      Number(result.response.headers.get("x-tp-save-bytes")),
    );
    expect(typeof entry.updatedAt).toBe("string");
  });
  it("emits a schema token-saver event row with signed bytesSaved", async () => {
    const onTokenSaverEvent = vi.fn();
    await drive({ schemaDistillEnabled: true, requestId: "sd000105", onTokenSaverEvent });
    const schemaRow = onTokenSaverEvent.mock.calls.find(
      (c) => c[0]?.saver === "schema",
    )?.[0];
    expect(schemaRow).toBeDefined();
    expect(schemaRow.applied).toBe(true);
    expect(schemaRow.bytesSaved).toBeLessThan(0);
    expect(schemaRow.saveTokEst).toBe(Math.round(schemaRow.bytesSaved / 4));
  });
});
