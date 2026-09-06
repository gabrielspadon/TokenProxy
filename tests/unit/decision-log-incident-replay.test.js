import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// INCIDENT-REPLAY VALIDATION (docs/logging-design.md): drives the REAL handler
// stack — chat.js admission/retry loop -> real auth.js scheduler -> chatCore ->
// real DefaultExecutor -> mocked upstream wire — through a scripted failure
// scenario, and captures every decision line the sink emits. The serialized
// capture is the proof that one `rg` over the log diagnoses the incident.
//
// Fixture convention: tests/fixtures/incident-replay-decisions.log is the
// golden capture. Re-generate it with UPDATE_FIXTURE=1 in the environment;
// a normal run compares against it. Non-deterministic fields (timestamps,
// latency ms, ledger row ids, lock-until instants) are normalized to
// placeholders before serialize/compare.

const harness = vi.hoisted(() => ({
  connections: [],
  connectionUpdates: [],
  upstream: null, // set per beat: (url, opts) => Response
  saveRequestDetailMock: vi.fn(),
}));

// ── module mocks ────────────────────────────────────────────────────────────

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  getProviderConnections: vi.fn(async (query) => {
    const all = harness.connections;
    if (!query) return all;
    return all.filter(
      (c) => (query.provider ? c.provider === query.provider : true) && (query.isActive ? c.isActive !== false : true)
    );
  }),
  validateApiKey: vi.fn(async () => true),
  updateProviderConnection: vi.fn(async (id, patch) => {
    harness.connectionUpdates.push({ id, patch });
    const conn = harness.connections.find((c) => c.id === id);
    if (conn) Object.assign(conn, patch);
    return conn ?? null;
  }),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(async () => {}),
  updateProviderStrategyProxyPoolSnapshotIfBound: vi.fn(async () => {}),
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("@/sse/services/schedulerRepos.js", () => ({
  createSchedulerRepos: vi.fn(async () => ({
    transaction: (fn) => fn(),
    getPin: () => null,
    setPin: vi.fn(),
    touchPin: vi.fn(),
    recordSwitch: vi.fn(() => ({ id: "rcpt-replay" })),
  })),
}));

vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getModelInfo: vi.fn(async () => ({ provider: "claude", model: "claude-fable-5" })),
  getComboModels: vi.fn(async () => null),
}));

vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  debug: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => "***"),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/admin/state.js", () => ({
  readAllDrainDocs: vi.fn(async () => []),
}));

vi.mock("@/lib/db/repos/quotaWindowsRepo.js", () => ({
  putWindows: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (url, opts) => harness.upstream(url, opts),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: harness.saveRequestDetailMock,
  trackActiveSession: vi.fn(),
  saveRequestUsage: vi.fn(async () => {}),
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

vi.mock("../../open-sse/utils/pxpipe.js", () => ({
  isPxpipeEnabled: vi.fn(() => false),
  runPxpipeHook: vi.fn(async () => null),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => null),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
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

import { __decide } from "@/shared/observability/decide.js";
import { PROVIDERS } from "open-sse/providers/index.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/incident-replay-decisions.log");
const DECISION_LINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (REQ|SEL|LOCK|UP|STREAM|XFORM|RANK|LEASE|CRED|ACCT|ADM|AUTHZ|LOG)\./;

let lines;
let consoleSpy;

beforeAll(async () => {
  // The DefaultExecutor reads its wire shape from PROVIDERS at construction;
  // the registry ships empty in tests, so pin the "claude" node the two
  // fixture connections claim to be.
  PROVIDERS["claude"] = {
    baseUrl: "https://upstream.test/v1/messages",
    format: "claude",
    tokenUrl: "https://upstream.test/oauth/token",
    clientId: "replay-client",
  };
  harness.handleChat = (await import("../../src/sse/handlers/chat.js")).handleChat;
});

beforeEach(() => {
  __decide.resetState();
  __decide.disableSink();
  lines = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((l) => {
    if (typeof l === "string" && DECISION_LINE.test(l)) lines.push(l);
  });
  harness.connections.splice(
    0,
    harness.connections.length,
    makeConnection("conn-aaaa1111", "key-aaaa1111"),
    makeConnection("conn-bbbb2222", "key-bbbb2222")
  );
  harness.connectionUpdates.length = 0;
  harness.upstream = () => new Response("unscripted upstream", { status: 404 });
  harness.saveRequestDetailMock.mockReset();
  harness.saveRequestDetailMock.mockImplementation(async (d) => {
    d.id ||= "row-replay";
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

// One snapshot clock for every connection: byte-identical windows keep the
// ranker's decidedKey stable (reset-horizon vs fallback-order otherwise
// flips on millisecond timing between the two at() calls).
const SNAP = (() => {
  const t0 = Date.now();
  return {
    fetchedAt: new Date(t0).toISOString(),
    hourlyReset: new Date(t0 + 8 * 3600 * 1000).toISOString(),
    weeklyReset: new Date(t0 + 7 * 24 * 3600 * 1000).toISOString(),
  };
})();

function makeConnection(id, apiKey) {
  return {
    id,
    provider: "claude",
    isActive: true,
    authType: "apikey",
    apiKey,
    connectionName: id,
    displayName: id,
    providerSpecificData: { baseUrl: "https://upstream.test/v1/messages" },
    isCustomNode: false,
    testStatus: "ok",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    // Rankable quota evidence so the scheduler ranks instead of falling back:
    // two percentage windows with future resets on the synthetic scale.
    lastQuotaSnapshot: {
      windows: [
        { key: "hourly (5h)", remainingPercentage: 85, resetAt: SNAP.hourlyReset, unlimited: false },
        { key: "weekly (7d)", remainingPercentage: 90, resetAt: SNAP.weeklyReset, unlimited: false },
      ],
      fetchedAt: SNAP.fetchedAt,
    },
  };
}

// The client speaks the OpenAI chat-completions shape (a universal-gateway
// incident: claude provider, foreign client). sourceFormat=openai vs the
// provider's claude target makes the response stream run in TRANSLATE mode,
// which accumulates upstream content — the gate STREAM.usage-estimated needs
// when a provider omits usage blocks (beat 2). A claude-shaped client would
// run the passthrough stream, which extracts usage only.
function chatRequest({ rid, systemBlocks, messages, extra = {} }) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tp-rid": rid,
    },
    body: JSON.stringify({
      model: "claude/claude-fable-5",
      messages: [...(systemBlocks ? [{ role: "system", content: systemBlocks }] : []), ...messages],
      stream: true,
      // OpenAI-format marker: forces detectFormat -> "openai".
      stream_options: { include_usage: true },
      ...extra,
    }),
  });
}

// Claude SSE with an honest usage tail. omitUsage drops every usage block —
// the handler must then estimate, and says so in the log.
function claudeSse({ usage = null, deltaUsage = null, text = "Hello from upstream" }) {
  // usage === null means the provider omitted usage entirely (beat 2's
  // failover) — no usage field anywhere, so the handler must estimate.
  const startUsage = usage === null ? {} : { usage };
  const deltaUsageField =
    deltaUsage === null && usage === null
      ? {}
      : { usage: deltaUsage ?? (usage ? { output_tokens: usage.output_tokens ?? 1 } : { output_tokens: 1 }) };
  const events = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_replay",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        ...startUsage,
      },
    })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      ...deltaUsageField,
    })}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  return new Response(events.map((e) => `${e}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function quotaDepleted() {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "insufficient_quota", message: "Quota exhausted for this account" },
    }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } }
  );
}

function take() {
  const out = lines;
  lines = [];
  return out;
}

function normalize(ls) {
  return ls.map((l) =>
    l
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/, "<ts>")
      .replace(/\b(t|ttft)=\d+/g, "$1=<ms>")
      .replace(/\brow=\S+/g, "row=<row>")
      .replace(/\buntil=\S+/g, "until=<until>")
      .replace(/\breset=\S+/g, "reset=<reset>")
      .replace(/\bfirst=\S+/g, "first=<ts>")
  );
}

function serialize(ls) {
  return normalize(ls).join("\n") + "\n";
}

describe("incident replay: diagnose the quota lock + failover from the log alone", () => {
  it("returns an ordinary rate cooldown without amplifying attempts", async () => {
    harness.upstream = vi.fn(() => Response.json({
      error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit" },
    }, { status: 429, headers: { "retry-after": "60" } }));
    const response = await harness.handleChat(chatRequest({
      rid: "aa000006", messages: [{ role: "user", content: "rate control" }],
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-tokenproxy-replay-safe")).toBe("false");
    expect(harness.upstream).toHaveBeenCalledTimes(1);
    await response.text();
    const decisions = take();
    expect(decisions.some((line) => line.includes("LOCK.applied") && line.includes("class=rate"))).toBe(true);
    expect(decisions.some((line) => line.includes("UP.no-replay") && line.includes("why=account-cooldown"))).toBe(true);
    expect(decisions.some((line) => line.includes("UP.failover"))).toBe(false);
  });

  it("plays beats 1-5 and matches the golden capture", async () => {
    const captured = [];

    // ── beat 1: healthy completion on conn-aaaa1111, cache fields present ──
    harness.upstream = (url, opts) => {
      if (String(url).includes("/oauth/")) return new Response("nf", { status: 404 });
      return claudeSse({ usage: { input_tokens: 1000, cache_read_input_tokens: 900, output_tokens: 50 } });
    };
    const res1 = await harness.handleChat(
      chatRequest({ rid: "aa000001", messages: [{ role: "user", content: "hi" }] })
    );
    expect(res1.status).toBe(200);
    await res1.text();
    const b1 = take();
    captured.push(...b1);
    const req1 = b1.filter((l) => l.includes(" REQ."));
    expect(req1).toHaveLength(1);
    expect(req1[0]).toContain("REQ.ok");
    expect(req1[0]).toContain("rid=aa000001");
    expect(req1[0]).toContain("conn=conn-aaa");
    expect(req1[0]).toContain("sel=win");
    // translate mode reports input total incl. cache-read: 1000 + 900
    expect(req1[0]).toContain("in=1900");
    expect(req1[0]).toContain("cr=900");

    // ── beat 2: 429 on aaaa1111 (quota lock), failover to bbbb2222 which
    //    answers without usage fields ──
    harness.upstream = (url, opts) => {
      const key = opts?.headers?.["x-api-key"];
      if (key === "key-aaaa1111") return quotaDepleted();
      return claudeSse({ usage: null, deltaUsage: null });
    };
    const res2 = await harness.handleChat(
      chatRequest({ rid: "aa000002", messages: [{ role: "user", content: "again" }] })
    );
    expect(res2.status).toBe(200);
    await res2.text();
    const b2 = take();
    captured.push(...b2);
    expect(
      b2.some((l) => l.includes("LOCK.applied") && l.includes("class=quota") && l.includes("expect_reset=true"))
    ).toBe(true);
    expect(b2.some((l) => /UP\.failover/.test(l) && l.includes("from=conn-aaa") && l.includes("to=pool"))).toBe(true);
    expect(b2.some((l) => /SEL\.win/.test(l) && l.includes("conn=conn-bbb"))).toBe(true);
    expect(b2.some((l) => l.includes("STREAM.usage-estimated"))).toBe(true);
    const req2 = b2.filter((l) => l.includes(" REQ."));
    expect(req2).toHaveLength(2); // the 429 attempt fails, the failover succeeds
    expect(req2[0]).toContain("REQ.failed");
    expect(req2[0]).toContain("status=429");
    expect(req2[1]).toContain("REQ.ok");
    expect(req2[1]).toContain("rid=aa000002");
    expect(req2[1]).toContain("conn=conn-bbb");
    expect(req2[1]).toContain("cr=0");

    // ── beat 3: the quota lock still holds — the scheduler skips aaaa1111 ──
    harness.upstream = () =>
      claudeSse({ usage: { input_tokens: 10, output_tokens: 5 } });
    const anchors = [
      { type: "text", text: "policy one", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "policy two", cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    const res3 = await harness.handleChat(
      chatRequest({ rid: "aa000003", systemBlocks: anchors, messages: [{ role: "user", content: "third" }] })
    );
    expect(res3.status).toBe(200);
    await res3.text();
    const b3 = take();
    captured.push(...b3);
    expect(b3.some((l) => /SEL\.model-locked/.test(l) && l.includes("conn=conn-aaa"))).toBe(true);
    expect(b3.some((l) => /SEL\.win/.test(l) && l.includes("conn=conn-bbb"))).toBe(true);
    const req3 = b3.filter((l) => l.includes(" REQ."));
    expect(req3).toHaveLength(1);
    expect(req3[0]).toContain("rid=aa000003");
    expect(req3[0]).toMatch(/path=.*XFORM\.cache-keep$/);

    // ── beat 4: same request without a client cache plan ──
    const res4 = await harness.handleChat(
      chatRequest({ rid: "aa000004", systemBlocks: [{ type: "text", text: "policy one" }], messages: [{ role: "user", content: "fourth" }] })
    );
    expect(res4.status).toBe(200);
    await res4.text();
    const b4 = take();
    captured.push(...b4);
    const req4 = b4.filter((l) => l.includes(" REQ."));
    expect(req4).toHaveLength(1);
    expect(req4[0]).toMatch(/path=.*XFORM\.cache-legacy$/);

    // ── beat 5: refresh failure with an unchanged fingerprint ──
    const { refreshAccessToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    const { tokenFingerprint } = await import("../../open-sse/services/tokenRefresh/dedup.js");
    const rt = "rt-deadbeef-0001-cccc3333";
    harness.upstream = (url) =>
      String(url).includes("/oauth/token")
        ? new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        : new Response("nf", { status: 404 });
    // invalid_grant on the exact held token: emits CRED.chain-diverged and
    // resolves null (the caller's retry layer treats it as unrecoverable).
    await expect(
      refreshAccessToken("claude", rt, {
        connectionId: "conn-cccc3333",
        refreshToken: rt,
        refreshTokenFp: tokenFingerprint(rt),
        refreshTokenIssuedAt: new Date().toISOString(),
      })
    ).resolves.toBeNull();
    const b5 = take();
    expect(
      b5.some((l) => /CRED\.refresh-failed/.test(l) && l.includes("status=400") && l.includes("why=invalid_grant"))
    ).toBe(true);
    captured.push(...b5);
    expect(
      b5.some((l) => /CRED\.chain-diverged/.test(l) && l.includes("conn=conn-ccc") && l.includes("prov=claude"))
    ).toBe(true);

    // ── golden capture ──
    const rendered = serialize(captured);
    if (process.env.UPDATE_FIXTURE === "1") {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, rendered);
    }
    expect(existsSync(FIXTURE)).toBe(true);
    expect(rendered).toBe(readFileSync(FIXTURE, "utf8"));
  });
});
