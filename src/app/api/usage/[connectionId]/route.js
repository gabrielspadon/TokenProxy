// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import {
  getDailyConnectionUsage,
  getProviderConnectionById,
  updateProviderConnection,
} from "@/lib/localDb";
import * as localDb from "@/lib/localDb";
import { retainQuotaUsage } from "@/lib/db/repos/quotaHistoryRepo.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig, toConnectionProxyOptions } from "@/lib/network/connectionProxy";
import { getCodexSubscriptionEntitlement } from "open-sse/services/usage/codex.js";
import { deriveQuotaSnapshot, isQuotaEligible } from "@/shared/utils/quotaPause.js";
import { runAntigravityUsageProbe } from "@/lib/antigravityVerification";
import { ANTIGRAVITY_SAFE_ERROR_MESSAGE } from "open-sse/services/antigravityValidation.js";
import { runUsageProbe } from "@/lib/usageProbeGate.js";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];

function snapshotOwner(connection) {
  const data = connection.providerSpecificData || {};
  return {
    persistPoolSnapshot: data.proxyPoolId && typeof localDb.updateConnectionProxyPoolSnapshotIfBound === "function"
      ? (pair) => localDb.updateConnectionProxyPoolSnapshotIfBound(connection.id, data.proxyPoolId, pair)
      : undefined,
  };
}

function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  // Update database
  const saved = await updateProviderConnection(connection.id, updateData, { expectedCredentials: connection });
  if (!saved) throw Object.assign(new Error('Account was removed during credential refresh'), { code: 'CREDENTIAL_CONFLICT' });

  return {
    connection: saved,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  const { connectionId } = await params;
  const force = new URL(request.url).searchParams.get("force") === "1";
  // Live provider call, and the dashboard starts one per connection at once.
  // See src/lib/usageProbeGate.js for why that needed a ceiling (#3061).
  try {
    return await runUsageProbe(
      `${connectionId}|${force ? "force" : "cached"}`,
      () => handleUsageRequest(connectionId, force),
      request.signal,
    );
  } catch (err) {
    if (err?.code === "PROBE_QUEUE_FULL") {
      return Response.json({ error: "Too many pending usage probes" }, { status: 429, headers: { "Retry-After": "2" } });
    }
    if (request.signal?.aborted) {
      return new Response(null, { status: 499 });
    }
    throw err;
  }
}

async function handleUsageRequest(connectionId, force) {
  let connection;
  try {

    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Who may be probed is one rule, in @/shared/utils/quotaPause.js, so this
    // route and the list that offers connections to it cannot drift apart —
    // three private copies of it is how a pasted Codex token ended up listed
    // nowhere and probed nowhere (#1322).
    if (!isQuotaEligible(connection)) {
      return Response.json({ message: "Usage not available for this connection" });
    }
    // Narrower than eligibility on purpose: a hand-pasted token carries no
    // refresh token, so only a real OAuth grant takes the refresh branches.
    const isOAuth = connection.authType === "oauth";

    // Resolve the persisted route before refresh or usage egress.
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData, snapshotOwner(connection));
    if (proxyConfig?.kind === "required-unavailable") {
      return Response.json({
        error: "Required proxy is unavailable",
        code: "required_proxy_unavailable",
      }, { status: 503 });
    }
    const proxyOptions = proxyConfig?.kind === "usable"
      ? toConnectionProxyOptions(proxyConfig)
      : { ...(proxyConfig || {}), strictProxy: proxyConfig?.strictProxy === true };

    // Refresh credentials only for OAuth connections (apikey has no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        const safeError = connection.provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : refreshError;
        console.error("[Usage API] Credential refresh failed:", safeError);
        return Response.json({
          error: connection.provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : `Credential refresh failed: ${refreshError.message}`
        }, { status: 401 });
      }
    }

    // Fetch usage from provider API
    let usage = connection.provider === "antigravity"
      ? await runAntigravityUsageProbe(connection, proxyOptions, { force })
      : await getUsageForProvider(connection, proxyOptions, { force });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = connection.provider === "antigravity"
          ? await runAntigravityUsageProbe(connection, proxyOptions, { force })
          : await getUsageForProvider(connection, proxyOptions, { force });
      } catch (retryError) {
        console.warn(
          `[Usage] ${connection.provider}: force refresh failed:`,
          connection.provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : retryError.message,
        );
      }
    }

    // Best-effort: persist a quota snapshot so routing can skip this account
    // when its remaining % drops to/below the per-account pause threshold
    // (see src/sse/services/quotaGuard.js). The remaining % is nested inside
    // usage.quotas, so derive it first. Fail-open — never block the response.
    const snapshot = deriveQuotaSnapshot(connection.provider, usage);
    if (snapshot) {
      updateProviderConnection(connection.id, { lastQuotaSnapshot: snapshot }).catch(() => {});
    }

    await retainQuotaUsage(connection, usage);

    if (
      connection.provider === "grok-cli" &&
      usage?.message?.includes("does not expose a numeric included quota")
    ) {
      const daily = await getDailyConnectionUsage(connection.id);
      const total = 800;
      usage = {
        plan: usage.plan || null,
        quotas: {
          "Daily use": {
            used: daily.requests,
            total,
            remainingPercentage: Math.max(
              0,
              ((total - daily.requests) / total) * 100,
            ),
            resetAt: daily.resetAt,
            unlimited: false,
          },
        },
      };
    }

    // Codex OAuth subscription expiry (fail-open, never affects quota response)
    if (connection.provider === "codex" && connection.authType === "oauth") {
      try {
        const sub = await getCodexSubscriptionEntitlement({
          accessToken: connection.accessToken,
          idToken: connection.idToken,
          providerSpecificData: connection.providerSpecificData,
          proxyOptions,
          force,
          now: Date.now(),
        });
        if (sub) {
          if (sub.subscriptionActiveUntil) usage.subscriptionActiveUntil = sub.subscriptionActiveUntil;
          if (sub.subscriptionPlan) usage.subscriptionPlan = sub.subscriptionPlan;
          if (sub.subscriptionSource) usage.subscriptionSource = sub.subscriptionSource;
          const patch = sub.patch || {};
          const psd = connection.providerSpecificData || {};
          const nextPsd = { ...psd };
          let changed = false;
          for (const k of ["codexSubscriptionActiveUntil","codexSubscriptionPlan","codexSubscriptionSource","codexSubscriptionFetchedAt","codexSubscriptionAttemptAt"]) {
            if (patch[k] !== undefined && patch[k] !== psd[k]) {
              nextPsd[k] = patch[k];
              changed = true;
            }
          }
          if (changed) {
            try { await updateProviderConnection(connection.id, { providerSpecificData: nextPsd }); } catch {}
          }
        }
      } catch {}
    }

    // The quota numbers alone do not say whether routing will actually USE this
    // account. A connection can be disabled, or model-locked after a failure,
    // and the tracker would still show a healthy remaining percentage — so an
    // account being skipped looked identical to one with quota to spare (#1901).
    // Additive: `usage` keeps its shape, and the DB status rides alongside it.
    const now = Date.now();
    const modelLocks = Object.entries(connection)
      .filter(([key, until]) => key.startsWith("modelLock_") && until)
      .map(([key, until]) => ({ model: key.slice("modelLock_".length), until }))
      // An expired lock is cleared lazily elsewhere, so filter by time here
      // rather than reporting a lock that no longer excludes anything.
      .filter(({ until }) => {
        const at = Date.parse(until);
        return Number.isFinite(at) && at > now;
      });

    return Response.json({
      ...usage,
      connectionStatus: {
        // isActive is only false when explicitly disabled; absent means enabled.
        isActive: connection.isActive !== false,
        modelLocks,
        // The same snapshot routing reads, so the UI and the router agree on
        // what "paused" means instead of each deriving it.
        lastQuotaSnapshot: snapshot ?? connection.lastQuotaSnapshot ?? null,
      },
    });
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    const isAntigravity = provider === "antigravity";
    console.warn(`[Usage] ${provider}:`, isAntigravity ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : error.message);
    return Response.json(
      { error: isAntigravity ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : error.message },
      { status: isAntigravity ? 502 : 500 },
    );
  }
}
