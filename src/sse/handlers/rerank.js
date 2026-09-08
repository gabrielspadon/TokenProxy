import { throwIfRequestAborted } from '../../../open-sse/utils/requestLifetime.js';
import { withResourceAdmission } from '../services/resourceAdmission.js';
import { withReplaySafety } from "open-sse/utils/replaySafety.js";
import { getRequestIdentity } from "../services/requestIdentity.js";
import { createUsageAttemptTracker } from "../services/usageAttempt.js";
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
import { isModelAllowed } from "@/lib/db/repos/apiKeysRepo.js";
import { getComboModels } from "../services/model.js";
import { handleRerankCore } from "open-sse/handlers/rerankCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { resolveRequestModel } from '../services/requestModel.js';
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";

/**
 * Handle a rerank request for the SSE/Next.js server (#936). Same auth, combo
 * and account-fallback shape as handleEmbeddings — rerank is another provider
 * capability behind the one endpoint, not a new kind of routing.
 *
 * @param {Request} request
 */
export async function handleRerank(request) {
  return withResourceAdmission(request, () => handleRerankAdmitted(request));
}

async function handleRerankAdmitted(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("RERANK", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const identity = getRequestIdentity(request);
  const modelStr = body.model;

  log.request("POST", `${url.pathname} | ${modelStr}`);

  const resolvedApiKey = await resolveClientApiKey(request, isValidApiKey);
  if (resolvedApiKey.refusal) return resolvedApiKey.refusal;
  const presentedApiKey = resolvedApiKey.apiKey;
  const apiKey = resolvedApiKey.valid ? presentedApiKey : null;
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

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
    log.warn("RERANK", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // A key may carry a model allowlist (#1154). Checked after the key itself is
  // valid and before any upstream work, so a key restricted to cheap models
  // cannot spend the operator's quota on an expensive one.
  if (apiKey && !(await isModelAllowed(apiKey, modelStr))) {
    log.warn("AUTH", `Key not allowed to use model: ${modelStr}`);
    return errorResponse(HTTP_STATUS.FORBIDDEN, `Model not allowed for this API key: ${modelStr}`);
  }

  if (!body.query) {
    log.warn("RERANK", "Missing query");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }

  if (!body.documents) {
    log.warn("RERANK", "Missing documents");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: documents");
  }

  // Combo expansion, same signal handleEmbeddings keys off: getModelInfo answers
  // { provider: null } for a bare combo name, and the members then run one at a
  // time through the single-model path with the shared fallback strategy.
  const resolved = await resolveRequestModel(modelStr);
  if (resolved.error) return errorResponse(HTTP_STATUS.BAD_REQUEST, resolved.error);
  if (!resolved.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const comboStrategy = settings.comboStrategies?.[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("RERANK", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelRerank(b, m, apiKey, url.pathname, null, identity),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
      });
    }
  }

  return handleSingleModelRerank(body, modelStr, apiKey, url.pathname, resolved, identity);
}

async function handleSingleModelRerank(body, modelStr, apiKey, endpoint, resolved = null, identity = getRequestIdentity(null)) {
  const modelInfo = resolved || await resolveRequestModel(modelStr);
  if (modelInfo.error) return errorResponse(HTTP_STATUS.BAD_REQUEST, modelInfo.error);
  if (!modelInfo.provider) {
    log.warn("RERANK", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    throwIfRequestAborted();
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

      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const errorMsg = credentials.lastError || "Unavailable";
          const status = credentials.clientErrorStatus ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
          log.warn("RERANK", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
          return withReplaySafety(unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman), credentials.mustWait !== true, 0, true);
        }
        if (excludeConnectionIds.size === 0) {
          log.error("AUTH", `No credentials for provider: ${provider}`);
          return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
        }
        log.warn("RERANK", "No more accounts available", { provider });
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
      }

      log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

      const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

      const usageAttempt = createUsageAttemptTracker(identity, { provider, model, connectionId: credentials.connectionId, apiKey }, credentials);
      const result = await handleRerankCore({
        beforeDispatch: usageAttempt.beforeDispatch,
        afterDispatch: usageAttempt.afterDispatch,
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
      }).catch(async (error) => { await usageAttempt.finish({ success: false }); throw error; });
      await usageAttempt.finish(result);

      if (result.success) {
        if (result.usage) {
          await saveRequestUsage({
            contextTelemetry: usageAttempt.contextTelemetry,
            provider,
            model,
            connectionId: credentials.connectionId,
            apiKey,
            endpoint,
            tokens: result.usage,
            status: "success",
          }).catch(() => {});
        }
        return result.response;
      }

      if (result.failureMetadata?.safeToReplay !== true) return withReplaySafety(result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error));
      const { shouldFallback, mustWait, cooldownMs } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs, result.failureMetadata);
      if (mustWait) return withReplaySafety(result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error), false, cooldownMs, true);

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
