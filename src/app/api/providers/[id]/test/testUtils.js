import {
  getProviderConnectionById,
  updateProviderConnection,
} from "@/lib/localDb";
import * as localDb from "@/lib/localDb";
import { resolveConnectionProxyConfig, toConnectionProxyOptions } from "@/lib/network/connectionProxy";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { getDefaultModel } from "open-sse/config/providerModels.js";
import {
  resolveOllamaLocalHost,
  resolveXiaomiTokenplanModelsUrl,
  isXiaomiTokenplanTestResponseValid,
  PROVIDERS,
} from "open-sse/config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";
import { credentialAuthMode } from "open-sse/services/provider.js";
import {
  createNousApiKeyProbe,
  getNousApiKeyValidationError,
  isNousApiKeyAccepted,
} from "open-sse/services/nous.js";
import {
  GEMINI_CONFIG,
  ANTIGRAVITY_CONFIG,
  KIRO_CONFIG,
  CLAUDE_CONFIG,
  KILOCODE_CONFIG,
  KIMCHI_CONFIG,
} from "@/lib/oauth/constants/oauth";
import { FETCH_CONNECT_TIMEOUT_MS, PROBE_MAX_TOKENS } from "open-sse/config/runtimeConfig.js";
import { assertValidAwsRegion } from "open-sse/config/awsRegions.js";

// A "Check" that accepts 404 reports a working connection for a model the upstream
// does not serve. The account is created, the first real request 404s, and the
// account is model-locked for an hour with nothing having warned the user (#2032).
// 400 and 429 still confirm the credential — the request reached the account and
// was understood. 404 does not: either the model or the base URL is wrong, and
// both are the user's to fix before the connection is usable.
const CREDENTIAL_REJECTED_STATUSES = new Set([401, 403, 404]);
function credentialConfirmedByStatus(status) {
  return !CREDENTIAL_REJECTED_STATUSES.has(status);
}


const HUGGINGFACE_WHOAMI_URL = "https://huggingface.co/api/whoami-v2";

// OAuth provider test endpoints
const OAUTH_TEST_CONFIG = {
  claude: { checkExpiry: true, refreshable: true },
  codex: {
    url: "https://chatgpt.com/backend-api/codex/responses",
    method: "POST",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    extraHeaders: { "Content-Type": "application/json", "originator": "codex_cli_rs", "User-Agent": "codex_cli_rs/0.136.0" },
    // Minimal invalid body — triggers fast 400 without consuming quota
    body: JSON.stringify({ model: "gpt-5.3-codex", input: [], stream: false, store: false }),
    // 400 (bad request) means auth succeeded; only 401/403 means token is bad
    acceptStatuses: [400],
    refreshable: true,
  },
  "gemini-cli": {
    url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    refreshable: true,
  },
  antigravity: {
    url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    refreshable: true,
  },
  github: {
    url: "https://api.github.com/user",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    extraHeaders: { "User-Agent": "TokenProxy", "Accept": "application/vnd.github+json" },
  },
  iflow: {
    // iFlow getUserInfo requires accessToken as query param, not header
    buildUrl: (token) => `https://iflow.cn/api/oauth/getUserInfo?accessToken=${encodeURIComponent(token)}`,
    method: "GET",
    noAuth: true,
  },
  kiro: { checkExpiry: true, refreshable: true },
  qoder: {
    // Test by hitting Qoder's userinfo endpoint with the device token.
    // refreshable: false because the device-flow refresh endpoint returns
    // 403 for our flow (users re-login when expired). No checkExpiry —
    // we want the actual URL probe to run so revoked tokens surface.
    url: "https://openapi.qoder.sh/api/v1/userinfo",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    refreshable: false,
  },
  kimi: { checkExpiry: true, refreshable: true },
  "kimi-coding": { checkExpiry: true, refreshable: true },
  cursor: { tokenExists: true },
  kilocode: {
    url: `${KILOCODE_CONFIG.apiBaseUrl}/api/profile`,
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  gitlab: {
    // Test by hitting the GitLab user API — requires api or read_user scope
    url: "https://gitlab.com/api/v4/user",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "codebuddy-cn": { tokenExists: true },
  kimchi: {
    url: KIMCHI_CONFIG.validationUrl || "https://api.cast.ai/v1/llm/openai/supported-providers",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    extraHeaders: {
      Accept: "application/json",
      "User-Agent": "kimchi/0.1.40",
    },
    refreshable: false,
  },
  // Grok CLI / Grok Build — probe /v1/user (no inference quota). Headers mirror official CLI.
  "grok-cli": {
    url: PROVIDERS["grok-cli"]?.userUrl || "https://cli-chat-proxy.grok.com/v1/user",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    extraHeaders: {
      Accept: "application/json",
      ...(PROVIDERS["grok-cli"]?.headers || {
        "User-Agent": "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-identifier": "grok-pager",
        "x-grok-client-version": "0.2.93",
      }),
    },
    refreshable: true,
    // Subscription spending-limit is not an auth failure — token is fine, credits aren't.
    // Accept 402 so the connection stays "active" with a warning (same idea as Codex 400).
    acceptStatuses: [402],
    softFailMessage: {
      402: "Connected, but Grok Build credits are exhausted (spending limit). Add credits or upgrade SuperGrok.",
    },
  },
};

/**
 * Classify an OAuth probe response as success / soft-success / hard-fail.
 * Soft success (e.g. 402 spending-limit on Grok CLI) means auth works but the
 * account cannot spend — keep connection active and surface a warning.
 * Exported for unit tests.
 */
export function classifyOAuthProbeResult(res, config, bodyText = "") {
  if (!res) return { valid: false, error: "No response", soft: false };
  const status = res.status;
  const accepted = res.ok || (config?.acceptStatuses && config.acceptStatuses.includes(status));
  if (!accepted) {
    if (status === 401) return { valid: false, error: "Token invalid or revoked", soft: false };
    if (status === 403) return { valid: false, error: "Access denied", soft: false };
    return { valid: false, error: `API returned ${status}`, soft: false };
  }

  // Soft success only when the provider configured an explicit message for this
  // status (e.g. Grok CLI 402 spending-limit). Codex-style acceptStatuses:[400]
  // stays silent success — 400 there only proves auth, not a user-facing warning.
  if (!res.ok && config?.acceptStatuses?.includes(status)) {
    const softMap = config.softFailMessage || {};
    if (softMap[status]) {
      return { valid: true, error: softMap[status], soft: true };
    }
    return { valid: true, error: null, soft: false };
  }

  return { valid: true, error: null, soft: false };
}

const CLOUD_CODE_ASSIST_TEST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const CLOUD_CODE_ASSIST_TEST_BODY = JSON.stringify({
  metadata: {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  },
});

function parseProviderErrorMessage(bodyText, fallback) {
  if (!bodyText) return fallback;
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof message === "string" && message.trim()) return message.trim();
    if (message) return JSON.stringify(message);
  } catch {
    // fall through
  }
  return bodyText.trim() || fallback;
}

async function probeCloudCodeAssistAccess(connection, accessToken, effectiveProxy = null) {
  const userAgent = connection.provider === "antigravity"
    ? "google-api-nodejs-client/9.15.1 vscode-antigravity/1.107.0"
    : "google-api-nodejs-client/9.15.1 gemini-cli/0.34.0";

  const res = await fetchWithConnectionProxy(CLOUD_CODE_ASSIST_TEST_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
    body: CLOUD_CODE_ASSIST_TEST_BODY,
  }, effectiveProxy);

  if (res.ok) return { valid: true, error: null };

  const bodyText = await res.text().catch(() => "");
  return {
    valid: false,
    error: parseProviderErrorMessage(bodyText, `API returned ${res.status}`),
    status: res.status,
  };
}

async function refreshOAuthToken(connection, effectiveProxy = null) {
  const provider = connection.provider;
  const refreshToken = connection.refreshToken;
  if (!refreshToken) return null;

  try {
    if (provider === "gemini-cli" || provider === "antigravity") {
      const config = provider === "gemini-cli" ? GEMINI_CONFIG : ANTIGRAVITY_CONFIG;
      const response = await fetchWithConnectionProxy("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      }, effectiveProxy);
      if (!response.ok) return null;
      const data = await response.json();
      return { accessToken: data.access_token, expiresIn: data.expires_in, refreshToken: data.refresh_token || refreshToken };
    }

    if (provider === "codex" || provider === "grok-cli" || provider === "xai") {
      return await refreshProviderCredentials(provider, connection, console);
    }

    if (provider === "claude") {
      const response = await fetchWithConnectionProxy(CLAUDE_CONFIG.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_CONFIG.clientId,
        }),
      }, effectiveProxy);
      if (!response.ok) return null;
      const data = await response.json();
      return { accessToken: data.access_token, expiresIn: data.expires_in, refreshToken: data.refresh_token || refreshToken };
    }

    if (provider === "kiro") {
      const psd = connection.providerSpecificData || {};
      const clientId = psd.clientId || connection.clientId;
      const clientSecret = psd.clientSecret || connection.clientSecret;
      const region = psd.region || connection.region;
      if (clientId && clientSecret) {
        // A saved or imported region is interpolated into the host this POSTs the
        // client secret and refresh token to, so a value like "evil.example.com/"
        // re-hosts the token endpoint. Validate before any egress, the same way the
        // executor and the catalog already do (#3497); throwing lands in the catch
        // below and the test reports a failed refresh with nothing sent. Only this
        // branch reads the region — the social refresh below is left alone.
        const endpoint = `https://oidc.${assertValidAwsRegion(region || "us-east-1")}.amazonaws.com/token`;
        const response = await fetchWithConnectionProxy(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
        }, effectiveProxy);
        if (!response.ok) return null;
        const data = await response.json();
        return { accessToken: data.accessToken, expiresIn: data.expiresIn || 3600, refreshToken: data.refreshToken || refreshToken };
      }
      const response = await fetchWithConnectionProxy(KIRO_CONFIG.socialRefreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "kiro-cli/1.0.0" },
        body: JSON.stringify({ refreshToken }),
      }, effectiveProxy);
      if (!response.ok) return null;
      const data = await response.json();
      return { accessToken: data.accessToken, expiresIn: data.expiresIn || 3600, refreshToken: data.refreshToken || refreshToken };
    }

    return null;
  } catch (err) {
    console.log(`Error refreshing ${provider} token:`, err.message);
    return null;
  }
}

function isTokenExpired(connection) {
  return shouldRefreshCredentials(connection.provider, connection);
}

async function testOAuthConnection(connection, effectiveProxy = null) {
  const config = OAUTH_TEST_CONFIG[connection.provider];
  if (!config) return { valid: false, error: "Provider test not supported", refreshed: false };
  if (!connection.accessToken) return { valid: false, error: "No access token", refreshed: false };

  // Cursor uses protobuf API - can only verify token exists, not test endpoint
  if (config.tokenExists) {
    return { valid: true, error: null, refreshed: false, newTokens: null };
  }

  let accessToken = connection.accessToken;
  let refreshed = false;
  let newTokens = null;

  const tokenExpired = isTokenExpired(connection);
  if (config.refreshable && tokenExpired && connection.refreshToken) {
    const tokens = await refreshOAuthToken(connection, effectiveProxy);
    if (tokens) {
      accessToken = tokens.accessToken;
      refreshed = true;
      newTokens = tokens;
    } else {
      return { valid: false, error: "Token expired and refresh failed", refreshed: false };
    }
  }

  if (config.checkExpiry) {
    if (refreshed) return { valid: true, error: null, refreshed, newTokens };
    if (tokenExpired) return { valid: false, error: "Token expired", refreshed: false };
    return { valid: true, error: null, refreshed: false, newTokens: null };
  }

  if (connection.provider === "gemini-cli" || connection.provider === "antigravity") {
    const initial = await probeCloudCodeAssistAccess(connection, accessToken, effectiveProxy);
    if (initial.valid) return { valid: true, error: null, refreshed, newTokens };

    if (initial.status === 401 && config.refreshable && !refreshed && connection.refreshToken) {
      const tokens = await refreshOAuthToken(connection, effectiveProxy);
      if (tokens?.accessToken) {
        const retry = await probeCloudCodeAssistAccess(connection, tokens.accessToken, effectiveProxy);
        if (retry.valid) return { valid: true, error: null, refreshed: true, newTokens: tokens };
        return { valid: false, error: retry.error, refreshed: true, newTokens: tokens };
      }
      return { valid: false, error: "Token invalid or revoked", refreshed: false };
    }

    return { valid: false, error: initial.error, refreshed };
  }

  try {
    const testUrl = config.buildUrl ? config.buildUrl(accessToken) : config.url;
    const headers = config.noAuth
      ? { ...config.extraHeaders }
      : { [config.authHeader]: `${config.authPrefix}${accessToken}`, ...config.extraHeaders };
    // Without a signal a hung probe blocks the sequential test queue for as
    // long as the socket stays open, so one unreachable provider stalls every
    // connection behind it. The other probes in this file already bound
    // themselves with the same constant; this one was the outlier (#1449).
    const fetchOpts = { method: config.method, headers, signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) };
    if (config.body) fetchOpts.body = config.body;
    const res = await fetchWithConnectionProxy(testUrl, fetchOpts, effectiveProxy);
    const bodyText = !res.ok ? await res.text().catch(() => "") : "";

    const classified = classifyOAuthProbeResult(res, config, bodyText);
    if (classified.valid) {
      return {
        valid: true,
        // soft success surfaces warning text without marking connection error
        error: classified.soft ? classified.error : null,
        warning: classified.soft ? classified.error : null,
        refreshed,
        newTokens,
      };
    }

    if (res.status === 401 && config.refreshable && !refreshed && connection.refreshToken) {
      const tokens = await refreshOAuthToken(connection, effectiveProxy);
      if (tokens) {
        const retryUrl = config.buildUrl ? config.buildUrl(tokens.accessToken) : testUrl;
        const retryHeaders = config.noAuth
          ? { ...config.extraHeaders }
          : { [config.authHeader]: `${config.authPrefix}${tokens.accessToken}`, ...config.extraHeaders };
        const retryOpts = { method: config.method, headers: retryHeaders, signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) };
        if (config.body) retryOpts.body = config.body;
        const retryRes = await fetchWithConnectionProxy(retryUrl, retryOpts, effectiveProxy);
        const retryBody = !retryRes.ok ? await retryRes.text().catch(() => "") : "";
        const retryClassified = classifyOAuthProbeResult(retryRes, config, retryBody);
        if (retryClassified.valid) {
          return {
            valid: true,
            error: retryClassified.soft ? retryClassified.error : null,
            warning: retryClassified.soft ? retryClassified.error : null,
            refreshed: true,
            newTokens: tokens,
          };
        }

        // The refresh succeeded and rotated the token, so the old refresh token
        // is already spent upstream. Dropping the new one here strands the
        // connection for good, and running a connection test must never be what
        // does that. Report why the retry actually failed rather than blaming a
        // token that was just renewed successfully: persistence below keys on
        // refreshed && newTokens, not on valid, so the rotation is saved either
        // way.
        return {
          valid: false,
          error: retryClassified.error || "Token refreshed, but the account rejected the request",
          refreshed: true,
          newTokens: tokens,
        };
      }
      return { valid: false, error: "Token invalid or revoked", refreshed: false };
    }

    return { valid: false, error: classified.error, refreshed };
  } catch (err) {
    return { valid: false, error: err.message, refreshed };
  }
}

// Connection tests run one behind the other, and neither this helper nor
// proxyAwareFetch imposed a deadline of its own, so a provider that accepts the
// socket and never answers stalled every connection queued behind it (#1450).
// Defaulting the signal here bounds every probe at once, including the ones
// that pass no options at all; a caller with its own deadline still wins.
async function fetchWithConnectionProxy(url, options = {}, effectiveProxy = null) {
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  return proxyAwareFetch(
    url,
    { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS), ...options },
    effectiveProxy,
  );
}

async function testHuggingFaceToken(apiKey, effectiveProxy) {
  try {
    const res = await fetchWithConnectionProxy(HUGGINGFACE_WHOAMI_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
    }, effectiveProxy);
    if (res.ok) return { valid: true, error: null };
    if (res.status === 401 || res.status === 403) return { valid: false, error: "Invalid API key" };
  } catch { /* Return a safe inconclusive result below. */ }

  return { valid: false, error: "Unable to verify API key" };
}

async function testOpenAIModelsApiKey(provider, apiKey, effectiveProxy) {
  const validateUrl = PROVIDERS[provider]?.validateUrl;
  if (!validateUrl) return { valid: false, error: "Unable to verify API key" };

  try {
    const res = await fetchWithConnectionProxy(validateUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
    }, effectiveProxy);
    if (res.ok) return { valid: true, error: null };
    if (res.status === 401 || res.status === 403) return { valid: false, error: "Invalid API key" };
  } catch { /* Return a safe inconclusive result below. */ }

  return { valid: false, error: "Unable to verify API key" };
}

async function testGitlawbOpenGatewayToken(apiKey, effectiveProxy) {
  const creditsUrl = PROVIDERS["gitlawb-opengateway"]?.validateUrl;
  if (!creditsUrl) return { valid: false, error: "Unable to verify API key" };

  try {
    const res = await fetchWithConnectionProxy(creditsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
    }, effectiveProxy);
    if (res.ok) return { valid: true, error: null };
    if (res.status === 401 || res.status === 403) return { valid: false, error: "Invalid API key" };
  } catch { /* Return a safe inconclusive result below. */ }

  return { valid: false, error: "Unable to verify API key" };
}

async function testApiKeyConnection(connection, effectiveProxy = null) {
  if (isOpenAICompatibleProvider(connection.provider)) {
    const modelsBase = connection.providerSpecificData?.baseUrl;
    if (!modelsBase) return { valid: false, error: "Missing base URL" };
    try {
      const base = modelsBase.replace(/\/$/, "");
      const res = await fetchWithConnectionProxy(`${base}/models`, {
        headers: { "Authorization": `Bearer ${connection.apiKey}` },
      }, effectiveProxy);
      if (res.ok) return { valid: true, error: null };
      // A gateway that serves no /models answers 404 or 405 there while working
      // perfectly on /chat/completions, and condemning it on the listing alone
      // reported every hand-added endpoint as a bad key (#994). Only an auth
      // status is definitive from the listing; anything else re-probes the
      // endpoint the connection actually uses, where 404 still fails (#2032).
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: "Invalid API key" };
      }
      const chatRes = await fetchWithConnectionProxy(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: connection.defaultModel || "test",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: PROBE_MAX_TOKENS,
        }),
      }, effectiveProxy);
      const valid = credentialConfirmedByStatus(chatRes.status);
      return { valid, error: valid ? null : "Invalid API key or base URL" };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  if (isAnthropicCompatibleProvider(connection.provider)) {
    let modelsBase = connection.providerSpecificData?.baseUrl;
    if (!modelsBase) return { valid: false, error: "Missing base URL" };
    try {
      modelsBase = modelsBase.replace(/\/$/, "");
      if (modelsBase.endsWith("/messages")) modelsBase = modelsBase.slice(0, -9);
      const messagesUrl = `${modelsBase}/v1/messages`;
      const model = connection.defaultModel || "claude-3-haiku-20240307";
      const res = await fetchWithConnectionProxy(messagesUrl, {
        method: "POST",
        headers: {
          "x-api-key": connection.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "Authorization": `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: "test" }],
        }),
      }, effectiveProxy);
      // 400/529 still confirms key accepted; only 401/403 = bad key
      const valid = credentialConfirmedByStatus(res.status);
      return { valid, error: valid ? null : "Invalid API key or base URL" };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  try {
    switch (connection.provider) {
      case "cloudflare-ai": {
        const psd = connection.providerSpecificData || {};
        const accountId = psd.accountId;
        if (!accountId) return { valid: false, error: "Missing Account ID" };
        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
        const res = await fetchWithConnectionProxy(url, {
          method: "POST",
          headers: { "Authorization": `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: getDefaultModel("cloudflare-ai"), messages: [{ role: "user", content: "test" }], max_tokens: PROBE_MAX_TOKENS }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API token or Account ID" };
      }
      case "azure": {
        const psd = connection.providerSpecificData || {};
        const endpoint = (psd.azureEndpoint || "").replace(/\/$/, "");
        const deployment = psd.deployment || "gpt-4";
        const apiVersion = psd.apiVersion || "2024-10-01-preview";
        const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
        const headers = { "api-key": connection.apiKey, "Content-Type": "application/json" };
        if (psd.organization) headers["OpenAI-Organization"] = psd.organization;
        const res = await fetchWithConnectionProxy(url, {
          method: "POST", headers,
          body: JSON.stringify({ messages: [{ role: "user", content: "test" }], max_completion_tokens: PROBE_MAX_TOKENS }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key or Azure configuration" };
      }
      case "openai": {
        const res = await fetchWithConnectionProxy("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "vercel-ai-gateway": {
        const res = await fetchWithConnectionProxy("https://ai-gateway.vercel.sh/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "anthropic": {
        const res = await fetchWithConnectionProxy("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "test" }] }),
        }, effectiveProxy);
        const valid = res.status !== 401;
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "gemini": {
        const res = await fetchWithConnectionProxy(`https://generativelanguage.googleapis.com/v1/models?key=${connection.apiKey}`, {}, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "openrouter": {
        const res = await fetchWithConnectionProxy("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "nous": {
        // /models is public on Nous; a minimal chat request is required to
        // distinguish an accepted Portal key from an arbitrary Bearer value.
        const probe = createNousApiKeyProbe(connection.apiKey);
        const res = await fetchWithConnectionProxy(probe.url, {
          ...probe.options,
          signal: AbortSignal.timeout(8000),
        }, effectiveProxy);
        const valid = isNousApiKeyAccepted(res.status);
        return {
          valid,
          error: valid ? null : getNousApiKeyValidationError(res.status),
        };
      }
      case "huggingface": {
        return await testHuggingFaceToken(connection.apiKey, effectiveProxy);
      }
      case "sumopod":
      case "x5lab": {
        return await testOpenAIModelsApiKey(connection.provider, connection.apiKey, effectiveProxy);
      }
      case "gitlawb-opengateway": {
        return await testGitlawbOpenGatewayToken(connection.apiKey, effectiveProxy);
      }
      case "glm": {
        const res = await fetchWithConnectionProxy("https://api.z.ai/api/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "glm-4.7", max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "test" }] }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "glm-cn": {
        const res = await fetchWithConnectionProxy("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${connection.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "glm-4.7", max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "test" }] }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "minimax":
      case "minimax-cn": {
        const endpoints = { minimax: "https://api.minimax.io/anthropic/v1/messages", "minimax-cn": "https://api.minimaxi.com/anthropic/v1/messages" };
        const res = await fetchWithConnectionProxy(endpoints[connection.provider], {
          method: "POST",
          headers: { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "minimax-m2", max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "test" }] }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "kimi": {
        // api.kimi.com/coding is the SUBSCRIPTION product and answers a platform API
        // key with 401 however valid it is, so probing it for every credential
        // reported working keys as invalid (#3190). Routing already scopes the host
        // to the credential through kimi.js `authModes` (#2881); the validator reads
        // the same mode so the two cannot disagree.
        const res = credentialAuthMode(connection) === "apikey"
          ? await fetchWithConnectionProxy("https://api.moonshot.ai/v1/users/me/balance", {
              headers: { Authorization: `Bearer ${connection.apiKey}` },
            }, effectiveProxy)
          : await fetchWithConnectionProxy("https://api.kimi.com/coding/v1/messages", {
              method: "POST",
              headers: { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
              body: JSON.stringify({ model: "kimi-latest", max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "test" }] }),
            }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "alicode":
      case "alicode-intl":
      case "alims-intl": {
        // Aliyun Coding Plan uses OpenAI-compatible API; alims-intl uses Model Studio compatible-mode
        const aliBaseUrl = connection.provider === "alicode-intl"
          ? "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions"
          : connection.provider === "alims-intl"
          ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
          : "https://coding.dashscope.aliyuncs.com/v1/chat/completions";
        const res = await fetchWithConnectionProxy(aliBaseUrl, {
          method: "POST",
          headers: { "Authorization": `Bearer ${connection.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: getDefaultModel(connection.provider), max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "test" }] }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "volcengine-ark":
      case "byteplus": {
        const res = await fetchWithConnectionProxy(PROVIDERS[connection.provider]?.baseUrl, {
          method: "POST",
          headers: { "Authorization": `Bearer ${connection.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: getDefaultModel(connection.provider), max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "test" }] }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "groq": {
        const res = await fetchWithConnectionProxy("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "mistral": {
        const res = await fetchWithConnectionProxy("https://api.mistral.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "xai": {
        const res = await fetchWithConnectionProxy("https://api.x.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "nvidia": {
        const res = await fetchWithConnectionProxy("https://integrate.api.nvidia.com/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "perplexity": {
        const res = await fetchWithConnectionProxy("https://api.perplexity.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "together": {
        const res = await fetchWithConnectionProxy("https://api.together.xyz/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "fireworks": {
        const res = await fetchWithConnectionProxy("https://api.fireworks.ai/inference/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "cerebras": {
        const res = await fetchWithConnectionProxy("https://api.cerebras.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "novita": {
        const res = await fetchWithConnectionProxy("https://api.novita.ai/openai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "sensenova": {
        const res = await fetchWithConnectionProxy(PROVIDERS.sensenova.validateUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${connection.apiKey}` },
          signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
        }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "cohere": {
        const res = await fetchWithConnectionProxy("https://api.cohere.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "nebius": {
        const res = await fetchWithConnectionProxy("https://api.studio.nebius.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "siliconflow": {
        const res = await fetchWithConnectionProxy("https://api.siliconflow.com/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "hyperbolic": {
        const res = await fetchWithConnectionProxy("https://api.hyperbolic.xyz/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "ollama": {
        const res = await fetchWithConnectionProxy("https://ollama.com/api/tags", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "ollama-local": {
        // Both Ollama probes called the global fetch, so they skipped the
        // connection proxy as well as the deadline every other case gets
        // (#1450). A loopback host still resolves to a direct route inside
        // proxyAwareFetch, so nothing is tunnelled that was not before.
        const host = resolveOllamaLocalHost(connection);
        const res = await fetchWithConnectionProxy(`${host}/api/tags`, {}, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : `Ollama not reachable at ${host}` };
      }
      case "deepgram": {
        const res = await fetchWithConnectionProxy("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "assemblyai": {
        const res = await fetchWithConnectionProxy("https://api.assemblyai.com/v1/account", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "nanobanana": {
        const res = await fetchWithConnectionProxy("https://api.nanobananaapi.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "fal-ai": {
        const res = await fetchWithConnectionProxy("https://api.fal.ai/v1/models?limit=1", { headers: { Authorization: `Key ${connection.apiKey}` } }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "chutes": {
        const res = await fetchWithConnectionProxy("https://llm.chutes.ai/v1/models", { headers: { Authorization: `Bearer ${connection.apiKey}` } }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "grok-web": {
        const token = connection.apiKey.startsWith("sso=") ? connection.apiKey.slice(4) : connection.apiKey;
        const randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
        const statsigId = Buffer.from("e:TypeError: Cannot read properties of null (reading 'children')").toString("base64");
        const res = await fetchWithConnectionProxy("https://grok.com/rest/app-chat/conversations/new", {
          method: "POST",
          headers: {
            Accept: "*/*", "Content-Type": "application/json",
            Cookie: `sso=${token}`, Origin: "https://grok.com", Referer: "https://grok.com/",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            "x-statsig-id": statsigId, "x-xai-request-id": crypto.randomUUID(),
            traceparent: `00-${randomHex(16)}-${randomHex(8)}-00`,
          },
          body: JSON.stringify({ temporary: true, modelName: "grok-4", message: "ping", fileAttachments: [], imageAttachments: [], disableSearch: false, enableImageGeneration: false, sendFinalMetadata: true }),
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid SSO cookie" };
      }
      case "perplexity-web": {
        let sessionToken = connection.apiKey;
        if (sessionToken.startsWith("__Secure-next-auth.session-token=")) sessionToken = sessionToken.slice("__Secure-next-auth.session-token=".length);
        const res = await fetchWithConnectionProxy("https://www.perplexity.ai/api/auth/session", {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
          },
        }, effectiveProxy);
        if (!res.ok) return { valid: false, error: "Invalid session cookie" };
        const data = await res.json().catch(() => null);
        const valid = !!(data && data.user);
        return { valid, error: valid ? null : "Session expired — re-paste cookie" };
      }
      case "opencode-go": {
        // Probing with a chat completion billed the user for every click on "test
        // connection" (#3250). The usage endpoint getOpencodeGoUsage already reads
        // is free and proves the credential just as well; a 200 reporting zero
        // remaining is a valid key out of quota, which only the 401/403/404 rule
        // below gets right.
        const res = await fetchWithConnectionProxy("https://opencode.ai/zen/go/v1/usage", {
          headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
        }, effectiveProxy);
        const valid = credentialConfirmedByStatus(res.status);
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "xiaomi-mimo":
      case "xiaomi-tokenplan": {
        const isTokenPlan = connection.provider === "xiaomi-tokenplan";
        const modelsUrl = isTokenPlan
          ? resolveXiaomiTokenplanModelsUrl(connection)
          : "https://api.xiaomimimo.com/v1/models";
        const res = await fetchWithConnectionProxy(modelsUrl, {
          headers: { Authorization: `Bearer ${connection.apiKey}` },
        }, effectiveProxy);
        const valid = isTokenPlan ? isXiaomiTokenplanTestResponseValid(res) : res.ok;
        return { valid, error: valid ? null : "Invalid API key" };
      }
      case "blackbox": {
        const baseUrl = PROVIDERS["blackbox"]?.baseUrl?.replace(/\/chat\/completions$/, "") || "https://api.blackbox.ai/v1";
        const res = await fetchWithConnectionProxy(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${connection.apiKey}` },
        }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key" };
      }
      case "qoder": {
        // PAT (pt-...) exchange → job token. A successful exchange proves the PAT.
        const raw = connection.apiKey || "";
        const pat = raw.startsWith("pt-") ? raw : `pt-${raw}`;
        const exRes = await fetchWithConnectionProxy(
          "https://openapi.qoder.sh/api/v1/jobToken/exchange",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "Cosy-Version": "1.0.1",
              "Cosy-ClientType": "5",
            },
            body: JSON.stringify({ personal_token: pat }),
          },
          effectiveProxy,
        );
        return { valid: exRes.ok, error: exRes.ok ? null : "Invalid Personal Access Token" };
      }
      case "tokenrouter": {
        const baseUrl = connection.providerSpecificData?.baseUrl || "https://api.tokenrouter.com/v1";
        const res = await fetchWithConnectionProxy(`${baseUrl.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${connection.apiKey}` },
        }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key or base URL" };
      }
      case "llm7": {
        const baseUrl = connection.providerSpecificData?.baseUrl || "https://api.llm7.io/v1";
        const res = await fetchWithConnectionProxy(`${baseUrl.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${connection.apiKey}` },
        }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key or base URL" };
      }
      case "kimchi": {
        // Dual-auth: same validation endpoint as the OAuth flow — the token (API key
        // or OAuth access token) is sent as Authorization: Bearer.
        const url = KIMCHI_CONFIG.validationUrl || "https://api.cast.ai/v1/llm/openai/supported-providers";
        const res = await fetchWithConnectionProxy(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${connection.apiKey}`,
            "User-Agent": "kimchi/0.1.40",
          },
        }, effectiveProxy);
        return { valid: res.ok, error: res.ok ? null : "Invalid API key", refreshed: false };
      }
      default:
        return { valid: false, error: "Provider test not supported" };
    }
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Test a single connection by ID, update DB, and return result.
 */
export async function testSingleConnection(id) {
  const connection = await getProviderConnectionById(id);
  if (!connection) return { valid: false, error: "Connection not found", latencyMs: 0, testedAt: new Date().toISOString() };

  const proxyData = connection.providerSpecificData || {};
  const proxyConfig = await resolveConnectionProxyConfig(proxyData, {
    persistPoolSnapshot: proxyData.proxyPoolId && typeof localDb.updateConnectionProxyPoolSnapshotIfBound === "function"
      ? (pair) => localDb.updateConnectionProxyPoolSnapshotIfBound(connection.id, proxyData.proxyPoolId, pair)
      : undefined,
  });
  if (proxyConfig?.kind === "required-unavailable") {
    return {
      valid: false,
      error: "Required proxy is unavailable",
      code: "required_proxy_unavailable",
      status: 503,
      latencyMs: 0,
      testedAt: new Date().toISOString(),
    };
  }
  const effectiveProxy = proxyConfig?.kind === "usable"
    ? toConnectionProxyOptions(proxyConfig)
    : proxyConfig || {};

  if (effectiveProxy.connectionProxyEnabled && effectiveProxy.connectionProxyUrl && !effectiveProxy.vercelRelayUrl) {
    const proxyResult = await testProxyUrl({ proxyUrl: effectiveProxy.connectionProxyUrl });
    if (!proxyResult.ok) {
      const proxyError = proxyResult.error || `Proxy test failed with status ${proxyResult.status}`;
      await updateProviderConnection(id, {
        testStatus: "error",
        lastError: proxyError,
        lastErrorAt: new Date().toISOString(),
      });
      return { valid: false, error: proxyError, latencyMs: 0, testedAt: new Date().toISOString() };
    }
  }

  const start = Date.now();
  let result;

  if (connection.authType === "apikey" || connection.authType === "cookie") {
    result = await testApiKeyConnection(connection, effectiveProxy);
  } else {
    result = await testOAuthConnection(connection, effectiveProxy);
  }

  const latencyMs = Date.now() - start;

  // Soft success (e.g. Grok CLI 402 spending-limit): credentials are good, account is
  // out of credits. Keep testStatus active; surface the message as lastError so the
  // dashboard can show a warning without marking the connection broken.
  const softWarning = result.valid && (result.warning || result.error);
  const updateData = {
    testStatus: result.valid ? "active" : "error",
    lastError: result.valid ? (softWarning || null) : result.error,
    lastErrorAt: result.valid
      ? softWarning
        ? new Date().toISOString()
        : null
      : new Date().toISOString(),
  };

  if (result.refreshed && result.newTokens) {
    if (result.newTokens.accessToken) updateData.accessToken = result.newTokens.accessToken;
    if (result.newTokens.refreshToken) updateData.refreshToken = result.newTokens.refreshToken;
    if (result.newTokens.idToken) updateData.idToken = result.newTokens.idToken;
    if (result.newTokens.lastRefreshAt) updateData.lastRefreshAt = result.newTokens.lastRefreshAt;
    if (result.newTokens.expiresIn) updateData.expiresIn = result.newTokens.expiresIn;
    if (result.newTokens.expiresIn) {
      updateData.expiresAt = new Date(Date.now() + result.newTokens.expiresIn * 1000).toISOString();
    } else if (result.newTokens.expiresAt) {
      updateData.expiresAt = result.newTokens.expiresAt;
    }
    if (result.newTokens.providerSpecificData) {
      updateData.providerSpecificData = {
        ...(connection.providerSpecificData || {}),
        ...result.newTokens.providerSpecificData,
      };
    }
  }

  await updateProviderConnection(id, updateData);

  return { valid: result.valid, error: result.error, refreshed: !!result.refreshed, latencyMs, testedAt: new Date().toISOString() };
}
