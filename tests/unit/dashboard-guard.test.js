import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  // `NextResponse.json()` delegates to the Fetch JSON response constructor.
  // Use it for the 204 path so this guard test sees the same body restriction
  // enforced by the Next 16 runtime.
  jsonResponse: vi.fn((body, init) => {
    if (init?.status === 204) return Response.json(body, init);
    return {
      status: init?.status || 200,
      body,
    };
  }),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: {
      pathname,
      searchParams: new URL(`http://localhost${pathname}`).searchParams,
    },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

// A request that actually came through custom-server.js: peer IP stamped from the TCP
// socket and proven by the per-process secret.
function localRequest(pathname, headers = {}) {
  return request(pathname, {
    "x-tp-peer-token": PEER_TOKEN,
    "x-tp-real-ip": "127.0.0.1",
    ...headers,
  });
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENPROXY_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(
      localRequest("/v1/chat/completions", { host: "localhost:20128" }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("returns a bodyless CORS preflight without API-key lookup", async () => {
    const preflight = request("/v1/chat/completions", {
      host: "router.example.com",
      "access-control-request-headers": "authorization, content-type",
    });
    preflight.method = "OPTIONS";

    const response = await proxy(preflight);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("keeps remote public LLM POST API-key-protected", async () => {
    const post = request("/v1/chat/completions", {
      host: "router.example.com",
    });
    post.method = "POST";

    const response = await proxy(post);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(
      localRequest("/v1/chat/completions", {
        host: "localhost",
        "x-tp-real-ip": "10.204.111.34",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(
      localRequest("/v1/chat/completions", {
        host: "localhost:20128",
        "x-tp-real-ip": "127.0.0.1",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(
      request("/api/v1/chat/completions", { host: "router.example.com" }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(
      localRequest("/api/v1/chat/completions", { host: "localhost:20128" }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(
      request("/v1beta/models", { host: "router.example.com" }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(
      request("/api/v1beta/models", { host: "router.example.com" }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(
      request("/codex/x", { host: "router.example.com" }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(
      request("/codex/x", {
        host: "router.example.com",
        authorization: "Bearer sk-valid",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(
      request("/api/v1/chat/completions", {
        host: "router.example.com",
        authorization: "Bearer sk-valid",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(
      request("/v1/web/fetch", {
        host: "router.example.com",
        "x-api-key": "sk-valid",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("accepts a valid x-api-key after a stale Bearer credential", async () => {
    mocks.validateApiKey.mockImplementation(async (key) => key === "sk-valid");

    const response = await proxy(
      request("/v1/messages", {
        host: "router.example.com",
        authorization: "Bearer stale-claude-session",
        "x-api-key": "sk-valid",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenNthCalledWith(1, "stale-claude-session");
    expect(mocks.validateApiKey).toHaveBeenNthCalledWith(2, "sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(
      request("/api/v1beta/models", {
        host: "router.example.com",
        "x-api-key": "sk-valid",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(
      request("/v1beta/models", {
        host: "router.example.com",
        "x-goog-api-key": "sk-valid",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(
      request("/v1beta/models?key=sk-valid", {
        host: "router.example.com",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard session generation verdict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENPROXY_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  it("redirects a stale dashboard cookie after the session verifier rejects its generation", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    const dashboardRequest = request("/dashboard/access", { host: "router.example.com" });
    dashboardRequest.cookies.get.mockReturnValue({ value: "stale-generation-token" });

    const response = await proxy(dashboardRequest);
    expect(response.status).toBe(307);
    expect(String(response.url)).toBe("http://localhost/login");
  });

  it("preserves access for a cookie whose persisted generation is current", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const dashboardRequest = request("/dashboard/access", { host: "router.example.com" });
    dashboardRequest.cookies.get.mockReturnValue({ value: "current-generation-token" });

    expect(await proxy(dashboardRequest)).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard auto-import local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENPROXY_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows only verified direct-loopback auto-import when login is disabled", async () => {
    const autoImportPaths = [
      "/api/oauth/cursor/auto-import",
      "/api/oauth/kiro/auto-import",
    ];

    for (const pathname of autoImportPaths) {
      const response = await proxy(localRequest(pathname, {
        host: "localhost:20128",
        origin: "http://localhost:20128",
      }));
      expect(response).toBe(mocks.nextResponse);
    }

    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    for (const pathname of autoImportPaths) {
      const response = await proxy(localRequest(pathname, {
        host: "localhost:20128",
        origin: "http://localhost:20128",
      }));
      expect(response.status).toBe(403);
    }

    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    for (const pathname of autoImportPaths) {
      for (const headers of [
        { host: "router.example.com", "x-tp-real-ip": "198.51.100.8" },
        { host: "localhost:20128", "x-tp-via-proxy": "1" },
        { host: "localhost:20128", "x-tp-peer-token": "forged", "x-tp-real-ip": "127.0.0.1" },
        { host: "localhost:20128", origin: "https://evil.example.com" },
      ]) {
        const response = await proxy(
          headers["x-tp-peer-token"] === "forged"
            ? request(pathname, headers)
            : localRequest(pathname, headers),
        );
        expect(response.status).toBe(403);
      }
    }

    for (const pathname of [
      "/api/version/update",
      "/api/version/shutdown",
      "/api/shutdown",
      "/api/settings/database",
    ]) {
      const response = await proxy(localRequest(pathname, {
        host: "localhost:20128",
        origin: "http://localhost:20128",
      }));
      expect(response.status).toBe(401);
    }
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENPROXY_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(
      request("/api/mcp/filesystem/sse", {
        host: "router.example.com",
      }),
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects /api/context-status remotely even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(
      request("/api/context-status", {
        host: "router.example.com",
      }),
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows /api/context-status on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(
      localRequest("/api/context-status", {
        host: "localhost:20128",
        origin: "http://localhost:20128",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(
      localRequest("/api/mcp/filesystem/sse", {
        host: "localhost:20128",
        origin: "http://localhost:20128",
      }),
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(
      localRequest("/api/headroom/status", {
        host: "localhost:20128",
        origin: "http://localhost:20128",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(
      request("/api/headroom/status", {
        host: "router.example.com",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(
      localRequest("/api/headroom/status", {
        host: "localhost:20128",
        origin: "http://evil.example.com",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(
      request("/api/mcp/filesystem/sse", {
        host: "router.example.com",
        "x-tp-cli-token": "cli-token",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects remote settings PATCH when requireLogin=false (PR 3499)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const remoteRequest = request("/api/settings", {
      host: "router.example.com",
      method: "PATCH",
    });
    remoteRequest.method = "PATCH";

    const response = await proxy(remoteRequest);

    expect(response.status).toBe(401);
  });

  it("allows settings PATCH on loopback with valid JWT when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const loopbackRequest = localRequest("/api/settings", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    });
    loopbackRequest.method = "PATCH";
    loopbackRequest.cookies.get.mockReturnValue({ value: "cookie-token" });

    const response = await proxy(loopbackRequest);

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows remote settings PATCH with valid CLI token when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const cliRequest = request("/api/settings", {
      host: "router.example.com",
      method: "PATCH",
      "x-tp-cli-token": "cli-token",
    });

    const response = await proxy(cliRequest);

    expect(response).toBe(mocks.nextResponse);
  });

  it("keeps settings GET open when requireLogin=false (dashboard read)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const getRequest = request("/api/settings", {
      host: "router.example.com",
    });
    getRequest.method = "GET";

    const response = await proxy(getRequest);

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects headroom routes from remote when requireLogin=false (PR 3503 gap)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    for (const [pathname, method] of [
      ["/api/headroom/status", "GET"],
      ["/api/headroom/proxy/dashboard", "GET"],
    ]) {
      const response = await proxy(
        request(pathname, { host: "router.example.com", method }),
      );
      expect(response.status, pathname).toBe(403);
    }
  });

  it("allows headroom routes with valid CLI token", async () => {
    const response = await proxy(
      request("/api/headroom/status", {
        host: "router.example.com",
        "x-tp-cli-token": "cli-token",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows headroom routes on loopback with valid auth_token cookie", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const headroomRequest = localRequest("/api/headroom/status", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    });
    headroomRequest.cookies.get.mockReturnValue({ value: "cookie-token" });

    const response = await proxy(headroomRequest);
    expect(response).toBe(mocks.nextResponse);
  });

  it.each(["/api/pxpipe/install", "/api/pxpipe/status"])(
    "denies pxpipe route %s from remote host even when requireLogin=false",
    async (pathname) => {
      mocks.getSettings.mockResolvedValue({ requireLogin: false });

      const response = await proxy(
        request(pathname, { host: "router.example.com" }),
      );

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Local only: CLI token required");
    },
  );

  it("allows pxpipe route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(
      localRequest("/api/pxpipe/install", {
        host: "localhost:20128",
        origin: "http://localhost:20128",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows pxpipe route from remote host with valid CLI token", async () => {
    const response = await proxy(
      request("/api/pxpipe/install", {
        host: "router.example.com",
        "x-tp-cli-token": "cli-token",
      }),
    );

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects /api/headroom/status from remote even when requireLogin=false (403)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/headroom/status", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows /api/headroom/status on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/headroom/status", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("still allows /api/headroom/status with valid CLI token from anywhere", async () => {
    const response = await proxy(request("/api/headroom/status", {
      host: "router.example.com",
      "x-tp-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });
});
