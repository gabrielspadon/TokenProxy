import { getRequestIdentity } from './requestIdentity.js';
import { getLogicalOutcomeStore } from '../../lib/db/repos/logicalRequestOutcomeRepo.js';
import { flushRequestStats } from '../../lib/db/repos/requestStatsRepo.js';

const lifecycles = new WeakMap();
const HEADER = 'x-tokenproxy-logical-request-id';

export async function withLogicalRequestLifecycle(request, run, { storeFactory = getLogicalOutcomeStore, flush = flushRequestStats } = {}) {
  if (lifecycles.has(request)) return run();
  const identity = getRequestIdentity(request);
  const lifecycle = { finalized: false };
  lifecycles.set(request, lifecycle);
  const started = { startedMs: performance.now(), firstObservedAt: new Date().toISOString() };
  let store, token, headersMs = null, status = null;
  try { store = await storeFactory(); token = store.begin(identity.logicalRequestId, started); }
  catch { console.error('[logicalOutcome] begin failed'); }
  const finalize = (transport) => {
    if (lifecycle.completion) return lifecycle.completion;
    request.signal?.removeEventListener('abort', aborted);
    lifecycle.completion = (async () => {
      try {
        await flush(identity.logicalRequestId);
        const spans = identity.finishSpans();
        if (token) store.finalize(token, { transport, status, headersMs, spans });
      } catch { console.error('[logicalOutcome] terminal write failed'); }
      lifecycle.finalized = true;
    })();
    return lifecycle.completion;
  };
  const aborted = () => { void finalize('cancelled'); };
  request.signal?.addEventListener('abort', aborted, { once: true });
  try {
    const response = await run();
    if (!(response instanceof Response)) {
      await finalize('error');
      return response;
    }
    status = response.status;
    headersMs = performance.now();
    const headers = new Headers(response.headers);
    headers.set(HEADER, identity.logicalRequestId);
    if (!response.body) {
      await finalize(request.signal?.aborted ? 'cancelled' : 'complete');
      return new Response(null, { status, statusText: response.statusText, headers });
    }
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            await finalize(request.signal?.aborted ? 'cancelled' : 'complete');
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          await finalize(request.signal?.aborted ? 'cancelled' : 'interrupted');
          controller.error(error);
        }
      },
      async cancel(reason) {
        const completion = finalize('cancelled');
        try { await reader.cancel(reason); }
        finally { reader.releaseLock(); await completion; }
      },
    });
    return new Response(body, { status, statusText: response.statusText, headers });
  } catch (error) {
    await finalize(request.signal?.aborted ? 'cancelled' : 'error');
    throw error;
  }
}
