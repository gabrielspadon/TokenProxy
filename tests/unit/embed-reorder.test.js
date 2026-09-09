import { describe, it, expect, vi, afterEach } from "vitest";
import { reorderByRelevance } from "../../open-sse/utils/embedReorder.js";

const OPTS = {
  query: "whale song frequency analysis",
  embedUrl: "http://embed.test/v1/embeddings",
  embedModel: "test-embed",
  keepRecentTurns: 2,
};

function keywordVec(text) {
  if (text.includes("whale")) return [0.95, 0.05, 0];
  if (text.includes("bird")) return [0.02, 0.98, 0];
  if (text.includes("fish")) return [0.01, 0.99, 0.1];
  return [0.5, 0.5, 0.5];
}

// Distinguishes 7 similarity levels (lvl0 nearest the query, lvl6 farthest)
// so a run of 7 pairs can be driven into an exact reversal.
function levelVec(text) {
  const m = String(text).match(/lvl(\d)/);
  const lvl = m ? Number(m[1]) : 0;
  return [6 - lvl, lvl];
}

function embedOk(vecFn = keywordVec) {
  return vi.fn(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map((text, index) => ({ index, embedding: vecFn(text) })),
      }),
    };
  });
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

const TAIL = [
  { role: "user", content: "current question" },
  { role: "assistant", content: "tail answer" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reorderByRelevance", () => {
  it("orders most relevant pairs nearest to the tail boundary", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song frequency research" },
      { role: "assistant", content: "whale songs carry across ocean basins" },
      { role: "user", content: "bird migration routes" },
      { role: "assistant", content: "birds migrate seasonally" },
      ...TAIL,
    ]);
    const fetchMock = embedOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await reorderByRelevance(messages, OPTS);

    expect(res.error).toBeUndefined();
    expect(res.messages).not.toBe(messages);
    expect(res.messages.slice(0, 4)).toEqual([
      messages[2],
      messages[3],
      messages[0],
      messages[1],
    ]);
    expect(res.messages[4]).toBe(messages[4]);
    expect(res.messages[5]).toBe(messages[5]);
    expect(res.moved).toBe(2);
    expect(res.notes[0].turn).toBe(2);
    expect(res.notes[0].similarity).toBeCloseTo(1, 3);
    expect(res.notes).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(req.model).toBe("test-embed");
    expect(req.input[0]).toBe(OPTS.query);
    expect(req.input).toHaveLength(3);
  });

  it("truncates notes beyond 5 moved pairs", async () => {
    const pairs = [];
    for (let lvl = 0; lvl <= 6; lvl++) {
      pairs.push(
        { role: "user", content: `case lvl${lvl} question` },
        { role: "assistant", content: `case lvl${lvl} answer` }
      );
    }
    const messages = deepFreeze([...pairs, ...TAIL]);
    vi.stubGlobal("fetch", embedOk(levelVec));

    const res = await reorderByRelevance(messages, { ...OPTS, query: "lvl0 relevance probe" });

    // 7 pairs reversed head-to-tail: the middle pair (lvl3) lands back on its
    // own slot, so 6 of the 7 pairs actually move.
    expect(res.moved).toBe(6);
    expect(res.notes).toHaveLength(6);
    expect(res.notes[5]).toEqual({ notesTruncated: true });
  });

  it("pins tool-bearing entries and reorders segments independently", async () => {
    const pinned = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }],
    };
    const messages = deepFreeze([
      { role: "user", content: "whale song frequency research" },
      { role: "assistant", content: "whale songs carry far" },
      pinned,
      { role: "user", content: "bird migration notes" },
      { role: "assistant", content: "birds migrate south" },
      ...TAIL,
    ]);
    vi.stubGlobal("fetch", embedOk());

    const res = await reorderByRelevance(messages, OPTS);

    expect(res.error).toBeUndefined();
    expect(res.messages[2]).toBe(pinned);
    // both segments are single pairs (length 1), below the >= 2 run
    // threshold, so the pinned entry leaves both untouched.
    expect(res.messages.slice(0, 2)).toEqual([messages[0], messages[1]]);
    expect(res.messages.slice(3, 5)).toEqual([messages[3], messages[4]]);
    expect(res.moved).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("reorders within a segment on both sides of a pinned entry", async () => {
    const pinned = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }],
    };
    const messages = deepFreeze([
      { role: "user", content: "whale song frequency research" },
      { role: "assistant", content: "whale songs carry across ocean basins" },
      { role: "user", content: "bird migration routes" },
      { role: "assistant", content: "birds migrate seasonally" },
      pinned,
      { role: "user", content: "whale pod behavior notes" },
      { role: "assistant", content: "whale pods travel together" },
      { role: "user", content: "bird nesting habits" },
      { role: "assistant", content: "birds nest in colonies" },
      ...TAIL,
    ]);
    vi.stubGlobal("fetch", embedOk());

    const res = await reorderByRelevance(messages, OPTS);

    expect(res.messages[4]).toBe(pinned);
    // each segment (2 pairs) is reordered on its own: least relevant first,
    // most relevant nearest that segment's own end.
    expect(res.messages.slice(0, 4)).toEqual([
      messages[2],
      messages[3],
      messages[0],
      messages[1],
    ]);
    expect(res.messages.slice(5, 9)).toEqual([
      messages[7],
      messages[8],
      messages[5],
      messages[6],
    ]);
    expect(res.messages[9]).toBe(messages[9]);
    expect(res.messages[10]).toBe(messages[10]);
    expect(res.moved).toBe(4);
  });

  it("never moves the protected tail, extending it to keep a split pair whole", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song frequency research" },
      { role: "assistant", content: "whale songs carry across ocean basins" },
      { role: "user", content: "bird migration routes" },
      { role: "assistant", content: "birds migrate seasonally" },
      { role: "user", content: "current question" },
    ]);
    vi.stubGlobal("fetch", embedOk());

    const res = await reorderByRelevance(messages, OPTS);

    // keepRecentTurns: 2 would naturally split the second pair (its user
    // half falls in history, its assistant half in the tail); the boundary
    // moves later so the final live user question is the only protected
    // entry and both historical pairs stay whole and reorderable.
    expect(res.messages[4]).toBe(messages[4]);
    expect(res.messages.slice(0, 2)).toEqual([messages[2], messages[3]]);
    expect(res.messages.slice(2, 4)).toEqual([messages[0], messages[1]]);
    expect(res.moved).toBe(2);
  });

  it("fails open on HTTP 500", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song one" },
      { role: "assistant", content: "bird song one" },
      { role: "user", content: "whale song two" },
      { role: "assistant", content: "bird song two" },
      ...TAIL,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    );
    const res = await reorderByRelevance(messages, OPTS);
    expect(res).toEqual({
      messages,
      moved: 0,
      notes: [],
      error: "service_http_error", outcome: "failed", errorCode: "service_http_error",
    });
  });

  it("fails open on timeout", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song one" },
      { role: "assistant", content: "bird song one" },
      { role: "user", content: "whale song two" },
      { role: "assistant", content: "bird song two" },
      ...TAIL,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      })
    );
    const res = await reorderByRelevance(messages, OPTS);
    expect(res.messages).toBe(messages);
    expect(res.moved).toBe(0);
    expect(res.error).toBe("service_timeout");
  });

  it("fails open on malformed response", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song one" },
      { role: "assistant", content: "bird song one" },
      { role: "user", content: "whale song two" },
      { role: "assistant", content: "bird song two" },
      ...TAIL,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    );
    const res = await reorderByRelevance(messages, OPTS);
    expect(res.messages).toBe(messages);
    expect(res.moved).toBe(0);
    expect(res.error).toBe("invalid_response");
  });

  it("fails open on zero vectors", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song one" },
      { role: "assistant", content: "bird song one" },
      { role: "user", content: "whale song two" },
      { role: "assistant", content: "bird song two" },
      ...TAIL,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: body.input.map((_, index) => ({ index, embedding: [0, 0, 0] })),
          }),
        };
      })
    );
    const res = await reorderByRelevance(messages, OPTS);
    expect(res.messages).toBe(messages);
    expect(res.moved).toBe(0);
    expect(res.error).toBe("invalid_response");
  });

  it("skips the fetch entirely on full cache hit", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song research" },
      { role: "assistant", content: "whale notes" },
      { role: "user", content: "bird migration notes" },
      { role: "assistant", content: "bird facts" },
      ...TAIL,
    ]);
    const cache = new Map();
    const fetchMock = embedOk();
    vi.stubGlobal("fetch", fetchMock);

    const first = await reorderByRelevance(messages, { ...OPTS, cache });
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await reorderByRelevance(messages, { ...OPTS, cache });

    expect(first.moved).toBe(2);
    expect(second.moved).toBe(2);
    expect(second.messages).toEqual(first.messages);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("passes through on short queries without fetching", async () => {
    const messages = [{ role: "user", content: "whale song" }];
    const fetchMock = embedOk();
    vi.stubGlobal("fetch", fetchMock);
    const res = await reorderByRelevance(messages, { ...OPTS, query: "hi there" });
    expect(res.messages).toBe(messages);
    expect(res.moved).toBe(0);
    expect(res.notes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through when no movable run reaches length 2", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song" },
      { role: "user", content: "bird song" },
    ]);
    const fetchMock = embedOk();
    vi.stubGlobal("fetch", fetchMock);
    const res = await reorderByRelevance(messages, { ...OPTS, keepRecentTurns: 1 });
    expect(res.messages).toBe(messages);
    expect(res.moved).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles empty input", async () => {
    const fetchMock = embedOk();
    vi.stubGlobal("fetch", fetchMock);
    const res = await reorderByRelevance([], OPTS);
    expect(res.messages).toEqual([]);
    expect(res.moved).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps roles alternating and every answer next to its original question", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song frequency research" },
      { role: "assistant", content: "whale songs carry across ocean basins" },
      { role: "user", content: "bird migration routes" },
      { role: "assistant", content: "birds migrate seasonally" },
      { role: "user", content: "fish scale patterns" },
      { role: "assistant", content: "fish scales vary by species" },
      ...TAIL,
    ]);
    vi.stubGlobal("fetch", embedOk());

    const res = await reorderByRelevance(messages, OPTS);

    for (let i = 0; i < res.messages.length - 1; i++) {
      if (res.messages[i].role === "user") {
        expect(res.messages[i + 1].role).toBe("assistant");
      }
    }
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role !== "user" || messages[i + 1].role !== "assistant") continue;
      const pos = res.messages.indexOf(messages[i]);
      expect(res.messages[pos + 1]).toBe(messages[i + 1]);
    }
  });

  it("replays a memoised order for known pairs and puts a newly appended pair last", async () => {
    const pairA = [
      { role: "user", content: "whale song frequency research" },
      { role: "assistant", content: "whale songs carry across ocean basins" },
    ];
    const pairB = [
      { role: "user", content: "bird migration routes" },
      { role: "assistant", content: "birds migrate seasonally" },
    ];
    const pairC = [
      { role: "user", content: "fish scale patterns" },
      { role: "assistant", content: "fish scales vary by species" },
    ];
    const memo = {};
    const cache = new Map();
    const fetchMock = embedOk();
    vi.stubGlobal("fetch", fetchMock);

    const messages1 = deepFreeze([...pairA, ...pairB, ...TAIL]);
    const first = await reorderByRelevance(messages1, {
      ...OPTS,
      memo,
      recompute: true,
      cache,
    });
    expect(first.moved).toBe(2);
    expect(first.messages.slice(0, 4)).toEqual([
      messages1[2],
      messages1[3],
      messages1[0],
      messages1[1],
    ]);
    const callsAfterFirst = fetchMock.mock.calls.length;

    // A new pair (C) appended right before the tail, with no embedding pass.
    const messages2 = deepFreeze([...pairA, ...pairB, ...pairC, ...TAIL]);
    const second = await reorderByRelevance(messages2, {
      ...OPTS,
      memo,
      recompute: false,
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(second.replayed).toBe(true);
    // known pairs (A, B) reproduce the first call's order
    expect(second.messages.slice(0, 4)).toEqual([
      messages2[2],
      messages2[3],
      messages2[0],
      messages2[1],
    ]);
    // the unseen pair (C) is unranked and stays in its last slot
    expect(second.messages.slice(4, 6)).toEqual([messages2[4], messages2[5]]);
    expect(second.messages.slice(6)).toEqual([messages2[6], messages2[7]]);
    expect(second.moved).toBe(2);
  });

  // PERFORMANCE-DELIVERY item 5: a preparation cache key carries the
  // configuration that produced the value. Two services answering to the same
  // model identifier hold different weights, so an operator who repoints the
  // embedding endpoint must not be served the previous service's vectors.
  it("keys cached vectors on the endpoint, not the model name alone", async () => {
    const messages = deepFreeze([
      { role: "user", content: "whale song frequency research" },
      { role: "assistant", content: "whale songs carry across ocean basins" },
      { role: "user", content: "bird migration routes" },
      { role: "assistant", content: "birds migrate seasonally" },
      ...TAIL,
    ]);
    const cache = new Map();
    const fetchMock = embedOk();
    vi.stubGlobal("fetch", fetchMock);

    await reorderByRelevance(messages, { ...OPTS, cache });
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Same endpoint, same model: served entirely from the cache.
    await reorderByRelevance(messages, { ...OPTS, cache });
    expect(fetchMock.mock.calls.length).toBe(afterFirst);

    // Different endpoint, same model name: must re-embed against the new one.
    await reorderByRelevance(messages, {
      ...OPTS,
      embedUrl: "http://other-embed.test/v1/embeddings",
      cache,
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(fetchMock.mock.calls.at(-1)[0]).toBe("http://other-embed.test/v1/embeddings");
  });
});
