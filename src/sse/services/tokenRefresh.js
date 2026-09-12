// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import { getProviderConnectionById, updateProviderConnection } from "../../lib/localDb.js";
import { credentialContentRevision, credentialRevision, waitForRefresh } from "open-sse/services/tokenRefresh/credentialRevision.js";
import { tokenFingerprint } from "open-sse/services/tokenRefresh/dedup.js";
import {
  getProjectIdForConnection,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  getEffectiveRefreshLeadMs as _getEffectiveRefreshLeadMs
} from "open-sse/services/tokenRefresh.js";
import {
  refreshProviderCredentials as _refreshProviderCredentials,
  shouldRefreshCredentials as _shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";
import { createAntigravityVerificationHooks } from "@/lib/antigravityVerification";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

export const shouldRefreshCredentials = (provider, credentials) =>
  _shouldRefreshCredentials(provider, credentials);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connection: tokenFingerprint(connectionId) });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute an ISO expiry timestamp from a relative expiresIn (seconds).
 * @param {number} expiresIn
 * @returns {string}
 */
function toExpiresAt(expiresIn) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

const SELECTED_TRANSPORT_FIELDS = [
  "connectionProxyEnabled",
  "connectionProxyUrl",
  "connectionNoProxy",
  "connectionProxyPoolId",
  "vercelRelayUrl",
  "strictProxy",
  "resolutionKind",
];

function withAuthoritativeConnection(wrapper, authoritative, selectedTransport = null) {
  if (!authoritative || typeof authoritative !== "object") return wrapper;
  const next = { ...wrapper, ...authoritative, _connection: authoritative };
  if (selectedTransport) {
    next.providerSpecificData = { ...(authoritative.providerSpecificData || {}) };
    for (const key of SELECTED_TRANSPORT_FIELDS) {
      if (Object.hasOwn(selectedTransport, key)) {
        next.providerSpecificData[key] = selectedTransport[key];
      }
    }
  }
  return next;
}

function persistenceFailure(error, { reauthRequired = false } = {}) {
  if (error?.code === "CREDENTIAL_PERSISTENCE_UNCONFIRMED") return error;
  return Object.assign(
    new Error("Refreshed credentials were not durably stored; reauthentication may be required"),
    {
      code: "CREDENTIAL_PERSISTENCE_UNCONFIRMED",
      cause: error,
      reauthRequired,
    },
  );
}

function persistenceReason(error) {
  if (error?.code === "CREDENTIAL_CONFLICT") return "conflict";
  if (String(error?.code || "").startsWith("CRITICAL_TRANSACTION_")) return "durability";
  return "storage";
}

function isUncertainCriticalWrite(error) {
  return String(error?.code || "").startsWith("CRITICAL_TRANSACTION_")
    && error?.commitState === "committed";
}

function credentialSelectionChanged() {
  return Object.assign(
    new Error("Credential selection changed during refresh"),
    { code: "CREDENTIAL_SELECTION_CHANGED", retryable: false },
  );
}

function isCompatibleCredentialSelection(expected, winner, { connectionId, provider } = {}) {
  if (!winner || winner.isActive === false) return false;
  const expectedId = expected?.id || expected?.connectionId || connectionId;
  const winnerId = winner.id || winner.connectionId;
  if (expectedId && winnerId !== expectedId) return false;
  const expectedProvider = expected?.provider || provider;
  if (expectedProvider && winner.provider !== expectedProvider) return false;
  if (expected?.authType && winner.authType !== expected.authType) return false;
  return true;
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Skipped when the connection already has a project ID –
 * it never changes on a token rotation.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken, options = {}) {
  if (!needsProjectId(provider) || !connectionId || !accessToken || options.signal?.aborted) return;

  const verificationHooks = provider === "antigravity"
    ? createAntigravityVerificationHooks(connectionId)
    : {};
  if (options.signal) {
    for (const name of ['onValidationRequired','onVerificationSuccess']) {
      const callback = verificationHooks[name];
      if (callback) verificationHooks[name] = (...args) => options.signal.aborted ? false : callback(...args);
    }
  }
  return getProjectIdForConnection(connectionId, accessToken, provider, verificationHooks)
    .then((projectId) => {
      if (!projectId || options.signal?.aborted) return;
      return updateProviderCredentials(connectionId, { projectId }, options).catch(() => {
        log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
          connection: tokenFingerprint(connectionId),
          reason: "persistence",
        });
      });
    })
    .catch(() => {
      log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
        connection: tokenFingerprint(connectionId),
        reason: "lookup",
      });
    });
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

/**
 * Persist updated credentials for a connection to localDb.
 * Only fields that are present in `newCredentials` are written.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @returns {Promise<object>} the authoritative stored connection revision
 */
export async function updateProviderCredentials(connectionId, newCredentials, options = {}) {
  options.signal?.throwIfAborted();
  let current = options.expectedCredentials;
  let candidate = null;
  let rotated = false;
  try {
    const updates = {};

    if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
    if (newCredentials.refreshToken) {
      updates.refreshToken = newCredentials.refreshToken;
      // Additive issue record for CRED.age/chain-diverged
      // (docs/logging-design.md §2 row 42): firstSeen/fp restart only on a
      // real rotation, so an unchanged token keeps its original age.
      current ||= await getProviderConnectionById(connectionId);
      if (!current?.refreshTokenIssuedAt
          || (current.refreshToken && current.refreshToken !== newCredentials.refreshToken)) {
        updates.refreshTokenIssuedAt = new Date().toISOString();
        updates.refreshTokenFp = tokenFingerprint(newCredentials.refreshToken);
      }
    }
    if (newCredentials.idToken)             updates.idToken = newCredentials.idToken;
    if (newCredentials.lastRefreshAt)       updates.lastRefreshAt = newCredentials.lastRefreshAt;
    if (newCredentials.expiresIn) {
      updates.expiresAt = toExpiresAt(newCredentials.expiresIn);
      updates.expiresIn = newCredentials.expiresIn;
    } else if (newCredentials.expiresAt) {
      const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
      if (expiresAt) {
        updates.expiresAt = expiresAt;
        updates.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      }
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = {
        ...(newCredentials.existingProviderSpecificData || {}),
        ...newCredentials.providerSpecificData,
      };
    }
    if (newCredentials.copilotToken || newCredentials.copilotTokenExpiresAt) {
      updates.providerSpecificData = {
        ...(updates.providerSpecificData || newCredentials.existingProviderSpecificData || {}),
        ...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
        ...(newCredentials.copilotTokenExpiresAt ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt } : {}),
      };
    }
    if (newCredentials.projectId)            updates.projectId = newCredentials.projectId;

    options.signal?.throwIfAborted();
    current ||= await getProviderConnectionById(connectionId);
    rotated = !!(
      newCredentials.refreshToken
      && current?.refreshToken
      && newCredentials.refreshToken !== current.refreshToken
    );
    candidate = current ? { ...current, ...updates } : null;
    const result = await updateProviderConnection(connectionId, updates, {
      expectedCredentials: current,
      durability: "critical",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!result || typeof result !== "object") throw persistenceFailure(null, { reauthRequired: rotated });
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connection: tokenFingerprint(connectionId),
      status: "acknowledged",
    });
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error?.code === "CREDENTIAL_CONFLICT") {
      const winner = await getProviderConnectionById(connectionId);
      if (!isCompatibleCredentialSelection(current, winner, { connectionId })) {
        throw credentialSelectionChanged();
      }
      return winner;
    }
    if (isUncertainCriticalWrite(error) && candidate) {
      const stored = await getProviderConnectionById(connectionId);
      if (stored && credentialContentRevision(stored) === credentialContentRevision(candidate)) {
        return stored;
      }
    }
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connection: tokenFingerprint(connectionId),
      reason: persistenceReason(error),
    });
    throw persistenceFailure(error, { reauthRequired: rotated });
  }
}

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Check whether the provider token (and, for GitHub, the Copilot token) is
 * about to expire and refresh it proactively.
 *
 * @param {string} provider
 * @param {object} credentials
 * @param {{ force?: boolean }} [options]  force=true skips the on-request lead check
 *   (used by background scheduler which applies a larger lead). Request path omits this.
 * @returns {Promise<object>} updated credentials object
 */
export async function checkAndRefreshToken(provider, credentials, options = {}) {
  let creds = { ...credentials };
  if (!creds.connectionId && creds.id) {
    creds.connectionId = creds.id;
  }

  const signal = options.signal;
  const waitSignal = options.waitForSettled ? undefined : signal;
  signal?.throwIfAborted();
  const stored = creds.connectionId ? await getProviderConnectionById(creds.connectionId) : null;
  signal?.throwIfAborted();
  const selected = credentials._connection || credentials;
  if (!stored && (options.requireCurrent || credentials._connection)) {
    throw credentialSelectionChanged();
  }
  if (stored && (
    !isCompatibleCredentialSelection(selected, stored, { connectionId: creds.connectionId, provider })
    || stored.authType && stored.authType !== "oauth"
  )) {
    throw credentialSelectionChanged();
  }
  if (stored) {
    const selectedTransport = !options.requireCurrent && credentials._connection
      && credentialRevision(credentials._connection) === credentialRevision(stored)
      ? credentials.providerSpecificData : null;
    creds = withAuthoritativeConnection(creds, stored, selectedTransport);
    if (!selectedTransport && stored.providerSpecificData?.proxyPoolId) {
      const {resolveConnectionProxyConfig,toConnectionProxyOptions} = await import('@/lib/network/connectionProxy');
      const proxy = await resolveConnectionProxyConfig(stored.providerSpecificData);
      signal?.throwIfAborted();
      if (proxy.kind !== 'usable') return creds;
      creds.providerSpecificData = {...stored.providerSpecificData,...toConnectionProxyOptions(proxy)};
    }
  }
  const force = options?.force === true;

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (force || _shouldRefreshCredentials(provider, creds)) {
    const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : null;
    const remaining = expiresAt ? expiresAt - Date.now() : null;
    const refreshLead = _getEffectiveRefreshLeadMs(provider, creds);

    log.info("TOKEN_REFRESH", "Refreshing provider credentials proactively", {
      provider,
      expiresIn: remaining === null ? null : Math.round(remaining / 1000),
      refreshLeadMs: refreshLead,
      lastRefreshAt: creds.lastRefreshAt || null,
    });

    const expectedCredentials = stored || creds;
    const newCreds = await _refreshProviderCredentials(provider, creds, log, {
      signal: waitSignal,
      expectedCredentials,
      onCredentialsRefreshed: (refreshed, context) => updateProviderCredentials(
        creds.connectionId,
        { ...refreshed, existingProviderSpecificData: creds.providerSpecificData },
        { expectedCredentials: context.expectedCredentials },
      ),
    });
    signal?.throwIfAborted();
    if (newCreds?.error === "unrecoverable_refresh_error" || newCreds?.error === "invalid_grant") {
      throw Object.assign(new Error("Credential refresh was rejected; reauthentication is required"), {
        code: "REAUTH_REQUIRED",
        reauthRequired: true,
      });
    }
    if (newCreds?.accessToken || newCreds?.apiKey || newCreds?.copilotToken) {
      // A durable publisher returns the repository's authoritative row. Keep
      // that exact revision so a CAS winner never inherits stale caller fields.
      creds = withAuthoritativeConnection(creds, newCreds, creds.providerSpecificData);

      // Non-blocking: fetch projectId only when the connection has none
      if (!creds.projectId && needsProjectId(provider)) {
        const activeConnectionId = creds.connectionId || creds.id;
        const current = await getProviderConnectionById(activeConnectionId);
        signal?.throwIfAborted();
        if (!current || current.isActive !== false && current.accessToken === creds.accessToken) {
          const projectWork = _refreshProjectId(provider, activeConnectionId, creds.accessToken, {expectedCredentials:current || creds,signal});
          if (options.waitForSettled) await projectWork;
          signal?.throwIfAborted();
        }
      }
    }
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  signal?.throwIfAborted();
  if (provider === "github") {
    const copilotToken = creds.providerSpecificData?.copilotToken;
    const copilotExpiresAt = creds.providerSpecificData?.copilotTokenExpiresAt
      ? creds.providerSpecificData.copilotTokenExpiresAt * 1000
      : 0;
    const now              = Date.now();
    const remaining        = copilotExpiresAt - now;

    if (!copilotToken || remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon or missing, refreshing proactively", {
        provider,
        expiresIn: copilotToken ? Math.round(remaining / 1000) : "missing",
      });

      const activeConnectionId = creds.connectionId || creds.id;
      const copilotSnapshot = activeConnectionId ? await getProviderConnectionById(activeConnectionId) : creds;
      signal?.throwIfAborted();
      if (stored && !copilotSnapshot) return creds;
      if (copilotSnapshot?.isActive === false || copilotSnapshot?.provider && copilotSnapshot.provider !== provider) {
        return withAuthoritativeConnection(creds, copilotSnapshot);
      }
      if (copilotSnapshot) {
        creds = withAuthoritativeConnection(creds, copilotSnapshot, creds.providerSpecificData);
      }
      const copilotOwner = Promise.resolve(refreshCopilotToken(creds.accessToken)).then(async (copilotTokenResult) => {
        if (!copilotTokenResult) return null;
        const updatedSpecific = {
          ...creds.providerSpecificData,
          copilotToken: copilotTokenResult.token,
          copilotTokenExpiresAt: copilotTokenResult.expiresAt,
        };
        return updateProviderCredentials(
          activeConnectionId,
          { providerSpecificData: updatedSpecific },
          { expectedCredentials: copilotSnapshot || creds },
        );
      });
      const copilotTokenResult = await waitForRefresh(copilotOwner,waitSignal);
      signal?.throwIfAborted();
      if (copilotTokenResult) {
        creds = withAuthoritativeConnection(
          creds,
          copilotTokenResult,
          creds.providerSpecificData,
        );
        creds.copilotToken = copilotTokenResult.providerSpecificData?.copilotToken;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken:          copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}
