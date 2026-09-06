// Upstream 5a86f6a8d + 9dbdca0e5 + ec6692808, adopted as one change.
//
// Net end state: ollama-search is its own webSearch provider that borrows the
// `ollama` chat key via `credentialFallback`; GLM's MCP web_search_prime rides
// the existing `glm` entry rather than a standalone zai-search provider; and a
// search failure writes a `websearch:<provider>` scoped lock so it cannot take
// the shared chat key offline.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSearchRequest } from "open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "open-sse/handlers/search/normalizers.js";
import ollamaSearch from "open-sse/providers/registry/ollama-search.js";
import glm from "open-sse/providers/registry/glm.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { resolveProviderIconId } from "@/shared/utils/providerIcon.js";

describe("ollama-search registry entry", () => {
  it("is a webSearch provider that borrows the ollama chat key", () => {
    expect(ollamaSearch.id).toBe("ollama-search");
    expect(ollamaSearch.serviceKinds).toEqual(["webSearch"]);
    expect(ollamaSearch.credentialFallback).toBe("ollama");
    expect(ollamaSearch.authType).toBe("apikey");
  });

  it("points at the Ollama Cloud web_search endpoint", () => {
    expect(ollamaSearch.searchConfig.baseUrl).toBe("https://ollama.com/api/web_search");
    expect(ollamaSearch.searchConfig.authHeader).toBe("bearer");
    expect(ollamaSearch.searchConfig.searchTypes).toEqual(["web"]);
  });

  it("is exported from the generated registry index", () => {
    expect(REGISTRY.filter(p => p.id === "ollama-search")).toHaveLength(1);
  });

  it("reuses the ollama brand mark rather than shipping a second copy", () => {
    expect(resolveProviderIconId("ollama-search")).toBe("ollama");
  });
});

describe("credentialFallback survives the registry → UI projection", () => {
  it("MEDIA_ENTRY_KEYS carries the field onto AI_PROVIDERS", () => {
    // src/sse/handlers/search.js reads it off AI_PROVIDERS, not off the raw
    // registry entry, so a missing MEDIA_ENTRY_KEYS row silently disables the
    // whole fallback with no other signal.
    expect(AI_PROVIDERS["ollama-search"]?.credentialFallback).toBe("ollama");
  });
});

describe("GLM hosts its own MCP search — no standalone zai-search provider", () => {
  it("declares webSearch and the web_search_prime searchConfig", () => {
    expect(glm.serviceKinds).toContain("webSearch");
    expect(glm.searchConfig.baseUrl).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");
    expect(glm.searchConfig.authHeader).toBe("bearer");
  });

  it("keeps the fork's chat-based search as the failover route (#2425)", () => {
    // search/index.js prefers searchConfig and falls back to searchViaChat on a
    // retriable failure. Dropping searchViaChat would delete that failover.
    expect(glm.searchViaChat?.defaultModel).toBe("glm-4.7");
  });

  it("never introduces a zai-search provider", () => {
    expect(REGISTRY.some(p => p.id === "zai-search")).toBe(false);
    expect(AI_PROVIDERS["zai-search"]).toBeUndefined();
  });
});

describe("ollama-search request builder + normalizer", () => {
  const CONFIG = { id: "ollama-search", baseUrl: "https://ollama.com/api/web_search", method: "POST" };

  it("posts {query, max_results} with a bearer token", () => {
    const { url, init } = buildSearchRequest(CONFIG, {
      query: "ocean heat content", searchType: "web", maxResults: 5, token: "k-1",
    });
    expect(url).toBe("https://ollama.com/api/web_search");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer k-1");
    expect(JSON.parse(init.body)).toEqual({ query: "ocean heat content", max_results: 5 });
  });

  it("omits the auth header when no token is supplied", () => {
    const { init } = buildSearchRequest(CONFIG, { query: "q", searchType: "web", maxResults: 3 });
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("maps {title,url,content} rows and keeps content as full text", () => {
    const { results, totalResults } = normalizeSearchResponse("ollama-search", {
      results: [{ title: "T", url: "https://www.example.org/a?x=1", content: "body text", published_at: "2026-01-02" }],
    }, "q", "web");
    expect(totalResults).toBe(1);
    expect(results[0]).toMatchObject({
      title: "T", url: "https://www.example.org/a?x=1", display_url: "example.org/a",
      snippet: "body text", published_at: "2026-01-02", position: 1,
    });
    expect(results[0].content).toEqual({ format: "text", text: "body text", length: 9 });
    expect(results[0].citation.provider).toBe("ollama-search");
  });

  it("returns an empty set rather than throwing on a malformed payload", () => {
    expect(normalizeSearchResponse("ollama-search", {}, "q", "web")).toEqual({ results: [], totalResults: 0 });
  });
});

describe("glm MCP request builder + normalizer", () => {
  const CONFIG = { id: "glm", baseUrl: "https://api.z.ai/api/mcp/web_search_prime/mcp", method: "POST" };

  it("wraps the query in a tools/call JSON-RPC envelope", () => {
    const { url, init } = buildSearchRequest(CONFIG, {
      query: "who won", searchType: "web", maxResults: 7, token: "glm-key",
    });
    expect(url).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");
    expect(init.headers.Authorization).toBe("Bearer glm-key");
    const body = JSON.parse(init.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(body.params).toEqual({
      name: "web_search_prime",
      arguments: { search_query: "who won", count: 7 },
    });
  });

  it("unwraps the MCP text envelope before mapping rows", () => {
    const { results } = normalizeSearchResponse("glm", {
      result: { content: [{ type: "text", text: JSON.stringify({
        results: [{ title: "T", link: "https://a.example/1", content: "snip", publish_date: "2026-02-03", icon: "https://a.example/f.ico", media: "Reuters" }],
      }) }] },
    }, "who won", "web");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: "T", url: "https://a.example/1", snippet: "snip", published_at: "2026-02-03" });
    expect(results[0].favicon_url).toBe("https://a.example/f.ico");
    expect(results[0].metadata.source_type).toBe("Reuters");
    expect(results[0].citation.provider).toBe("glm");
  });

  it("survives a non-JSON envelope body without throwing", () => {
    expect(normalizeSearchResponse("glm", {
      result: { content: [{ type: "text", text: "not json" }] },
    }, "q", "web")).toEqual({ results: [], totalResults: 0 });
  });
});

// ── ec6692808: a failing search must not lock the shared chat key ──────────

const auth = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  isValidApiKey: vi.fn(async () => false),
}));
const core = vi.hoisted(() => ({ handleSearchCore: vi.fn() }));

vi.mock("@/sse/services/auth.js", () => auth);
vi.mock("open-sse/handlers/search/index.js", () => core);
vi.mock("@/lib/auth/clientApiKey", () => ({ resolveClientApiKey: async () => ({ apiKey: null, valid: false }) }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}), getCombos: async () => ({}) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
}));
vi.mock("@/sse/services/apiKeyDevices.js", () => ({ recordApiKeyDevice: vi.fn() }));
vi.mock("@/sse/services/modelAccess.js", () => ({ refuseDisallowedModel: vi.fn(async () => null) }));

const searchRequest = (provider) => new Request("http://localhost/v1/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider, query: "ocean heat content" }),
});

describe("search failure locks are scoped to websearch:<provider>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    core.handleSearchCore.mockResolvedValue({ success: false, status: 429, error: "rate limited", failureMetadata: { safeToReplay: true }, response: new Response("x", { status: 429 }) });
  });

  it("reads and writes the lock under the same websearch-scoped key", async () => {
    auth.getProviderCredentials.mockResolvedValue({ connectionId: "c1", connectionName: "glm-1", providerSpecificData: {} });
    const { handleSearch } = await import("@/sse/handlers/search.js");
    await handleSearch(searchRequest("glm"));

    expect(auth.getProviderCredentials).toHaveBeenCalledWith("glm", expect.any(Set), "websearch:glm");
    const [, , , provider, model] = auth.markAccountUnavailable.mock.calls[0];
    expect(provider).toBe("glm");
    expect(model).toBe("websearch:glm");
  });

  it("attributes the lock to the provider that owns the borrowed connection", async () => {
    // ollama-search has no connection of its own, so the credential comes from
    // `ollama`. Locking it under "ollama-search" would look up a stale
    // backoffLevel on the wrong provider.
    auth.getProviderCredentials.mockImplementation(async (provider) =>
      provider === "ollama" ? { connectionId: "c9", connectionName: "ollama-1", providerSpecificData: {} } : null);
    const { handleSearch } = await import("@/sse/handlers/search.js");
    await handleSearch(searchRequest("ollama-search"));

    expect(auth.getProviderCredentials).toHaveBeenCalledWith("ollama", expect.any(Set), "websearch:ollama-search");
    const [, , , provider, model] = auth.markAccountUnavailable.mock.calls[0];
    expect(provider).toBe("ollama");
    expect(model).toBe("websearch:ollama-search");
  });
});
