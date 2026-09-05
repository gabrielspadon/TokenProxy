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
    return Number(status) === 404
      && error?.type === "not_found_error"
      && typeof error?.message === "string"
      && error.message.includes(requestedModel);
  },
  // OpenAI/Codex: {"error":{"message":"The model `x` does not exist...","type":"invalid_request_error","code":"model_not_found","param":"model"}}
  codex: ({ requestedModel, status, payload }) => {
    const error = payload?.error;
    const verifiedCode = error?.code === "model_not_found";
    const verifiedParam = error?.param === "model" && error?.type === "invalid_request_error";
    return (Number(status) === 404 || Number(status) === 400)
      && (verifiedCode || verifiedParam)
      && typeof error?.message === "string"
      && error.message.includes(requestedModel);
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
    clientErrorStatus: unknownModelVerified ? 404 : status,
    unknownModelVerified,
  };
}
