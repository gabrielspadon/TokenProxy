// Web Fetch handler — dispatches to firecrawl, jina-reader, tavily, exa
// Returns normalized shape across all providers

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { isReplaySafeRejection } from "../../utils/replaySafety.js";
import { extractRetryAfterDeadline } from "../../utils/error.js";

function upstreamFailure(response, error, errorPayload = null) {
  return { success: false, status: response.status, error,
    failureMetadata: { safeToReplay: isReplaySafeRejection(response, errorPayload) },
    resetsAtMs: extractRetryAfterDeadline(response) };
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_FORMAT = "markdown";
const OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch";
const OLLAMA_FORMAT = "markdown";
const OLLAMA_MAX_CHARACTERS = 200000;
const OLLAMA_TIMEOUT_MS = 30000;
const MAX_TARGET_URL_BYTES = 8192;
const MAX_SUCCESS_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_ERROR_CHARACTERS = 512;
const MAX_LINKS = 100;
const MAX_LINK_BYTES = 8192;
const MAX_LINK_TOTAL_BYTES = 64 * 1024;

const OLLAMA_ERROR = Object.freeze({
  INVALID_CONFIG: "OLLAMA_INVALID_CONFIG",
  INVALID_URL: "OLLAMA_INVALID_URL",
  INVALID_FORMAT: "OLLAMA_INVALID_FORMAT",
  INVALID_MAX_CHARACTERS: "OLLAMA_INVALID_MAX_CHARACTERS",
  INVALID_API_KEY: "OLLAMA_INVALID_API_KEY",
  CLIENT_ABORTED: "OLLAMA_CLIENT_ABORTED",
  TIMEOUT: "OLLAMA_TIMEOUT",
  TRANSPORT_ERROR: "OLLAMA_TRANSPORT_ERROR",
  RESPONSE_TOO_LARGE: "OLLAMA_RESPONSE_TOO_LARGE",
  INVALID_CONTENT_TYPE: "OLLAMA_INVALID_CONTENT_TYPE",
  INVALID_ENCODING: "OLLAMA_INVALID_ENCODING",
  INVALID_JSON: "OLLAMA_INVALID_JSON",
  EMPTY_RESPONSE: "OLLAMA_EMPTY_RESPONSE",
  INVALID_RESPONSE: "OLLAMA_INVALID_RESPONSE",
  UPSTREAM_ERROR: "OLLAMA_UPSTREAM_ERROR",
});

function getDefaultTimeoutMs() {
  const env = process.env.FIRECRAWL_TIMEOUT_MS;
  if (!env) return DEFAULT_TIMEOUT_MS;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function getDefaultFormat() {
  return process.env.FIRECRAWL_DEFAULT_FORMAT || DEFAULT_FORMAT;
}

function failure(status, code, message) {
  return {
    success: false,
    status,
    code,
    error: String(message || "Ollama web fetch failed").slice(0, MAX_ERROR_CHARACTERS),
  };
}

function validationFailure(status, code, message) {
  return { ok: false, result: failure(status, code, message) };
}

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function configuredProxySecrets(proxyOptions) {
  const secrets = [];
  for (const value of [proxyOptions?.connectionProxyUrl, proxyOptions?.vercelRelayUrl]) {
    if (typeof value !== "string" || !value) continue;
    secrets.push(value);
    const rawUserinfo = /^[a-z][a-z\d+.-]*:\/\/([^@/]+)@/i.exec(value)?.[1];
    if (rawUserinfo) secrets.push(rawUserinfo);
    try {
      const parsed = new URL(value);
      for (const component of [parsed.username, parsed.password]) {
        if (!component) continue;
        secrets.push(component);
        try { secrets.push(decodeURIComponent(component)); } catch { }
      }
    } catch { }
  }
  return [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
}

function configuredTargetSecrets(url) {
  const secrets = [];
  if (typeof url !== "string" || !url) return secrets;
  secrets.push(url);
  try {
    const canonical = new URL(url).href;
    secrets.push(canonical);
    for (const decoder of [decodeURI, decodeURIComponent]) {
      try { secrets.push(decoder(canonical)); } catch { }
    }
  } catch { }
  return secrets;
}

function sanitizeOllamaError(message, { apiKey, url, proxyOptions }) {
  let safe = String(message || "Ollama web fetch failed");
  const secrets = [apiKey, ...configuredTargetSecrets(url), ...configuredProxySecrets(proxyOptions)]
    .filter((value) => typeof value === "string" && value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  safe = safe.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
  safe = safe.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
  return safe.slice(0, MAX_ERROR_CHARACTERS);
}

function validateOllamaRequest({ url, format, maxCharacters, providerConfig, credentials }) {
  if (!providerConfig
      || !Array.isArray(providerConfig.formats)
      || providerConfig.formats.length !== 1
      || providerConfig.formats[0] !== OLLAMA_FORMAT
      || providerConfig.maxCharacters !== OLLAMA_MAX_CHARACTERS
      || providerConfig.timeoutMs !== OLLAMA_TIMEOUT_MS) {
    return validationFailure(
      500,
      OLLAMA_ERROR.INVALID_CONFIG,
      "Ollama web fetch is not configured",
    );
  }

  if (typeof url !== "string" || !url || url !== url.trim()
      || Buffer.byteLength(url, "utf8") > MAX_TARGET_URL_BYTES) {
    return validationFailure(400, OLLAMA_ERROR.INVALID_URL, "Invalid Ollama web fetch URL");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return validationFailure(400, OLLAMA_ERROR.INVALID_URL, "Invalid Ollama web fetch URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    return validationFailure(400, OLLAMA_ERROR.INVALID_URL, "Invalid Ollama web fetch URL");
  }

  const resolvedFormat = format == null ? OLLAMA_FORMAT : format;
  if (resolvedFormat !== OLLAMA_FORMAT) {
    return validationFailure(
      400,
      OLLAMA_ERROR.INVALID_FORMAT,
      "Ollama web fetch supports markdown only",
    );
  }

  const resolvedMax = maxCharacters == null ? OLLAMA_MAX_CHARACTERS : maxCharacters;
  if (!Number.isInteger(resolvedMax) || resolvedMax < 1 || resolvedMax > OLLAMA_MAX_CHARACTERS) {
    return validationFailure(
      400,
      OLLAMA_ERROR.INVALID_MAX_CHARACTERS,
      "max_characters must be an integer from 1 through 200000",
    );
  }

  const apiKey = credentials?.apiKey;
  if (typeof apiKey !== "string" || apiKey !== apiKey.trim() || !/^[\x21-\x7E]+$/.test(apiKey)) {
    return validationFailure(
      401,
      OLLAMA_ERROR.INVALID_API_KEY,
      "A valid Ollama API key is required",
    );
  }

  return {
    ok: true,
    url,
    format: resolvedFormat,
    maxCharacters: resolvedMax,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    apiKey,
  };
}

function createOllamaDeadline({ callerSignal, timeoutMs }) {
  const controller = new AbortController();
  let source = null;
  let cleared = false;
  const abort = (nextSource, reason) => {
    if (source !== null) return;
    source = nextSource;
    controller.abort(reason);
  };
  const onCallerAbort = () => abort(
    "caller",
    callerSignal.reason ?? new DOMException("The operation was aborted", "AbortError"),
  );
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => abort(
    "timeout",
    codedError(OLLAMA_ERROR.TIMEOUT, "Ollama web fetch timed out"),
  ), timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    classify(error) {
      return { source: source || "other", error: controller.signal.reason || error };
    },
    clear() {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function ownCancellation(reader, reason) {
  try {
    Promise.resolve(reader?.cancel(reason)).catch(() => {});
  } catch { }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

function ownLateResolution(value, reason, onLateResolve) {
  if (typeof onLateResolve !== "function") return;
  try {
    Promise.resolve(onLateResolve(value, reason)).catch(() => {});
  } catch { }
}

function waitWithSignal(promise, signal, onLateResolve) {
  const owned = Promise.resolve(promise);
  if (signal?.aborted) {
    owned.then(
      (value) => ownLateResolution(value, signal.reason, onLateResolve),
      () => {},
    );
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    owned.then(
      (value) => {
        if (settled) {
          ownLateResolution(value, signal?.reason, onLateResolve);
          return;
        }
        finish(resolve, value);
      },
      (error) => finish(reject, error),
    );
  });
}

function readWithSignal(reader, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let pending;
  try {
    pending = reader.read();
  } catch (error) {
    return Promise.reject(error);
  }
  return waitWithSignal(pending, signal);
}

function concatenateBytes(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readBoundedBody(response, { maxBytes, signal, overflowMode }) {
  throwIfAborted(signal);
  const contentLength = response.headers.get("content-length");
  throwIfAborted(signal);
  if (/^\d+$/.test(contentLength || "") && Number(contentLength) > maxBytes) {
    const reader = response.body?.getReader();
    throwIfAborted(signal);
    ownCancellation(reader, codedError(OLLAMA_ERROR.RESPONSE_TOO_LARGE));
    throwIfAborted(signal);
    return overflowMode === "truncate"
      ? { bytes: new Uint8Array(), overflowed: true }
      : Promise.reject(codedError(OLLAMA_ERROR.RESPONSE_TOO_LARGE));
  }

  const body = response.body;
  throwIfAborted(signal);
  const reader = body?.getReader();
  throwIfAborted(signal);
  if (!reader) {
    throwIfAborted(signal);
    return { bytes: new Uint8Array(), overflowed: false };
  }
  const chunks = [];
  let total = 0;
  let canceled = false;
  const cancel = (reason) => {
    if (canceled) return;
    canceled = true;
    ownCancellation(reader, reason);
  };
  try {
    while (true) {
      const read = await readWithSignal(reader, signal);
      const { value, done } = read;
      throwIfAborted(signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancel(codedError(OLLAMA_ERROR.RESPONSE_TOO_LARGE));
        if (overflowMode === "truncate") {
          return { bytes: new Uint8Array(), overflowed: true };
        }
        throw codedError(OLLAMA_ERROR.RESPONSE_TOO_LARGE);
      }
      chunks.push(value);
    }
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { }
  }
  throwIfAborted(signal);
  return { bytes: concatenateBytes(chunks, total), overflowed: false };
}

function validateOllamaLinks(value) {
  if (value === undefined) return { ok: true, links: [] };
  if (!Array.isArray(value) || value.length > MAX_LINKS) {
    return validationFailure(
      502,
      OLLAMA_ERROR.INVALID_RESPONSE,
      "Invalid Ollama web fetch links",
    );
  }
  let aggregateBytes = 0;
  for (const link of value) {
    if (typeof link !== "string" || link !== link.trim()) {
      return validationFailure(
        502,
        OLLAMA_ERROR.INVALID_RESPONSE,
        "Invalid Ollama web fetch links",
      );
    }
    const bytes = Buffer.byteLength(link, "utf8");
    let parsed;
    try {
      parsed = new URL(link);
    } catch {
      return validationFailure(
        502,
        OLLAMA_ERROR.INVALID_RESPONSE,
        "Invalid Ollama web fetch links",
      );
    }
    aggregateBytes += bytes;
    if (bytes > MAX_LINK_BYTES || aggregateBytes > MAX_LINK_TOTAL_BYTES
        || !["http:", "https:"].includes(parsed.protocol)
        || parsed.username || parsed.password) {
      return validationFailure(
        502,
        OLLAMA_ERROR.INVALID_RESPONSE,
        "Invalid Ollama web fetch links",
      );
    }
  }
  return { ok: true, links: [...value] };
}

function truncateUtf16Safely(text, maxCharacters) {
  let truncated = text.slice(0, maxCharacters);
  if (!truncated) return truncated;
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) truncated = truncated.slice(0, -1);
  return truncated;
}

function cancelResponseBody(response, reason) {
  try {
    ownCancellation(response.body?.getReader(), reason);
  } catch { }
}

function cancelLateResponse(value, reason) {
  if (!(value instanceof Response)) return;
  cancelResponseBody(value, reason);
}

function isJsonMediaType(value) {
  const mime = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mime === "application/json"
    || (mime.startsWith("application/") && mime.endsWith("+json"));
}

function boundedUpstreamFailure(response, body, context) {
  const { status } = response;
  const generic = `Ollama web fetch failed (HTTP ${status})`;
  let message = generic;
  let errorPayload = null;
  if (!body.overflowed && isJsonMediaType(response.headers.get("content-type"))) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes).trim();
      errorPayload = JSON.parse(text);
      const candidate = errorPayload?.error ?? errorPayload?.message ?? errorPayload?.detail;
      if (["string", "number", "boolean"].includes(typeof candidate)) {
        message = String(candidate);
      }
    } catch { }
  }
  return { ...failure(
    status,
    OLLAMA_ERROR.UPSTREAM_ERROR,
    sanitizeOllamaError(message, context),
  ), failureMetadata: {
    safeToReplay: isReplaySafeRejection(response, errorPayload),
  }, resetsAtMs: extractRetryAfterDeadline(response) };
}

function classifyOllamaFailure(error, { deadline, apiKey, url, proxyOptions }) {
  const classified = deadline.classify(error);
  if (classified.source === "caller") {
    return failure(
      499,
      OLLAMA_ERROR.CLIENT_ABORTED,
      "Ollama web fetch was canceled by the caller",
    );
  }
  if (classified.source === "timeout") {
    return failure(504, OLLAMA_ERROR.TIMEOUT, "Ollama web fetch timed out");
  }
  if (classified.error?.code === OLLAMA_ERROR.RESPONSE_TOO_LARGE) {
    return failure(
      502,
      OLLAMA_ERROR.RESPONSE_TOO_LARGE,
      "Ollama web fetch response exceeded 4 MiB",
    );
  }
  return failure(
    502,
    OLLAMA_ERROR.TRANSPORT_ERROR,
    sanitizeOllamaError(
      classified.error?.message || "Ollama web fetch transport failed",
      { apiKey, url, proxyOptions },
    ),
  );
}

/**
 * @typedef {Object} FetchResult
 * @property {boolean} success
 * @property {number} [status]
 * @property {string} [error]
 * @property {Object} [data]
 */

/**
 * Fetch with timeout abort.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
// Strip non-ASCII chars from header values (HTTP headers must be ByteString).
function sanitizeHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = typeof v === "string" ? v.replace(/[^\x00-\xFF]/g, "").trim() : v;
  }
  return out;
}

async function tryFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, headers: sanitizeHeaders(init.headers), signal: ctrl.signal });
    return { ok: true, res };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { ok: false, timeout: isAbort, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, max) {
  if (!text || typeof text !== "string") return text || "";
  if (!max || max <= 0) return text;
  return text.length > max ? text.slice(0, max) : text;
}

function parseJinaTitle(text) {
  const source = String(text || "");
  const metadataTitle = source.match(/^\s*Title:\s*(.+)$/mi);
  if (metadataTitle) return metadataTitle[1].trim();
  const m = source.match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function buildData({ provider, url, title, format, text, links, costUsd, responseMs, upstreamMs }) {
  const data = {
    provider,
    url,
    title: title || null,
    content: { format, text: text || "", length: (text || "").length },
    metadata: { author: null, published_at: null, language: null },
    usage: { fetch_cost_usd: costUsd ?? null },
    metrics: { response_time_ms: responseMs, upstream_latency_ms: upstreamMs }
  };
  if (links?.length) data.links = [...links];
  return data;
}

function parseAndNormalizeOllama(bytes, valid, startedAt, upstreamMs) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure(
      502,
      OLLAMA_ERROR.INVALID_ENCODING,
      "Ollama web fetch returned invalid UTF-8",
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return failure(502, OLLAMA_ERROR.INVALID_JSON, "Ollama web fetch returned invalid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return failure(
      502,
      OLLAMA_ERROR.INVALID_RESPONSE,
      "Ollama web fetch returned an invalid response",
    );
  }
  if (Object.keys(data).length === 0) {
    return failure(
      502,
      OLLAMA_ERROR.EMPTY_RESPONSE,
      "Ollama web fetch returned an empty response",
    );
  }
  if (typeof data.title !== "string" || typeof data.content !== "string") {
    return failure(
      502,
      OLLAMA_ERROR.INVALID_RESPONSE,
      "Ollama web fetch returned an invalid response",
    );
  }
  const checkedLinks = validateOllamaLinks(data.links);
  if (!checkedLinks.ok) return checkedLinks.result;
  return {
    success: true,
    data: buildData({
      provider: "ollama",
      url: valid.url,
      title: data.title,
      format: valid.format,
      text: truncateUtf16Safely(data.content, valid.maxCharacters),
      links: checkedLinks.links,
      costUsd: null,
      responseMs: Date.now() - startedAt,
      upstreamMs,
    }),
  };
}

async function runOllama(args) {
  const valid = validateOllamaRequest(args);
  if (!valid.ok) return valid.result;
  const deadline = createOllamaDeadline({
    callerSignal: args.signal,
    timeoutMs: valid.timeoutMs,
  });
  if (deadline.signal.aborted) {
    deadline.clear();
    return classifyOllamaFailure(deadline.signal.reason, {
      deadline,
      apiKey: valid.apiKey,
      url: valid.url,
      proxyOptions: args.proxyOptions,
    });
  }

  try {
    const upstreamStartedAt = Date.now();
    const response = await waitWithSignal(
      args.transport(OLLAMA_WEB_FETCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${valid.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ url: valid.url }),
        signal: deadline.signal,
      }, args.proxyOptions ?? null),
      deadline.signal,
      cancelLateResponse,
    );
    throwIfAborted(deadline.signal);

    const upstreamMs = Date.now() - upstreamStartedAt;
    const responseOk = response.ok;
    throwIfAborted(deadline.signal);
    if (!responseOk) {
      const body = await readBoundedBody(response, {
        maxBytes: MAX_ERROR_BODY_BYTES,
        signal: deadline.signal,
        overflowMode: "truncate",
      });
      throwIfAborted(deadline.signal);
      const result = boundedUpstreamFailure(response, body, {
        apiKey: valid.apiKey,
        url: valid.url,
        proxyOptions: args.proxyOptions,
      });
      throwIfAborted(deadline.signal);
      return result;
    }

    const contentType = response.headers.get("content-type");
    throwIfAborted(deadline.signal);
    if (!isJsonMediaType(contentType)) {
      cancelResponseBody(response, codedError(OLLAMA_ERROR.INVALID_CONTENT_TYPE));
      throwIfAborted(deadline.signal);
      return failure(
        502,
        OLLAMA_ERROR.INVALID_CONTENT_TYPE,
        "Ollama web fetch returned a non-JSON response",
      );
    }

    const body = await readBoundedBody(response, {
      maxBytes: MAX_SUCCESS_BODY_BYTES,
      signal: deadline.signal,
      overflowMode: "error",
    });
    throwIfAborted(deadline.signal);
    const result = parseAndNormalizeOllama(body.bytes, valid, args.startedAt, upstreamMs);
    throwIfAborted(deadline.signal);
    return result;
  } catch (error) {
    return classifyOllamaFailure(error, {
      deadline,
      apiKey: valid.apiKey,
      url: valid.url,
      proxyOptions: args.proxyOptions,
    });
  } finally {
    deadline.clear();
  }
}

async function readJsonOrText(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { return { json: await res.json() }; } catch { return { text: "" }; }
  }
  return { text: await res.text() };
}

/**
 * Main handler.
 * @param {Object} params
 * @param {string} params.url
 * @param {string} [params.format]
 * @param {number} [params.maxCharacters]
 * @param {string} params.provider
 * @param {Object} [params.providerConfig]
 * @param {Object} [params.credentials]
 * @param {AbortSignal} [params.signal]
 * @param {Object} [params.proxyOptions]
 * @param {Function} [params.transport]
 * @param {Function} [params.log]
 * @returns {Promise<FetchResult>}
 */
export async function handleFetchCore({
  url,
  format,
  maxCharacters,
  provider,
  providerConfig,
  credentials,
  signal,
  proxyOptions,
  transport,
  log,
}) {
  const startedAt = Date.now();
  if (provider === "ollama") {
    return runOllama({
      url,
      format,
      maxCharacters,
      providerConfig,
      credentials,
      signal,
      proxyOptions,
      transport: transport ?? proxyAwareFetch,
      startedAt,
    });
  }

  if (!url || typeof url !== "string") {
    return { success: false, status: 400, error: "url is required" };
  }
  if (!provider) {
    return { success: false, status: 400, error: "provider is required" };
  }

  const fmt = format || getDefaultFormat();
  const timeoutMs = providerConfig?.timeoutMs || getDefaultTimeoutMs();
  const apiKey = credentials?.apiKey || credentials?.key || credentials?.token || "";
  const costPerQuery = providerConfig?.costPerQuery ?? null;

  try {
    if (provider === "firecrawl" || provider === "firecrawl_custom") {
      return await runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, provider });
    }
    if (provider === "jina-reader") {
      return await runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "tavily") {
      return await runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "exa") {
      return await runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    return { success: false, status: 400, error: `Unsupported provider: ${provider}` };
  } catch (err) {
    log?.("fetch handler error:", err?.message || err);
    return { success: false, status: 502, error: err?.message || "Internal fetch error" };
  }
}

async function runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, provider }) {
  const isCustom = provider === "firecrawl_custom";

  if (!isCustom && !apiKey) {
    return { success: false, status: 400, error: "FIRECRAWL_API_KEY is required for the official Firecrawl provider" };
  }

  const baseUrl = isCustom
    ? (process.env.FIRECRAWL_BASE_URL || "http://127.0.0.1:3002")
    : (process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev");
  const endpoint = isCustom ? "/v2/scrape" : "/v1/scrape";

  const headers = { "content-type": "application/json" };
  if (!isCustom && apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const upstreamStart = Date.now();
  const r = await tryFetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, formats: [fmt] })
  }, timeoutMs);

  if (!r.ok) {
    const status = r.timeout ? 504 : 502;
    const error = isCustom ? `Custom Firecrawl instance unreachable: ${r.error}` : r.error;
    return { success: false, status, error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return upstreamFailure(r.res, json?.error || `Firecrawl error: ${r.res.status}`, json);
  }
  const d = json?.data || {};
  const text = truncate(d.markdown || d.html || d.text || "", maxCharacters);
  const title = d.metadata?.title || null;
  return {
    success: true,
    data: buildData({
      provider, url, title, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

// Formats r.jina.ai accepts on X-Return-Format. Anything else is left off the
// request so an unrecognised value falls back to Jina's own default (markdown)
// instead of being rejected.
const JINA_RETURN_FORMATS = new Set(["markdown", "html", "text", "screenshot", "pageshot"]);

async function runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  // fmt was accepted and then dropped, so every fetch came back in Jina's
  // default format however the caller asked for it, while the response still
  // reported `format: fmt` — the reply claimed a format it had not requested
  // (#2239).
  const returnFormat = JINA_RETURN_FORMATS.has(fmt) ? fmt : null;
  const r = await tryFetch("https://r.jina.ai/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(returnFormat ? { "x-return-format": returnFormat } : {}),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const body = await r.res.text();
  if (!r.res.ok) {
    return upstreamFailure(r.res, body?.slice(0, 500) || `Jina error: ${r.res.status}`);
  }
  const text = truncate(body, maxCharacters);
  return {
    success: true,
    data: buildData({
      // Report the format actually requested. Claiming `fmt` while sending no
      // header made the response describe itself wrongly.
      provider: "jina-reader", url, title: parseJinaTitle(body), format: returnFormat || DEFAULT_FORMAT, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ urls: [url], extract_depth: "basic" })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return upstreamFailure(r.res, json?.error || `Tavily error: ${r.res.status}`, json);
  }
  const first = json?.results?.[0] || {};
  const text = truncate(first.raw_content || "", maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "tavily", url, title: null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    },
    body: JSON.stringify({ ids: [url], text: true })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return upstreamFailure(r.res, json?.error || `Exa error: ${r.res.status}`, json);
  }
  const first = json?.results?.[0] || {};
  const text = truncate(first.text || "", maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "exa", url, title: first.title || null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}
