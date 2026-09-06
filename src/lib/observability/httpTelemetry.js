import { monitorEventLoopDelay } from 'node:perf_hooks';

const METHODS = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
export function technicalRoute(raw) {
  const path = String(raw || '').split('?',1)[0];
  if (/^\/(?:api\/)?v1\/(?:chat\/completions|responses|messages)$/.test(path) || path === '/responses' || path.startsWith('/codex/')) return 'generation';
  if (/^\/(?:api\/)?v1(?:beta)?\//.test(path)) return 'model-api';
  if (path.startsWith('/api/')) return 'operator-api';
  if (path.startsWith('/dashboard')) return 'workspace';
  if (path.startsWith('/_next/') || path.startsWith('/images/')) return 'assets';
  return 'other';
}

// SDK instruments own aggregation and export. This adapter only knows the
// actual HTTP lifetime and never reads headers, bodies, IDs or exception text.
export function createHttpTelemetry({ tracer, meter, rootContext, clock = () => performance.now(), eventLoop = monitorEventLoopDelay({ resolution: 20 }) }) {
  const duration = meter.createHistogram('tokenproxy.http.duration', { unit: 's' });
  const firstByte = meter.createHistogram('tokenproxy.http.first_body_write', { unit: 's' });
  const completed = meter.createCounter('tokenproxy.http.completed');
  const active = meter.createUpDownCounter('tokenproxy.http.active');
  const lag = meter.createObservableGauge('tokenproxy.event_loop.delay', { unit: 's' });
  const memory = meter.createObservableGauge('tokenproxy.process.memory', { unit: 'By' });
  eventLoop.enable();
  lag.addCallback(result => {
    if (eventLoop.count > 0) {
      result.observe(eventLoop.percentile(50)/1e9, { quantile: 'p50' });
      result.observe(eventLoop.percentile(99)/1e9, { quantile: 'p99' });
      result.observe(eventLoop.max/1e9, { quantile: 'max' });
    }
    eventLoop.reset();
  });
  memory.addCallback(result => {
    const usage = process.memoryUsage();
    result.observe(usage.rss, { kind: 'rss' });
    result.observe(usage.heapUsed, { kind: 'heap' });
    result.observe(usage.external, { kind: 'external' });
  });
  let stopped = false;
  function observe(req, res) {
    if (stopped) return;
    const attributes = { 'http.request.method': METHODS.has(req.method) ? req.method : 'OTHER', 'tokenproxy.route_class': technicalRoute(req.url) };
    let span;
    try { span = tracer.startSpan('tokenproxy.http', { kind: 1, attributes },rootContext); }
    catch { return; }
    const started = clock();
    let finished = false, bodyStarted = false;
    let activeRecorded = false;
    try { active.add(1,attributes); activeRecorded = true; } catch { /* Metrics may be unavailable. */ }
    const write = res.write, end = res.end;
    const markBody = chunk => {
      if (bodyStarted || chunk == null || typeof chunk === 'function' || chunk.length === 0) return;
      bodyStarted = true;
      try { firstByte.record(Math.max(0,clock()-started)/1000,attributes); } catch { /* Technical telemetry is optional. */ }
    };
    // Return values and callbacks stay Node-owned, including backpressure.
    function observedWrite(...args) { markBody(args[0]); return write.apply(this,args); }
    function observedEnd(...args) { markBody(args[0]); return end.apply(this,args); }
    res.write = observedWrite; res.end = observedEnd;
    function finalize(outcome) {
      if (finished) return;
      finished = true;
      res.off('finish',onFinish); res.off('close',onClose); res.off('error',onError);
      if (res.write === observedWrite) res.write = write;
      if (res.end === observedEnd) res.end = end;
      const statusClass = Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599 ? `${Math.floor(res.statusCode/100)}xx` : 'unknown';
      const finalAttributes = { ...attributes, 'http.response.status_class': statusClass, 'tokenproxy.outcome': outcome };
      if (activeRecorded) { try { active.add(-1,attributes); } catch {} }
      try { duration.record(Math.max(0,clock()-started)/1000,finalAttributes); } catch {}
      try { completed.add(1,finalAttributes); } catch {}
      try {
        span.setAttributes(finalAttributes);
        if (outcome === 'error' || statusClass === '5xx') span.setStatus({ code: 2 });
      } catch { /* Never change response completion because export failed. */ }
      finally { try { span.end(); } catch {} }
    }
    function onFinish() { finalize('complete'); }
    function onClose() { finalize(res.writableFinished ? 'complete' : 'aborted'); }
    function onError() { finalize('error'); }
    res.once('finish',onFinish); res.once('close',onClose); res.once('error',onError);
  }
  return { observe, stop() { stopped = true; eventLoop.disable(); } };
}
