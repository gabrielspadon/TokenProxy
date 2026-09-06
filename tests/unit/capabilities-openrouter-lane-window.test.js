import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// The two OpenRouter models cc-open pins its sonnet and haiku lanes to. Both
// are served at OpenRouter's own top_provider ceiling of 1048576, which the
// pattern and canonical tables understate as a round 1000000. The lane
// declares context_exact 1048575 / 1048576, so an understated catalog window
// makes the launcher's own context-window-probe report MISMATCH(pin>real) and
// costs 48576 tokens of paid context on every long session.
//
// A provider entry REPLACES pattern caps rather than merging over them, so
// each row is also asserted to still carry every non-default capability the
// pattern supplied. That is the part a future edit is most likely to drop.
describe("OpenRouter lane models resolve their real provider ceiling", () => {
  it("keeps z-ai/glm-5.3-flash at 1048576 with its vision and zai thinking caps", () => {
    const caps = getCapabilitiesForModel("openrouter", "z-ai/glm-5.3-flash");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(131072);
    expect(caps.vision).toBe(true);
    expect(caps.pdf).toBe(true);
    expect(caps.videoInput).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("zai");
    expect(caps.thinkingEffortSupported).toBe(true);
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("keeps deepseek/deepseek-v4-flash-0731 at 1048576 with its deepseek thinking caps", () => {
    const caps = getCapabilitiesForModel("openrouter", "deepseek/deepseek-v4-flash-0731");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(384000);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("deepseek");
    expect(caps.thinkingCanDisable).toBe(true);
  });

  // The thinking-suffixed spelling is what a routed request actually carries,
  // and getStaticCapabilitiesForModel strips it before lookup. A window that
  // held for the bare id but not the suffixed one would leave the lane
  // understated on exactly the ids the router emits.
  for (const id of [
    "z-ai/glm-5.3-flash(high)",
    "deepseek/deepseek-v4-flash-0731(medium)",
  ]) {
    it(`resolves ${id} to the same 1048576 window as its bare id`, () => {
      expect(getCapabilitiesForModel("openrouter", id).contextWindow).toBe(1048576);
    });
  }

  // Both lanes pin context_exact at or below this, so the catalog must never
  // fall under the pin again in either direction of a future table edit.
  it("meets the lane context_exact pins of 1048575 and 1048576", () => {
    for (const [model, pin] of [
      ["z-ai/glm-5.3-flash", 1048575],
      ["deepseek/deepseek-v4-flash-0731", 1048576],
    ]) {
      expect(getCapabilitiesForModel("openrouter", model).contextWindow).toBeGreaterThanOrEqual(pin);
    }
  });
});
