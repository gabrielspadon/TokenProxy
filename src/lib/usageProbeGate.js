// The dashboard renders one card per connection and fetches every one of them
// at once (Promise.all over visibleConnections in the ProviderLimits page), and
// each fetch is a LIVE call to the provider, often preceded by an OAuth token
// refresh. With thirty accounts that is thirty simultaneous TLS handshakes plus
// thirty token refreshes, and TLS runs on the libuv threadpool, so the cost is
// spread across cores rather than confined to the event loop. Two browser tabs,
// or a refresh while the first round is still in flight, multiply it again.
//
// Nothing upstream of here bounds that fan-out: the route had no cache, no
// in-flight tracking and no concurrency limit, so the amount of work a single
// page load could start was set by how many accounts the user had configured.
// This gate puts a ceiling on it (#3061).

const MAX_CONCURRENT_PROBES = 4;
// One page load queues at most one probe per configured connection, so the
// queue only ever needs to hold "every card minus the four running". 64 covers
// double that with two tabs open; past it the caller is retrying anyway.
const MAX_WAITING_PROBES = 64;

const inFlight = new Map();
let active = 0;
const waiting = [];

class ProbeQueueFullError extends Error {
  constructor() {
    super('usage probe queue is full');
    this.name = 'ProbeQueueFullError';
    this.code = 'PROBE_QUEUE_FULL';
  }
}

function releaseSlot() {
  active -= 1;
  const next = waiting.shift();
  if (next) {
    active += 1;
    next.resolve();
  }
}

function acquireSlot(signal) {
  if (active < MAX_CONCURRENT_PROBES) {
    active += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING_PROBES) {
    return Promise.reject(new ProbeQueueFullError());
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve };
    if (signal) {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      // Only a QUEUED entry leaves on abort. A probe already running stays:
      // its result may be shared by other subscribers via inFlight.
      const onAbort = () => {
        const i = waiting.indexOf(entry);
        if (i !== -1) {
          waiting.splice(i, 1);
          reject(signal.reason ?? new Error('aborted'));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.resolve = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
    }
    waiting.push(entry);
  });
}

/**
 * Run `probe` under the shared ceiling, collapsing concurrent callers that want
 * the same thing onto one upstream call.
 *
 * The key carries whatever distinguishes the request, `force` included: a user
 * pressing refresh must not be handed the result of a probe that was already
 * running without it.
 *
 * `signal` (optional) only cancels a probe still WAITING for a slot. It is
 * deliberately not passed into `probe`: a running probe may have several
 * subscribers collapsed onto it, and no downstream transport consumes a
 * per-subscriber signal.
 *
 * @param {string} key
 * @param {() => Promise<any>} probe
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
export function runUsageProbe(key, probe, signal) {
  const existing = inFlight.get(key);
  if (existing) return existing;

  // ponytail: joiners that coalesce onto a probe still queued share the
  // creator's abort rejection; per-subscriber refcounting when it matters.
  const run = acquireSlot(signal).then(
    () =>
      Promise.resolve()
        .then(probe)
        .finally(() => {
          inFlight.delete(key);
          releaseSlot();
        }),
    (err) => {
      inFlight.delete(key);
      throw err;
    }
  );

  inFlight.set(key, run);
  return run;
}

// Test seam. The counters are module state on purpose — the ceiling is
// per-process, not per-request — so a suite that exercises them needs a reset.
export function __resetUsageProbeGate() {
  inFlight.clear();
  active = 0;
  waiting.length = 0;
}

export { MAX_CONCURRENT_PROBES, MAX_WAITING_PROBES };
