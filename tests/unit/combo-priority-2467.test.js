// #2467 asked for a fourth combo strategy — `priority` / `priority_fallback` /
// `preferred_first` — where members are ordered by priority, every request goes
// to the highest-priority member, a temporary limit fails over to the next, and
// the router returns to the preferred member as soon as its window resets.
//
// That is what `fallback` already does, so this file is the evidence rather
// than a new enum value. getRotatedModels only rotates for "round-robin"
// (combo.js), so `fallback` hands the loop the stored order on EVERY request;
// advanceRotationAfterSuccessfulFallback is likewise a no-op for it, so serving
// from member two leaves no cursor behind and the next request starts at member
// one again. Adding a `priority` value would alias `fallback`.
import { describe, expect, it, vi } from "vitest";
import { getRotatedModels, handleComboChat, resetComboRotation } from "open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, line: () => {} };

const body = () => ({ model: "combo", messages: [{ role: "user", content: "hi" }] });

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// What a rolling usage window looks like on the wire: a 429 the account layer
// classifies as fallback-worthy, not a client error.
const rateLimited = () =>
  new Response(
    JSON.stringify({ error: { message: "rate_limit_error: 5-hour limit reached" } }),
    { status: 429, headers: { "Content-Type": "application/json", "x-tokenproxy-replay-safe": "true" } },
  );

const PREFERRED = "claude/claude-sonnet-4.6";
const BACKUP = "openrouter/some-free-model";
const MEMBERS = [PREFERRED, BACKUP];

async function run(handleSingleModel, comboName) {
  return handleComboChat({
    body: body(),
    models: MEMBERS,
    handleSingleModel,
    log,
    comboName,
    comboStrategy: "fallback",
  });
}

describe("`fallback` already is the requested priority strategy (#2467)", () => {
  it("keeps the stored order untouched, request after request", () => {
    resetComboRotation("prio");
    const entries = MEMBERS.map((modelStr, originalIndex) => ({ modelStr, originalIndex }));
    for (let i = 0; i < 5; i++) {
      const out = getRotatedModels(entries, "prio", "fallback");
      expect(out.map((e) => e.modelStr)).toEqual(MEMBERS);
    }
  });

  it("sends every request to the highest-priority member while it is healthy", async () => {
    resetComboRotation("prio");
    const seen = [];
    const handler = vi.fn(async (_b, m) => {
      seen.push(m);
      return ok();
    });

    await run(handler, "prio");
    await run(handler, "prio");
    await run(handler, "prio");

    expect(seen).toEqual([PREFERRED, PREFERRED, PREFERRED]);
  });

  it("fails over to the next member on a rolling usage limit", async () => {
    resetComboRotation("prio");
    const seen = [];
    const handler = vi.fn(async (_b, m) => {
      seen.push(m);
      return m === PREFERRED ? rateLimited() : ok();
    });

    const res = await run(handler, "prio");

    expect(seen).toEqual([PREFERRED, BACKUP]);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-tokenproxy-model")).toBe(BACKUP);
  });

  it("returns to the preferred member on the next request once its window resets", async () => {
    resetComboRotation("prio");
    let preferredAvailable = false;
    const seen = [];
    const handler = vi.fn(async (_b, m) => {
      seen.push(m);
      if (m === PREFERRED && !preferredAvailable) return rateLimited();
      return ok();
    });

    await run(handler, "prio"); // served by BACKUP
    preferredAvailable = true; // the 5-hour window resets
    const res = await run(handler, "prio");

    // No manual reorder, no config edit: the very next request probes the
    // preferred member first and is served by it.
    expect(seen).toEqual([PREFERRED, BACKUP, PREFERRED]);
    expect(res.headers.get("x-tokenproxy-model")).toBe(PREFERRED);
  });

  it("is distinct from round-robin, which does NOT hold priority", async () => {
    resetComboRotation("rr");
    const entries = MEMBERS.map((modelStr, originalIndex) => ({ modelStr, originalIndex }));
    const first = getRotatedModels(entries, "rr", "round-robin").map((e) => e.modelStr);
    const second = getRotatedModels(entries, "rr", "round-robin").map((e) => e.modelStr);
    expect(first).toEqual([PREFERRED, BACKUP]);
    expect(second).toEqual([BACKUP, PREFERRED]);
    resetComboRotation("rr");
  });
});
