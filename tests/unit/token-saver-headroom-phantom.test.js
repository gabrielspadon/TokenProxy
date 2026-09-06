// Phantom-savings contract: isHeadroomPhantomSavings (open-sse/rtk/headroom.js)
// plus the in-band gates inside callCompress and each format branch. Tests pin
// the EXACT contract as written, quirks included — see report for findings.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  compressWithHeadroom as compressWithPolicy,
  isHeadroomPhantomSavings,
} from "../../open-sse/rtk/headroom.js";
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });

const PROXY = "http://127.0.0.1:8787";
const BIG = "x".repeat(2000);

function res(json, status = 200) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isHeadroomPhantomSavings unit contract", () => {
  const diag = (before, after) => ({ before: { bodyBytes: before }, after: { bodyBytes: after } });

  it("tokens_saved>0 AND after >= before*0.95 (bytes) → phantom", () => {
    expect(
      isHeadroomPhantomSavings(
        { tokens_before: 10000, tokens_after: 9000, tokens_saved: 1000 },
        diag(10000, 9600),
      ),
    ).toBe(true);
  });

  it("tokens_saved>0 AND after < before*0.95 (bytes) → NOT phantom", () => {
    expect(
      isHeadroomPhantomSavings(
        { tokens_before: 10000, tokens_after: 9000, tokens_saved: 1000 },
        diag(10000, 9000),
      ),
    ).toBe(false);
  });

  it("after < before*0.95 but tokens_saved=0 → NOT phantom by this function", () => {
    // Exact contract: the tokens_saved>0 guard short-circuits first. (The
    // in-band gate in callCompress separately rejects tokens_saved<=0, so a
    // zero-claim never reaches commit — but THIS function reports false.)
    expect(
      isHeadroomPhantomSavings(
        { tokens_before: 10000, tokens_after: 5000, tokens_saved: 0 },
        diag(10000, 5000),
      ),
    ).toBe(false);
  });

  it("tokens_saved absent/NaN → NOT phantom", () => {
    expect(isHeadroomPhantomSavings({ tokens_before: 100, tokens_after: 1 }, diag(100, 1))).toBe(false);
    expect(isHeadroomPhantomSavings({ tokens_saved: "abc", tokens_before: 100, tokens_after: 1 }, diag(100, 1))).toBe(false);
  });

  it("zero/missing byte snapshots → NOT phantom", () => {
    expect(
      isHeadroomPhantomSavings({ tokens_saved: 5, tokens_before: 100, tokens_after: 1 }, { before: { bodyBytes: 0 }, after: { bodyBytes: 50 } }),
    ).toBe(false);
    expect(
      isHeadroomPhantomSavings({ tokens_saved: 5, tokens_before: 100, tokens_after: 1 }, null),
    ).toBe(false);
  });

  it("custom minShrinkRatio shifts the byte threshold", () => {
    // 10000 -> 8000 is 20% shrink; with minShrinkRatio 0.25 the 8000-byte
    // after must be < 7500 to escape phantom, so 8000 >= 7500 → phantom.
    expect(
      isHeadroomPhantomSavings(
        { tokens_saved: 10, tokens_before: 10000, tokens_after: 8000 },
        diag(10000, 8000),
        0.25,
      ),
    ).toBe(true);
    expect(
      isHeadroomPhantomSavings(
        { tokens_saved: 10, tokens_before: 10000, tokens_after: 8000 },
        diag(10000, 7400),
        0.25,
      ),
    ).toBe(false);
  });
});

describe("in-band phantom gate: proxy claims savings but body barely shrinks", () => {
  it("keeps original when claimed token shrink is under 5%", async () => {
    const body = { model: "m", messages: [{ role: "user", content: BIG }] };
    const original = JSON.parse(JSON.stringify(body));
    global.fetch = vi.fn(async () =>
      res({
        messages: [{ role: "user", content: "shrunk a little" }],
        tokens_before: 1000,
        tokens_after: 980,
        tokens_saved: 20,
      }),
    );
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true, url: PROXY, model: "m", format: "openai", diagnostics,
    });
    expect(result).toBeNull();
    expect(body).toEqual(original);
    expect(JSON.stringify(diagnostics)).toContain("phantom savings");
  });

  it("keeps original on conflicting metrics: big token claim, <5% byte shrink", async () => {
    // Proxy claims 50% token savings but the committed body only loses ~2% of
    // its bytes — the byte phantom gate catches the lie.
    const body = { model: "m", messages: [{ role: "user", content: BIG }] };
    const original = JSON.parse(JSON.stringify(body));
    global.fetch = vi.fn(async () =>
      res({
        messages: [{ role: "user", content: "x".repeat(1900) }],
        tokens_before: 100000,
        tokens_after: 50000,
        tokens_saved: 50000,
      }),
    );
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true, url: PROXY, model: "m", format: "openai", diagnostics,
    });
    expect(result).toBeNull();
    expect(body).toEqual(original);
    expect(JSON.stringify(diagnostics)).toContain(">95% size");
  });

  it("keeps original when proxy reports zero/negative savings", async () => {
    const body = { model: "m", messages: [{ role: "user", content: BIG }] };
    const original = JSON.parse(JSON.stringify(body));
    global.fetch = vi.fn(async () =>
      res({
        messages: [{ role: "user", content: "ok" }],
        tokens_before: 1000,
        tokens_after: 990,
        tokens_saved: 0,
      }),
    );
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true, url: PROXY, model: "m", format: "openai", diagnostics,
    });
    expect(result).toBeNull();
    expect(body).toEqual(original);
    expect(JSON.stringify(diagnostics)).toContain("no token saving");
  });
});
