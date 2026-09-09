/** Serialized, lossy diagnostics. Capacity includes the operation currently in flight. */
export function createBoundedLogSink({ write, maxRecords = 256, maxBytes = 1024 * 1024, schedule = setImmediate }) {
  const queue = [];
  const stats = { accepted: 0, written: 0, dropped: 0, failed: 0, bytes: 0, records: 0, peakBytes: 0, peakRecords: 0 };
  let running = false;
  let closed = false;
  let flushPromise = null;
  let finishFlush = null;
  let closePromise = null;
  const settle = () => { if (!stats.records) finishFlush?.(); };
  async function drain() {
    while (queue.length) {
      const item = queue.shift();
      try { if (await write(item.value) === false) stats.dropped++; else stats.written++; } catch { stats.failed++; }
      stats.bytes -= item.bytes;
      stats.records--;
    }
    running = false;
    settle();
  }
  function enqueue(value, bytes, { evictPending = false, protected: protect = false } = {}) {
    if (evictPending && !closed && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maxBytes) {
      while (queue.length && (stats.records >= maxRecords || bytes > maxBytes - stats.bytes)) {
        const index = queue.findLastIndex(item => !item.protect);
        if (index < 0) break;
        const [discarded] = queue.splice(index, 1); stats.records--; stats.bytes -= discarded.bytes; stats.dropped++;
      }
    }
    if (closed || !Number.isSafeInteger(bytes) || bytes < 0 || stats.records >= maxRecords || bytes > maxBytes - stats.bytes) { stats.dropped++; return false; }
    queue.push({ value, bytes, protect });
    stats.records++; stats.bytes += bytes; stats.accepted++;
    stats.peakBytes = Math.max(stats.peakBytes, stats.bytes);
    stats.peakRecords = Math.max(stats.peakRecords, stats.records);
    if (!running) { running = true; schedule(drain); }
    return true;
  }
  function discard() {
    for (const item of queue.splice(0)) { stats.bytes -= item.bytes; stats.records--; stats.dropped++; }
    settle();
  }
  function flush(timeoutMs = 1000) {
    if (!stats.records) return Promise.resolve({ drained: true, ...stats });
    if (flushPromise) return flushPromise;
    flushPromise = new Promise(resolve => {
      let timer;
      finishFlush = () => {
        clearTimeout(timer); finishFlush = null; flushPromise = null;
        resolve({ drained: !stats.records, ...stats });
      };
      timer = setTimeout(finishFlush, Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, timeoutMs)) : 1000);
    });
    return flushPromise;
  }
  function close({ timeoutMs = 1000, discardPending = false } = {}) {
    if (closePromise) return closePromise;
    closed = true;
    if (discardPending) discard();
    closePromise = flush(timeoutMs).then(result => {
      if (!result.drained) discard();
      return { ...stats, drained: !stats.records };
    });
    return closePromise;
  }

  return { enqueue, flush, close, discard, status: () => ({ ...stats, closed }) };
}
