import { throwIfRequestAborted } from '../../../open-sse/utils/requestLifetime.js';
import { withResourceAdmission, withPublicProviderAdmission } from '../services/resourceAdmission.js';
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
import { getSettings, getCombos } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleFetchCore } from "open-sse/handlers/fetch/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";
import { refuseDisallowedModel } from "@/sse/services/modelAccess.js";

function buildFetchProxyOptions(credentials) {
  const data = credentials?.providerSpecificData;
  return {
    connectionProxyEnabled: data?.connectionProxyEnabled === true,
    connectionProxyUrl: data?.connectionProxyUrl || "",
    connectionNoProxy: data?.connectionNoProxy || "",
    vercelRelayUrl: data?.vercelRelayUrl || "",
    strictProxy: data?.strictProxy === true,
  };
}

/**
 * Handle web fetch (URL extraction) request for the SSE/Next.js server.
 * Provider IS the model. Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleFetch(request) {
  return withResourceAdmission(request, () => handleFetchAdmitted(request));
}

async function handleFetchAdmitted(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("FETCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const reqUrl = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webFetch)
  const providerInput = body.provider || body.model;
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;

  log.request("POST", `${reqUrl.pathname} | ${providerInput}`);

  // Log API key (masked)
  const resolvedApiKey = await resolveClientApiKey(request, isValidApiKey);
  if (resolvedApiKey.refusal) return resolvedApiKey.refusal;
  const presentedApiKey = resolvedApiKey.apiKey;
  const apiKey = resolvedApiKey.valid ? presentedApiKey : null;
  const budgetRefusal = await refuseUncoveredBudget(apiKey);
  if (budgetRefusal) return budgetRefusal;
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!presentedApiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    if (!apiKey) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
    // Count the distinct clients on this key, so a leaked or shared key is
    // visible as more than a bigger bill (#930). Only a VALIDATED key is
    // recorded: counting unchecked strings would let anyone grow the map.
    recordApiKeyDevice(apiKey, request);
  }

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("FETCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  // The key's model allowlist (#1154) was only ever enforced in rerank, so
  // every other modality could reach a barred target with the same key
  // (#448, #2833). Here the provider IS the model, so the allowlist is
  // checked against that same string.
  const barred = await refuseDisallowedModel(apiKey, providerInput, log);
  if (barred) return barred;

  if (!targetUrl || typeof targetUrl !== "string") {
    log.warn("FETCH", "Missing url");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: url");
  }

  // Validate URL format
  try {
    new URL(targetUrl);
  } catch {
    log.warn("FETCH", "Invalid URL", { url: targetUrl });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid URL format");
  }

  // SSRF guard: reject internal/private/metadata targets
  try {
    assertPublicUrl(targetUrl);
  } catch (err) {
    log.warn("FETCH", "Blocked URL", { url: targetUrl });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, err.message);
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("FETCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderFetch(b, m, request, apiKey, settings),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderFetch(body, providerInput, request, apiKey, settings);
}

async function handleSingleProviderFetch(body, providerInput, request, apiKey, settings) {
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("FETCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.fetchConfig;
  if (!providerConfig) {
    log.warn("FETCH", "Provider does not support web fetch", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web fetch`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // No-auth fetch path (kept for parity though no current fetch provider sets noAuth)
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await withPublicProviderAdmission(providerId, () => handleFetchCore({
      url: targetUrl,
      format,
      maxCharacters,
      provider: resolvedProvider.id,
      providerConfig,
      credentials: null,
      signal: request.signal,
      proxyOptions: buildFetchProxyOptions(null),
      log
    }));
    if (result.success) {
      return new Response(JSON.stringify(result.data), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    return withReplaySafety(errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed"), result.failureMetadata?.safeToReplay);
  }

  // Credential + fallback loop
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
    const credentials = await getProviderCredentials(providerId, excludeConnectionIds);
    const accountLease = credentials?.accountLease || null;
    try {

      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const errorMsg = credentials.lastError || "Unavailable";
          const status = credentials.clientErrorStatus ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
          log.warn("FETCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
          return withReplaySafety(unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman), credentials.mustWait !== true, 0, true);
        }
        if (excludeConnectionIds.size === 0) {
          log.error("AUTH", `No credentials for provider: ${providerId}`);
          return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
        }
        log.warn("FETCH", "No more accounts available", { provider: providerId });
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
      }

      log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

      const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

      const result = await handleFetchCore({
        url: targetUrl,
        format,
        maxCharacters,
        provider: resolvedProvider.id,
        providerConfig,
        credentials: refreshedCredentials,
        signal: request.signal,
        proxyOptions: buildFetchProxyOptions(refreshedCredentials),
        log,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            // Without the existing map, the merge at tokenRefresh.js:178 has
            // nothing to merge onto and the refreshed data REPLACES what was
            // stored, dropping the connection proxy fields auth.js inflates
            // onto credentials (connectionProxyPoolId and friends). A refresh
            // then silently unpins the account from its proxy pool (#884).
            // chat.js already passed this; these three did not.
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        }
      });

      if (result.success) {
        await clearAccountError(credentials.connectionId, credentials);
        return new Response(JSON.stringify(result.data), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      if (result.failureMetadata?.safeToReplay !== true) return withReplaySafety(result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error));
      const { shouldFallback, mustWait, cooldownMs } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, providerId, null, result.resetsAtMs, result.failureMetadata);
      if (mustWait) return withReplaySafety(result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error), false, cooldownMs, true);

      if (shouldFallback) {
        log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }

      return withReplaySafety(errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed"), result.failureMetadata?.safeToReplay);
    } finally {
      releaseAccountLease(accountLease);
    }
  }
}
