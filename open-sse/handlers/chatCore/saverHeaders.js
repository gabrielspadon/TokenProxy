// HEADERS finding: model-self-sizing response headers on every gateway-built
// response. Values come from the already-computed saver telemetry (saverMeta),
// so wiring them costs zero marginal serialization; each header is omitted
// when its value is not known. x-tp-rid is untouched.
//
// Lives in its own module (not sseToJsonHandler.js) because several suites
// mock the handlers module-by-module; a helper exported from a handler would
// vanish under those mocks and break the import.

export function saverTelemetryHeaders(meta = {}) {
  const h = {};
  if (Number.isFinite(meta.ctxTokens)) {
    h["x-tp-ctx-tokens"] = String(Math.round(meta.ctxTokens));
  }
  if (Number.isFinite(meta.saveBytes)) {
    h["x-tp-save-bytes"] = String(Math.round(meta.saveBytes));
  }
  if (Number.isFinite(meta.ce)) {
    h["x-tp-ce-bytes"] = String(Math.round(meta.ce));
  }
  if (meta.compactHint) h["x-tp-compact-hint"] = "1";
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (uuid.test(meta.requestId || "")) h["x-tokenproxy-request-id"] = meta.requestId;
  if (uuid.test(meta.logicalRequestId || "")) h["x-tokenproxy-logical-request-id"] = meta.logicalRequestId;
  if (h["x-tokenproxy-request-id"] || h["x-tokenproxy-logical-request-id"]) h["Access-Control-Expose-Headers"] = Object.keys(h).join(", ");
  return h;
}

// Merge the saver telemetry headers into an already-built error result's
// response. Fail-open: anything unusual about the response leaves it as-is.
export function withSaverHeaders(result, meta) {
  const extra = saverTelemetryHeaders(meta);
  if (!result?.response || !Object.keys(extra).length) return result;
  try {
    const headers = new Headers(result.response.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, k === "Access-Control-Expose-Headers" && headers.has(k) ? `${headers.get(k)}, ${v}` : v);
    return {
      ...result,
      response: new Response(result.response.body, {
        status: result.response.status,
        statusText: result.response.statusText,
        headers,
      }),
    };
  } catch {
    return result;
  }
}
