import {
  getProviderConnections,
  validateApiKey,
  updateProviderConnection,
  updateConnectionProxyPoolSnapshotIfBound,
  updateProviderStrategyProxyPoolSnapshotIfBound,
  getSettings,
  getProxyPools,
} from "@/lib/localDb";
import {
  resolveConnectionProxyConfig,
  toConnectionProxyOptions,
  pickProxyPoolId,
} from "@/lib/network/connectionProxy";
import {
  buildModelFailureUpdate,
  buildModelLockUpdateAt,
  checkFallbackError,
  formatRetryAfter,
  getActiveModelFailure,
  getEarliestModelLockUntil,
  getModelFailureKey,
  getModelLockKey,
  isModelLockActive,
} from "open-sse/services/accountFallback.js";
import { FREE_TIER_RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { ACCOUNT_ERROR_MESSAGE_MAX_CHARS } from "open-sse/config/runtimeConfig.js";
import { resolveProviderId, NO_AUTH_PROVIDER_IDS, isNoAuthProvider, isProviderDisabled, FREE_PROVIDERS, FREE_TIER_PROVIDERS } from "@/shared/constants/providers.js";
import { createHash } from "node:crypto";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import { readAllDrainDocs } from "@/lib/admin/state.js";
import { evaluateQuota } from "./quotaGuard.js";
import { selectAndReserve } from "./accountScheduler.js";
import { createSchedulerRepos } from "./schedulerRepos.js";
import {
  leaseRegistry,
  registerAccountCapacity,
  releaseAccountLease,
  releaseAccountLeaseOnResponse,
  lastLeaseRefusal,
  _getLeaseRegistry,
} from "./accountLeaseRegistry.js";
import { decide } from "@/shared/observability/decide.js";

// The design's id shape is a literal 8-char prefix (conn=acc_9f2c). decide's
// idPrefix is a SHA-256 prefix and is for credentials, not connection ids.
const prefix8 = (v) => String(v ?? '').slice(0, 8);
import { effectiveCapacity } from "@/shared/utils/accountCapacity.js";
import { toRankerWindows } from "@/shared/utils/quotaWindowBridge.js";
import { buildSwitchReceipt } from "@/shared/utils/switchReceipt.js";
import { putWindows } from "@/lib/db/repos/quotaWindowsRepo.js";
import * as log from "../utils/logger.js";
import { collectClientApiKeyCandidates } from "@/lib/auth/clientApiKey";

// Serialize account selection per canonical provider without blocking unrelated providers.
const providerSelectionQueues = new Map();

export function _getProviderSelectionQueueSize() {
  return providerSelectionQueues.size;
}

// overlay-spec §4: a local admission refusal always carries a nonzero
// retry-after, so a caller is never told to retry with no delay hint at all.
// Mirrors accountScheduler.js's own RETRY_AFTER_SECONDS.
const SCHEDULER_RETRY_AFTER_SECONDS = 1;
// Local, so this module does not take a dependency on the handler's status
// table just to name one code.
const HTTP_STATUS_RATE_LIMITED = 429;

// The affinity table is keyed by (sessionHash, model) and both are NOT NULL, so
// a request that names no model still needs a key. A sentinel rather than the
// empty string keeps the row legible and keeps a modelless request from sharing
// a pin with a request for a model literally named "".
const MODEL_ANY = "*";

/**
 * The HASH of this request's client session identity — never the raw id.
 *
 * open-sse/utils/sessionManager.js is the single session-identity authority in
 * this codebase, so `resolveSessionIdentity` resolves WHICH session this is and
 * nothing here invents a second scheme. What reaches the affinity table and the
 * switch receipt is sha256 of that id, truncated the same way sessionManager's
 * own `sha16` truncates, so rule 8 holds by construction: a raw session id, a
 * bearer token or a prompt body cannot be written even by mistake, because the
 * only value that leaves this function is a digest.
 *
 * A request that carries no session evidence at all still gets a stable key
 * from the provider node, which pins every anonymous caller of one provider
 * together. That is the honest reading: with no way to tell two callers apart,
 * claiming they are separate sessions would be a fabricated distinction.
 *
 * WHY THE IDENTITY IS RESOLVED TWICE. resolveSessionIdentity never reports "no
 * evidence"; with none it falls through to deriveSessionId(connectionId), and
 * selection has no connection yet by construction, so that arm returns
 * generateBinaryStyleId() — `crypto.randomUUID() + Date.now()`, a DIFFERENT
 * value on every call (sessionManager.js:45 and :81). Hashing that would give
 * every request its own pin: affinity could never hit, and sessionAffinity
 * would gain one dead row per request forever. A client-derived id (a header,
 * a prompt_cache_key, the assistant-text digest) is a pure function of the same
 * inputs, so it reproduces. Comparing two resolutions is therefore the exact
 * test for "did this come from the client", and it needs nothing from
 * sessionManager that is not already exported. An id that does not reproduce
 * carries no session information and is treated as anonymous.
 */
function resolveRoutingSessionHash(options, providerId) {
  let sessionId = null;
  const headers = options?.clientHeaders || null;
  const body = options?.clientBody || null;
  if (headers || body) {
    try {
      const args = { headers, body, scope: providerId };
      const first = resolveSessionIdentity(args);
      // ephemeral is sessionManager's own "this id is disposable" flag (kiro).
      if (!first?.ephemeral && first?.sessionId
          && first.sessionId === resolveSessionIdentity(args)?.sessionId) {
        sessionId = first.sessionId;
      }
    } catch {
      // An identity resolution failure must not fail the request. Falling back
      // to the provider node makes the session read as a shared anonymous one,
      // which still ranks and still pins, rather than throwing inside selection.
      sessionId = null;
    }
  }
  return createHash("sha256")
    .update(`${providerId}:${sessionId || "anonymous"}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Make an OPERATOR pin durable, the way selectAndReserve makes the scheduler's
 * own choice durable.
 *
 * WHY THIS EXISTS. The operator branch below reserved a lease and returned,
 * calling neither setPin nor touchPin, so every request an operator pinned on
 * purpose -- a combo member, a same-request replay, an `x-connection-id` call --
 * left sessionAffinity untouched. A session served entirely through that branch
 * had no durable pin at all, and one that already had a pin could not tell a
 * reused pin from a writer that was never reached. That is the provider-side
 * prompt-cache locality the pin exists to protect, lost for exactly the traffic
 * that asked for it.
 *
 * WHAT IT DOES NOT DO. It does not give the pin a vote. The operator named this
 * account and it has already been chosen by the time this runs; the pin RECORDS
 * that decision so later requests of the same session inherit it, and never
 * overrules it. The three writes mirror accountScheduler.js:139-147 exactly: a
 * first selection sets, a same-account reuse touches lastSeenAt and leaves
 * pinnedAt where decideRepin re-ranks from, and a move off a live pin is a
 * switch, so rule 8 gets its receipt. The `operator-pin` trigger keeps that
 * receipt distinguishable from a ranker-driven `repin` in the audit log.
 *
 * READ AND WRITE INSIDE ONE TRANSACTION, for rule 4's reason: read outside it
 * and a concurrent repin lands between the read and the write, leaving two
 * answers to a question with one answer. The adapter is resolved BEFORE the
 * transaction opens, because db.transaction(fn) is synchronous.
 *
 * FAILURE DIRECTION. Affinity is a locality optimisation, never an admission
 * gate, and the lease is ALREADY held by the time this runs. A throw here would
 * escape getProviderCredentials with a reserved slot nobody downstream knows
 * about, which is the one leak this file otherwise guards against by hand. So a
 * failed write is logged and swallowed: the request proceeds on the account the
 * operator chose, and the session simply reads as new next time.
 */
async function persistOperatorPin({ sessionHash, model, connection, windows, nowMs }) {
  const connectionId = connection?.id;
  if (!sessionHash || !model || !connectionId) return null;
  const at = new Date(nowMs).toISOString();
  try {
    const repos = await createSchedulerRepos({ now: nowMs });
    return repos.transaction(() => {
      const previousPinId = repos.getPin({ sessionHash, model })?.connectionId ?? null;
      if (previousPinId === connectionId) {
        repos.touchPin({ sessionHash, model, at });
        return { reason: "pinned", receipt: null };
      }
      repos.setPin({ sessionHash, model, connectionId, at });
      const trigger = previousPinId === null ? "first-pin" : "operator-pin";
      const receipt = repos.recordSwitch(buildSwitchReceipt({
        from: previousPinId,
        to: connectionId,
        windows: windows || [],
        trigger,
        model,
        sessionHash,
        now: nowMs,
      }));
      return { reason: trigger, receipt };
    });
  } catch (error) {
    log.warn("AUTH", `operator pin not persisted: ${error?.message || error}`);
    return null;
  }
}

// Re-exported so a handler keeps ONE import for "select an account and give
// the slot back". The definitions live in accountLeaseRegistry.js because a
// test that partially mocks this module must not lose the release path.
export { releaseAccountLease, releaseAccountLeaseOnResponse, _getLeaseRegistry };

/**
 * Quota windows in the RANKER's units, persisted so the ranker reads a live
 * table rather than an empty one.
 *
 * `evaluateQuota` already fetched (or cache-read) the provider's usage for its
 * own fail-open pause check, and that read is the only quota evidence in the
 * request path. It emits PERCENTAGES; the ranker needs absolute units. The
 * bridge converts, honestly (a percentage-only provider keeps
 * `confidence: 'unknown'` rather than getting a fabricated total), and the row
 * is written through quotaWindowsRepo.putWindows so a restart, the dashboard
 * and the admin surface all read the same evidence the decision used.
 *
 * Persistence is best-effort and deliberately NOT awaited into the decision: a
 * write failure must never make an account ineligible, which is the same
 * fail-open direction evaluateQuota itself takes.
 */
function persistWindows(connectionId, windows, { hasEvidence = false } = {}) {
  if (!connectionId || !Array.isArray(windows)) return;
  // An EMPTY array is written when, and only when, a quota read actually
  // produced a snapshot and that snapshot held no rankable window. That is
  // itself evidence -- "this account reports nothing the ranker can compare" --
  // and putWindows' delete-then-insert is the only thing that clears a window
  // the provider has stopped reporting. Skipping the write on an empty array
  // left the previous snapshot on disk indefinitely, so the ranker kept
  // comparing a shape the account no longer has: exactly the resurrection
  // putWindows' transaction docstring says it exists to prevent.
  //
  // With NO snapshot at all (ineligible account, required proxy unavailable, a
  // fetch that failed or timed out) nothing was measured, so nothing is
  // written. Erasing good evidence because one read failed is the opposite of
  // the fail-open direction evaluateQuota takes.
  if (windows.length === 0 && !hasEvidence) return;
  putWindows(connectionId, windows).catch(() => {});
}

/**
 * Longest an account of this provider may be benched for a rate limit. A free
 * pool rate-limits on a roughly per-minute window, so both an overlong
 * provider-reported reset and the blind exponential backoff are cut back to that
 * window -- otherwise one burst locks every key in the pool for minutes to hours
 * and selection has nothing left to hand out (#2895). Everything else keeps the
 * global ceiling, which leaves paid providers' resets exactly as they were.
 */
function retryDelayCapMs(provider) {
  if (!provider) return MAX_RATE_LIMIT_COOLDOWN_MS;
  const id = resolveProviderId(provider) || provider;
  return (FREE_PROVIDERS?.[id] || FREE_TIER_PROVIDERS?.[id])
    ? FREE_TIER_RATE_LIMIT_COOLDOWN_MS
    : MAX_RATE_LIMIT_COOLDOWN_MS;
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";
const CODEX_PERMANENT_OAUTH_MARKERS = [
  "invalidated oauth token",
  "authentication token has been invalidated",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "refresh token already used",
];

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function isCodexPermanentOAuthFailure(status, errorText, provider) {
  if (resolveProviderId(provider) !== "codex" || Number(status) !== 401) return false;
  const reason = describeProviderError(errorText).toLowerCase();
  return CODEX_PERMANENT_OAUTH_MARKERS.some((marker) => reason.includes(marker));
}

/**
 * Detect Qoder account-wide quota exhaustion.
 * Qoder delivers it as an HTTP-200 SSE payload whose first envelope carries
 * statusCodeValue 403 and a body containing "code":"112"; the qoder executor
 * converts that billing block into a plain 403 error before we get here.
 * Unlike transient billing blocks (queue throttle code 10605 / pricingUrl
 * nudges), code 112 does not recover on its own.
 */
function isQoderQuotaExhausted(status, errorText, provider) {
  if (resolveProviderId(provider) !== "qoder" || Number(status) !== 403) return false;
  return /"code"\s*:\s*"112"/.test(String(errorText || ""));
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
// Providers this install can actually reach right now: one with an active
// connection, or a free provider that needs no auth at all.
//
// The capacity adapter prepends its pool ahead of the model the user asked for,
// because the adapter only fires when nothing requested satisfies a required
// capability. A pool entry whose provider was never connected cannot satisfy
// anything, and attempting it spent one fallback slot and logged
// "No credentials for <provider>" against a request that had nothing to do with
// it, which reads as the router authenticating somewhere it was not asked to
// (#2555). Filter those out before the chain is built rather than after they
// have failed.
export async function getReachableProviders() {
  const reachable = new Set(NO_AUTH_PROVIDER_IDS);
  try {
    for (const connection of await getProviderConnections()) {
      if (connection?.isActive === false) continue;
      if (connection?.provider) reachable.add(resolveProviderId(connection.provider));
    }
  } catch {
    // A repo failure must not take routing down: report nothing reachable and
    // let the normal per-attempt credential lookup produce the real error.
  }
  return reachable;
}

export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Decision-log context (docs/logging-design.md 3.2): rid/sid threaded from the
  // request-handling caller through options.logCtx. Absent on background
  // selection, and then the emitted lines simply carry no rid.
  const logCtx = options?.logCtx && typeof options.logCtx === 'object' ? options.logCtx : {};
  const rid = typeof logCtx.rid === 'string' ? logCtx.rid : null;
  const sid = typeof logCtx.sid === 'string' ? logCtx.sid : null;
  const selCtx = (fields = {}) => ({
    ...(rid ? { rid } : {}),
    ...(sid ? { sid } : {}),
    ...(model ? { model } : {}),
    ...fields,
  });
  // decide() renders one k=v per key; repeated alternatives (alt=, folded by
  // the design into one comma-joined value) are joined here at the printer.
  const flatten = (fields = {}) => Object.fromEntries(
    Object.entries(fields)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
  );
  const emit = (cls, verdict, fields) => { decide(cls, verdict, selCtx(flatten(fields))); };

  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const strictPreferredConnection = Boolean(preferredConnectionId) && options?.strictPreferredConnection === true;
  // Resolve aliases before queue acquisition so alias and canonical requests share one lock.
  const providerId = resolveProviderId(provider);
  // P-F4: resolveRoutingSessionHash was computed three times per request
  // (operator pin, scheduler selection, return). It is a pure function of
  // options/providerId, so compute it once, ahead of the serialized queue.
  const routingSessionHash = resolveRoutingSessionHash(options, providerId);
  const currentQueue = providerSelectionQueues.get(providerId) || Promise.resolve();
  let releaseQueue;
  const nextQueue = new Promise(resolve => { releaseQueue = resolve; });
  providerSelectionQueues.set(providerId, nextQueue);

  try {
    await currentQueue;

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (isNoAuthProvider(providerId)) {
      const settings = await getSettings();
      // A no-auth provider has no connection row to deactivate, so the operator
      // switch is the only way to bench it. Refuse here rather than in the
      // dashboard: this is the call every modality routes through, and the
      // caller already treats null as "no account, fall through" (#2650).
      if (isProviderDisabled(settings, providerId)) {
        log.warn("AUTH", `${provider} is disabled`);
        return null;
      }
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      let pickedPool = null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const availablePools = allPools.filter(p => p.proxyUrl);
        const poolIds = availablePools.map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
        pickedPool = availablePools.find((pool) => pool.id === pickedId) || null;
      }
      const proxyData = {
        proxyPoolId: pickedId || "",
        ...(strategy === "none" && Object.prototype.hasOwnProperty.call(override, "strictProxy")
          ? { strictProxy: override.strictProxy }
          : {}),
        ...(strategy !== "none" && pickedPool
          ? { strictProxy: pickedPool.strictProxy === true }
          : {}),
      };
      const resolvedProxy = await resolveConnectionProxyConfig(proxyData, {
        persistPoolSnapshot: strategy === "none" && pickedId
          ? (pair) => updateProviderStrategyProxyPoolSnapshotIfBound(providerId, pickedId, pair)
          : undefined,
      });
      if (resolvedProxy.kind !== "usable") return null;
      const proxyOptions = toConnectionProxyOptions(resolvedProxy);
      return {
        id: "noauth",
        // Executors key their upstream session id on connectionId. Without it
        // deriveSessionId() falls through to a fresh random id on every call, so
        // each turn of one conversation reaches the provider as a new session and
        // burns a free-tier slot. "noauth" is the sentinel markAccountUnavailable
        // and clearAccountError already test for.
        connectionId: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: proxyOptions.connectionProxyEnabled,
          connectionProxyUrl: proxyOptions.connectionProxyUrl,
          connectionNoProxy: proxyOptions.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: proxyOptions.vercelRelayUrl,
          strictProxy: proxyOptions.strictProxy,
          resolutionKind: proxyOptions.resolutionKind,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out draining, model-locked and excluded connections.
    // ignoreModelLockConnId: a same-account retry must still reach the just-
    // failed connection (its transient model-lock would otherwise force a
    // switch), so skip the lock check for that one connection only. Draining
    // is checked ahead of that bypass: an operator drain must still exclude
    // the connection from this same-account retry, not just a first attempt.
    //
    // A draining connection is excluded from NEW selection only. An existing
    // session pin or in-flight stream already bound to it is untouched here:
    // selectAndReserve simply finds the pin ineligible against this smaller
    // candidate set and repins to the next eligible account, the same way it
    // already repins around any other account that drops out of eligibility.
    const drainDocs = await readAllDrainDocs();
    const draining = new Set(
      Object.entries(drainDocs || {})
        .filter(([, doc]) => doc?.isDraining)
        .map(([connectionId]) => connectionId)
    );
    const ignoreLockConn = options?.ignoreModelLockConnId || null;
    // Exclusions carry their reason to the decision log (rows 32-33): a
    // filtered-out account is a decision, and "who was skipped and why" is the
    // first question an auditor asks of a refusal.
    const drainExcluded = [];
    const modelLocked = [];
    const availableConnections = connections.filter(c => {
      if (strictPreferredConnection && c.id !== preferredConnectionId) return false;
      if (excludeSet.has(c.id)) return false;
      if (draining.has(c.id)) { drainExcluded.push(prefix8(c.id)); return false; }
      if (c.id === ignoreLockConn) return true;
      if (isModelLockActive(c, model)) {
        const failure = getActiveModelFailure(c, model);
        modelLocked.push({
          conn: prefix8(c.id),
          lock: String(getModelLockKey(model)).slice(0, 60),
          until: failure?.until ?? null,
        });
        return false;
      }
      return true;
    });
    if (drainExcluded.length) {
      emit('SEL', 'drain-excluded', {
        alt: drainExcluded.slice(0, 3),
        ...(drainExcluded.length > 3 ? { more: drainExcluded.length - 3 } : {}),
      });
    }
    for (const m of modelLocked) {
      emit('SEL', 'model-locked', { conn: m.conn, lock: m.lock, ...(m.until ? { until: m.until } : {}) });
    }

    // Filter out accounts paused due to low remaining quota (safety buffer).
    // evaluateQuota is fail-open: a missing/erroring quota read never pauses an
    // account, so this only drops accounts we can actually confirm are below threshold.
    //
    // The same read is the ONLY quota evidence in the request path, so its
    // snapshot is also what the ranker gets: converting it here means one
    // provider fetch answers both questions instead of two. A throw is caught
    // per account, because a quota lookup that fails must never make an account
    // ineligible.
    const nowMs = Date.now();
    // Fail-open exits still speak (rows 34-35): a paused account and an
    // evidence-less one are decisions the log must be able to answer for.
    const quotaPaused = [];
    const quotaUnknown = [];
    const quotaChecked = await Promise.all(
      availableConnections.map(async (c) => {
        let q;
        try {
          q = await evaluateQuota(c);
        } catch {
          // Fail OPEN, explicitly. evaluateQuota swallows its own fetch errors,
          // but a throw from anywhere else in it (a proxy resolution, a repo
          // read) would otherwise reject this Promise.all and take the WHOLE
          // provider down rather than one account.
          quotaUnknown.push(c);
          return { connection: c, windows: [] };
        }
        if (q.paused) {
          quotaPaused.push(c);
          return null;
        }
        // Percentage in, absolute units out (quotaWindowBridge.js). An empty
        // array is a valid answer meaning "no usable quota evidence" and is
        // never padded with an invented window.
        //
        // evaluateQuota now fetches evidence whenever the account is eligible
        // and reachable, threshold or no threshold (quotaGuard.js:100-117), so
        // snapshot:null means the read itself found nothing (ineligible, a
        // required proxy unavailable, or a failed/empty fetch) rather than "the
        // pause gate is off". The persisted snapshot the usage route writes
        // (src/app/api/usage/[connectionId]/route.js:208) is the fallback for
        // that case, in the identical shape. q.rawUsage is THIS call's raw
        // payload, paired one-to-one with q.snapshot (quotaGuard.js never hands
        // back one without the other) — forwarding it is what lets the bridge
        // upgrade a window from the synthetic percentage scale to the
        // provider's own absolute remaining/limit.
        const evidence = q.snapshot || c.lastQuotaSnapshot || null;
        const windows = toRankerWindows(evidence, q.rawUsage || null, { now: nowMs });
        persistWindows(c.id, windows, { hasEvidence: Boolean(evidence) });
        return { connection: c, windows };
      })
    );
    const routed = quotaChecked.filter(Boolean);
    const routedConnections = routed.map((r) => r.connection);
    const windowsByConnection = Object.fromEntries(routed.map((r) => [r.connection.id, r.windows]));

    for (const c of quotaPaused) {
      emit('SEL', 'quota-paused', { conn: prefix8(c.id), why: 'window-below-threshold' });
    }
    for (const c of quotaUnknown) {
      // A fail-open always speaks: empty windows here mean the read itself
      // threw, not that the account has no quota state (row 35).
      emit('SEL', 'quota-unknown', { conn: prefix8(c.id), why: 'evidence-absent-not-empty' });
    }

    log.debug("AUTH", `${provider} | available: ${routedConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const isDraining = draining.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || isDraining || locked) {
        const lockUntil = getEarliestModelLockUntil(c, model);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${isDraining ? "draining" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (routedConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockCandidates = strictPreferredConnection
        ? connections.filter((connection) => connection.id === preferredConnectionId)
        : connections;
      const lockedPairs = lockCandidates
        .map((connection) => ({ connection, failure: getActiveModelFailure(connection, model) }))
        .filter((entry) => entry.failure);
      const selected = lockedPairs.sort((a, b) => a.failure.until.localeCompare(b.failure.until))[0];
      if (selected) {
        const { failure } = selected;
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(failure.until)}) | lastError=${failure.message?.slice(0, 50) || "none"}`);
        return {
          allRateLimited: true,
          retryAfter: failure.until,
          retryAfterHuman: formatRetryAfter(failure.until),
          lastError: failure.message,
          lastErrorCode: failure.status,
          clientErrorStatus: failure.clientErrorStatus,
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();

    let connection = null;
    let lease = null;
    // The scheduler's verdict for the caller: REQ.ok sel= and path= read this
    // in a later wave (row 29's silent pin-hit reaches the caller here).
    let selection = null;
    // Pin to preferred connection if specified and available. This is an
    // OPERATOR pin (a combo member, a replay of the connection that just
    // failed), which is a different fact from the session pin the scheduler
    // owns: the operator named this account, so ranking does not get a vote.
    if (preferredConnectionId) {
      connection = routedConnections.find((c) => c.id === preferredConnectionId) || null;
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }

    // Register every candidate's capacity before anything reserves, so the
    // registry's capacityOf sees the configured ceiling rather than the
    // fail-open sentinel on this account's first ever selection.
    for (const c of routedConnections) {
      registerAccountCapacity(c.id, effectiveCapacity(c, { settings, provider: providerId }).limit);
    }

    if (connection) {
      // An operator pin still takes a LEASE: rule 7's per-account ceiling is
      // about the account, not about how it was chosen, and skipping the
      // reservation here would let a pinned combo member over-admit while every
      // other path is gated.
      lease = leaseRegistry.reserve(connection.id);
      if (!lease) {
        // At capacity is a WAIT, not a failure (overlay-spec §4): entitlement
        // is free, the slot is not. Reported with a nonzero retry-after through
        // the shape callers already read for "come back later".
        const retryAt = new Date(Date.now() + SCHEDULER_RETRY_AFTER_SECONDS * 1000).toISOString();
        // LEASE.refused carries the numbers the wait is about (row 37): how
        // full, against what ceiling, when to try again.
        const refusal = lastLeaseRefusal(connection.id);
        const cap = refusal?.cap ?? effectiveCapacity(connection, { settings, provider: providerId }).limit;
        const held = refusal?.held ?? leaseRegistry.inFlight(connection.id);
        emit('LEASE', 'refused', {
          conn: prefix8(connection.id),
          held,
          cap,
          next: `${SCHEDULER_RETRY_AFTER_SECONDS}s`,
          retry_after: `${SCHEDULER_RETRY_AFTER_SECONDS}s`,
        });
        log.info("AUTH", `${provider} | ${connection.id?.slice(0, 8)} at capacity, caller should retry`);
        return {
          allRateLimited: true,
          retryAfter: retryAt,
          retryAfterHuman: `${SCHEDULER_RETRY_AFTER_SECONDS}s`,
          lastError: "Account at capacity",
          lastErrorCode: null,
          clientErrorStatus: null,
        };
      }

      // The slot is proven free and this account WILL serve the request, so the
      // binding is real and gets recorded. Placed after the reservation on
      // purpose: pinning ahead of it would bind a session to an account that
      // refused it.
      // An admission without a registered ceiling is fail-open, not free:
      // it must be visible as such (row 38).
      if (lease?.ungated) {
        emit('LEASE', 'ungated', {
          conn: prefix8(connection.id),
          why: lease.why,
          held: lease.held,
        });
      }
      const pinned = await persistOperatorPin({
        sessionHash: routingSessionHash,
        model: model || MODEL_ANY,
        connection,
        windows: windowsByConnection[connection.id],
        nowMs,
      });
      // Row 29: the operator pin is a real decision and says so.
      emit('SEL', 'operator-pinned', { conn: prefix8(connection.id), why: pinned?.reason ?? 'operator-pin' });
      selection = { verdict: 'operator-pinned', conn: prefix8(connection.id), why: pinned?.reason ?? null };
      if (pinned?.receipt) {
        log.info(
          "AUTH",
          `${provider} | affinity ${pinned.reason} → ${connection.id?.slice(0, 8)}`
          + ` from ${pinned.receipt.fromConnectionId?.slice(0, 8) || "none"}`
        );
      }
    } else {
      // The scheduler decides: the ranker orders by expiring entitlement, the
      // durable pin keeps a session on its account while that account stays
      // eligible, and the reservation is what proves a slot was free. There is
      // deliberately no round-robin or fill-first fallback underneath — a
      // silent fall-through to arbitrary order is exactly the failure the
      // durable pin exists to prevent, so a refusal is reported as a wait.
      //
      // The adapter is resolved BEFORE selectAndReserve opens its transaction,
      // because db.transaction(fn) is synchronous (schedulerRepos.js).
      const sessionHash = routingSessionHash;
      const repos = await createSchedulerRepos({ now: nowMs });
      const decision = selectAndReserve({
        sessionHash,
        model: model || MODEL_ANY,
        accounts: routedConnections,
        windows: windowsByConnection,
        now: nowMs,
        registry: leaseRegistry,
        repos,
      });

      // The scheduler's whole decision as trace entries: the ranking verdict,
      // the repin verdict, slot-walk skips and the refusal reason. Printing is
      // auth.js's job (purity discipline, step 3.2) — the scheduler only
      // returns the verdicts.
      const printTrace = (trace) => {
        for (const entry of trace || []) {
          if (!entry || entry.verdict === 'pin-hit') continue; // nominal, silent (row 29)
          const fields = { ...(entry.fields || {}) };
          if (entry.verdict === 'repin' && decision.receipt?.id) fields.rcpt = decision.receipt.id;
          emit(entry.cls, entry.verdict, fields);
        }
      };

      if (decision?.unavailable) {
        // TWO DIFFERENT FACTS WEAR THIS SHAPE, and telling them apart is what
        // stops a client spinning at one request per second.
        //
        // `at-capacity` is a CONCURRENCY wait: the pool has entitlement, it
        // just has no free slot this instant. One second is the right answer
        // and 503 is the right status, because the condition clears on its own
        // in well under a second.
        //
        // Every other refusal is the pool being out of ENTITLEMENT, and that is
        // a 429 whose honest retry-after is the earliest projected window reset
        // — which the ranker already computed and handed up as
        // `earliestResetAt`. This branch used to answer 503 with a flat
        // one-second floor for both, so a caller told "come back in a second"
        // retried straight into an exhausted pool and kept doing it until a
        // window rolled over hours later. The operator sees that as the proxy
        // hammering accounts that had nothing left to give.
        const capacityWait = decision.reason === 'at-capacity';
        const retryAt = !capacityWait && decision.earliestResetAt
          ? decision.earliestResetAt
          : new Date(nowMs + (decision.retryAfter || SCHEDULER_RETRY_AFTER_SECONDS) * 1000).toISOString();
        printTrace(decision.trace);
        log.info(
          "AUTH",
          `${provider} | scheduler: ${decision.reason}`
          + `${decision.degraded ? " (no quota evidence)" : ""}`
          + ` | caller should retry at ${retryAt}`
        );
        return {
          allRateLimited: true,
          retryAfter: retryAt,
          retryAfterHuman: capacityWait
            ? `${decision.retryAfter || SCHEDULER_RETRY_AFTER_SECONDS}s`
            : formatRetryAfter(retryAt),
          lastError: `No account available (${decision.reason})`,
          // 429 is the truth an exhausted pool owes the caller. A capacity wait
          // is not a rate limit, so it keeps the 503 the caller already reads.
          lastErrorCode: capacityWait ? null : HTTP_STATUS_RATE_LIMITED,
          clientErrorStatus: capacityWait ? null : HTTP_STATUS_RATE_LIMITED,
        };
      }

      connection = decision.connection;
      lease = decision.lease;
      // The retired "selected (...)" INFO line is replaced by these: SEL.win
      // (or the ranking's degraded verdict), SEL.repin with rcpt=<receipt id>,
      // SEL.skipped for the slot walk. pin-hit is nominal and stays silent —
      // its info rides the return below for the REQ.ok sel= field.
      for (const entry of decision.trace || []) {
        if (!entry || entry.verdict === 'pin-hit') continue;
        const fields = { ...(entry.fields || {}) };
        if (entry.verdict === 'win' && !fields.why) {
          if (decision.reason === 'pinned') fields.why = 'operator-pinned';
          else if (decision.reason === 'first-pin') fields.why = 'initial-pin';
        }
        if (entry.verdict === 'repin' && decision.receipt?.id) fields.rcpt = decision.receipt.id;
        emit(entry.cls, entry.verdict, fields);
      }
      if (lease?.ungated) {
        emit('LEASE', 'ungated', { conn: prefix8(connection.id), why: lease.why, held: lease.held });
      }
      selection = {
        verdict: decision.reason === 'pinned' ? 'pin-hit' : 'win',
        conn: prefix8(connection.id),
        why: decision.repin?.reason ?? null,
      };
    }

    const connectionProxyData = connection.providerSpecificData || {};
    const expectedPoolId = connectionProxyData.proxyPoolId;
    const resolvedProxy = await resolveConnectionProxyConfig(connectionProxyData, {
      persistPoolSnapshot: expectedPoolId
        ? (pair) => updateConnectionProxyPoolSnapshotIfBound(connection.id, expectedPoolId, pair)
        : undefined,
    });
    if (resolvedProxy.kind !== "usable") {
      // Row 36: the account was selected but its proxy resolution failed —
      // pool id and the resolution verdict are the whole fact.
      emit('SEL', 'proxy-unusable', {
        conn: prefix8(connection.id),
        prov: providerId,
        pool: expectedPoolId || 'none',
        why: resolvedProxy.kind,
      });
      // The lease was taken before the proxy was resolved, and this return
      // happens AFTER the reservation, so it is the one exit inside this
      // function that can strand a slot. Release it here: nothing downstream
      // ever learns the lease existed, so nothing downstream can free it.
      if (lease && !leaseRegistry.release(lease)) {
        // Only possible when this same lease was already released — name the
        // seq so a leaking caller is findable (row 39).
        emit('LEASE', 'double-release', { conn: prefix8(lease.connectionId), seq: lease.seq });
      }
      return null;
    }
    const proxyOptions = toConnectionProxyOptions(resolvedProxy);

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      defaultModel: typeof connection.defaultModel === "string" ? connection.defaultModel.trim() || null : null,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: proxyOptions.connectionProxyEnabled,
        connectionProxyUrl: proxyOptions.connectionProxyUrl,
        connectionNoProxy: proxyOptions.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: proxyOptions.vercelRelayUrl,
        strictProxy: proxyOptions.strictProxy,
        resolutionKind: proxyOptions.resolutionKind,
      },
      connectionId: connection.id,
      // Session identity the selection already resolved for routing affinity;
      // chat.js prefixes it into the `sid` used by REQ ce= cache-epoch
      // telemetry. Additive: absent rather than recomputed when resolution
      // found nothing client-derived.
      sessionHash: routingSessionHash,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // The admission slot this selection reserved. The caller HOLDS it for the
      // whole request and hands it back through releaseAccountLease() on every
      // exit — success, error, abort, client disconnect. Release is idempotent,
      // so a belt-and-braces release costs nothing and a missed one is a leaked
      // slot that never comes back until the process restarts.
      accountLease: lease,
      // The selection verdict for the caller (REQ.ok sel=/path= later).
      selection,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    releaseQueue();
    if (providerSelectionQueues.get(providerId) === nextQueue) {
      providerSelectionQueues.delete(providerId);
    }
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
/**
 * Human-readable reason for the connection's `lastError`.
 *
 * A non-string error used to collapse to the bare string "Provider error", which
 * is what an operator then sees in the dashboard and in the console line below —
 * no status, no code, nothing to act on. A failed `fetch` is exactly that case:
 * Node reports `TypeError: fetch failed` and puts the useful part
 * (ECONNREFUSED, ENOTFOUND, ETIMEDOUT) on `error.cause.code`.
 *
 * Only message-shaped fields and error codes are read. The error object is never
 * serialized wholesale, so a request body or header that happens to be attached
 * to it cannot leak into the stored reason.
 */
export function describeProviderError(errorText) {
  // Clipped far enough out that the upstream reason survives. At 100 chars the cut
  // landed mid-word inside "Upstream request failed: …", so the only diagnostic
  // that mattered was discarded before it reached either the client or the logs.
  const clamp = (value) => String(value).replace(/\s+/g, " ").trim().slice(0, ACCOUNT_ERROR_MESSAGE_MAX_CHARS);

  if (typeof errorText === "string") return clamp(errorText);
  if (!errorText || typeof errorText !== "object") return "Provider error";

  const code = typeof errorText.code === "string" ? errorText.code
    : typeof errorText.cause?.code === "string" ? errorText.cause.code
      : null;

  if (errorText instanceof Error) {
    const message = errorText.message ? clamp(errorText.message) : errorText.name || "Provider error";
    return code && !message.includes(code) ? clamp(`${message} (${code})`) : message;
  }

  const candidates = [
    errorText.error?.message,
    errorText.message,
    typeof errorText.error === "string" ? errorText.error : null,
    errorText.detail,
    errorText.reason,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return code && !candidate.includes(code) ? clamp(`${candidate} (${code})`) : clamp(candidate);
    }
  }

  return code ? clamp(`Provider error (${code})`) : "Provider error";
}

// A verified "account does not serve this model" is stable until the plan
// changes; 24h keeps the pool honest without a permanent operator-only lock.
const UNKNOWN_MODEL_LOCK_MS = 24 * 60 * 60 * 1000;

export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, failureMetadata = null, logCtx = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  // Request-scoped decision-log context ({rid, sid}); absent on background
  // calls, and then the LOCK lines carry no rid (docs/logging-design.md 3.2).
  const rid = typeof logCtx?.rid === 'string' ? logCtx.rid : null;
  const sid = typeof logCtx?.sid === 'string' ? logCtx.sid : null;
  const lockCtx = (fields = {}) => ({
    ...(rid ? { rid } : {}),
    ...(sid ? { sid } : {}),
    conn: prefix8(connectionId),
    prov: resolveProviderId(provider),
    ...(model ? { model } : {}),
    ...fields,
  });
  const numStatus = Number(status);
  const lockClass = numStatus === 401 || numStatus === 403 || numStatus === 404
    ? 'credential'
    : numStatus === 429 ? 'quota' : 'transient';
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  if (isCodexPermanentOAuthFailure(status, errorText, provider)) {
    const reason = describeProviderError(errorText);
    await updateProviderConnection(connectionId, {
      isActive: false,
      testStatus: "reauth_required",
      lastError: reason,
      errorCode: 401,
      lastErrorAt: new Date().toISOString(),
      backoffLevel: 0,
    });
    // The credential is dead and the provider says so: no reset exists, which
    // is exactly what expect_reset=false states (rows 47-48).
    decide('LOCK', 'permanent', lockCtx({
      status: numStatus || null,
      class: 'credential',
      why: reason,
      expect_reset: false,
    }));
    return { shouldFallback: true, cooldownMs: 0 };
  }

  // Qoder code 112 is an account-wide quota signal. A timed lock alone would
  // keep retrying a dead account after the cooldown, so deactivate the
  // connection (what an operator would do manually) and let selection move to
  // the next Qoder account or the next combo fallback model.
  if (isQoderQuotaExhausted(status, errorText, provider)) {
    const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Qoder quota exhausted (code 112)";
    await updateProviderConnection(connectionId, {
      isActive: false,
      testStatus: "unavailable",
      lastError: reason,
      errorCode: 403,
      lastErrorAt: new Date().toISOString(),
      backoffLevel: 0,
    });
    const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
    log.warn("AUTH", `${connName} disabled: Qoder quota exhausted [403/code 112]`);
    return { shouldFallback: true, cooldownMs: 0 };
  }

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // A provider-verified "this account does not serve this model" is a fact
  // about the (account, model) pair, not the request. The pass-through rules
  // in errorConfig exist for the typo case (#2032) and would return this error
  // to the caller without trying accounts that DO have the model (Fable vs
  // Opus vs Sonnet lanes differ per Anthropic account). Only a structured
  // signature naming the requested model reaches here (modelErrorClassifier),
  // so a typo still passes through: no other account can fix a wrong name
  // either, but the verified signature costs one lock instead of a retry loop.
  if (failureMetadata?.unknownModelVerified === true && model) {
    const until = new Date(Date.now() + UNKNOWN_MODEL_LOCK_MS).toISOString();
    const reason = describeProviderError(errorText);
    await updateProviderConnection(connectionId, {
      ...buildModelLockUpdateAt(model, until),
      ...buildModelFailureUpdate(model, {
        status,
        message: reason,
        until,
        resetsAt: null,
        clientErrorStatus: failureMetadata?.clientErrorStatus ?? null,
        unknownModelVerified: true,
      }),
      lastError: reason,
      errorCode: status,
      lastErrorAt: new Date().toISOString(),
    });
    decide('LOCK', 'model-unavailable', lockCtx({
      status: numStatus || null,
      class: 'capability',
      reset: until,
      why: 'verified-unknown-model',
      expect_reset: false,
    }));
    return { shouldFallback: true, cooldownMs: 0 };
  }

  // A request error belongs to the caller, so reset metadata must not turn it
  // into a persisted account lock or a replay on another account.
  const fallbackResult = checkFallbackError(status, errorText, backoffLevel);
  if (!fallbackResult.shouldFallback) return fallbackResult;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff.
  // GitHub's monthly exhaustion is a real month-long window and stays uncapped;
  // everything else is bounded by this provider's ceiling (#2895).
  let shouldFallback, cooldownMs, newBackoffLevel;
  // What the schedule ASKED for before the ceiling, for LOCK.clamped
  // (row 51): {requested, applied} is only interesting when they differ.
  let requestedMs = null;
  let clampedApplied = false;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    requestedMs = resetsAtMs - Date.now();
    cooldownMs = Math.min(requestedMs, retryDelayCapMs(provider));
    clampedApplied = cooldownMs === retryDelayCapMs(provider) && requestedMs > cooldownMs;
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = fallbackResult);
    // Only the backoff schedule, which is what a rate limit earns. A 401/403/404
    // lock is about the credential rather than a window, and shortening it would
    // just retry a dead key every minute.
    if (newBackoffLevel) {
      requestedMs = cooldownMs;
      cooldownMs = Math.min(cooldownMs, retryDelayCapMs(provider));
      clampedApplied = cooldownMs === retryDelayCapMs(provider) && requestedMs > cooldownMs;
    }
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = describeProviderError(errorText);
  const lockModel = githubResetAtMs ? null : model;
  const until = githubResetAtMs
    ? new Date(githubResetAtMs).toISOString()
    : new Date(Date.now() + cooldownMs).toISOString();
  const lockUpdate = buildModelLockUpdateAt(lockModel, until);
  const failureUpdate = buildModelFailureUpdate(lockModel, {
    status,
    message: reason,
    until,
    resetsAt: resetsAtMs ? new Date(resetsAtMs).toISOString() : null,
    clientErrorStatus: failureMetadata?.clientErrorStatus ?? null,
    unknownModelVerified: failureMetadata?.unknownModelVerified === true,
  });

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    ...failureUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  // The retired "locked modelLock_... for Ns [status]" line is replaced by
  // these (rows 47-51). expect_reset=false beside class=credential is the
  // misreport the design calls out: a timed backoff on a credential fault
  // asserts a reset that will never happen.
  if (githubResetAtMs) {
    decide('LOCK', 'monthly-reset', lockCtx({
      status: numStatus || null,
      reset: until,
      why: 'usage-limit',
    }));
  } else {
    const why = lockClass === 'credential'
      ? 'no-permanent-path-for-provider'
      : lockClass === 'quota' ? 'retry-after' : 'upstream-error';
    decide('LOCK', 'applied', lockCtx({
      status: numStatus || null,
      class: lockClass,
      sched: 'backoff',
      level: newBackoffLevel ?? backoffLevel,
      cooldown: `${Math.max(0, Math.round(cooldownMs / 1000))}s`,
      cap: `${Math.round(retryDelayCapMs(provider) / 1000)}s`,
      why,
      expect_reset: lockClass !== 'credential',
    }));
    if (clampedApplied && requestedMs !== null) {
      decide('LOCK', 'clamped', lockCtx({
        requested: `${Math.max(0, Math.round(requestedMs / 1000))}s`,
        applied: `${Math.max(0, Math.round(cooldownMs / 1000))}s`,
      }));
    }
  }

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));
  const allFailureKeys = Object.keys(conn).filter(k => k.startsWith("modelFailure_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0 && allFailureKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === getModelLockKey(model)) return true; // succeeded model
    if (model && k === getModelLockKey(null)) return true;  // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  const failureKeysToClear = new Set(keysToClear.map((key) =>
    getModelFailureKey(key.slice("modelLock_".length) || null)
  ));
  if (model && Object.hasOwn(conn, getModelFailureKey(model))) {
    failureKeysToClear.add(getModelFailureKey(model));
  }
  if (model && Object.hasOwn(conn, getModelFailureKey(null))) {
    failureKeysToClear.add(getModelFailureKey(null));
  }

  if (keysToClear.length === 0 && failureKeysToClear.size === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));
  for (const key of failureKeysToClear) clearObj[key] = null;

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  return collectClientApiKeyCandidates(request)[0] || null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
