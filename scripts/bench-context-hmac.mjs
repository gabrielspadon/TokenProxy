// Bench: measureContextStructure per-call cost on a ~1.3 MB representative body.
//
// Component attribution. `createHmac` is a direct named binding, so it cannot be
// monkeypatched at the module object. Variants are instead compiled from the
// source with the HMAC construction replaced by a no-op, written to a temp dir
// with relative specifiers rewritten absolute. The traversal, the JSON
// fragment serialization and the byte accounting all still run in every
// variant, so the delta isolates the digest cost and nothing else.
//
//   node scripts/bench-context-hmac.mjs            attribution, 4 variants
//   node scripts/bench-context-hmac.mjs --profile  per-call series + GC attribution
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PerformanceObserver } from "node:perf_hooks";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "../open-sse/utils/contextStructure.js");
const N = 500;
const REPS = 15;

const chunk = "Representative tool result content 0123456789 with unicode 日本語 🧭. ";
const big = chunk.repeat(6000); // ~430KB
const body = {
  model: "gpt-4o", stream: true,
  system: "You are a helpful assistant. ".repeat(50),
  tools: [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  messages: [
    { role: "user", content: big },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "/x" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
    { role: "assistant", content: big.slice(0, 200000) },
    { role: "user", content: "latest question " + big.slice(0, 200000) },
  ],
};
const serialized = JSON.stringify(body);
const key = Buffer.alloc(32, 7);

// Replace the HMAC construction while leaving every byte-accounting call intact.
const STUB = `const __stubDigest = "0".repeat(64);\nconst __stubHash = { update() { return __stubHash; }, digest: () => __stubDigest };\n`;
const CUTS = {
  body: [/createHmac\("sha256", key\)\.update\("context-v1:body[\s\S]*?\.digest\("hex"\)/, "__stubDigest"],
  prefix: [/const prefix = createHmac\("sha256", key\)\.update\("context-v1:history-prefix[^;]*\);/, "const prefix = __stubHash;"],
  // Byte-identical rewrite: drops the whole-body Buffer copy, keeping both
  // HMACs and every emitted field exactly as version 1 defines them.
  noalloc: [/const encodedBuffer = Buffer\.from\(encoded, "utf8"\);\s*\n\s*const bodyBytes = encodedBuffer\.length;/, 'const bodyBytes = Buffer.byteLength(encoded, "utf8");'],
  noallocBody: [/\.update\("context-v1:body\\0"\)\.update\(encodedBuffer\)/, '.update("context-v1:body\\0").update(encoded, "utf8")'],
};

const tmp = mkdtempSync(join(tmpdir(), "bench-ctx-"));
async function variant(name, cuts) {
  if (!cuts.length) return (await import(pathToFileURL(SOURCE))).measureContextStructure;
  let src = readFileSync(SOURCE, "utf8");
  for (const cut of cuts) {
    const [pattern, replacement] = CUTS[cut];
    if (!pattern.test(src)) throw new Error(`variant ${name}: pattern for '${cut}' no longer matches source`);
    src = src.replace(pattern, replacement);
  }
  // Relative specifiers would resolve against the temp dir; make them absolute.
  src = STUB + src.replace(/from "(\.[^"]*)"/g, (_, spec) => `from "${pathToFileURL(resolve(dirname(SOURCE), spec))}"`);
  const file = join(tmp, `${name}.mjs`);
  writeFileSync(file, src);
  return (await import(pathToFileURL(file))).measureContextStructure;
}

const time = (fn, calls) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < calls; i++) fn(body, "physical-dispatch", key, { serialized });
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

// Each variant runs in a FRESH process. Sharing one heap across variants lets
// earlier variants' JIT state and GC pressure leak into later ones, which
// produced impossible orderings (a stubbed variant timing slower than the
// unmodified one). Under additive host noise the MINIMUM is the robust
// estimator, so report min-of-reps rather than a mean.
async function attribution() {
  if (process.env.BENCH_VARIANT !== undefined) return child(process.env.BENCH_VARIANT);
  const specs = [
    ["(a) unmodified", "none"],
    ["(b) body HMAC stubbed", "body"],
    ["(c) history-prefix HMAC stubbed", "prefix"],
    ["(d) both stubbed", "body,prefix"],
    // Not an HMAC scope change: same digests, one fewer 1.3 MB copy. Included
    // to show what is reachable without touching the version-1 contract.
    ["(e) byte-identical, no body copy", "noalloc,noallocBody"],
  ];
  console.log(`bodyBytes: ${Buffer.byteLength(serialized)}  calls=${N}  reps=${REPS}  (min of per-rep means, isolated processes)`);
  const results = [];
  for (const [label, cuts] of specs) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)],
      { env: { ...process.env, BENCH_VARIANT: cuts }, encoding: "utf8" }).trim();
    results.push([label, Number(out)]);
  }
  const base = results[0][1];
  for (const [label, ms] of results) {
    const share = label.startsWith("(a)") ? "" : `  attributable=${(((base - ms) / base) * 100).toFixed(1)}%`;
    console.log(`${label.padEnd(34)} per-call=${ms.toFixed(3)}ms${share}`);
  }
}

async function child(cuts) {
  const fn = await variant(cuts.replace(/,/g, "_"), cuts === "none" ? [] : cuts.split(","));
  for (let i = 0; i < 30; i++) fn(body, "physical-dispatch", key, { serialized });
  const reps = [];
  for (let r = 0; r < REPS; r++) reps.push(time(fn, N) / N);
  console.log(Math.min(...reps).toFixed(4));
}

// Per-call series plus GC attribution, for the recurring-p95-spike question.
async function profile() {
  const fn = await variant("a", []);
  const gc = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) gc.push({ at: e.startTime, dur: e.duration, kind: e.detail?.kind }); })
    .observe({ entryTypes: ["gc"] });
  for (let i = 0; i < 20; i++) fn(body, "physical-dispatch", key, { serialized });

  const calls = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    fn(body, "physical-dispatch", key, { serialized });
    calls.push({ start, end: performance.now() });
  }
  await new Promise((r) => setTimeout(r, 50)); // let the observer drain
  const ms = calls.map((c) => c.end - c.start);
  const sorted = [...ms].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  console.log(`calls=${N} p50=${q(0.5).toFixed(3)}ms p95=${q(0.95).toFixed(3)}ms p99=${q(0.99).toFixed(3)}ms max=${sorted.at(-1).toFixed(3)}ms`);

  // A spike is a call well above the central tendency, matching how a gateway
  // p95 outlier is read rather than a fixed millisecond threshold.
  const threshold = q(0.5) * 1.5;
  const spikes = ms.map((v, i) => [i, v]).filter(([, v]) => v > threshold);
  const gaps = spikes.slice(1).map(([i], k) => i - spikes[k][0]);
  console.log(`spikes(>${threshold.toFixed(3)}ms)=${spikes.length} (${((spikes.length / N) * 100).toFixed(1)}%)`);
  if (gaps.length) {
    const sg = [...gaps].sort((a, b) => a - b);
    console.log(`spike period: median=${sg[sg.length >> 1]} mean=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)} range=[${sg[0]}, ${sg.at(-1)}] gaps=${gaps.slice(0, 24).join(",")}`);
  }

  const byKind = gc.reduce((acc, g) => (acc[g.kind] = (acc[g.kind] || 0) + 1, acc), {});
  console.log(`gc events=${gc.length} byKind=${JSON.stringify(byKind)} totalPause=${gc.reduce((a, g) => a + g.dur, 0).toFixed(1)}ms`);
  // Attribute each GC to the call whose window contains it.
  const gcCalls = new Set();
  for (const g of gc) {
    const i = calls.findIndex((c) => g.at < c.end && g.at + g.dur > c.start);
    if (i >= 0) gcCalls.add(i);
  }
  const spikeSet = new Set(spikes.map(([i]) => i));
  const explained = [...spikeSet].filter((i) => gcCalls.has(i)).length;
  console.log(`spikes overlapping a GC pause: ${explained}/${spikeSet.size}`);
  const gcGaps = [...gcCalls].sort((a, b) => a - b).slice(1).map((v, k) => v - [...gcCalls].sort((a, b) => a - b)[k]);
  if (gcGaps.length) {
    const sgg = [...gcGaps].sort((a, b) => a - b);
    console.log(`gc-bearing call period: median=${sgg[sgg.length >> 1]} range=[${sgg[0]}, ${sgg.at(-1)}]`);
  }
}

await (process.argv.includes("--profile") ? profile() : attribution());
