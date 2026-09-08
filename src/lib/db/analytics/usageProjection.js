import { scopeRecentToPeriod } from '@/lib/usagePeriod.js';
import { analyticsRefreshPolicy } from './refreshPolicy.js';

/** Shared snapshots, never an accounting queue. Events invalidate projections;
 * the writer and request cancellation do not await any subscriber. */
export function createUsageProjectionHub({ emitter, readStats, readActive, now = Date.now,
  policy = analyticsRefreshPolicy, maxSubscribers = 64, maxGroups = 16, maxFrameBytes = 1024 * 1024 } = {}) {
  const groups = new Map();
  let subscribers = 0, timer = null, running = false, listening = false, version = 0, lastGroup = null;
  const encoder = new TextEncoder();
  const update = () => { version++; for (const g of groups.values()) g.dirty = true; schedule(true); };
  const pending = () => { for (const g of groups.values()) g.pending = true; schedule(true); };
  const listen = () => { if (listening) return; listening = true; emitter.on('update', update); emitter.on('pending', pending); };
  function stopIdle() {
    if (subscribers) return;
    clearTimeout(timer); timer = null;
    emitter.off('update', update); emitter.off('pending', pending); listening = false;
  }
  function schedule(reset = false) {
    if (reset && timer) { clearTimeout(timer); timer = null; }
    if (timer || running || !subscribers) return;
    const delay = Math.max(0, Math.min(...[...groups.values()].map(g => !g.cached ? 0 : Math.max(0, (g.dirty || g.pending ? g.nextAt : Math.max(g.nextAt, g.lastFullAt + 15000)) - now()))));
    timer = setTimeout(() => { timer = null; pump().catch(() => {}); }, delay); timer.unref?.();
  }
  function publish(g, stats, { stale = false, partial = false } = {}) {
    const refresh = policy();
    const frame = encoder.encode(`data: ${JSON.stringify({ ...stats, projection: {
      version: g.version, computedAt: g.computedAt, servedAt: new Date(now()).toISOString(),
      stale, partial, mode: refresh.mode, reason: refresh.reason, refreshAfterMs: refresh.refreshAfterMs,
      recentLimit: 100, delivery: 'latest-only', source: 'usage-snapshot',
    } })}\n\n`);
    if (frame.byteLength > maxFrameBytes) { for (const s of [...g.subscribers]) s.close(new Error('Usage projection exceeds delivery limit')); return; }
    for (const s of g.subscribers) s.offer(frame);
  }
  async function pump() {
    if (running || !subscribers) return;
    const due = [...groups.values()].filter(g => !g.cached || (now() >= g.nextAt && (g.dirty || g.pending || now() - g.lastFullAt >= 15000)));
    const g = due.find(g => g.key !== lastGroup) || due[0];
    if (!g) { schedule(); return; }
    running = true; lastGroup = g.key;
    const full = !g.cached || g.dirty || now() - g.lastFullAt >= 15000;
    const readVersion = version;
    let failed = false;
    g.dirty = false; g.pending = false;
    try {
      const data = full ? await readStats(g.period) : await readActive();
      if (!g.subscribers.size) return;
      if (full) {
        g.cached = { ...data, recentRequests: scopeRecentToPeriod(data.recentRequests || [], g.period).slice(0, 100) };
        g.computedAt = new Date(now()).toISOString(); g.lastFullAt = now(); g.version = readVersion;
      } else {
        g.cached = { ...g.cached, ...data, recentRequests: scopeRecentToPeriod(data.recentRequests || [], g.period).slice(0, 100) };
      }
      publish(g, g.cached, { stale: version !== g.version, partial: !full });
    } catch {
      failed = true;
      if (g.cached) { g.dirty = true; publish(g, g.cached, { stale: true }); }
      else for (const s of [...g.subscribers]) s.close(new Error('Usage projection unavailable'));
    } finally {
      running = false;
      g.nextAt = now() + Math.max(failed ? 5000 : 0, policy().streamIntervalMs);
      schedule();
    }
  }
  function open({ period = 'today', authorizedScope, signal } = {}) {
    if (!authorizedScope) throw new TypeError('Authorized projection scope required');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const key = JSON.stringify([authorizedScope, period]);
    if (subscribers >= maxSubscribers || (!groups.has(key) && groups.size >= maxGroups)) throw new Error('Usage subscribers are at capacity');
    let g = groups.get(key);
    if (!g) { g = { key, period, subscribers: new Set(), dirty: true, pending: false, cached: null, nextAt: 0, lastFullAt: 0 }; groups.set(key, g); }
    let closed = false, latest = null, waiting = null, controller;
    function close(error, cancelled = false) {
      if (closed) return; closed = true; latest = null;
      signal?.removeEventListener('abort', abort);
      g.subscribers.delete(subscriber); subscribers--;
      if (!g.subscribers.size) groups.delete(key);
      waiting?.(); waiting = null;
      if (!cancelled) { if (error) controller.error(error); else controller.close(); }
      stopIdle();
    }
    const abort = () => close();
    function flush() {
      if (!waiting || !latest || closed) return;
      controller.enqueue(latest); latest = null;
      const resolve = waiting; waiting = null; resolve();
    }
    const subscriber = { close, offer(frame) { if (closed) return; latest = frame; flush(); } };
    const stream = new ReadableStream({
      start(c) { controller = c; g.subscribers.add(subscriber); subscribers++; signal?.addEventListener('abort', abort, { once: true }); listen(); if (g.cached) publish(g, g.cached, { stale: g.dirty || version !== g.version }); schedule(true); },
      pull() { if (closed) return; return new Promise(resolve => { waiting = resolve; flush(); }); },
      cancel() { close(null, true); },
    }, { highWaterMark: 0 });
    return stream;
  }
  return { open, status: () => ({ groups: groups.size, subscribers, running, version, delivery: 'latest-only', maxFrameBytes }),
    close: () => { for (const g of groups.values()) for (const s of [...g.subscribers]) s.close(); stopIdle(); } };
}
