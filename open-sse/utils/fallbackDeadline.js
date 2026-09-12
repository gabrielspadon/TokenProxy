import { FALLBACK_BUDGET_MS } from '../config/connectTimeout.js';
import { waitForPreparation } from './preparationAbort.js';

const requestDeadlines = new WeakMap();

export class FallbackDeadlineError extends Error {
  constructor() {
    super('Request fallback deadline exhausted');
    this.name = 'FallbackDeadlineError';
    this.code = 'FALLBACK_DEADLINE_EXCEEDED';
  }
}

export function isFallbackDeadlineError(error) {
  return error?.code === 'FALLBACK_DEADLINE_EXCEEDED';
}

// One monotonic budget spans selection, preparation, nested combos and header
// acquisition. Scopes are temporary: clearing a header scope never schedules
// a later abort of a healthy response body.
export function createFallbackDeadline({ timeoutMs = FALLBACK_BUDGET_MS, now = () => performance.now() } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid fallback budget');
  const expiresAt = now() + timeoutMs;
  const remainingMs = () => Math.max(0, expiresAt - now());
  const throwIfExpired = (signal) => {
    signal?.throwIfAborted();
    if (remainingMs() <= 0) throw new FallbackDeadlineError();
  };
  const scope = (callerSignal) => {
    throwIfExpired(callerSignal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new FallbackDeadlineError()), Math.ceil(remainingMs()));
    return {
      signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
      clear: () => clearTimeout(timer),
    };
  };
  const run = async (operation, { signal, onLateResult } = {}) => {
    const bounded = scope(signal);
    let budgetReleased = false;
    const releaseBudget = () => { budgetReleased = true; bounded.clear(); };
    try {
      const value = await waitForPreparation(Promise.resolve().then(() => {
        bounded.signal.throwIfAborted();
        return operation(bounded.signal, releaseBudget);
      }), bounded.signal, onLateResult);
      try {
        signal?.throwIfAborted();
        if (!budgetReleased) throwIfExpired(signal);
      }
      catch (error) {
        try { await onLateResult?.(value); } catch {}
        throw error;
      }
      return value;
    } finally {
      bounded.clear();
    }
  };
  const wait = (delayMs, signal) => run(waitSignal => new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(waitSignal.reason);
    };
    const timer = setTimeout(() => {
      waitSignal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    waitSignal.addEventListener('abort', abort, { once: true });
  }), { signal });
  return Object.freeze({ remainingMs, throwIfExpired, scope, run, wait });
}

export function getRequestFallbackDeadline(request) {
  if (!request || typeof request !== 'object') return createFallbackDeadline();
  let deadline = requestDeadlines.get(request);
  if (!deadline) {
    deadline = createFallbackDeadline();
    requestDeadlines.set(request, deadline);
  }
  return deadline;
}
