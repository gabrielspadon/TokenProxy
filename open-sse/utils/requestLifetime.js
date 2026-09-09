import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const contextKey = Symbol.for('tokenproxy.requestLifetime');
const context = globalThis[contextKey] ??= new AsyncLocalStorage();
export const requestSignal = () => context.getStore()?.signal;
export const hasRequestAdmission = () => context.getStore()?.admitted === true;
export function withRequestLifetime(signal, run, { admitted = false } = {}) { return context.run({ signal, admitted }, run); }
export function throwIfRequestAborted() { requestSignal()?.throwIfAborted(); }
export function requestDelay(ms) { return delay(ms, undefined, { signal: requestSignal() }); }
// Lexically imported by media adapters. This does not replace global fetch or
// attach caller cancellation to unrelated shared credential refresh work.
export function requestFetch(input, init = {}) {
  const caller = requestSignal();
  const supplied = init.signal ?? (input instanceof Request ? input.signal : null);
  const signal = caller && supplied ? AbortSignal.any([caller, supplied]) : caller || supplied;
  signal?.throwIfAborted();
  return globalThis.fetch(input, { ...init, ...(signal ? { signal } : {}) });
}
