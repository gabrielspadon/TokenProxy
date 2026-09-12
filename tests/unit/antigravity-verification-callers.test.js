import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const usageMocks = vi.hoisted(() => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => usageMocks);

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

const projectCallerPaths = [
  "src/sse/handlers/chat.js",
  "src/sse/services/tokenRefresh.js",
];
const usageCallerPaths = [
  "src/app/api/providers/[id]/hotreload/route.js",
  "src/app/api/usage/[connectionId]/route.js",
  "src/sse/services/quotaGuard.js",
  "src/lib/antigravityVerification.js",
];

describe("Antigravity verification callers", () => {
  it("keeps the exact two project callers wrapped with Antigravity hooks", () => {
    const callers = projectCallerPaths.filter((path) => source(path).includes("getProjectIdForConnection("));
    expect(callers).toEqual(projectCallerPaths);
    for (const path of callers) {
      expect(source(path)).toContain("createAntigravityVerificationHooks");
    }
  });

  it("keeps the exact four generic Antigravity-capable usage callers wrapped", () => {
    const callers = usageCallerPaths.filter((path) => {
      const contents = source(path);
      return contents.includes("getUsageForProvider(") || contents.includes("runAntigravityUsageProbe(");
    });
    expect(callers).toEqual(usageCallerPaths);
    for (const path of callers) {
      expect(source(path)).toContain("runAntigravityUsageProbe");
    }
  });

  it("gives the cold Antigravity chat project lookup a hook snapshot", () => {
    const contents = source("src/sse/handlers/chat.js");
    expect(contents).toContain("const projectVerificationHooks = provider === \"antigravity\"");
    expect(contents).toMatch(/getProjectIdForConnection\([\s\S]*?projectVerificationHooks,\s*\)/);
  });

  it("takes a fresh Antigravity hook snapshot immediately before chatCore", () => {
    const contents = source("src/sse/handlers/chat.js");
    expect(contents).toContain("const chatVerificationHooks = provider === \"antigravity\"");
    expect(contents).toMatch(/handleChatCore\(\{[\s\S]*verificationContext: chatVerificationHooks\.verificationContext/);
  });

  it("keeps proactive Antigravity project refresh non-blocking while supplying hooks", () => {
    const contents = source("src/sse/services/tokenRefresh.js");
    expect(contents).toContain("const verificationHooks = provider === \"antigravity\"");
    expect(contents).toMatch(/getProjectIdForConnection\([^;]*verificationHooks\)/s);
  });

  it("forwards the independent metadata owner lifetime through the verification wrapper", async () => {
    vi.resetModules();
    usageMocks.getUsageForProvider.mockClear().mockResolvedValue({ quotas: {} });
    const { runAntigravityUsageProbe } = await import('../../src/lib/antigravityVerification.js');
    const owner = new AbortController();
    await runAntigravityUsageProbe({ id: 'conn-owner', provider: 'antigravity' }, {}, { signal: owner.signal });
    expect(usageMocks.getUsageForProvider.mock.calls[0][2].signal).toBe(owner.signal);
  });

  it("keeps trusted verification callbacks independent of caller cancellation", async () => {
    vi.resetModules();
    usageMocks.getUsageForProvider.mockClear().mockResolvedValue({ quotas: {} });
    const store = await import('../../src/lib/antigravityVerification.js');
    const owner = new AbortController();
    await store.runAntigravityUsageProbe({ id: 'conn-late', provider: 'antigravity' }, {}, { signal: owner.signal });
    const hooks = usageMocks.getUsageForProvider.mock.calls[0][2];
    owner.abort();
    const url = 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fcloudcode-pa.googleapis.com%2Fv1internal%3AloadCodeAssist&flowName=GlifWebSignIn&opaque=fixture';
    expect(hooks.onValidationRequired({
      validation: { kind: 'antigravity_validation_required', url, source: 'usage' },
      observationId: hooks.verificationContext.observationId,
    })).toBe(true);
    const current = store.getAntigravityVerification('conn-late');
    expect(current.href).toBe(url);
    expect(hooks.onVerificationSuccess({ challengeId: current.challengeId })).toBe(true);
    expect(store.getAntigravityVerification('conn-late')).toBeNull();
  });

  it("uses a fresh wrapper for every hot-reload quota verification attempt", () => {
    const contents = source("src/app/api/providers/[id]/hotreload/route.js");
    expect(contents).toContain("await runAntigravityUsageProbe(connection, proxyOptions)");
  });

  it("classifies a direct hot-reload 403 from one text read without false clears", () => {
    const contents = source("src/app/api/providers/[id]/hotreload/route.js");
    expect(contents).toContain("res.status === 403");
    expect(contents).toContain("await res.text()");
    expect(contents).toContain("classifyAntigravityValidation");
  });

  it("uses a fresh wrapper for the initial Antigravity usage read", () => {
    const contents = source("src/app/api/usage/[connectionId]/route.js");
    expect(contents).toContain("runAntigravityUsageProbe(connection, proxyOptions, { force })");
  });

  it("uses another fresh wrapper for the post-refresh Antigravity usage read", () => {
    const contents = source("src/app/api/usage/[connectionId]/route.js");
    expect(contents.match(/runAntigravityUsageProbe\(connection, proxyOptions, \{ force \}\)/g)).toHaveLength(2);
  });

  it("forwards only force, owner signal and trusted hook fields through one usage attempt", async () => {
    vi.resetModules();
    usageMocks.getUsageForProvider.mockResolvedValue({ quotas: {} });
    const store = await import("../../src/lib/antigravityVerification.js");
    const connection = { id: "conn-wrapper", provider: "antigravity" };

    await store.runAntigravityUsageProbe(connection, { proxy: true }, {
      force: true,
      expectedChallengeId: "submitted",
      ignored: "must-not-cross",
    });

    expect(usageMocks.getUsageForProvider).toHaveBeenCalledWith(
      connection,
      { proxy: true },
      expect.objectContaining({
        force: true,
        verificationContext: expect.objectContaining({
          connectionId: "conn-wrapper",
          challengeIdAtStart: "submitted",
        }),
      }),
    );
    expect(usageMocks.getUsageForProvider.mock.calls[0][2]).not.toHaveProperty("ignored");
    expect(Object.keys(usageMocks.getUsageForProvider.mock.calls[0][2]).sort()).toEqual([
      "force",
      "onValidationRequired",
      "onVerificationSuccess",
      "signal",
      "verificationContext",
    ]);
  });

  it("uses the submitted challenge ID for the dedicated forced recheck", () => {
    const contents = source("src/app/api/providers/antigravity/verification/[connectionId]/recheck/route.js");
    expect(contents).toMatch(/runAntigravityUsageProbe\(connection, [\s\S]*?\{\s*force: true,\s*expectedChallengeId: submittedId,?\s*}\)/);
  });

  it("releases engine and verification lifetimes only after provider deletion succeeds", () => {
    const contents = source("src/app/api/providers/[id]/route.js");
    expect(contents).toContain('import { releaseConnection } from "@/sse/services/tokenRefresh"');
    expect(contents).toContain('import { invalidateAntigravityVerificationConnection } from "@/lib/antigravityVerification"');
    expect(contents).toMatch(/if \(!deleted\)[\s\S]*releaseConnection\(id\);[\s\S]*invalidateAntigravityVerificationConnection\(id\);/);
  });
});
