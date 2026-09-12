import { AI_PROVIDERS } from "../shared/constants/providers.js";
import { holdsCredential } from "../shared/utils/accountCredential.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}

// A connection leaving over the HTTP boundary must not carry the credential it
// was created with (#999). This used to be a `delete` list copied into each
// route, which missed two things: POST /api/providers dropped only `apiKey`, so
// it echoed the rest straight back, and none of the copies descended into
// providerSpecificData — where half the providers actually keep their secret
// (Copilot's token, Azure's clientSecret, Bedrock's key pair, opencode's
// managementKey, and the operator-supplied customHeaders that can carry a whole
// Authorization line, see open-sse/utils/clientHeaderPassthrough.js).
//
// It matters because /api/providers sits in dashboardGuard's
// PROTECTED_API_PATHS, which honour requireLogin=false — the same reason
// /api/settings/database is ALWAYS_PROTECTED instead. With login disabled those
// responses are readable without a session.
const SECRET_CONNECTION_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken"];
// ponytail: a denylist, not an allowlist, because the dashboard reads a couple
// of dozen benign providerSpecificData fields (region, profileArn, authMethod,
// proxy selection, plan type, custom models…) and an allowlist would break a
// page silently instead of leaking silently. A new secret-bearing field has to
// be added here; tests/unit/secret-storage-999.test.js pins the list.
const SECRET_PROVIDER_SPECIFIC_FIELDS = [
  "apiKey",
  "accessKeyId",
  "secretAccessKey",
  "clientSecret",
  "copilotToken",
  "managementKey",
  "customHeaders",
];

// Removing the credential also removes the ANSWER to "does this row have one",
// and the dashboard needs that answer: three legacy rows holding no token at
// all rendered as "Paused", which claims an operator decision nobody made. The
// boolean is derived here, at the one choke point that still holds the secret,
// so the board can name the state without the token ever leaving the server.
// Same predicate the gateway admits on, never a second rule.
export function redactConnectionSecrets(connection) {
  if (!connection || typeof connection !== "object") return connection;
  const safe = { ...connection, hasCredential: holdsCredential(connection) };
  for (const field of SECRET_CONNECTION_FIELDS) delete safe[field];
  const specific = safe.providerSpecificData;
  if (specific && typeof specific === "object" && !Array.isArray(specific)) {
    const cleaned = { ...specific };
    for (const field of SECRET_PROVIDER_SPECIFIC_FIELDS) delete cleaned[field];
    safe.providerSpecificData = cleaned;
  }
  return safe;
}
