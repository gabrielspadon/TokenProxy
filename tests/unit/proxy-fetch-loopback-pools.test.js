import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransportLoopback } from "../helpers/transport-loopback.mjs";
import { MEMORY_CONFIG } from "open-sse/config/runtimeConfig.js";

let fixture, transport;
beforeEach(async () => { fixture = await createTransportLoopback(); vi.resetModules(); transport = await import("open-sse/utils/proxyFetch.js"); });
afterEach(async () => { fixture.finish(); await transport.closeTransportDispatchers(); await fixture.close(); });
const route = (identity = 0, strictProxy = true) => ({ enabled: true, url: fixture.proxyUrl.replace("//", `//user${identity}:fake@`), strictProxy });
const target = path => `http://transport.fixture.test${path}`;

describe("actual loopback proxy pool lifecycle", () => {
  it('closes a timed-out metadata body while another owner keeps its stream', async () => {
    const owner = new AbortController();
    const expired = await transport.proxyAwareFetch(target('/long'), {}, { ...route(), signal: owner.signal });
    const healthy = await transport.proxyAwareFetch(target('/long'), {}, route());
    const failedBody = expired.text().catch(error => error);
    const started = performance.now();
    owner.abort(new DOMException('metadata timeout', 'TimeoutError'));
    expect(await failedBody).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(fixture.stats.closedBodies).toBe(1), { interval: 5, timeout: 900 });
    expect(performance.now() - started).toBeLessThan(1000);
    const reader = healthy.body.getReader();
    expect(await reader.read()).toMatchObject({ done: false });
    reader.releaseLock();
  });

  it("stops pending construction at shutdown before upstream dispatch and refuses later direct work", async () => {
    const pending = transport.proxyAwareFetch(target("/sample"), {}, route());
    const closing = transport.closeTransportDispatchers();
    const failure = await pending.catch(error => error);
    const { isLocalTransportPoolRefusal } = await import("open-sse/utils/dispatcherCache.js");
    expect(failure.code).toBe("transport_pools_closed"); expect(isLocalTransportPoolRefusal(failure)).toBe(true);
    await closing;
    await expect(transport.proxyAwareFetch(`${fixture.originUrl}/sample`)).rejects.toMatchObject({ code: "transport_pools_closed" });
    expect(fixture.stats.requests).toBe(0); expect(fixture.stats.connects).toBe(0);
  });

  it("keeps active response bodies available through cache pressure and reuses a canceled slot", async () => {
    const bodies = [];
    try {
      for (let id = 0; id < MEMORY_CONFIG.proxyDispatchersMaxSize; id++) bodies.push(await transport.proxyAwareFetch(target("/long"), {}, route(id)));
      const before = fixture.stats.connects;
      await expect(transport.proxyAwareFetch(target("/sample"), {}, route(100, false))).rejects.toMatchObject({ code: "transport_pool_capacity" });
      expect(fixture.stats.connects).toBe(before); expect(fixture.stats.closedBodies).toBe(0);
      await bodies[0].body.cancel("free one slot");
      await vi.waitFor(() => expect(fixture.stats.closedBodies).toBe(1));
      const next = await transport.proxyAwareFetch(target("/sample"), {}, route(100));
      expect(await next.text()).toBe("verified response");
      const activeReader = bodies[1].body.getReader();
      expect(await activeReader.read()).toMatchObject({ done: false }); activeReader.releaseLock();
    } finally { fixture.finish(); }
  });

  it("preserves slow-reader backpressure and cancels an unfinished large body promptly", async () => {
    const response = await transport.proxyAwareFetch(target("/bulk"), {}, route());
    const reader = response.body.getReader();
    for (let n = 0; n < 3; n++) { expect((await reader.read()).value.length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 5)); }
    expect(fixture.stats.bulkWritten).toBeLessThan(fixture.bulkBytes);
    const start = performance.now(); await reader.cancel("client stopped"); reader.releaseLock();
    await vi.waitFor(() => expect(fixture.stats.closedBulkBodies).toBe(1), { interval: 5 });
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("preserves unread but transport-complete response bodies after idle eviction", async () => {
    const responses = [];
    for (let id = 0; id <= MEMORY_CONFIG.proxyDispatchersMaxSize; id++) {
      responses.push(await transport.proxyAwareFetch(target("/sample"), {}, route(id)));
    }
    for (const response of responses) expect(await response.text()).toBe("verified response");
  });

  it("separates origin authority and proxy authentication while sharing each effective route", async () => {
    const first = await transport.proxyAwareFetch(target("/sample"), {}, route(1)); expect(await first.text()).toBe("verified response");
    const second = await transport.proxyAwareFetch("http://other.fixture.test/sample", {}, route(1)); expect(await second.text()).toBe("verified response");
    const third = await transport.proxyAwareFetch(target("/sample"), {}, route(2)); await third.text();
    expect(first.headers.get("x-fixture-host")).toBe("transport.fixture.test");
    expect(second.headers.get("x-fixture-host")).toBe("other.fixture.test");
    expect(fixture.stats.authorities).toContain("other.fixture.test:80");
    expect(new Set(fixture.stats.proxyAuth).size).toBe(2);
  });

  it("keeps explicit direct dispatchers and loopback bypass untouched", async () => {
    const { Agent } = await import("undici"); const dispatcher = new Agent();
    try {
      const response = await transport.proxyAwareFetch(`${fixture.originUrl}/sample`, { dispatcher }, route());
      expect(await response.text()).toBe("verified response"); expect(fixture.stats.connects).toBe(0);
    } finally { await dispatcher.close(); }
  });
});
