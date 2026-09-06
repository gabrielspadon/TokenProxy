#!/usr/bin/env node
// Token-saver combinatorial audit.
//
// For every subset of the pipeline stages, and every order of that subset
// (all orders up to --maxPerm stages, canonical plus random samples above),
// replay a deterministic Claude Code-shaped session turn by turn through the
// production stage modules and score the configuration on:
//
//   stability  mean fraction of the previous turn's cache-order string that
//              the next turn reproduces byte for byte (a proxy for the
//              provider prefix-cache hit rate, 1.0 = every turn cache-hit)
//   savings    mean 1 - finalBytes/entryBytes
//   violations invariant codes from stages.mjs (must be empty)
//   idempotent re-running the pipeline on its own output changes nothing
//
// Two regimes: "wide" (the session never approaches the window) and "tight"
// (the second half of the session runs over budget, so every pressure-gated
// stage fires).
//
// Usage: node tests/qa/saver-audit/run.mjs [--seed 7] [--rounds 12]
//        [--tools 48] [--maxPerm 5] [--randomPerms 8] [--workers 28]
//        [--out /tmp/saver-audit] [--quick]

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSession, turnBodies } from "./fixture.mjs";
import { CANONICAL_ORDER, runPipeline, newCtx, invariants, commonPrefix } from "./stages.mjs";
import { estimateRequestTokens, measureContextPressure } from "../../../open-sse/services/memory/contextBudget.js";

const SELF = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const a = { seed: 7, rounds: 24, tools: 64, maxPerm: 5, randomPerms: 8, workers: 28, out: "/tmp/saver-audit", quick: false, stages: CANONICAL_ORDER.join(",") };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (k === "quick") { a.quick = true; continue; }
    a[k] = isNaN(Number(argv[i + 1])) ? argv[i + 1] : Number(argv[i + 1]);
    i++;
  }
  a.stages = String(a.stages).split(",").filter(Boolean);
  return a;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function* subsets(items) {
  const n = items.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const s = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s.push(items[i]);
    yield s;
  }
}

function* permutations(items) {
  if (items.length <= 1) { yield items.slice(); return; }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

function shuffled(items, rng) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function buildConfigs(a) {
  const rng = mulberry32(a.seed * 31 + 1);
  const configs = [];
  for (const subset of subsets(a.stages)) {
    const canonical = a.stages.filter((s) => subset.includes(s));
    const orders = new Map();
    orders.set(canonical.join(">"), canonical);
    if (!a.quick) {
      if (subset.length <= a.maxPerm) {
        for (const p of permutations(subset)) orders.set(p.join(">"), p);
      } else {
        let tries = 0;
        while (orders.size < a.randomPerms + 1 && tries++ < a.randomPerms * 6) {
          const p = shuffled(subset, rng);
          orders.set(p.join(">"), p);
        }
      }
    }
    for (const order of orders.values()) configs.push({ subset: canonical, order });
  }
  return configs;
}

function makeSettings(regime) {
  return {
    toolDisclosure: { filterEnabled: true, disclosureEnabled: true, maxTools: 24, excludeServers: [], excludeTools: [] },
    memoryMaxToolTurnsKeepFull: 8,
    privacyTerms: ["gabriel@spadon.com.br"],
    cavemanLevel: "full",
    ponytailLevel: "full",
    memoryCompactionEnabled: regime === "tight-compact",
  };
}

function regimeWindow(regime, finalEstTokens) {
  if (regime === "wide") return Math.round(finalEstTokens * 8);
  // Budget = window - max(8000, 5%). Aim the budget at 55% of the final turn.
  const budget = Math.round(finalEstTokens * 0.55);
  return Math.round(Math.max(budget + 8000, budget / 0.95));
}

async function evaluate(cfg, regime, turns, finalEst, a, cfgIndex) {
  const settings = makeSettings(regime);
  const contextWindow = regimeWindow(regime, finalEst);
  const connectionId = `audit-${cfgIndex}-${regime}`;
  let prevCache = null;
  let prevOver = false;
  const stab = [], stabTight = [], sav = [], ms = [];
  let cacheWriteBytes = 0;
  const viol = {};
  let idem = true;
  let idemDiff = 0;
  let errors = 0;
  for (const t of turns) {
    const ctx = newCtx({ sid: "s1", connectionId, settings, contextWindow, order: cfg.order });
    const res = await runPipeline(t.body, cfg.order, ctx);
    errors += ctx.errors.length;
    if (prevCache !== null) {
      const f = commonPrefix(prevCache, res.cacheString) / Buffer.byteLength(prevCache, "utf8");
      stab.push(f);
      if (prevOver) stabTight.push(f);
      // Bytes of the previous prefix the provider would have to re-cache.
      cacheWriteBytes += Math.round((1 - f) * Buffer.byteLength(prevCache, "utf8"));
    }
    prevCache = res.cacheString;
    prevOver = measureContextPressure(t.body, { contextWindow, settings }).over;
    sav.push(1 - res.finalBytes / res.entryBytes);
    ms.push(res.ms);
    for (const v of invariants(t.body, res.body, { contextWindow, privacy: cfg.order.includes("privacy") })) viol[v] = (viol[v] || 0) + 1;
    if (t === turns[turns.length - 1]) {
      // Idempotency: the pipeline applied to its own output (what an account
      // fallback retry sees when isolation fails) must be a fixed point.
      const ctx2 = newCtx({ sid: "s1", connectionId, settings, contextWindow, order: cfg.order });
      const again = await runPipeline(res.body, cfg.order, ctx2);
      if (again.cacheString !== res.cacheString) {
        idem = false;
        idemDiff = again.finalBytes - res.finalBytes;
      }
    }
  }
  const mean = (xs) => (xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : null);
  return {
    subset: cfg.subset.join(","), order: cfg.order.join(">"), regime,
    contextWindow,
    stabMean: mean(stab), stabMin: stab.length ? Math.min(...stab) : null, stabTight: mean(stabTight),
    cacheWriteKB: Math.round(cacheWriteBytes / 1024),
    savMean: mean(sav), savFinal: sav[sav.length - 1],
    viol, idem, idemDiff, errors, msMean: mean(ms),
  };
}

async function workerMain() {
  const { a, configs, from, to, regimes } = workerData;
  const session = buildSession({ seed: a.seed, rounds: a.rounds, toolCount: a.tools });
  const turns = turnBodies(session);
  const finalEst = estimateRequestTokens(turns[turns.length - 1].body);
  const out = [];
  for (let i = from; i < to; i++) {
    for (const regime of regimes) {
      out.push(await evaluate(configs[i], regime, turns, finalEst, a, i));
    }
    if (out.length >= 40) { parentPort.postMessage(out.splice(0)); }
  }
  parentPort.postMessage(out);
  parentPort.postMessage("done");
}

function summarize(rows, a) {
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.subset}|${r.regime}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const canonicalOf = (subset) => a.stages.filter((s) => subset.split(",").includes(s)).join(">");
  const score = (r) => {
    const nv = Object.values(r.viol).reduce((p, c) => p + c, 0);
    return [nv === 0 ? 1 : 0, r.idem ? 1 : 0, -(r.cacheWriteKB ?? 0), Math.round((r.savMean ?? 0) * 1000)];
  };
  const cmp = (x, y) => { const sx = score(x), sy = score(y); for (let i = 0; i < sx.length; i++) if (sx[i] !== sy[i]) return sy[i] - sx[i]; return 0; };
  const perSubset = [];
  const precedence = {};
  let canonicalBest = 0, canonicalTied = 0, total = 0;
  for (const [k, list] of byKey) {
    list.sort(cmp);
    const best = list[0];
    const canon = list.find((r) => r.order === canonicalOf(r.subset));
    const tied = canon && cmp(canon, best) === 0;
    total++;
    if (canon === best) canonicalBest++;
    else if (tied) canonicalTied++;
    perSubset.push({ key: k, best: best.order, bestStab: best.stabMean, bestSav: best.savMean, bestViol: best.viol, canonical: canon?.order, canonStab: canon?.stabMean, canonSav: canon?.savMean, canonViol: canon?.viol, canonicalOptimal: canon === best || !!tied, orders: list.length });
    // Pairwise precedence: for every pair (x before y) in the best order,
    // credit x>y; in the worst order (last), credit the reverse.
    const bo = best.order.split(">");
    for (let i = 0; i < bo.length; i++) for (let j = i + 1; j < bo.length; j++) {
      const key = `${bo[i]}>${bo[j]}`;
      precedence[key] = (precedence[key] || 0) + 1;
    }
  }
  // Global order: sort stages by how often they precede others in best orders.
  const wins = {};
  for (const [pair, n] of Object.entries(precedence)) {
    const [x, y] = pair.split(">");
    wins[x] = (wins[x] || 0) + n;
    wins[y] = (wins[y] || 0) - n;
  }
  const globalOrder = a.stages.slice().sort((x, y) => (wins[y] || 0) - (wins[x] || 0));
  // Single-stage report: each stage alone in each regime.
  const single = rows.filter((r) => !r.subset.includes(",")).map((r) => ({ stage: r.subset, regime: r.regime, cacheWriteKB: r.cacheWriteKB, stabMean: r.stabMean, stabMin: r.stabMin, stabTight: r.stabTight, savMean: r.savMean, savFinal: r.savFinal, viol: r.viol, idem: r.idem, msMean: r.msMean }));
  const all = rows.filter((r) => r.subset.split(",").length === a.stages.length && r.order === a.stages.join(">"));
  return {
    coverage: { stages: a.stages, nonemptySubsets: 2 ** a.stages.length - 1,
      orders: a.quick ? "canonical only" : `exhaustive through size ${a.maxPerm}; canonical plus at most ${a.randomPerms} seeded samples above`,
      headroom: "real wrapper; deterministic JSON-compaction stub, no remote model", reorder: "deterministic bag-of-words stub",
      cacheMetric: "UTF-8 common prefix of JSON serialization; not provider token cache hits or billed cache writes",
      note: "Legacy twelve-stage grouping; inject combines Caveman/Ponytail; pxpipe absent. See independent 14-toggle matrix for full toggle coverage." },
    totalConfigs: rows.length, subsetsScored: total, canonicalBest, canonicalTied, canonicalOptimal: canonicalBest + canonicalTied, globalOrderByPrecedence: globalOrder, precedence, single, allStagesCanonical: all, perSubset };
}

async function main() {
  const a = parseArgs(process.argv);
  mkdirSync(a.out, { recursive: true });
  const configs = buildConfigs(a);
  const regimes = ["wide", "tight"];
  const workers = Math.min(a.workers, configs.length);
  console.log(`configs=${configs.length} regimes=${regimes.length} workers=${workers} stages=${a.stages.join(",")}`);
  const rows = [];
  const jsonl = createWriteStream(join(a.out, "results.jsonl"));
  const per = Math.ceil(configs.length / workers);
  const started = Date.now();
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const from = w * per, to = Math.min(configs.length, from + per);
    if (from >= to) return resolve();
    const worker = new Worker(SELF, { workerData: { a, configs, from, to, regimes } });
    worker.on("message", (m) => {
      if (m === "done") return;
      for (const r of m) { rows.push(r); jsonl.write(JSON.stringify(r) + "\n"); }
      if (rows.length % 2000 < m.length) console.log(`  ${rows.length}/${configs.length * regimes.length} rows, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${w} exit ${code}`))));
  })));
  jsonl.end();
  const summary = summarize(rows, a);
  writeFileSync(join(a.out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`done: ${rows.length} rows in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${a.out}`);
  console.log(`canonical optimal in ${summary.canonicalOptimal}/${summary.subsetsScored} subset×regime cells (best ${summary.canonicalBest}, tied ${summary.canonicalTied})`);
  console.log(`global order by precedence: ${summary.globalOrderByPrecedence.join(" > ")}`);
  console.log("single-stage:");
  for (const s of summary.single) console.log(`  ${s.stage.padEnd(9)} ${s.regime.padEnd(6)} cw=${String(s.cacheWriteKB).padStart(5)}KB stab=${s.stabMean?.toFixed(3)} min=${s.stabMin?.toFixed(3)} tight=${s.stabTight?.toFixed(3) ?? "-"} sav=${(s.savMean * 100).toFixed(1)}% viol=${JSON.stringify(s.viol)} idem=${s.idem} ms=${s.msMean?.toFixed(1)}`);
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain().catch((e) => { console.error(e); process.exit(1); });
