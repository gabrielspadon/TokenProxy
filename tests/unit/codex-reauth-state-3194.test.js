import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  resolveProviderId: (provider) => provider === "codex-alias" ? "codex" : provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const PERMANENT_CODEX_MARKERS = [
  "invalidated oauth token",
  "authentication token has been invalidated",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "refresh token already used",
];

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let connectionsRepo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-codex-reauth-"));
  process.env.DATA_DIR = tempDir;
  connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");
});

afterAll(() => {
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "codex-a",
    provider: "codex",
    name: "Codex A",
    backoffLevel: 3,
  }]);
});

describe("Codex permanently invalid OAuth state (#3194)", () => {
  for (const marker of PERMANENT_CODEX_MARKERS) {
    it(`quarantines a resolved Codex 401 containing ${marker}`, async () => {
      const result = await markAccountUnavailable(
        "codex-a",
        401,
        { error: { message: `OpenAI reported ${marker}`, token: "must-not-persist" } },
        "codex-alias",
        "gpt-5.6-sol",
      );

      expect(result).toEqual({ shouldFallback: true, cooldownMs: 0, failureClass: 'credential', retrySameAccount: false, mustWait: false });
      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "codex-a",
        expect.objectContaining({
          isActive: false,
          testStatus: "reauth_required",
          errorCode: 401,
          backoffLevel: 0,
          lastError: `OpenAI reported ${marker}`,
        }),
      );
      const update = dbMocks.updateProviderConnection.mock.calls[0][1];
      expect(update.lastError).not.toContain("must-not-persist");
      expect(Object.keys(update).some((key) => key.startsWith("modelLock_"))).toBe(false);
    });
  }

  it("keeps an ordinary Codex 401 model-scoped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T15:00:00.000Z"));

    try {
      await markAccountUnavailable(
        "codex-a",
        401,
        "Authorization header rejected",
        "codex",
        "gpt-5.6-sol",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "codex-a",
        expect.objectContaining({
          "modelLock_gpt-5.6-sol": "2026-08-31T15:02:00.000Z",
          testStatus: "unavailable",
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1].isActive).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps non-Codex invalidation markers model-scoped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T15:00:00.000Z"));

    try {
      await markAccountUnavailable(
        "codex-a",
        401,
        "authentication token has been invalidated",
        "other-provider",
        "other-model",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "codex-a",
        expect.objectContaining({
          "modelLock_other-model": "2026-08-31T15:02:00.000Z",
          testStatus: "unavailable",
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1].isActive).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the same Codex OAuth profile and clears stale failure state", async () => {
    const original = await connectionsRepo.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      email: "reauth@example.test",
      providerSpecificData: { chatgptAccountId: "acct-reauth" },
    });
    await connectionsRepo.updateProviderConnection(original.id, {
      isActive: false,
      testStatus: "reauth_required",
      lastError: "old invalidated token",
      lastErrorAt: "2026-08-30T00:00:00.000Z",
      errorCode: 401,
      backoffLevel: 4,
      rateLimitedUntil: "2099-01-01T00:00:00.000Z",
      "modelLock_gpt-5.6-sol": "2099-01-01T00:00:00.000Z",
      "modelFailure_gpt-5.6-sol": { status: 401, message: "old invalidated token" },
    });

    const restored = await connectionsRepo.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      email: "reauth@example.test",
      providerSpecificData: { chatgptAccountId: "acct-reauth" },
      testStatus: "active",
    });

    expect(restored).toMatchObject({
      id: original.id,
      isActive: true,
      testStatus: "active",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
    });
    for (const field of [
      "lastError",
      "lastErrorAt",
      "errorCode",
      "backoffLevel",
      "rateLimitedUntil",
      "modelLock_gpt-5.6-sol",
      "modelFailure_gpt-5.6-sol",
    ]) {
      expect(restored).not.toHaveProperty(field);
    }

    const persisted = await connectionsRepo.getProviderConnectionById(original.id);
    expect(persisted).toEqual(restored);
  });
});
