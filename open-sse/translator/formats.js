// Format identifiers
export const FORMATS = {
  OPENAI: "openai",
  OPENAI_RESPONSES: "openai-responses",
  CLAUDE: "claude",
  GEMINI: "gemini",
  GEMINI_CLI: "gemini-cli",
  VERTEX: "vertex",
  ANTIGRAVITY: "antigravity",
  KIRO: "kiro",
  CURSOR: "cursor",
  OLLAMA: "ollama",
  COMMANDCODE: "commandcode"
};

// These specialized executors own both sides of their private wire protocol.
// The translator sees OpenAI-shaped data at the executor boundary, so route
// completeness must validate the client-to-OpenAI leg without requiring a
// fictitious translator for the private protocol name.
export const EXECUTOR_MANAGED_FORMATS = Object.freeze({
  "grok-web": Object.freeze({ requestFormat: FORMATS.OPENAI, responseFormat: FORMATS.OPENAI }),
  "perplexity-web": Object.freeze({ requestFormat: FORMATS.OPENAI, responseFormat: FORMATS.OPENAI }),
});

/**
 * Detect source format from request URL pathname + body.
 * Returns null to fall back to body-based detection.
 */
export function detectFormatByEndpoint(pathname, body) {
  // /v1/responses is always openai-responses
  if (pathname.includes("/v1/responses")) return FORMATS.OPENAI_RESPONSES;

  // /v1/messages is always Claude
  if (pathname.includes("/v1/messages")) return FORMATS.CLAUDE;

  // /v1/chat/completions + input[] → treat as openai (Cursor CLI sends Responses body via chat endpoint)
  if (pathname.includes("/v1/chat/completions") && Array.isArray(body?.input)) {
    return FORMATS.OPENAI;
  }

  return null;
}
