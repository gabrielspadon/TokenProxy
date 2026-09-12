import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(() => ({ ready: 1 })),
  credentialWrite: vi.fn(),
}));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({ get: state.query })),
}));
vi.mock("@/app/api/v1/models/catalogSnapshot.js", () => ({
  getPublicModelCatalogState: () => ({ available: true, running: false, updatedAt: "fixture" }),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: state.credentialWrite }));

describe("GET /api/ready", () => {
  beforeEach(() => {
    state.query.mockClear();
    state.credentialWrite.mockClear();
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
  });

  it("answers 1000 concurrent reads from local state while upstream work is stalled", async () => {
    const { GET } = await import("@/app/api/ready/route.js");
    const samples = await Promise.all(Array.from({ length: 1000 }, async () => {
      const started = performance.now();
      const response = await GET();
      return { response, elapsed: performance.now() - started };
    }));
    const responses = samples.map(({ response }) => response);
    const durations = samples.map(({ elapsed }) => elapsed).sort((a, b) => a - b);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(durations[Math.ceil(durations.length * 0.99) - 1]).toBeLessThan(100);
    expect(state.query).toHaveBeenCalledTimes(1000);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(state.credentialWrite).not.toHaveBeenCalled();
  });

  it("fails closed when the local store cannot answer", async () => {
    state.query.mockImplementationOnce(() => { throw new Error("local database unavailable"); });
    const { GET } = await import("@/app/api/ready/route.js");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, reason: "local-state-unavailable" });
  });
});
