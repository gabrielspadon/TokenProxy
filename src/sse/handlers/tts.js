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
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";
import { refuseDisallowedModel } from "@/sse/services/modelAccess.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || "mp3"; // mp3 (default) | json
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  const style = body.style || ""; // Optional style/voice instructions (e.g. Xiaomi MiMo)
  // Everything else the caller sent. Normalizing to one shape made the common
  // case easy and threw away every provider-specific control, so a vendor that
  // offers a reading speed or a delivery style had no way to reach it (#2036).
  // Collected here and merged by the adapter, which decides what its own API
  // accepts; the fields the router owns are applied after and cannot be
  // overridden from a request.
  const providerOptions = { ...body };
  for (const key of ["model", "input", "voice", "response_format", "language", "style", "stream"]) {
    delete providerOptions[key];
  }
  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  const resolvedApiKey = await resolveClientApiKey(request, isValidApiKey);
  if (resolvedApiKey.refusal) return resolvedApiKey.refusal;
  const presentedApiKey = resolvedApiKey.apiKey;
  const apiKey = resolvedApiKey.valid ? presentedApiKey : null;
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!presentedApiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
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

  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelTts(b, m, responseFormat, language, style, providerOptions),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, style, providerOptions);
}

async function handleSingleModelTts(body, modelStr, responseFormat, language, style, providerOptions = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language, style, providerOptions });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
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
          return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
        }
        if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
      }

      log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

      const result = await handleTtsCore({ provider, model, input: body.input, credentials, responseFormat, language, style, providerOptions });

      if (result.success) return result.response;

      const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
      if (shouldFallback) {
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }
      return result.response || errorResponse(result.status, result.error);
    } finally {
      releaseAccountLease(accountLease);
    }
  }
}
