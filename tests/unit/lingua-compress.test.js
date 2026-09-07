// LLMLingua-2 selective compression (task 4): open-sse/utils/linguaCompress.js
// module contract plus the chatCore wiring gate and the reference sidecar
// contract (scripts/lingua-sidecar.mjs). Module tests drive a mock sidecar
// over a real loopback http server created inside this file (never an
// external host) and cover the content classifier, threshold gating, epoch
// boundaries, inert-without-endpoint, backend failure, and the loopback-only
// endpoint gate. Wiring tests drive handleChatCore with a mocked executor
// (no network beyond the loopback stub) and assert default-off behavior, the
// applied path, and truthful telemetry rows.
import http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyEndpoint,
  compressBlobs,
  looksLikeCodeOrData,
  resolveLinguaEndpoint,
} from "open-sse/utils/linguaCompress.js";
import { appendTokenSaverEvent, __setTokenSaverEventsDirForTest } from "@/lib/tokenSaver/events.js";
import { createLinguaSidecar } from "../../scripts/lingua-sidecar.mjs";

// Natural-language fixture: no code keywords, no fences, no JSON shape.
const NL_SENTENCE =
  "the quick brown fox jumps over the lazy dog and wanders through the quiet forest all day ";
function nlChars(n) {
  let out = "";
  while (out.length < n) out += NL_SENTENCE;
  return out.slice(0, n);
}

// Loopback-only mock sidecar: records every POST and answers per handler.
async function startSidecarStub({ status = 200, handler } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* shape assertions read it back as null */
      }
      seen.push({ url: req.url, body: parsed });
      const payload = handler ? handler(parsed) : { text: "compressed summary" };
      const body = JSON.stringify(payload ?? { text: "compressed summary" });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// A user message with one large natural-language text block at index 2,
// followed by a long tail so the message sits well below the epoch cut.
function agedMessages(block, { extra = {} } = {}) {
  const messages = [
    { role: "user", content: "head" },
    { role: "assistant", content: "a0" },
    { role: "user", content: [{ type: "text", text: block, ...extra }] },
  ];
  for (let k = 0; k < 9; k++) {
    messages.push({ role: "user", content: [{ type: "text", text: `step ${k}` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `ok ${k}` }] });
  }
  return messages;
}

// ---- module: gates ----------------------------------------------------------

describe("compressBlobs", () => {
  beforeEach(() => {
    delete process.env.TOKENPROXY_LINGUA_ENDPOINT;
  });

  it("skips with applied:false when the epoch cut is 0", async () => {
    const messages = agedMessages(nlChars(6000));
    const res = await compressBlobs({ messages }, { epochCutIndex: 0, endpoint: "http://127.0.0.1:1" });
    expect(res.applied).toBe(false);
    expect(res.skip).toBe("epoch_boundary");
    expect(res.messages).toBe(messages);
  });

  it("is inert without an endpoint: no_backend, body reference unchanged", async () => {
    const messages = agedMessages(nlChars(6000));
    const res = await compressBlobs({ messages }, { epochCutIndex: 1, endpoint: "" });
    expect(res.applied).toBe(false);
    expect(res.skip).toBe("no_backend");
    expect(res.messages).toBe(messages);
    expect(resolveLinguaEndpoint()).toBe("");
  });

  it("refuses a remote-host endpoint without issuing any request", async () => {
    const messages = agedMessages(nlChars(6000));
    const fetchImpl = vi.fn();
    const res = await compressBlobs(
      { messages },
      { epochCutIndex: 1, endpoint: "https://prompts.exfil.example/compress", fetchImpl },
    );
    expect(res.applied).toBe(false);
    expect(res.skip).toBe("endpoint_refused");
    expect(res.messages).toBe(messages);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies endpoints: loopback ok, unix path ok, remote refused", () => {
    expect(classifyEndpoint("http://127.0.0.1:4891").kind).toBe("http");
    expect(classifyEndpoint("http://localhost:4891").kind).toBe("http");
    expect(classifyEndpoint("http://[::1]:4891").kind).toBe("http");
    expect(classifyEndpoint("/tmp/lingua.sock").kind).toBe("unix");
    expect(classifyEndpoint("http://10.0.0.5:4891").kind).toBe("refused");
    expect(classifyEndpoint("ftp://127.0.0.1/x").kind).toBe("refused");
  });

  it("compresses a natural-language blob at minChars", async () => {
    const stub = await startSidecarStub();
    try {
      const messages = agedMessages(nlChars(6000));
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(true);
      expect(res.compressedBlocks).toBe(1);
      expect(res.messages[2].content[0].text).toBe("compressed summary");
      expect(stub.seen).toHaveLength(1);
      expect(stub.seen[0].url).toBe("/compress");
      expect(typeof stub.seen[0].body.text).toBe("string");
      expect(stub.seen[0].body.ratio).toBeGreaterThan(0);
      expect(stub.seen[0].body.ratio).toBeLessThanOrEqual(0.5);
    } finally {
      await stub.close();
    }
  });

  it("skips a blob at minChars-1 and compresses at minChars", async () => {
    const stub = await startSidecarStub();
    try {
      const messages = agedMessages(nlChars(5999));
      messages[2].content[0].text = messages[2].content[0].text.slice(0, 5119);
      const skipped = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(skipped.applied).toBe(false);
      expect(skipped.messages).toBe(messages);
      expect(stub.seen).toHaveLength(0);

      messages[2].content[0].text = nlChars(5120);
      const hit = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(hit.applied).toBe(true);
      expect(hit.compressedBlocks).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it("derives ratio from blob size (<=0.5, targeting 4096 chars out)", async () => {
    const stub = await startSidecarStub();
    try {
      const messages = agedMessages(nlChars(6000));
      await compressBlobs({ messages }, { epochCutIndex: 1, endpoint: stub.url });
      // 4096/6000 ≈ 0.68 exceeds the 0.5 cap.
      expect(stub.seen[0].body.ratio).toBe(0.5);
      const bigger = agedMessages(nlChars(40000));
      await compressBlobs({ messages: bigger }, { epochCutIndex: 1, endpoint: stub.url });
      expect(stub.seen[1].body.ratio).toBeCloseTo(4096 / 40000, 5);
    } finally {
      await stub.close();
    }
  });

  it("skips code-keyword blobs, fenced blobs, and diff hunks", async () => {
    const stub = await startSidecarStub();
    try {
      const codeLines = Array.from({ length: 120 }, (_, k) => `const value${k} = compute(${k});`);
      const codeBlob = codeLines.join("\n");
      expect(looksLikeCodeOrData(codeBlob)).toBe(true);
      const fenced = "```js\n" + codeLines.join("\n") + "\n```";
      expect(looksLikeCodeOrData(fenced)).toBe(true);
      const diff = Array.from({ length: 120 }, (_, k) => `@@ -${k},3 +${k},4 @@ context line ${k}`).join("\n");
      expect(looksLikeCodeOrData(diff)).toBe(true);
      expect(looksLikeCodeOrData(nlChars(6000))).toBe(false);

      const messages = [
        { role: "user", content: "head" },
        { role: "assistant", content: "a0" },
        { role: "user", content: [{ type: "text", text: codeBlob }] },
        { role: "user", content: [{ type: "text", text: fenced }] },
        { role: "user", content: [{ type: "text", text: diff }] },
      ];
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(false);
      expect(res.messages).toBe(messages);
      expect(stub.seen).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("skips JSON blobs", async () => {
    const stub = await startSidecarStub();
    try {
      const jsonBlob = JSON.stringify({ rows: Array.from({ length: 300 }, (_, k) => ({ id: k, name: `row ${k}`, note: NL_SENTENCE })) });
      expect(looksLikeCodeOrData(jsonBlob)).toBe(true);
      const messages = agedMessages(jsonBlob);
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(false);
      expect(stub.seen).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("never touches messages at or before the epoch cut", async () => {
    const stub = await startSidecarStub();
    try {
      const headBlob = nlChars(6000);
      const tailBlob = nlChars(6000);
      const messages = [
        { role: "user", content: "head" },
        { role: "assistant", content: "a0" },
        { role: "user", content: [{ type: "text", text: headBlob }] }, // index 2, at/below cut 2
        { role: "assistant", content: "a1" },
        { role: "user", content: [{ type: "text", text: tailBlob }] }, // index 4, past the cut
      ];
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 2, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(true);
      expect(res.compressedBlocks).toBe(1);
      expect(res.messages[2]).toBe(messages[2]);
      expect(res.messages[4].content[0].text).toBe("compressed summary");
    } finally {
      await stub.close();
    }
  });

  it("leaves cache_control blocks untouched", async () => {
    const stub = await startSidecarStub();
    try {
      const messages = agedMessages(nlChars(6000), {
        extra: { cache_control: { type: "ephemeral" } },
      });
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(false);
      expect(res.messages).toBe(messages);
      expect(stub.seen).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("keeps pair structure intact while compressing a tool_result payload", async () => {
    const stub = await startSidecarStub();
    try {
      const messages = [
        { role: "user", content: "head" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_l", name: "bash", input: {} }] },
        {
          role: "user",
          content: [
            { type: "text", text: "run" },
            { type: "tool_result", tool_use_id: "toolu_l", content: nlChars(6000) },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ];
      const before = JSON.stringify(messages);
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(true);
      expect(res.messages).toHaveLength(messages.length);
      const toolUse = res.messages[1].content.find((b) => b.type === "tool_use");
      expect(toolUse.id).toBe("toolu_l");
      const toolResult = res.messages[2].content.find((b) => b.type === "tool_result");
      expect(toolResult.tool_use_id).toBe("toolu_l");
      expect(toolResult.content).toBe("compressed summary");
      expect(JSON.stringify(messages)).toBe(before);
    } finally {
      await stub.close();
    }
  });

  it("reports applied:false and leaves the body unchanged on a backend failure", async () => {
    const stub = await startSidecarStub({ status: 500 });
    try {
      const messages = agedMessages(nlChars(6000));
      const before = JSON.stringify(messages);
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(false);
      expect(res.skip).toBe("backend_error");
      expect(res.messages).toBe(messages);
      expect(JSON.stringify(messages)).toBe(before);
    } finally {
      await stub.close();
    }
  });

  it("reports applied:false on a schema mismatch and never partially mutates", async () => {
    const stub = await startSidecarStub({ handler: () => ({ notText: true }) });
    try {
      const messages = [
        { role: "user", content: "head" },
        { role: "assistant", content: "a0" },
        { role: "user", content: [{ type: "text", text: nlChars(6000) }] },
        { role: "user", content: [{ type: "text", text: nlChars(7000) }] },
      ];
      const before = JSON.stringify(messages);
      const res = await compressBlobs(
        { messages },
        { epochCutIndex: 1, endpoint: stub.url, minChars: 5120 },
      );
      expect(res.applied).toBe(false);
      expect(res.skip).toBe("backend_error");
      expect(JSON.stringify(messages)).toBe(before);
    } finally {
      await stub.close();
    }
  });
});

// ---- chatCore wiring ---------------------------------------------------------

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  dispatchedBodies: [],
}));

vi.mock("../../open-sse/utils/proxyFetch.js", async (orig) => ({
  ...(await orig()),
  proxyAwareFetch: vi.fn(async () => {
    throw new Error("no test in this file may reach an upstream");
  }),
  installGlobalProxyFetch: vi.fn(),
}));

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

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function executorResult() {
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
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    transformedBody: null,
  };
}

const MODEL = "claude-opus-5";
const PROVIDER = "anthropic";

function claudeBody(rest, { systemChars = 4000 } = {}) {
  return {
    model: `${PROVIDER}/${MODEL}`,
    stream: false,
    max_tokens: 100,
    system: "sys ".repeat(Math.ceil(systemChars / 4)),
    messages: [
      { role: "user", content: "head ".repeat(400) },
      ...rest,
    ],
  };
}

// Shared head (assistant + divergent user) then a large natural-language
// tool_result below the cut: the tool_use partner, the payload, and 9
// user/assistant rounds.
function linguaTail() {
  return [
    { role: "assistant", content: "shared asst " + "s".repeat(900) },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_l", name: "bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "text", text: "run" },
        { type: "tool_result", tool_use_id: "toolu_l", content: nlChars(6000) },
      ],
    },
    ...Array.from({ length: 9 }, (_, k) => ({
      role: "user",
      content: [{ type: "text", text: `step ${k}` }],
    })).flatMap((u, k) => [u, { role: "assistant", content: [{ type: "text", text: `ok ${k}` }] }]),
  ];
}

function baseArgs(overrides = {}) {
  return {
    body: claudeBody(linguaTail()),
    modelInfo: { provider: PROVIDER, model: MODEL },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      line: vi.fn(),
      tagForSession: () => "TAG",
      nextTag: () => "TAG",
      fmtThink: () => null,
    },
    connectionId: "conn-lingua-1",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    clientRawRequest: { headers: {}, body: {} },
    onTokenSaverEvent: appendTokenSaverEvent,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatchedBodies.length = 0;
  delete process.env.TOKENPROXY_LINGUA_ENDPOINT;
  mocks.executeMock.mockImplementation(async (args) => {
    mocks.dispatchedBodies.push(args?.body);
    return executorResult();
  });
});

describe("chatCore lingua wiring", () => {
  // Two-request dance per test: the first primes the session's epoch entry,
  // the second diverges after a shared head, giving a nonzero cut. The lingua
  // region (tool_result + tail) sits entirely below the cut.
  async function runSession({ firstBody, secondBody, overrides = {}, sid = "11ngu4s1d" }) {
    await handleChatCore(baseArgs({ body: firstBody, sid, ...overrides }));
    await handleChatCore(baseArgs({ body: secondBody, sid, ...overrides }));
    return mocks.dispatchedBodies.at(-1);
  }

  function history(divergentUser) {
    return claudeBody([
      { role: "assistant", content: "shared asst " + "s".repeat(900) },
      divergentUser,
      ...linguaTail().slice(1),
    ]);
  }

  const first = () => history({ role: "user", content: "filler " + "f".repeat(13000) });
  const second = () => history({ role: "user", content: "brand new " + "n".repeat(8000) });

  function findLinguaToolResult(dispatched) {
    for (const msg of dispatched.messages) {
      if (!Array.isArray(msg.content)) continue;
      const block = msg.content.find((b) => b?.type === "tool_result" && b.tool_use_id === "toolu_l");
      if (block) return block;
    }
    return null;
  }

  it("leaves tool_results untouched by default (flag off)", async () => {
    const stub = await startSidecarStub();
    try {
      process.env.TOKENPROXY_LINGUA_ENDPOINT = stub.url;
      const dispatched = await runSession({ firstBody: first(), secondBody: second() });
      const block = findLinguaToolResult(dispatched);
      expect(block).toBeTruthy();
      expect(block.content).toBe(nlChars(6000));
      expect(mocks.executeMock).toHaveBeenCalledTimes(2);
      expect(stub.seen).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("compresses a natural-language tool_result below the cut when lingua is on", async () => {
    const stub = await startSidecarStub();
    try {
      process.env.TOKENPROXY_LINGUA_ENDPOINT = stub.url;
      const dispatched = await runSession({
        firstBody: first(),
        secondBody: second(),
        overrides: { linguaEnabled: true },
      });
      // The epoch region (the shared head) is byte-identical to the first
      // request's dispatched messages.
      const firstDispatched = mocks.dispatchedBodies.at(-2);
      expect(JSON.stringify(dispatched.messages[0])).toBe(JSON.stringify(firstDispatched.messages[0]));
      expect(JSON.stringify(dispatched.messages[1])).toBe(JSON.stringify(firstDispatched.messages[1]));
      const block = findLinguaToolResult(dispatched);
      expect(block).toBeTruthy();
      expect(block.content).toBe("compressed summary");
      // Pair structure survives: the tool_use partner keeps its id.
      const toolUse = dispatched.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b?.type === "tool_use" && b.id === "toolu_l");
      expect(toolUse).toBeTruthy();
      // Two backend calls: the live divergent user message is itself a large
      // natural-language blob and is a legitimate candidate alongside the
      // tool_result payload.
      expect(stub.seen).toHaveLength(2);
      const toolResultCall = stub.seen.find((s) => s.body.text === nlChars(6000));
      expect(toolResultCall).toBeTruthy();
      expect(toolResultCall.url).toBe("/compress");
      expect(toolResultCall.body.ratio).toBe(0.5);
    } finally {
      await stub.close();
    }
  });

  it("leaves the body unchanged and stays truthful when the endpoint fails", async () => {
    const stub = await startSidecarStub({ status: 500 });
    try {
      process.env.TOKENPROXY_LINGUA_ENDPOINT = stub.url;
      const dispatched = await runSession({
        firstBody: first(),
        secondBody: second(),
        overrides: { linguaEnabled: true },
      });
      const block = findLinguaToolResult(dispatched);
      expect(block.content).toBe(nlChars(6000));
    } finally {
      await stub.close();
    }
  });

  async function readLinguaRows(name, fn) {
    const eventsDir = `/tmp/tokenproxy-lingua-events-${process.pid}-${name}`;
    __setTokenSaverEventsDirForTest(eventsDir);
    let rows;
    try {
      await fn();
      const { readTokenSaverEvents } = await import("@/lib/tokenSaver/events.js");
      rows = readTokenSaverEvents().filter((r) => r.saver === "lingua");
    } finally {
      __setTokenSaverEventsDirForTest(null);
    }
    return rows;
  }

  it("emits an applied:true lingua row with truthful byte savings", async () => {
    const stub = await startSidecarStub();
    try {
      process.env.TOKENPROXY_LINGUA_ENDPOINT = stub.url;
      const rows = await readLinguaRows("applied", async () => {
        await runSession({
          firstBody: first(),
          secondBody: second(),
          overrides: { linguaEnabled: true },
        });
      });
      const applied = rows.find((r) => r.applied === true);
      expect(applied).toBeTruthy();
      expect(applied.bytesSaved).toBeLessThan(0);
      expect(typeof applied.ce).toBe("number");
      expect(JSON.stringify(rows)).not.toContain(nlChars(100));
    } finally {
      await stub.close();
    }
  });

  it("emits a truthful applied:false row when the epoch boundary blocks the stage", async () => {
    const stub = await startSidecarStub();
    try {
      process.env.TOKENPROXY_LINGUA_ENDPOINT = stub.url;
      const rows = await readLinguaRows("boundary", async () => {
        await runSession({
          firstBody: first(),
          secondBody: second(),
          overrides: { linguaEnabled: true },
        });
        // Third request identical to the second: fully stable epoch, so the
        // enabled stage must skip and say why.
        await handleChatCore(
          baseArgs({ body: second(), sid: "11ngu4s1d", linguaEnabled: true }),
        );
      });
      expect(rows.length).toBeGreaterThan(0);
      const skipped = rows.find((r) => r.applied === false);
      expect(skipped).toBeTruthy();
      expect(skipped.reason).toBe("epoch_boundary");
    } finally {
      await stub.close();
    }
  });

  it("reports no_backend when the stage is on but no endpoint is configured", async () => {
    const rows = await readLinguaRows("nobackend", async () => {
      await runSession({
        firstBody: first(),
        secondBody: second(),
        overrides: { linguaEnabled: true },
      });
    });
    expect(rows.length).toBeGreaterThan(0);
    const skipped = rows.find((r) => r.applied === false);
    expect(skipped).toBeTruthy();
    expect(skipped.reason).toBe("no_backend");
    // No backend was configured, so the body went out untouched.
    const block = findLinguaToolResult(mocks.dispatchedBodies.at(-1));
    expect(block.content).toBe(nlChars(6000));
  });

  it("accepts lingua events through the events allowlist", async () => {
    const rows = await readLinguaRows("allowlist", async () => {
      appendTokenSaverEvent({ saver: "lingua", applied: false, reason: "no_backend" });
      appendTokenSaverEvent({ saver: "lingua", applied: true, bytesSaved: -200 });
    });
    expect(rows.find((r) => r.applied === false && r.reason === "no_backend")).toBeTruthy();
    expect(rows.find((r) => r.applied === true)).toBeTruthy();
  });
});

// ---- reference sidecar contract ----------------------------------------------

describe("scripts/lingua-sidecar.mjs", () => {
  async function withSidecarServer(fn) {
    const server = await createLinguaSidecar();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function post(base, path, body, headers = { "content-type": "application/json" }) {
    const res = await fetch(base + path, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      /* non-JSON bodies parse as null */
    }
    return { status: res.status, parsed };
  }

  // llmlingua-2 is not a dependency of this repo; the sidecar must own that
  // contract by answering 501 instead of compressing.
  it("answers 501 when llmlingua-2 is not importable", async () => {
    await withSidecarServer(async (base) => {
      const res = await post(base, "/compress", { text: nlChars(6000), ratio: 0.5 });
      expect(res.status).toBe(501);
      expect(typeof res.parsed.error).toBe("string");
    });
  });

  it("validates request shape and path", async () => {
    await withSidecarServer(async (base) => {
      expect((await post(base, "/compress", "{not json")).status).toBe(400);
      expect((await post(base, "/compress", { text: 42, ratio: 0.5 })).status).toBe(400);
      expect((await post(base, "/compress", { text: "hi" })).status).toBe(400);
      expect((await post(base, "/compress", { text: "hi", ratio: 1.5 })).status).toBe(400);
      expect((await post(base, "/other", { text: "hi", ratio: 0.5 })).status).toBe(404);
      const getRes = await fetch(base + "/compress");
      expect(getRes.status).toBe(404);
    });
  });
});
