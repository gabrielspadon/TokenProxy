// Runtime-only guard. Each run permits only its owned loopback provider port.
const net = require('node:net');
const dns = require('node:dns');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const ports = new Set(String(process.env.BENCH_ALLOWED_PORTS || '').split(',').map(Number));
if (!process.env.DATA_DIR || !process.env.BENCH_RUN_ID || !ports.size) throw new Error('Benchmark isolation is required');
const state = { deniedNetwork: 0, deniedProcesses: 0 };
const denial = () => Object.assign(new Error('Benchmark guard denied external I/O'), { code: 'BENCH_IO_DENIED' });
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object' ? first.host : args[1];
  const port = Number(typeof first === 'object' ? first.port : first);
  if (!['127.0.0.1', '::1'].includes(host) || !ports.has(port)) { state.deniedNetwork++; throw denial(); }
  return connect.apply(this, args);
};
const literal = (host, options) => {
  if (!['127.0.0.1', '::1'].includes(host)) { state.deniedNetwork++; throw denial(); }
  const value = { address: host, family: host === '::1' ? 6 : 4 };
  return options?.all ? [value] : value;
};
dns.lookup = (host, options, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  try { const value = literal(host, options); queueMicrotask(() => options?.all ? cb(null, value) : cb(null, value.address, value.family)); }
  catch (error) { queueMicrotask(() => cb(error)); }
};
dns.promises.lookup = async (host, options) => literal(host, options);
for (const obj of [dns, dns.Resolver.prototype, dns.promises, dns.promises.Resolver.prototype]) {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if ((key.startsWith('resolve') || key === 'reverse' || key === 'lookupService') && typeof obj[key] === 'function') {
      obj[key] = function (...args) { state.deniedNetwork++; const cb = args.at(-1); if (typeof cb === 'function') queueMicrotask(() => cb(denial())); else return Promise.reject(denial()); };
    }
  }
}
if (process.env.BENCH_BUILD !== '1') for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = () => { state.deniedProcesses++; throw denial(); };
syncBuiltinESMExports();
const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable();
let cpu = process.cpuUsage(), started = performance.now(), rssBase = process.memoryUsage().rss, peakRss = rssBase;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10); sample.unref();
process.on('message', msg => {
  if (msg?.type === 'metrics-reset') {
    delay.reset(); cpu = process.cpuUsage(); started = performance.now(); rssBase = process.memoryUsage().rss; peakRss = rssBase;
    process.send?.({ type: 'metrics-reset', id: msg.id });
  }
  if (msg?.type === 'metrics') {
    const used = process.cpuUsage(cpu);
    process.send?.({ type: 'metrics', id: msg.id, metrics: { elapsedMs: performance.now() - started, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, rssBaseBytes: rssBase, peakRssBytes: peakRss, rssGrowthBytes: peakRss - rssBase, memory: process.memoryUsage(), eventLoopLagMs: { p50: delay.percentile(50) / 1e6, p95: delay.percentile(95) / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 }, ...state } });
  }
});
