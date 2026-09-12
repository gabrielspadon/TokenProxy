import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir;
let priorDataDir;
let priorDataDirPresent;
let listenerBaseline;
let repository;
let proxyPools;
let GET;
let PATCH;

const signals = ["beforeExit", "SIGINT", "SIGTERM", "exit"];

// These cases call the route handler as a function, outside any Next request
// scope, so the real cookies() throws. One case here flips requireLogin, which
// is an auth-mode key, so the PATCH takes the session-revocation branch added by
// ac8c1668 and reaches for the cookie store on its way out. The revocation
// behaviour itself is asserted against a real generation row in
// session-revocation-routes.test.js; this file only needs the call to resolve.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

function settingsRequest(payload) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function rawSettingsRequest(json) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
}

async function expectRejectedWithoutWrite(request) {
  const before = await repository.exportSettings();
  const response = await PATCH(request);
  expect(response.status).toBe(400);
  expect(await repository.exportSettings()).toEqual(before);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "tokenproxy-timeout-settings-"));
  priorDataDirPresent = Object.prototype.hasOwnProperty.call(process.env, "DATA_DIR");
  priorDataDir = process.env.DATA_DIR;
  listenerBaseline = Object.fromEntries(
    signals.map((signal) => [signal, process.listeners(signal).slice()]),
  );
  process.env.DATA_DIR = dataDir;
  delete global._dbAdapter;
  vi.resetModules();
  repository = await import("../../src/lib/db/repos/settingsRepo.js");
  proxyPools = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
  ({ GET, PATCH } = await import("../../src/app/api/settings/route.js"));
});

afterEach(async () => {
  try {
    global._dbAdapter?.instance?.close?.();
  } finally {
    delete global._dbAdapter;
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!listenerBaseline[signal].includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
    delete globalThis.__tokenproxyShutdownState;
    vi.resetModules();
    if (priorDataDirPresent) process.env.DATA_DIR = priorDataDir;
    else delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("settings compatibility", () => {
  it("omits retired controls from settings reads without deleting saved data", async () => {
    const retained = {
      tunnelEnabled: true,
      tunnelUrl: "https://retired.example",
      tunnelProvider: "cloudflare",
      tailscaleEnabled: true,
      tailscaleUrl: "https://retired.example.net",
      tunnelDashboardAccess: false,
      enableTranslator: true,
    };
    await repository.updateSettings({ ...retained, requireLogin: true });
    for (const key of Object.keys(retained)) {
      expect(await repository.getSettings()).not.toHaveProperty(key);
    }
    const response = await GET();
    const body = await response.json();
    for (const key of Object.keys(retained)) expect(body).not.toHaveProperty(key);
    const patched = await PATCH(settingsRequest({ requireLogin: false }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    for (const key of Object.keys(retained)) expect(patchedBody).not.toHaveProperty(key);
    expect(await repository.exportSettings()).toMatchObject({ ...retained, requireLogin: false });
  });

  it("does not publish a retired workbench flag from the startup environment", async () => {
    vi.stubEnv("ENABLE_TRANSLATOR", "true");
    try {
      const response = await GET();
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("enableTranslator");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("connect timeout settings repository", () => {
  it("merges 15000 into an old row without writing it", async () => {
    expect((await repository.getSettings()).connectTimeoutMs).toBe(15000);
    expect(await repository.exportSettings()).not.toHaveProperty("connectTimeoutMs");
  });

  it("uses 15000 in memory for an invalid imported global without rewriting raw data", async () => {
    await repository.updateSettings({ connectTimeoutMs: "15000" });
    expect((await repository.getSettings()).connectTimeoutMs).toBe(15000);
    expect((await repository.exportSettings()).connectTimeoutMs).toBe("15000");
  });

  it("drops an invalid imported provider override in memory while preserving its siblings and raw data", async () => {
    await repository.updateSettings({
      providerStrategies: {
        qoder: { fallbackStrategy: "round-robin", connectTimeoutMs: "8000" },
      },
    });
    expect((await repository.getSettings()).providerStrategies.qoder).toEqual({
      fallbackStrategy: "round-robin",
    });
    expect((await repository.exportSettings()).providerStrategies.qoder.connectTimeoutMs).toBe("8000");
  });

  it("atomically patches siblings and deletes only null fields", async () => {
    await repository.updateSettings({
      providerStrategies: {
        qoder: {
          fallbackStrategy: "round-robin",
          stickyRoundRobinLimit: 2,
          proxyPoolId: "pool-a",
          rotateStrategy: "random",
        },
      },
    });
    await repository.updateProviderStrategy("qoder", { connectTimeoutMs: 8000 });
    expect((await repository.getSettings()).providerStrategies.qoder).toEqual({
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: 2,
      proxyPoolId: "pool-a",
      rotateStrategy: "random",
      connectTimeoutMs: 8000,
    });
    await repository.updateProviderStrategy("qoder", { connectTimeoutMs: null });
    expect((await repository.getSettings()).providerStrategies.qoder).toEqual({
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: 2,
      proxyPoolId: "pool-a",
      rotateStrategy: "random",
    });
  });

  it("serializes concurrent provider patches without losing fields", async () => {
    await Promise.all([
      repository.updateProviderStrategy("qoder", { connectTimeoutMs: 8000 }),
      repository.updateProviderStrategy("qoder", { proxyPoolId: "pool-b" }),
    ]);
    expect((await repository.getSettings()).providerStrategies.qoder).toMatchObject({
      connectTimeoutMs: 8000,
      proxyPoolId: "pool-b",
    });
  });

  it("deletes both proxy snapshot fields when a bulk strategy clear carries nulls", async () => {
    await repository.updateSettings({
      providerStrategies: {
        "mimo-free": {
          rotateStrategy: "none",
          keep: "bulk-clear",
          proxyPoolId: null,
          strictProxy: null,
        },
      },
    });

    expect((await repository.exportSettings()).providerStrategies["mimo-free"]).toEqual({
      rotateStrategy: "none",
      keep: "bulk-clear",
    });
  });
});

describe("connect timeout settings route", () => {
  it("GET exposes the in-memory default without migrating or leaking secrets", async () => {
    await repository.updateSettings({
      password: "stored-hash",
      oidcIssuerUrl: "https://issuer.test",
      oidcClientId: "client-id",
      oidcClientSecret: "client-secret",
    });
    const rawBefore = await repository.exportSettings();
    expect(rawBefore).not.toHaveProperty("connectTimeoutMs");
    const response = await GET(new Request("http://localhost/api/settings"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connectTimeoutMs).toBe(15000);
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("oidcClientSecret");
    expect(body.oidcConfigured).toBe(true);
    expect(await repository.exportSettings()).toEqual(rawBefore);
  });

  it("persists a valid global timeout", async () => {
    const response = await PATCH(settingsRequest({ connectTimeoutMs: 20000 }));
    expect(response.status).toBe(200);
    expect((await response.json()).connectTimeoutMs).toBe(20000);
    expect((await repository.exportSettings()).connectTimeoutMs).toBe(20000);
  });

  it("persists context controls as exact booleans and refuses non-boolean literals", async () => {
    const controls = {
      epochMicroEnabled: true,
      epochAutoEnabled: false,
      dietEnabled: true,
      linguaEnabled: false,
      adaptiveCacheTtlEnabled: true,
    };
    const accepted = await PATCH(settingsRequest(controls));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject(controls);
    expect(await repository.exportSettings()).toMatchObject(controls);

    for (const key of Object.keys(controls)) {
      await expectRejectedWithoutWrite(settingsRequest({ [key]: "false" }));
    }
  });

  it.each([999, 120001, 15000.5, "15000", null, true])(
    "rejects invalid global literal %s",
    async (connectTimeoutMs) => {
      await expectRejectedWithoutWrite(settingsRequest({ connectTimeoutMs }));
    },
  );

  it("rejects parsed numeric overflow rather than JSON-stringifying it to null", async () => {
    await expectRejectedWithoutWrite(rawSettingsRequest('{"connectTimeoutMs":1e400}'));
  });

  it("rejects mixed provider command and ordinary settings", async () => {
    await expectRejectedWithoutWrite(settingsRequest({
      connectTimeoutMs: 15000,
      providerStrategyPatch: { providerId: "qoder", values: { connectTimeoutMs: 8000 } },
    }));
  });

  it("persists one provider field without losing siblings", async () => {
    await repository.updateSettings({
      providerStrategies: {
        qoder: { fallbackStrategy: "round-robin", proxyPoolId: "pool-b" },
      },
    });
    const response = await PATCH(settingsRequest({
      providerStrategyPatch: { providerId: "qoder", values: { connectTimeoutMs: 8000 } },
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).providerStrategies.qoder).toMatchObject({
      fallbackStrategy: "round-robin",
      proxyPoolId: "pool-b",
      connectTimeoutMs: 8000,
    });
  });

  it.each([
    {},
    { providerId: "   ", values: {} },
    { providerId: "qoder", values: null },
    { providerId: "qoder", values: [] },
  ])("rejects malformed provider command %#", async (providerStrategyPatch) => {
    await expectRejectedWithoutWrite(settingsRequest({ providerStrategyPatch }));
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects dangerous provider id %s",
    async (providerId) => {
      await expectRejectedWithoutWrite(settingsRequest({
        providerStrategyPatch: { providerId, values: { connectTimeoutMs: 8000 } },
      }));
    },
  );

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects dangerous provider value key %s",
    async (key) => {
      await expectRejectedWithoutWrite(rawSettingsRequest(
        `{"providerStrategyPatch":{"providerId":"qoder","values":{"${key}":true}}}`,
      ));
    },
  );

  it.each([999, 120001, 15000.5, "8000", true])(
    "rejects invalid nested timeout %s",
    async (connectTimeoutMs) => {
      await expectRejectedWithoutWrite(settingsRequest({
        providerStrategyPatch: { providerId: "qoder", values: { connectTimeoutMs } },
      }));
    },
  );

  it("rejects nested numeric overflow", async () => {
    await expectRejectedWithoutWrite(rawSettingsRequest(
      '{"providerStrategyPatch":{"providerId":"qoder","values":{"connectTimeoutMs":1e400}}}',
    ));
  });

  it("rejects unknown siblings beside a provider command", async () => {
    await expectRejectedWithoutWrite(settingsRequest({
      providerStrategyPatch: { providerId: "qoder", values: { connectTimeoutMs: 8000 } },
      unrelated: true,
    }));
  });

  it.each([
    { providerStrategies: null },
    { providerStrategies: [] },
    { providerStrategies: { qoder: null } },
    { providerStrategies: { qoder: [] } },
    { providerStrategies: { qoder: { connectTimeoutMs: "15000" } } },
  ])("rejects unsafe legacy provider strategy map %#", async (payload) => {
    await expectRejectedWithoutWrite(settingsRequest(payload));
  });

  it("rejects dangerous provider ids in the legacy map", async () => {
    await expectRejectedWithoutWrite(rawSettingsRequest(
      '{"providerStrategies":{"__proto__":{"connectTimeoutMs":8000}}}',
    ));
  });

  it("accepts a valid legacy provider strategy map", async () => {
    const response = await PATCH(settingsRequest({
      providerStrategies: {
        qoder: { fallbackStrategy: "round-robin", connectTimeoutMs: 8000 },
      },
    }));
    expect(response.status).toBe(200);
    expect((await repository.getSettings()).providerStrategies.qoder).toEqual({
      fallbackStrategy: "round-robin",
      connectTimeoutMs: 8000,
    });
  });

  it("atomically persists and deletes Codex Fast without losing siblings", async () => {
    await repository.updateSettings({
      providerStrategies: {
        codex: { fallbackStrategy: "round-robin", connectTimeoutMs: 9000 },
      },
    });

    const enabled = await PATCH(settingsRequest({
      providerStrategyPatch: { providerId: "codex", values: { fastMode: true } },
    }));
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).providerStrategies.codex).toEqual({
      fallbackStrategy: "round-robin",
      connectTimeoutMs: 9000,
      fastMode: true,
    });

    const disabled = await PATCH(settingsRequest({
      providerStrategyPatch: { providerId: "codex", values: { fastMode: null } },
    }));
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).providerStrategies.codex).toEqual({
      fallbackStrategy: "round-robin",
      connectTimeoutMs: 9000,
    });
  });

  it.each(["true", 1, 0, {}, []])(
    "rejects invalid atomic Codex Fast literal %# without a write",
    async (fastMode) => {
      await expectRejectedWithoutWrite(settingsRequest({
        providerStrategyPatch: { providerId: "codex", values: { fastMode } },
      }));
    },
  );

  it("accepts a boolean Codex Fast value in the legacy strategy map", async () => {
    const response = await PATCH(settingsRequest({
      providerStrategies: { codex: { fastMode: false } },
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).providerStrategies.codex.fastMode).toBe(false);
  });

  it.each([null, "true", 1, {}, []])(
    "rejects invalid legacy Codex Fast literal %# without a write",
    async (fastMode) => {
      await expectRejectedWithoutWrite(settingsRequest({
        providerStrategies: { codex: { fastMode } },
      }));
    },
  );
});

describe("provider strategy proxy-pool snapshots", () => {
  it("migrates a pairless fixed no-auth selection before returning credentials", async () => {
    const pool = await proxyPools.createProxyPool({
      name: "Legacy no-auth Pool",
      proxyUrl: "https://proxy.example.test:8443",
      strictProxy: true,
      isActive: true,
    });
    await repository.updateProviderStrategy("mimo-free", { proxyPoolId: pool.id });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("mimo-free");

    expect(credentials?.providerSpecificData).toMatchObject({
      connectionProxyPoolId: pool.id,
      strictProxy: true,
      resolutionKind: "selected-proxy",
    });
    expect((await repository.exportSettings()).providerStrategies["mimo-free"])
      .toMatchObject({ proxyPoolId: pool.id, strictProxy: true });
  });

  it("derives a fixed no-auth strict snapshot from an active pool", async () => {
    const pool = await proxyPools.createProxyPool({
      name: "Strict Pool",
      proxyUrl: "https://proxy.example.test:8443",
      strictProxy: true,
      isActive: true,
    });

    const response = await PATCH(settingsRequest({
      providerStrategyPatch: {
        providerId: "mimo-free",
        values: { proxyPoolId: pool.id },
      },
    }));

    expect(response.status).toBe(200);
    expect((await repository.getSettings()).providerStrategies["mimo-free"])
      .toMatchObject({ proxyPoolId: pool.id, strictProxy: true });
  });

  it("bulk clearing a no-auth pool removes its snapshot and retains direct credentials", async () => {
    const pool = await proxyPools.createProxyPool({
      name: "Clearable Pool",
      proxyUrl: "https://proxy.example.test:8443",
      strictProxy: true,
      isActive: true,
    });
    const selected = await PATCH(settingsRequest({
      providerStrategyPatch: {
        providerId: "mimo-free",
        values: { proxyPoolId: pool.id },
      },
    }));
    expect(selected.status).toBe(200);

    const cleared = await PATCH(settingsRequest({
      providerStrategies: {
        "mimo-free": {
          rotateStrategy: "none",
          keep: "bulk-clear",
          proxyPoolId: null,
        },
      },
    }));

    expect(cleared.status).toBe(200);
    expect((await repository.exportSettings()).providerStrategies["mimo-free"]).toEqual({
      rotateStrategy: "none",
      keep: "bulk-clear",
    });
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    await expect(getProviderCredentials("mimo-free")).resolves.toMatchObject({
      id: "noauth",
      providerSpecificData: {
        connectionProxyEnabled: false,
        strictProxy: false,
        resolutionKind: "unselected",
      },
    });
  });

  it.each([null, "", "__none__", "   "])(
    "atomically clears an existing no-auth pool and snapshot with literal %#",
    async (proxyPoolId) => {
      const pool = await proxyPools.createProxyPool({
        name: "Atomic clear Pool",
        proxyUrl: "https://proxy.example.test:8443",
        strictProxy: true,
        isActive: true,
      });
      await repository.updateSettings({
        providerStrategies: {
          "edge-tts": { keep: "retain", rotateStrategy: "random" },
          openai: { maxConcurrent: 3 },
        },
      });
      const selected = await PATCH(settingsRequest({
        providerStrategyPatch: { providerId: "edge-tts", values: { proxyPoolId: pool.id } },
      }));
      expect(selected.status).toBe(200);
      expect((await selected.json()).providerStrategies["edge-tts"])
        .toMatchObject({ proxyPoolId: pool.id, strictProxy: true });

      const cleared = await PATCH(settingsRequest({
        providerStrategyPatch: {
          providerId: "edge-tts",
          values: { proxyPoolId, rotateStrategy: "none" },
        },
      }));

      expect(cleared.status).toBe(200);
      const expected = {
        "edge-tts": { keep: "retain", rotateStrategy: "none" },
        openai: { maxConcurrent: 3 },
      };
      expect((await cleared.json()).providerStrategies).toEqual(expected);
      expect((await (await GET()).json()).providerStrategies).toEqual(expected);
      expect((await repository.exportSettings()).providerStrategies).toEqual(expected);
    },
  );

  it("reads back each virtual-account rotation mode without losing its fixed pool", async () => {
    const pool = await proxyPools.createProxyPool({
      name: "Rotation Pool",
      proxyUrl: "https://proxy.example.test:8443",
      strictProxy: true,
      isActive: true,
    });

    for (const rotateStrategy of ["none", "round-robin", "random"]) {
      const response = await PATCH(settingsRequest({
        providerStrategyPatch: {
          providerId: "edge-tts",
          values: { proxyPoolId: pool.id, rotateStrategy },
        },
      }));
      const expected = { proxyPoolId: pool.id, strictProxy: true, rotateStrategy };
      expect(response.status).toBe(200);
      expect((await response.json()).providerStrategies["edge-tts"]).toEqual(expected);
      expect((await (await GET()).json()).providerStrategies["edge-tts"]).toEqual(expected);
      expect((await repository.exportSettings()).providerStrategies["edge-tts"]).toEqual(expected);
    }
  });

  it("rejects inactive and client-strict no-auth pool selections without writing", async () => {
    const pool = await proxyPools.createProxyPool({
      name: "Inactive Pool",
      proxyUrl: "https://proxy.example.test:8443",
      strictProxy: true,
      isActive: false,
    });

    await expectRejectedWithoutWrite(settingsRequest({
      providerStrategyPatch: {
        providerId: "mimo-free",
        values: { proxyPoolId: pool.id },
      },
    }));
    await expectRejectedWithoutWrite(settingsRequest({
      providerStrategyPatch: {
        providerId: "mimo-free",
        values: { proxyPoolId: "pool-missing", strictProxy: false },
      },
    }));
  });
});
