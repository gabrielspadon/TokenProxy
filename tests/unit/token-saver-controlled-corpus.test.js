import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTROLLED_CORPUS, buildControlledBody, growControlledBody } from "../qa/saver-audit/controlled-corpus.mjs";
import { commonPrefix, invariants, newCtx, runPipeline } from "../qa/saver-audit/stages.mjs";
import { estimateRequestTokens } from "../../open-sse/services/memory/contextBudget.js";

const DEPLOYED_SAVER_ORDER = [
  "tools", "schema", "thinking", "rtk", "inject", "headroom", "qac", "pairs", "reorder", "midinject",
];
const DETERMINISTIC_ORDER = ["tools", "schema", "thinking", "rtk", "inject"];
const SETTINGS = {
  toolDisclosure: { filterEnabled: true, disclosureEnabled: false, maxTools: 12 },
  cavemanLevel: "ultra",
  ponytailLevel: "ultra",
  privacyTerms: [],
};

async function evaluate(body, order, contextWindow, connectionId) {
  const ctx = newCtx({ sid: connectionId, connectionId, settings: SETTINGS, contextWindow, order });
  const result = await runPipeline(body, order, ctx);
  return { ctx, result };
}

describe("controlled token-saver corpus", () => {
  it("pins exact populations, effort and output length", () => {
    for (const spec of CONTROLLED_CORPUS.populations) {
      const body = buildControlledBody(spec);
      expect(estimateRequestTokens(body)).toBe(spec.estimatedContextTokens);
      expect(body.output_config).toEqual({ effort: "high" });
      expect(body.max_tokens).toBe(32);
    }
  });

  it("preserves semantic invariants, deterministic bytes and execution receipts", async () => {
    const records = [];
    for (const spec of CONTROLLED_CORPUS.populations) {
      const body = buildControlledBody(spec);
      const source = JSON.stringify(body);
      for (const [name, order, contextWindow] of [
        ["deterministic-wide", DETERMINISTIC_ORDER, CONTROLLED_CORPUS.contextWindowTokens],
        ["configured-pressure", DEPLOYED_SAVER_ORDER, spec.estimatedContextTokens],
      ]) {
        const first = await evaluate(body, order, contextWindow, `${spec.id}-${name}-a`);
        const second = await evaluate(body, order, contextWindow, `${spec.id}-${name}-b`);
        const violations = invariants(body, first.result.body, first.ctx).filter((code) => code !== "over-window");
        expect(violations, `${spec.id} ${name}`).toEqual([]);
        expect(first.ctx.errors, `${spec.id} ${name}`).toEqual([]);
        expect(first.result.cacheString, `${spec.id} ${name} deterministic`).toBe(second.result.cacheString);
        expect(first.result.ledger).toHaveLength(order.length);
        for (const receipt of first.result.ledger) {
          expect(["applied", "unchanged", "skipped", "failed"]).toContain(receipt.outcome);
          if (receipt.outcome === "skipped") expect(receipt.reason).toBeTruthy();
        }
        expect(first.result.ledger.some(({ outcome }) => outcome === "applied")).toBe(true);
        records.push({ population: spec.id, configuration: name, estimatedContextTokens: spec.estimatedContextTokens,
          inputBytes: first.result.entryBytes, outputBytes: first.result.finalBytes, ledger: first.result.ledger,
          deterministicPrefixBytes: Buffer.byteLength(first.result.cacheString), violations });
      }

      const connectionId = `${spec.id}-growth`;
      const previous = await evaluate(body, DEPLOYED_SAVER_ORDER, CONTROLLED_CORPUS.contextWindowTokens, connectionId);
      const next = await evaluate(growControlledBody(body), DEPLOYED_SAVER_ORDER, CONTROLLED_CORPUS.contextWindowTokens, connectionId);
      const shared = commonPrefix(previous.result.cacheString, next.result.cacheString);
      const previousBytes = Buffer.byteLength(previous.result.cacheString);
      expect(shared / previousBytes).toBeGreaterThanOrEqual(0.95);
      records.push({ population: spec.id, configuration: "consecutive-growth", sharedPrefixBytes: shared,
        previousPrefixBytes: previousBytes, nextPrefixBytes: Buffer.byteLength(next.result.cacheString),
        sharedPrefixFraction: shared / previousBytes });
      expect(JSON.stringify(body)).toBe(source);
    }
    if (process.env.CONTROLLED_SAVER_REPORT) {
      writeFileSync(process.env.CONTROLLED_SAVER_REPORT, JSON.stringify({
        schemaVersion: 1,
        evidence: "Offline UTF-8 cache-prefix and structural semantics only. No provider cache or latency claim.",
        settings: SETTINGS,
        records,
      }, null, 2));
    }
  }, 120000);
});
