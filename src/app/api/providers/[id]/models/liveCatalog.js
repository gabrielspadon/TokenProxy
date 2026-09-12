// Authenticated provider catalogs shared by the dashboard's provider-detail
// route and the client-facing /v1/models listing (#2654).
//
// Before this module the OpenAI and Codex catalog fetches lived inline in the
// provider-detail route, so /v1/models could only ever serve the static
// registry for those two providers: a connection that gained or lost a model
// between releases showed one truth on the provider page and another to every
// downstream client.
//
// Fail-open is the contract. Every entry point returns null (or the dashboard
// resolver's empty models array) on timeout, auth failure, malformed body or an
// empty catalog, so the caller keeps the static registry and a catalog refresh
// can never become an inference outage.

import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { withCodexReviewModels } from "open-sse/providers/models/helpers.js";
import { refreshCodexToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";

// The /codex/models endpoint gates each entry by minimal_client_version against this
// value, and codex CLI's own manifest (openai/codex codex-rs/models-manager/models.json)
// already requires 0.144.0 for its newest models, so a stale client_version here comes
// back 200 with those entries quietly missing instead of erroring.
export const CODEX_CLIENT_VERSION = "0.144.6";
export const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// /v1/models is on the client hot path, so an upstream that accepts the socket
// and then stalls must not hold the whole listing open.
const CATALOG_TIMEOUT_MS = 8000;

export const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

const catalogSignal = (ownerSignal) => {
  const timeout = typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    : null;
  if (ownerSignal && timeout && typeof AbortSignal.any === "function") {
    return AbortSignal.any([ownerSignal, timeout]);
  }
  return ownerSignal || timeout || undefined;
};

const entryId = (entry) => entry?.id || entry?.slug || entry?.model || entry?.name || "";
const entryName = (entry, id) => entry?.display_name || entry?.displayName || entry?.name || id;
const declaredKind = (entry) => entry?.kind || entry?.type || null;

// Upstream capability metadata is echoed into the public /v1/models response,
// so only a plain object survives. Anything else is dropped and the caller
// falls back to the conservative capability floor it already computes.
function withValidatedCapabilities(entry) {
  const caps = entry.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) delete entry.capabilities;
  return entry;
}

// Static registry kind per model id — the hand-curated answer where one exists.
function staticKinds(providerId) {
  const map = new Map();
  for (const model of getModelsByProviderId(providerId)) {
    if (model?.id) map.set(model.id, declaredKind(model) || "llm");
  }
  return map;
}

// OpenAI's authenticated catalog is the whole account surface — embeddings,
// speech, moderation and completions-only legacy engines arrive in the same
// list as the chat models. Classify what we recognise so each id lands in its
// own /v1/models/{kind} bucket, and drop the rest rather than advertise a
// non-chat engine as a chat model.
const OPENAI_LIVE_KINDS = [
  [/embedding/, "embedding"],
  [/moderation/, "moderation"],
  [/whisper|transcribe/, "stt"],
  [/tts/, "tts"],
  [/dall-e|image/, "image"],
];
const OPENAI_CHAT_ID = /^(?:gpt-|o[1-9]|chatgpt-)/;
// Realtime and audio-preview speak their own protocols and `-instruct` is
// completions-only: all three answer /v1/chat/completions with an error.
const OPENAI_NOT_CHAT = /realtime|audio|instruct/;

function openAIKind(id, statics) {
  const known = statics.get(id);
  if (known) return known;
  const lower = id.toLowerCase();
  const matched = OPENAI_LIVE_KINDS.find(([re]) => re.test(lower));
  if (matched) return matched[1];
  if (OPENAI_CHAT_ID.test(lower) && !OPENAI_NOT_CHAT.test(lower)) return "llm";
  return null;
}

/**
 * Normalize an authenticated OpenAI catalog into listing entries.
 * Unrecognised families are dropped; everything else carries an explicit kind
 * so the caller never has to guess the kind from the id.
 */
export function normalizeOpenAICatalog(entries) {
  const statics = staticKinds("openai");
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const id = String(entryId(entry) || "").trim();
    if (!id || seen.has(id)) continue;
    const kind = openAIKind(id, statics);
    if (!kind) continue;
    seen.add(id);
    out.push(withValidatedCapabilities({ ...entry, id, name: entryName(entry, id), kind }));
  }
  return out;
}

/**
 * Normalize an authenticated Codex catalog and mint the deterministic
 * TokenProxy `-review` aliases.
 *
 * Kind resolution runs BEFORE the review expansion on purpose: the expansion
 * only twins llm models, and an upstream entry arriving without a `type` would
 * otherwise default to llm and mint a `gpt-5.x-image-review` that no registry
 * declares and no upstream accepts.
 */
export function normalizeCodexCatalog(entries) {
  const statics = staticKinds("codex");
  const seen = new Set();
  const normalized = [];
  for (const entry of entries || []) {
    const id = String(entryId(entry) || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(withValidatedCapabilities({
      ...entry,
      id,
      name: entryName(entry, id),
      kind: statics.get(id) || declaredKind(entry) || (/image/i.test(id) ? "image" : "llm"),
    }));
  }
  return withCodexReviewModels(normalized);
}

export const parseCodexModels = (data) => normalizeCodexCatalog(parseOpenAIStyleModels(data));

// Generic custom resolver for OAuth providers that need refresh-on-401 + token persist.
// Receives a `fetchFn(token)` and returns parsed models or throws.
export const buildOAuthResolver = ({ refreshFn, fetchFn, parseFn, errorLabel }) => async (connection, { signal } = {}) => {
  const { accessToken, refreshToken } = connection;
  if (!accessToken) {
    return { error: "No valid token found", status: 401 };
  }
  let warning;
  try {
    let response = await fetchFn(accessToken, connection, signal);
    if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
      const refreshed = await refreshFn(connection);
      if (
        refreshed?.accessToken
        && refreshed.error !== "unrecoverable_refresh_error"
        && refreshed.error !== "invalid_grant"
        && refreshed.reauthRequired !== true
      ) {
        const authoritative = await updateProviderCredentials(
          connection.id,
          {
            ...refreshed,
            refreshToken: refreshed.refreshToken || refreshToken,
            existingProviderSpecificData: connection.providerSpecificData,
          },
          { expectedCredentials: connection },
        );
        if (!authoritative?.accessToken) {
          throw Object.assign(new Error("Credential publication was not acknowledged"), {
            code: "CREDENTIAL_PERSISTENCE_UNCONFIRMED",
          });
        }
        // The catalog publisher hashes this object after the resolver returns.
        // Install the full durable revision only after acknowledgement so its
        // credentialRevisionId and provider evidence match that comparison.
        Object.assign(connection, authoritative);
        response = await fetchFn(authoritative.accessToken, connection, signal);
      }
    }
    if (response.ok) {
      const data = await response.json();
      const models = parseFn(data);
      if (models.length > 0) return { models };
    } else {
      warning = `${errorLabel}: HTTP ${response.status}`;
      console.log(`${errorLabel} (falling back to static): HTTP ${response.status}`);
    }
  } catch {
    warning = `${errorLabel}: unavailable`;
    console.log(`${errorLabel} (falling back to static): unavailable`);
  }
  return { models: [], warning };
};

export const codexModelsResolver = buildOAuthResolver({
  refreshFn: (conn) => refreshCodexToken(conn.refreshToken),
  fetchFn: (token, _connection, signal) => fetch(CODEX_MODELS_URL, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
      "originator": "codex_cli_rs"
    },
    signal: catalogSignal(signal)
  }),
  parseFn: parseCodexModels,
  errorLabel: "Failed to fetch Codex models"
});

/**
 * Authenticated OpenAI catalog for one connection.
 * @returns {Promise<Array<object>|null>} normalized entries, or null to keep static.
 */
export async function fetchOpenAICatalog(connection, { signal } = {}) {
  const token = connection?.apiKey || connection?.accessToken;
  if (!token) return null;
  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      method: "GET",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      signal: catalogSignal(signal)
    });
    if (!response.ok) {
      console.log(`Failed to fetch OpenAI models (falling back to static): ${response.status}`);
      return null;
    }
    const models = normalizeOpenAICatalog(parseOpenAIStyleModels(await response.json()));
    return models.length ? models : null;
  } catch {
    console.log("Failed to fetch OpenAI models (falling back to static) class=request-failed");
    return null;
  }
}

/**
 * A live catalog is authoritative for the models it actually enumerates. Media
 * kinds a provider serves through separate endpoints (images, speech,
 * embeddings) are frequently absent from it, and letting an llm-only response
 * replace the whole static list would empty /v1/models/image and its siblings.
 * Keep the static non-llm entries the live list did not mention.
 */
export function withStaticMediaModels(providerId, live) {
  const seen = new Set((live || []).map((m) => m?.id));
  const extras = getModelsByProviderId(providerId)
    .filter((m) => m?.id && !seen.has(m.id) && (declaredKind(m) || "llm") !== "llm")
    .map((m) => ({ id: m.id, name: m.name || m.id, kind: declaredKind(m) }));
  return extras.length ? [...live, ...extras] : live;
}

/**
 * /v1/models resolver for an authenticated OpenAI API-key connection.
 */
export async function resolveLiveOpenAIModels(connection, { signal } = {}) {
  const models = await fetchOpenAICatalog(connection, { signal });
  return models ? { models: withStaticMediaModels("openai", models) } : null;
}

/**
 * /v1/models resolver for an authenticated Codex OAuth connection.
 */
export async function resolveLiveCodexModels(connection, { signal } = {}) {
  const result = await codexModelsResolver(connection, { signal });
  if (!result?.models?.length) return null;
  return { models: withStaticMediaModels("codex", result.models) };
}
