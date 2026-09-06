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
import { handleSearchCore } from "open-sse/handlers/search/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";
import { refuseDisallowedModel } from "@/sse/services/modelAccess.js";

/**
 * Handle web search request for the SSE/Next.js server.
 * Provider IS the model (no model field). Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSearch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webSearch)
  const providerInput = body.provider || body.model;
  const query = body.query;

  log.request("POST", `${url.pathname} | ${providerInput}`);

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
    log.warn("SEARCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  // The key's model allowlist (#1154) was only ever enforced in rerank, so
  // every other modality could reach a barred target with the same key
  // (#448, #2833). Here the provider IS the model, so the allowlist is
  // checked against that same string.
  const barred = await refuseDisallowedModel(apiKey, providerInput, log);
  if (barred) return barred;

  if (!query || typeof query !== "string" || !query.trim()) {
    log.warn("SEARCH", "Missing query");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("SEARCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderSearch(b, m, request, apiKey, settings),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderSearch(body, providerInput, request, apiKey, settings);
}

async function handleSingleProviderSearch(body, providerInput, request, apiKey, settings) {
  const query = body.query;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("SEARCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.searchConfig;
  const supportsSearch = !!providerConfig || !!resolvedProvider.searchViaChat;

  if (!supportsSearch) {
    log.warn("SEARCH", "Provider does not support web search", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web search`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // Sanitized body forwarded to core
  const coreBody = {
    query: query.trim(),
    provider: providerId,
    max_results: body.max_results,
    search_type: body.search_type,
    country: body.country,
    language: body.language,
    time_range: body.time_range,
    offset: body.offset,
    domain_filter: body.domain_filter,
    content_options: body.content_options,
    provider_options: body.provider_options
  };

  // No-auth providers (e.g. searxng) bypass credential lookup
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: null,
      log
    });
    if (result.success) return result.response;
    return result.response;
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Credential fallback: some search providers reuse the API key of a related
  // chat provider (e.g. ollama-search reuses the `ollama` chat key). When the
  // search provider has no connection of its own, fall back to the linked
  // provider's credentials.
  const fallbackProviderId = resolvedProvider.credentialFallback;

  // Lock scope for this handler. Without it markAccountUnavailable would write
  // an account-wide `__all` lock, which on the credentialFallback path takes
  // the shared chat key (e.g. glm) offline for chat as well. Must be passed to
  // getProviderCredentials too, so the lock is read back under the same key.
  const searchLockKey = `websearch:${providerId}`;

  while (true) {
    // Provider that actually owns the connection in use — differs from
    // providerId once we fall back, and error locks must be attributed to it.
    let credentialProviderId = providerId;
    let credentials = await getProviderCredentials(providerId, excludeConnectionIds, searchLockKey);

    // Fall back to the related chat provider's credentials when this search
    // provider has none of its own (one key, chat + search).
    if (!credentials && fallbackProviderId) {
      credentials = await getProviderCredentials(fallbackProviderId, excludeConnectionIds, searchLockKey);
      if (credentials) {
        credentialProviderId = fallbackProviderId;
        log.info("AUTH", `\x1b[32m${providerId} reusing ${fallbackProviderId} credentials\x1b[0m`);
      }
    }

    // Only ONE of the two calls above can have reserved a slot: the fallback
    // runs only when the first returned nothing at all, and nothing means no
    // reservation, so a single lease covers both. The `finally` releases it on
    // every exit of this attempt, rotation `continue` included. This core
    // buffers its whole response, so nothing is still reading after the return.
    const accountLease = credentials?.accountLease || null;
    try {

      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const errorMsg = credentials.lastError || "Unavailable";
          const status = credentials.clientErrorStatus ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
          log.warn("SEARCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
          return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
        }
        if (excludeConnectionIds.size === 0) {
          log.error("AUTH", `No credentials for provider: ${providerId}`);
          return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
        }
        log.warn("SEARCH", "No more accounts available", { provider: providerId });
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
      }

      log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

      const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

      const result = await handleSearchCore({
        body: coreBody,
        provider: resolvedProvider,
        providerConfig,
        credentials: refreshedCredentials,
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
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials);
        }
      });

      if (result.success) return result.response;

      const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, credentialProviderId, searchLockKey);

      if (shouldFallback) {
        log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }

      return result.response;
    } finally {
      releaseAccountLease(accountLease);
    }
  }
}
