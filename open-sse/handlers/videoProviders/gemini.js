import { createErrorResult, extractRetryAfterDeadline } from "../../utils/error.js";
import { isReplaySafeRejection } from "../../utils/replaySafety.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";

/**
 * Google Veo, as a video provider (#3656).
 *
 * The transparent proxy in videoCore is xAI-shaped — POST {base}/{action},
 * GET {base}/{id}, Bearer auth, body forwarded byte-for-byte — and Veo matches
 * none of that. It takes an api-key header, a predictLongRunning verb on the
 * model itself, its own request body, and returns an OPERATION NAME rather than
 * an id, so the poll target is a path the caller cannot reconstruct from a base
 * URL and an id. That is why this is an adapter and not another videoConfig
 * base URL.
 *
 * The client contract is unchanged: a creation POST answers { request_id,
 * status }, a poll answers { request_id, status, video } — the same envelope
 * xAI already returns, so nothing downstream learns a second shape.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// The operation name Veo returns is "models/<model>/operations/<id>". Carrying
// it through the client's request_id is what makes a poll addressable without
// storing state here, and the prefix is what lets a poll be told from an xAI id.
const OPERATION_PREFIX = "veo:";

function authHeaders(credentials) {
  const key = credentials?.apiKey || credentials?.accessToken;
  return key ? { "x-goog-api-key": key, "Content-Type": "application/json" } : null;
}

/** OpenAI-ish video request → Veo's instances/parameters body. */
export function toVeoBody(body) {
  const prompt = body?.prompt ?? body?.input ?? "";
  const parameters = {};
  const aspect = body?.aspect_ratio || body?.aspectRatio;
  if (aspect) parameters.aspectRatio = aspect;
  else if (typeof body?.size === "string" && body.size.includes("x")) {
    const [w, h] = body.size.split("x").map(Number);
    if (w && h) parameters.aspectRatio = w >= h ? "16:9" : "9:16";
  }
  if (body?.duration_seconds || body?.durationSeconds) {
    parameters.durationSeconds = Number(body.duration_seconds ?? body.durationSeconds);
  }
  if (body?.negative_prompt) parameters.negativePrompt = body.negative_prompt;

  const instance = { prompt: String(prompt) };
  // An image-to-video request carries a still; Veo takes it on the instance.
  const image = body?.image || body?.image_url;
  if (typeof image === "string" && image) {
    instance.image = image.startsWith("data:")
      ? { bytesBase64Encoded: image.slice(image.indexOf(",") + 1), mimeType: image.slice(5, image.indexOf(";")) }
      : { gcsUri: image };
  }
  return { instances: [instance], ...(Object.keys(parameters).length ? { parameters } : {}) };
}

/**
 * Read a finished operation into the envelope the client already knows.
 * Veo nests the result differently across preview revisions, so every shape
 * seen in the documented response is read rather than one guessed path.
 */
export function readOperation(operation) {
  const name = operation?.name || "";
  const requestId = name ? `${OPERATION_PREFIX}${name}` : null;

  if (operation?.error) {
    return { request_id: requestId, status: "failed", error: operation.error.message || "generation failed" };
  }
  if (!operation?.done) {
    return { request_id: requestId, status: "pending" };
  }

  const response = operation.response || {};
  const generated =
    response.generateVideoResponse?.generatedSamples?.[0] ||
    response.generateVideoResponse?.generatedVideos?.[0] ||
    response.generatedSamples?.[0] ||
    response.generatedVideos?.[0] ||
    null;
  const url = generated?.video?.uri || generated?.video?.url || generated?.uri || null;

  if (!url) {
    // Done with nothing readable is a failure the caller must see, not a
    // "completed" job with no video in it.
    return { request_id: requestId, status: "failed", error: "operation completed without a video URI" };
  }
  return { request_id: requestId, status: "completed", video: { url } };
}

function json(payload, status = HTTP_STATUS.OK) {
  return {
    success: true,
    response: new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}

/** True when `requestId` addresses a Veo operation rather than an xAI job. */
export function ownsRequestId(requestId) {
  return typeof requestId === "string" && requestId.startsWith(OPERATION_PREFIX);
}

const geminiVideoAdapter = {
  ownsRequestId,

  async create({ model, body, credentials, signal }) {
    const headers = authHeaders(credentials);
    if (!headers) return createErrorResult(HTTP_STATUS.UNAUTHORIZED, "[gemini] video requires an API key");
    if (!model) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "[gemini] video requires a model");

    let upstream;
    try {
      upstream = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:predictLongRunning`, {
        method: "POST",
        headers,
        body: JSON.stringify(toVeoBody(body)),
        signal,
      });
    } catch (error) {
      // Never re-send a creation POST on a network error: the job may exist.
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `[gemini] video create failed: ${error.message}`);
    }

    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      return createErrorResult(upstream.status, `[gemini] ${(text || `HTTP ${upstream.status}`).slice(0, 2000)}`, extractRetryAfterDeadline(upstream),
        { safeToReplay: isReplaySafeRejection(upstream) });
    }
    let operation;
    try {
      operation = JSON.parse(text);
    } catch {
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "[gemini] video create returned no JSON");
    }
    if (!operation?.name) {
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "[gemini] video create returned no operation name");
    }
    return json({ request_id: `${OPERATION_PREFIX}${operation.name}`, status: "pending" });
  },

  async poll({ requestId, credentials, signal }) {
    const headers = authHeaders(credentials);
    if (!headers) return createErrorResult(HTTP_STATUS.UNAUTHORIZED, "[gemini] video requires an API key");

    const name = requestId.slice(OPERATION_PREFIX.length);
    let upstream;
    try {
      upstream = await fetch(`${API_BASE}/${name}`, { method: "GET", headers, signal });
    } catch (error) {
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `[gemini] video poll failed: ${error.message}`);
    }

    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      return createErrorResult(upstream.status, `[gemini] ${(text || `HTTP ${upstream.status}`).slice(0, 2000)}`);
    }
    try {
      return json(readOperation(JSON.parse(text)));
    } catch {
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "[gemini] video poll returned no JSON");
    }
  },
};

export default geminiVideoAdapter;
