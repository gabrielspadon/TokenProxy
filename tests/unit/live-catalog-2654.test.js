// #2654 — /v1/models must serve the authenticated OpenAI and Codex catalogs the
// provider detail page already fetched, and must fail open to the static
// registry when that fetch cannot answer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The catalog module only needs the codex refresh hooks; stub them so the test
// never drags the SQLite layer in.
const refreshMocks = vi.hoisted(() => ({
  refreshCodexToken: vi.fn(async () => null),
  updateProviderCredentials: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh", () => refreshMocks);

const {
  parseOpenAIStyleModels,
  normalizeOpenAICatalog,
  normalizeCodexCatalog,
  buildOAuthResolver,
  withStaticMediaModels,
  fetchOpenAICatalog,
  codexModelsResolver,
  resolveLiveOpenAIModels,
} = await import("@/app/api/providers/[id]/models/liveCatalog.js");

const kindOf = (models, id) => models.find((m) => m.id === id)?.kind;
const ids = (models) => models.map((m) => m.id);

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  refreshMocks.refreshCodexToken.mockReset().mockResolvedValue(null);
  refreshMocks.updateProviderCredentials.mockReset().mockResolvedValue(null);
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("normalizeOpenAICatalog", () => {
  it("keeps a live chat model the static registry has never heard of", () => {
    const out = normalizeOpenAICatalog([{ id: "gpt-6-preview" }, { id: "o5-mini" }]);
    expect(ids(out)).toEqual(["gpt-6-preview", "o5-mini"]);
    expect(out.every((m) => m.kind === "llm")).toBe(true);
  });

  it("routes each non-chat family to its own kind so /v1/models stays chat-only", () => {
    const out = normalizeOpenAICatalog([
      { id: "text-embedding-3-large" },
      { id: "tts-1" },
      { id: "whisper-1" },
      { id: "gpt-4o-transcribe" },
      { id: "gpt-image-1" },
      { id: "omni-moderation-latest" },
      { id: "gpt-5.4" },
    ]);
    expect(kindOf(out, "text-embedding-3-large")).toBe("embedding");
    expect(kindOf(out, "tts-1")).toBe("tts");
    expect(kindOf(out, "whisper-1")).toBe("stt");
    expect(kindOf(out, "gpt-4o-transcribe")).toBe("stt");
    expect(kindOf(out, "gpt-image-1")).toBe("image");
    expect(kindOf(out, "omni-moderation-latest")).toBe("moderation");
    expect(kindOf(out, "gpt-5.4")).toBe("llm");
  });

  it("drops engines that would 400 on /v1/chat/completions", () => {
    const out = normalizeOpenAICatalog([
      { id: "davinci-002" },
      { id: "babbage-002" },
      { id: "gpt-3.5-turbo-instruct" },
      { id: "gpt-4o-realtime-preview" },
      { id: "gpt-4o-audio-preview" },
      { id: "gpt-4o" },
    ]);
    expect(ids(out)).toEqual(["gpt-4o"]);
  });

  it("drops capability metadata that is not a plain object", () => {
    const out = normalizeOpenAICatalog([
      { id: "gpt-4o", capabilities: "everything" },
      { id: "gpt-4.1", capabilities: ["vision"] },
      { id: "gpt-5.4", capabilities: { vision: true } },
    ]);
    expect(out.find((m) => m.id === "gpt-4o")).not.toHaveProperty("capabilities");
    expect(out.find((m) => m.id === "gpt-4.1")).not.toHaveProperty("capabilities");
    expect(out.find((m) => m.id === "gpt-5.4").capabilities).toEqual({ vision: true });
  });

  it("survives a malformed body without throwing", () => {
    expect(normalizeOpenAICatalog(null)).toEqual([]);
    expect(normalizeOpenAICatalog([null, {}, { id: "" }])).toEqual([]);
  });
});

describe("normalizeCodexCatalog", () => {
  it("mints the deterministic -review alias for chat models", () => {
    const out = normalizeCodexCatalog([{ id: "gpt-5.6-sol", display_name: "GPT 5.6 Sol" }]);
    expect(ids(out)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol-review"]);
    expect(out[1].quotaFamily).toBe("review");
    expect(out[1].upstreamModelId).toBe("gpt-5.6-sol");
  });

  it("never twins an image model, even when upstream omits its type", () => {
    // The registry declares gpt-5.5-image as kind:image. Resolving the kind
    // before the review expansion is what stops a bogus -image-review id.
    const out = normalizeCodexCatalog([{ id: "gpt-5.5-image" }]);
    expect(ids(out)).toEqual(["gpt-5.5-image"]);
    expect(kindOf(out, "gpt-5.5-image")).toBe("image");
  });

  it("does not double-suffix an id that already ends in -review", () => {
    const out = normalizeCodexCatalog([{ id: "gpt-5.5-review" }]);
    expect(ids(out)).toEqual(["gpt-5.5-review"]);
  });
});

describe("withStaticMediaModels", () => {
  it("keeps the static media catalog an llm-only live list never mentioned", () => {
    const merged = withStaticMediaModels("openai", [{ id: "gpt-9", kind: "llm" }]);
    expect(ids(merged)).toContain("gpt-9");
    // /v1/models/image and /v1/models/embedding must not go empty.
    expect(kindOf(merged, "gpt-image-1")).toBe("image");
    expect(kindOf(merged, "text-embedding-3-large")).toBe("embedding");
    // ...and the live list still governs the llm bucket.
    expect(merged.filter((m) => (m.kind || "llm") === "llm").map((m) => m.id)).toEqual(["gpt-9"]);
  });

  it("does not duplicate an id the live catalog already carries", () => {
    const merged = withStaticMediaModels("openai", [{ id: "gpt-image-1", kind: "image" }]);
    expect(merged.filter((m) => m.id === "gpt-image-1")).toHaveLength(1);
  });
});

describe("fetchOpenAICatalog fails open", () => {
  it("returns null without a credential rather than calling out", async () => {
    globalThis.fetch = vi.fn();
    expect(await fetchOpenAICatalog({})).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null on 401 so the static registry stands", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "nope" }));
    expect(await fetchOpenAICatalog({ apiKey: "sk-test" })).toBeNull();
  });

  it("returns null when the upstream throws or times out", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => { throw new Error("secret-token-in-error"); });
    expect(await fetchOpenAICatalog({ apiKey: "sk-test" })).toBeNull();
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret-token-in-error");
    log.mockRestore();
  });

  it("returns null on an empty catalog", async () => {
    globalThis.fetch = vi.fn(async () => okResponse({ object: "list", data: [] }));
    expect(await fetchOpenAICatalog({ apiKey: "sk-test" })).toBeNull();
  });

  it("sends the connection's own key and nothing else", async () => {
    globalThis.fetch = vi.fn(async () => okResponse({ data: [{ id: "gpt-4o" }] }));
    await fetchOpenAICatalog({ apiKey: "sk-connection-one" });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer sk-connection-one");
    expect(init.signal).toBeDefined();
  });
});

describe("Codex catalog logging", () => {
  it("does not retain or log an upstream error body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "secret-upstream-body",
    }));
    const result = await codexModelsResolver({ accessToken: "token" });
    expect(result.warning).toBe("Failed to fetch Codex models: HTTP 401");
    expect(JSON.stringify(result)).not.toContain("secret-upstream-body");
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret-upstream-body");
    log.mockRestore();
  });
});

describe("resolveLiveOpenAIModels", () => {
  it("exposes a live-only chat id and keeps the static media entries", async () => {
    globalThis.fetch = vi.fn(async () => okResponse({
      object: "list",
      data: [{ id: "gpt-5.4" }, { id: "gpt-6-preview" }, { id: "davinci-002" }],
    }));
    const result = await resolveLiveOpenAIModels({ apiKey: "sk-test" });
    expect(ids(result.models)).toContain("gpt-6-preview");
    expect(ids(result.models)).not.toContain("davinci-002");
    expect(ids(result.models)).toContain("dall-e-3");
  });

  it("returns null, not an empty list, when the fetch cannot answer", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => "" }));
    expect(await resolveLiveOpenAIModels({ apiKey: "sk-test" })).toBeNull();
  });
});

describe("OAuth live-catalog credential publication", () => {
  it("retries only with the full authoritative revision after durable acknowledgement", async () => {
    const original = {
      id: "catalog-account",
      provider: "codex",
      accessToken: "fixture-old-access",
      refreshToken: "fixture-old-refresh",
      credentialRevisionId: "revision-old",
      providerSpecificData: { retained: true },
    };
    const authoritative = {
      ...original,
      accessToken: "fixture-authoritative-access",
      refreshToken: "fixture-authoritative-refresh",
      credentialRevisionId: "revision-new",
      lastQuotaSnapshot: { remainingPercentage: 41 },
    };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(okResponse({ data: [{ id: "gpt-5.6-sol" }] }));
    const refreshFn = vi.fn(async () => ({
      accessToken: "fixture-issued-access",
      refreshToken: "fixture-issued-refresh",
      expiresIn: 3600,
    }));
    let observedExpected;
    refreshMocks.updateProviderCredentials.mockImplementationOnce(async (_id, _patch, options) => {
      observedExpected = { ...options.expectedCredentials };
      return authoritative;
    });
    const resolve = buildOAuthResolver({
      refreshFn,
      fetchFn,
      parseFn: parseOpenAIStyleModels,
      errorLabel: "Catalog unavailable",
    });

    const signal = new AbortController().signal;
    await expect(resolve(original, { signal })).resolves.toEqual({ models: [{ id: "gpt-5.6-sol" }] });
    expect(refreshMocks.updateProviderCredentials).toHaveBeenCalledWith(
      original.id,
      expect.objectContaining({
        accessToken: "fixture-issued-access",
        refreshToken: "fixture-issued-refresh",
        existingProviderSpecificData: { retained: true },
      }),
      { expectedCredentials: original },
    );
    expect(observedExpected.credentialRevisionId).toBe("revision-old");
    expect(fetchFn).toHaveBeenNthCalledWith(2, "fixture-authoritative-access", authoritative, signal);
    expect(original).toEqual(authoritative);
  });

  it("never retries with an issued credential when durable publication fails", async () => {
    const canary = "credential-canary://do-not-log\nprivate";
    const connection = {
      id: "catalog-account-failure",
      accessToken: "fixture-old-access",
      refreshToken: "fixture-old-refresh",
    };
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401 }));
    const refreshFn = vi.fn(async () => ({ accessToken: "fixture-issued-access" }));
    refreshMocks.updateProviderCredentials.mockRejectedValueOnce(new Error(canary));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const resolve = buildOAuthResolver({
      refreshFn,
      fetchFn,
      parseFn: parseOpenAIStyleModels,
      errorLabel: "Catalog unavailable",
    });

    const result = await resolve(connection);
    expect(result).toEqual({ models: [], warning: "Catalog unavailable: unavailable" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(connection.accessToken).toBe("fixture-old-access");
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    log.mockRestore();
  });
});
