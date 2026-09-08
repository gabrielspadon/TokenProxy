/**
 * CRED decision points in open-sse/services/tokenRefresh/providers.js
 * (docs/logging-design.md §2 rows 42-43, 46, §3.4 worked examples, §3.6
 * folding). Captures the real console lines the real decide() writes, same
 * approach as tests/unit/decision-log-auth-emissions.test.js.
 *
 * proxyFetch.js captures globalThis.fetch at module load, so the mock must be
 * installed BEFORE providers.js is imported (mirrors token-refresh-generic).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as decideModule from "@/shared/observability/decide.js";

const originalFetch = global.fetch;

const ISSUED_AT = Date.parse("2026-09-03T17:00:00Z");
const TOK_OLD = "tok-old-0123456789abcdef";
const TOK_NEW = "tok-new-fedcba9876543210";

let logSpy;

function credLines(verdict) {
  return logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes(` CRED.${verdict} `));
}

function loadProviders() {
  return import("open-sse/services/tokenRefresh/providers.js");
}

/** Install the mock BEFORE the first providers.js import in the test. */
function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(typeof payload === "string" ? JSON.parse(payload) : payload),
    text: () => Promise.resolve(typeof payload === "string" ? payload : JSON.stringify(payload ?? {})),
  });
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  vi.resetModules();
  global.fetch = originalFetch;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  decideModule.__decide.resetState();
  decideModule.__decide.disableSink();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe("CRED.no-refresh-path", () => {
  it("emits which=url when the provider has no refresh URL", async () => {
    const { refreshAccessToken } = await loadProviders();
    await refreshAccessToken("zed-unknown", TOK_OLD, { connectionId: "conn-url" }, console);
    const emitted = credLines("no-refresh-path");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("conn=conn-url");
    expect(emitted[0]).toContain("which=url");
  });

  it("emits which=token when the refresh token is missing", async () => {
    const { refreshAccessToken } = await loadProviders();
    await refreshAccessToken("kimi", "", { connectionId: "conn-tok" }, console);
    const emitted = credLines("no-refresh-path");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("which=token");
  });
});

describe("CRED.refresh-failed", () => {
  it("emits conn, prov, status, why, fp0, age with the closed discriminator", async () => {
    mockFetch('{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}', { ok: false, status: 400 });
    const { refreshAccessToken } = await loadProviders();
    const creds = {
      connectionId: "7a1acb09-full",
      refreshTokenFp: "fp-mismatch",
      refreshTokenIssuedAt: new Date(ISSUED_AT).toISOString(),
    };
    await refreshAccessToken("kimi", TOK_OLD, creds, console);
    const emitted = credLines("refresh-failed");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("conn=7a1acb0"); // 8-char prefix
    expect(emitted[0]).toContain("prov=kimi");
    expect(emitted[0]).toContain("status=400");
    expect(emitted[0]).toContain("why=invalid_grant");
    expect(emitted[0]).toMatch(/fp0=[0-9a-f]{8}/);
    expect(emitted[0]).toMatch(/age=\d+[mhd]/);
    expect(emitted[0]).not.toContain("Refresh token not found"); // no provider message
  });

  it("discriminates invalid_client and http", async () => {
    mockFetch({});
    const { refreshFailureWhy } = await loadProviders();
    expect(refreshFailureWhy('{"error":"invalid_client"}')).toBe("invalid_client");
    expect(refreshFailureWhy('{"error":"invalid_grant"}')).toBe("invalid_grant");
    expect(refreshFailureWhy("Internal Server Error")).toBe("http");
    expect(refreshFailureWhy('{"error":"unsupported_grant_type"}')).toBe("http");
  });

  it("emits why=network when the fetch itself throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { refreshAccessToken } = await loadProviders();
    await refreshAccessToken("kimi", TOK_OLD, { connectionId: "conn-net" }, console);
    const emitted = credLines("refresh-failed");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("why=network");
    expect(emitted[0]).not.toContain("status=");
  });

  it("folds repeats exponentially and never folds across a why change", async () => {
    // The captured mock returns the same 400 for every call; a distinct token
    // per call bypasses the 10s dedup cache while conn and why stay constant,
    // so the fold key is stable.
    // proxyFetch captured this mock at import — mutate it in place to change
    // the provider response; reassigning global.fetch would have no effect.
    const fetchMock = mockFetch('{"error":"invalid_grant"}', { ok: false, status: 400 });
    const { refreshAccessToken } = await loadProviders();
    const creds = { connectionId: "conn-fold" };

    for (let n = 1; n <= 8; n++) {
      await refreshAccessToken("kimi", `${TOK_OLD}-${n}`, creds, console);
    }
    let emitted = credLines("refresh-failed");
    expect(emitted).toHaveLength(4); // speaks on occurrences 1,2,4,8
    expect(emitted[2]).toContain("rep=2");
    expect(emitted[3]).toContain("rep=4"); // occurrences since last emission
    expect(emitted[3]).toContain("why=invalid_grant");

    // why change must open a new fold key, not extend the old one
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("boom"),
    });
    for (let n = 1; n <= 2; n++) {
      await refreshAccessToken("kimi", `${TOK_OLD}-http-${n}`, creds, console);
    }
    emitted = credLines("refresh-failed");
    expect(emitted).toHaveLength(6); // 4 + occurrences 1,2 of the new why
    expect(emitted[4]).toContain("why=http");
    expect(emitted[4]).not.toContain("rep=");
    expect(emitted[5]).toContain("why=http");
    expect(emitted[5]).not.toContain("rep="); // rep shows only past occurrence 2
  });
});

describe("CRED.rotated", () => {
  it("emits only when the refresh token fingerprint changes", async () => {
    mockFetch({ access_token: "at", refresh_token: TOK_NEW, expires_in: 3600 });
    const { refreshAccessToken } = await loadProviders();
    const result = await refreshAccessToken("kimi", TOK_OLD, { connectionId: "conn-rot" }, console);
    expect(result.refreshToken).toBe(TOK_NEW);
    const emitted = credLines("rotated");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("conn=conn-rot");
    expect(emitted[0]).toContain("prov=kimi");
    expect(emitted[0]).toMatch(/fp0=[0-9a-f]{8} fp=[0-9a-f]{8}/);
  });

  it("stays silent when the provider returns the same token", async () => {
    mockFetch({ access_token: "at", expires_in: 3600 });
    const { refreshAccessToken } = await loadProviders();
    const result = await refreshAccessToken("kimi", TOK_OLD, { connectionId: "conn-same" }, console);
    expect(result.refreshToken).toBe(TOK_OLD);
    expect(credLines("rotated")).toHaveLength(0);
  });
});

describe("CRED.chain-diverged", () => {
  it("fires once per held fp and lists capped peers", async () => {
    vi.useFakeTimers();
    const dedup = await import("open-sse/services/tokenRefresh/dedup.js");
    const fp0 = dedup.tokenFingerprint(TOK_OLD);

    // Seed four chain peers sharing this token through the same dedup key
    // refreshAccessToken will use below.
    for (const peer of ["peer-aaaa", "peer-bbbb", "peer-cccc", "peer-dddd"]) {
      await dedup.dedupRefresh("kimi", TOK_OLD, async () => ({ accessToken: "x" }), console, peer);
    }
    // The seeded success caches (kimi:TOK_OLD) for 10s — age past it so the
    // failing refresh below actually executes.
    vi.advanceTimersByTime(11_000);

    mockFetch('{"error":"invalid_grant"}', { ok: false, status: 400 });
    const { refreshAccessToken } = await loadProviders();
    const creds = {
      connectionId: "conn-div",
      refreshTokenFp: fp0, // held fp unchanged since issue
      refreshTokenIssuedAt: new Date(ISSUED_AT).toISOString(),
    };
    await refreshAccessToken("kimi", TOK_OLD, creds, console);
    let emitted = credLines("chain-diverged");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("conn=conn-div");
    expect(emitted[0]).toContain(`fp0=${fp0}`);
    expect(emitted[0]).toContain("fp=unknown");
    expect(emitted[0]).toContain("why=issuer-rejected-held-token");
    const peersMatch = emitted[0].match(/peers=([^ ]+)/);
    expect(peersMatch).not.toBeNull();
    const peers = peersMatch[1].split(",");
    expect(peers.length).toBe(3); // capped at 3, +N appended to the third
    expect(peers[2]).toMatch(/\+1$/);

    // second failure on the same held fp stays silent
    await refreshAccessToken("kimi", TOK_OLD, creds, console);
    emitted = credLines("chain-diverged");
    expect(emitted).toHaveLength(1);
  });

  it("does not fire when the held fp differs from the issued fp", async () => {
    mockFetch('{"error":"invalid_grant"}', { ok: false, status: 400 });
    const { refreshAccessToken } = await loadProviders();
    const creds = {
      connectionId: "conn-div2",
      refreshTokenFp: "deadbeef", // TokenProxy already rotated locally
      refreshTokenIssuedAt: new Date(ISSUED_AT).toISOString(),
    };
    await refreshAccessToken("kimi", TOK_OLD, creds, console);
    expect(credLines("chain-diverged")).toHaveLength(0);
  });
});

describe("issue-record age rendering", () => {
  it("renders minutes, hours, and days compactly", async () => {
    mockFetch({});
    const { formatIssueAge } = await loadProviders();
    const now = Date.parse("2026-09-03T18:00:00Z");
    expect(formatIssueAge(now - 41 * 60000, now)).toBe("41m");
    expect(formatIssueAge(now - 3 * 3600000, now)).toBe("3h");
    expect(formatIssueAge(now - 2 * 86400000, now)).toBe("2d");
    expect(formatIssueAge(now + 60000, now)).toBe("0m"); // clock skew floor
  });

  it("uses the persisted firstSeen for age on failure", async () => {
    mockFetch('{"error":"invalid_grant"}', { ok: false, status: 400 });
    const { refreshAccessToken } = await loadProviders();
    const creds = {
      connectionId: "conn-age",
      refreshTokenIssuedAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    };
    await refreshAccessToken("kimi", TOK_OLD, creds, console);
    const emitted = credLines("refresh-failed");
    expect(emitted[0]).toContain("age=3h");
  });
});

// Isolate decision semantics from the separately qualified asynchronous transport.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
