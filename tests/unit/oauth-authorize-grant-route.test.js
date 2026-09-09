/**
 * The add-account sign-in path, at the route the dashboard actually calls.
 *
 * AddAccountRow probes /authorize when a provider is picked and runGrant calls it
 * again on submit, so each call must mint its own state and PKCE pair; and a
 * fixed-port provider must answer with the loopback URI its own callback proxy
 * binds rather than the dashboard origin the caller asked for. A refused exchange
 * must come back as a message, because the row has nothing else to show.
 */
import crypto from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

// providers/index.js swaps global fetch at import time, which hides vi.stubGlobal.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  installGlobalProxyFetch: () => {},
  default: (...args) => globalThis.fetch(...args),
}));

const DASHBOARD_CALLBACK = "http://127.0.0.1:20129/callback";
let GET;
let POST;
let models;

const authorize = (provider, redirectUri = DASHBOARD_CALLBACK) =>
  GET(new Request(`http://127.0.0.1:20129/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`),
    { params: Promise.resolve({ provider, action: "authorize" }) });

beforeAll(async () => {
  ({ GET, POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js"));
  models = await import("../../src/models/index.js");
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
});

afterEach(() => vi.unstubAllGlobals());

it("mints an independent state and PKCE pair on every claude authorize, bound to the caller callback", async () => {
  const first = await (await authorize("claude")).json();
  const second = await (await authorize("claude")).json();

  const url = new URL(first.authUrl);
  expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
  expect(url.searchParams.get("redirect_uri")).toBe(DASHBOARD_CALLBACK);
  expect(first.redirectUri).toBe(DASHBOARD_CALLBACK);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  // The challenge in the URL belongs to the verifier the body hands back, so the
  // pair the grant later exchanges with is the pair the provider was shown.
  expect(url.searchParams.get("code_challenge")).toBe(
    crypto.createHash("sha256").update(first.codeVerifier).digest("base64url")
  );
  expect(url.searchParams.get("state")).toBe(first.state);
  // The probe on provider pick and the grant on submit are separate rounds; neither
  // inherits the other's state, so a stale probe cannot be replayed into an exchange.
  expect(second.state).not.toBe(first.state);
  expect(second.codeVerifier).not.toBe(first.codeVerifier);
});

it("answers a codex authorize with the loopback callback its own proxy binds", async () => {
  const body = await (await authorize("codex")).json();
  const url = new URL(body.authUrl);

  expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
  expect(body.fixedPort).toBe(1455);
  expect(body.callbackPath).toBe("/auth/callback");
  const loopback = `http://localhost:${body.fixedPort}${body.callbackPath}`;
  expect(body.redirectUri).toBe(loopback);
  expect(url.searchParams.get("redirect_uri")).toBe(loopback);
  // Sending the browser to the dashboard instead leaves the proxy on 1455 with
  // nothing to receive, and the grant polls it until it gives up.
  expect(url.searchParams.get("redirect_uri")).not.toBe(DASHBOARD_CALLBACK);
});

it("returns the provider refusal for a bad code instead of writing a tokenless account", async () => {
  const before = (await models.getProviderConnections()).length;
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":"invalid_grant"}',
    json: async () => ({ error: "invalid_grant" }),
  })));

  const response = await POST(
    new Request("http://127.0.0.1:20129/api/oauth/claude/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "not-a-real-code", redirectUri: DASHBOARD_CALLBACK, codeVerifier: "fixture-verifier", state: "fixture-state" }),
    }),
    { params: Promise.resolve({ provider: "claude", action: "exchange" }) }
  );

  expect(response.ok).toBe(false);
  expect((await response.json()).error).toContain("invalid_grant");
  expect((await models.getProviderConnections()).length).toBe(before);
});
