/**
 * Token Usage Tracking - Extract, normalize, estimate and log token usage
 */

import { FORMATS } from "../translator/formats.js";
import { decide } from "../../src/shared/observability/decide.js";

// Legacy per-chunk usage console line; off by default (superseded by "📊 done")
const DEBUG_USAGE = process.env.LOG_USAGE_VERBOSE === "1";

// ANSI color codes
export const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

const EXACT_COST_FIELDS = ["cost_usd", "cost_in_usd", "cost_in_usd_ticks"];

// Reasoning is reported inside completion/output tokens, never in addition to
// them. Reject invalid provider values and retain only the inclusive subset.
export function clampReasoningTokens(reasoningTokens, completionTokens) {
  const reasoning = typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
    ? Math.max(0, reasoningTokens)
    : 0;
  const completion = typeof completionTokens === "number" && Number.isFinite(completionTokens)
    ? Math.max(0, completionTokens)
    : 0;
  return Math.min(reasoning, completion);
}

/**
 * Copy finite, nonnegative provider totals used for internal cost accounting.
 * These fields are deliberately excluded from filterUsageForFormat so provider
 * pricing metadata never becomes part of a client-facing usage schema.
 */
export function copyNonnegativeExactCosts(source, target, { enumerable = true } = {}) {
  if (!source || typeof source !== "object" || !target || typeof target !== "object") return target;

  for (const field of EXACT_COST_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) continue;

    if (enumerable) {
      target[field] = numeric;
    } else {
      Object.defineProperty(target, field, {
        value: numeric,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  return target;
}

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}


export function filterUsageForFormat(usage, targetFormat) {
  if (!usage || typeof usage !== "object") return usage;

  // Helper to pick only defined fields from usage
  const pickFields = (fields) => {
    const filtered = {};
    for (const field of fields) {
      if (usage[field] !== undefined) {
        filtered[field] = usage[field];
      }
    }
    return filtered;
  };

  // Define allowed fields for each format
  const formatFields = {
    [FORMATS.CLAUDE]: [
      'input_tokens', 'output_tokens', 
      'cache_read_input_tokens', 'cache_creation_input_tokens',
      'estimated'
    ],
    [FORMATS.GEMINI]: [
      'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
      'cachedContentTokenCount', 'thoughtsTokenCount',
      'estimated'
    ],
    [FORMATS.OPENAI_RESPONSES]: [
      'input_tokens', 'output_tokens',
      'input_tokens_details', 'output_tokens_details',
      'estimated'
    ],
    // OpenAI format (default for OPENAI, CODEX, KIRO, etc.)
    default: [
      'prompt_tokens', 'completion_tokens', 'total_tokens',
      'cached_tokens', 'reasoning_tokens',
      'prompt_tokens_details', 'completion_tokens_details',
      'estimated'
    ]
  };

  // Get fields for target format
  let fields = formatFields[targetFormat];
  
  // Use same fields for similar formats
  if (targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.ANTIGRAVITY) {
    fields = formatFields[FORMATS.GEMINI];
  } else if (!fields) {
    fields = formatFields.default;
  }

  return pickFields(fields);
}

/**
 * Normalize usage object - ensure all values are valid numbers
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const normalized = {};
  const assignNumber = (key, value) => {
    if (value === undefined || value === null) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  };

  assignNumber("prompt_tokens", usage?.prompt_tokens);
  assignNumber("completion_tokens", usage?.completion_tokens);
  assignNumber("total_tokens", usage?.total_tokens);
  assignNumber("cache_read_input_tokens", usage?.cache_read_input_tokens);
  assignNumber("cache_creation_input_tokens", usage?.cache_creation_input_tokens);
  assignNumber("cached_tokens", usage?.cached_tokens);
  assignNumber("reasoning_tokens", usage?.reasoning_tokens);
  copyNonnegativeExactCosts(usage, normalized);

  // Preserve nested details objects for OpenAI format forwarding
  if (usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object") {
    normalized.prompt_tokens_details = usage.prompt_tokens_details;
  }
  if (usage?.completion_tokens_details && typeof usage.completion_tokens_details === "object") {
    normalized.completion_tokens_details = usage.completion_tokens_details;
  }

  if (Object.keys(normalized).length === 0) return null;
  return normalized;
}

// Provider spellings for the two cache quantities. Cache READ is input served
// from a warm cache; cache WRITE is input newly written INTO the cache. Both are
// resolved HERE and nowhere else: canonicalizeUsage is the single normalization
// point every persisted request, aggregate and cost computation reads through,
// so a reader that re-derives a cache field from a raw alias is normalizing
// twice and drifts the moment this table grows.
//
// Split by accounting convention, because that is what decides whether the cache
// counts fold into prompt_tokens:
//   INCLUSIVE — provider already counted the cache inside prompt/input tokens
//               (OpenAI, Gemini). Pass through.
//   EXCLUSIVE — provider reports cache BESIDE a prompt count that omits it
//               (Anthropic). Fold both cache quantities into prompt_tokens.
const CACHE_READ_INCLUSIVE_KEYS = ["cached_tokens"];
const CACHE_READ_EXCLUSIVE_KEYS = ["cache_read_input_tokens", "cache_read_tokens"];
// `cache_write_tokens` is the common spelling no reader handled, which silently
// zeroed every cache write on the providers that use it.
const CACHE_WRITE_KEYS = [
  "cache_creation_input_tokens",
  "cache_write_tokens",
  "cache_write_input_tokens",
  "cache_creation_tokens",
];
// Nested breakdowns carrying the same two quantities (Responses API, and
// buildUsage()'s own OpenAI-forwarding shape).
const CACHE_READ_NESTED = [
  ["input_tokens_details", "cached_tokens"],
  ["prompt_tokens_details", "cached_tokens"],
];
const CACHE_WRITE_NESTED = [
  ["prompt_tokens_details", "cache_creation_tokens"],
  ["input_tokens_details", "cache_creation_tokens"],
];

// First key that is actually present wins; absence is distinguished from zero so
// the fold discriminator below can tell "provider omitted this" from "provider
// reported none".
function firstPresent(usage, keys, nested) {
  for (const key of keys) {
    if (usage[key] !== undefined && usage[key] !== null) return usage[key];
  }
  for (const [outer, inner] of nested) {
    const value = usage[outer]?.[inner];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Resolve the canonical cache read and cache write counts from any provider
 * spelling, along with which accounting convention the input used.
 *
 * @param {object} usage
 * @returns {{read: number|undefined, write: number|undefined, inclusive: boolean}}
 */
export function resolveCacheTokens(usage) {
  const inclusiveRead = firstPresent(usage, CACHE_READ_INCLUSIVE_KEYS, CACHE_READ_NESTED);
  const exclusiveRead = firstPresent(usage, CACHE_READ_EXCLUSIVE_KEYS, []);
  const write = firstPresent(usage, CACHE_WRITE_KEYS, CACHE_WRITE_NESTED);
  return {
    read: inclusiveRead !== undefined ? inclusiveRead : exclusiveRead,
    write,
    // An inclusive read spelling is the marker that prompt_tokens already counts
    // the cache. It is also what canonicalizeUsage's own output always carries,
    // which is what makes re-running it idempotent.
    inclusive: inclusiveRead !== undefined,
  };
}

/**
 * Canonicalize usage into ONE storage/cost convention so token counts and cost
 * are consistent across providers:
 *   prompt_tokens               = total input INCLUDING cache read + cache creation
 *   cached_tokens               = cache-read portion (subset of prompt_tokens)
 *   cache_creation_input_tokens = cache-write portion (subset of prompt_tokens)
 *   completion_tokens, reasoning_tokens, total_tokens
 *
 * Discriminator: Claude reports cache_read_input_tokens with a prompt that
 * EXCLUDES cache, so we fold cache into prompt. OpenAI/Gemini report
 * cached_tokens already counted inside prompt, so we pass through. Idempotent:
 * once folded the output carries cached_tokens (not cache_read_input_tokens),
 * so re-running takes the passthrough branch and does not double-add.
 *
 * @param {object} usage - a normalizeUsage()-shaped object
 * @returns {object|null} canonical token object, or null for invalid input
 */
export function canonicalizeUsage(usage, ctx = null) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  // The `cache_write_tokens` spelling no reader handled once silently zeroed
  // every cache write (doc row 66): say so when it shows up.
  if (Object.prototype.hasOwnProperty.call(usage, "cache_write_tokens")) {
    decide("ACCT", "alias-dropped", {
      ...(ctx?.conn ? { conn: ctx.conn } : {}),
      ...(ctx?.model ? { model: String(ctx.model).slice(0, 60) } : {}),
      why: "cache_write_tokens",
    });
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  // Responses-API shapes nest the breakdowns: input_tokens_details.cached_tokens
  // and output_tokens_details.reasoning_tokens. Read them so converter output
  // reaching the usage DB keeps its cache/reasoning split.
  const reasoning = num(
    usage.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens,
  );
  // Every provider spelling of cache read and cache write resolves in ONE call.
  // See resolveCacheTokens: this is the only site that reads a raw cache alias.
  const cache = resolveCacheTokens(usage);
  const cacheCreation = num(cache.write);

  let prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  let cached = num(cache.read);

  // Exclusive path (Anthropic): prompt omits the cache, so both cache
  // quantities fold into it. A cache-miss "first write" reports only a write and
  // no read, so the fold triggers on either quantity being present — otherwise a
  // first-write request took the passthrough branch and its write was never
  // folded in. `cache.inclusive` is false only when no inclusive spelling was
  // present, and canonicalizeUsage's own output always sets `cached_tokens`
  // (even to 0), which is what makes re-running it idempotent rather than
  // folding a second time.
  if (!cache.inclusive && (cache.read !== undefined || cache.write !== undefined)) {
    prompt = prompt + cached + cacheCreation;
  }

  const result = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    // Recompute rather than pass through: when the fold branch ran above,
    // an upstream total_tokens (cache-exclusive) would otherwise be stale.
    total_tokens: prompt + completion,
    cached_tokens: cached,
    cache_creation_input_tokens: cacheCreation,
  };
  copyNonnegativeExactCosts(usage, result);
  if (reasoning > 0) result.reasoning_tokens = reasoning;
  return result;
}

/**
 * Convert Claude's cache-exclusive input accounting to OpenAI's convention,
 * where prompt_tokens includes cached and newly cached input tokens.
 */
export function claudeUsageToOpenAI(usage) {
  const canonical = canonicalizeUsage({
    prompt_tokens: usage?.input_tokens,
    completion_tokens: usage?.output_tokens,
    cache_read_input_tokens: usage?.cache_read_input_tokens,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens,
    reasoning_tokens: clampReasoningTokens(
      usage?.output_tokens_details?.thinking_tokens,
      usage?.output_tokens,
    ),
  });
  if (!canonical) return null;

  const result = {
    prompt_tokens: canonical.prompt_tokens,
    completion_tokens: canonical.completion_tokens,
    total_tokens: canonical.total_tokens,
  };
  if (canonical.cached_tokens > 0 || canonical.cache_creation_input_tokens > 0) {
    result.prompt_tokens_details = {};
    if (canonical.cached_tokens > 0) {
      result.prompt_tokens_details.cached_tokens = canonical.cached_tokens;
    }
    if (canonical.cache_creation_input_tokens > 0) {
      result.prompt_tokens_details.cache_creation_tokens = canonical.cache_creation_input_tokens;
    }
  }
  if (canonical.reasoning_tokens > 0) {
    result.completion_tokens_details = { reasoning_tokens: canonical.reasoning_tokens };
  }
  return result;
}

/**
 * Check if usage has valid token data
 * Valid = has at least one token field with value > 0
 * Invalid = empty object {}, null, undefined, no token fields, or all zeros
 */
export function hasValidUsage(usage) {
  if (!usage || typeof usage !== "object") return false;

  // Check for any known token field with value > 0
  const tokenFields = [
    "prompt_tokens", "completion_tokens", "total_tokens",  // OpenAI
    "input_tokens", "output_tokens",                        // Claude
    "promptTokenCount", "candidatesTokenCount"              // Gemini
  ];

  for (const field of tokenFields) {
    if (typeof usage[field] === "number" && usage[field] > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Extract usage from any format (Claude, OpenAI, Gemini, Responses API)
 */
export function extractUsage(chunk) {
  if (!chunk || typeof chunk !== "object") return null;

  // Claude format (message_start event): carries input_tokens + cache_read +
  // cache_creation. message_delta later carries only the final output_tokens,
  // so callers must MERGE (mergeUsage), not overwrite, to keep cache counts.
  if (chunk.type === "message_start" && chunk.message?.usage && typeof chunk.message.usage === "object") {
    const u = chunk.message.usage;
    return normalizeUsage({
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
      cost_usd: u.cost_usd,
      cost_in_usd: u.cost_in_usd,
      cost_in_usd_ticks: u.cost_in_usd_ticks,
    });
  }

  // Claude format (message_delta event)
  if (chunk.type === "message_delta" && chunk.usage && typeof chunk.usage === "object") {
    const completionTokens = chunk.usage.output_tokens || 0;
    return normalizeUsage({
      prompt_tokens: chunk.usage.input_tokens || 0,
      completion_tokens: completionTokens,
      cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
      cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens,
      reasoning_tokens: clampReasoningTokens(
        chunk.usage.output_tokens_details?.thinking_tokens,
        completionTokens,
      ),
      cost_usd: chunk.usage.cost_usd,
      cost_in_usd: chunk.usage.cost_in_usd,
      cost_in_usd_ticks: chunk.usage.cost_in_usd_ticks,
    });
  }

  // OpenAI Responses API format (response.completed or response.done)
  if ((chunk.type === "response.completed" || chunk.type === "response.done") && chunk.response?.usage && typeof chunk.response.usage === "object") {
    const usage = chunk.response.usage;
    const cachedTokens = usage.input_tokens_details?.cached_tokens;
    return normalizeUsage({
      prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cached_tokens: cachedTokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
      cost_usd: usage.cost_usd,
      cost_in_usd: usage.cost_in_usd,
      cost_in_usd_ticks: usage.cost_in_usd_ticks,
      prompt_tokens_details: cachedTokens ? { cached_tokens: cachedTokens } : undefined
    });
  }

  // OpenAI format (also covers DeepSeek which uses prompt_cache_hit_tokens)
  if (chunk.usage && typeof chunk.usage === "object" && chunk.usage.prompt_tokens !== undefined) {
    return normalizeUsage({
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens || 0,
      cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.prompt_cache_hit_tokens,
      reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
      cost_usd: chunk.usage.cost_usd,
      cost_in_usd: chunk.usage.cost_in_usd,
      cost_in_usd_ticks: chunk.usage.cost_in_usd_ticks,
      prompt_tokens_details: chunk.usage.prompt_tokens_details,
      completion_tokens_details: chunk.usage.completion_tokens_details
    });
  }

  // Gemini format (Antigravity)
  // Antigravity wraps usageMetadata inside response: { response: { usageMetadata: {...} } }
  const usageMeta = chunk.usageMetadata || chunk.response?.usageMetadata;
  if (usageMeta && typeof usageMeta === "object") {
    return normalizeUsage({
      prompt_tokens: usageMeta.promptTokenCount || 0,
      completion_tokens: usageMeta.candidatesTokenCount || 0,
      total_tokens: usageMeta.totalTokenCount,
      cached_tokens: usageMeta.cachedContentTokenCount,
      reasoning_tokens: usageMeta.thoughtsTokenCount
    });
  }

  // Ollama NDJSON format (raw from provider, before translation)
  // Ollama sends: {"model":"...","done":true,"prompt_eval_count":N,"eval_count":M}
  if (chunk.done === true && typeof chunk.prompt_eval_count === "number") {
    return normalizeUsage({
      prompt_tokens: chunk.prompt_eval_count || 0,
      completion_tokens: chunk.eval_count || 0,
      total_tokens: (chunk.prompt_eval_count || 0) + (chunk.eval_count || 0)
    });
  }

  return null;
}

// Field-wise max-merge of two usage objects. Anthropic splits usage across
// events: message_start has real input+cache (output is a placeholder 1),
// message_delta has the real cumulative output (input/cache absent). Max keeps
// the meaningful value from each without clobbering. Idempotent for other
// providers that emit a single complete usage object.
export function mergeUsage(prev, next) {
  if (!prev) return next || null;
  if (!next) return prev;
  const merged = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    // typeof NaN === "number" — guard with Number.isFinite so one malformed
    // chunk can't poison the whole accumulation (Math.max(x, NaN) is NaN).
    if (typeof v === "number" && Number.isFinite(v)) {
      merged[k] = Math.max(typeof merged[k] === "number" ? merged[k] : 0, v);
    } else if (v && typeof v === "object") {
      merged[k] = v; // nested details objects: take latest
    }
  }
  return merged;
}

/**
 * Estimate input tokens from request body
 * Calculate total body size for more accurate estimation
 */
export function estimateInputTokens(body) {
  if (!body || typeof body !== "object") return 0;

  try {
    // Calculate total body size (includes messages, tools, system, thinking config, etc.)
    const bodyStr = JSON.stringify(body);
    const totalChars = bodyStr.length;

    // Estimate: ~4 chars per token (rough average across all tokenizers)
    return Math.ceil(totalChars / 4);
  } catch (err) {
    // Fallback if stringify fails
    return 0;
  }
}


/**
 * Estimate output tokens from content length
 */
export function estimateOutputTokens(contentLength) {
  if (!contentLength || contentLength <= 0) return 0;
  return Math.max(1, Math.floor(contentLength / 4));
}

/**
 * Format usage object based on target format
 * @param {number} inputTokens - Input/prompt tokens
 * @param {number} outputTokens - Output/completion tokens
 * @param {string} targetFormat - Target format from FORMATS
 */
export function formatUsage(inputTokens, outputTokens, targetFormat) {
  // Claude format uses input_tokens/output_tokens
  if (targetFormat === FORMATS.CLAUDE) {
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated: true,
    };
  }

  // Default: OpenAI format (works for openai, gemini, responses, etc.)
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated: true,
  };
}

/**
 * Estimate full usage when provider doesn't return it
 * @param {object} body - Request body for input token estimation
 * @param {number} contentLength - Content length for output token estimation
 * @param {string} targetFormat - Target format from FORMATS constant
 */
export function estimateUsage(body, contentLength, targetFormat = FORMATS.OPENAI) {
  return formatUsage(
    estimateInputTokens(body),
    estimateOutputTokens(contentLength),
    targetFormat
  );
}

/**
 * Log usage with cache info (green color)
 */
/**
 * Resolve the usage a stream had produced by the time it stopped, falling back to
 * an estimate from the accumulated content when the provider never sent a usage
 * frame. A stream that dies early still consumed tokens, and a client that is
 * handed nothing keeps sizing its context from the last turn that reported.
 */
export function resolvePartialUsage(streamState, body, sourceFormat) {
  if (!streamState) return null;
  if (hasValidUsage(streamState.usage)) return streamState.usage;
  if (!streamState.content) return null;
  return estimateUsage(body, streamState.content.length, sourceFormat || FORMATS.OPENAI);
}

export function logUsage(provider, usage, model = null, connectionId = null, apiKey = null) {
  if (!usage || typeof usage !== "object") return;

  // Console output moved to the unified "📊 done" line (streamingHandler). Kept as
  // a no-op hook so callers stay unchanged; usage persistence happens via saveUsageStats.
  if (!DEBUG_USAGE) return;

  const p = provider?.toUpperCase() || "UNKNOWN";

  // Support both formats:
  // - OpenAI: prompt_tokens, completion_tokens
  // - Claude: input_tokens, output_tokens
  const inTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
  const outTokens = usage?.completion_tokens || usage?.output_tokens || 0;
  const accountPrefix = connectionId ? connectionId.slice(0, 8) + "..." : "unknown";

  let msg = `[${getTimeString()}] 📊 ${COLORS.green}[USAGE] ${p} | in=${inTokens} | out=${outTokens} | account=${accountPrefix}${COLORS.reset}`;

  // Add estimated flag if present
  if (usage.estimated) {
    msg += ` ${COLORS.yellow}(estimated)${COLORS.reset}`;
  }

  // Add cache info if present (unified from different formats)
  const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens;
  if (cacheRead) msg += ` | cache_read=${cacheRead}`;

  const cacheCreation = usage.cache_creation_input_tokens;
  if (cacheCreation) msg += ` | cache_create=${cacheCreation}`;

  const reasoning = usage.reasoning_tokens;
  if (reasoning) msg += ` | reasoning=${reasoning}`;

  console.log(msg);
}
