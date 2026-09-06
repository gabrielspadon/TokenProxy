import { refuseUncoveredBudget } from "../services/budgetDispatch.js";
import {
  isValidApiKey,
  getProviderCredentials,
  markAccountUnavailable,
} from "../services/auth.js";
// Lease release lives in its own module, not in auth.js: a handler test that
// partially mocks account SELECTION must still run the real release path.
import { releaseAccountLease } from "../services/accountLeaseRegistry.js";
import { resolveClientApiKey } from "@/lib/auth/clientApiKey";
import { getSettings } from "@/lib/localDb";
import { isInternalModelTestAuthorized } from "@/lib/auth/internalCliToken";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { withReplaySafety } from "open-sse/utils/replaySafety.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";
import { refuseDisallowedModel } from "@/sse/services/modelAccess.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  const settings = await getSettings();
  const resolvedApiKey = await resolveClientApiKey(request, isValidApiKey);
  if (resolvedApiKey.refusal) return resolvedApiKey.refusal;
  const presentedApiKey = resolvedApiKey.apiKey;
  const apiKey = resolvedApiKey.valid ? presentedApiKey : null;
  const budgetRefusal = await refuseUncoveredBudget(apiKey);
  if (budgetRefusal) return budgetRefusal;
  if (settings.requireApiKey) {
    const authorized = await isInternalModelTestAuthorized(request, apiKey, isValidApiKey);
    if (!authorized) return errorResponse(HTTP_STATUS.UNAUTHORIZED, presentedApiKey ? "Invalid API key" : "Missing API key");
    // Count the distinct clients on this key, so a leaked or shared key is
    // visible as more than a bigger bill (#930). Only a VALIDATED key is
    // recorded: counting unchecked strings would let anyone grow the map.
    recordApiKeyDevice(apiKey, request);
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");

  // The key's model allowlist (#1154) was only ever enforced in rerank, so
  // every other modality could reach a barred model with the same key
  // (#448, #2833).
  const barred = await refuseDisallowedModel(apiKey, modelStr, log);
  if (barred) return barred;

  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  // Combo expansion: model may be a combo name -> run fallback/round-robin across
  // members, as every other modality handler already does. Speech-to-text was the
  // one that never got it, so a combo name here was parsed as a literal
  // "provider/model" and rejected (#3600).
  // autoSwitch is off: capability and context-fit reordering read a chat-shaped
  // body, and this request carries multipart audio with nothing to classify.
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("STT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body: formData,
      models: comboModels,
      handleSingleModel: (_body, m) => handleSingleModelStt(formData, m),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      autoSwitch: false,
    });
  }

  return handleSingleModelStt(formData, modelStr);
}

async function handleSingleModelStt(formData, modelStr) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({ provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig });
    if (result.success) return result.response;
    return withReplaySafety(result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed"), result.failureMetadata?.safeToReplay);
  }

  // Credentialed — fallback loop
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

      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const msg = credentials.lastError || "Unavailable";
          const status = credentials.clientErrorStatus ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
          return withReplaySafety(unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman), credentials.mustWait !== true, 0, true);
        }
        if (excludeConnectionIds.size === 0) return withReplaySafety(errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`), true);
        return withReplaySafety(errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable"), true);
      }

      log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

      const result = await handleSttCore({ provider, model, formData, credentials, sttConfig: AI_PROVIDERS[provider]?.sttConfig });

      if (result.success) return result.response;

      if (result.failureMetadata?.safeToReplay !== true) return withReplaySafety(result.response || errorResponse(result.status, result.error));
      const { shouldFallback, mustWait, cooldownMs } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs, result.failureMetadata);
      if (mustWait) return withReplaySafety(result.response || errorResponse(result.status, result.error), false, cooldownMs, true);
      if (shouldFallback) {
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }
      return withReplaySafety(result.response || errorResponse(result.status, result.error), true);
    } finally {
      releaseAccountLease(accountLease);
    }
  }
}
