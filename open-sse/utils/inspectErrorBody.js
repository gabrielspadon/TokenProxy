const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 1000;

// An incomplete error body cannot prove nonacceptance. Inspect a bounded clone
// and leave the original response available to the caller. Never await tee
// cancellation, which can wait for the original branch to be consumed.
export async function inspectErrorBody(response, { signal, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  signal?.throwIfAborted();
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) return { complete: false, text: null, reason: 'byte-limit' };
  if (!response.body) return { complete: true, text: '' };
  const reader = response.clone().body.getReader();
  let timer, onAbort, finished = false, total = 0;
  const chunks = [];
  const interrupted = new Promise(resolve => {
    timer = setTimeout(() => resolve({ interrupted: 'deadline' }), timeoutMs);
    timer.unref?.();
    onAbort = () => resolve({ interrupted: 'cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.interrupted === 'cancelled') { signal.throwIfAborted(); }
      if (part.interrupted) return { complete: false, text: null, reason: part.interrupted };
      if (part.done) { finished = true; break; }
      total += part.value.byteLength;
      if (total > maxBytes) return { complete: false, text: null, reason: 'byte-limit' };
      chunks.push(part.value);
    }
    return { complete: true, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { complete: false, text: null, reason: 'unreadable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (!finished) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    }
    try { reader.releaseLock(); } catch {}
  }
}
