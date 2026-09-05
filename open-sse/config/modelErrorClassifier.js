// An entitlement refusal is the same fact as an unknown model from the pool's
// point of view: this account cannot serve this model, another one can. Anthropic
// splits its lanes per account (an account may carry Sonnet and Opus but not
// Fable), and the refusal arrives as 403 permission_error rather than the 404
// not_found_error a typo produces. Both must reach the (account, model) lock so
// rotation moves to a capable account instead of benching the whole account for
// two minutes and retrying it forever.
//
// The message must name the model, or name an access refusal about a model.
// Without that guard a 403 from a revoked token or an empty balance would lock
// one model per request until every model on the account was locked for 24h.
const ACCESS_REFUSAL_RE = /\b(?:does not have access|do not have access|not have access|no access|not authoriz|not permitted|not allowed|unsupported model|model is not available|not available to)\b/i;

function isEntitlementRefusal({ requestedModel, status, payload, errorTypes }) {
  if (Number(status) !== 403) return false;
  const error = payload?.error;
  if (!errorTypes.includes(error?.type)) return false;
  const message = error?.message;
  if (typeof message !== "string") return false;
  return message.includes(requestedModel)
    || (/\bmodel\b/i.test(message) && ACCESS_REFUSAL_RE.test(message));
}

const UNKNOWN_MODEL_PREDICATES = {
  gemini: ({ requestedModel, status, payload }) => {
    const error = payload?.error;
    return Number(status) === 404
      && Number(error?.code) === 404
      && error?.status === "NOT_FOUND"
      && typeof error?.message === "string"
      && error.message.startsWith(`models/${requestedModel} is not found`);
  },
  // Anthropic: {"type":"error","error":{"type":"not_found_error","message":"model: <name>"}}
  claude: ({ requestedModel, status, payload }) => {
    const error = payload?.error;
    return (Number(status) === 404
      && error?.type === "not_found_error"
      && typeof error?.message === "string"
      && error.message.includes(requestedModel))
      || isEntitlementRefusal({ requestedModel, status, payload, errorTypes: ["permission_error"] });
  },
  // OpenAI/Codex: {"error":{"message":"The model `x` does not exist...","type":"invalid_request_error","code":"model_not_found","param":"model"}}
  codex: ({ requestedModel, status, payload }) => {
    const error = payload?.error;
    const verifiedCode = error?.code === "model_not_found";
    const verifiedParam = error?.param === "model" && error?.type === "invalid_request_error";
    return ((Number(status) === 404 || Number(status) === 400)
      && (verifiedCode || verifiedParam)
      && typeof error?.message === "string"
      && error.message.includes(requestedModel))
      || isEntitlementRefusal({
        requestedModel, status, payload,
        errorTypes: ["insufficient_quota", "permission_error", "invalid_request_error"],
      });
  },
};

/**
 * Project a client-visible status without changing the raw upstream result.
 * A 404 is accepted only from a provider-specific structured signature that
 * identifies the exact requested model.
 */
// API-key twins share the OAuth provider's error shape.
const PREDICATE_ALIASES = { anthropic: "claude", openai: "codex" };

export function projectClientModelStatus({ provider, requestedModel, status, payload }) {
  const predicate = UNKNOWN_MODEL_PREDICATES[PREDICATE_ALIASES[provider] || provider];
  const unknownModelVerified = Boolean(predicate?.({ requestedModel, status, payload }));
  return {
    clientErrorStatus: unknownModelVerified ? (Number(status) === 403 ? 403 : 404) : status,
    unknownModelVerified,
  };
}
