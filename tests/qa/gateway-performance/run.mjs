import { fork, spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, openSync, closeSync, existsSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release, arch, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createParser } from 'eventsource-parser';
import { quantiles, requestFailed, outsideProviderMs } from './measurements.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(s => { const [key, value = 'true'] = s.replace(/^--/, '').split('='); return [key, value]; }));
const mode = args.mode || 'routes', samples = Number(args.samples || 100), warmup = Number(args.warmup || 5), concurrency = Number(args.concurrency || 8);
if (!['routes', 'standalone'].includes(mode) || !Number.isInteger(samples) || samples < 1 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid benchmark mode or sample count');
const work = mkdtempSync(join(tmpdir(), 'tokenproxy-gateway-bench-')); chmodSync(work, 0o700);
const runId = randomUUID(), now = () => Number(process.hrtime.bigint()) / 1e6;
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC', NODE_ENV: 'production', DATA_DIR: work, BENCH_RUN_ID: runId, JWT_SECRET: randomBytes(32).toString('hex'), INITIAL_PASSWORD: randomBytes(32).toString('hex'), NEXT_TELEMETRY_DISABLED: '1', TOKENPROXY_NO_UPDATE: '1', HOSTNAME: '127.0.0.1' };
const children = [], logs = [], providerRecords = new Map(), starts = new Map();
function child(script, extra = {}, cwd = root) {
  const fd = openSync(join(work, `${script.replaceAll('/', '_')}.log`), 'w', 0o600); logs.push(fd);
  const proc = fork(script, [], { cwd, env: { ...env, ...extra }, execArgv: ['--require', join(here, 'guard.cjs')], stdio: ['ignore', fd, fd, 'ipc'] });
  children.push(proc); return proc;
}
function message(proc, predicate, timeout = 30000) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Child response timed out')); }, timeout);
    const receive = value => { if (predicate(value)) { cleanup(); resolveMessage(value); } };
    const exited = code => { cleanup(); reject(new Error(`Child exited ${code}`)); };
    const cleanup = () => { clearTimeout(timer); proc.off('message', receive); proc.off('exit', exited); };
    proc.on('message', receive); proc.once('exit', exited);
  });
}
async function metrics(proc, type) { const id = randomUUID(), result = message(proc, m => m.type === type && m.id === id); proc.send({ type, id }); return (await result).metrics; }
async function freePort() { const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency + 4 });
function request(url, body, headers = {}, options = {}) {
  return new Promise(resolveRequest => {
    const record = { id: options.id, startedAt: now(), useful: [], status: null, receivedBytes: 0, terminal: false };
    let settled = false, response, timer, jsonText = '';
    const decoder = new StringDecoder('utf8');
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      record.endedAt = now(); if (error && !record.abortAt) record.error = error.code || error.message;
      if (options.captureJson) { try { record.json = JSON.parse(jsonText); } catch {} }
      resolveRequest(record);
    };
    const parser = createParser({ onEvent(event) {
      if (event.data === '[DONE]') { record.terminal = true; return; }
      let value; try { value = JSON.parse(event.data); } catch { return; }
      if (value.type === 'message_stop' || value.choices?.some(c => c.finish_reason)) record.terminal = true;
      const text = value.choices?.[0]?.delta?.content ?? value.delta?.text ?? '';
      for (const match of text.matchAll(/B_([a-f0-9-]+)_(\d+)_([\d.]+)_/g)) record.useful.push({ at: now(), index: Number(match[2]), sentAt: Number(match[3]), id: match[1] });
      if (options.abortAfterUseful && record.useful.length === options.abortAfterUseful) { record.abortAt = now(); req.destroy(); }
    } });
    const req = http.request(url, { method: body ? 'POST' : 'GET', agent, headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      response = res; record.headersAt = now(); record.status = res.statusCode;
      res.on('data', chunk => {
        record.receivedBytes += chunk.length;
        if (options.json) { if (options.captureJson && jsonText.length < 65536) jsonText += chunk.toString(); return; }
        parser.feed(decoder.write(chunk));
        if (options.readerDelayMs) { res.pause(); setTimeout(() => res.resume(), options.readerDelayMs); }
      });
      res.on('end', () => finish()); res.on('error', finish); res.on('close', () => finish(record.abortAt ? null : !res.complete ? new Error('premature-close') : null));
    });
    req.on('error', error => finish(record.abortAt ? null : error));
    timer = setTimeout(() => { req.destroy(); response?.destroy(); finish(new Error('benchmark-timeout')); }, 20000);
    if (options.abortBeforeHeadersMs) setTimeout(() => { if (!settled) { record.abortAt = now(); req.destroy(); } }, options.abortBeforeHeadersMs);
    req.end(body);
  });
}
function fixture(id, profile, target) {
  const text = `BENCH_${id}_${profile} Please reply.`;
  const body = { model: target, messages: [{ role: 'system', content: 'Preserve instructions and tool results.' }, { role: 'user', content: text }], max_tokens: 128, stream: true };
  if (profile === 'large') body.messages[0].content += ' immutable context α '.repeat(12000);
  if (profile === 'tools') {
    body.tools = [{ type: 'function', function: { name: 'lookup', description: 'Read a measurement', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }];
    body.messages.splice(1, 0, { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{"id":"protected"}' } }] }, { role: 'tool', tool_call_id: 'call-fixture', content: '{"status":"error","value":1}' });
  }
  if (profile === 'multimodal') body.messages[1].content = [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=' } }];
  return body;
}
let receipt;
try {
  const provider = child(join(here, 'provider.mjs'), { BENCH_ALLOWED_PORTS: '0' });
  provider.on('message', m => { if (m.type === 'provider') { const rows = providerRecords.get(m.record.id) || []; rows.push(m.record); providerRecords.set(m.record.id, rows); } if (m.type === 'provider-start') starts.set(m.id, m.receivedAt); });
  const { port: providerPort } = await message(provider, m => m.type === 'ready');
  const port = await freePort(); Object.assign(env, { BENCH_PROVIDER_PORT: String(providerPort), BENCH_ALLOWED_PORTS: String(providerPort), PORT: String(port) });
  const seed = child(join(here, 'seed.mjs')); const [seedCode] = await once(seed, 'exit'); if (seedCode !== 0) throw new Error(`Seed failed, see private logs in ${work}`);
  const auth = JSON.parse(readFileSync(join(work, 'fixture-auth.json')));
  if (args.build === 'true') {
    const fd = openSync(join(work, 'build.log'), 'w', 0o600); logs.push(fd);
    const build = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], { cwd: root, env: { ...env, BENCH_BUILD: '1', NODE_OPTIONS: `--require="${join(here, 'guard.cjs')}"` }, stdio: ['ignore', fd, fd] }); children.push(build);
    if ((await once(build, 'exit'))[0] !== 0) throw new Error(`Build failed, see ${work}/build.log`);
    execFileSync(process.execPath, ['scripts/copy-standalone-assets.mjs'], { cwd: root, env });
  }
  const standalone = join(root, '.next/standalone');
  if (mode === 'standalone' && !existsSync(join(standalone, 'custom-server.js'))) throw new Error('Build standalone first with --mode=standalone --build=true');
  const gateway = child(mode === 'routes' ? join(here, 'route-server.mjs') : join(standalone, 'custom-server.js'), {}, mode === 'routes' ? root : standalone);
  const gatewayUrl = `http://127.0.0.1:${port}`, providerUrl = `http://127.0.0.1:${providerPort}`;
  let ready = false;
  for (let i = 0; i < 300; i++) { const r = await request(`${gatewayUrl}${mode === 'routes' ? '/__ready' : '/api/auth/status'}`, null, {}, { json: true }); if (r.status === 200) { ready = true; break; } if (gateway.exitCode !== null) break; await sleep(100); }
  if (!ready) throw new Error(`Gateway did not start, see private logs in ${work}`);
  const servedVersion = mode === 'standalone' ? await request(`${gatewayUrl}/api/version`, null, { cookie: `auth_token=${auth.operator}` }, { json: true, captureJson: true }) : null;
  const scenarios = (args.scenarios || 'small,large,tools,multimodal,translation,slow-stream,slow-reader,abort-headers,abort-stream,dashboard').split(',');
  const results = [];
  for (const scenario of scenarios) {
    const translated = scenario === 'translation', profile = translated ? 'small' : scenario;
    const count = ['slow-reader', 'abort-stream'].includes(scenario) ? Math.min(samples, 20) : samples;
    const collected = [], dashboard = [];
    const perform = async (arm, index) => {
      const id = randomUUID();
      const model = profile === 'multimodal' ? 'gpt-4o' : 'fixture-model';
      const body = fixture(id, profile, arm === 'gateway' ? `${translated ? 'bench-claude' : 'bench-openai'}/${model}` : model);
      if (translated && arm === 'direct') { body.system = body.messages.shift().content; }
      const path = arm === 'gateway' || !translated ? '/v1/chat/completions' : '/v1/messages';
      const record = await request(`${arm === 'gateway' ? gatewayUrl : providerUrl}${path}`, JSON.stringify(body), arm === 'gateway' ? { authorization: `Bearer ${auth.key}`, 'x-session-id': `bench-worker-${index % concurrency}` } : {}, { id, readerDelayMs: scenario === 'slow-reader' ? 3 : 0, abortAfterUseful: scenario === 'abort-stream' ? 3 : 0, abortBeforeHeadersMs: scenario === 'abort-headers' ? 50 : 0 });
      return { ...record, arm, inputBytes: Buffer.byteLength(JSON.stringify(body)) };
    };
    for (let i = 0; i < warmup; i++) { await perform('direct', i); await perform('gateway', i); }
    const startedAt = now();
    let keepReading = scenario === 'dashboard';
    const analytics = (async () => { while (keepReading) { dashboard.push(await request(`${gatewayUrl}/api/context?view=summary`, null, { cookie: `auth_token=${auth.operator}` }, { json: true })); await sleep(10); } })();
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { for (;;) { const index = next++; if (index >= count) break; const order = index % 2 ? ['gateway', 'direct'] : ['direct', 'gateway']; const pair = {}; for (const arm of order) pair[arm] = await perform(arm, index); collected.push(pair); } }));
    const pairedElapsedMs = now() - startedAt;
    await metrics(gateway, 'metrics-reset');
    const throughputStarted = now(), loadRecords = []; next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { for (;;) { const index = next++; if (index >= count) break; loadRecords.push(await perform('gateway', index)); } }));
    const elapsedMs = now() - throughputStarted, runtime = await metrics(gateway, 'metrics');
    keepReading = false; await analytics;
    await sleep(100);
    const outside = record => outsideProviderMs(record, providerRecords.get(record.id)?.[0]);
    const routed = collected.map(p => p.gateway), direct = collected.map(p => p.direct);
    const failed = requestFailed;
    const errors = [...routed, ...loadRecords].filter(failed);
    const protocolFailures = [...routed, ...loadRecords].flatMap(r => (providerRecords.get(r.id) || []).flatMap(p => Object.entries(p.checks).filter(([, value]) => !value).map(([check]) => ({ id: r.id, check }))));
    const jitter = routed.flatMap(r => r.useful.slice(1).map((v, i) => (v.at - r.useful[i].at) - (v.sentAt - r.useful[i].sentAt)));
    const abortLatency = routed.filter(r => r.abortAt).map(r => { const p = providerRecords.get(r.id)?.[0]; return p?.aborted ? p.closedAt - r.abortAt : NaN; });
    const duplicates = routed.filter(r => (providerRecords.get(r.id)?.length || 0) > 1).length;
    const result = { scenario, samples: count, warmupPerArm: warmup, concurrency, elapsedMs, pairedElapsedMs, throughputSamples: loadRecords.length, completedRequestsPerSecond: loadRecords.filter(r => !failed(r) && !r.abortAt).length * 1000 / elapsedMs, cancelledRequestsPerSecond: loadRecords.filter(r => r.abortAt).length * 1000 / elapsedMs, errors: errors.map(r => ({ status: r.status, error: r.error, terminal: r.terminal, usefulEvents: r.useful.length })), protocolFailures, duplicateUpstreamRequests: duplicates, firstUsefulMs: quantiles(routed.map(r => r.useful[0]?.at - r.startedAt)), directFirstUsefulMs: quantiles(direct.map(r => r.useful[0]?.at - r.startedAt)), gatewayAddedFirstUsefulMs: quantiles(collected.map(p => outside(p.gateway) - outside(p.direct))), endToEndMs: quantiles(routed.map(r => r.endedAt - r.startedAt)), deliveryJitterMs: quantiles(jitter), abortPropagationMs: quantiles(abortLatency), abortedUpstreams: abortLatency.filter(Number.isFinite).length, dashboard: { samples: dashboard.length, errors: dashboard.filter(r => r.status !== 200).length, latencyMs: quantiles(dashboard.map(r => r.endedAt - r.startedAt)) }, runtime, peakRssGrowthBytesPerConcurrentStream: runtime.rssGrowthBytes / concurrency, raw: collected, loadRecords };
    const upstreams = loadRecords.flatMap(r => providerRecords.get(r.id) || []);
    result.upstreamBackpressure = { blockedWrites: upstreams.reduce((sum, p) => sum + p.blockedWrites, 0), drainMs: quantiles(upstreams.map(p => p.drainMs)) };
    result.clientToProviderMs = quantiles(routed.map(r => providerRecords.get(r.id)?.[0]?.receivedAt - r.startedAt));
    results.push(result); console.log(JSON.stringify({ scenario, samples: count, errors: errors.length, addedP95Ms: result.gatewayAddedFirstUsefulMs.p95, firstP95Ms: result.firstUsefulMs.p95, abortP95Ms: result.abortPropagationMs.p95 }));
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(work, 'db/data.sqlite'), { readOnly: true });
  const durable = { integrity: db.prepare('PRAGMA quick_check').get(), requests: db.prepare('SELECT count(*) AS n FROM requestStats').get().n, usage: db.prepare('SELECT count(*) AS n FROM usageHistory').get().n, duplicateUsageRequests: db.prepare('SELECT count(*) AS n FROM (SELECT requestId FROM usageHistory WHERE requestId IS NOT NULL GROUP BY requestId HAVING count(*)>1)').get().n, usageTotals: db.prepare('SELECT sum(promptTokens) AS inputTokens, sum(completionTokens) AS outputTokens FROM usageHistory').get(), walBytes: existsSync(join(work, 'db/data.sqlite-wal')) ? statSync(join(work, 'db/data.sqlite-wal')).size : 0 }; db.close();
  receipt = { schemaVersion: 1, runId, capturedAt: new Date().toISOString(), mode, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), servedBuildSha: servedVersion?.json?.buildSha ?? null, runtime: process.versions, database: { ...auth.stats, durable }, hardware: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), loadAverage: loadavg() }, isolation: { work, controlledLoopbackOnly: true, providerRequests: [...providerRecords.values()].reduce((n, rows) => n + rows.length, 0), productionDataAccess: false }, providerRecords: [...providerRecords.values()].flat(), results };
  receipt.validity = { responseErrors: results.reduce((n, r) => n + r.errors.length, 0), protocolFailures: results.reduce((n, r) => n + r.protocolFailures.length, 0), duplicateUpstreamRequests: [...providerRecords.values()].filter(rows => rows.length > 1).length, duplicateUsageRequests: durable.duplicateUsageRequests };
  if (Object.values(receipt.validity).some(n => n > 0)) process.exitCode = 1;
  const output = resolve(args.output || join(work, 'receipt.json')); writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); console.log(`Receipt ${output}`);
} finally {
  agent.destroy();
  for (const proc of children.reverse()) { if (proc.exitCode === null) { const ended = once(proc, 'exit'); proc.kill('SIGTERM'); await Promise.race([ended, sleep(3000)]); if (proc.exitCode === null) { proc.kill('SIGKILL'); await ended; } } }
  for (const fd of logs) closeSync(fd);
}
