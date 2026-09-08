import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';
import { createPxpipeWorkerPool } from '../../../src/lib/pxpipe/workerPool.mjs';
import { transformAnthropicMessages } from './fixture.mjs';

const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const arm = options.arm, size = Number(options.size || 32768), samples = 20, warmup = 3;
if (!['direct', 'worker'].includes(arm) || ![32768, 1048576].includes(size)) throw new Error('Unsupported controlled scenario');
const body = new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(size) }));
const entry = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
const pool = createPxpipeWorkerPool({ entry });
const run = () => arm === 'worker' ? pool.run({ body }) : transformAnthropicMessages({ body });
const expected = createHash('sha256').update(body).digest('hex');
const verify = result => { if (result.digest !== expected || result.body.byteLength !== body.byteLength) throw new Error('Invalid output'); };
const coldStarted = performance.now(); verify(await run()); const coldMs = performance.now() - coldStarted;
for (let index = 0; index < warmup; index++) verify(await run());
let last = performance.now(), maximumHeartbeatDelayMs = 0, heartbeatTicks = 0;
const heartbeat = setInterval(() => { const now = performance.now(); maximumHeartbeatDelayMs = Math.max(maximumHeartbeatDelayMs, now - last); last = now; heartbeatTicks++; }, 1);
await delay(5); maximumHeartbeatDelayMs = 0; heartbeatTicks = 0; last = performance.now();
const started = performance.now(), cpuStarted = process.cpuUsage(), latencies = [];
for (let index = 0; index < samples; index++) {
  const at = performance.now(); verify(await run()); latencies.push(performance.now() - at);
}
const durationMs = performance.now() - started, cpu = process.cpuUsage(cpuStarted);
await delay(5); clearInterval(heartbeat); await pool.close();
latencies.sort((a, b) => a - b);
const quantile = fraction => latencies[Math.ceil(fraction * samples) - 1];
console.log(JSON.stringify({ arm, sizeBytes: body.byteLength, samples, warmup, coldMs, durationMs,
  operationsPerSecond: samples * 1000 / durationMs, p50Ms: quantile(.5), p95Ms: quantile(.95), maximumHeartbeatDelayMs, heartbeatTicks,
  cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, runtime: process.version, platform: process.platform, arch: process.arch,
  hardware: cpus()[0].model, cpuCount: cpus().length, memoryBytes: totalmem(),
  fixtureHash: createHash('sha256').update(readFileSync(entry)).digest('hex'),
  workerSourceHash: createHash('sha256').update(readFileSync(fileURLToPath(new URL('../../../src/lib/pxpipe/workerPool.mjs', import.meta.url)))).digest('hex'),
  scope: 'Same deterministic CPU surrogate, warmed work plus transfer and scheduling; not actual PXPIPE performance or gateway latency.',
}));
