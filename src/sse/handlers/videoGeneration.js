import { withReplaySafety } from "open-sse/utils/replaySafety.js";
import { refuseUncoveredBudget } from "../services/budgetDispatch.js";
import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  isValidApiKey,
} from "../services/auth.js";
// Lease release lives in its own module, not in auth.js: a handler test that
// partially mocks account SELECTION must still run the real release path.
import { releaseAccountLease } from "../services/accountLeaseRegistry.js";
import { resolveClientApiKey } from "@/lib/auth/clientApiKey";
import { getSettings, getProviderConnectionById } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleVideoProxyCore, getVideoConfig, sanitizeSecrets } from "open-sse/handlers/videoCore.js";
import { findVideoAdapterForRequestId, getVideoAdapter } from "open-sse/handlers/videoProviders/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import * as log from "../utils/logger.js";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";
import { refuseDisallowedModel } from "@/sse/services/modelAccess.js";

// Video generation is xAI-only today; requests without a provider prefix
// (bare model id, or multipart bodies we deliberately don't parse) land here.
const DEFAULT_VIDEO_PROVIDER = "xai";
const VIDEO_CONNECTION_HEADER = "x-tokenproxy-connection-id";
const LEGACY_VIDEO_CONNECTION_HEADER = "x-connection-id";

// Creation POSTs are billable jobs — only rotate to another account for
// errors that upstream rejects BEFORE creating a job (auth/quota). A 5xx may
// have created the job, so it is returned to the caller instead of re-sent.
const CREATE_ROTATION_STATUSES = new Set([
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.RATE_LIMITED,
]);

// Returns { error } to refuse, or { apiKey } with the validated key so the
// caller can apply that key's model allowlist once it knows the model.
async function requireValidApiKey(request) {
  const resolvedApiKey = await resolveClientApiKey(request, isValidApiKey);
  if (resolvedApiKey.refusal) return { error: resolvedApiKey.refusal };
  const presentedApiKey = resolvedApiKey.apiKey;
  const apiKey = resolvedApiKey.valid ? presentedApiKey : null;
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!presentedApiKey) return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") };
    if (!apiKey) return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key") };
    // Count the distinct clients on this key, so a leaked or shared key is
    // visible as more than a bigger bill (#930). Only a VALIDATED key is
    // recorded: counting unchecked strings would let anyone grow the map.
    recordApiKeyDevice(apiKey, request);
  }
  return { apiKey };
}

/**
 * Read the request body once, byte-preserving.
 * JSON bodies are additionally parsed so the `model` provider prefix can be
 * resolved (and stripped) — everything else is forwarded exactly as received.
 */
async function readForwardableBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const raw = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
    }
    return { raw, parsed, contentType };
  }
  // Multipart (or any other content type): forward the exact bytes — parsing
  // and re-encoding FormData would change the multipart boundary.
  const buf = Buffer.from(await request.arrayBuffer());
  return { raw: buf, parsed: null, contentType };
}

async function resolveVideoProvider(parsedBody) {
  if (!parsedBody?.model) return { provider: DEFAULT_VIDEO_PROVIDER, model: null };

  const modelStr = String(parsedBody.model);
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Combos are not supported for video generation") };
  }
  if (!getVideoConfig(modelInfo.provider)) {
    // Bare model ids (no explicit "provider/" prefix) fall back to the default
    // video provider — the prefix-less inference targets chat providers only.
    if (!modelStr.includes("/")) {
      return { provider: DEFAULT_VIDEO_PROVIDER, model: modelStr };
    }
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${modelInfo.provider}' does not support video generation`) };
  }
  return { provider: modelInfo.provider, model: modelInfo.model };
}

function withConnectionHeader(response, connectionId) {
  if (!connectionId) return response;
  const headers = new Headers(response.headers);
  // Video jobs are account-bound upstream. The returned header is accepted on
  // later polls directly; `x-connection-id` remains a compatibility alias.
  headers.set(VIDEO_CONNECTION_HEADER, String(connectionId));
  const exposed = headers.get("access-control-expose-headers");
  if (!exposed?.split(",").some((name) => name.trim().toLowerCase() === VIDEO_CONNECTION_HEADER)) {
    headers.set("Access-Control-Expose-Headers", exposed ? `${exposed}, ${VIDEO_CONNECTION_HEADER}` : VIDEO_CONNECTION_HEADER);
  }
  return new Response(response.body, { status: response.status, headers });
}

function getPreferredVideoConnectionId(request) {
  return request.headers.get(VIDEO_CONNECTION_HEADER)
    || request.headers.get(LEGACY_VIDEO_CONNECTION_HEADER)
    || null;
}

function providerOwnsVideoRequest(provider, requestId) {
  const config = getVideoConfig(provider);
  const configuredAdapter = config?.adapter ? getVideoAdapter(config.adapter) : null;
  const requestAdapter = findVideoAdapterForRequestId(requestId);
  return configuredAdapter ? requestAdapter === configuredAdapter : !requestAdapter;
}

/**
 * POST /v1/videos/{generations|edits|extensions} — async job creation proxy.
 */
export async function handleVideoCreate(request, action) {
  const auth = await requireValidApiKey(request);
  if (auth.error) return auth.error;
  const budgetRefusal = await refuseUncoveredBudget(auth.apiKey);
  if (budgetRefusal) return budgetRefusal;

  const bodyInfo = await readForwardableBody(request);
  if (bodyInfo.error) return bodyInfo.error;

  // The key's model allowlist (#1154) was only ever enforced in rerank, so
  // every other modality could reach a barred model with the same key
  // (#448, #2833). Checked before any upstream job is created.
  if (bodyInfo.parsed?.model) {
    const barred = await refuseDisallowedModel(auth.apiKey, String(bodyInfo.parsed.model), log);
    if (barred) return barred;
  }

  const resolved = await resolveVideoProvider(bodyInfo.parsed);
  if (resolved.error) return resolved.error;
  const { provider, model } = resolved;

  // Strip the provider prefix (e.g. "xai/grok-imagine-video") before forwarding;
  // otherwise forward the original bytes untouched.
  let forwardBody = bodyInfo.raw;
  if (bodyInfo.parsed && model && bodyInfo.parsed.model !== model) {
    forwardBody = JSON.stringify({ ...bodyInfo.parsed, model });
  }

  const preferredConnectionId = getPreferredVideoConnectionId(request);
  const idempotencyKey = request.headers.get("idempotency-key") || null;

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    // The admission slot this selection reserved (auth.js). Released on EVERY
    // exit of this attempt - the unavailable returns, the success return, each
    // rotation `continue`, and any throw from the core - because `finally` is
    // what makes that exhaustive rather than a list that goes stale. Release is
    // idempotent (accountLease.js), so a double release frees nothing. This
    // core buffers its whole response before returning, so unlike the chat
    // stream there is no body still reading after the return.
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });
    const accountLease = credentials?.accountLease || null;
    try {

      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const errorMsg = credentials.lastError || "Unavailable";
          const status = credentials.clientErrorStatus ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
          return withReplaySafety(unavailableResponse(status, `[${provider}/${model || "video"}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman), credentials.mustWait !== true, 0, true);
        }
        if (excludeConnectionIds.size === 0) {
          return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
        }
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
      }

      const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

      const result = await handleVideoProxyCore({
        provider,
        action,
        rawBody: forwardBody,
        contentType: bodyInfo.contentType || null,
        idempotencyKey,
        credentials: refreshedCredentials,
        signal: request.signal,
        log,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            // Without the existing map the merge at tokenRefresh.js:178 has
            // nothing to merge onto, so a refresh REPLACES the stored data and
            // drops the connection proxy fields auth.js inflates onto
            // credentials, silently unpinning the account from its pool (#884).
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active",
          });
        },
      });

      if (result.success) {
        await clearAccountError(credentials.connectionId, credentials, model);
        log.info("VIDEO", `${provider.toUpperCase()} | ${action} accepted (connection ${credentials.connectionId})`);
        return withConnectionHeader(result.response, credentials.connectionId);
      }

      // Record the failure (dashboard shows lastError/errorCode → user sees re-auth is needed)
      if (result.failureMetadata?.safeToReplay !== true) return withReplaySafety(result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error));
      const { shouldFallback, mustWait, cooldownMs } = await markAccountUnavailable(
        credentials.connectionId, result.status, sanitizeSecrets(result.error, refreshedCredentials), provider, model, result.resetsAtMs, result.failureMetadata
      );
      if (mustWait) return withReplaySafety(result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error), false, cooldownMs, true);

      if (shouldFallback && CREATE_ROTATION_STATUSES.has(result.status)) {
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }

      return withReplaySafety(result.response, true);
    } finally {
      releaseAccountLease(accountLease);
    }
  }
}

/**
 * GET /v1/videos/{request_id} — poll job status.
 * Jobs are account-bound upstream, so no cross-account rotation here: the
 * caller pins the creating account via the returned connection header.
 */
export async function handleVideoGet(request, requestId) {
  const auth = await requireValidApiKey(request);
  if (auth.error) return auth.error;

  if (!requestId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing video request id");

  const preferredConnectionId = getPreferredVideoConnectionId(request);
  let provider = DEFAULT_VIDEO_PROVIDER;
  if (preferredConnectionId) {
    const pinnedConnection = await getProviderConnectionById(preferredConnectionId);
    if (pinnedConnection?.provider && getVideoConfig(pinnedConnection.provider)) {
      provider = pinnedConnection.provider;
    }
  }
  if (!providerOwnsVideoRequest(provider, requestId)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Video request id does not belong to provider: ${provider}`);
  }

  const credentials = await getProviderCredentials(provider, null, null, {
    preferredConnectionId,
    strictPreferredConnection: Boolean(preferredConnectionId),
  });
  if (!credentials) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }
  if (credentials.allRateLimited) {
    const errorMsg = credentials.lastError || "Unavailable";
    const status = credentials.clientErrorStatus ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
    return unavailableResponse(
      status,
      `[${provider}/video] ${errorMsg}`,
      credentials.retryAfter,
      credentials.retryAfterHuman,
    );
  }

  // Poll path: one attempt, no rotation, so the whole remainder is the lease's
  // lifetime. try/finally rather than a release before each return, so a throw
  // from the core or from markAccountUnavailable cannot strand the slot.
  const accountLease = credentials?.accountLease || null;
  try {
  const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

  const result = await handleVideoProxyCore({
    provider,
    requestId,
    credentials: refreshedCredentials,
    signal: request.signal,
    log,
    onCredentialsRefreshed: async (newCreds) => {
      await updateProviderCredentials(credentials.connectionId, {
        ...newCreds,
        // Same as the create path above: without the existing map the
        // merge has no base and a refresh drops the connection proxy
        // fields, unpinning the account from its pool (#884).
        existingProviderSpecificData: credentials.providerSpecificData,
        testStatus: "active",
      });
    },
  });

  if (result.success) {
    await clearAccountError(credentials.connectionId, credentials, null);
    return withConnectionHeader(result.response, credentials.connectionId);
  }

  await markAccountUnavailable(
    credentials.connectionId, result.status, sanitizeSecrets(result.error, refreshedCredentials), provider, null
  );
  return result.response;
  } finally {
    releaseAccountLease(accountLease);
  }
}
