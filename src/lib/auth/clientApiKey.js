function queryApiKey(request) {
  const searchParams = request?.nextUrl?.searchParams;
  if (searchParams?.get) return searchParams.get("key");
  try {
    return new URL(request?.url).searchParams.get("key");
  } catch {
    return null;
  }
}

/**
 * Return all API-key credentials supplied by a client in protocol precedence
 * order. This is pure on purpose: callers decide how and where to validate.
 */
export function collectClientApiKeyCandidates(request) {
  const candidates = [];
  const push = (value) => {
    if (typeof value === "string" && value && !candidates.includes(value)) candidates.push(value);
  };
  const authorization = request?.headers?.get?.("Authorization");
  if (authorization?.startsWith("Bearer ")) push(authorization.slice(7));
  push(request?.headers?.get?.("x-api-key"));
  push(request?.headers?.get?.("x-goog-api-key"));
  push(queryApiKey(request));
  return candidates;
}

/**
 * Validate every credential the client presents and retain only the first one
 * that the gateway recognizes. Callers must use a valid result for downstream
 * attribution and never log the raw candidates.
 */
const admissionResolutions = new WeakMap();
// Admission identity is immutable only for this Request and validator. Normal
// handler authorization always revalidates, including after a queue wait.
export async function resolveClientApiKey(request, validate, { admission = false } = {}) {
  if (!admission || !request || typeof request !== 'object') return resolveCurrentClientApiKey(request, validate);
  let byValidator = admissionResolutions.get(request);
  if (!byValidator) { byValidator = new WeakMap(); admissionResolutions.set(request, byValidator); }
  let result = byValidator.get(validate);
  if (!result) { result = resolveCurrentClientApiKey(request, validate); byValidator.set(validate, result); }
  return result;
}

async function resolveCurrentClientApiKey(request, validate) {
  const candidates = collectClientApiKeyCandidates(request);
  for (const apiKey of candidates) {
    if (await validate(apiKey)) return { apiKey, valid: true };
  }
  // A recognized key that exhausted its budget is still the presented
  // principal. Local-mode handlers must not turn it into anonymous traffic.
  if (candidates.length) {
    const { getExceededLimit } = await import("../db/repos/apiKeysRepo.js");
    for (const apiKey of candidates) {
      const dimension = await getExceededLimit(apiKey);
      if (dimension) return { apiKey, valid: false, refusal: Response.json({
        error: { code: "api_key_budget_exceeded", type: "budget_error", message: `API key ${dimension} budget is exhausted.` },
      }, { status: 402, headers: { "x-should-retry": "false", "x-tokenproxy-replay-safe": "false" } }) };
    }
  }
  return { apiKey: candidates[0] || null, valid: false };
}
