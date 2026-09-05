/**
 * Live repro for issue #1933: MiMo Code Free returns HTTP 502 "MiMo bootstrap failed: 403".
 * Root cause: upstream gates on Chrome-like User-Agent. Without UA → 403 "Illegal access".
 * Hits real endpoints — no mocks. Free provider, safe to call.
 */
import { describe, it, expect } from "vitest";

// Opt-in only, matches the repo's RUN_E2E convention (translator/real/*.e2e.test.js):
// this file hits real xiaomimimo.com endpoints with no mock, which the real-io
// guard now blocks by default. Run explicitly with RUN_LIVE_MIMO=1.
const RUN = process.env.RUN_LIVE_MIMO === "1";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { __test__ } from "../../open-sse/executors/mimo-free.js";

const { BOOTSTRAP_URL, CHAT_URL, generateFingerprint, MIMO_SYSTEM_MARKER } = __test__;

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function bootstrapWith(ua) {
  const headers = { "Content-Type": "application/json" };
  if (ua) headers["User-Agent"] = ua;
  const r = await proxyAwareFetch(BOOTSTRAP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ client: generateFingerprint() }),
  });
  const data = await r.json();
  return { status: r.status, jwt: data.jwt };
}

async function chatWith(jwt, ua) {
  const headers = {
    "Content-Type": "application/json",
    "X-Mimo-Source": "mimocode-cli-free",
    Authorization: `Bearer ${jwt}`,
    Accept: "application/json",
  };
  if (ua) headers["User-Agent"] = ua;
  const body = {
    model: "mimo-auto",
    messages: [
      { role: "system", content: MIMO_SYSTEM_MARKER },
      { role: "user", content: "hi" },
    ],
    stream: false,
  };
  return proxyAwareFetch(CHAT_URL, { method: "POST", headers, body: JSON.stringify(body) });
}

describe.skipIf(!RUN)("MiMo Free bootstrap (live)", () => {
  it("bootstrap returns 200 with JWT", async () => {
    const { status, jwt } = await bootstrapWith(CHROME_UA);
    expect(status).toBe(200);
    expect(jwt).toBeTruthy();
  });
});

describe.skipIf(!RUN)("MiMo Free ended channel (live)", () => {
  // Xiaomi ended the free MiMo channel (#3035): bootstrap still hands out a JWT,
  // but chat answers 400 "Unsupported model" for the old mimo-auto id. Lock that
  // end-state; a revived channel flips this back to 200 and tells us to re-enable
  // the registry entry (open-sse/providers/registry/mimo-free.js).
  it("chat with valid JWT → 400 Unsupported model (channel ended)", async () => {
    const { jwt } = await bootstrapWith(CHROME_UA);
    const r = await chatWith(jwt, CHROME_UA);
    const body = await r.json();
    expect(r.status).toBe(400);
    expect(body.error?.message).toMatch(/Unsupported model/);
  });
});
