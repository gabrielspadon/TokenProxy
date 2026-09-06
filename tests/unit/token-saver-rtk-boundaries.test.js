// Size-boundary behavior of compressMessages: MIN_COMPRESS_SIZE (500) and
// RAW_CAP (10 MiB) edges, plus the zero-compressible-block no-op path.
import { describe, it, expect } from "vitest";
import { compressMessages as compressWithPolicy, formatRtkLog } from "../../open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });
import { MIN_COMPRESS_SIZE, RAW_CAP } from "../../open-sse/rtk/constants.js";

// Grep-shaped lines of exactly 30 chars each, so any length is prefix-able.
const UNIT = (i) => `src/f.js:${i}:` + "p".repeat(18) + "\n";
function buildGrepLike(n) {
  let t = "";
  let i = 1;
  while (t.length + 30 <= n) {
    t += UNIT(i++);
  }
  return t + "q".repeat(n - t.length);
}

const wrapTool = (t) => ({ messages: [{ role: "tool", tool_call_id: "c1", content: t }] });

describe("MIN_COMPRESS_SIZE boundary", () => {
  it(`exactly ${MIN_COMPRESS_SIZE - 1}B is skipped byte-identical, no hits`, () => {
    const text = buildGrepLike(MIN_COMPRESS_SIZE - 1);
    const body = wrapTool(text);
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  it(`exactly ${MIN_COMPRESS_SIZE}B is compressed`, () => {
    const text = buildGrepLike(MIN_COMPRESS_SIZE);
    const body = wrapTool(text);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(1);
    expect(stats.hits[0].filter).toBe("grep");
    expect(body.messages[0].content).not.toBe(text);
    expect(body.messages[0].content.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RAW_CAP boundary", () => {
  it(`exactly ${RAW_CAP}B (10 MiB) is still attempted and compresses`, () => {
    const text = buildGrepLike(RAW_CAP);
    const body = wrapTool(text);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(1);
    expect(body.messages[0].content.length).toBeLessThan(text.length);
  });

  it(`${RAW_CAP + 1}B (10 MiB + 1) is skipped byte-identical, no hits`, () => {
    const text = buildGrepLike(RAW_CAP + 1);
    const body = wrapTool(text);
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(stats.bytesBefore).toBe(RAW_CAP + 1); // counted, but not compressed
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });
});

describe("zero compressible blocks", () => {
  it("body with only user/system text: untouched, empty stats, null log line", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello there" },
        { role: "assistant", content: "hi, how can I help" },
      ],
    };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
    expect(stats).toEqual({ bytesBefore: 0, bytesAfter: 0, hits: [], mode: "lossy-opt-in", semanticPreserving: true });
    expect(formatRtkLog(stats)).toBeNull();
  });

  it("body with tool results under MIN_COMPRESS_SIZE: untouched, no hits", () => {
    const body = {
      messages: [
        { role: "tool", tool_call_id: "a", content: "tiny result one" },
        { role: "tool", tool_call_id: "b", content: [{ type: "text", text: "tiny result two" }] },
      ],
    };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
    // both small blocks were counted in the byte ledger even though untouched
    expect(stats.bytesBefore).toBe("tiny result one".length + "tiny result two".length);
    expect(stats.bytesAfter).toBe(stats.bytesBefore);
  });
});

describe("disabled path", () => {
  it("enabled=false returns null and leaves the body untouched", () => {
    const body = wrapTool(buildGrepLike(5000));
    const before = structuredClone(body);
    expect(compressMessages(body, false)).toBeNull();
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  it("enabled=true without a messages/input array returns null", () => {
    expect(compressMessages({ foo: "bar" }, true)).toBeNull();
  });
});
