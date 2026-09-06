import { HTTP_STATUS, JSON_PROXY_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { createErrorResult, parseUpstreamError } from "../utils/error.js";
import { isReplaySafeRejection } from "../utils/replaySafety.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const KIND_CONFIG_KEYS = {
  ocr: "ocrConfig",
  moderation: "moderationConfig",
};

export function getJsonProxyConfig(provider, kind) {
  const configKey = KIND_CONFIG_KEYS[kind];
  return configKey ? PROVIDER_MEDIA[provider]?.[configKey] || null : null;
}

function buildAuthHeaders(config, credentials) {
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token || config.authType === "none") return {};
  switch (config.authHeader) {
    case "x-api-key": return { "x-api-key": token };
    case "authorization": return { Authorization: token };
    case "token": return { Authorization: `Token ${token}` };
    default: return { Authorization: `Bearer ${token}` };
  }
}

function sanitizeSecrets(text, credentials) {
  let safe = String(text || "").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  for (const key of ["apiKey", "accessToken", "refreshToken"]) {
    const secret = credentials?.[key];
    if (typeof secret === "string" && secret.length >= 8) safe = safe.split(secret).join("[redacted]");
  }
  return safe;
}

function buildProxyOptions(credentials) {
  return {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
    strictProxy: credentials?.providerSpecificData?.strictProxy === true,
  };
}

function combineSignals(clientSignal, timeoutMs) {
  let timeoutSignal;
  if (typeof AbortSignal?.timeout === "function") {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    timeoutSignal = controller.signal;
  }
  if (clientSignal && timeoutSignal && typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([clientSignal, timeoutSignal]), timeoutSignal };
  }
  if (clientSignal && timeoutSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (clientSignal.aborted || timeoutSignal.aborted) abort();
    else {
      clientSignal.addEventListener("abort", abort, { once: true });
      timeoutSignal.addEventListener("abort", abort, { once: true });
    }
    return { signal: controller.signal, timeoutSignal };
  }
  return { signal: clientSignal || timeoutSignal, timeoutSignal };
}

function classifyTransportError(error, { clientSignal, timeoutSignal, provider, label, credentials, phase }) {
  if (clientSignal?.aborted) {
    return { success: false, clientAborted: true, response: new Response(null, { status: 499 }) };
  }
  if (timeoutSignal?.aborted) {
    return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, `[${provider}] ${label} upstream timed out`);
  }
  const message = sanitizeSecrets(error?.message || "Upstream request failed", credentials);
  return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `[${provider}] ${label} upstream ${phase} failed: ${message}`);
}

/**
 * Proxy a JSON-only provider endpoint whose request and response schemas are
 * already native to the client. The application-side handler owns auth,
 * connection selection, and fallback. This core owns the registered endpoint.
 */
export async function handleJsonProxyCore({
  provider,
  model,
  kind,
  body,
  credentials,
  signal: clientSignal,
  timeoutMs = JSON_PROXY_TIMEOUT_MS,
}) {
  const config = getJsonProxyConfig(provider, kind);
  const label = kind === "ocr" ? "OCR" : "moderation";
  if (!config?.baseUrl) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support ${label}`);
  }

  const { signal, timeoutSignal } = combineSignals(clientSignal, timeoutMs);
  const fetchOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.headers || {}),
      ...buildAuthHeaders(config, credentials),
    },
    body: JSON.stringify({ ...body, model }),
    signal,
  };

  let upstream;
  try {
    upstream = await proxyAwareFetch(config.baseUrl, fetchOptions, buildProxyOptions(credentials));
  } catch (error) {
    return classifyTransportError(error, {
      clientSignal,
      timeoutSignal,
      provider,
      label,
      credentials,
      phase: "fetch",
    });
  }

  let responseBody;
  try {
    if (!upstream.ok) {
      const parsed = await parseUpstreamError(upstream, null, { signal });
      const message = sanitizeSecrets(parsed.message, credentials);
      return createErrorResult(upstream.status, `[${provider}] ${message.slice(0, 2000)}`, parsed.resetsAtMs,
        { safeToReplay: isReplaySafeRejection(upstream) });
    }
    responseBody = await upstream.text();
  } catch (error) {
    return classifyTransportError(error, {
      clientSignal,
      timeoutSignal,
      provider,
      label,
      credentials,
      phase: "response body",
    });
  }

  return {
    success: true,
    response: new Response(responseBody, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
