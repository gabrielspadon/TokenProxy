import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Resolved lazily INSIDE the test: a top-level import of the registry pulls in
// the real proxyFetch before vi.mock hoists, which silently unmocks the module
// this file depends on. The subject is the generic PATH, not any one provider.
async function genericProvider() {
  const { PROVIDERS } = await import('../../open-sse/providers/index.js');
  const id = Object.entries(PROVIDERS).find(([, p]) => p?.refreshUrl && p?.clientId)?.[0];
  if (!id) throw new Error('no provider carries refreshUrl + clientId');
  return id;
}

// Issue #2703. A connection pinned to a proxy must stay pinned for its token
// refreshes. Refreshing over the host's own egress tells the provider the real
// address of a router the user deliberately put behind a proxy, and no amount
// of care on the chat path hides that. proxyAwareFetch was imported here and
// used at three Kiro sites; seven other refresh paths called raw fetch().

const calls = [];
let failNext = false;
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options, proxyOptions) => {
    calls.push({ url: String(url), proxyOptions });
    if (failNext) { failNext = false; throw new Error("ECONNREFUSED via proxy"); }
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "b", expires_in: 3600 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  },
}));

let mod;
beforeEach(async () => { calls.length = 0; mod = await import("../../open-sse/services/tokenRefresh/providers.js"); });
afterEach(() => { vi.restoreAllMocks(); });

const source = () => {
  // Read the module text rather than exercising every provider path: the
  // invariant is that no refresh path reaches the network outside proxyAwareFetch.
  const { readFileSync } = require("node:fs");
  return readFileSync(new URL("../../open-sse/services/tokenRefresh/providers.js", import.meta.url), "utf8");
};

describe("token refresh honours the connection proxy (#2703)", () => {
  it("leaves no raw fetch( call in any refresh path", () => {
    const raw = source().split("\n").filter((l) => /(?<![\w.])fetch\(/.test(l) && !/proxyAwareFetch\(/.test(l));
    expect(raw).toEqual([]);
  });

  it("forwards the connection's proxy config on a real refresh call", async () => {
    const credentials = {
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://corp-proxy:3128",
        connectionNoProxy: "",
        strictProxy: true,
      },
    };

    // A provider whose oauth block carries a token endpoint, so the generic
    // path actually reaches the network rather than returning early.
    await mod.refreshAccessToken(await genericProvider(), "rt-with-proxy", credentials, null);

    expect(calls).toHaveLength(1);
    expect(calls[0].proxyOptions).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://corp-proxy:3128",
      strictProxy: true,
    });
  });

  it("passes null options when the connection carries no provider data", async () => {
    await mod.refreshAccessToken(await genericProvider(), "rt-no-data", {}, null);

    expect(calls).toHaveLength(1);
    expect(calls[0].proxyOptions).toBeNull();
  });

  it("returns null instead of throwing when the transport fails", async () => {
    // Every other exit in these refreshers returns null and lets the caller
    // decide. A thrown transport error used to escape instead, surfacing as an
    // unhandled 500 on the request path rather than a refresh failure (#2737).
    failNext = true;
    await expect(mod.refreshCodebuddyToken("rt-boom", null)).resolves.toBeNull();

    failNext = true;
    await expect(mod.refreshCodebuddyIntlToken("rt-boom-intl", null)).resolves.toBeNull();
  });

  it("still routes a refresh with no connection config through proxyAwareFetch", async () => {
    // The environment proxy must apply even where per-connection affinity does
    // not: the leak this closes is a refresh going out on the host's own egress.
    await mod.refreshGoogleToken("rt-google", "client", "secret", null);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("http");
  });
});
