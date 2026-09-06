import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
if (!process.env.DATA_DIR) throw new Error('Explicit scratch DATA_DIR required');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [variant = 'candidate', scenario = 'small'] = process.argv.slice(2);
if (!['candidate', 'baseline'].includes(variant)) throw new Error('Invalid variant');
const baseline = '8f062c6b';
const config = {
  small: { requests: 100_000, fragmentBytes: Infinity, textSize: 100, kind: 'converter' },
  fragmented: { requests: 12, fragmentBytes: 128, textSize: 512 * 1024, kind: 'converter' },
  peek: { requests: 50_000, fragmentBytes: Infinity, textSize: 100, kind: 'peek' },
}[scenario];
if (!config) throw new Error('Invalid scenario');
async function moduleAt(path) {
  // Equalize fixture-loading work in both command-level benchmark arms.
  let source = execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' });
  if (variant === 'candidate') return import(pathToFileURL(resolve(root, path)));
  source = source.replace(/from (['"])(\.[^'"]+)\1/g, (_all, quote, specifier) => `from ${quote}${pathToFileURL(resolve(root, dirname(path), specifier)).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { convertResponsesStreamToJson } = await moduleAt('open-sse/transformer/streamToJsonConverter.js');
const { peekStreamForContent } = await moduleAt('open-sse/utils/streamContent.js');
const encoder = new TextEncoder();
const item = { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: JSON.stringify({ text: 'x'.repeat(config.textSize), anchor: 'José 🐋' }) } };
const events = [{ type: 'response.created', response: { id: 'resp-bench', created_at: 42 } }, item, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 10 } } }];
const wire = encoder.encode(config.kind === 'peek' ? 'data: {"choices":[{"delta":{"content":"progress"}}]}\n\n' : events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
const fragments = [];
for (let at = 0; at < wire.length; at += config.fragmentBytes) fragments.push(wire.subarray(at, at + config.fragmentBytes));
function stream() {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i === fragments.length) c.close(); else c.enqueue(fragments[i++]); } }, { highWaterMark: 0 });
}
async function run() {
  if (config.kind === 'peek') {
    const result = await peekStreamForContent(new Response(stream(), { headers: { 'content-type': 'text/event-stream' } }), 1000);
    if (!result.hasContent || await new Response(result.body).text() !== new TextDecoder().decode(wire)) throw new Error('Incorrect peek output');
  } else {
    const result = await convertResponsesStreamToJson(stream());
    if (result.status !== 'completed' || result.output[0].arguments !== item.item.arguments || result.usage.output_tokens !== 10) throw new Error('Incorrect collector output');
  }
}
for (let n = 0; n < (scenario === 'fragmented' ? 2 : 100); n++) await run();
global.gc?.();
const memoryBefore = process.memoryUsage();
const cpuBefore = process.cpuUsage();
const samples = [], started = performance.now();
for (let n = 0; n < config.requests; n++) { const start = performance.now(); await run(); samples.push(performance.now() - start); }
const durationMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore), memory = process.memoryUsage();
samples.sort((a, b) => a - b);
const percentile = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const sourceHash = variant === 'baseline' ? baseline : createHash('sha256').update(['open-sse/utils/sseDecoder.js', 'open-sse/utils/streamContent.js', 'open-sse/transformer/streamToJsonConverter.js'].map(path => readFileSync(resolve(root, path), 'utf8')).join('\n')).digest('hex');
console.log(JSON.stringify({ variant, scenario, baseline, sourceHash, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, architecture: process.arch, cpu: cpus()[0]?.model, requests: config.requests, bytesPerRequest: wire.byteLength, fragmentsPerRequest: fragments.length, durationMs, requestsPerSecond: config.requests * 1000 / durationMs, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), cpuUsPerRequest: (cpu.user + cpu.system) / config.requests, rssDeltaBytes: memory.rss - memoryBefore.rss, heapDeltaBytes: memory.heapUsed - memoryBefore.heapUsed, verifiedOutputs: config.requests }));
