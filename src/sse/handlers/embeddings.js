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
import { getSettings } from "@/lib/localDb";
import { isInternalModelTestAuthorized } from "@/lib/auth/internalCliToken";
import { getComboModels } from "../services/model.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { withReplaySafety } from "open-sse/utils/replaySafety.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { resolveRequestModel } from '../services/requestModel.js';
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";
import { refuseDisallowedModel } from "@/sse/services/modelAccess.js";

function exactEmbeddingUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.estimated === true) return null;
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const totalTokens = raw.total_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens <= 0 || completionTokens !== 0 || totalTokens !== promptTokens) return null;
  return { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: totalTokens };
}

/**
 * Handle embeddings request for the SSE/Next.js server.
 * Follows the same auth + fallback pattern as handleChat.
 *
 * @param {Request} request
 */
export async function handleEmbeddings(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("EMBEDDINGS", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;

  log.request("POST", `${url.pathname} | ${modelStr}`);

  // Log API key (masked)
  const resolvedApiKey = await resolveClientApiKey(request, isValidApiKey);
  const presentedApiKey = resolvedApiKey.apiKey;
  const apiKey = resolvedApiKey.valid ? presentedApiKey : null;
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    const authorized = await isInternalModelTestAuthorized(request, apiKey, isValidApiKey);
    if (!authorized) {
      const message = presentedApiKey ? "Invalid API key" : "Missing API key";
      log.warn("AUTH", `${message} (requireApiKey=true)`);
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, message);
    }
    // Count the distinct clients on this key, so a leaked or shared key is
    // visible as more than a bigger bill (#930). Only a VALIDATED key is
    // recorded: counting unchecked strings would let anyone grow the map.
    recordApiKeyDevice(apiKey, request);
  }

  if (!modelStr) {
    log.warn("EMBEDDINGS", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // The key's model allowlist (#1154) was only ever enforced in rerank, so
  // every other modality could reach a barred model with the same key
  // (#448, #2833).
  const barred = await refuseDisallowedModel(apiKey, modelStr, log);
  if (barred) return barred;

  if (!body.input) {
    log.warn("EMBEDDINGS", "Missing input");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }

  // Combo expansion (#1379): getModelInfo answers { provider: null } for a bare
  // combo name, which is the same signal handleChat keys off. Members then run
  // one at a time through the single-model path below, with the shared
  // fallback/round-robin strategy on top.
  const resolved = await resolveRequestModel(modelStr);
  if (resolved.error) return errorResponse(HTTP_STATUS.BAD_REQUEST, resolved.error);
  if (!resolved.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const comboStrategy = settings.comboStrategies?.[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("EMBEDDINGS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelEmbeddings(b, m, apiKey, url.pathname),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
      });
    }
  }

  return handleSingleModelEmbeddings(body, modelStr, apiKey, url.pathname, resolved);
}

async function handleSingleModelEmbeddings(body, modelStr, apiKey, endpoint, resolved = null) {
  const modelInfo = resolved || await resolveRequestModel(modelStr);
  if (modelInfo.error) return errorResponse(HTTP_STATUS.BAD_REQUEST, modelInfo.error);
  if (!modelInfo.provider) {
    log.warn("EMBEDDINGS", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Credential + fallback loop (mirrors handleChat)
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
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    const accountLease = credentials?.accountLease || null;
    try {

      // All accounts unavailable
      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const errorMsg = credentials.lastError || "Unavailable";
          const status = credentials.clientErrorStatus ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
          log.warn("EMBEDDINGS", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
          return withReplaySafety(unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman), credentials.mustWait !== true, 0, true);
        }
        if (excludeConnectionIds.size === 0) {
          log.error("AUTH", `No credentials for provider: ${provider}`);
          return withReplaySafety(errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`), true);
        }
        log.warn("EMBEDDINGS", "No more accounts available", { provider });
        return withReplaySafety(errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable"), true);
      }

      log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

      const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

      const result = await handleEmbeddingsCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model);
        }
      });

      if (result.success) {
        const usage = exactEmbeddingUsage(result.usage);
        if (usage) {
          saveRequestUsage({
            provider,
            model,
            connectionId: credentials.connectionId,
            apiKey,
            endpoint,
            tokens: usage,
            status: "success",
          }).catch(() => {});
        }
        return result.response;
      }

      if (result.failureMetadata?.safeToReplay !== true) return withReplaySafety(result.response);
      const { shouldFallback, mustWait, cooldownMs } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs, result.failureMetadata);
      if (mustWait) return withReplaySafety(result.response, false, cooldownMs, true);

      if (shouldFallback) {
        log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
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
