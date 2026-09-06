import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  isNoAuthProvider: () => false,
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "connection-3075",
    provider: "provider-3075",
    backoffLevel: 2,
  }]);
});

describe("account reset metadata precedence (PR #3075)", () => {
  it("does not persist or replay a malformed request with future reset metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T16:00:00.000Z"));

    try {
      const result = await markAccountUnavailable(
        "connection-3075",
        400,
        JSON.stringify({ error: { type: "invalid_request_error", message: "messages[0] is malformed" } }),
        "provider-3075",
        "provider-3075/model",
        Date.parse("2026-08-31T16:10:00.000Z"),
      );

      expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
      expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a precise future reset for a genuine 429 rate limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T16:00:00.000Z"));

    try {
      const result = await markAccountUnavailable(
        "connection-3075",
        429,
        "rate limit exceeded",
        "provider-3075",
        "provider-3075/model",
        Date.parse("2026-08-31T16:10:00.000Z"),
      );

      expect(result).toEqual({ shouldFallback: true, cooldownMs: 600000, failureClass: 'rate', retrySameAccount: false, mustWait: true });
      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "connection-3075",
        expect.objectContaining({
          "modelLock_provider-3075/model": "2026-08-31T16:10:00.000Z",
          backoffLevel: 0,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
