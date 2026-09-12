/**
 * Quota guard — pause an account when its remaining quota drops to/below a
 * per-account threshold so it keeps a safety buffer instead of hitting 0%.
 *
 * Design (see plan):
 *  - Per-account thresholds are `connection.quotaPauseThresholds` (a map of
 *    windowKey -> %, e.g. { "session (5h)": 15, "weekly (7d)": 30 }). 0/undefined = off.
 *  - The "remaining %" is known from a quota snapshot. Primary source is a
 *    snapshot persisted onto the connection (`lastQuotaSnapshot`) whenever the
 *    dashboard Quota Tracker / auto-ping fetches usage. On a cache miss we do a
 *    live fetch (timeout-wrapped) to refresh.
 *  - Paused state is derived, never persisted: once remaining% climbs back above
 *    the threshold (e.g. after resetAt) the account auto-recovers for routing.
 *  - Fail-open: if quota can't be determined (no data, ineligible provider, fetch
 *    error/timeout) the account is NEVER paused.
 */

import { retainQuotaUsage } from "@/lib/db/repos/quotaHistoryRepo.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig, toConnectionProxyOptions } from "@/lib/network/connectionProxy";
import { updateProviderConnection } from "@/lib/localDb";
import * as localDb from "@/lib/localDb";
import { isQuotaEligible, isQuotaPaused, deriveQuotaSnapshot } from "@/shared/utils/quotaPause.js";
import { runAntigravityUsageProbe } from "@/lib/antigravityVerification";
import { requestSignal, withRequestLifetime } from "open-sse/utils/requestLifetime.js";
import { waitForPreparation } from "open-sse/utils/preparationAbort.js";
import { quotaEvidenceIdentity } from "./quotaEvidenceIdentity.js";

// How long a snapshot (memory or persisted) stays fresh before a live refresh.
const CACHE_TTL_MS = 2 * 60 * 1000;
// Bound latency of an on-demand live fetch inside the routing path.
const LIVE_FETCH_TIMEOUT_MS = 3000;
const NEGATIVE_CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 1024;

// Module-level in-memory cache to avoid a live provider fetch on every request.
// key: connectionId -> { snapshot, fetchedAt }
const memoryCache = new Map();

// P-F2: one in-flight live refresh per connection. Concurrent cache misses
// share a single fetch instead of each stalling the selection queue on its
// own up-to-3s provider call.
const inFlightRefreshes = new Map();
const negativeCache = new Map();

function setBounded(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

function freshSnapshot(snapshot, fetchedAt) {
  if (!snapshot || !fetchedAt) return null;
  const ts = typeof fetchedAt === "number" ? fetchedAt : new Date(fetchedAt).getTime();
  if (!Number.isFinite(ts)) return null;
  if (Date.now() - ts >= CACHE_TTL_MS) return null;
  return snapshot;
}

function readSnapshot(connection, identity) {
  const cached = memoryCache.get(connection.id);
  if (cached?.identity === identity) {
    const s = freshSnapshot(cached.snapshot, cached.fetchedAt);
    if (s) return s;
  }
  const persisted = connection.lastQuotaSnapshot;
  if (persisted?.evidenceIdentity !== identity) return null;
  if (persisted) {
    const s = freshSnapshot(persisted, persisted.fetchedAt);
    if (s) {
      setBounded(memoryCache, connection.id, { identity, snapshot: s, fetchedAt: Date.parse(s.fetchedAt) });
      return s;
    }
  }
  return null;
}

// P-F2: the stale-but-usable answer. Anything we have is better than holding
// the admission queue for a live fetch, so a TTL-expired snapshot still gates
// (isQuotaPaused auto-recovers a window past its resetAt) while a refresh
// catches up in the background.
function staleSnapshot(connection, identity) {
  const cached = memoryCache.get(connection.id);
  if (cached?.identity === identity && cached.snapshot) return cached.snapshot;
  if (cached && cached.identity !== identity) return null;
  const persisted = connection.lastQuotaSnapshot;
  if (persisted?.evidenceIdentity !== identity) return null;
  if (persisted) setBounded(memoryCache, connection.id, { identity, snapshot: persisted, fetchedAt: Date.parse(persisted.fetchedAt) });
  return persisted || null;
}

function snapshotOwner(connection) {
  const data = connection.providerSpecificData || {};
  return {
    persistPoolSnapshot: data.proxyPoolId && typeof localDb.updateConnectionProxyPoolSnapshotIfBound === "function"
      ? (pair) => localDb.updateConnectionProxyPoolSnapshotIfBound(connection.id, data.proxyPoolId, pair)
      : undefined,
  };
}

function buildProxyOptions(connection) {
  // Reuse the same proxy resolution as the usage API, preserving a selected
  // route's strictness through the quota fetch.
  return resolveConnectionProxyConfig(connection.providerSpecificData || {}, snapshotOwner(connection)).then((proxyConfig) => {
    if (proxyConfig?.kind === "required-unavailable") return proxyConfig;
    if (proxyConfig?.kind === "usable") return toConnectionProxyOptions(proxyConfig);
    return { ...(proxyConfig || {}), strictProxy: proxyConfig?.strictProxy === true };
  });
}

async function fetchLiveSnapshot(connection, providedProxyOptions, signal) {
  const proxyOptions = providedProxyOptions || await buildProxyOptions(connection);
  if (proxyOptions?.kind === "required-unavailable") return { snapshot: proxyOptions, rawUsage: null };
  const usagePromise = connection.provider === "antigravity"
    ? runAntigravityUsageProbe(connection, proxyOptions, { signal })
    : getUsageForProvider(connection, proxyOptions, { signal });
  const usage = await waitForPreparation(usagePromise, signal);
  signal.throwIfAborted();
  // getUsageForProvider nests remaining % inside `usage.quotas`; derive the
  // single gating snapshot (most-depleted window) from it. null → fail-open.
  // The raw payload is returned alongside it (not just the snapshot) so a
  // caller can hand both to quotaWindowBridge.js and upgrade ranking from the
  // synthetic percentage scale to the provider's own absolute units.
  const snapshot = deriveQuotaSnapshot(connection.provider, usage);
  return { snapshot: snapshot || null, rawUsage: usage };
}

function storeSnapshot(connection, snapshot, identity, signal) {
  const stored = { ...snapshot, evidenceIdentity: identity };
  setBounded(memoryCache, connection.id, { snapshot: stored, identity, fetchedAt: Date.parse(snapshot.fetchedAt) });
  // Best-effort persistence so the dashboard and subsequent routing reads stay warm.
  updateProviderConnection(connection.id, { lastQuotaSnapshot: stored }, { expectedCredentials: connection, signal }).catch(() => {});
}

// Run one live fetch and, when it produced a usable snapshot, warm both caches.
// Fail-open is preserved by the caller: a rejection here never pauses anything.
async function runLiveRefresh(connection, proxyOptions, entry) {
  const { signal } = entry.controller;
  const timer = setTimeout(() => entry.controller.abort(new DOMException('Quota evidence timeout', 'TimeoutError')), LIVE_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const fetched = await fetchLiveSnapshot(connection, proxyOptions, signal);
    signal.throwIfAborted();
    if (inFlightRefreshes.get(connection.id) !== entry) return { snapshot: null, rawUsage: null, failureClass: 'superseded' };
    if (fetched?.snapshot?.kind === 'required-unavailable') return fetched;
    if (fetched?.snapshot) {
      negativeCache.delete(connection.id);
      storeSnapshot(connection, fetched.snapshot, entry.identity, signal);
    } else {
      setBounded(negativeCache, connection.id, { identity: entry.identity, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS, failureClass: 'empty' });
    }
    await waitForPreparation(retainQuotaUsage(connection, fetched?.rawUsage), signal);
    return { ...fetched, ...(!fetched?.snapshot ? { failureClass: 'empty' } : {}) };
  } catch (error) {
    const failureClass = error?.name === 'TimeoutError' ? 'timeout' : signal.aborted ? 'superseded' : 'fetch-error';
    if (inFlightRefreshes.get(connection.id) === entry && failureClass !== 'superseded') {
      setBounded(negativeCache, connection.id, { identity: entry.identity, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS, failureClass });
    }
    return { snapshot: null, rawUsage: null, failureClass };
  } finally {
    clearTimeout(timer);
  }
}

// Deduped per connection: the first miss starts the fetch, every concurrent
// miss (and the background revalidator) awaits the same promise.
function scheduleRefresh(connection, proxyOptions, identity) {
  const negative = negativeCache.get(connection.id);
  if (negative?.identity === identity && negative.expiresAt > Date.now()) {
    return Promise.resolve({ snapshot: null, rawUsage: null, failureClass: negative.failureClass });
  }
  let entry = inFlightRefreshes.get(connection.id);
  if (entry?.identity !== identity) {
    entry?.controller.abort(new DOMException('Quota credentials changed', 'AbortError'));
    entry = { identity, controller: new AbortController(), promise: null };
    inFlightRefreshes.set(connection.id, entry);
    const owned = entry;
    // A cancelled subscriber cannot cancel other waiters or poison a shared
    // metadata refresh. This owner has its own bounded lifetime.
    entry.promise = withRequestLifetime(undefined, () => runLiveRefresh(connection, proxyOptions, owned)).finally(() => {
      if (inFlightRefreshes.get(connection.id) === owned) inFlightRefreshes.delete(connection.id);
    });
  }
  return entry.promise;
}

/**
 * Decide whether an account should be skipped for routing due to low quota.
 *
 * Evidence acquisition is unconditional on anything the PAUSE gate cares
 * about: a quota read runs whenever the account is eligible and reachable,
 * whether or not any window threshold is configured. `isQuotaPaused` already
 * answers "never" when no threshold is set (quotaPause.js:36-45's thresholds
 * map is empty, so every window's `normalizeWindowThreshold` is 0 and no
 * window can trigger), so gating the FETCH on the same condition only starved
 * the ranker, the quotaWindows table and the admin surface of evidence that
 * was never going to pause anything anyway.
 * @param {Object} connection
 * @returns {Promise<{paused:boolean, reason:string, snapshot:Object|null, rawUsage:Object|null}>}
 *   `rawUsage` is the provider's own payload from THIS call's live fetch, for
 *   quotaWindowBridge.js to convert onto the ranker's absolute-unit scale. It
 *   is null on a cache hit (no live fetch ran) or when the read produced no
 *   usable snapshot, so it is never paired with evidence it did not produce.
 */
export async function evaluateQuota(connection, { proxyOptions: providedProxyOptions } = {}) {
  const signal = requestSignal();
  signal?.throwIfAborted();
  if (!isQuotaEligible(connection)) return { paused: false, reason: "ineligible", snapshot: null, rawUsage: null };

  const proxyOptions = providedProxyOptions || await waitForPreparation(buildProxyOptions(connection), signal);
  signal?.throwIfAborted();
  if (proxyOptions?.kind === "required-unavailable") {
    return {
      paused: false,
      reason: "required-proxy-unavailable",
      code: "required_proxy_unavailable",
      snapshot: null,
      rawUsage: null,
    };
  }

  const identity = quotaEvidenceIdentity(connection, proxyOptions);
  let snapshot = readSnapshot(connection, identity);
  let rawUsage = null;
  let failureClass = null;
  if (!snapshot) {
    const stale = staleSnapshot(connection, identity);
    if (stale) {
      // P-F2: serve the stale snapshot now, refresh asynchronously. The next
      // request sees fresh evidence; this one never waits on the provider.
      snapshot = stale;
      scheduleRefresh(connection, proxyOptions, identity).catch(() => {});
    } else {
      // No evidence anywhere: one deduped live fetch, awaited — the only case
      // an admission still waits on the provider, and only the first one in.
      try {
        const fetched = await waitForPreparation(scheduleRefresh(connection, proxyOptions, identity), signal);
        signal?.throwIfAborted();
        failureClass = fetched?.failureClass || null;
        if (fetched?.snapshot?.kind === "required-unavailable") {
          return {
            paused: false,
            reason: "required-proxy-unavailable",
            code: "required_proxy_unavailable",
            snapshot: null,
            rawUsage: null,
          };
        }
        snapshot = fetched?.snapshot ?? null;
        // Only carried alongside the snapshot it produced: a null snapshot means
        // deriveQuotaSnapshot found no usable quotas in it, and pairing it with
        // a DIFFERENT (persisted) snapshot below would mislabel stale evidence
        // as fresh.
        rawUsage = snapshot ? fetched?.rawUsage ?? null : null;
      } catch {
        signal?.throwIfAborted();
        snapshot = null;
        failureClass = 'fetch-error';
      }
    }
  }

  const paused = isQuotaPaused({ ...connection, lastQuotaSnapshot: snapshot });
  return {
    paused,
    reason: paused ? "below-threshold" : snapshot ? "ok" : "no-data",
    snapshot,
    rawUsage,
    ...(failureClass ? { failureClass } : {}),
  };
}

/**
 * Synchronous info for the dashboard UI (badge + threshold control).
 * Re-exported from the shared pure helper so callers only import one place.
 * Reads the persisted snapshot as-is (the Quota Tracker keeps it fresh).
 */
export { getQuotaPauseInfo } from "@/shared/utils/quotaPause.js";

// Exposed for tests / cache invalidation.
export function _clearQuotaCache(connectionId) {
  if (connectionId) {
    memoryCache.delete(connectionId);
    negativeCache.delete(connectionId);
    inFlightRefreshes.get(connectionId)?.controller.abort(new DOMException('Quota cache invalidated', 'AbortError'));
    inFlightRefreshes.delete(connectionId);
  } else {
    memoryCache.clear();
    negativeCache.clear();
    for (const entry of inFlightRefreshes.values()) entry.controller.abort(new DOMException('Quota cache invalidated', 'AbortError'));
    inFlightRefreshes.clear();
  }
}
