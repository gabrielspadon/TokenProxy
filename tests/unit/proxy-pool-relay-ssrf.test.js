import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  updateProxyPool: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
  updateProxyPool: mocks.updateProxyPool,
}));

const { testProxyUrl, testRelayUrl } = await import("../../src/lib/network/proxyTest.js");
const { POST: testProxyPool } = await import("../../src/app/api/proxy-pools/[id]/test/route.js");

// undici surfaces a connector/DNS rejection as TypeError("fetch failed") with the
// real reason on .cause — the shape createPublicOnlyLookup produces on rebinding.
const wrapAsFetchFailure = (cause) => Object.assign(new TypeError("fetch failed"), { cause });
const ssrfCause = () => Object.assign(new Error("Blocked URL: private IP"), { code: "ERR_SSRF_BLOCKED" });

describe("testRelayUrl SSRF guard", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ip: "1.2.3.4" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    ["loopback (the reproduced exploit)", "http://127.0.0.1:20136/api/health"],
    ["loopback by name", "http://localhost:20128/dashboard"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["private 10/8", "http://10.0.0.5/admin"],
    ["private 192.168/16", "http://192.168.1.1/"],
    ["private 172.16/12", "http://172.16.0.1/"],
    ["carrier NAT 100.64/10", "http://100.64.0.1/"],
    ["multicast", "http://224.0.0.1/"],
    ["IPv6 loopback", "http://[::1]:20128/"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
    ["internal suffix", "http://relay.internal/"],
    ["non-http protocol", "file:///etc/passwd"],
  ])("refuses %s with an actionable 400 and never dials", async (_label, relayUrl) => {
    const result = await testRelayUrl({ relayUrl });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/Blocked/i);
    expect(result.error).toMatch(/public/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a DNS-rebinding refusal raised at connect time to 400, not 500", async () => {
    fetchSpy.mockRejectedValueOnce(wrapAsFetchFailure(ssrfCause()));

    const result = await testRelayUrl({ relayUrl: "https://rebind.example.com/" });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.error).toMatch(/Blocked/i);
  });

  it("still reports an ordinary upstream failure as 500", async () => {
    fetchSpy.mockRejectedValueOnce(wrapAsFetchFailure(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));

    const result = await testRelayUrl({ relayUrl: "https://relay-abc.vercel.app/" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it("allows a genuinely public relay and sends the relay probe headers", async () => {
    const result = await testRelayUrl({ relayUrl: "https://relay-abc.vercel.app/" });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://relay-abc.vercel.app/");
    expect(init.headers["x-relay-target"]).toBe("https://api.ipify.org");
  });

  it("rejects an empty relay URL without dialling", async () => {
    const result = await testRelayUrl({ relayUrl: "  " });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("testProxyUrl (ProxyAgent path) stays usable for private proxies", () => {
  it("dials a loopback proxy instead of refusing it as SSRF", async () => {
    // Port 9 (discard) is closed here, so this fails at connect — the point is
    // that it FAILS AT CONNECT rather than being rejected by an address guard.
    const result = await testProxyUrl({ proxyUrl: "http://127.0.0.1:9", timeoutMs: 2000 });

    expect(result.ok).toBe(false);
    expect(result.status).not.toBe(400);
    expect(result.error || "").not.toMatch(/Blocked/i);
  });
});

describe("POST /api/proxy-pools/[id]/test", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchSpy);
    mocks.updateProxyPool.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("answers 400 and persists the reason when a relay pool points at loopback", async () => {
    // The activation effect now commits atomically with the operation receipt
    // against the real row, so seed one instead of asserting on a mock call.
    const { createProxyPool, getProxyPoolById } = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
    const seeded = await createProxyPool({
      id: "p1", name: "p1", type: "vercel", proxyUrl: "http://127.0.0.1:20136/api/health",
      isActive: true, testStatus: "active",
    });
    mocks.getProxyPoolById.mockResolvedValue(seeded);

    const res = await testProxyPool(new Request("http://localhost/api/proxy-pools/p1/test", { method: "POST" }), {
      params: Promise.resolve({ id: "p1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Blocked/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await getProxyPoolById("p1");
    expect(after).toMatchObject({ testStatus: "error", isActive: false });
    expect(after.lastError).toMatch(/Blocked/i);
  });

  it("answers 200 for a public relay pool", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      id: "p2", type: "cloudflare", proxyUrl: "https://relay-abc.workers.dev/",
    });

    const res = await testProxyPool(new Request("http://localhost/api/proxy-pools/p2/test", { method: "POST" }), {
      params: Promise.resolve({ id: "p2" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("does not block an http pool whose proxy is on loopback", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "p3", type: "http", proxyUrl: "http://127.0.0.1:9" });

    const res = await testProxyPool(new Request("http://localhost/api/proxy-pools/p3/test", { method: "POST" }), {
      params: Promise.resolve({ id: "p3" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error || "").not.toMatch(/Blocked/i);
  });
});
