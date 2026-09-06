// Elide filter: deterministic head+tail elision with an integrity marker for
// oversized tool_result blobs that match no structured filter. Contract pins:
//   - marker text exact (operators grep it): "\n[elided N chars · hmac <8hex> · head+tail preserved by tokenproxy]\n"
//   - N = exact elided char count; hmac = first 8 hex of HMAC-SHA256 of the
//     elided middle under a per-process key (SEC-1) — deterministic within one
//     process, not stable across restarts, and never equal to a bare sha256
//   - <= ELIDE_MIN_CHARS: no match (null), same convention as other filters
//   - never grows the input; is_error blocks are exempt via the framework guard
//   - wired as a size-based catch-all AFTER autodetect, never sniffed
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { compressMessages as compressWithPolicy } from "../../open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });
import { elide } from "../../open-sse/rtk/filters/elide.js";
import { ELIDE_MIN_CHARS } from "../../open-sse/rtk/constants.js";

// --- helpers ----------------------------------------------------------------

const sha8 = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
// SEC-1: the marker field is now hmac, not sha.
const MARKER_RE = /\n\[elided (\d+) chars · hmac ([0-9a-f]{8}) · head\+tail preserved by tokenproxy\]\n/;

// Compress a single Claude string-form tool_result block; returns the text
// before/after plus stats.
function compressOne(text, extra = {}) {
  const body = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: text, ...extra }] }] };
  const before = structuredClone(body);
  const stats = compressMessages(body, true);
  return {
    before: before.messages[0].content[0].content,
    after: body.messages[0].content[0].content,
    stats,
  };
}

// Split an elided output into { head, n, hmac, tail }; fails the test if the
// marker is absent or malformed.
function parseElided(out) {
  const m = out.match(MARKER_RE);
  expect(m, "marker must be present and exact").not.toBeNull();
  const head = out.slice(0, m.index);
  const tail = out.slice(m.index + m[0].length);
  return { head, n: Number(m[1]), hmac: m[2], tail };
}

// Assert the full contract for one elided blob against its original text.
function expectElidedConsistent(orig, out) {
  const { head, n, hmac, tail } = parseElided(out);
  expect(head).toBe(orig.slice(0, head.length));           // head verbatim
  expect(tail).toBe(orig.slice(orig.length - tail.length)); // tail verbatim
  const middle = orig.slice(head.length, orig.length - tail.length);
  expect(n).toBe(middle.length);                           // N exact
  expect(hmac).toMatch(/^[0-9a-f]{8}$/);                   // SEC-1: hmac field shape
  // SEC-1: within one process the HMAC is deterministic and content-bound —
  // eliding a middle-differing twin under an identical head/tail must not
  // reuse this marker.
  const twin = head + middle.split("").reverse().join("") + tail;
  if (twin.length === orig.length && twin !== orig && middle.length > 1) {
    expect(parseElided(compressOne(twin).after).hmac).not.toBe(hmac);
  }
  expect(out.length).toBeLessThan(orig.length);            // no-grow
  expect(out).toBe(
    head + `\n[elided ${n} chars · hmac ${hmac} · head+tail preserved by tokenproxy]\n` + tail
  ); // byte-exact composition
}

// 20KB single-line blob matching no structured filter.
const singleLineBlob = () => "x".repeat(20_000);

// 20KB multi-line blob with only 4 non-empty lines (5+ would route to
// dedup-log) and no filter signature (no colons, no leading . or /, no glyphs).
function multiLineBlob() {
  const line = (i) => `blob line ${i} lorem ipsum dolor sit amet padding words ${"y".repeat(4900)}`;
  return Array.from({ length: 4 }, (_, i) => line(i)).join("\n").slice(0, 20_000);
}

// --- tests ------------------------------------------------------------------

describe("elide: direct filter contract", () => {
  it("returns null at or below ELIDE_MIN_CHARS, elides above", () => {
    expect(elide("x".repeat(ELIDE_MIN_CHARS))).toBeNull();
    expect(elide("x".repeat(ELIDE_MIN_CHARS + 1))).not.toBeNull();
    expect(elide("short")).toBeNull();
  });

  it("never grows: for sampled sizes/shapes output is null or strictly smaller", () => {
    const cases = [singleLineBlob(), multiLineBlob(), "x".repeat(4001)];
    for (let len = 4001; len <= 20000; len += 997) {
      cases.push("q".repeat(len));
      cases.push(Array.from({ length: 4 }, () => "w".repeat(Math.ceil(len / 4))).join("\n").slice(0, len));
    }
    for (const t of cases) {
      const out = elide(t);
      expect(out === null || out.length < t.length).toBe(true);
    }
  });

  it("determinism: same input yields byte-identical output", () => {
    const t = multiLineBlob();
    expect(elide(t)).toBe(elide(t));
    const a = compressOne(singleLineBlob());
    const b = compressOne(singleLineBlob());
    expect(a.after).toBe(b.after);
  });
});

describe("elide: via compressMessages", () => {
  it("elides a 20KB single-line blob: head/tail verbatim, marker exact, N and sha correct", () => {
    const text = singleLineBlob();
    const { after, stats } = compressOne(text);
    expect(stats.hits.map((h) => h.filter)).toEqual(["elide"]);
    expectElidedConsistent(text, after);
    // single line: boundaries fall at the exact cuts
    const { head, tail } = parseElided(after);
    expect(head).toBe(text.slice(0, 1500));
    expect(tail).toBe(text.slice(text.length - 1000));
  });

  it("elides a 20KB multi-line blob: head/tail verbatim, marker exact, N and sha correct", () => {
    const text = multiLineBlob();
    expect(text.split("\n").length).toBeGreaterThan(1);
    const { after, stats } = compressOne(text);
    expect(stats.hits.map((h) => h.filter)).toEqual(["elide"]);
    expectElidedConsistent(text, after);
  });

  it("newline-boundary preference: head breaks at the nearest newline within 100 chars of the cut", () => {
    // first line is 1570 chars, so the 1500 cut lands mid-line and the
    // newline at 1570 is within the window
    const text = "a".repeat(1570) + "\n" + "b".repeat(10_000);
    const { after } = compressOne(text);
    const { head } = parseElided(after);
    expect(head.length).not.toBe(1500);              // broke at the boundary
    expect(head.length).toBe(1570);                  // exactly at the newline
    expect(text[head.length]).toBe("\n");
    expect(Math.abs(head.length - 1500)).toBeLessThanOrEqual(100);
    expectElidedConsistent(text, after);
  });

  it("newline-boundary: exact cut when no newline is near", () => {
    const text = singleLineBlob();
    const { after } = compressOne(text);
    expect(parseElided(after).head).toHaveLength(1500);
  });

  it(`boundary: exactly ${ELIDE_MIN_CHARS} chars is untouched, ${ELIDE_MIN_CHARS + 1} is elided`, () => {
    const exact = "x".repeat(ELIDE_MIN_CHARS);
    const r1 = compressOne(exact);
    expect(r1.after).toBe(exact);
    expect(r1.stats.hits).toEqual([]);

    const over = "x".repeat(ELIDE_MIN_CHARS + 1);
    const r2 = compressOne(over);
    expect(r2.stats.hits.map((h) => h.filter)).toEqual(["elide"]);
    expectElidedConsistent(over, r2.after);
  });

  it("content that autodetect handles still routes to its filter, not elide", () => {
    // git-log shaped blob, well over ELIDE_MIN_CHARS
    const PAD = "x".repeat(90);
    const text = Array.from({ length: 40 }, (_, i) =>
      `commit abc123${i}def\nAuthor: Dev ${i} <dev${i}@example.com>\nDate:   Sun Jul 6 10:00:0${i % 10} 2026 +0700\n\n    subject line number ${i}\n\n${PAD}\n${PAD}\n${PAD}\n`
    ).join("\n");
    expect(text.length).toBeGreaterThan(ELIDE_MIN_CHARS);
    const { stats } = compressOne(text);
    expect(stats.hits.map((h) => h.filter)).toEqual(["git-log"]);
  });

  it("is_error block is exempt: 20KB error blob stays byte-identical", () => {
    const text = singleLineBlob();
    const { after, stats } = compressOne(text, { is_error: true });
    expect(after).toBe(text);
    expect(stats.hits).toEqual([]);
  });

  it("stats: hit carries filter 'elide' and saved = before - after UTF-8 bytes", () => {
    const text = singleLineBlob();
    const { before, after, stats } = compressOne(text);
    expect(stats.hits).toHaveLength(1);
    expect(stats.hits[0].filter).toBe("elide");
    expect(stats.hits[0].saved).toBe(Buffer.byteLength(before) - Buffer.byteLength(after));
    expect(stats.bytesBefore - stats.bytesAfter).toBe(stats.hits[0].saved);
  });

  it("no-grow through the pipeline: an inflating rewrite is discarded", () => {
    // Guard exists at the filter level; at ELIDE_MIN_CHARS=4000 with head 1500
    // + tail 1000 + ~60-char marker it cannot trigger, so assert the pipeline
    // floor directly: smallest elidable blob still strictly shrinks.
    const text = "x".repeat(4001);
    const { after, stats } = compressOne(text);
    expect(stats.hits.map((h) => h.filter)).toEqual(["elide"]);
    expect(after.length).toBeLessThan(text.length);
    // and a 4001-char blob whose head+tail+marker would exceed it cannot be
    // constructed with these constants; assert the filter agrees (returns
    // null rather than growing) on the closest possible shape
    expect(elide(text) === null || elide(text).length < text.length).toBe(true);
  });
});

describe("elide: composed invariants", () => {
  const collectByKey = (node, key, out = []) => {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) { for (const item of node) collectByKey(item, key, out); return out; }
    if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
    for (const v of Object.values(node)) if (v && typeof v === "object") collectByKey(v, key, out);
    return out;
  };
  const json = (v) => JSON.stringify(v);

  function makeBody() {
    return {
      system: [{ type: "text", text: "You are a helpful agent.", cache_control: { type: "ephemeral", ttl: "5m" } }],
      tools: [{ name: "bash", description: "run shell commands", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        { role: "user", content: "The quick brown fox jumps over the lazy dog. ".repeat(40) },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the repository and report back shortly. ".repeat(40) },
            { type: "thinking", thinking: "step one, step two, step three. ".repeat(30), signature: "EqABC123sig==" },
            { type: "tool_use", id: "toolu_elide_1", name: "bash", input: { command: "cat blob.bin" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_elide_1", content: "z".repeat(120_000), cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "tool_result", tool_use_id: "toolu_err_1", is_error: true, content: "e".repeat(20_000) },
          ],
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    };
  }

  const body = makeBody();
  const before = structuredClone(body);
  const stats = compressMessages(body, true);

  it("the huge blob was elided (hit recorded, marker present)", () => {
    expect(stats.hits.map((h) => h.filter)).toContain("elide");
    expect(stats.hits.find((h) => h.filter === "elide").saved).toBeGreaterThan(0);
    expect(body.messages[2].content[0].content).toContain("[elided ");
    expectElidedConsistent(before.messages[2].content[0].content, body.messages[2].content[0].content);
  });

  it("message count, order, and roles unchanged", () => {
    expect(body.messages.length).toBe(before.messages.length);
    expect(body.messages.map((m) => m.role)).toEqual(before.messages.map((m) => m.role));
    expect(json(body.system)).toBe(json(before.system));
    expect(json(body.tools)).toBe(json(before.tools));
  });

  it("tool_use ids unchanged and still paired with exactly one tool_result", () => {
    const uses = [];
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (n.type === "tool_use") uses.push(n.id);
      Object.values(n).forEach(walk);
    };
    walk(body);
    expect(uses).toEqual(["toolu_elide_1"]);
    const resultIds = body.messages[2].content.map((b) => b.tool_use_id);
    expect(resultIds.filter((r) => r === "toolu_elide_1")).toHaveLength(1);
  });

  it("cache_control blocks byte-identical", () => {
    expect(collectByKey(body, "cache_control").map(json)).toEqual(
      collectByKey(before, "cache_control").map(json)
    );
  });

  it("thinking blocks and signatures untouched", () => {
    expect(json(collectByKey(body, "signature"))).toEqual(json(collectByKey(before, "signature")));
    const think = (root) => collectByKey(root, "type").filter((t) => t === "thinking").length;
    expect(think(body)).toBe(think(before));
  });

  it("is_error tool_result stays byte-identical inside the composed body", () => {
    expect(json(body.messages[2].content[1].content)).toBe(json(before.messages[2].content[1].content));
  });
});

// SEC-1: the marker authenticates the elided span with HMAC-SHA256 under a
// per-process key instead of a bare sha256, which was a brute-force oracle
// for low-entropy middles (probe recovered a 5-char middle in 2.6s).
describe("SEC-1: HMAC integrity marker", () => {
  it("marker carries hmac, never sha, and never equals the bare sha256 prefix", () => {
    const text = singleLineBlob();
    const { after } = compressOne(text);
    expect(after).not.toMatch(/· sha [0-9a-f]{8}/);
    const { hmac } = parseElided(after);
    const middle = text.slice(1500, text.length - 1000);
    expect(hmac).not.toBe(sha8(middle)); // not a bare hash of the middle
  });

  it("integrity holds within one process: same input, same marker", () => {
    const text = multiLineBlob();
    expect(parseElided(elide(text)).hmac).toBe(parseElided(elide(text)).hmac);
  });

  it("integrity is content-bound: a one-char middle change under identical head/tail changes the hmac", () => {
    const head = "h".repeat(1500);
    const tail = "t".repeat(1000);
    const a = head + "m".repeat(5000) + tail;
    const b = head + "n" + "m".repeat(4999) + tail;
    expect(parseElided(elide(a)).hmac).not.toBe(parseElided(elide(b)).hmac);
  });
});

// Audit finding 13: the tail boundary used to be able to land between the two
// UTF-16 units of an emoji, splitting a surrogate pair into the marker.
describe("elide never splits a surrogate pair at the tail boundary", () => {
  it("tail starting on a low surrogate advances past the whole pair", () => {
    // 4999 'a' + one emoji (2 UTF-16 units) + 999 'b': len = 6000, so the raw
    // tailStart (len - 1000 = 5000) is the emoji's LOW surrogate.
    const input = "a".repeat(4999) + "\u{1F600}" + "b".repeat(999);
    const out = compressOne(input).after;
    const parsed = parseElided(out);
    // The whole pair elides into the middle; the tail is the intact 999 'b's.
    expect(parsed.tail).toBe("b".repeat(999));
    expect(out.endsWith("b".repeat(999))).toBe(true);
    // No orphaned surrogate half survives anywhere in the output.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });
});
