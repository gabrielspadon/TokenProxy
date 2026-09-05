/**
 * Unit tests for the deterministic Claude billing header in
 * open-sse/utils/claudeCloaking.js (applyCloaking).
 *
 * The header is injected as system[0] ahead of the 1h system cache anchor; if
 * it varies per request the anchored prefix changes every turn and the
 * provider prompt cache can never hit. It must be byte-identical per
 * (apiKey, sessionId) regardless of the request body, and differ across
 * sessions/accounts.
 */

import { describe, it, expect } from "vitest";
import { applyCloaking } from "../../open-sse/utils/claudeCloaking.js";

const OAT_KEY = "sk-ant-oat-AAAAAAAA";

function bodyWith(text) {
  return {
    system: [{ type: "text", text: "system prompt" }],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

describe("applyCloaking billing header determinism", () => {
  it("produces a byte-identical header across calls with the same key+session and different bodies", () => {
    const a = applyCloaking(bodyWith("first message"), OAT_KEY, "session-1");
    const b = applyCloaking(bodyWith("a much longer second message with different content"), OAT_KEY, "session-1");
    expect(a.system[0].text).toBe(b.system[0].text);
    expect(a.system[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.261\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/
    );
  });

  it("differs across sessions for the same account", () => {
    const a = applyCloaking(bodyWith("same body"), OAT_KEY, "session-1");
    const b = applyCloaking(bodyWith("same body"), OAT_KEY, "session-2");
    expect(a.system[0].text).not.toBe(b.system[0].text);
  });

  it("differs across accounts", () => {
    const a = applyCloaking(bodyWith("same body"), OAT_KEY, "session-1");
    const b = applyCloaking(bodyWith("same body"), "sk-ant-oat-BBBBBBBB", "session-1");
    expect(a.system[0].text).not.toBe(b.system[0].text);
  });

  it("is stable when the session id is absent", () => {
    const a = applyCloaking(bodyWith("one"), OAT_KEY);
    const b = applyCloaking(bodyWith("two"), OAT_KEY);
    expect(a.system[0].text).toBe(b.system[0].text);
  });

  it("does not touch non-OAuth credentials", () => {
    const body = bodyWith("hello");
    expect(applyCloaking(body, "sk-ant-api03-XXXX", "session-1")).toBe(body);
  });
});

describe("applyCloaking absent-session fallback (F5)", () => {
  it("derives a stable per-account seed when sessionId is null, for header and user_id", () => {
    // sessionManager returns a fresh random id per request when it has no
    // connectionId; the cloaking layer must collapse an absent session to a
    // stable apiKey-derived seed so neither the billing header nor
    // metadata.user_id varies per request.
    const a = applyCloaking(bodyWith("one"), OAT_KEY, null);
    const b = applyCloaking(bodyWith("two"), OAT_KEY, null);
    expect(a.system[0].text).toBe(b.system[0].text);
    expect(a.metadata.user_id).toBe(b.metadata.user_id);
    // still differs from a real session's header on the same account
    const c = applyCloaking(bodyWith("one"), OAT_KEY, "session-9");
    expect(a.system[0].text).not.toBe(c.system[0].text);
  });
});
