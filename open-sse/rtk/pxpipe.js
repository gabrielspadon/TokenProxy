import { stageErrorCode } from "../utils/stageOutcome.js";
// PXPIPE: render bulky Claude-format context as dense PNGs via pxpipe-proxy's
// library API (transformAnthropicMessages). Fail-open like every token saver:
// any error/timeout returns { body: null, summary } and leaves the request untouched.
import { FORMATS } from "../translator/formats.js";
import { isErrorResult } from "./errorFlags.js";
import { currentUserRequestMatches } from "./contentPolicy.js";
import { waitForPreparation } from "../utils/preparationAbort.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MIN_CHARS = 25000;
// pxpipe's own profitability gate assumes ~4 chars/token; reuse it for the
// estimated before/after numbers surfaced in stats (marked "estimated" in UI).
const EST_CHARS_PER_TOKEN = 4;

function bodyChars(body) {
  try {
    return JSON.stringify(body)?.length || 0;
  } catch {
    return 0;
  }
}

function estTokens(chars) {
  return Math.round(chars / EST_CHARS_PER_TOKEN);
}

function skipped(reason, extra = {}) {
  const failures = {
    timeout: "service_timeout", transform_error: "transform_exception", protected_fields_changed: "protected_content_changed",
    invalid_transform_shape: "invalid_response", tool_evidence_changed: "protected_content_changed", current_user_changed: "protected_content_changed",
    invalid_image_count: "invalid_response", invalid_transform_metrics: "invalid_response",
  };
  const errorCode = failures[reason];
  return { body: null, summary: { applied: false, reason, saver: "pxpipe", outcome: errorCode ? "failed" : "skipped", errorCode: errorCode || null, ...extra } };
}

function toolEvidence(messages) {
  const evidence = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (["tool_use", "thinking", "redacted_thinking"].includes(value.type)) { evidence.push(value); return; }
    if (value.type === "tool_result") {
      const { content, ...metadata } = value;
      evidence.push(isErrorResult(value) ? value : metadata);
      visit(content);
      return;
    }
    if (isErrorResult(value)) { evidence.push(value); return; }
    Object.values(value).forEach(visit);
  };
  visit(messages);
  return JSON.stringify(evidence);
}

function countImages(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + countImages(part), 0);
  if (value.type === "image") return 1;
  return Object.values(value).reduce((sum, part) => sum + countImages(part), 0);
}

// Transform a Claude-format request body through pxpipe. Returns
// { body: <new body object> | null, summary } — body is null when nothing changed.
// opts.transform is injected by the host (src side) so open-sse stays free of
// filesystem/install concerns and remains usable standalone.
export async function compressWithPxpipe(body, { enabled, allowLossy = false, format, model, minChars, timeoutMs, transform, signal } = {}) {
  signal?.throwIfAborted();
  if (!enabled) return skipped("disabled");
  if (!allowLossy) return skipped("lossy_opt_in_required");
  if (typeof transform !== "function") return skipped("not_installed");
  if (!body) return skipped("missing_body");
  if (format !== FORMATS.CLAUDE) return skipped("unsupported_format", { detail: format });

  const startedAt = Date.now();
  const originalChars = bodyChars(body);
  const threshold = Number(minChars) > 0 ? Number(minChars) : DEFAULT_MIN_CHARS;
  if (originalChars < threshold) {
    return skipped("below_threshold", { originalChars, threshold });
  }

  let timeout;
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(body));
    const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    timeout = setTimeout(() => controller.abort(new DOMException('PXPIPE deadline exceeded', 'TimeoutError')), budget);
    // The host's worker adapter terminates owned work on this signal. Custom
    // injected functions receive it too; late results never mutate the body.
    const result = await waitForPreparation(transform({
        body: encoded,
        model,
        options: { minCompressChars: threshold },
        signal: workSignal,
      }), workSignal);
    workSignal.throwIfAborted();
    if (!result) return skipped("timeout", { originalChars, durationMs: Date.now() - startedAt });
    if (!result.applied) {
      return skipped(result.reason || "passthrough", {
        detail: result.detail,
        originalChars,
        durationMs: Date.now() - startedAt,
      });
    }

    const transformed = JSON.parse(new TextDecoder().decode(result.body));
    if (Object.keys(transformed || {}).some((key) => key !== "messages" &&
        JSON.stringify(transformed[key]) !== JSON.stringify(body[key]))) {
      return skipped("protected_fields_changed", { originalChars });
    }
    const newBody = { ...body, messages: transformed?.messages };
    if (!Array.isArray(newBody?.messages) || newBody.messages.length !== body.messages?.length ||
        newBody.messages.some((message, i) => message?.role !== body.messages[i]?.role)) {
      return skipped("invalid_transform_shape", { originalChars });
    }
    if (toolEvidence(newBody.messages) !== toolEvidence(body.messages)) {
      return skipped("tool_evidence_changed", { originalChars });
    }
    if (!currentUserRequestMatches(body, newBody)) {
      return skipped("current_user_changed", { originalChars });
    }
    if (JSON.stringify(newBody.messages) === JSON.stringify(body.messages)) {
      return skipped("unchanged_transform", { originalChars });
    }
    const compressedBodyChars = bodyChars(newBody);
    const info = result.info || {};
    const imageCount = countImages(newBody.messages) - countImages(body.messages);
    if (imageCount <= 0 || (info.imageCount != null && info.imageCount !== imageCount)) {
      return skipped("invalid_image_count", { originalChars });
    }
    const imagedChars = info.compressedChars ?? 0;
    if (!Number.isFinite(imagedChars) || imagedChars < 0 || imagedChars > originalChars ||
        [info.imageTokens, info.imagePixels, info.baselineTokens, info.imageBytes].some((value) =>
          value != null && (!Number.isFinite(value) || value < 0))) {
      return skipped("invalid_transform_metrics", { originalChars });
    }
    // The transformed body is BIGGER in bytes (base64 PNGs) but cheaper in tokens:
    // images bill by pixels (Anthropic: pixels/750), not by encoded length. So the
    // after-estimate is remaining-text tokens + image tokens — never chars/4 of the
    // new body. Provider-billed usage recorded per request stays the ground truth.
    const imageTokensEst = info.imageTokens
      || (info.imagePixels ? Math.round(info.imagePixels / 750) : imageCount * 4761);
    const summary = {
      applied: true,
      reason: "applied",
      saver: "pxpipe",
      mode: "visual-lossy-opt-in",
      semanticPreserving: false,
      tokenMeasurement: "estimated",
      originalChars,
      compressedBodyChars,
      imagedChars,
      imageCount,
      imageBytes: info.imageBytes || 0,
      tokensBeforeEst: info.baselineTokens || estTokens(originalChars),
      tokensAfterEst: estTokens(Math.max(0, originalChars - imagedChars)) + imageTokensEst,
      durationMs: Date.now() - startedAt,
      cacheOwnsControl: result.cache?.ownsCacheControl === true,
    };
    summary.tokensSavedEst = Math.max(0, summary.tokensBeforeEst - summary.tokensAfterEst);
    if (!Number.isFinite(summary.tokensSavedEst) || summary.tokensSavedEst <= 0) {
      return skipped("no_estimated_saving", { originalChars, tokensBeforeEst: summary.tokensBeforeEst, tokensAfterEst: summary.tokensAfterEst });
    }
    summary.savedPct = summary.tokensBeforeEst > 0
      ? +((summary.tokensSavedEst / summary.tokensBeforeEst) * 100).toFixed(2)
      : 0;
    return { body: newBody, summary };
  } catch (e) {
    signal?.throwIfAborted();
    if (controller.signal.aborted) return skipped('timeout', { originalChars, durationMs: Date.now() - startedAt });
    return skipped("transform_error", { detail: stageErrorCode(e), errorCode: stageErrorCode(e), originalChars, durationMs: Date.now() - startedAt });
  } finally {
    clearTimeout(timeout);
  }
}

export function formatPxpipeLog(summary) {
  if (!summary) return null;
  if (!summary.applied) return null;
  return `imaged ${summary.imagedChars}ch → ${summary.imageCount} image(s) | est ${summary.tokensBeforeEst}→${summary.tokensAfterEst} tokens (-${summary.savedPct}%) | ${summary.durationMs}ms`;
}
