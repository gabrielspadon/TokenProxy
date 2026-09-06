import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIG } from "../../open-sse/config/runtimeConfig.js";

const dispatcherSeam = vi.hoisted(() => {
  const state = {
    instances: [],
    directInstances: [],
    closeFailureByUri: new Map(),
  };

  class InjectedDispatcher {
    constructor(options) {
      this.options = options;
      this.activeWorkAborted = false;
      this.gracefulCloseRequested = false;
      this.close = vi.fn(() => {
        this.gracefulCloseRequested = true;
        const failure = state.closeFailureByUri.get(options.uri);
        if (failure?.kind === "sync") throw failure.error;
        return failure?.kind === "async" ? Promise.reject(failure.error) : Promise.resolve();
      });
      this.destroy = vi.fn(() => {
        this.activeWorkAborted = true;
        return Promise.resolve();
      });
      state.instances.push(this);
    }
  }

  class InjectedDirectDispatcher {
    constructor(options) {
      this.options = options;
      state.directInstances.push(this);
    }
  }

  return {
    InjectedDispatcher,
    InjectedDirectDispatcher,
    state,
    reset() {
      state.instances.length = 0;
      state.directInstances.length = 0;
      state.closeFailureByUri.clear();
    },
  };
});

const originalProxyTimeoutEnv = {
  connect: process.env.PROXY_CONNECT_TIMEOUT_MS,
  headers: process.env.PROXY_HEADERS_TIMEOUT_MS,
};

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// tests/ carries its own nested copy of undici (a transitive dependency pulled in
// by vitest's own toolchain) that shadows the project's root node_modules/undici
// when "undici" is resolved starting from a file under tests/. proxyFetch.js has
// no local node_modules, so its `import("undici")` always walks up to the ROOT
// copy — a different physical package than a bare `vi.mock("undici", ...)` would
// target from here, so the mock silently never intercepted anything the SUT
// touched. Resolve through proxyFetch.js's own location so the mock lands on the
// exact module id the SUT loads.
const undiciModulePath = vi.hoisted(() => {
  const { createRequire } = process.getBuiltinModule("node:module");
  return createRequire(new URL("../../open-sse/utils/proxyFetch.js", import.meta.url)).resolve("undici");
});

vi.mock(undiciModulePath, () => ({
  Agent: dispatcherSeam.InjectedDirectDispatcher,
  ProxyAgent: dispatcherSeam.InjectedDispatcher,
}));

let restoreHarness = null;

async function loadHarness() {
  const priorFetch = globalThis.fetch;
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
  globalThis.fetch = fetchSpy;
  dispatcherSeam.reset();
  vi.resetModules();
  const { proxyAwareFetch, closeTransportDispatchers } = await import("../../open-sse/utils/proxyFetch.js");

  restoreHarness = async () => {
    await closeTransportDispatchers?.();
    globalThis.fetch = priorFetch;
  };

  return { fetchSpy, proxyAwareFetch, closeTransportDispatchers };
}

async function fetchThrough(proxyAwareFetch, proxyUrl) {
  return proxyAwareFetch(
    "https://upstream.example/v1/chat/completions",
    { method: "POST" },
    {
      connectionProxyEnabled: true,
      connectionProxyUrl: proxyUrl,
      connectionNoProxy: "",
      strictProxy: true,
    },
  );
}

async function fetchDirect(proxyAwareFetch) {
  return proxyAwareFetch(
    "https://upstream.example/v1/chat/completions",
    { method: "POST" },
    { connectionProxyMode: "direct", strictProxy: true },
  );
}

async function fillDispatcherCache(proxyAwareFetch) {
  for (let index = 0; index < MEMORY_CONFIG.proxyDispatchersMaxSize; index += 1) {
    await fetchThrough(proxyAwareFetch, `http://proxy-${index}.example:8080`);
  }
}

beforeEach(() => {
  delete process.env.PROXY_CONNECT_TIMEOUT_MS;
  delete process.env.PROXY_HEADERS_TIMEOUT_MS;
});

afterEach(async () => {
  await restoreHarness?.();
  restoreHarness = null;
  restoreEnv("PROXY_CONNECT_TIMEOUT_MS", originalProxyTimeoutEnv.connect);
  restoreEnv("PROXY_HEADERS_TIMEOUT_MS", originalProxyTimeoutEnv.headers);
});

describe("proxy dispatcher cache eviction", () => {
  it("coalesces concurrent cold construction for one effective proxy", async () => {
    const { proxyAwareFetch, fetchSpy } = await loadHarness();
    await Promise.all(Array.from({ length: 32 }, () => fetchThrough(proxyAwareFetch, "http://cold.example:8080")));
    expect(new Set(fetchSpy.mock.calls.map(call => call[1].dispatcher)).size).toBe(1);
  });

  it("cancels one waiting caller without dispatching it or canceling another reservation", async () => {
    const { proxyAwareFetch, fetchSpy } = await loadHarness();
    const abort = new AbortController();
    const stopped = proxyAwareFetch("https://upstream.example/sample", { signal: abort.signal }, { enabled: true, url: "http://shared.example:8080", strictProxy: true });
    const continued = fetchThrough(proxyAwareFetch, "http://shared.example:8080");
    abort.abort(new DOMException("client stopped", "AbortError"));
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    await expect(continued).resolves.toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("revokes local-refusal proof if an earlier GET fallback already invoked transport", async () => {
    const { proxyAwareFetch, fetchSpy, closeTransportDispatchers } = await loadHarness();
    const { isLocalTransportPoolRefusal } = await import("open-sse/utils/dispatcherCache.js");
    fetchSpy.mockImplementationOnce(async () => { await closeTransportDispatchers(); throw new Error("synthetic transport failure"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await proxyAwareFetch("https://upstream.example/sample", {}, { enabled: true, url: "http://proof.example:8080", strictProxy: false }).catch(error => error);
      expect(result.code).toBe("transport_pools_closed");
      expect(isLocalTransportPoolRefusal(result)).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(dispatcherSeam.state.directInstances).toHaveLength(0);
    } finally { warn.mockRestore(); }
  });

  it("bounds concurrent distinct construction before dispatch", async () => {
    const { proxyAwareFetch, fetchSpy } = await loadHarness();
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => fetchThrough(proxyAwareFetch, `http://cold-${index}.example:8080`)));
    expect(results.filter(item => item.status === "rejected").map(item => item.reason.code ?? item.reason.message)).toEqual(Array(20).fill("transport_pool_capacity"));
    expect(new Set(fetchSpy.mock.calls.map(call => call[1].dispatcher)).size).toBe(MEMORY_CONFIG.proxyDispatchersMaxSize);
    expect(fetchSpy).toHaveBeenCalledTimes(MEMORY_CONFIG.proxyDispatchersMaxSize);
    for (const result of results.filter(item => item.status === "rejected")) {
      expect(result.reason.code).toBe("transport_pool_capacity");
    }
  });

  it("coalesces equivalent URL spelling but keeps proxy credentials distinct", async () => {
    const { proxyAwareFetch } = await loadHarness();
    await fetchThrough(proxyAwareFetch, "http://USER:password@PROXY.example:80");
    await fetchThrough(proxyAwareFetch, "http://USER:password@proxy.example/");
    expect(dispatcherSeam.state.instances).toHaveLength(1);
    await fetchThrough(proxyAwareFetch, "http://USER:other@proxy.example/");
    expect(dispatcherSeam.state.instances).toHaveLength(2);
  });

  it("uses one Happy Eyeballs Agent for intentional direct requests", async () => {
    const { fetchSpy, proxyAwareFetch } = await loadHarness();

    await fetchDirect(proxyAwareFetch);
    await fetchDirect(proxyAwareFetch);

    expect(dispatcherSeam.state.instances).toHaveLength(0);
    expect(dispatcherSeam.state.directInstances).toHaveLength(1);
    expect(dispatcherSeam.state.directInstances[0].options).toMatchObject({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 1000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][1].dispatcher).toBe(dispatcherSeam.state.directInstances[0]);
    expect(fetchSpy.mock.calls[1][1].dispatcher).toBe(dispatcherSeam.state.directInstances[0]);
  });

  it("reuses the dispatcher for a repeated normalized proxy identity", async () => {
    const { fetchSpy, proxyAwareFetch } = await loadHarness();
    const proxyUrl = "http://proxy-reused.example:8080";

    await fetchThrough(proxyAwareFetch, proxyUrl);
    await fetchThrough(proxyAwareFetch, proxyUrl);

    expect(dispatcherSeam.state.instances).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][1].dispatcher).toBe(dispatcherSeam.state.instances[0]);
    expect(fetchSpy.mock.calls[1][1].dispatcher).toBe(dispatcherSeam.state.instances[0]);
    expect(dispatcherSeam.state.instances[0].options).toMatchObject({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 1000,
    });
    expect(dispatcherSeam.state.instances[0].close).not.toHaveBeenCalled();
    expect(dispatcherSeam.state.instances[0].destroy).not.toHaveBeenCalled();
  });

  it("uses streaming-safe defaults for newly created proxy dispatchers", async () => {
    const { proxyAwareFetch } = await loadHarness();

    await fetchThrough(proxyAwareFetch, "http://proxy-defaults.example:8080");

    expect(dispatcherSeam.state.instances[0].options).toMatchObject({
      connectTimeout: 90_000,
      headersTimeout: 300_000,
      bodyTimeout: 0,
    });
  });

  it("accepts positive safe-integer proxy timeout overrides", async () => {
    process.env.PROXY_CONNECT_TIMEOUT_MS = " 120000 ";
    process.env.PROXY_HEADERS_TIMEOUT_MS = "600000";
    const { proxyAwareFetch } = await loadHarness();

    await fetchThrough(proxyAwareFetch, "http://proxy-overrides.example:8080");

    expect(dispatcherSeam.state.instances[0].options).toMatchObject({
      connectTimeout: 120_000,
      headersTimeout: 600_000,
      bodyTimeout: 0,
    });
  });

  it.each(["0", "-1", "1.5", "10junk", "9007199254740992", ""]) (
    "rejects invalid proxy timeout override %j",
    async (value) => {
      process.env.PROXY_CONNECT_TIMEOUT_MS = value;
      process.env.PROXY_HEADERS_TIMEOUT_MS = value;
      const { proxyAwareFetch } = await loadHarness();

      await fetchThrough(proxyAwareFetch, `http://proxy-invalid-${value || "empty"}.example:8080`);

      expect(dispatcherSeam.state.instances[0].options).toMatchObject({
        connectTimeout: 90_000,
        headersTimeout: 300_000,
        bodyTimeout: 0,
      });
    },
  );

  it("uses a separate dispatcher when effective timeout configuration changes", async () => {
    process.env.PROXY_CONNECT_TIMEOUT_MS = "120000";
    process.env.PROXY_HEADERS_TIMEOUT_MS = "600000";
    const { proxyAwareFetch } = await loadHarness();
    const proxyUrl = "http://proxy-cache-timeouts.example:8080";

    await fetchThrough(proxyAwareFetch, proxyUrl);
    process.env.PROXY_CONNECT_TIMEOUT_MS = "240000";
    process.env.PROXY_HEADERS_TIMEOUT_MS = "900000";
    await fetchThrough(proxyAwareFetch, proxyUrl);

    expect(dispatcherSeam.state.instances).toHaveLength(2);
    expect(dispatcherSeam.state.instances[0].options).toMatchObject({
      connectTimeout: 120_000,
      headersTimeout: 600_000,
      bodyTimeout: 0,
    });
    expect(dispatcherSeam.state.instances[1].options).toMatchObject({
      connectTimeout: 240_000,
      headersTimeout: 900_000,
      bodyTimeout: 0,
    });
  });

  it("promotes a cache hit so overflow closes B and retains the touched A", async () => {
    const { proxyAwareFetch } = await loadHarness();
    await fillDispatcherCache(proxyAwareFetch);
    const cachedDispatchers = [...dispatcherSeam.state.instances];
    const touched = cachedDispatchers[0];
    const leastRecentlyUsed = cachedDispatchers[1];

    await fetchThrough(proxyAwareFetch, "http://proxy-0.example:8080");
    await fetchThrough(proxyAwareFetch, "http://proxy-overflow.example:8080");
    await Promise.resolve();

    expect(leastRecentlyUsed.close).toHaveBeenCalledTimes(1);
    expect(touched.close).not.toHaveBeenCalled();
    expect(touched.destroy).not.toHaveBeenCalled();
    for (const retained of [...cachedDispatchers.slice(2), touched]) {
      expect(retained.close).not.toHaveBeenCalled();
      expect(retained.destroy).not.toHaveBeenCalled();
    }
  });

  it("gracefully closes only the evicted dispatcher without aborting active work", async () => {
    const { proxyAwareFetch } = await loadHarness();
    await fillDispatcherCache(proxyAwareFetch);
    const cachedDispatchers = [...dispatcherSeam.state.instances];

    await fetchThrough(proxyAwareFetch, "http://proxy-overflow.example:8080");
    await Promise.resolve();

    expect(dispatcherSeam.state.instances).toHaveLength(MEMORY_CONFIG.proxyDispatchersMaxSize + 1);
    expect(cachedDispatchers[0].close).toHaveBeenCalledTimes(1);
    expect(cachedDispatchers[0].gracefulCloseRequested).toBe(true);
    expect(cachedDispatchers[0].activeWorkAborted).toBe(false);
    expect(cachedDispatchers[0].destroy).not.toHaveBeenCalled();
    for (const retained of cachedDispatchers.slice(1)) {
      expect(retained.close).not.toHaveBeenCalled();
      expect(retained.destroy).not.toHaveBeenCalled();
    }
    expect(dispatcherSeam.state.instances.at(-1).close).not.toHaveBeenCalled();
    expect(dispatcherSeam.state.instances.at(-1).destroy).not.toHaveBeenCalled();
  });

  it("reclaims an idle dispatcher after a synchronous close failure before replacing it", async () => {
    const { proxyAwareFetch } = await loadHarness();
    const failure = new Error("synthetic synchronous close failure");
    dispatcherSeam.state.closeFailureByUri.set(
      "http://proxy-0.example:8080",
      { kind: "sync", error: failure },
    );

    await fillDispatcherCache(proxyAwareFetch);
    const evicted = dispatcherSeam.state.instances[0];

    await expect(
      fetchThrough(proxyAwareFetch, "http://proxy-overflow.example:8080"),
    ).resolves.toMatchObject({ ok: true });

    expect(evicted.close).toHaveBeenCalledTimes(1);
    expect(evicted.destroy).toHaveBeenCalledTimes(1);
    expect(dispatcherSeam.state.instances).toHaveLength(MEMORY_CONFIG.proxyDispatchersMaxSize + 1);
  });

  it("owns an evicted dispatcher's rejected close promise", async () => {
    const { proxyAwareFetch } = await loadHarness();
    const rejection = new Error("synthetic asynchronous close failure");
    dispatcherSeam.state.closeFailureByUri.set(
      "http://proxy-0.example:8080",
      { kind: "async", error: rejection },
    );
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await fillDispatcherCache(proxyAwareFetch);
      const evicted = dispatcherSeam.state.instances[0];

      await fetchThrough(proxyAwareFetch, "http://proxy-overflow.example:8080");
      await new Promise((resolve) => setImmediate(resolve));

      expect(evicted.close).toHaveBeenCalledTimes(1);
      expect(evicted.destroy).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
