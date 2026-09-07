import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mcpMocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(async (key) => key === "good-key"),
  getProviderConnections: vi.fn(async () => [{ provider: "openai" }, { provider: "anthropic" }]),
  readContextStatus: vi.fn(() => null),
}));

vi.mock("@/lib/localDb", () => ({
  validateApiKey: mcpMocks.validateApiKey,
  getProviderConnections: mcpMocks.getProviderConnections,
}));

vi.mock("open-sse/handlers/chatCore/contextStatusStore.js", () => ({
  readContextStatus: mcpMocks.readContextStatus,
}));

const { POST } = await import("../../src/app/api/v1/mcp/route.js");

// The same hash chain the route replicates from the chat path: session id
// from x-session-id, namespaced per provider, then idPrefix's 8-hex sha256.
function expectedSid(provider, sessionId) {
  const hash = createHash("sha256")
    .update(`${provider}:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return createHash("sha256").update(hash).digest("hex").slice(0, 8);
}

function rpcRequest(body, { sessionId = "sess-abc", key = "good-key", accept = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  if (sessionId !== null) headers["X-Session-Id"] = sessionId;
  if (accept !== null) headers.Accept = accept;
  return new Request("http://localhost:20128/v1/mcp", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const SAMPLE_ENTRY = {
  sid: "deadbeef",
  rid: "a1b2c3d4",
  ctxTokens: 51234,
  saveBytes: -3200,
  ceBytes: 8192,
  dollarsSaved: 0.0123,
  epochHitRate: 0.5,
  volatileKeys: ["metadata"],
  compactHint: true,
  updatedAt: "2026-09-04T12:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mcpMocks.getProviderConnections.mockResolvedValue([
    { provider: "openai" },
    { provider: "anthropic" },
  ]);
});

describe("POST /api/v1/mcp JSON-RPC", () => {
  it("initialize handshake shape", async () => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tokenproxy", version: "0.0.1" },
      },
    });
  });

  it("initialize answers identically for text/event-stream Accept", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 2, method: "initialize" }, { accept: "text/event-stream" }),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).result.protocolVersion).toBe("2025-03-26");
  });

  it("notifications/initialized is a 202 no-op", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(res.status).toBe(202);
  });

  it("tools/list exposes exactly context_status with the contract schema", async () => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    const body = await res.json();
    expect(body.result.tools).toHaveLength(1);
    const tool = body.result.tools[0];
    expect(tool.name).toBe("context_status");
    expect(tool.description).toContain("ctxTokens");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        sid: {
          type: "string",
          description: "optional override; defaults to the caller's own session",
        },
      },
    });
  });

  it("tools/call returns the caller's own telemetry (default sid derivation)", async () => {
    const openaiSid = expectedSid("openai", "sess-abc");
    mcpMocks.readContextStatus.mockImplementation((sid) =>
      sid === openaiSid ? { ...SAMPLE_ENTRY, sid } : null,
    );
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context_status" } }),
    );
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(false);
    const parsed = JSON.parse(body.result.content[0].text);
    expect(body.result.content[0]).toMatchObject({
      type: "resource",
      uri: "context://status",
      mimeType: "application/json",
    });
    expect(parsed).toEqual({
      sid: openaiSid,
      rid: "a1b2c3d4",
      ctxTokens: 51234,
      ctxTokensActual: null,
      saveBytes: -3200,
      ceBytes: 8192,
      dollarsSaved: 0.0123,
      epochHitRate: 0.5,
      volatileKeys: ["metadata"],
      compactHint: true,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    expect(body.result.structuredContent).toEqual(parsed);
  });

  it("tools/call picks the freshest entry across provider candidates", async () => {
    const openaiSid = expectedSid("openai", "sess-abc");
    const anthropicSid = expectedSid("anthropic", "sess-abc");
    mcpMocks.readContextStatus.mockImplementation((sid) => {
      if (sid === openaiSid)
        return { ...SAMPLE_ENTRY, sid, updatedAt: "2026-09-04T10:00:00.000Z" };
      if (sid === anthropicSid)
        return { ...SAMPLE_ENTRY, sid, updatedAt: "2026-09-04T11:00:00.000Z" };
      return null;
    });
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "context_status" } }),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.sid).toBe(anthropicSid);
  });

  it("tools/call with an explicit valid sid reads that sid directly", async () => {
    mcpMocks.readContextStatus.mockImplementation((sid) =>
      sid === "cafe0000" ? { ...SAMPLE_ENTRY, sid: "cafe0000" } : null,
    );
    const res = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "context_status", arguments: { sid: "cafe0000" } },
      }),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.sid).toBe("cafe0000");
    expect(mcpMocks.readContextStatus).toHaveBeenCalledWith("cafe0000");
    expect(mcpMocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it("tools/call with an invalid sid arg → isError, store untouched", async () => {
    const res = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "context_status", arguments: { sid: "XYZ!nothex" } },
      }),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/sid/);
    expect(mcpMocks.readContextStatus).not.toHaveBeenCalled();
  });

  it("tools/call for an unknown session → isError with a clear message", async () => {
    const res = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "context_status", arguments: { sid: "1234abcd" } },
      }),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("1234abcd");
  });

  it("unknown tool name → isError", async () => {
    const res = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "something_else" },
      }),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
  });

  it("unknown method → JSON-RPC -32601", async () => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 10, method: "resources/list" }));
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
    expect(body.id).toBe(10);
  });

  it("parse failure → -32700 with null id", async () => {
    const res = await POST(rpcRequest("{not valid json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it("rejects an unrecognized bearer credential", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 11, method: "initialize" }, { key: "bad-key" }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe(-32001);
  });

  it("no bearer at all → 401, every method gated", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 12, method: "tools/list" }, { key: null }),
    );
    expect(res.status).toBe(401);
  });

  it("anonymous caller (no session headers) gets isError, never another caller's anonymous entry", async () => {
    // The anonymous namespace is shared across callers: a freshest-anonymous
    // read would leak one session's telemetry to an unrelated caller.
    const anonSid = (() => {
      const hash = createHash("sha256").update("openai:anonymous").digest("hex").slice(0, 32);
      return createHash("sha256").update(hash).digest("hex").slice(0, 8);
    })();
    mcpMocks.readContextStatus.mockImplementation((s) =>
      s === anonSid ? { ...SAMPLE_ENTRY, sid: anonSid } : null,
    );
    const res = await POST(
      rpcRequest(
        { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "context_status" } },
        { sessionId: null },
      ),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("No context telemetry");
    // the anonymous-namespace hash must never be read as "your own"
    expect(mcpMocks.readContextStatus).not.toHaveBeenCalledWith(anonSid);
  });

  it("notifications/cancelled (id null) is a 202 no-op, no JSON-RPC reply", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } }),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toBeNull();
  });

  it("a notifications/* method WITH an id is not a notification: method-not-found", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 14, method: "notifications/cancelled" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
    expect(body.id).toBe(14);
  });
});
