#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { CONTROLLED_CORPUS, buildControlledBody } from "./controlled-corpus.mjs";
import { newCtx, runPipeline } from "./stages.mjs";

const order = ["tools", "schema", "thinking", "rtk", "inject", "headroom", "qac", "pairs", "reorder", "midinject"];
const settings = {
  toolDisclosure: { filterEnabled: true, disclosureEnabled: false, maxTools: 12 },
  cavemanLevel: "ultra",
  ponytailLevel: "ultra",
  privacyTerms: [],
};

function percentile(sorted, proportion) {
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
}

const outArg = process.argv.find((value) => value.startsWith("--out="));
const out = resolve(outArg?.slice("--out=".length) || process.env.DATA_DIR || "/tmp/tokenproxy-saver-controlled");
mkdirSync(out, { recursive: true });

const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
const rows = [];
let failed = false;
for (const spec of CONTROLLED_CORPUS.populations) {
  const body = buildControlledBody(spec);
  const beforeMemory = process.memoryUsage();
  let peakRss = beforeMemory.rss;
  const samplesMs = [];
  for (let index = -CONTROLLED_CORPUS.warmupRequests; index < CONTROLLED_CORPUS.measuredRequests; index++) {
    const ctx = newCtx({
      sid: `${spec.id}-${index}`,
      connectionId: `${spec.id}-${index}`,
      settings,
      contextWindow: CONTROLLED_CORPUS.contextWindowTokens,
      order,
    });
    const started = performance.now();
    const result = await runPipeline(body, order, ctx);
    const elapsed = performance.now() - started;
    if (ctx.errors.length) throw new Error(`${spec.id} saver errors ${ctx.errors.join(",")}`);
    if (index >= 0) samplesMs.push(elapsed);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (index % 5 === 0) await yieldEventLoop();
    if (result.ledger.some(({ outcome }) => outcome === "failed")) throw new Error(`${spec.id} failed stage receipt`);
  }
  samplesMs.sort((left, right) => left - right);
  const p95Ms = percentile(samplesMs, 0.95);
  failed ||= p95Ms > spec.p95GatewayOverheadMs;
  rows.push({
    id: spec.id,
    estimatedContextTokens: spec.estimatedContextTokens,
    thresholdP95Ms: spec.p95GatewayOverheadMs,
    p50Ms: percentile(samplesMs, 0.5),
    p95Ms,
    p99Ms: percentile(samplesMs, 0.99),
    maxMs: samplesMs.at(-1),
    samplesMs,
    memory: { rssBeforeBytes: beforeMemory.rss, peakRssBytes: peakRss, rssAfterBytes: process.memoryUsage().rss },
  });
}
eventLoop.disable();

const receipt = {
  schemaVersion: 1,
  node: process.version,
  corpus: CONTROLLED_CORPUS,
  order,
  settings,
  externalProviderCalls: 0,
  scope: "Local shaping pipeline including its input clone and deterministic service stubs. Started-gateway request parsing, routing, network writes, provider time and billed cache behavior are outside this prequalification.",
  eventLoopDelay: {
    minMs: eventLoop.min / 1e6,
    meanMs: eventLoop.mean / 1e6,
    p95Ms: eventLoop.percentile(95) / 1e6,
    maxMs: eventLoop.max / 1e6,
  },
  rows,
  passedLocalThresholds: !failed,
};
writeFileSync(resolve(out, "controlled-shaping-performance.json"), JSON.stringify(receipt, null, 2));
process.stdout.write(`${JSON.stringify({ output: resolve(out, "controlled-shaping-performance.json"), passedLocalThresholds: !failed })}\n`);
if (failed) process.exitCode = 1;
