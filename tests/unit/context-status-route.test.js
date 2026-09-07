import { describe, it, expect, vi, beforeEach } from "vitest";

const storeMocks = vi.hoisted(() => ({
  readAllContextStatuses: vi.fn(),
}));

vi.mock("open-sse/handlers/chatCore/contextStatusStore.js", () => ({
  readAllContextStatuses: storeMocks.readAllContextStatuses,
}));

import { GET } from "../../src/app/api/context-status/route.js";

function makeEntry(overrides = {}) {
  return {
    sid: "sess-1",
    rid: "req-1",
    ctxTokens: 12000,
    saveBytes: -3456,
    ceBytes: 789,
    dollarsSaved: 0.0042,
    epochHitRate: 0.83,
    volatileKeys: ["metadata"],
    compactHint: false,
    updatedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

describe("context-status route", () => {
  beforeEach(() => {
    storeMocks.readAllContextStatuses.mockReset();
  });

  it("returns entries newest-first with an ISO generatedAt", async () => {
    // store is newest-LAST; route must reverse to newest-first
    storeMocks.readAllContextStatuses.mockReturnValue([
      makeEntry({ sid: "old", updatedAt: "2026-09-01T00:00:00.000Z" }),
      makeEntry({ sid: "mid", updatedAt: "2026-09-03T00:00:00.000Z" }),
      makeEntry({ sid: "new", updatedAt: "2026-09-05T00:00:00.000Z" }),
    ]);

    const res = await GET({ url: "http://localhost/api/context-status" });
    expect(res.status).toBe(200);
    expect(storeMocks.readAllContextStatuses).toHaveBeenCalledWith({ strict: true });
    const body = await res.json();
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.entries.map((e) => e.sid)).toEqual(["new", "mid", "old"]);
    expect(body.entries[0]).toEqual({
      sid: "new",
      rid: "req-1",
      ctxTokens: 12000,
      ctxTokensActual: null,
      saveBytes: -3456,
      ceBytes: 789,
      dollarsSaved: 0.0042,
      epochHitRate: 0.83,
      volatileKeys: ["metadata"],
      compactHint: false,
      updatedAt: "2026-09-05T00:00:00.000Z",
    });
  });

  it("caps entries at 100, keeping the newest", async () => {
    storeMocks.readAllContextStatuses.mockReturnValue(
      Array.from({ length: 150 }, (_, i) => makeEntry({ sid: `s${i}` }))
    );

    const res = await GET({ url: "http://localhost/api/context-status" });
    const body = await res.json();
    expect(body.entries).toHaveLength(100);
    expect(body.entries[0].sid).toBe("s149");
    expect(body.entries.at(-1).sid).toBe("s50");
  });

  it.each([0, 18000, null, undefined, -1, Infinity, '18000'])("keeps observed input distinct from estimates for %s", async (value) => {
    storeMocks.readAllContextStatuses.mockReturnValue([makeEntry({ ctxTokens: 12000, ctxTokensActual: value })]);
    const body = await (await GET()).json();
    expect(body.entries[0].ctxTokens).toBe(12000);
    expect(body.entries[0].ctxTokensActual).toBe(typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
    expect(body.entries[0]).not.toHaveProperty('cacheSavedUsd');
  });

  it("null-sanitizes garbage fields and caps strings at 64 chars", async () => {
    storeMocks.readAllContextStatuses.mockReturnValue([
      {
        sid: 12345,
        rid: "r".repeat(100),
        ctxTokens: -5,
        saveBytes: NaN,
        ceBytes: Infinity,
        dollarsSaved: "lots",
        epochHitRate: -0.5,
        volatileKeys: "metadata",
        compactHint: "yes",
        updatedAt: null,
      },
    ]);

    const res = await GET({ url: "http://localhost/api/context-status" });
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual({
      sid: null,
      rid: "r".repeat(64),
      ctxTokens: null,
      ctxTokensActual: null,
      saveBytes: null,
      ceBytes: null,
      dollarsSaved: null,
      epochHitRate: null,
      volatileKeys: null,
      compactHint: null,
      updatedAt: null,
    });
  });

  it("returns 200 with an empty entries array for an empty store", async () => {
    storeMocks.readAllContextStatuses.mockReturnValue([]);

    const res = await GET({ url: "http://localhost/api/context-status" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
  });

  it("replies 503 when the store read throws", async () => {
    storeMocks.readAllContextStatuses.mockImplementation(() => {
      throw new Error("boom");
    });

    const res = await GET({ url: "http://localhost/api/context-status" });
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.error).toBe("context status unavailable");
    expect(body.entries).toBeUndefined();
  });
});
