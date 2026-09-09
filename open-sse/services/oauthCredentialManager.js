import {
  getEffectiveRefreshLeadMs,
  isUnrecoverableRefreshError,
  refreshTokenByProvider,
} from "./tokenRefresh.js";
import { PROVIDER_OAUTH } from "../providers/index.js";

import { credentialRevision, credentialContentRevision, waitForRefresh } from "./tokenRefresh/credentialRevision.js";
import { MAX_REFRESH_ENTRIES, withRefreshContext } from "./tokenRefresh/dedup.js";

// Single source: codex.oauth.maxRefreshAgeMs (8 days) — proactive refresh window
export const CODEX_MAX_REFRESH_AGE_MS = PROVIDER_OAUTH["codex"]?.maxRefreshAgeMs;

const refreshLocks = new Map();

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toExpiresAt(expiresIn, nowMs = Date.now()) {
  if (!expiresIn) return null;
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

export function getCredentialExpiryMs(credentials) {
  return parseTimeMs(credentials?.expiresAt ?? credentials?.tokenExpiresAt);
}

export function getCredentialLastRefreshMs(credentials) {
  return parseTimeMs(
    credentials?.lastRefreshAt ??
    credentials?.lastRefresh ??
    credentials?.providerSpecificData?.lastRefreshAt
  );
}

export function isCodexRefreshStale(credentials, nowMs = Date.now(), maxAgeMs = CODEX_MAX_REFRESH_AGE_MS) {
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  return !lastRefreshMs || nowMs - lastRefreshMs >= maxAgeMs;
}

export function shouldRefreshCredentials(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return false;

  const expiresAtMs = getCredentialExpiryMs(credentials);
  if (
    expiresAtMs !== null &&
    expiresAtMs - nowMs < getEffectiveRefreshLeadMs(provider, credentials, nowMs)
  ) {
    return true;
  }

  // Proactive stale refresh for providers declaring oauth.maxRefreshAgeMs (e.g. codex)
  const maxAgeMs = PROVIDER_OAUTH[provider]?.maxRefreshAgeMs;
  if (maxAgeMs && credentials.refreshToken && isCodexRefreshStale(credentials, nowMs, maxAgeMs)) {
    return true;
  }

  return false;
}

export function mergeProviderSpecificData(existing, next) {
  if (!next || typeof next !== "object") return existing;
  return {
    ...(existing || {}),
    ...next,
  };
}

export function mergeRefreshedCredentials(provider, currentCredentials, refreshedCredentials, nowMs = Date.now()) {
  if (!refreshedCredentials) return null;
  if (isUnrecoverableRefreshError(refreshedCredentials)) return refreshedCredentials;

  const next = {};
  const nowIso = new Date(nowMs).toISOString();

  if (refreshedCredentials.accessToken) next.accessToken = refreshedCredentials.accessToken;
  if (refreshedCredentials.apiKey) next.apiKey = refreshedCredentials.apiKey;
  if (refreshedCredentials.token) next.token = refreshedCredentials.token;

  const refreshToken = refreshedCredentials.refreshToken ?? currentCredentials?.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;

  const idToken = refreshedCredentials.idToken ?? currentCredentials?.idToken;
  if (idToken) next.idToken = idToken;

  if (refreshedCredentials.expiresIn) {
    next.expiresIn = refreshedCredentials.expiresIn;
    next.expiresAt = toExpiresAt(refreshedCredentials.expiresIn, nowMs);
  } else if (refreshedCredentials.expiresAt) {
    next.expiresAt = refreshedCredentials.expiresAt;
  }

  if (refreshedCredentials.projectId) next.projectId = refreshedCredentials.projectId;

  if (refreshedCredentials.providerSpecificData) {
    next.providerSpecificData = mergeProviderSpecificData(
      currentCredentials?.providerSpecificData,
      refreshedCredentials.providerSpecificData
    );
  }

  if (refreshedCredentials.copilotToken) next.copilotToken = refreshedCredentials.copilotToken;
  if (refreshedCredentials.copilotTokenExpiresAt) {
    next.copilotTokenExpiresAt = refreshedCredentials.copilotTokenExpiresAt;
  }

  // trackRefreshAt providers (e.g. codex) always stamp lastRefreshAt for staleness tracking
  if (
    PROVIDER_OAUTH[provider]?.trackRefreshAt ||
    next.accessToken ||
    next.apiKey ||
    next.token ||
    next.refreshToken ||
    next.copilotToken
  ) {
    next.lastRefreshAt = refreshedCredentials.lastRefreshAt || nowIso;
  }

  return next;
}

function getRefreshLockKey(provider, credentials) {
  const stableId = credentials?.connectionId || credentials?.id || "unbound";
  return `${provider}:${stableId}:${credentialRevision(credentials)}`;
}

export async function withCredentialRefreshLock(provider, credentials, refreshFn) {
  const key = getRefreshLockKey(provider, credentials);
  const existing = refreshLocks.get(key);
  if (existing) return existing;

  if (refreshLocks.size >= MAX_REFRESH_ENTRIES) throw Object.assign(new Error("Refresh capacity reached; retry later"), {code:"REFRESH_CAPACITY"});
  const pending = Promise.resolve()
    .then(refreshFn)
    .finally(() => {
      refreshLocks.delete(key);
    });

  refreshLocks.set(key, pending);
  return pending;
}

export async function refreshProviderCredentials(provider, credentials, log, {signal} = {}) {
  if (!credentials) return null;
  signal?.throwIfAborted();

  return waitForRefresh(withCredentialRefreshLock(provider, credentials, async () => {
    const refreshed = await withRefreshContext({revision:credentialContentRevision(credentials),credentialRevision:credentialRevision(credentials),credentials}, () => refreshTokenByProvider(provider, credentials, log));
    return mergeRefreshedCredentials(provider, credentials, refreshed);
  }),signal);
}
