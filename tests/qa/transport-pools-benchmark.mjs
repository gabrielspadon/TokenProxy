import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import "../setup-real-io-guard.js";
import { createTransportLoopback } from "../helpers/transport-loopback.mjs";

if (!process.env.DATA_DIR) throw new Error("Explicit scratch DATA_DIR required");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), baseline = "15ca368c";
const [variant = "candidate", scenario = "burst"] = process.argv.slice(2);
assert.ok(["baseline", "candidate"].includes(variant)); assert.ok(["burst", "warm", "mixed"].includes(scenario));
const modulePath = "open-sse/utils/proxyFetch.js", requireFromSut = createRequire(resolve(root, modulePath));
let source = execFileSync("git", ["show", `${baseline}:${modulePath}`], { cwd: root, encoding: "utf8" });
source = source.replace(/from (["'])(\.[^"']+)\1/g, (_, quote, path) => `from ${quote}${pathToFileURL(resolve(root, dirname(modulePath), path)).href}${quote}`)
  .replace(/import\((["'])(undici|socks-proxy-agent)\1\)/g, (_, _quote, name) => `import(${JSON.stringify(pathToFileURL(requireFromSut.resolve(name)).href)})`);
const dispatchers = new Set(), nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => { if (options?.dispatcher) dispatchers.add(options.dispatcher); return nativeFetch(url, options); };
const transport = await import(variant === "baseline" ? `data:text/javascript;base64,${Buffer.from(source).toString("base64")}` : pathToFileURL(resolve(root, modulePath)));
globalThis.fetch = nativeFetch;
const fixture = await createTransportLoopback();
const route = id => ({ enabled: true, url: fixture.proxyUrl.replace("//", `//user${id}:fake@`), strictProxy: true });
const target = path => `http://transport.fixture.test${path}`;
let verified = 0, cancellationMs = null, bytesWrittenBeforeCancel = null;
const latencies = [];
async function request(id) {
  const start = performance.now();
  const response = await transport.proxyAwareFetch(target("/sample"), {}, route(id));
  assert.equal(await response.text(), "verified response"); verified++; latencies.push(performance.now() - start);
}
try {
  if (scenario !== "burst") { await Promise.all(Array.from({ length: 32 }, () => request(0))); await Promise.all(Array.from({ length: 32 }, () => request(0))); }
  verified = 0; latencies.length = 0; global.gc?.();
  const cpuBefore = process.cpuUsage(), memoryBefore = process.memoryUsage();
  let sampledPeakRss = memoryBefore.rss;
  const sampler = setInterval(() => { sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); }, 5);
  const started = performance.now();
  try {
    if (scenario === "burst") for (let id = 0; id < 10; id++) await Promise.all(Array.from({ length: 32 }, () => request(id)));
    if (scenario === "warm") for (let batch = 0; batch < 32; batch++) await Promise.all(Array.from({ length: 32 }, () => request(0)));
    if (scenario === "mixed") {
      const long = await Promise.all(Array.from({ length: 8 }, () => transport.proxyAwareFetch(target("/long"), {}, route(0))));
      for (let batch = 0; batch < 16; batch++) await Promise.all(Array.from({ length: 16 }, () => request(0)));
      const bulk = await transport.proxyAwareFetch(target("/bulk"), {}, route(0)), reader = bulk.body.getReader();
      for (let n = 0; n < 3; n++) { assert.ok((await reader.read()).value.length > 0); await new Promise(resolve => setTimeout(resolve, 5)); }
      bytesWrittenBeforeCancel = fixture.stats.bulkWritten; assert.ok(bytesWrittenBeforeCancel < fixture.bulkBytes);
      const cancelAt = performance.now(), before = fixture.stats.closedBodies;
      await reader.cancel("synthetic client stop"); reader.releaseLock();
      while (fixture.stats.closedBodies === before && performance.now() - cancelAt < 100) await new Promise(resolve => setTimeout(resolve, 1));
      cancellationMs = performance.now() - cancelAt; assert.ok(fixture.stats.closedBodies > before); assert.ok(cancellationMs < 100);
      fixture.finish(); for (const response of long) assert.equal(await response.text(), "anchorfinished"); verified += 9;
    }
  } finally { clearInterval(sampler); }
  const durationMs = performance.now() - started, cpu = process.cpuUsage(cpuBefore), memory = process.memoryUsage();
  latencies.sort((a, b) => a - b);
  const percentile = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  const sourceHash = variant === "baseline" ? baseline : createHash("sha256").update([modulePath, "open-sse/utils/dispatcherCache.js"].map(path => readFileSync(resolve(root, path), "utf8")).join("\n")).digest("hex");
  console.log(JSON.stringify({ variant, scenario, baseline, sourceHash, node: process.version, undici: requireFromSut("undici/package.json").version, architecture: process.arch, cpu: cpus()[0]?.model, verifiedRequests: verified, durationMs, requestsPerSecond: verified * 1000 / durationMs, sampleRequestP50Ms: percentile(.5), sampleRequestP95Ms: percentile(.95), sampleRequestP99Ms: percentile(.99), cpuUsPerRequest: (cpu.user + cpu.system) / verified, uniqueDispatchers: dispatchers.size, tunnelConnections: fixture.stats.connects, cancellationMs, bytesWrittenBeforeCancel, rssDeltaBytes: memory.rss - memoryBefore.rss, sampledPeakRssDeltaBytes: sampledPeakRss - memoryBefore.rss }));
} finally {
  fixture.finish();
  await Promise.all([...dispatchers].map(dispatcher => dispatcher.close()));
  await transport.closeTransportDispatchers?.();
  await fixture.close();
}
