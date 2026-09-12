/**
 * Claude usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";

// Claude API config (urls from registry, apiVersion is header logic kept here)
const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  usageUrl: U("claude").orgUrl,
  settingsUrl: U("claude").settingsUrl,
  apiVersion: ANTHROPIC_API_VERSION,
};

// OAuth usage endpoint rate-limits (429); cool down per-token to stop hammering it.
// Only the quota endpoint is affected — chat with the same token still works.
const OAUTH_429_COOLDOWN_MS = 180000;
const oauthCooldown = new Map();

// Dedup + short TTL cache per access token. Many tabs / many accounts / auto-refresh
// all funnel through here; without this each call hits Anthropic and triggers 429.
const USAGE_CACHE_TTL_MS = 300000;
const usageCache = new Map(); // token -> { promise } | { result, expiresAt }

// Both maps are keyed by access token, and an OAuth token rotates on every
// refresh, so nothing ever revisited the old key: the maps grew one dead entry
// per refresh for the life of the process (#2848). Insertion-ordered eviction is
// enough here -- entries are all the same cheap shape and all carry their own
// expiry, so the oldest is always the safest to drop.
const MAX_CACHE_ENTRIES = 128;
function setBounded(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

export async function getClaudeUsage(accessToken, proxyOptions = null, options = {}) {
  // A bounded metadata owner (the routing quota cache) already coalesces its
  // subscribers. Its timeout must not cancel the dashboard's separate cached
  // read or publish an aborted result into that cache.
  if (options.signal) {
    options.signal.throwIfAborted();
    const result = await fetchClaudeUsageRaw(accessToken, { ...(proxyOptions || {}), signal: options.signal });
    options.signal.throwIfAborted();
    return result;
  }
  const force = options?.force === true;

  // Serve in-flight or fresh cached result (skip on manual force)
  if (!force && accessToken) {
    const hit = usageCache.get(accessToken);
    if (hit?.promise) return hit.promise;
    if (hit && hit.expiresAt > Date.now()) return hit.result;
  }

  const stale = (!force && accessToken && usageCache.get(accessToken)?.result) || null;

  const promise = (async () => {
    try {
      const result = await fetchClaudeUsageRaw(accessToken, proxyOptions);
      // Only cache real quota data, not soft-failure {message: ...} payloads
      if (accessToken && result?.quotas) {
        setBounded(usageCache, accessToken, {
          result,
          expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
        });
        return result;
      }
      // Soft failure (429/error): prefer the last good read over a transient error.
      // A dead credential is not transient, so its expiry must reach the caller
      // rather than be papered over with the quota it had before it died.
      if (stale && !result?.expired) return stale;
      return result;
    } finally {
      // The in-flight marker was only ever replaced by a cacheable result, so a
      // soft failure left a settled promise in the map and every later call was
      // answered with that same failure for the life of the process (#2848).
      if (accessToken && usageCache.get(accessToken)?.promise === promise) {
        usageCache.delete(accessToken);
      }
    }
  })();

  if (accessToken) setBounded(usageCache, accessToken, { promise });
  return promise;
}

async function fetchClaudeUsageRaw(accessToken, proxyOptions = null) {
  try {
    // Skip OAuth usage call while this token is cooling down from a recent 429
    const cooldownUntil = oauthCooldown.get(accessToken);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return await getClaudeUsageLegacy(accessToken, proxyOptions);
    }

    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    const oauthResponse = await proxyAwareFetch(CLAUDE_CONFIG.oauthUsageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      return {
        plan: "Claude Code",
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
    }

    // A 401 is the credential itself, not the quota endpoint: every cached read
    // for this token is worthless and the legacy leg can only fail the same way.
    // Purge and report the expiry so the account surfaces as needing a reconnect
    // instead of showing the quota it had while it still worked (#2848).
    if (oauthResponse.status === 401) {
      usageCache.delete(accessToken);
      oauthCooldown.delete(accessToken);
      return { expired: true, message: "Claude credential expired. Reconnect the account." };
    }

    // Cool down OAuth usage polling after a 429 (quota endpoint only)
    if (oauthResponse.status === 429) {
      setBounded(oauthCooldown, accessToken, Date.now() + OAUTH_429_COOLDOWN_MS);
    }

    // Fallback: legacy settings + org usage endpoint
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    return await getClaudeUsageLegacy(accessToken, proxyOptions);
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}
