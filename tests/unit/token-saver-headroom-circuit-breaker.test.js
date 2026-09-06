// Failure modes and circuit breaker: open-sse/rtk/headroom.js.
// Contract as written: CB_FAILURE_THRESHOLD = 2, CB_COOLDOWN_MS = 30000 — TWO
// consecutive failures open the breaker and the THIRD request is the one
// short-circuited (the task brief said "three"; the code says two — the tests
// pin the code). All failure paths are fail-open: null result, body untouched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  compressWithHeadroom as compressWithPolicy,
  resetHeadroomCircuitBreaker,
} from "../../open-sse/rtk/headroom.js";
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });

const PROXY = "http://127.0.0.1:8787";
const BIG = "x".repeat(2000);

function okRes(messages) {
  return new Response(
    JSON.stringify({ messages, tokens_before: 100000, tokens_after: 5000, tokens_saved: 95000 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function body() {
  return { model: "m", messages: [{ role: "assistant", content: BIG }, { role: "user", content: "Current request." }] };
}

async function call(b = body()) {
  const diagnostics = {};
  const result = await compressWithHeadroom(b, {
    enabled: true, url: PROXY, model: "m", format: "openai", diagnostics,
  });
  return { b, result, diagnostics };
}

beforeEach(() => {
  resetHeadroomCircuitBreaker();
  vi.spyOn(Date, "now");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetHeadroomCircuitBreaker();
});

describe("fail-open failure modes (body untouched, no throw)", () => {
  it("proxy HTTP 500 → null, body unchanged", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    const { b, result, diagnostics } = await call();
    expect(result).toBeNull();
    expect(b.messages[0].content).toBe(BIG);
    expect(JSON.stringify(diagnostics)).toContain("HTTP 500");
  });

  it("fetch timeout/reject → null, body unchanged", async () => {
    global.fetch = vi.fn(async () => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const { b, result } = await call();
    expect(result).toBeNull();
    expect(b.messages[0].content).toBe(BIG);
  });

  it("malformed JSON from proxy → null via outer catch, body unchanged", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response("this is not json {{{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { b, result, diagnostics } = await call();
    expect(result).toBeNull();
    expect(b.messages[0].content).toBe(BIG);
    expect(JSON.stringify(diagnostics)).toContain("unexpected error");
  });

  it("proxy returns object without messages[] → null, body unchanged", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ tokens_before: 1, tokens_after: 0, tokens_saved: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { b, result, diagnostics } = await call();
    expect(result).toBeNull();
    expect(b.messages[0].content).toBe(BIG);
    expect(JSON.stringify(diagnostics)).toContain("missing messages[]");
  });
});

describe("circuit breaker", () => {
  it("opens after TWO consecutive failures; third request is short-circuited without fetch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    global.fetch = fetchMock;

    await call(); // failure 1
    await call(); // failure 2 — breaker now open
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const { result, diagnostics } = await call();
    expect(fetchMock).toHaveBeenCalledTimes(2); // NOT called again
    expect(result).toBeNull();
    expect(JSON.stringify(diagnostics)).toContain("circuit breaker active");
  });

  it("a success after failures closes the breaker and clears the count", async () => {
    let mode = "fail";
    global.fetch = vi.fn(async () => {
      if (mode === "fail") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return okRes([{ role: "assistant", content: "ok" }, { role: "user", content: "Current request." }]);
    });

    await call(); // failure 1
    await call(); // failure 2 → open

    // advance past the 30s cooldown so the success call is allowed through
    Date.now.mockReturnValue(Date.now() + 31000);
    mode = "ok";
    const { result } = await call();
    expect(result).not.toBeNull();

    // breaker cleared: next call fetches again immediately
    Date.now.mockReturnValue(Date.now());
    const second = await call();
    expect(second.result).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(4); // 2 fails + 2 successes
  });

  it("is keyed per endpoint, resettable via resetHeadroomCircuitBreaker", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    global.fetch = fetchMock;
    await call();
    await call();

    resetHeadroomCircuitBreaker();
    Date.now.mockReturnValue(0); // any timestamp works once cleared

    const { result } = await call();
    expect(global.fetch).toHaveBeenCalledTimes(3); // fetch attempted again after reset
    expect(result).toBeNull(); // still a 500, but NOT blocked
  });
});
