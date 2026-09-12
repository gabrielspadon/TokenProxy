import {
  isValidConnectTimeoutMs,
  resolveConnectTimeoutMs,
} from "../config/connectTimeout.js";
import { FallbackDeadlineError } from "./fallbackDeadline.js";

export class ConnectTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Upstream response headers exceeded ${timeoutMs}ms`);
    this.name = "ConnectTimeoutError";
    this.code = "UPSTREAM_CONNECT_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export function isConnectTimeoutError(error) {
  return error?.name === "ConnectTimeoutError"
    && error?.code === "UPSTREAM_CONNECT_TIMEOUT";
}

export function createResponseHeaderTimeout({ timeoutMs, signal: callerSignal, fallbackDeadline } = {}) {
  if (!isValidConnectTimeoutMs(timeoutMs)) {
    throw new TypeError("timeoutMs must be a finite integer from 1000 through 120000");
  }
  fallbackDeadline?.throwIfExpired(callerSignal);
  const remainingMs = fallbackDeadline?.remainingMs() ?? Infinity;
  const effectiveTimeoutMs = Math.min(timeoutMs, Math.ceil(remainingMs));

  const timeoutController = new AbortController();
  let source = callerSignal?.aborted ? "caller" : null;
  let cleared = false;
  let timeoutError = null;

  const observeCallerAbort = () => {
    if (source !== null) return;
    source = "caller";
  };

  if (!callerSignal?.aborted) {
    callerSignal?.addEventListener("abort", observeCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (source !== null) return;
    source = "timeout";
    timeoutError = remainingMs <= timeoutMs ? new FallbackDeadlineError() : new ConnectTimeoutError(timeoutMs);
    timeoutController.abort(timeoutError);
  }, effectiveTimeoutMs);

  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;

  const clear = () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", observeCallerAbort);
  };

  return {
    signal,
    timeoutMs: effectiveTimeoutMs,
    clear,
    classify(error) {
      if (source === "timeout") return timeoutError;
      if (source === "caller") return callerSignal.reason;
      return error;
    },
  };
}

export function createExecutorResponseHeaderTimeout({
  connectTimeout,
  registryTimeout,
  envTimeout,
  signal,
} = {}) {
  const timeoutMs = resolveConnectTimeoutMs({
    providerOverride: connectTimeout?.providerOverride,
    registryTimeout,
    globalTimeout: connectTimeout?.globalTimeout,
    envTimeout,
  });
  return createResponseHeaderTimeout({ timeoutMs, signal, fallbackDeadline: connectTimeout?.fallbackDeadline });
}
