import { notifyDispatchResponse } from "../utils/dispatchHooks.js";
import { BudgetAdmissionError } from "../../src/lib/db/repos/budgetRepo.js";
import { budgetErrorResult } from "../../src/sse/services/budgetDispatch.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { getExecutor } from "../executors/index.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getEmbeddingAdapter } from "./embeddingProviders/index.js";

/**
 * Core embeddings handler — orchestrator only. Provider-specific URL/headers/body/normalize
 * live in `./embeddingProviders/{id}.js`.
 *
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleEmbeddingsCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  beforeDispatch,
  afterDispatch,
}) {
  const { provider, model } = modelInfo;

  // Validate input
  const input = body.input;
  if (!input) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }
  if (typeof input !== "string" && !Array.isArray(input)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "input must be a string or array of strings");
  }

  const adapter = getEmbeddingAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support embeddings.`
    );
  }

  const ctx = { input };
  // buildUrl/buildHeaders/buildBody were called bare. An adapter that rejects a
  // misconfigured connection — selfhosted-embedding throws when no baseUrl is set
  // rather than silently falling back to api.openai.com — would have escaped this
  // function uncaught, surfacing as a 500 or a request that never settles. A
  // configuration mistake is a 400 with the reason in it.
  let url, headers, requestBody;
  try {
    url = adapter.buildUrl(model, credentials, ctx);
    headers = adapter.buildHeaders(credentials, ctx);
    requestBody = adapter.buildBody(model, {
      input,
      encoding_format: body.encoding_format || "float",
      dimensions: body.dimensions,
      input_type: body.input_type,
    });
  } catch (error) {
    if (error instanceof BudgetAdmissionError) return budgetErrorResult(error);
    log?.debug?.("EMBEDDINGS", `Request build failed: ${error.message}`);
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}/${model}] ${error.message}`);
  }

  log?.debug?.("EMBEDDINGS", `${provider.toUpperCase()} | ${model} | input_type=${Array.isArray(input) ? `array[${input.length}]` : "string"}`);

  let providerResponse;
  let serialized;
  try {
    serialized = JSON.stringify(requestBody);
    if (beforeDispatch) await beforeDispatch({ body: requestBody, serialized, url });
    providerResponse = await fetch(url, {
      method: "POST",
      headers,
      body: serialized,
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    });
    await notifyDispatchResponse(afterDispatch, providerResponse);
  } catch (error) {
    if (error instanceof BudgetAdmissionError) return budgetErrorResult(error);
    const errMsg = formatProviderError(error, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("EMBEDDINGS", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 — try token refresh (skip for noAuth providers)
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    const newCredentials = await refreshWithRetry(
      () => executor.refreshCredentials(credentials, log),
      3,
      log
    );

    if (newCredentials?.accessToken || newCredentials?.apiKey) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for embeddings`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);

      try {
        const retryHeaders = adapter.buildHeaders(credentials, ctx);
        const retryUrl = adapter.buildUrl(model, credentials, ctx);
        if (beforeDispatch) await beforeDispatch({ body: requestBody, serialized, url: retryUrl });
        providerResponse = await fetch(retryUrl, {
          method: "POST",
          headers: retryHeaders,
          body: serialized,
        });
    await notifyDispatchResponse(afterDispatch, providerResponse);
      } catch (error) {
    if (error instanceof BudgetAdmissionError) return budgetErrorResult(error);
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, error.message || 'Embedding retry failed', null, { safeToReplay: false });
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), statusCode);
    log?.debug?.("EMBEDDINGS", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg, null, { safeToReplay: true });
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const normalized = adapter.normalize(responseBody, model);
  log?.debug?.("EMBEDDINGS", `Success | usage=${JSON.stringify(normalized.usage || {})}`);

  return {
    success: true,
    usage: normalized.usage || null,
    response: new Response(JSON.stringify(normalized), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
