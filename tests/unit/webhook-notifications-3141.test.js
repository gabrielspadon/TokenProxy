import { describe, it, expect, vi, beforeEach } from "vitest";

// #3141 — webhook notifications for critical events.
//
// Two contracts are load-bearing and both are asserted here:
//   1. DELIVERY IS FAIL-OPEN. A hostile, slow or blocked endpoint must never
//      throw out of emit(), because emit() is what a request path would call.
//   2. DETECTION READS ONLY PERSISTED STATE. The watcher is driven by the same
//      connection fields src/sse/services/auth.js already writes and the same
//      requestStats window /api/system/state already reads, so the events are
//      edge-triggered on transitions rather than levels.

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
// ensureWatcher() is never called here — these tests drive evaluate() directly.
vi.mock("@/lib/db/repos/usageRepo.js", () => ({ statsEmitter: { on: () => {} } }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: vi.fn(),
  isConnectionDegraded: (conn) => conn.degraded === true,
}));
vi.mock("@/lib/db/repos/requestStatsRepo.js", () => ({ getTrafficWindow: vi.fn() }));

const {
  deliver, dispatch, emit, signPayload, normalizeNotificationsConfig, WEBHOOK_EVENTS,
} = await import("@/lib/notifications/webhooks.js");
const { evaluate } = await import("@/lib/notifications/watcher.js");

const ok = () => ({ ok: true, status: 200 });
const status = (s) => ({ ok: false, status: s });
const endpoint = { id: "e1", url: "https://hooks.example.com/x", secret: "s3cret", events: WEBHOOK_EVENTS, active: true };
const noWait = async () => {};

function freshState() {
  return { degraded: new Map(), errorRateFiring: false };
}

beforeEach(() => {
  mocks.getSettings.mockReset();
  mocks.updateSettings.mockReset();
});

describe("deliver", () => {
  it("signs the exact body it sends with HMAC-SHA256", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await deliver(endpoint, "provider.unhealthy", { provider: "claude" }, { fetchImpl, wait: noWait });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(endpoint.url);
    expect(init.method).toBe("POST");
    expect(init.headers["x-tp-event"]).toBe("provider.unhealthy");
    expect(init.headers["x-tp-signature"]).toBe(signPayload("s3cret", init.body));
    expect(JSON.parse(init.body)).toMatchObject({ event: "provider.unhealthy", data: { provider: "claude" } });
  });

  it("omits the signature header when no secret is configured", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await deliver({ ...endpoint, secret: "" }, "high.error.rate", {}, { fetchImpl, wait: noWait });
    expect(fetchImpl.mock.calls[0][1].headers["x-tp-signature"]).toBeUndefined();
  });

  it("retries a 5xx three times with the 1s/5s/30s ladder, then gives up", async () => {
    const fetchImpl = vi.fn(async () => status(503));
    const waited = [];
    const result = await deliver(endpoint, "high.error.rate", {}, {
      fetchImpl,
      wait: async (ms) => { waited.push(ms); },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(waited).toEqual([1000, 5000, 30000]);
    expect(result).toMatchObject({ ok: false, attempts: 4, error: "HTTP 503" });
  });

  it("retries a 429 but never a plain 4xx", async () => {
    const rateLimited = vi.fn(async () => status(429));
    await deliver(endpoint, "high.error.rate", {}, { fetchImpl: rateLimited, wait: noWait });
    expect(rateLimited).toHaveBeenCalledTimes(4);

    const rejected = vi.fn(async () => status(404));
    const result = await deliver(endpoint, "high.error.rate", {}, { fetchImpl: rejected, wait: noWait });
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("never retries an SSRF-blocked target and never throws", async () => {
    const blocked = Object.assign(new Error("Blocked URL: private IP"), { code: "ERR_SSRF_BLOCKED" });
    const fetchImpl = vi.fn(async () => { throw blocked; });
    const result = await deliver(endpoint, "provider.unhealthy", {}, { fetchImpl, wait: noWait });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/public address/);
  });

  it("honours retries: 0 for the manual test button", async () => {
    const fetchImpl = vi.fn(async () => status(500));
    await deliver(endpoint, "test", {}, { fetchImpl, wait: noWait, retries: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels unused response bodies and retains a stable receiver deduplication ID", async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204, body: { cancel } }));
    await deliver(endpoint, 'rule.fired', { alertId: 'fixture-alert' }, {
      fetchImpl, deliveryId: 'fixture-delivery',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers['x-tp-delivery-id']).toBe('fixture-delivery');
  });

  it("stops a retry delay promptly on caller cancellation without another send", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => { queueMicrotask(() => controller.abort()); return status(503); });
    const result = await deliver(endpoint, 'rule.fired', {}, { fetchImpl, signal: controller.signal });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, uncertain: true, attempts: 1 });
  });

  it("does no network work for an already cancelled delivery", async () => {
    const fetchImpl = vi.fn();
    const result = await deliver(endpoint, 'rule.fired', {}, {
      fetchImpl, signal: AbortSignal.abort(),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cancelled: true, attempts: 0 });
  });
});

describe("dispatch", () => {
  const config = { enabled: true, endpoints: [endpoint], errorRate: {} };

  it("skips everything while notifications are disabled", async () => {
    const fetchImpl = vi.fn();
    const result = await dispatch("provider.unhealthy", {}, { config: { ...config, enabled: false }, fetchImpl });
    expect(result).toMatchObject({ delivered: 0, skipped: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("only posts to endpoints subscribed to the event and still active", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await dispatch("provider.recovered", {}, {
      config: {
        ...config,
        endpoints: [
          { ...endpoint, id: "subscribed", events: ["provider.recovered"] },
          { ...endpoint, id: "other-event", events: ["high.error.rate"] },
          { ...endpoint, id: "inactive", events: ["provider.recovered"], active: false },
        ],
      },
      fetchImpl,
      wait: noWait,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("emit() returns without throwing when every endpoint fails", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    expect(() => emit("provider.unhealthy", {}, { config, fetchImpl, wait: noWait })).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe("normalizeNotificationsConfig", () => {
  it("treats an empty subscription as all events, not none", () => {
    const cfg = normalizeNotificationsConfig({ endpoints: [{ url: "https://a.example/x" }] });
    expect(cfg.endpoints[0].events).toEqual(WEBHOOK_EVENTS);
  });

  it("drops urlless entries, unknown events and out-of-range thresholds", () => {
    const cfg = normalizeNotificationsConfig({
      enabled: "yes",
      endpoints: [{ url: "" }, null, { url: "https://a.example/x", events: ["nope", "high.error.rate"] }],
      errorRate: { threshold: 42, windowSeconds: 1, minSamples: 0 },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.endpoints).toHaveLength(1);
    expect(cfg.endpoints[0].events).toEqual(["high.error.rate"]);
    expect(cfg.errorRate).toEqual({ threshold: 0.5, windowSeconds: 300, minSamples: 20 });
  });
});

describe("watcher.evaluate", () => {
  const config = {
    enabled: true,
    endpoints: [endpoint],
    errorRate: { threshold: 0.5, windowSeconds: 300, minSamples: 20 },
  };
  const quiet = async () => ({ requests: 0, errors: 0 });

  async function run(state, connections, traffic = quiet) {
    const sent = [];
    const result = await evaluate({
      config,
      state,
      listConnections: async () => connections,
      trafficWindow: traffic,
      send: (event, data) => sent.push({ event, data }),
    });
    return { sent, result };
  }

  it("seeds the first sighting silently so a restart does not replay old incidents", async () => {
    const state = freshState();
    const { sent } = await run(state, [{ id: "c1", provider: "claude", degraded: true }]);
    expect(sent).toEqual([]);
    expect(state.degraded.get("c1")).toBe(true);
  });

  it("fires provider.unhealthy and provider.recovered on transitions only", async () => {
    const state = freshState();
    const healthy = [{ id: "c1", provider: "claude", name: "acct", degraded: false }];
    await run(state, healthy);

    const broke = await run(state, [{ ...healthy[0], degraded: true, testStatus: "unavailable", errorCode: 403 }]);
    expect(broke.sent.map((e) => e.event)).toEqual(["provider.unhealthy"]);
    expect(broke.sent[0].data).toMatchObject({ provider: "claude", connectionId: "c1", account: "acct", errorCode: 403 });

    const stillBroken = await run(state, [{ ...healthy[0], degraded: true }]);
    expect(stillBroken.sent).toEqual([]);

    const fixed = await run(state, healthy);
    expect(fixed.sent.map((e) => e.event)).toEqual(["provider.recovered"]);
  });

  it("treats a removed connection as gone, not as a recovery", async () => {
    const state = freshState();
    await run(state, [{ id: "c1", provider: "claude", degraded: true }]);
    const { sent } = await run(state, []);
    expect(sent).toEqual([]);
    expect(state.degraded.has("c1")).toBe(false);
  });

  it("fires high.error.rate once per crossing and never below minSamples", async () => {
    const state = freshState();
    const below = await run(state, [], async () => ({ requests: 4, errors: 4 }));
    expect(below.sent).toEqual([]);

    const crossed = await run(state, [], async () => ({ requests: 100, errors: 80 }));
    expect(crossed.sent.map((e) => e.event)).toEqual(["high.error.rate"]);
    expect(crossed.sent[0].data).toMatchObject({ rate: 0.8, threshold: 0.5, requests: 100, errors: 80 });

    const stillHigh = await run(state, [], async () => ({ requests: 100, errors: 90 }));
    expect(stillHigh.sent).toEqual([]);

    await run(state, [], async () => ({ requests: 100, errors: 1 }));
    const reFired = await run(state, [], async () => ({ requests: 100, errors: 90 }));
    expect(reFired.sent.map((e) => e.event)).toEqual(["high.error.rate"]);
  });

  it("swallows a source failure instead of propagating it", async () => {
    const result = await evaluate({
      config,
      state: freshState(),
      listConnections: async () => { throw new Error("db gone"); },
      trafficWindow: quiet,
      send: () => {},
    });
    expect(result).toMatchObject({ skipped: "error" });
  });
});
