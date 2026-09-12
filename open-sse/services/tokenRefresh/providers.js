import { PROVIDERS, PROVIDER_OAUTH } from "../../config/providers.js";
import { OAUTH_ENDPOINTS, GITHUB_COPILOT, buildKimiHeaders } from "../../config/appConstants.js";
import { proxyAwareFetch as unboundedProxyFetch } from "../../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { assertValidAwsRegion } from "../../config/awsRegions.js";

// Proxy options for a refresh call, in the same shape jsonProxyCore.js:36-44
// builds for a chat request. A connection pinned to a proxy must stay pinned
// for its token refreshes too: refreshing over the host's own egress tells the
// provider the real address of a router the user deliberately put behind a
// proxy, and no amount of care on the chat path hides that. Mirrored rather
// than imported because the builder is a local function in a handler module;
// a shared helper on proxyFetch is the right eventual home for all three.
export function refreshProxyOptions(credentials) {
  const data = credentials?.providerSpecificData;
  if (!data) return null;
  return {
    connectionProxyEnabled: data.connectionProxyEnabled === true,
    connectionProxyUrl: data.connectionProxyUrl || "",
    connectionNoProxy: data.connectionNoProxy || "",
    vercelRelayUrl: data.vercelRelayUrl || "",
    strictProxy: data.strictProxy === true,
  };
}

import { credentialContentRevision } from "./credentialRevision.js";
import { dedupRefresh, getRefreshContext, tokenFingerprint, chainPeers, connsLabel } from "./dedup.js";
import { decide } from "../../../src/shared/observability/decide.js";

// A refresh runs inline on the chat request that triggered it, so an upstream
// that returns response headers and then goes silent held that request open for
// as long as the socket stayed up (#1450). Nothing underneath bounds it:
// proxyFetch.js sets `bodyTimeout: 0` on the shared proxy dispatcher, which
// undici documents as "disable it entirely", and that dispatcher also carries
// chat streams, so it must stay disabled. Bounding it here instead covers every
// refresh below at once, including any added later, and leaves non-refresh
// traffic alone. The deadline is the connection probe's, the closest comparable
// upstream call; a caller passing its own signal still wins. A timeout throws an
// AbortError, which each path's existing catch already treats as a failed
// refresh, so callers see no new failure shape.
function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  return unboundedProxyFetch(
    url,
    { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS), ...options },
    getRefreshContext()?.credentials ? refreshProxyOptions(getRefreshContext().credentials) : proxyOptions,
  );
}

function safeStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function safeDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function safeNetworkReason(error) {
  return error?.name === "AbortError" ? "timeout-or-cancelled" : "network";
}

function httpFailure(response, errorText) {
  return { status: safeStatus(response?.status), reason: refreshFailureWhy(errorText) };
}

import { buildExternalIdpRefreshParams } from "../../../src/lib/oauth/kiroExternalIdp.js";

let _xaiServiceSingleton = null;
export async function refreshXaiToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("xai", refreshToken, async () => {
    try {
      if (!_xaiServiceSingleton) {
        const mod = await import("../../../src/lib/oauth/services/xai.js");
        _xaiServiceSingleton = new mod.XaiService();
      }
      const tokens = await _xaiServiceSingleton.refreshAccessToken(refreshToken, {fetcher:proxyAwareFetch});
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        idToken: tokens.id_token,
      };
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("invalid_grant") || msg.includes("invalid_request")) {
        log?.warn?.("TOKEN_REFRESH", "xAI refresh failed", { reason: "invalid-grant" });
        return { error: "invalid_grant" };
      }
      log?.warn?.("TOKEN_REFRESH", "xAI refresh failed", { reason: safeNetworkReason(e) });
      return null;
    }
  }, log);
}

// Per-provider refresh variants for the generic path. Keys not listed fall back
// to the default form-encoded OAuth2 refresh with client_id + client_secret.
const REFRESH_PROFILES = {
  claude: {
    bodyFormat: "json",
    includeClientSecret: false,
    url: () => OAUTH_ENDPOINTS.anthropic.token,
    dedupKey: "claude",
  },
  iflow: {
    url: () => OAUTH_ENDPOINTS.iflow.token,
    dedupKey: "iflow",
    extraHeaders: (creds, cfg) => ({
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
    }),
  },
  github: {
    url: () => OAUTH_ENDPOINTS.github.token,
    dedupKey: "github",
    includeClientSecret: (cfg) => !!cfg?.clientSecret,
  },
  kimi: {
    dedupKey: "kimi",
    extraHeaders: (creds) => buildKimiHeaders(creds?.providerSpecificData?.deviceId),
  },
};

function resolveRefreshUrl(provider, config, profile) {
  if (profile?.url) {
    try { return profile.url(); } catch { /* fall through */ }
  }
  return config?.refreshUrl || PROVIDER_OAUTH[provider]?.tokenUrl || null;
}

function buildRefreshBody(profile, config, refreshToken) {
  const fmt = profile?.bodyFormat === "json" ? "json" : "form";
  const includeSecret = profile?.includeClientSecret === undefined
    ? true
    : typeof profile.includeClientSecret === "function"
      ? profile.includeClientSecret(config)
      : profile.includeClientSecret;
  const payload = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  if (includeSecret && config.clientSecret) payload.client_secret = config.clientSecret;
  if (fmt === "json") return { format: "json", body: JSON.stringify(payload) };
  return { format: "form", body: new URLSearchParams(payload) };
}

// ─── CRED decision points (docs/logging-design.md §2 rows 42-43, 46) ────────

/** conn identity mirrors the getRefreshLockKey cascade in
 *  oauthCredentialManager.js: refreshAccessToken sees the credential bag,
 *  not the connection. 8-char prefix, same as the log schema. */
function credConn(credentials, refreshToken) {
  const id =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name;
  return id ? String(id).slice(0, 8) : tokenFingerprint(refreshToken) || "default";
}

// Per-connection refresh-token issue record: which fingerprint was issued
// when. firstSeen seeds from the persisted refreshTokenIssuedAt field
// (src/sse/services/tokenRefresh.js updateProviderCredentials), else the
// first time this process saw the connection hold this fp. Bounded Map so
// the registry cannot become the leak.
const ISSUE_MAX = 512;
const issueRecords = new Map();

// chain-diverged fires at most once per (conn, held fp)
const DIVERGED_MAX = 512;
const divergedFired = new Set();

function issueRecord(conn, fp0, credentials) {
  const persistedMs = Date.parse(credentials?.refreshTokenIssuedAt || "");
  const existing = issueRecords.get(conn);
  let rec;
  if (existing && existing.fp === fp0) {
    rec = existing;
    if (Number.isFinite(persistedMs) && persistedMs < rec.firstSeen) {
      rec.firstSeen = persistedMs;
    }
  } else {
    rec = { fp: fp0, firstSeen: Number.isFinite(persistedMs) ? persistedMs : Date.now() };
  }
  issueRecords.set(conn, rec);
  if (issueRecords.size > ISSUE_MAX) {
    issueRecords.delete(issueRecords.keys().next().value);
  }
  return rec;
}

/** Age of the issued token, rendered compactly: 41m / 3h / 2d. */
export function formatIssueAge(firstSeen, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - firstSeen) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Closed discriminator parsed from a provider error body. Never a free-form
 *  provider message: the log carries the enum, not the payload (§3.3). */
export function refreshFailureWhy(errorText) {
  try {
    const body = JSON.parse(errorText);
    const err = body?.error ?? body;
    if (err === "invalid_grant" || err === "invalid_client") return err;
  } catch { /* not a JSON body — fall through */ }
  return "http";
}

export async function refreshAccessToken(provider, refreshToken, credentials, log) {
  const config = PROVIDERS[provider];
  const profile = REFRESH_PROFILES[provider] || {};
  const url = resolveRefreshUrl(provider, config, profile);
  const conn = credConn(credentials, refreshToken);
  const prov = String(provider).slice(0, 8);

  if (!config || !url) {
    decide("CRED", "no-refresh-path", { conn, prov, which: "url" });
    log?.warn?.("TOKEN_REFRESH", "No refresh URL configured", { provider: prov });
    return null;
  }

  if (!refreshToken) {
    decide("CRED", "no-refresh-path", { conn, prov, which: "token" });
    log?.warn?.("TOKEN_REFRESH", "No refresh token available", { provider: prov });
    return null;
  }

  const fp0 = tokenFingerprint(refreshToken);
  const issued = issueRecord(conn, fp0, credentials);
  const age = () => formatIssueAge(issued.firstSeen);

  const dedupKey = profile.dedupKey || provider;

  return dedupRefresh(dedupKey, refreshToken, async () => {
  try {
    const { format: bodyFormat, body } = buildRefreshBody(profile, config, refreshToken);
    const headers = {
      "Content-Type": bodyFormat === "json" ? "application/json" : "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...(profile.extraHeaders ? (profile.extraHeaders(credentials, config) || {}) : {}),
    };
    const response = await proxyAwareFetch(url, { method: "POST", headers, body }, refreshProxyOptions(credentials));

    if (!response.ok) {
      const errorText = await response.text();
      const why = refreshFailureWhy(errorText);
      decide("CRED", "refresh-failed", {
        conn, prov, status: response.status, why, fp0, age: age(),
      });
      if (why === "invalid_grant" && credentials?.refreshTokenFp === fp0
          && !!credentials?.refreshTokenIssuedAt) {
        // The issuer rejected the exact token we were issued: someone else
        // rotated this chain (docs/logging-design.md §1.5, §3.4).
        const dk = `${conn}:${fp0}`;
        if (!divergedFired.has(dk)) {
          divergedFired.add(dk);
          if (divergedFired.size > DIVERGED_MAX) {
            divergedFired.delete(divergedFired.values().next().value);
          }
          decide("CRED", "chain-diverged", {
            conn, prov, fp0, fp: "unknown", why: "issuer-rejected-held-token",
            peers: connsLabel(chainPeers(fp0, conn)),
          });
        }
      }
      log?.error?.("TOKEN_REFRESH", "Provider token refresh failed", {
        provider: prov,
        ...httpFailure(response, errorText),
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", `Successfully refreshed token for ${provider}`, {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: safeDuration(tokens.expires_in),
    });

    const fp = tokenFingerprint(tokens.refresh_token || refreshToken);
    if (fp !== fp0) {
      decide("CRED", "rotated", { conn, prov, fp0, fp });
      issueRecords.set(conn, { fp, firstSeen: Date.now() });
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      ...(profile.parse ? (profile.parse(tokens) || {}) : {}),
    };
  } catch (error) {
    decide("CRED", "refresh-failed", { conn, prov, why: "network", fp0, age: age() });
    log?.error?.("TOKEN_REFRESH", "Provider token refresh failed", {
      provider: prov,
      reason: safeNetworkReason(error),
    });
    return null;
  }
  }, log, conn, credentialContentRevision(credentials));
}

// CLIProxyAPI DeviceFlowClient.RefreshToken: form body (no client_secret) + X-Msh-* headers
// Delegate to refreshAccessToken("kimi", ...) — profile carries the X-Msh headers.
export async function refreshKimiToken(refreshToken, credentials, log) {
  return refreshAccessToken("kimi", refreshToken, credentials, log);
}

// Claude OAuth: JSON body, client_id only. Delegate to refreshAccessToken("claude", ...).
export async function refreshClaudeOAuthToken(refreshToken, log) {
  return refreshAccessToken("claude", refreshToken, {}, log);
}

export async function refreshGoogleToken(refreshToken, clientId, clientSecret, log) {
  if (!refreshToken) return null;
  return dedupRefresh(`google:${clientId}`, refreshToken, async () => {
  try {
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Google token", httpFailure(response, errorText));
      return null;
    }

    const tokens = await response.json();
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Google token", { hasNewAccessToken: !!tokens.access_token, expiresIn: safeDuration(tokens.expires_in) });
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Network error refreshing Google token", { reason: safeNetworkReason(error) });
    return null;
  }
  }, log, null, credentialContentRevision({providerSpecificData:{clientId,clientSecret}}));
}

export function classifyOAuthRefreshError(errorText = "", status = 0) {
  let parsed = null;
  try {
    parsed = errorText ? JSON.parse(errorText) : null;
  } catch {
    parsed = null;
  }

  const code = parsed?.error?.code || parsed?.error || parsed?.error_code || "";
  const description = parsed?.error_description || parsed?.message || errorText || "";
  const combined = `${code} ${description}`.toLowerCase();
  const permanent = [
    // PR #1821: OpenAI answers a dead refresh token with 401
    // {error:{code:"token_expired"}}; the marker also covers refresh_token_expired.
    "token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "invalid_grant",
  ].some((marker) => combined.includes(marker));

  return { status, code, description, permanent };
}

function safeOAuthCode(code) {
  return ["token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant", "invalid_client"]
    .includes(code) ? code : "oauth_error";
}

export async function refreshCodexToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codex", refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(OAUTH_ENDPOINTS.openai.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: PROVIDERS.codex.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const failure = classifyOAuthRefreshError(errorText, response.status);
        if (failure.permanent) {
          log?.error?.("TOKEN_REFRESH", "Codex refresh token already used or invalid. Re-auth required.", {
            status: safeStatus(response.status),
            code: safeOAuthCode(failure.code),
          });
          return { error: "unrecoverable_refresh_error", code: safeOAuthCode(failure.code) };
        }

        log?.error?.("TOKEN_REFRESH", "Failed to refresh Codex token", {
          status: safeStatus(response.status),
          code: safeOAuthCode(failure.code),
          reason: "http",
          permanent: failure.permanent,
        });
        return null;
      }

      const tokens = await response.json();

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Codex token", {
        hasNewAccessToken: !!tokens.access_token,
        hasNewRefreshToken: !!tokens.refresh_token,
        hasIdToken: !!tokens.id_token,
        expiresIn: safeDuration(tokens.expires_in),
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", "Network error refreshing Codex token", { reason: safeNetworkReason(error) });
      return null;
    }
  }, log);
}

async function resolveKiroProfileArnPatch(providerSpecificData, accessToken, refreshedArn) {
  if (providerSpecificData?.profileArn) return {};
  let profileArn = refreshedArn?.trim?.() || null;
  if (!profileArn) {
    const { fetchKiroProfileArn } = await import("../../../src/lib/oauth/providers.js");
    profileArn = await fetchKiroProfileArn(accessToken);
  }
  return profileArn ? { providerSpecificData: { profileArn } } : {};
}

export async function refreshKiroToken(refreshToken, providerSpecificData, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh("kiro", refreshToken, async () => {
  const authMethod = providerSpecificData?.authMethod;
  const clientId = providerSpecificData?.clientId;
  const clientSecret = providerSpecificData?.clientSecret;
  const region = providerSpecificData?.region;

  if (authMethod === "external_idp") {
    let refreshRequest;
    try {
      refreshRequest = buildExternalIdpRefreshParams(refreshToken, providerSpecificData);
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", "Invalid Kiro external_idp refresh config", { reason: "invalid-config" });
      return null;
    }

    const response = await proxyAwareFetch(refreshRequest.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: refreshRequest.body,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro external_idp token", httpFailure(response, errorText));
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro external_idp token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: safeDuration(tokens.expires_in),
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      providerSpecificData: refreshRequest.providerSpecificData,
    };
  }

  if (clientId && clientSecret) {
    const isIDC = authMethod === "idc";
    // The body below carries clientSecret and refreshToken, so a persisted
    // region that is not a region re-hosts both with no user action. The
    // executor, the model catalog and the connection test already pin this;
    // this unattended path was the one that did not (#3497). A stored region
    // that fails the guard is a tampered or corrupt record, so refuse rather
    // than quietly refreshing against us-east-1 as if none had been set.
    let endpoint = "https://oidc.us-east-1.amazonaws.com/token";
    if (isIDC && region) {
      try {
        endpoint = `https://oidc.${assertValidAwsRegion(region)}.amazonaws.com/token`;
      } catch {
        log?.warn?.("TOKEN_REFRESH", "Refusing Kiro IDC refresh: invalid stored region");
        return null;
      }
    }

    const response = await proxyAwareFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        grantType: "refresh_token",
      }),
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro AWS token", httpFailure(response, errorText));
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro AWS token", {
      hasNewAccessToken: !!tokens.accessToken,
      expiresIn: safeDuration(tokens.expiresIn),
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || refreshToken,
      expiresIn: tokens.expiresIn,
      ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
    };
  }

  const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "kiro-cli/1.0.0",
    },
    body: JSON.stringify({
      refreshToken: refreshToken,
    }),
  }, proxyOptions);

  if (!response.ok) {
    const errorText = await response.text();
    log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro social token", httpFailure(response, errorText));
    return null;
  }

  const tokens = await response.json();

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro social token", {
    hasNewAccessToken: !!tokens.accessToken,
    expiresIn: safeDuration(tokens.expiresIn),
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || refreshToken,
    expiresIn: tokens.expiresIn,
    ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
  };
  }, log, null, credentialContentRevision({providerSpecificData:{...providerSpecificData,refreshTransport:proxyOptions}}));
}

// iFlow: Basic Auth + client_id+client_secret in body. Delegate to refreshAccessToken("iflow", ...).
export async function refreshIflowToken(refreshToken, log) {
  return refreshAccessToken("iflow", refreshToken, {}, log);
}

// GitHub: optional client_secret. Delegate to refreshAccessToken("github", ...).
export async function refreshGitHubToken(refreshToken, log) {
  return refreshAccessToken("github", refreshToken, {}, log);
}

export async function refreshCopilotToken(githubAccessToken, log) {
  if (!githubAccessToken) return null;
  return dedupRefresh("copilot", githubAccessToken, async () => {
  try {
    const response = await proxyAwareFetch(PROVIDER_OAUTH["github"]?.copilotTokenUrl, {
      headers: {
        "Authorization": `token ${githubAccessToken}`,
        "User-Agent": GITHUB_COPILOT.USER_AGENT,
        "Editor-Version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
        "Editor-Plugin-Version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
        "Accept": "application/json",
        "x-github-api-version": GITHUB_COPILOT.API_VERSION
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Copilot token", httpFailure(response, errorText));
      return null;
    }

    const data = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Copilot token", {
      hasToken: !!data.token,
      hasExpiration: Number.isFinite(Number(data.expires_at)),
    });

    return {
      token: data.token,
      expiresAt: data.expires_at
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Error refreshing Copilot token", { reason: safeNetworkReason(error) });
    return null;
  }
  }, log);
}

// CodeBuddy (Tencent) refresh — POST /v2/plugin/auth/token/refresh with the
// refresh token carried in the X-Refresh-Token header (not a form body),
// matching the official CodeBuddy CLI. Response: { code: 0, data: <token> }.
export async function refreshCodebuddyToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codebuddy-cn", refreshToken, async () => {
    try {
      const oauth = PROVIDER_OAUTH["codebuddy-cn"] || {};
      const response = await proxyAwareFetch(oauth.refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": oauth.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "copilot.tencent.com",
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": "SaaS",
        },
        body: "{}",
      });

      if (!response.ok) {
        const errorText = await response.text();
        log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy token", httpFailure(response, errorText));
        return null;
      }

      const data = await response.json();
      if (data.code !== 0 || !data.data?.accessToken) {
        log?.error?.("TOKEN_REFRESH", "CodeBuddy token refresh returned no token", { reason: "provider-response" });
        return null;
      }

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy token", {
        hasNewAccessToken: !!data.data.accessToken,
        hasNewRefreshToken: !!data.data.refreshToken,
        expiresIn: safeDuration(data.data.expiresIn),
      });

      return {
        accessToken: data.data.accessToken,
        refreshToken: data.data.refreshToken || refreshToken,
        expiresIn: data.data.expiresIn,
      };
    } catch (error) {
      // Every other exit here returns null and lets the caller decide, so a
      // thrown transport error must not be the one that escapes: it surfaced
      // as an unhandled 500 on the request path instead of a refresh failure.
      log?.error?.("TOKEN_REFRESH", "Error refreshing CodeBuddy token", { reason: safeNetworkReason(error) });
      return null;
    }
  }, log);
}

export async function refreshCodebuddyIntlToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codebuddy-intl", refreshToken, async () => {
    try {
      const oauth = PROVIDER_OAUTH["codebuddy-intl"] || {};
      const response = await proxyAwareFetch(oauth.refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": oauth.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "www.codebuddy.ai",
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": "SaaS",
        },
        body: "{}",
      });

      if (!response.ok) {
        const errorText = await response.text();
        log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy intl token", httpFailure(response, errorText));
        return null;
      }

      const data = await response.json();
      if (data.code !== 0 || !data.data?.accessToken) {
        log?.error?.("TOKEN_REFRESH", "CodeBuddy intl token refresh returned no token", { reason: "provider-response" });
        return null;
      }

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy intl token", {
        hasNewAccessToken: !!data.data.accessToken,
        hasNewRefreshToken: !!data.data.refreshToken,
        expiresIn: safeDuration(data.data.expiresIn),
      });

      return {
        accessToken: data.data.accessToken,
        refreshToken: data.data.refreshToken || refreshToken,
        expiresIn: data.data.expiresIn,
      };
    } catch (error) {
      // Every other exit here returns null and lets the caller decide, so a
      // thrown transport error must not be the one that escapes: it surfaced
      // as an unhandled 500 on the request path instead of a refresh failure.
      log?.error?.("TOKEN_REFRESH", "Error refreshing CodeBuddy International token", { reason: safeNetworkReason(error) });
      return null;
    }
  }, log);
}

// Trae refresh — POST ExchangeToken with JSON body {ClientID, RefreshToken, ClientSecret, UserID}.
// Response: {Result: {AccessToken, RefreshToken, TokenType, ExpiresAt}}.
export async function refreshTraeToken(refreshToken, credentials, log) {
  if (!refreshToken) return null;
  const oauth = PROVIDER_OAUTH.trae || {};
  const url = oauth.exchangeTokenUrl || oauth.tokenUrl;
  if (!url) {
    log?.warn?.("TOKEN_REFRESH", "No Trae exchangeTokenUrl configured");
    return null;
  }

  return dedupRefresh("trae", refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Trae/1.0.0 antigravity-cockpit-tools",
        },
        body: JSON.stringify({
          ClientID: oauth.clientId || "ono9krqynydwx5",
          RefreshToken: refreshToken,
          ClientSecret: oauth.clientSecret || "-",
          UserID: "",
        }),
      }, refreshProxyOptions(credentials));

      if (!response.ok) {
        const errorText = await response.text();
        log?.error?.("TOKEN_REFRESH", "Failed to refresh Trae token", httpFailure(response, errorText));
        return null;
      }

      const payload = await response.json();
      const result = payload?.Result || payload?.result || payload;
      const accessToken = result?.AccessToken || result?.accessToken;
      if (!accessToken) {
        log?.error?.("TOKEN_REFRESH", "Trae refresh returned no AccessToken", { reason: "provider-response" });
        return null;
      }

      const newRefresh = result?.RefreshToken || result?.refreshToken || refreshToken;
      const expiresAt = result?.ExpiresAt || result?.expiresAt;
      let expiresIn;
      if (typeof expiresAt === "number") {
        expiresIn = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
      } else if (typeof expiresAt === "string") {
        const ms = new Date(expiresAt).getTime() - Date.now();
        expiresIn = ms > 0 ? Math.floor(ms / 1000) : undefined;
      }

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Trae token", {
        hasNewAccessToken: !!accessToken,
        hasNewRefreshToken: newRefresh !== refreshToken,
        expiresIn,
      });

      return {
        accessToken,
        refreshToken: newRefresh,
        expiresIn,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", "Error refreshing Trae token", { reason: safeNetworkReason(error) });
      return null;
    }
  }, log, null, credentialContentRevision(credentials));
}

// Zed access_token is long-lived; auth flow returns no refresh_token.
// No refresh possible — re-login required when token expires/revoked.
// Mirrors cursor/kilocode null-refresh pattern.
export function refreshZedToken() {
  return null;
}

// Windsurf apiKey is the long-lived terminal credential (no OAuth2 refresh_token
// grant yields a fresh apiKey). Refresh handled out-of-band by the caller.
// TODO(firebase): if short-lived Firebase JWT credentials must be refreshed,
// re-run RegisterUser with the refreshed Firebase JWT (separate code path).
export async function refreshWindsurfToken(credentials, log) {
  log?.info?.(
    "TOKEN_REFRESH",
    "windsurf: apiKey is long-lived (no refresh_token flow) — skipping"
  );
  return null;
}
