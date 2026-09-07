import { randomUUID } from "node:crypto";
import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "../../../src/lib/usageDb.js";
import { recordCostLedgerForRequest } from "../../../src/lib/db/repos/costLedgerRepo.js";
import { extractThinking } from "../../translator/concerns/thinkingUnified.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage, clampReasoningTokens } from "../../utils/usageTracking.js";
import { priceUsage, usageQuantityPresence } from "../../../src/lib/db/repos/usagePricing.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  if (responseBody.usage?.input_tokens !== undefined) {
    const completionTokens = responseBody.usage.output_tokens;
    return {
      prompt_tokens: responseBody.usage.input_tokens,
      completion_tokens: completionTokens,
      cached_tokens: responseBody.usage.input_tokens_details?.cached_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens,
      reasoning_tokens: clampReasoningTokens(
        responseBody.usage.output_tokens_details?.thinking_tokens,
        completionTokens,
      ),
      cost_usd: responseBody.usage.cost_usd,
      cost_in_usd: responseBody.usage.cost_in_usd,
      cost_in_usd_ticks: responseBody.usage.cost_in_usd_ticks,
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens,
      completion_tokens: responseBody.usage.completion_tokens,
      cached_tokens: responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens,
      cost_usd: responseBody.usage.cost_usd,
      cost_in_usd: responseBody.usage.cost_in_usd,
      cost_in_usd_ticks: responseBody.usage.cost_in_usd_ticks,
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount,
      completion_tokens: usageMetadata.candidatesTokenCount,
      cached_tokens: usageMetadata.cachedContentTokenCount,
      reasoning_tokens: usageMetadata.thoughtsTokenCount
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    id: base.contextTelemetry?.requestId,
    contextTelemetry: base.contextTelemetry,
    timestamp: base.contextTelemetry?.timestamp || new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens ?? null,
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    rid: base.rid || undefined,
    ...overrides
  };
}

/**
 * The numeric fields behind formatDoneLine as the k=v map REQ.ok carries. One
 * selection point for both the human line and the decision line, so the CACHE
 * split and units cannot drift between them.
 */
export function doneFields({ usage, latency }) {
  const u = usage || {};
  const fields = {
    t: latency?.total ?? 0,
    in: u.prompt_tokens ?? u.input_tokens ?? 0,
    out: u.completion_tokens ?? u.output_tokens ?? 0,
    cr: u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    cw: u.cache_creation_input_tokens ?? 0,
  };
  // Only observed, cache-inclusive input can calibrate the next request.
  // The display fields above preserve the provider convention.
  if (!u.estimated && typeof (u.prompt_tokens ?? u.input_tokens) === "number") {
    fields.ctx = canonicalizeUsage(u)?.prompt_tokens;
  }
  if (latency?.ttft != null) fields.ttft = latency.ttft;
  return fields;
}

// Build the "done" summary: duration, ttft, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}

/**
 * One short, stable label for the reasoning a request actually ran with, so
 * usage can be grouped by it (#2483). Derived from the TRANSLATED body, which
 * is the one that went upstream: a provider-level thinking override injected in
 * chatCore is part of what was used, and the client's own body would not show
 * it.
 *
 * extractThinking already normalises every client shape (Claude thinking,
 * Ollama think, OpenAI reasoning_effort, the model-name suffix) into one
 * intent, so nothing here re-parses a format.
 */
export function summarizeReasoning(translatedBody) {
  const intent = extractThinking(translatedBody);
  if (!intent?.mode) return undefined;
  if (intent.mode === "none") return "off";
  if (intent.mode === "auto") return "auto";
  if (intent.mode === "level") return intent.level || undefined;
  if (intent.mode === "budget") {
    // Bucketed by thousands, because a per-token budget would make every
    // request its own group and answer nothing.
    return intent.budget >= 1000 ? `${Math.round(intent.budget / 1000)}k` : `${intent.budget}`;
  }
  return undefined;
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, requestedModel, translatedBody, label = "USAGE", silent = false, rid, contextTelemetry, usageFinality = "final", preSaverSerialized, sid }) {
  if (!tokens || typeof tokens !== "object") {
    if (contextTelemetry?.budgetReservationId) return saveRequestUsage({ provider, model, tokens: null, apiKey, contextTelemetry, usageFinality });
    return;
  }

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  if (inTokens === 0 && outTokens === 0 && priceUsage(tokens, null).costEvidence === null && !contextTelemetry?.budgetReservationId) return;

  if (!silent) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
  }

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = canonicalizeUsage(tokens, { conn: connectionId ? String(connectionId).slice(0, 8) : undefined, model }) || {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };

  // Counterfactual dollar ledger: one row per completed request, computed from
  // the pre-saver serialized body (baseline) and this provider-reported usage
  // (actual). Fire-and-forget: the repo is best-effort, and a ledger failure
  // must never block or alter the response. Estimated usage is not actual and
  // is skipped inside the repo, along with unknown-model rate cards.
  // This UUID belongs to this completion, independently of client-supplied rid
  // prefixes or retries. A failed ledger write cannot bind an older rid row.
  const completionId = usageFinality === "final" ? randomUUID() : null;
  if (completionId && typeof preSaverSerialized === "string" && preSaverSerialized) {
    void recordCostLedgerForRequest({
      rid: rid || contextTelemetry?.requestId,
      completionId,
      sid,
      provider,
      model,
      preSaverSerialized,
      usage: tokens,
    }).catch(() => {});
  }

  return saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    usagePresence: usageQuantityPresence(tokens),
    contextTelemetry,
    usageFinality,
    completionId,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    requestedModel: requestedModel || undefined,
    reasoningEffort: summarizeReasoning(translatedBody),
    rid: rid || undefined,
  }).catch(() => {});
}
