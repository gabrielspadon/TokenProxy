import { resolveClientApiKey } from '@/lib/auth/clientApiKey.js';
import { withRequestLifetime, requestSignal, hasRequestAdmission } from '../../../open-sse/utils/requestLifetime.js';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

export const ADMISSION_DEFAULTS = Object.freeze({
  adaptive: true, minStreams: 8, maxStreams: 128, maxHandlers: 64,
  clientStreams: 32, clientHandlers: 32, providerStreams: 64,
  queueDepth: 512, clientQueueDepth: 128, maxWaitMs: 30000,
  memoryBudgetMb: 2048, eventLoopBudgetMs: 100,
  minSamples: 5, cooldownMs: 10000, overrideStreams: null,
});
export function validateAdmissionPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Admission policy must be an object');
  const policy = { ...ADMISSION_DEFAULTS, ...input };
  for (const [key, value] of Object.entries(policy)) {
    if (!Object.hasOwn(ADMISSION_DEFAULTS, key)) throw new TypeError(`Unknown admission setting ${key}`);
    if (key === 'adaptive') { if (typeof value !== 'boolean') throw new TypeError('adaptive must be boolean'); }
    else if (key === 'overrideStreams' && value === null) continue;
    else if (!Number.isSafeInteger(value) || value < 1 || value > (key.endsWith('Ms') ? 300000 : 65536)) throw new TypeError(`Invalid ${key}`);
  }
  if (policy.minStreams > policy.maxStreams) throw new TypeError('Minimum streams exceeds maximum');
  if (policy.overrideStreams !== null && (policy.overrideStreams < policy.minStreams || policy.overrideStreams > policy.maxStreams)) throw new TypeError('Override must be inside operator bounds');
  return policy;
}

/** One process owns all reservations. Streaming duration is never a congestion sample. */
export function createResourceAdmission({ now = Date.now, policy: initial = {}, timers = globalThis } = {}) {
  let policy = validateAdmissionPolicy(initial), effective = policy.minStreams;
  let handlers = 0, streams = 0, samples = 0, smoothed = null, healthy = 0, lastChange = -Infinity;
  let decision = 'awaiting-pressure-samples', lastSample = null, lastClient = null;
  const clients = new Map(), queue = [], providers = new Map(), quotaEvidence = new Map();
  const counters = { admitted: 0, refused: 0, aborted: 0, timedOut: 0, released: 0 };
  const currentLimit = () => policy.overrideStreams ?? (policy.adaptive ? effective : policy.maxStreams);
  const stateFor = key => {
    if (!clients.has(key)) clients.set(key, { handlers: 0, streams: 0, queued: 0 });
    return clients.get(key);
  };
  const clean = key => { const s = clients.get(key); if (s && !s.handlers && !s.streams && !s.queued) clients.delete(key); };
  const fits = w => {
    const s = stateFor(w.client);
    return handlers < policy.maxHandlers && streams < currentLimit()
      && s.handlers < policy.clientHandlers && s.streams < Math.min(policy.clientStreams, Math.max(1, Math.floor(currentLimit() / 2)));
  };
  function grant(w) {
    const s = stateFor(w.client); handlers++; streams++; s.handlers++; s.streams++; counters.admitted++;
    lastClient = w.client;
    let handlerHeld = true, streamHeld = true;
    const releaseHandler = () => { if (!handlerHeld) return false; handlerHeld = false; handlers--; s.handlers--; clean(w.client); drain(); return true; };
    const release = () => { if (!streamHeld) return false; streamHeld = false; streams--; s.streams--; counters.released++; releaseHandler(); clean(w.client); drain(); return true; };
    return { admitted: true, waitedMs: Math.max(0, now() - w.enqueuedAt), releaseHandler, release };
  }
  function drain() {
    while (queue.length) {
      // Oldest eligible request from a different client first; a saturated
      // client never blocks another, and each client retains FIFO order.
      let index = queue.findIndex(w => w.client !== lastClient && fits(w));
      if (index < 0) index = queue.findIndex(fits);
      if (index < 0) break;
      const w = queue[index];
      if (w.signal?.aborted || now() >= w.deadline) { w.settle(null, w.signal?.aborted ? 'aborted' : 'wait-timeout'); continue; }
      w.settle(grant(w));
    }
  }
  function acquire({ client = 'anonymous', signal, deadline = Infinity } = {}) {
    const at = now();
    if (signal?.aborted || deadline <= at) return Promise.resolve({ admitted: false, why: signal?.aborted ? 'aborted' : 'wait-timeout' });
    const w = { client, signal, enqueuedAt: at, deadline: Math.min(deadline, at + policy.maxWaitMs) };
    if (!queue.length && fits(w)) return Promise.resolve(grant(w));
    const s = stateFor(client);
    if (queue.length >= policy.queueDepth || s.queued >= policy.clientQueueDepth) { counters.refused++; clean(client); return Promise.resolve({ admitted: false, why: 'queue-full' }); }
    return new Promise(resolve => {
      let settled = false;
      const onAbort = () => { w.settle(null, 'aborted'); drain(); };
      w.settle = (permit, why) => {
        if (settled) return; settled = true;
        timers.clearTimeout(w.timer); signal?.removeEventListener('abort', onAbort);
        queue.splice(queue.indexOf(w), 1); s.queued--; clean(client);
        if (!permit) { counters.refused++; counters[why === 'aborted' ? 'aborted' : 'timedOut']++; }
        resolve(permit ?? { admitted: false, why, waitedMs: now() - at });
      };
      s.queued++; queue.push(w);
      w.timer = timers.setTimeout(() => { w.settle(null, 'wait-timeout'); drain(); }, w.deadline - at); w.timer?.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort(); else drain();
    });
  }
  function observe(sample) {
    lastSample = { ...sample, at: now() };
    const measurements = [Number.isFinite(sample.eventLoopMs) ? sample.eventLoopMs / policy.eventLoopBudgetMs : NaN, Number.isFinite(sample.memoryMb) ? sample.memoryMb / policy.memoryBudgetMb : NaN];
    if (Number.isFinite(sample.heapPressure)) measurements.push(sample.heapPressure);
    if (Number.isFinite(sample.connectionPressure)) measurements.push(sample.connectionPressure);
    const valid = measurements.filter(Number.isFinite);
    if (valid.length < 2) { samples = 0; healthy = 0; decision = 'pressure-evidence-unavailable'; return snapshot(); }
    const pressure = Math.max(...valid);
    smoothed = smoothed === null ? pressure : 0.25 * pressure + 0.75 * smoothed;
    samples++;
    if (!policy.adaptive || policy.overrideStreams !== null) decision = policy.overrideStreams !== null ? 'operator-override' : 'operator-fixed';
    else if (samples < policy.minSamples) decision = 'minimum-samples';
    else if (now() - lastChange < policy.cooldownMs) decision = 'cooldown';
    else if (smoothed > 1) {
      effective = Math.max(policy.minStreams, Math.floor(effective * 0.8)); lastChange = now(); healthy = 0; decision = 'measured-process-pressure';
    } else if (smoothed < 0.65) {
      healthy++;
      if (healthy >= 3 && ((queue.length > 0 && now() - queue[0].enqueuedAt >= Math.min(1000, policy.maxWaitMs / 4)) || streams >= effective * 0.75)) {
        effective = Math.min(policy.maxStreams, effective + 1); lastChange = now(); healthy = 0; decision = 'healthy-demand-gradual-recovery'; drain();
      } else decision = 'healthy-awaiting-demand';
    } else { healthy = 0; decision = 'hysteresis-hold'; }
    return snapshot();
  }
  function configure(input) { const next = validateAdmissionPolicy(input); if (JSON.stringify(next) === JSON.stringify(policy)) return snapshot(); policy = next; samples = 0; smoothed = null; healthy = 0; effective = Math.max(policy.minStreams, Math.min(policy.maxStreams, effective)); decision = policy.overrideStreams !== null ? 'operator-override' : 'policy-updated'; drain(); return snapshot(); }
  function reserveProvider(provider, configuredLimit) {
    for (const [id, value] of providers) if (!value.active && now() - value.lastSeen > 300000) providers.delete(id);
    const key = provider || 'unknown';
    let s = providers.get(key);
    if (!s) { s = { active: 0, throttledUntil: 0, effective: null, limit: policy.providerStreams, reason: 'operator-provider-limit', lastSeen: now() }; providers.set(key, s); }
    s.lastSeen = now();
    s.limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? Math.min(configuredLimit, policy.providerStreams) : policy.providerStreams;
    if (s.effective === null) s.effective = s.limit;
    s.effective = Math.min(s.effective, s.limit);
    if (now() >= s.throttledUntil && s.effective < s.limit) { s.effective++; s.throttledUntil = now() + policy.cooldownMs; s.reason = 'provider-gradual-recovery'; }
    const cap = s.effective;
    if (s.active >= cap) return null;
    s.active++; let held = true;
    return { release: () => { if (!held) return false; held = false; s.active--; return true; } };
  }
  function providerThrottle(provider) {
    // Provider identities come only from resolved configured accounts. Expire
    // idle evidence so removed custom providers do not accumulate forever.
    for (const [key, value] of providers) if (!value.active && now() - value.lastSeen > 300000) providers.delete(key);
    const s = providers.get(provider);
    if (s && (s.reason !== 'observed-provider-throttle' || now() >= s.throttledUntil)) { s.effective = Math.max(1, Math.floor((s.effective ?? s.limit) / 2)); s.throttledUntil = now() + policy.cooldownMs; s.reason = 'observed-provider-throttle'; s.lastSeen = now(); }
  }
  function recordQuota(connectionId, snapshot, paused) {
    const observedAt = Date.parse(snapshot?.fetchedAt);
    if (!Number.isFinite(observedAt) || observedAt > now() || now() - observedAt > 120000) return;
    for (const [key, value] of quotaEvidence) if (now() - value.observedAt > 120000) quotaEvidence.delete(key);
    quotaEvidence.set(connectionId, { observedAt, paused: paused === true });
  }
  function snapshot() {
    return { scope: 'process', policy, effectiveStreams: currentLimit(), activeHandlers: handlers, activeStreams: streams,
      queued: queue.length, oldestQueueMs: queue.length ? Math.max(0, now() - queue[0].enqueuedAt) : 0,
      activeClients: clients.size, samples, smoothedPressure: smoothed, decision, lastSample,
      counters: { ...counters }, providers: Object.fromEntries([...providers].map(([k, s]) => [k, { active: s.active, effectiveLimit: s.effective ?? s.limit, reason: s.effective < s.limit ? s.reason : 'operator-provider-limit' }])),
      unavailable: ['connection-pool-pressure', 'cross-process-capacity'],
      quotaEvidence: { freshAccounts: [...quotaEvidence.values()].filter(v => now() - v.observedAt <= 120000).length, pausedAccounts: [...quotaEvidence.values()].filter(v => now() - v.observedAt <= 120000 && v.paused).length },
      quotaPolicy: 'Existing account quota eligibility remains authoritative; unknown or stale quota never increases capacity.' };
  }
  return { acquire, observe, configure, snapshot, reserveProvider, providerThrottle, recordQuota };
}

const singletonKey = Symbol.for('tokenproxy.resourceAdmission');
export const resourceAdmission = globalThis[singletonKey] ??= createResourceAdmission();
const samplerKey = Symbol.for('tokenproxy.admissionSampler');
let loadedPolicyAt = -Infinity;
export async function refreshAdmissionPolicy() {
  if (Date.now() - loadedPolicyAt < 1000) return;
  const { getSettings } = await import('@/lib/localDb');
  const settings = await getSettings();
  resourceAdmission.configure(settings?.resourceAdmission || {});
  loadedPolicyAt = Date.now();
}
export function startAdmissionSampling() {
  if (globalThis[samplerKey]) return;
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  const sampler = globalThis[samplerKey] = setInterval(() => {
    const memory = process.memoryUsage();
    resourceAdmission.observe({ eventLoopMs: delay.count ? delay.percentile(95) / 1e6 : null,
      memoryMb: memory.rss / 1048576, heapPressure: memory.heapUsed / getHeapStatistics().heap_size_limit });
    delay.reset();
  }, 1000); sampler.unref();
}

/** A pull-through body preserves backpressure and transfers permit ownership. */
export function releaseOnResponse(response, release, signal) {
  if (!response?.body) { release(); return response; }
  let reader;
  try { reader = response.body.getReader(); } catch (error) { release(); throw error; }
  let finished = false, controllerRef;
  const finish = () => { if (finished) return false; finished = true; signal?.removeEventListener('abort', abort); release(); return true; };
  const abort = () => { if (!finish()) return; const reason = signal.reason ?? new DOMException('Aborted', 'AbortError'); reader.cancel(reason).catch(() => {}); controllerRef.error(reason); };
  const body = new ReadableStream({
    start(controller) { controllerRef = controller; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); },
    async pull(controller) { try { const value = await reader.read(); if (finished) return; if (value.done) { finish(); controller.close(); } else controller.enqueue(value.value); } catch (error) { if (finish()) controller.error(error); } },
    cancel(reason) { finish(); return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function withResourceAdmission(request, run, { signal = request?.signal, deadline, fallbackDeadline } = {}) {
  if (hasRequestAdmission()) { requestSignal()?.throwIfAborted(); return run(); }
  if (Number.isFinite(deadline)) {
    const timeout = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - Date.now())));
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  if (signal?.aborted || Number.isFinite(deadline) && deadline <= Date.now()) return new Response(null, { status: 499 });
  const prepare = (operation, onLateResult) => fallbackDeadline
    ? fallbackDeadline.run(operation, { signal, onLateResult })
    : operation(signal);
  await prepare(() => refreshAdmissionPolicy());
  startAdmissionSampling();
  const principal = await prepare(async () => {
    const { isValidApiKey } = await import('./auth.js');
    return resolveClientApiKey(request, isValidApiKey, { admission: true });
  });
  if (principal.refusal) return principal.refusal;
  const client = principal.valid && principal.apiKey ? createHash('sha256').update(principal.apiKey).digest('hex') : 'anonymous';
  const slot = await prepare(boundedSignal => resourceAdmission.acquire({ client, signal: boundedSignal, deadline }),
    value => { if (value?.admitted) value.release(); });
  if (!slot.admitted) return Response.json({ error: { message: slot.why === 'aborted' ? 'Request aborted' : 'TokenProxy admission queue unavailable', type: 'admission_error', code: slot.why } }, { status: slot.why === 'aborted' ? 499 : 503, headers: { 'retry-after': '1', 'x-tokenproxy-replay-safe': 'true' } });
  try {
    if (signal?.aborted) { slot.release(); return new Response(null, { status: 499 }); }
    const response = await withRequestLifetime(signal, run, { admitted: true }); slot.releaseHandler();
    if (signal?.aborted) { response?.body?.cancel?.().catch(() => {}); slot.release(); return new Response(null, { status: 499 }); }
    return releaseOnResponse(response, slot.release, signal);
  } catch (error) { slot.release(); if (signal?.aborted) return new Response(null, { status: 499 }); throw error; }
}

/** Public media paths have no account lease; reserve the same provider pool. */
export async function withPublicProviderAdmission(provider, run) {
  const permit = resourceAdmission.reserveProvider(provider);
  if (!permit) return { success: false, status: 503, error: 'TokenProxy provider capacity is occupied',
    failureMetadata: { safeToReplay: true, failurePhase: 'admission' },
    response: Response.json({ error: { message: 'TokenProxy provider capacity is occupied', type: 'admission_error' } }, { status: 503, headers: { 'retry-after': '1' } }) };
  let transferred = false;
  try {
    const result = await run();
    if (!result?.response) return result;
    const response = releaseOnResponse(result.response, permit.release, requestSignal());
    transferred = true;
    return { ...result, response };
  } finally { if (!transferred) permit.release(); }
}
