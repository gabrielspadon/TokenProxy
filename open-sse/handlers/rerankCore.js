import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { getExecutor } from "../executors/index.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";

// The contract this endpoint speaks is Cohere's `POST /v2/rerank`
// ({ model, query, documents, top_n } -> { results: [{ index, relevance_score }] }),
// because it is the one the other vendors copied rather than one invented here:
// Jina, Together and SiliconFlow publish the same field names on their own
// /v1/rerank. Voyage is the single exception — `top_k` instead of `top_n`, and
// its ranked list under `data` instead of `results` — so those two differences
// are mapped below instead of being pushed onto the client.
//
// The URL lives here rather than in each provider's registry row because the
// registry has no rerankConfig field yet; when it grows one, this table is what
// moves into it.
export const RERANK_PROVIDERS = {
  cohere: { url: "https://api.cohere.com/v2/rerank" },
  "jina-ai": { url: "https://api.jina.ai/v1/rerank" },
  together: { url: "https://api.together.xyz/v1/rerank" },
  siliconflow: { url: "https://api.siliconflow.com/v1/rerank" },
  "voyage-ai": { url: "https://api.voyageai.com/v1/rerank", topField: "top_k", resultsField: "data" },
};

export function getRerankProvider(provider) {
  return RERANK_PROVIDERS[provider] || null;
}

// A document is a bare string (every vendor) or Cohere v1's { text }. Anything
// else is a client mistake and is reported as one rather than being stringified
// into "[object Object]" and silently scored.
export function documentText(doc) {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc === "object" && typeof doc.text === "string") return doc.text;
  return null;
}

// Cohere reports its spend under meta, the rest under usage, SiliconFlow under
// tokens. Only an exact integer count is returned: an absent or malformed count
// yields null so the caller records nothing, the same discipline embeddings
// applies, rather than billing the operator for a guess.
export function rerankUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const total = raw.usage?.total_tokens
    ?? raw.usage?.prompt_tokens
    ?? raw.meta?.tokens?.input_tokens
    ?? raw.meta?.billed_units?.input_tokens
    ?? raw.tokens?.input_tokens;
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  return { prompt_tokens: total, completion_tokens: 0, total_tokens: total };
}

// One shape out, whichever vendor answered. `document` is filled from the
// request when the client asked for it and the provider did not echo it —
// Cohere v2 never does — so return_documents means the same thing everywhere.
export function normalizeRerank(responseBody, { model, documents, returnDocuments, resultsField }) {
  const raw = Array.isArray(responseBody?.[resultsField]) ? responseBody[resultsField] : [];
  const results = raw.map((r) => {
    const index = Number(r?.index);
    const out = {
      index: Number.isInteger(index) ? index : 0,
      relevance_score: Number(r?.relevance_score ?? r?.score ?? 0),
    };
    if (returnDocuments) {
      const echoed = documentText(r?.document);
      out.document = { text: echoed ?? documents[out.index] ?? "" };
    }
    return out;
  });
  const usage = rerankUsage(responseBody);
  return {
    object: "rerank",
    id: responseBody?.id,
    model,
    results,
    ...(usage ? { usage: { total_tokens: usage.total_tokens } } : {}),
  };
}

/**
 * Core rerank handler. Same orchestrator shape as handleEmbeddingsCore: validate,
 * build, call, refresh once on 401/403, normalize.
 *
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleRerankCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;

  const query = body?.query;
  if (typeof query !== "string" || !query.trim()) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }
  if (!Array.isArray(body?.documents) || body.documents.length === 0) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "documents must be a non-empty array");
  }
  const documents = body.documents.map(documentText);
  const badDoc = documents.findIndex((d) => d === null);
  if (badDoc !== -1) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `documents[${badDoc}] must be a string or { text }`);
  }

  const cfg = getRerankProvider(provider);
  if (!cfg) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support rerank.`
    );
  }

  const topField = cfg.topField || "top_n";
  const resultsField = cfg.resultsField || "results";
  const returnDocuments = body.return_documents === true;

  const requestBody = { model, query, documents };
  // Accept either spelling from the client and send whichever one this vendor
  // publishes, so a client written against Cohere works against Voyage.
  const topN = body.top_n ?? body.top_k;
  if (topN != null && topN !== "") {
    const n = Number(topN);
    if (Number.isInteger(n) && n > 0) requestBody[topField] = n;
  }
  if (body.max_tokens_per_doc != null && provider === "cohere") {
    const n = Number(body.max_tokens_per_doc);
    if (Number.isInteger(n) && n > 0) requestBody.max_tokens_per_doc = n;
  }
  // Cohere v2 has no return_documents and rejects unknown fields; the others
  // take it, and asking for it there saves echoing documents we already hold.
  if (returnDocuments && provider !== "cohere") requestBody.return_documents = true;

  const headers = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${credentials.apiKey || credentials.accessToken}`,
  });

  log?.debug?.("RERANK", `${provider.toUpperCase()} | ${model} | documents=${documents.length}`);

  let providerResponse;
  try {
    providerResponse = await fetch(cfg.url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(requestBody),
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    });
  } catch (error) {
    const errMsg = formatProviderError(error, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("RERANK", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

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
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for rerank`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);
      try {
        providerResponse = await fetch(cfg.url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(requestBody),
        });
      } catch {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), statusCode);
    log?.debug?.("RERANK", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const normalized = normalizeRerank(responseBody, { model, documents, returnDocuments, resultsField });
  log?.debug?.("RERANK", `Success | results=${normalized.results.length}`);

  return {
    success: true,
    usage: rerankUsage(responseBody),
    response: new Response(JSON.stringify(normalized), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
