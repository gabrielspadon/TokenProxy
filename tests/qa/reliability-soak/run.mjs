#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseOptions, prepareArtifacts, privateEnvironment, reservePort, runCommand,
  sha256File, startOwnedArtifact,
} from '../../../scripts/qa/verify-standalone.mjs';
import { CASES, FULL_DURATION_MS, FULL_REQUESTS, processResources, qualification, readHistory, readJournal, reconcile, resourceSummary } from './evidence.mjs';
import { startSoakProvider } from './provider.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function number(options, name, defaultValue, min, max) {
  const value = Number(options[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid --${name}`);
  return value;
}

export function configuration(argv) {
  const options = parseOptions(argv);
  const allowed = new Set(['mode', 'artifacts', 'standalone-root', 'artifact-sha256', 'candidate-sha', 'candidate-version', 'front-root', 'front-sha', 'seed-script', 'duration-ms', 'requests', 'concurrency', 'epoch-ms', 'sustained-ms', 'sample-ms', 'pause-budget-ms']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`unknown --${key}`);
  const mode = options.mode || 'full';
  if (!['full', 'smoke'].includes(mode)) throw new Error('--mode must be full or smoke');
  for (const key of ['artifacts', 'standalone-root', 'front-root', 'seed-script']) {
    if (!options[key] || !isAbsolute(options[key])) throw new Error(`absolute --${key} is required`);
  }
  for (const key of ['candidate-sha', 'front-sha']) if (!SHA.test(options[key] || '')) throw new Error(`full --${key} is required`);
  if (!SHA256.test(options['artifact-sha256'] || '')) throw new Error('--artifact-sha256 must identify the standalone tree');
  if (!options['candidate-version']) throw new Error('--candidate-version is required');
  const requests = number(options, 'requests', mode === 'full' ? FULL_REQUESTS : CASES.length * 2, CASES.length, 1_000_000);
  const durationMs = number(options, 'duration-ms', mode === 'full' ? FULL_DURATION_MS : 5_000, 1000, 24 * FULL_DURATION_MS);
  const epochMs = number(options, 'epoch-ms', mode === 'full' ? 300_000 : 1_000, 1000, 600_000);
  const sustainedMs = number(options, 'sustained-ms', mode === 'full' ? 30_000 : 100, 25, 120_000);
  if (mode === 'full' && (requests < FULL_REQUESTS || durationMs < FULL_DURATION_MS || epochMs > durationMs / 6 || sustainedMs < 30_000)) throw new Error('full qualification cannot reduce request, duration, restart, or sustained-stream requirements');
  return {
    ...options, mode, requests, durationMs, epochMs, sustainedMs,
    concurrency: number(options, 'concurrency', 8, 1, 32),
    sampleMs: number(options, 'sample-ms', mode === 'full' ? 5_000 : 100, 100, 10_000),
    pauseBudgetMs: number(options, 'pause-budget-ms', 3500, 1000, 3800),
  };
}

// Bind the files actually launched, independently of a version endpoint that could lie.
// Dependencies are included. Runtime logs/data must live outside this immutable tree.
export function artifactTreeSha256(directory) {
  const digest = createHash('sha256');
  const seenDirectories = new Set();
  const visit = (path, prefix = '') => {
    const canonical = realpathSync(path);
    if (seenDirectories.has(canonical)) throw new Error('artifact has a directory cycle');
    seenDirectories.add(canonical);
    for (const name of readdirSync(path).sort()) {
      const item = join(path, name);
      const label = `${prefix}${name}`;
      const metadata = lstatSync(item);
      if (metadata.isSymbolicLink()) throw new Error(`artifact symlink is not self-contained: ${label}`);
      if (metadata.isDirectory()) visit(item, `${label}/`);
      else if (metadata.isFile()) {
        digest.update(`${label}\0${metadata.mode & 0o777}\0${metadata.size}\0`);
        digest.update(readFileSync(item));
      } else throw new Error(`artifact is not a regular file: ${label}`);
    }
    seenDirectories.delete(canonical);
  };
  visit(directory);
  return digest.digest('hex');
}

function frontBinding(frontRoot, expectedSha) {
  const git = (args) => {
    const result = spawnSync('git', ['-C', frontRoot, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('front provenance cannot be resolved');
    return result.stdout.trim();
  };
  if (git(['rev-parse', 'HEAD']) !== expectedSha) throw new Error('front HEAD does not match requested SHA');
  const scope = 'services/tokenproxy';
  if (git(['status', '--porcelain', '--untracked-files=all', '--', scope])) throw new Error('canonical front source has uncommitted changes');
  const files = git(['ls-files', '--', scope]).split('\n').filter(Boolean);
  if (!files.includes(`${scope}/front-proxy.mjs`) || !files.includes(`${scope}/front-outcome-journal.mjs`)) throw new Error('front journal implementation is not tracked');
  return { sha: expectedSha, files: files.map((path) => ({ path, sha256: sha256File(join(frontRoot, path)) })) };
}

function control(socketPath, action = 'status', timeoutMs = 1500) {
  return new Promise((done, reject) => {
    const request = http.request({ socketPath, path: `/${action}`, method: action === 'status' ? 'GET' : 'POST' }, (response) => {
      let text = '';
      response.on('data', (chunk) => {
        text += chunk;
        if (text.length > 64 * 1024) request.destroy(new Error('front control response too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const body = JSON.parse(text);
          if (response.statusCode !== 200) throw new Error(`front ${action} returned ${response.statusCode}`);
          done(body);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`front ${action} timed out`)));
    request.once('error', reject);
    request.end();
  });
}

function assertQuiet(status) {
  if (status.active !== 0 || status.dispatching !== 0 || status.queued !== 0) throw new Error('front is not quiet');
  if (status.journal_healthy !== true || status.backend_ready !== true || status.public_ready !== true) throw new Error('front is not ready with a healthy journal');
}

async function waitQuiet(socket, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  let status;
  while (performance.now() < deadline) {
    status = await control(socket);
    if (status.active === 0 && status.dispatching === 0 && status.queued === 0) { assertQuiet(status); return status; }
    await delay(25);
  }
  throw new Error(`front never quiesced (${JSON.stringify(status)})`);
}

export async function clientRequest({ baseUrl, authorization, id, scenario, phase, timeoutMs = 45_000 }) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request deadline')), timeoutMs);
  const row = { id, case: scenario, phase, state: 'failed', status: null, frontIngressId: null, logicalRequestId: null, receivedContent: false, terminalFrame: false };
  try {
    const streaming = ['stream', 'sustained', 'cancel', 'stream-reset'].includes(scenario);
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: scenario === 'unauthorized' ? 'Bearer invalid-soak-key' : authorization, 'content-type': 'application/json' },
      body: scenario === 'malformed' ? '{' : JSON.stringify({
        model: scenario === 'unknown-model' ? 'soak-missing/model' : 'fixture/fixture-model',
        messages: [{ role: 'user', content: `soak:${id}:${scenario}` }], stream: streaming, max_tokens: 8,
      }),
    });
    row.status = response.status;
    row.frontIngressId = response.headers.get('x-tokenproxy-front-request-id');
    row.logicalRequestId = response.headers.get('x-tokenproxy-logical-request-id');
    row.replaySafe = response.headers.get('x-tokenproxy-replay-safe');
    if (['malformed', 'unauthorized', 'unknown-model', 'provider-reject'].includes(scenario)) {
      await response.text();
      const expected = scenario === 'unauthorized' ? [401, 403] : scenario === 'unknown-model' ? [400, 404] : [400];
      if (!expected.includes(response.status)) throw new Error(`expected rejection, received HTTP ${response.status}`);
    } else if (streaming) {
      if (response.status !== 200) throw new Error(`expected stream HTTP 200, received ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let output = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
          if (output.length > 64 * 1024) throw new Error('fixture response too large');
          row.receivedContent = output.includes('soak-content');
          row.terminalFrame = output.includes('[DONE]');
          if (scenario === 'cancel' && row.receivedContent) { await reader.cancel(); controller.abort(); break; }
        }
      } catch (error) {
        if (scenario !== 'stream-reset' || !row.receivedContent) throw error;
        row.transportTerminated = true;
      }
      if (!row.receivedContent) throw new Error('stream lost fixture content');
      if (scenario === 'stream-reset') {
        if (row.terminalFrame || !row.transportTerminated) throw new Error('abrupt provider stream became an apparent completed stream');
        if (row.replaySafe === 'true') throw new Error('partial generation incorrectly marked replay safe');
      } else if (scenario !== 'cancel' && !row.terminalFrame) throw new Error('stream lacks terminal frame');
    } else {
      const body = await response.json();
      if (response.status !== 200 || body.choices?.[0]?.message?.content !== 'soak-content') throw new Error('successful JSON body mismatch');
      row.receivedContent = true;
    }
    row.state = 'passed';
  } catch (error) { row.error = error.message; }
  finally { clearTimeout(timer); row.durationMs = performance.now() - started; }
  return row;
}

async function dashboardRead(baseUrl, cookie) {
  const started = performance.now();
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60_000);
    const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), view: 'economics', facets: 'summary,groups,series', pageSize: '50' });
    const response = await fetch(`${baseUrl}/api/analytics?${query}`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    if (response.status !== 200 || !body.summary) throw new Error(`dashboard analytics returned ${response.status} without summary`);
    return { state: 'passed', status: response.status, durationMs: performance.now() - started };
  } catch (error) { return { state: 'failed', error: error.message, durationMs: performance.now() - started }; }
}

function validateCleanup(value) {
  return value?.graceful === true && value.forced === false && value.listenerGone === true && value.processesGone === true && value.exitCode === 0;
}

export async function runSoak(config) {
  const started = performance.now();
  const receipt = {
    schema: 'tokenproxy-reliability-soak-v1', mode: config.mode, state: 'failed', startedAt: new Date().toISOString(),
    candidate: { sha: config['candidate-sha'], version: config['candidate-version'], artifactSha256: config['artifact-sha256'] },
    config: { requests: config.requests, durationMs: config.durationMs, epochMs: config.epochMs, sustainedMs: config.sustainedMs, concurrency: config.concurrency, sampleMs: config.sampleMs, pauseBudgetMs: config.pauseBudgetMs },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    deterministicCompleted: 0, mixedDurationMs: 0, clients: [], dashboard: [], resources: [], quiescentResources: [], cutovers: [], starts: [], errors: [], cleanup: {},
  };
  let runRoot, provider, gateway, front, interval, sampling = false, aborted = false;
  let socket, database, journalDirectory, keyringPath, verifyReceipt;
  const abort = () => { aborted = true; receipt.errors.push('operator signal interrupted qualification'); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const save = () => {
    if (runRoot) writeFileSync(join(config.artifacts, 'soak-evidence.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    if (process.platform !== 'linux') throw new Error('Linux process identity and resource proof required');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer required for qualification');
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) if (existsSync(join(config['standalone-root'], name))) throw new Error('artifact contains an implicit environment file');
    const pathWithin = (a, b) => { const rel = relative(resolve(a), resolve(b)); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
    if (pathWithin(config['standalone-root'], config.artifacts) || pathWithin(config['front-root'], config.artifacts)) throw new Error('artifacts must be outside source and executable trees');
    const artifactHash = artifactTreeSha256(config['standalone-root']);
    if (artifactHash !== config['artifact-sha256']) throw new Error('standalone artifact SHA256 mismatch');
    receipt.front = frontBinding(config['front-root'], config['front-sha']);
    receipt.seed = { path: config['seed-script'], sha256: sha256File(config['seed-script']) };
    runRoot = prepareArtifacts(config.artifacts);
    const logDir = join(runRoot, 'logs'); mkdirSync(logDir, { mode: 0o700 });
    provider = await startSoakProvider({ sustainedMs: config.sustainedMs });
    const gatewayPort = await reservePort();
    const frontPort = await reservePort();
    if (gatewayPort === frontPort) throw new Error('reserved ports collided');
    journalDirectory = join(runRoot, 'front-telemetry');
    keyringPath = join(runRoot, 'front-auth', 'keyring.json');
    socket = join(runRoot, 'front-control.sock');
    database = join(runRoot, 'data', 'db', 'data.sqlite');
    const guard = join(root, 'tests/qa/gateway-performance/guard.cjs');
    const authFile = join(runRoot, 'authorization');
    const env = privateEnvironment(runRoot, {
      NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
      BENCH_RUN_ID: 't10-isolated-soak', BENCH_ALLOWED_PORTS: `${new URL(provider.baseUrl).port},${gatewayPort},${frontPort}`,
      TOKENPROXY_ARTIFACT_LOG_DIR: logDir,
      TOKENPROXY_FRONT_TELEMETRY_DIR: journalDirectory, TOKENPROXY_FRONT_TELEMETRY_KEYRING: keyringPath,
      CAPABILITY_PROVIDER_BASE_URL: `${provider.baseUrl}/v1`, CAPABILITY_AUTH_FILE: authFile,
    });
    const seed = await runCommand(process.execPath, [config['seed-script']], { cwd: dirname(config['seed-script']), env, timeoutMs: 60_000 });
    writeFileSync(join(logDir, 'seed.log'), `${seed.stdout}\n${seed.stderr}`, { mode: 0o600 });
    if (seed.code !== 0) throw new Error(`synthetic seed failed with exit ${seed.code}`);
    const authorization = readFileSync(authFile, 'utf8').trim();
    if (!authorization.startsWith('Bearer ')) throw new Error('seed authorization missing');
    const launch = { command: process.execPath, args: () => [join(config['standalone-root'], 'custom-server.js')], cwd: config['standalone-root'] };
    const startGateway = async () => {
      const value = await startOwnedArtifact({ launch, env, candidate: receipt.candidate, port: gatewayPort, label: `gateway-${receipt.starts.length}` });
      receipt.starts.push(value.receipt); return value;
    };
    gateway = await startGateway();
    const frontState = join(runRoot, 'front-state');
    mkdirSync(frontState, { mode: 0o700 });
    writeFileSync(join(frontState, 'front-public.json'), JSON.stringify({ schema_version: 1, public_enabled: true }), { mode: 0o600 });
    const frontEnv = privateEnvironment(runRoot, {
      ...env,
      TOKENPROXY_FRONT_HOST: '127.0.0.1', TOKENPROXY_FRONT_PORT: String(frontPort),
      TOKENPROXY_FRONT_UPSTREAM_URL: gateway.baseUrl, TOKENPROXY_FRONT_STATE_DIR: join(runRoot, 'front-state'),
      TOKENPROXY_FRONT_CONTROL_SOCKET: socket, TOKENPROXY_FRONT_BACKEND_POLL_MS: '100',
      TOKENPROXY_FRONT_PAUSE_TIMEOUT_MS: String(config.pauseBudgetMs), TOKENPROXY_FRONT_PAUSE_LEASE_MS: '3900',
    });
    const frontLaunch = { command: process.execPath, args: () => [join(config['front-root'], 'services/tokenproxy/front-proxy.mjs')], cwd: join(config['front-root'], 'services/tokenproxy') };
    front = await startOwnedArtifact({ launch: frontLaunch, env: frontEnv, candidate: receipt.candidate, port: frontPort, label: 'front' });
    receipt.front.start = front.receipt;
    ({ verifyFrontOutcomeReceipt: verifyReceipt } = await import(pathToFileURL(join(config['front-root'], 'services/tokenproxy/front-outcome-journal.mjs')).href));
    const login = await fetch(`${front.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.INITIAL_PASSWORD }), signal: AbortSignal.timeout(5000),
    });
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    if (login.status !== 200 || !cookie.includes('auth_token=')) throw new Error('synthetic dashboard login failed');
    const sample = async (quiescent = false) => {
      if (!gateway || !front || sampling) return;
      sampling = true;
      try {
        const status = await control(socket);
        const backend = processResources(gateway.ownership.listener), frontProcess = processResources(front.ownership.listener);
        const value = { elapsedMs: performance.now() - started, phase: receipt.mixedStartedAt ? 'mixed' : 'deterministic', gatewayPid: gateway.ownership.listener.pid, gatewayRssBytes: backend.rssBytes, gatewayFdCount: backend.fdCount, frontRssBytes: frontProcess.rssBytes, frontFdCount: frontProcess.fdCount, queued: status.queued, active: status.active, dispatching: status.dispatching, providerActive: provider.active };
        receipt.resources.push(value);
        if (quiescent) receipt.quiescentResources.push(value);
      } catch (error) { receipt.errors.push(`resource sampling failed: ${error.message}`); }
      finally { sampling = false; }
    };
    interval = setInterval(() => { void sample(); }, config.sampleMs);
    const requestOne = async (scenario, phase, index) => {
      const row = await clientRequest({ baseUrl: front.baseUrl, authorization, id: `${phase}-${index}`, scenario, phase, timeoutMs: Math.max(45_000, config.sustainedMs + 15_000) });
      receipt.clients.push(row);
      if (row.state !== 'passed') throw new Error(`${row.id} ${scenario}: ${row.error}`);
      return row;
    };
    const settleWorkload = async () => {
      await waitQuiet(socket);
      const deadline = performance.now() + 5000;
      while (provider.active > 0 && performance.now() < deadline) await delay(25);
      if (provider.active !== 0) throw new Error('provider dispatch remained active after caller completion');
    };
    const lanes = async (jobs) => {
      const results = await Promise.allSettled(jobs.map(async (job) => {
        try { return await job(); }
        catch (error) { aborted = true; throw error; }
      }));
      const failed = results.find((value) => value.status === 'rejected');
      if (failed) throw failed.reason;
    };
    // Static scheduling and unique fixture IDs make failure cells independent of arrival order.
    let next = 0;
    await lanes(Array.from({ length: config.concurrency }, () => async () => {
      while (!aborted && next < config.requests) {
        const index = next++;
        await requestOne(CASES[index % CASES.length], 'deterministic', index);
        receipt.deterministicCompleted += 1;
      }
    }));
    if (aborted) throw new Error('qualification interrupted');
    await settleWorkload(); await sample(true); save();
    const mixedStarted = performance.now(); receipt.mixedStartedAt = new Date().toISOString();
    let mixedIndex = 0;
    while (!aborted && performance.now() - mixedStarted < config.durationMs) {
      const epochEnd = Math.min(mixedStarted + config.durationMs, performance.now() + config.epochMs);
      await lanes([
        ...Array.from({ length: Math.min(config.concurrency, 8) }, (_, lane) => async () => {
          while (!aborted && performance.now() < epochEnd) {
            const index = mixedIndex++;
            const scenario = lane === 0 ? 'sustained' : CASES[index % CASES.length];
            await requestOne(scenario, 'mixed', index);
            await delay(20);
          }
        }),
        async () => {
          while (!aborted && performance.now() < epochEnd) {
            const row = await dashboardRead(front.baseUrl, cookie); receipt.dashboard.push(row);
            if (row.state !== 'passed') throw new Error(row.error);
            await delay(Math.min(config.sampleMs, 1000));
          }
        },
      ]);
      if (aborted) break;
      const cutover = { sequence: receipt.cutovers.length + 1, state: 'failed', kind: 'same-artifact-quiet-restart', queuedClients: 2, artifactSha: receipt.candidate.sha };
      receipt.cutovers.push(cutover);
      await settleWorkload(); await sample(true);
      clearInterval(interval); interval = null;
      while (sampling) await delay(10);
      const pauseStart = performance.now();
      let probes = [];
      let probesDone = Promise.resolve([]);
      try {
        const paused = await control(socket, 'pause');
        assertQuiet(paused);
        if (!paused.activation_paused) throw new Error('pause did not take ownership');
        probes = [requestOne('json', 'cutover', mixedIndex++), requestOne('stream', 'cutover', mixedIndex++)];
        probesDone = Promise.allSettled(probes);
        // The front owns admission throughout. No other process is selected or signalled.
        cutover.stop = await gateway.close(); gateway = null;
        if (!validateCleanup(cutover.stop)) throw new Error('gateway quiet stop failed');
        gateway = await startGateway();
        const remaining = config.pauseBudgetMs - (performance.now() - pauseStart);
        if (remaining <= 0) throw new Error('quiet restart exceeded pause budget');
        const resumed = await control(socket, 'resume', Math.min(1000, remaining));
        cutover.pauseMs = performance.now() - pauseStart;
        if (resumed.activation_paused || cutover.pauseMs >= config.pauseBudgetMs) throw new Error('front did not resume within budget');
        const probeResults = await probesDone;
        const failed = probeResults.find((value) => value.status === 'rejected');
        if (failed) throw failed.reason;
        await settleWorkload();
        cutover.state = 'passed';
      } catch (error) {
        cutover.error = error.message; cutover.pauseMs = performance.now() - pauseStart;
        throw error;
      } finally {
        try { await control(socket, 'resume'); } catch (error) { receipt.errors.push(`restart resume failed: ${error.message}`); }
        await probesDone;
        interval = setInterval(() => { void sample(); }, config.sampleMs);
      }
      receipt.mixedDurationMs = performance.now() - mixedStarted;
      await sample(true); save();
      process.stdout.write(`soak elapsed_ms=${Math.round(receipt.mixedDurationMs)} clients=${receipt.clients.length} cutovers=${receipt.cutovers.length} errors=${receipt.errors.length}\n`);
    }
    receipt.mixedDurationMs = performance.now() - mixedStarted;
    receipt.mixedFinishedAt = new Date().toISOString();
    if (aborted) throw new Error('qualification interrupted');
    await settleWorkload();
    await sample(true);
    receipt.resourceSummary = resourceSummary(receipt.resources.filter((sample) => sample.phase === 'mixed'));
    receipt.quiescentSummary = resourceSummary(receipt.quiescentResources.filter((sample) => sample.phase === 'mixed'));
    for (const field of ['queued', 'active', 'dispatching', 'providerActive']) {
      if (receipt.quiescentResources.some((sample) => sample[field] !== 0)) receipt.errors.push(`quiescent ${field} backlog is nonzero`);
    }
    for (const field of ['frontFdCount', 'gatewayFdCount', 'frontRssBytes', 'gatewayRssBytes']) {
      if (receipt.quiescentSummary[field]?.monotonicallyGrowing) receipt.errors.push(`monotonically growing quiescent ${field}`);
    }
  } catch (error) { receipt.errors.push(error.message); if (error.receipt) receipt.startupFailure = error.receipt; }
  finally {
    clearInterval(interval);
    // Every terminal check runs even when workload, restart, or preceding cleanup failed.
    // Close front first, then leave the running gateway time to import its final journal.
    if (front) {
      try { receipt.cleanup.front = await front.close(); if (!validateCleanup(receipt.cleanup.front)) receipt.errors.push('front cleanup failed'); }
      catch (error) { receipt.errors.push(`front cleanup: ${error.message}`); }
    }
    if (gateway) {
      try { await delay(6500); receipt.cleanup.gateway = await gateway.close(); if (!validateCleanup(receipt.cleanup.gateway)) receipt.errors.push('gateway cleanup failed'); }
      catch (error) { receipt.errors.push(`gateway cleanup: ${error.message}`); }
    }
    if (provider) {
      try { receipt.cleanup.provider = await provider.close(); }
      catch (error) { receipt.errors.push(`provider cleanup: ${error.message}`); }
    }
    if (database && existsSync(database)) {
      let history, journal;
      try { history = readHistory(database); receipt.history = history; }
      catch (error) { receipt.errors.push(`history reconciliation: ${error.message}`); }
      try { journal = readJournal(journalDirectory, keyringPath, verifyReceipt); receipt.journal = { files: journal.files, records: journal.records.length }; }
      catch (error) { receipt.errors.push(`signed journal reconciliation: ${error.message}`); }
      if (history && journal) receipt.reconciliation = reconcile({ clients: receipt.clients, provider: provider?.requests || [], history, journal });
    }
    receipt.provider = provider?.requests || [];
    if (runRoot) {
      try {
        const secrets = ['artifact-fixture-jwt-secret-000000000000', 'artifact-fixture-api-secret-111111111111', 'fixture-upstream-key'];
        for (const name of readdirSync(join(runRoot, 'logs'))) {
          const text = readFileSync(join(runRoot, 'logs', name), 'utf8');
          if (secrets.some((secret) => text.includes(secret))) receipt.errors.push(`canary secret appeared in log ${name}`);
        }
        receipt.artifactUnchanged = artifactTreeSha256(config['standalone-root']) === config['artifact-sha256'];
        if (!receipt.artifactUnchanged) receipt.errors.push('artifact tree changed during soak');
      } catch (error) { receipt.errors.push(`final evidence check: ${error.message}`); }
    }
    receipt.finishedAt = new Date().toISOString(); receipt.elapsedMs = performance.now() - started;
    receipt.resourceSummary ||= resourceSummary(receipt.resources.filter((sample) => sample.phase === 'mixed'));
    receipt.quiescentSummary ||= resourceSummary(receipt.quiescentResources.filter((sample) => sample.phase === 'mixed'));
    receipt.gatewayResourceEpochs = [...new Set(receipt.resources.map((sample) => sample.gatewayPid))].map((pid) => ({
      pid, summary: resourceSummary(receipt.resources.filter((sample) => sample.gatewayPid === pid)),
    }));
    const counters = receipt.reconciliation;
    receipt.checks = {
      noProxyLoss: counters?.state === 'passed' && receipt.clients.every((row) => row.state === 'passed'),
      noUnsafeReplay: counters?.unsafeReplay === 0, noStalePending: counters?.stalePending === 0,
      resourcesReleased: validateCleanup(receipt.cleanup.gateway) && validateCleanup(receipt.cleanup.front) && receipt.cleanup.provider === true,
      resourceSlopes: Number.isFinite(receipt.quiescentSummary.frontRssBytes?.slopePerMinute)
        && receipt.quiescentResources.every((sample) => sample.queued === 0 && sample.active === 0 && sample.dispatching === 0 && sample.providerActive === 0),
      repeatedCutovers: receipt.cutovers.length >= 6 && receipt.cutovers.every((row) => row.state === 'passed'),
    };
    receipt.metrics = {
      deterministicRequests: receipt.deterministicCompleted, mixedRequests: receipt.clients.filter((row) => row.phase === 'mixed').length,
      mixedElapsedMs: receipt.mixedDurationMs, cutovers: receipt.cutovers.length,
      backlogSlope: receipt.quiescentSummary.queued?.slopePerMinute ?? null,
      rssSlopeBytesPerMinute: receipt.quiescentSummary.frontRssBytes?.slopePerMinute ?? null,
      unsafeReplay: counters?.unsafeReplay ?? null, stalePending: counters?.stalePending ?? null,
    };
    Object.assign(receipt, qualification(receipt));
    save();
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
  return receipt;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const receipt = await runSoak(configuration(process.argv.slice(2)));
    console.log(`${receipt.state.toUpperCase()} ${receipt.reason}`);
    process.exitCode = receipt.smokeState === 'passed' ? 0 : 1;
  } catch (error) { console.error(`FAILED ${error.message}`); process.exitCode = 1; }
}
