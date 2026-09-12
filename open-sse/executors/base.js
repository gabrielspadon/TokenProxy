import { notifyDispatchResponse } from "../utils/dispatchHooks.js";
import { setTimeout as retryDelay } from "node:timers/promises";
import { isReplaySafeRejection } from "../utils/replaySafety.js";
import { inspectErrorBody } from "../utils/inspectErrorBody.js";
import {
  HTTP_STATUS,
  RETRY_CONFIG,
  DEFAULT_RETRY_CONFIG,
  resolveRetryEntry,
  FETCH_CONNECT_TIMEOUT_MS,
} from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  createExecutorResponseHeaderTimeout,
  isConnectTimeoutError,
} from "../utils/responseHeaderTimeout.js";
import { dbg } from "../utils/debugLog.js";
import {
  ANTHROPIC_API_VERSION,
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
} from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { extractRetryAfterDeadline } from "../utils/error.js";

// Format byte count to human-readable string for debug logs
function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * BaseExecutor - Base class for provider executors
 */
function parseDurationToMs(durationStr) {
  if (!durationStr || typeof durationStr !== "string") return null;

  // Format 1: "547098.015490101s" (seconds only, with decimals)
  const secondsMatch = durationStr.match(/^([\d.]+)\s*s$/i);
  if (secondsMatch) {
    const secs = parseFloat(secondsMatch[1]);
    return isNaN(secs) ? null : Math.round(secs * 1000);
  }

  // Format 2: "151h58m18.015490101s" (hours, minutes, seconds with decimals)
  const match = durationStr.match(
    /(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i,
  );
  if (!match) return null;

  let totalMs = 0;
  if (match[1]) totalMs += parseInt(match[1], 10) * 3600 * 1000;
  if (match[2]) totalMs += parseInt(match[2], 10) * 60 * 1000;
  if (match[3]) totalMs += Math.round(parseFloat(match[3]) * 1000);

  return totalMs > 0 ? totalMs : null;
}

export class BaseExecutor {
  get supportsBudgetDispatch() { return this.execute === BaseExecutor.prototype.execute; }
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return (
      this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : [])
    );
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl =
        credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path =
        resolveOpenAICompatibleApiType(this.provider, credentials) ===
        "responses"
          ? "/responses"
          : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl =
        credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials, sourceFormat) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return (
      status === HTTP_STATUS.RATE_LIMITED &&
      urlIndex + 1 < this.getFallbackCount()
    );
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    let message = bodyText || `HTTP ${response.status}`;
    let resetsAtMs = null;

    if (bodyText) {
      try {
        const json = JSON.parse(bodyText);
        message = json.error?.message || json.message || json.error || message;

        // Parse Google RPC error details
        const details = json?.error?.details;
        if (Array.isArray(details)) {
          for (const d of details) {
            // ErrorInfo: quotaResetTimeStamp (ISO) or quotaResetDelay
            if (d?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo") {
              if (d.reason) {
                // json.error may be an object (no .message), leaving `message` non-string
                if (!String(message).includes(d.reason)) {
                  message = `${message} [${d.reason}]`;
                }
              }
              const metadata = d.metadata;
              if (metadata) {
                if (metadata.quotaResetTimeStamp) {
                  const t = new Date(metadata.quotaResetTimeStamp).getTime();
                  if (!isNaN(t) && t > Date.now()) {
                    resetsAtMs = t;
                  }
                }
                if (!resetsAtMs && metadata.quotaResetDelay) {
                  const delayMs = parseDurationToMs(metadata.quotaResetDelay);
                  if (delayMs) {
                    resetsAtMs = Date.now() + delayMs;
                  }
                }
              }
            }
            // RetryInfo: retryDelay
            if (
              !resetsAtMs &&
              d?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo" &&
              d?.retryDelay
            ) {
              const delayMs = parseDurationToMs(d.retryDelay);
              if (delayMs) {
                resetsAtMs = Date.now() + delayMs;
              }
            }
          }
        }
      } catch {
        // ignore parse error
      }
    }

    // Try to parse from message string using regex (e.g. "Resets in 151h58m18s" or "reset after 2h7m23s")
    if (
      !resetsAtMs &&
      message &&
      typeof message === "string" &&
      response.status === 429
    ) {
      const match = message.match(
        /reset(?:s)?\s+(?:after|in)\s+(\d+h)?\s*(\d+m)?\s*(\d+s)?/i,
      );
      if (match) {
        let totalMs = 0;
        if (match[1]) totalMs += parseInt(match[1], 10) * 3600 * 1000;
        if (match[2]) totalMs += parseInt(match[2], 10) * 60 * 1000;
        if (match[3]) totalMs += parseInt(match[3], 10) * 1000;
        if (totalMs > 0) {
          resetsAtMs = Date.now() + totalMs;
        }
      }
    }

    return {
      status: response.status,
      message,
      ...(resetsAtMs && { resetsAtMs }),
    };
  }

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    proxyOptions = null, sourceFormat, targetFormat,
    connectTimeout = null,
    beforeDispatch,
    afterDispatch,
  }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};
    const replayProofs = new WeakMap();
    const canReplay = async response => {
      if (response?.status !== 429) return isReplaySafeRejection(response);
      if (response.headers?.get?.('x-tokenproxy-replay-safe') === 'false'
          || response.headers?.get?.('x-should-retry') === 'false') return false;
      if (!replayProofs.has(response)) replayProofs.set(response, (async () => {
        try {
          const inspected = await inspectErrorBody(response, { signal });
          return inspected.complete && isReplaySafeRejection(response, JSON.parse(inspected.text));
        } catch {
          signal?.throwIfAborted();
          return false;
        }
      })());
      return replayProofs.get(response);
    };
    // Captured from a retried attempt's own body before it is discarded, so an
    // exhausted final attempt that comes back empty doesn't leave the caller
    // with nothing but the generic "Internal server error" default (#2722).
    let lastRetriedErrorText = null;

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Plan a retry. The discarded response is cancelled before waiting.
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      if (!await canReplay(response)) return null;
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts)
        return null;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(
          response,
          retryAttemptsByUrl[urlIndex] + 1,
          delayMs,
          { signal },
        );
        if (dynamic === false) return null; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      if (!Number.isFinite(waitMs) || waitMs < 0) return null;
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.(
        "RETRY",
        `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`,
      );
      return waitMs;
    };

    const cancelBody = response => {
      try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
    };
    const discardResponse = async response => {
      try {
        if (typeof response.clone === 'function') {
          const inspected = await inspectErrorBody(response, { signal });
          if (inspected.complete && inspected.text?.trim()) lastRetriedErrorText = inspected.text;
        }
      } finally { cancelBody(response); }
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(
        model,
        body,
        stream,
        credentials,
        sourceFormat,
        targetFormat,
      );
      const headers = this.buildHeaders(credentials, stream, url, model);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      const deadline = createExecutorResponseHeaderTimeout({
        connectTimeout,
        registryTimeout: this.config?.timeoutMs,
        envTimeout: FETCH_CONNECT_TIMEOUT_MS,
        signal,
      });

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg(
          "FETCH",
          `${this.provider.toUpperCase()} → ${url} | model=${model} | body=${fmtBytes(bodyStr.length)} | connectTimeout=${deadline.timeoutMs}ms`,
        );
        if (beforeDispatch) await beforeDispatch({ body: transformedBody, serialized: bodyStr, url });
        const response = await proxyAwareFetch(
          url,
          {
            method: "POST",
            headers,
            body: bodyStr,
            signal: deadline.signal,
          },
          proxyOptions,
        );
        await notifyDispatchResponse(afterDispatch, response);
        deadline.clear();
        if (signal?.aborted) { cancelBody(response); signal.throwIfAborted(); }
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg(
          "FETCH",
          `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`,
        );

        // A provider deadline belongs to the coordinator's pinned-account wait.
        // Returning it intact prevents both fixed-delay retries and URL fallback
        // from issuing another generation before Retry-After expires.
        if ((response.status === 429 || response.status === 503) && extractRetryAfterDeadline(response)) {
          return { response, url, headers, transformedBody };
        }

        const waitMs = await tryRetry(
            urlIndex,
            response.status,
            `status ${response.status}`,
            response,
          );
        if (waitMs !== null) {
          await discardResponse(response);
          await retryDelay(waitMs, undefined, { signal });
          urlIndex--;
          continue;
        }

        if (await canReplay(response) && this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.(
            "RETRY",
            `${response.status} on ${url}, trying fallback ${urlIndex + 1}`,
          );
          lastStatus = response.status;
          await discardResponse(response);
          continue;
        }

        if (lastRetriedErrorText && response.status >= 500 && typeof response.clone === "function") {
          const inspected = await inspectErrorBody(response, { signal });
          if (inspected.complete && !inspected.text?.trim()) {
            const preservedHeaders = new Headers(response.headers);
            preservedHeaders.delete("content-length");
            preservedHeaders.set("x-tokenproxy-error-body-source", "previous-rejected-attempt");
            cancelBody(response);
            return {
              response: new Response(lastRetriedErrorText, {
                status: response.status,
                headers: preservedHeaders,
              }),
              url,
              headers,
              transformedBody,
            };
          }
        }

        return { response, url, headers, transformedBody };
      } catch (rawError) {
        deadline.clear();
        const error = deadline.classify(rawError);
        lastError = error;
        dbg(
          "FETCH",
          `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeoutError(error) ? " (connect timeout)" : ""}`,
        );
        if (isConnectTimeoutError(error)) throw error;
        if (error.name === "AbortError") throw error;

        // A failed POST transport does not prove rejection. The provider may
        // have accepted and billed generation before the connection vanished.
        // Only an explicit HTTP rejection above authorizes another attempt.
        throw error;
      }
    }

    throw (
      lastError ||
      new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`)
    );
  }
}

export default BaseExecutor;
