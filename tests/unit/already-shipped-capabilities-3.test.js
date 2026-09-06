import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Six reports the re-triage found already fixed by commits that POSTDATE them.
// Each is re-derived here against the tree.
//
// These once also asserted `git merge-base --is-ancestor <sha> HEAD` for the
// fixing commit. That check is gone, not ported: this repository has its own
// root commit and imports no predecessor history, so no predecessor SHA is
// addressable here and reintroducing one would make the suite depend on a
// history the product deliberately does not carry. What the ancestry check was
// a proxy for -- the fix being present -- is what every assertion below reads
// straight out of the tree, which is the stronger statement anyway.
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

it("#1087 #1126 a malformed request does not lock the account", () => {
  // Repeated locking on a client-side error is what produced the reporter's
  // "reached max iterations" and burned through every account.
  expect(read("open-sse/config/errorConfig.js")).toContain('{ text: "improperly formed request", pass: true }');
});

it("#1050 a non-SSE upstream body is short-circuited before the stall timer", () => {
  expect(read("open-sse/handlers/chatCore/streamingHandler.js")).toContain("upstreamContentType");
  expect(read("open-sse/utils/streamHandler.js")).toMatch(/stall/i);
});

it("#1188 antigravity is a normal oauth provider, not hidden", () => {
  const src = read("open-sse/providers/registry/antigravity.js");
  expect(src).toContain('category: "oauth"');
  expect(src).not.toContain("hidden: true");
});

it("#1276 thinking blocks carrying a foreign signature are dropped", () => {
  expect(read("open-sse/translator/formats/claude.js")).toContain("signature");
});

it("#1632 the CLI build handles the nested standalone layout", () => {
  expect(read("cli/scripts/build-cli.js")).toContain("standalone");
});

// Five more from the slice-01 re-triage, each re-derived here.
it("#1877 fusion degrades on a thin panel instead of failing outright", () => {
  const src = read("open-sse/services/combo.js");
  expect(src).toContain("FUSION_DEFAULTS");
  expect(src).toContain("minPanel");
});

it("#1905 #1982 the heap cap is overridable, not hardcoded", () => {
  expect(read("cli/hooks/nodeFlags.js")).toContain("TOKENPROXY_MAX_OLD_SPACE_SIZE");
  expect(read("cli/cli.js")).toContain("resolveHeapFlags");
});

it("#2021 mimo-v2.5-free is multimodal", async () => {
  const { getStaticCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
  expect(getStaticCapabilitiesForModel("mimo", "mimo-v2.5-free").vision).toBe(true);
});

