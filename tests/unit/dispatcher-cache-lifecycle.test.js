import { describe, expect, it, vi } from "vitest";
import { createDispatcherCache, isLocalTransportPoolRefusal, LocalTransportPoolRefusal, revokeLocalTransportRefusalProof } from "open-sse/utils/dispatcherCache.js";

function resource(busy = false) {
  const state = { busy };
  return { state, isIdle: () => !state.busy, dispatcher: { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("dispatcher cache lifecycle", () => {
  it("brands only owned local refusals and can revoke proof after an earlier dispatch", () => {
    const actual = new LocalTransportPoolRefusal("transport_pool_capacity");
    expect(isLocalTransportPoolRefusal(actual)).toBe(true);
    expect(isLocalTransportPoolRefusal({ name: actual.name, code: actual.code, statusCode: 503 })).toBe(false);
    expect(isLocalTransportPoolRefusal(Object.create(LocalTransportPoolRefusal.prototype))).toBe(false);
    expect(isLocalTransportPoolRefusal(new Error(actual.message))).toBe(false);
    expect(isLocalTransportPoolRefusal(null)).toBe(false);
    revokeLocalTransportRefusalProof(actual); expect(isLocalTransportPoolRefusal(actual)).toBe(false);
  });
  it("reserves one cold construction synchronously and shares its exact result", async () => {
    const cache = createDispatcherCache(1), pending = deferred(), value = resource();
    const create = vi.fn(() => pending.promise);
    const leases = Array.from({ length: 32 }, () => cache.reserve("identity", create));
    await Promise.resolve(); expect(create).toHaveBeenCalledTimes(1);
    pending.resolve(value);
    expect(new Set(await Promise.all(leases.map(lease => lease.dispatcher)))).toEqual(new Set([value.dispatcher]));
    for (const lease of leases) { lease.release(); lease.release(); }
    await cache.close(); expect(value.dispatcher.close).toHaveBeenCalledTimes(1);
  });

  it("rejects new identities while an acquisition or body is active without closing either", async () => {
    const cache = createDispatcherCache(2), pending = deferred(), body = resource(true);
    const first = cache.reserve("constructing", () => pending.promise);
    const second = cache.reserve("body", async () => body); await second.dispatcher; second.release();
    expect(() => cache.reserve("overflow", async () => resource())).toThrow(expect.objectContaining({ code: "transport_pool_capacity", statusCode: 503 }));
    expect(body.dispatcher.close).not.toHaveBeenCalled(); expect(body.dispatcher.destroy).not.toHaveBeenCalled();
    pending.resolve(resource()); await first.dispatcher; first.release(); body.state.busy = false; await cache.close();
  });

  it("evicts an idle entry while preserving an older active stream", async () => {
    const cache = createDispatcherCache(2), busy = resource(true), idle = resource();
    const a = cache.reserve("a", async () => busy); await a.dispatcher; a.release();
    const b = cache.reserve("b", async () => idle); await b.dispatcher; b.release();
    const c = cache.reserve("c", async () => resource()); await c.dispatcher; c.release();
    expect(idle.dispatcher.close).toHaveBeenCalledTimes(1); expect(busy.dispatcher.close).not.toHaveBeenCalled();
    busy.state.busy = false; await cache.close();
  });

  it("waits for graceful close before allocating a replacement and retains the slot", async () => {
    const cache = createDispatcherCache(1), old = resource(), closing = deferred(), create = vi.fn(async () => resource());
    old.dispatcher.close.mockReturnValue(closing.promise);
    const a = cache.reserve("a", async () => old); await a.dispatcher; a.release();
    const b = cache.reserve("b", create); await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(() => cache.reserve("c", create)).toThrow(expect.objectContaining({ code: "transport_pool_capacity" }));
    closing.resolve(); await b.dispatcher; b.release(); expect(create).toHaveBeenCalledTimes(1); await cache.close();
  });

  it("releases failed construction so a later attempt can construct successfully", async () => {
    const cache = createDispatcherCache(1);
    const first = cache.reserve("a", async () => { throw new Error("construction failed"); });
    await expect(first.dispatcher).rejects.toThrow("construction failed"); first.release();
    const value = resource(), next = cache.reserve("a", async () => value);
    expect(await next.dispatcher).toBe(value.dispatcher); next.release(); await cache.close();
  });

  it("quarantines failed idle cleanup without losing ownership or leaking its secret error", async () => {
    const cache = createDispatcherCache(1), old = resource();
    old.dispatcher.close.mockRejectedValue(new Error("secret proxy credential")); old.dispatcher.destroy.mockRejectedValue(new Error("secret again"));
    const a = cache.reserve("a", async () => old); await a.dispatcher; a.release();
    const create = vi.fn(), b = cache.reserve("b", create);
    await expect(b.dispatcher).rejects.toThrow(expect.objectContaining({ code: "transport_pool_cleanup", message: "An idle transport pool could not be closed" })); b.release();
    expect(create).not.toHaveBeenCalled();
    expect(() => cache.reserve("c", create)).toThrow(expect.objectContaining({ code: "transport_pool_capacity" }));
    old.dispatcher.close.mockResolvedValue(); await cache.close(); expect(old.dispatcher.close).toHaveBeenCalledTimes(2);
  });

  it("gracefully waits for active shutdown and refuses subsequent admission", async () => {
    const cache = createDispatcherCache(1), active = resource(true), ending = deferred();
    active.dispatcher.close.mockReturnValue(ending.promise);
    const lease = cache.reserve("a", async () => active); await lease.dispatcher; lease.release();
    let finished = false; const closing = cache.close().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    expect(() => cache.reserve("a", async () => active)).toThrow(expect.objectContaining({ code: "transport_pools_closed" }));
    expect(active.dispatcher.destroy).not.toHaveBeenCalled(); ending.resolve(); await closing;
  });
});
