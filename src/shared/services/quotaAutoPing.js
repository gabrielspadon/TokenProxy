// Quota auto-ping scheduler: warms 5h windows by sending tiny opt-in requests right after reset.
import 'open-sse/index.js';
import { randomUUID } from 'node:crypto';
import { retainQuotaUsage, quotaObservationsFromUsage, recordQuotaCheckEvent } from '@/lib/db/repos/quotaHistoryRepo.js';
import { getAdapter } from '@/lib/db/driver.js';
import { getQuotaCheckQueue, QUOTA_CHECK_BATCH_SIZE, QUOTA_CHECK_LEASE_MS } from '@/lib/db/repos/quotaCheckQueue.js';
import { registerShutdownFlusher } from '@/lib/shutdown.js';

import { getSettings, getProviderConnections, updateProviderConnection } from '@/lib/localDb';
import * as localDb from '@/lib/localDb';
import { getUsageForProvider } from 'open-sse/services/usage.js';
import { getExecutor } from 'open-sse/executors/index.js';
import {
  classifyWindows,
  normalizeResetKey,
  planWarm,
  recordWarm,
  reconcileWarmOutcome,
} from '@/shared/services/quotaWindowWarm.js';
import { CLAUDE_CLI_SPOOF_HEADERS } from 'open-sse/providers/shared.js';
import { getModelsByProviderId } from 'open-sse/config/providerModels.js';
import { proxyAwareFetch } from 'open-sse/utils/proxyFetch.js';
import {
  resolveConnectionProxyConfig,
  toConnectionProxyOptions,
} from '@/lib/network/connectionProxy';
import { refreshAndUpdateCredentials } from '@/app/api/usage/[connectionId]/route.js';
import { QUOTA_AUTOPING_CONFIG } from '@/shared/constants/config';

const C = QUOTA_AUTOPING_CONFIG;
const CLAUDE_PING_URL = 'https://api.anthropic.com/v1/messages?beta=true';

function throwIfStopped(signal) { signal?.throwIfAborted(); }
function waitForCheck(promise, signal, late) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new Error('quota_check_cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { Promise.resolve().then(() => late?.(value)).catch(() => {}); return; }
      resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function waitForMetadata(promise, deps) {
  const pending = deps.metadataState?.pendingMetadata;
  const task = Promise.resolve(promise);
  pending?.add(task);
  task.then(() => pending?.delete(task), () => pending?.delete(task));
  // Shared quota/credential collectors may serve another waiter. Their I/O
  // retains its own timeout and ownership while this cancelled waiter detaches.
  // Keep the background permit until that work settles to prevent stop/start
  // bursts from accumulating abandoned metadata work.
  return waitForCheck(task, deps.signal);
}

// Bespoke warm senders only. Usage reads ALWAYS go through the generic
// dispatcher (deps.getUsageForProvider), which already covers every provider
// here: a second per-provider usage table was the drift that kept this
// scheduler blind to whatever the dashboard could already read, and it also
// bypassed the injectable deps that make the tick testable.
const PING_SENDERS = {
  claude: sendClaudePing,
  codex: sendCodexPing,
  antigravity: sendAntigravityPing,
};

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__quotaAutoPing ??= {
  interval: null,
  running: false,
  resetCache: {},
  failureCache: {},
  // Per connection: was every tracked window running on the last read? Only
  // then may the near-reset read guard skip a tick, because a connection with
  // a cold window has no reset to wait for.
  allRunning: {},
});

function cacheKey(provider, connectionId) {
  return `${provider}:${connectionId}`;
}

function toFiniteNumber(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isQuotaExhausted(quota) {
  if (!quota || quota.unlimited === true) return false;
  const remaining = toFiniteNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;

  const used = toFiniteNumber(quota.used);
  const total = toFiniteNumber(quota.total);
  return total !== null && total > 0 && used !== null && used >= total;
}

function isBlockingQuotaName(name, sessionKey) {
  if (name === sessionKey) return false;
  return !String(name).toLowerCase().includes('session');
}

function hasExhaustedBlockingQuota(quotas, sessionKey) {
  return Object.entries(quotas || {}).some(
    ([name, quota]) => isBlockingQuotaName(name, sessionKey) && isQuotaExhausted(quota)
  );
}

// Claude and Codex each meter one named window, so `quotaKey` is a literal.
// Antigravity meters per MODEL: its quota map is keyed by the registry model id,
// one window per quota family, so a provider may name a SET via `quotaKeys`.
// The governing reset is the EARLIEST of them — the next window to roll over,
// which is the deadline that decides when this connection is next pinged.
// The single-key path stays a plain lookup, so Claude and Codex are untouched.
export function resolveQuotaEntry(quotas, providerConfig) {
  const keys = providerConfig.quotaKeys || [providerConfig.quotaKey];
  if (keys.length === 1) return quotas?.[keys[0]];

  let governing = null;
  let governingMs = Infinity;
  for (const key of keys) {
    const quota = quotas?.[key];
    const resetMs = new Date(quota?.resetAt).getTime();
    if (!Number.isFinite(resetMs) || resetMs >= governingMs) continue;
    governing = quota;
    governingMs = resetMs;
  }
  return governing;
}

function buildProxyOptions(cfg) {
  if (cfg?.kind === 'usable') return toConnectionProxyOptions(cfg);
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || '',
    connectionNoProxy: cfg.connectionNoProxy || '',
    vercelRelayUrl: cfg.vercelRelayUrl || '',
    strictProxy: cfg.strictProxy === true,
  };
}

function snapshotOwner(conn, deps) {
  const data = conn.providerSpecificData || {};
  return {
    persistPoolSnapshot:
      data.proxyPoolId && typeof deps.updateConnectionProxyPoolSnapshotIfBound === 'function'
        ? (pair) => deps.updateConnectionProxyPoolSnapshotIfBound(conn.id, data.proxyPoolId, pair)
        : undefined,
  };
}

// The models this fork routes for Claude, cheapest last so the ping costs as
// little as possible when the configured one is refused.
export function claudePingCandidates(providerConfig) {
  const registry = getModelsByProviderId('claude')
    .map((m) => m?.id)
    .filter(Boolean);
  const cheapestFirst = [
    ...registry.filter((id) => id.includes('haiku')),
    ...registry.filter((id) => !id.includes('haiku')),
  ];
  return [providerConfig.pingModel, ...cheapestFirst].filter(
    (id, i, all) => id && all.indexOf(id) === i
  );
}

// A 404, or a 400 whose message names the model, means THIS model is refused for
// this account and another may work. A 401, 403 or 429 is about the account or
// the rate limiter and must never make us walk the catalogue.
export function isClaudeModelRejection(status, bodyText) {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /model/i.test(bodyText || '');
}

async function sendClaudePing(connection, providerConfig, proxyOptions, deps) {
  const candidates = claudePingCandidates(providerConfig);
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const result = await dispatchWarmRequest(deps, { model, scopes: deps.warmTargets, readError: true }, () => deps.proxyAwareFetch(
      CLAUDE_PING_URL,
      {
        method: 'POST',
        signal: deps.signal,
        headers: {
          ...CLAUDE_CLI_SPOOF_HEADERS,
          Authorization: `Bearer ${connection.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: providerConfig.pingMaxTokens,
          messages: [{ role: 'user', content: providerConfig.pingText }],
        }),
      },
      proxyOptions
    ));
    if (result.outcome === 'accepted') {
      if (i > 0) console.log(`[AutoPing] claude: ${candidates[0]} refused, pinged with ${model}`);
      return true;
    }
    // The configured model erroring used to end the tick, so the window was
    // never warmed and the countdown never started, with nothing said about why
    // (#2592). Walk to the next model instead, but only when the refusal is
    // about the model.
    if (result.outcome !== 'rejected' || !isClaudeModelRejection(result.status, result.bodyText)) {
      console.log(`[AutoPing] claude: ping failed with ${result.status}, not retrying another model`);
      return false;
    }
    if (i === candidates.length - 1) {
      console.log(`[AutoPing] claude: every candidate model was refused (last ${result.status})`);
    }
  }
  return false;
}

function buildCodexPingInput(text) {
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  ];
}

async function drainResponseBody(response, capture = false, signal) {
  throwIfStopped(signal);
  const reader = response?.body?.getReader?.();
  if (!reader) return typeof response?.text === 'function'
    ? (await waitForCheck(response.text(), signal)).slice(0, capture ? 4096 : 0) : '';
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await waitForCheck(reader.read(), signal);
      if (done) return text;
      bytes += value?.byteLength || 0;
      if (bytes > 65536) throw new Error('warm_response_limit');
      if (capture && text.length < 4096 && value) text += decoder.decode(value, { stream: true }).slice(0, 4096 - text.length);
    }
  } catch (error) {
    try { void reader.cancel().catch(() => {}); } catch { /* Preserve the original outcome. */ }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

// Request acceptance and observed quota activation are separate facts. Unknown
// transport outcomes never authorize another model or family as a fallback.
async function dispatchWarmRequest(deps, { model, scopes = [], readError = false }, send) {
  await deps.beforeWarmRequest(scopes, model);
  await deps.assertQuotaCheckOwnership?.();
  throwIfStopped(deps.signal);
  let result;
  try {
    const response = await waitForCheck(send(), deps.signal, response => response?.body?.cancel?.());
    const status = Number.isInteger(response?.status) ? response.status : null;
    await deps.onWarmResponse?.(response, scopes.length === 1 ? scopes[0] : null);
    const outcome = status >= 200 && status < 300 ? 'accepted'
      : status >= 400 && status < 500 ? 'rejected' : 'uncertain';
    let bodyText = '';
    if (outcome === 'accepted' || readError) bodyText = await drainResponseBody(response, readError, deps.signal);
    else { try { await response?.body?.cancel?.(); } catch { /* A refusal stays a refusal. */ } }
    result = { outcome, status, bodyText, code: status >= 100 && status <= 599 ? `http_${status}` : 'response-status-unknown' };
  } catch {
    result = { outcome: 'uncertain', status: null, bodyText: '', code: 'warm_exception' };
  }
  await deps.onWarmOutcome({ ...result, scopes, targetModel: model });
  return result;
}

// Codex model access is per-account and moves over time, so a model fixed in
// config can be unavailable for an otherwise valid account (#3212). Ask the
// account's own catalog instead of inferring access from a Free/Plus/Pro label.
// Duplicated from src/app/api/providers/[id]/models/route.js, which owns the
// canonical copy but does not export it; the client_version must stay in step
// with it, because the endpoint silently omits entries gated above it.
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.144.6';

/**
 * Pick the model to ping from a Codex model catalog.
 *
 * @returns {string} the selected model id,
 *          `null` when the catalog is readable but offers nothing callable
 *          (the account genuinely cannot ping — do not spend a request), or
 *          `undefined` when the payload is not a catalog at all (unknown, so
 *          the caller keeps the configured model rather than guessing).
 */
export function selectCodexPingModel(catalog) {
  const entries = Array.isArray(catalog)
    ? catalog
    : Array.isArray(catalog?.models)
      ? catalog.models
      : Array.isArray(catalog?.data)
        ? catalog.data
        : null;
  if (!entries) return undefined;

  // Catalog order IS the preference order; `is_default` only overrides it when
  // the endpoint states one. Entries are filtered on the endpoint's own
  // supported_in_api flag, absent meaning supported.
  const usable = entries.filter((m) => m && m.supported_in_api !== false);
  const chosen = usable.find((m) => m.is_default === true) || usable[0];
  if (!chosen) return null;
  const id = chosen.slug || chosen.id || chosen.model || chosen.name;
  return typeof id === 'string' && id ? id : null;
}

// Fetched only once a ping is actually about to be sent (every skip guard in
// pingConnection has already passed), so this costs one GET per 5h window per
// account rather than one per scheduler tick.
async function resolveCodexPingModel(connection, providerConfig, proxyOptions, deps) {
  try {
    const res = await deps.proxyAwareFetch(
      CODEX_MODELS_URL,
      {
        method: 'GET',
        signal: deps.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${connection.accessToken}`,
          originator: 'codex_cli_rs',
        },
      },
      proxyOptions
    );
    if (!res?.ok) return providerConfig.pingModel;
    const selected = selectCodexPingModel(await res.json());
    return selected === undefined ? providerConfig.pingModel : selected;
  } catch {
    // Catalog unreachable is not evidence the model is gone — keep the
    // configured one so a transient failure cannot disable auto-ping.
    return providerConfig.pingModel;
  }
}

async function sendCodexPing(connection, providerConfig, proxyOptions, deps) {
  const pingModel = await resolveCodexPingModel(connection, providerConfig, proxyOptions, deps);
  // The catalog answered and listed nothing this account can call in the API.
  // Reported as a failed ping so the cooldown backs off instead of retrying
  // the same doomed request every tick.
  if (!pingModel) return false;

  const executor = deps.getExecutor('codex');
  const result = await dispatchWarmRequest(deps, { model: pingModel, scopes: deps.warmTargets }, async () => (await executor.execute({
    signal: deps.signal,
    model: pingModel,
    stream: true,
    credentials: {
      accessToken: connection.accessToken,
      connectionId: connection.id,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    body: {
      model: pingModel,
      input: buildCodexPingInput(providerConfig.pingText),
      instructions: providerConfig.pingInstructions,
      reasoning: providerConfig.pingReasoningEffort
        ? { effort: providerConfig.pingReasoningEffort, summary: 'auto' }
        : undefined,
      store: false,
      stream: true,
    },
  })).response);
  return result.outcome === 'accepted';
}

// A 401, 403 or 429 is about the ACCOUNT or the limiter, never about this one
// model, so the remaining quota families are left alone: poking them would be
// one more request at an endpoint that is already refusing this account.
export function isAntigravityAccountRefusal(status) {
  return status === 401 || status === 403 || status === 429;
}

// Antigravity's countdown only starts once a window is actually used, and each
// quota family has its own window, so this pokes one model from EVERY family
// rather than only the family that governed the schedule. Two families sharing a
// reset timestamp share a reset key, so a single governing poke would leave the
// other one cold for good.
//
// Only the families admitted by the current plan are dispatched. A 5xx or an
// interrupted stream is uncertain, so remaining families wait for another check.
async function sendAntigravityPing(connection, providerConfig, proxyOptions, deps) {
  const executor = deps.getExecutor('antigravity');
  const models = (providerConfig.quotaKeys || []).filter(model => deps.warmTargets.includes(model));
  let landed = 0;

  for (const model of models) {
      const result = await dispatchWarmRequest(deps, { model, scopes: [model] }, async () => (await executor.execute({
        signal: deps.signal,
        model,
        stream: true,
        credentials: {
          accessToken: connection.accessToken,
          projectId: connection.projectId,
          email: connection.email || connection.name,
          connectionId: connection.id,
          providerSpecificData: connection.providerSpecificData,
        },
        proxyOptions,
        log: console,
        body: {
          model,
          request: {
            contents: [{ role: 'user', parts: [{ text: providerConfig.pingText }] }],
            generationConfig: { maxOutputTokens: providerConfig.pingMaxTokens, temperature: 0 },
          },
        },
      })).response);
      const status = result.status;
      if (isAntigravityAccountRefusal(status)) {
        console.log(
          `[AutoPing] antigravity: ${model} refused with ${status}, leaving the other quota families alone`
        );
        break;
      }
      // A 400/404 is a model this account is not entitled to (or a renamed
      // id). Counting it as landed masked a never-warmed family as warmed and
      // spent one wasted poke per period on it forever.
      if (result.outcome === 'rejected') {
        console.log(
          `[AutoPing] antigravity: ${model} answered ${status}, not counting as warmed`
        );
        continue;
      }
      if (result.outcome === 'uncertain') break;
      landed += 1;
  }

  // A partial success still counts. Failing the whole tick would put the
  // connection on the failure cooldown and re-poke the family that DID answer
  // every 15min, for a model this account may simply not be entitled to.
  if (landed > 0 && landed < models.length) {
    console.log(`[AutoPing] antigravity: ${landed}/${models.length} quota families warmed`);
  }
  return landed > 0;
}

// Cheapest model in a provider's own lane. A warming request must cost as
// little as the lane allows, and "cheapest" is knowable from the registry
// without a price table: the small tiers are named, consistently, across
// vendors. Falls back to the last registry entry, which is conventionally the
// smallest, and then to whatever the provider config named.
export function cheapestPingModel(provider, providerConfig = {}) {
  const registry = getModelsByProviderId(provider)
    .map((m) => m?.id)
    .filter(Boolean);
  const small = /(haiku|mini|flash|lite|nano|small|tiny|turbo|air|8b|4b|1\.5b)/i;
  return (
    providerConfig.pingModel ||
    registry.find((id) => small.test(id)) ||
    registry[registry.length - 1] ||
    null
  );
}

// The warming request for any provider with no bespoke sender. It goes through
// the provider's own executor, so body translation, auth and proxying are the
// same code a real request uses — a warming path with its own HTTP call would
// drift from the real one and warm nothing the day it did.
//
// A completed 2xx request was accepted. It does not prove that a quota window
// started; the later provider observation establishes that separately.
async function sendGenericPing(connection, providerConfig, proxyOptions, deps) {
  const provider = connection.provider;
  const model = cheapestPingModel(provider, providerConfig);
  if (!model) {
    console.log(`[AutoPing] ${provider}: no model to warm with`);
    return false;
  }
  const executor = deps.getExecutor(provider);
  if (!executor?.execute) {
    console.log(`[AutoPing] ${provider}: no executor, cannot warm`);
    return false;
  }
  const result = await dispatchWarmRequest(deps, { model, scopes: deps.warmTargets }, async () => (await executor.execute({
    signal: deps.signal,
    model,
    stream: false,
    credentials: {
      accessToken: connection.accessToken,
      apiKey: connection.apiKey,
      connectionId: connection.id,
      projectId: connection.projectId,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    body: {
      model,
      messages: [{ role: 'user', content: providerConfig.pingText || 'hi' }],
      max_tokens: providerConfig.pingMaxTokens ?? 1,
      stream: false,
    },
  })).response);
  if (result.outcome !== 'accepted') console.log(`[AutoPing] ${provider}: warm request answered ${result.status}, treating as failed (${result.outcome})`);
  return result.outcome === 'accepted';
}

// A repeat failure doubles the cooldown up to the cap. Without escalation a
// permanently refusing endpoint got refresh+usage+ping attempts every 15min
// forever (~96/day/connection), which is the loop-spend the lightning feature
// must never cause.
function recordFailure(state, key, nowMs = Date.now()) {
  state.failureCache[key] = nowMs;
  (state.failureCounts ??= {})[key] = ((state.failureCounts ??= {})[key] || 0) + 1;
}

function clearFailure(state, key) {
  delete state.failureCache[key];
  if (state.failureCounts) delete state.failureCounts[key];
}

function shouldSkipAfterFailure(state, key, nowMs = Date.now()) {
  const failedAt = state.failureCache[key];
  if (!failedAt) return false;
  const count = state.failureCounts?.[key] || 1;
  const cooldown = Math.min(
    C.failureCooldownMs * 2 ** (count - 1),
    C.failureCooldownCapMs || 6 * 60 * 60 * 1000
  );
  return nowMs - failedAt < cooldown;
}

async function markRateLimitedUntil(connection, resetAt, provider, deps, check) {
  if (connection.rateLimitedUntil === resetAt) return;
  try {
    await deps.updateProviderConnection(connection.id, { rateLimitedUntil: resetAt });
    console.log(
      `[AutoPing] ${provider}:${connection.id}: quota exhausted, skipped until ${resetAt}`
    );
  } catch (e) {
    await check?.('failed', { code: 'state_write_failed' });
    // Never fail a poll tick over bookkeeping; the next tick retries.
    console.warn(
      `[AutoPing] ${provider}:${connection.id}: could not record exhausted quota`
    );
  }
}

/**
 * Keep one connection's quota windows rolling.
 *
 * THE BUG THIS REPLACES. The old body read one named window and gave up when it
 * had no reset timestamp:
 *
 *     const resetAt = quota?.resetAt;
 *     if (!resetAt) return;
 *
 * A window that has not started is exactly the window with no reset timestamp —
 * Anthropic omits `five_hour` from the usage payload entirely until something
 * has been sent — so the one state warming exists to fix was the one state that
 * disabled it. An idle account's clock stayed stopped until a person touched it
 * by hand. On the RTX seam that was one ping in thirty-six hours across ten
 * enabled accounts. It also read a single family per provider, so Claude's 7d
 * window and its per-model weekly windows were never kept rolling at all.
 *
 * The decision now lives in quotaWindowWarm.js, which sorts every family into
 * running, not-running and exhausted and applies the brakes. This function does
 * the I/O: read usage, warm once, verify the clock started, persist per-window
 * state.
 */
async function pingConnection(conn, provider, providerConfig, sendPingOverride, deps, state = g) {
  const key = cacheKey(provider, conn.id);

  // Avoid hammering provider auth/quota endpoints if a warm failed recently.
  if (!deps.quotaCheckClaim && shouldSkipAfterFailure(state, key)) return;

  // A connection whose every cold family is on a warm brake has nothing this
  // tick can do, so the refresh+usage read is held too. Without this hold, one
  // permanently absent family (a plan without the weekly window, say) cost a
  // token refresh and a usage GET every 60s tick, 1440/day per connection.
  const probeHold = state.probeHold?.[key];
  if (!deps.quotaCheckClaim && probeHold && Date.now() < probeHold) return;

  // A COLD WINDOW HAS NO RESET TO WAIT FOR, so the old "skip until we are near
  // the cached reset" guard cannot gate the read any more: it is what kept the
  // scheduler from ever looking at an account whose window had gone quiet. The
  // guard survives for connections whose every tracked family is running,
  // which is the common case and the one it was written for.
  const cachedReset = state.resetCache[key];
  const allWarm = state.allRunning?.[key] === true;
  if (!deps.quotaCheckClaim && allWarm && cachedReset && Date.now() < new Date(cachedReset).getTime() - C.refreshAheadMs)
    return;

  const checkId = deps.quotaCheckClaim?.checkId || randomUUID();
  let failureRecorded = false;
  const check = async (eventType, fields = {}) => {
    if (eventType === 'failed') failureRecorded = true;
    deps.onQuotaCheckEvent?.({ eventType, ...fields });
    try {
      await deps.recordQuotaCheckEvent?.({ checkId, jobId: deps.quotaCheckClaim?.id, connectionId: conn.id, provider, eventType, ...fields });
    } catch { console.warn('[QuotaHistory] check_event_write_failed'); }
  };
  await check('started', { scheduledFor: deps.quotaCheckClaim?.nextCheckAt ?? (probeHold ? new Date(probeHold).toISOString() :
    allWarm && cachedReset ? new Date(new Date(cachedReset).getTime() - C.refreshAheadMs).toISOString() : null), resetAt: cachedReset || null });
  try { return await performQuotaCheck(conn, provider, providerConfig, sendPingOverride, deps, state, check, cachedReset); }
  catch (error) { if (!failureRecorded) await check('failed', { code: 'check_exception' }); throw error; }
}

async function performQuotaCheck(conn, provider, providerConfig, sendPingOverride, deps, state, check, cachedReset) {
  throwIfStopped(deps.signal);
  await deps.assertQuotaCheckOwnership?.();
  const key = cacheKey(provider, conn.id);
  const proxyCfg = await waitForMetadata(deps.resolveConnectionProxyConfig(
    conn.providerSpecificData,
    snapshotOwner(conn, deps)
  ), deps);
  if (proxyCfg?.kind === 'required-unavailable') {
    recordFailure(state, key);
    await check('failed', { code: 'required_proxy_unavailable' });
    console.warn(`[AutoPing] ${provider}:${conn.id}: required_proxy_unavailable`);
    return { code: 'required_proxy_unavailable', status: 503 };
  }
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  try {
    throwIfStopped(deps.signal);
    const r = await waitForMetadata(deps.refreshAndUpdateCredentials(connection, false, proxyOptions), deps);
    connection = r.connection;
  } catch (e) {
    recordFailure(state, key);
    await check('failed', { code: 'credential_refresh_failed' });
    console.warn(`[AutoPing] ${provider}:${conn.id}: refresh failed`);
    return;
  }

  let usage;
  try { throwIfStopped(deps.signal); usage = await waitForMetadata(deps.getUsageForProvider(connection, proxyOptions), deps); }
  catch (error) { await check('failed', { code: 'usage_exception' }); throw error; }
  // A usage reader that failed returns {message}/{expired} WITHOUT a quotas
  // object. Treating that as "every window absent" is what made a 429ing or
  // broken usage endpoint trigger a real ping: cold is a fact about the
  // account, not about our ability to read it.
  if (!usage || typeof usage.quotas !== 'object' || usage.quotas === null) {
    await check('failed', { code: 'usage_unreadable' });
    recordFailure(state, key);
    console.warn(
      `[AutoPing] ${provider}:${conn.id}: usage unreadable, skipping warm`
    );
    return;
  }
  const quotas = usage.quotas;
  let observations = [];
  try {
    if (deps.retainQuotaUsage && await deps.retainQuotaUsage(connection, usage) !== null) {
      observations = quotaObservationsFromUsage(connection, usage);
    }
  }
  catch { console.warn('[QuotaHistory] observation_write_failed'); }
  const priorObservation = scope => observations.find(row => row.scope === scope)?.id ?? null;
  const observedAt = usage.quotaObservation?.observedAt ?? null;
  await check('usage-read', { code: 'observed', observedAt });
  for (const observation of observations) deps.onQuotaObservation?.(observation);

  // TWO KINDS OF STATE, kept in two places on purpose.
  //
  // Warm state (when we last warmed a family, and whether that warm took) is
  // DURABLE: the backoff it drives has to survive a restart, or a family that
  // cannot be started gets re-poked every time the process comes up. It lives
  // on the connection.
  //
  // Last-seen reset, which is only used to spot a SLIDING window, is
  // in-memory. Losing it on restart costs one tick of detection and nothing
  // else, and persisting it would mean a database write on every tick of every
  // healthy connection — a write for the express purpose of learning nothing.
  // In-memory mirror of the last computed warm state. The durable write below
  // can fail (DB busy, disk error); without this mirror a failed write erased
  // the brake and the same family was re-warmed every tick for as long as the
  // DB stayed unhappy. The DB copy wins when present, because it survived a
  // restart and the mirror did not.
  const mirror = (state.warmStateCache ??= {})[key];
  const warmState =
    connection.autoPingWindows && typeof connection.autoPingWindows === 'object'
      ? connection.autoPingWindows
      : mirror && typeof mirror === 'object'
        ? mirror
        : {};
  const seenResets = (state.seenResets ??= {})[key] || {};

  const planState = {};
  for (const name of new Set([...Object.keys(warmState), ...Object.keys(seenResets)])) {
    planState[name] = { ...(warmState[name] || {}), lastSeenResetAt: seenResets[name] };
  }
  // The pre-per-window scheduler kept THREE fields on the connection and
  // applied them to its single governing window: when it last pinged, and
  // which reset instance that ping belonged to. Both brakes still matter, so
  // they are bridged onto the governing family rather than dropped — a
  // connection carrying only the old fields must not be re-warmed the first
  // time this version runs.
  const legacyWarmedResetKey =
    connection.lastPingedResetKey ||
    (connection.lastPingedResetAt ? normalizeResetKey(connection.lastPingedResetAt) : null);
  // COMPATIBILITY BRIDGE. Before windows were tracked individually, the
  // governing window's last-seen reset was the whole of this state and lived in
  // `resetCache`. Reading it here keeps slide detection working across the
  // change, and for a single-window provider the two are the same fact.
  const governingName = providerConfig.quotaKey;
  if (governingName) {
    const entry = { ...(planState[governingName] || {}) };
    if (!entry.lastSeenResetAt && cachedReset) entry.lastSeenResetAt = cachedReset;
    if (!entry.lastWarmedAt && connection.lastPingAt) entry.lastWarmedAt = connection.lastPingAt;
    if (!entry.lastWarmedResetKey && legacyWarmedResetKey) {
      entry.lastWarmedResetKey = legacyWarmedResetKey;
    }
    planState[governingName] = entry;
  }

  const expectedWindows =
    providerConfig.expectedWindows ||
    providerConfig.quotaKeys ||
    (governingName ? [governingName] : []);
  const warmConfig = { ...C, resetAtDriftMs: providerConfig.resetAtDriftMs || 0 };

  // VERIFY THE PREVIOUS WARM FIRST, off this tick's usage read. A family we
  // warmed and that is still not reporting a window did not have its clock
  // started, and saying so here is what puts it on the slow backoff before the
  // plan below can spend another request on it.
  const firstLook = classifyWindows({
    quotas,
    tracked: [...expectedWindows, ...Object.keys(quotas), ...Object.keys(planState)],
    now: Date.now(),
    state: planState,
    resetAtDriftMs: warmConfig.resetAtDriftMs,
  });
  const verdict = reconcileWarmOutcome({
    state: planState,
    running: firstLook.running,
    notRunning: firstLook.notRunning,
    now: Date.now(),
    verifyAfterMs: C.warmVerifyAfterMs,
  });
  const observedAfterWarm = scope => Number.isFinite(Date.parse(observedAt)) &&
    Number.isFinite(Date.parse(planState[scope]?.lastWarmedAt)) &&
    Date.parse(observedAt) > Date.parse(planState[scope].lastWarmedAt);
  for (const scope of verdict.stillCold.filter(observedAfterWarm)) await check('still-cold', { scope, observedAt, code: 'verified' });
  for (const scope of verdict.started.filter(observedAfterWarm)) await check('clock-running', { scope, observedAt, code: 'verified' });
  if (verdict.stillCold.length) {
    console.warn(
      `[AutoPing] ${provider}:${connection.id}: warmed but still cold:` +
        ` ${verdict.stillCold.join(', ')} — backing off to one attempt per window period`
    );
  }
  if (verdict.started.length) {
    console.log(
      `[AutoPing] ${provider}:${connection.id}: clock running for ${verdict.started.join(', ')}`
    );
  }
  if (verdict.changed) {
    // A transition is worth a durable write; "still the same" is not. The
    // mirror lands first so the brake holds this process even when the write
    // fails; the failure itself is logged, never swallowed silently.
    state.warmStateCache[key] = verdict.state;
    try {
      await deps.updateProviderConnection(connection.id, { autoPingWindows: verdict.state });
    } catch (e) {
      await check('failed', { code: 'state_write_failed' });
      console.warn(
        `[AutoPing] ${provider}:${connection.id}: could not persist warm state`
      );
    }
  }

  const plan = planWarm({
    quotas,
    expectedWindows,
    windowPeriodsMs: providerConfig.windowPeriodsMs || {},
    state: verdict.state,
    now: Date.now(),
    config: warmConfig,
  });

  // Stamp what we just saw, for the next tick's slide comparison.
  const nextSeen = { ...seenResets };
  for (const { name, resetAt } of plan.running) {
    nextSeen[name] = new Date(resetAt).toISOString();
  }
  state.seenResets[key] = nextSeen;

  (state.allRunning ??= {})[key] = plan.reason === 'every-window-running';
  // Every cold family refused a warm (backoff, min interval, or same reset):
  // hold the next probe for the min warm interval instead of re-reading usage
  // on every tick. Reset detection is delayed by at most that interval.
  (state.probeHold ??= {})[key] =
    !plan.shouldWarm && plan.reason !== 'every-window-running' && plan.targets.length === 0
      ? Date.now() + C.minWarmIntervalMs
      : 0;
  if (plan.nextResetAt) state.resetCache[key] = new Date(plan.nextResetAt).toISOString();
  // The guard is a not-before deadline, not a prediction that a reset occurred
  // or an exact execution time. The existing tick determines actual execution.
  if (!deps.quotaCheckClaim && state.allRunning[key] && plan.nextResetAt) {
    for (const window of plan.running) await check('scheduled', { scope: window.name, observationId: priorObservation(window.name),
      code: 'reset-not-before', resetAt: new Date(window.resetAt).toISOString(),
      scheduledFor: new Date(Math.max(Date.now() + C.tickIntervalMs, window.resetAt - C.refreshAheadMs)).toISOString(), observedAt });
  } else if (!deps.quotaCheckClaim && state.probeHold[key]) {
    await check('scheduled', { code: 'probe-not-before', scheduledFor: new Date(state.probeHold[key]).toISOString(), observedAt });
  }

  // The governing window is spent. The poller is the only thing that knows that
  // before a real request finds out the hard way (#1125), and `rateLimitedUntil`
  // is the field account fallback already filters on, so writing the reset the
  // provider reported makes the account skipped the way a paused one is and
  // lapses on its own at reset.
  const governing = resolveQuotaEntry(quotas, providerConfig);
  if (governing && isQuotaExhausted(governing) && governing.resetAt) {
    await markRateLimitedUntil(connection, governing.resetAt, provider, deps, check);
  } else if (
    governing &&
    !isQuotaExhausted(governing) &&
    connection.rateLimitedUntil &&
    new Date(connection.rateLimitedUntil).getTime() > Date.now()
  ) {
    // EARLY LIFT. The lock's timestamp is our guess (blind backoff caps at 6h)
    // or the provider's last word, and providers lift quotas before either.
    // This tick's usage read is fresher than both: a governing window reading
    // healthy while the lock is still in the future means the quota is gone,
    // so release the account now instead of serving out the sentence. The
    // usage read already happened, so this costs no request and no quota.
    // backoffLevel is deliberately kept: a lock cleared wrongly re-locks one
    // level higher on the next real failure, which is half-open behavior.
    // ponytail: account-level lock only; per-model modelLock_* clears when a
    // per-model provider (antigravity) needs early lift.
    try {
      await deps.updateProviderConnection(connection.id, { rateLimitedUntil: null });
      console.log(
        `[AutoPing] ${provider}:${connection.id}: quota lifted early, lock cleared` +
          ` (was ${connection.rateLimitedUntil})`
      );
    } catch (e) {
      await check('failed', { code: 'state_write_failed' });
      console.warn(
        `[AutoPing] ${provider}:${connection.id}: could not clear lifted lock`
      );
    }
  }
  if (
    providerConfig.skipWhenBlockingQuotaExhausted &&
    hasExhaustedBlockingQuota(quotas, providerConfig.quotaKey)
  ) {
    await check('completed', { code: 'blocking_quota_exhausted', observedAt });
    return;
  }

  if (!plan.shouldWarm) {
    await check('completed', { code: plan.reason === 'every-window-running' ? 'every-window-running' : 'warm-policy-held', observedAt });
    return;
  }

  const targets = plan.targets;
  console.log(
    `[AutoPing] ${provider}:${connection.id}: warming ${targets.join(', ')} (${plan.reason})`
  );

  const sendPing = sendPingOverride || sendGenericPing;
  let nextState = { ...verdict.state };
  const accepted = new Set(), outcomes = new Map();
  const persist = deps.persistWarmState || deps.updateProviderConnection;
  const persistAttempt = async () => {
    state.warmStateCache[key] = nextState;
    try { await persist(connection.id, { autoPingWindows: nextState }); }
    catch (error) { await check('failed', { code: 'state_write_failed' }); recordFailure(state, key); throw error; }
  };
  const senderDeps = {
    ...deps,
    warmTargets: targets,
    beforeWarmRequest: async (scopes, model) => {
      await deps.assertQuotaCheckOwnership?.();
      if (!scopes.length || scopes.some(scope => !targets.includes(scope))) throw new Error('warm_target_mismatch');
      for (const scope of scopes) nextState[scope] = { ...nextState[scope],
        lastAttemptedAt: new Date().toISOString(), lastAttemptedResetKey: plan.resetKeys?.[scope] ?? null,
        lastAttemptOutcome: 'dispatching', lastAttemptModel: model };
      // The durable guard is acknowledged before a possibly billable dispatch.
      await persistAttempt();
    },
    onWarmOutcome: async ({ scopes, targetModel, outcome, code }) => {
      for (const scope of scopes) {
        outcomes.set(scope, { targetModel, outcome });
        nextState[scope] = { ...nextState[scope], lastAttemptOutcome: outcome };
        if (outcome === 'accepted') {
          accepted.add(scope);
          nextState = recordWarm({ state: nextState, targets: [scope], resetKeys: plan.resetKeys || {}, now: Date.now() });
        }
        await check('warm-outcome', { scope, targetModel, outcome, code, observedAt, observationId: priorObservation(scope) });
      }
      await persistAttempt();
    },
    onWarmResponse: (response, scope = null) => check('warm-response', {
      scope, code: Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
        ? `http_${response.status}` : 'response-status-unknown',
    }),
  };
  try { await sendPing(connection, providerConfig, proxyOptions, senderDeps); }
  catch (error) { await check('failed', { code: 'warm_exception' }); throw error; }
  if (!accepted.size) {
    await check('failed', { code: [...outcomes.values()].some(o => o.outcome === 'uncertain') ? 'warm_uncertain' : 'warm_rejected' });
    // Do not record a warm unless upstream took the tiny request.
    recordFailure(state, key);
    console.warn(
      `[AutoPing] ${provider}:${connection.id}: warm request failed for ${targets.join(', ')}`
    );
    return;
  }
  clearFailure(state, key);
  for (const scope of accepted) await check('warm-recorded', { scope, ...outcomes.get(scope), code: 'scheduler-recorded', observedAt, observationId: priorObservation(scope) });

  const nowIso = new Date().toISOString();
  nextState = recordWarm({
    state: nextState,
    targets: [...accepted],
    resetKeys: plan.resetKeys || {},
    now: Date.now(),
  });
  // The reset instance this warm belonged to, for the legacy single-window
  // fields. It is the reset we OBSERVED — for a cold window that is the one
  // that just ended, which is what identifies the instance — not the next one,
  // which nothing has reported yet.
  //
  // `governing` rather than `quotas[governingName]`: a provider metering per
  // model has no single `quotaKey`, so the named lookup missed and this fell
  // through to `nextResetAt`, which is the earliest RUNNING window and can be a
  // different family days away. resolveQuotaEntry already owns "which window
  // governs" for both shapes, so it answers here too.
  // No governing entry means the payload carried no window at all, which is
  // exactly the cold-start case. The earliest reset among the families we are
  // warming is then the best instance id available; ISO-8601 sorts lexically,
  // so this is the minimum without parsing anything.
  const observedReset =
    governing?.resetAt ||
    Object.values(plan.resetKeys || {}).sort()[0] ||
    (plan.nextResetAt ? new Date(plan.nextResetAt).toISOString() : null);
  state.warmStateCache[key] = nextState;
  try {
    await persist(connection.id, {
      autoPingWindows: nextState,
      // Kept for the dashboard and for anything still reading the single-window
      // fields; the per-window map above is what the scheduler decides on.
      lastPingedResetAt: observedReset || null,
      lastPingedResetKey: observedReset ? normalizeResetKey(observedReset) : null,
      lastPingAt: nowIso,
      updatedAt: nowIso,
    });
  } catch (e) {
    await check('failed', { code: 'state_write_failed' });
    // The ping was SPENT. Losing this write must not re-spend it: the mirror
    // above keeps the brake for this process, and the failure cooldown keeps a
    // dead DB from turning every tick into a token.
    recordFailure(state, key);
    console.warn(
      `[AutoPing] ${provider}:${connection.id}: warm spent but state write failed`
    );
  }
}

async function quotaInventory(settings, deps) {
  const inventory = [];
  const byId = new Map();
  for (const [provider, config] of Object.entries(C.providers)) {
    const enabled = settings?.[config.settingsKey]?.connections || {};
    const connections = await deps.getProviderConnections({ provider }) || [];
    for (const connection of connections) {
      const cancelReason = connection.isActive === false ? 'account-inactive'
        : enabled[connection.id] !== true ? 'setting-disabled'
        : !(config.authTypes || ['oauth']).includes(connection.authType) ? 'auth-unsupported' : null;
      inventory.push({ id: connection.id, provider, cancelReason });
      if (!cancelReason) byId.set(`${provider}:${connection.id}`, { connection, config });
    }
  }
  return { inventory, byId };
}

async function runDurableQuotaChecks(settings, deps, state) {
  const queue = await deps.getQuotaCheckQueue();
  state.queue = queue;
  const { inventory, byId } = await quotaInventory(settings, deps);
  throwIfStopped(deps.signal);
  queue.reconcile(inventory);
  for (const job of queue.due(QUOTA_CHECK_BATCH_SIZE)) {
    throwIfStopped(deps.signal);
    const target = byId.get(`${job.provider}:${job.connectionId}`);
    if (!target) continue;
    const claim = queue.claim(job.id);
    if (!claim) continue;
    let lost = false;
    let failed = false;
    let accepted = false;
    const observations = new Map();
    const controller = new AbortController();
    const signal = AbortSignal.any([deps.signal, controller.signal].filter(Boolean));
    const cancel = reason => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
        try { queue.cancel(claim, reason); } catch { console.warn('[AutoPing] cancellation_state_write_failed'); }
      }
    };
    state.activeCheck = { claim, cancel };
    const assertAuthority = async () => {
      throwIfStopped(signal);
      if (lost || !queue.owns(claim)) { lost = true; cancel('ownership-lost'); throw new Error('quota_check_ownership_lost'); }
      const current = await deps.getSettings();
      const accounts = await deps.getProviderConnections({ provider: job.provider }) || [];
      const account = accounts.find(item => item.id === job.connectionId);
      const reason = !account ? 'account-missing' : account.isActive === false ? 'account-inactive'
        : current?.[target.config.settingsKey]?.connections?.[job.connectionId] !== true ? 'setting-disabled'
        : !(target.config.authTypes || ['oauth']).includes(account.authType) ? 'auth-unsupported' : null;
      if (reason) { cancel(reason); throw new Error(reason); }
      throwIfStopped(signal);
      if (!queue.owns(claim)) { lost = true; cancel('ownership-lost'); throw new Error('quota_check_ownership_lost'); }
    };
    const renewal = setInterval(() => {
      try { if (!queue.renew(claim)) { lost = true; cancel('ownership-lost'); } }
      catch { lost = true; cancel('ownership-lost'); }
    }, Math.floor(QUOTA_CHECK_LEASE_MS / 3));
    renewal.unref?.();
    const deadline = setTimeout(() => cancel('check-deadline'), QUOTA_CHECK_LEASE_MS);
    deadline.unref?.();
    const stop = () => cancel('scheduler-stopped');
    deps.signal?.addEventListener('abort', stop, { once: true });
    try {
      await pingConnection(target.connection, job.provider, target.config,
        PING_SENDERS[job.provider] || null, { ...deps, signal, quotaCheckClaim: claim,
          assertQuotaCheckOwnership: assertAuthority,
          onQuotaObservation: observation => observations.set(observation.scope, observation),
          onQuotaCheckEvent: event => { if (event.eventType === 'failed') failed = true; if (event.eventType === 'warm-outcome' && event.outcome === 'accepted') accepted = true; },
        }, state);
    } catch {
      failed = true;
      recordFailure(state, cacheKey(job.provider, job.connectionId));
    } finally {
      clearInterval(renewal);
      clearTimeout(deadline);
      deps.signal?.removeEventListener('abort', stop);
      if (state.activeCheck?.claim === claim) state.activeCheck = null;
    }
    const key = cacheKey(job.provider, job.connectionId);
    let next = Date.now() + C.tickIntervalMs;
    let reason = 'poll-not-before';
    if (failed) { next = Date.now() + C.failureCooldownMs; reason = 'retry-not-before'; }
    else if (accepted) { next = Date.now() + C.warmVerifyAfterMs; reason = 'verify-not-before'; }
    else if (state.probeHold?.[key] > next) { next = state.probeHold[key]; reason = 'probe-not-before'; }
    else if (state.allRunning?.[key] && Date.parse(state.resetCache[key]) - C.refreshAheadMs > next) {
      next = Date.parse(state.resetCache[key]) - C.refreshAheadMs; reason = 'reset-not-before';
    }
    const targets = [...observations.values()].map(observation => ({ scope: observation.scope, observationId: observation.id, resetAt: observation.resetAt }));
    if (!lost && !signal.aborted) {
      await assertAuthority();
      queue.complete(claim, { nextCheckAt: new Date(next).toISOString(), reason,
        targets: targets.slice(0,100), outcome: failed ? 'failed' : 'completed' });
    }
  }
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateConnectionProxyPoolSnapshotIfBound: localDb.updateConnectionProxyPoolSnapshotIfBound,
    updateProviderConnection,
    persistWarmState: async (id, patch) => {
      if (!await updateProviderConnection(id, patch)) throw new Error('warm_account_missing');
      const db = await getAdapter();
      db.flush?.();
    },
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    proxyAwareFetch,
    getExecutor,
    getUsageForProvider,
    retainQuotaUsage,
    recordQuotaCheckEvent,
    getQuotaCheckQueue,
  };
}

export function runQuotaAutoPingTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return state.tickPromise || Promise.resolve();
  if (state.pendingMetadata?.size) return Promise.resolve();
  state.running = true;
  state.pendingMetadata ??= new Set();
  state.controller = new AbortController();
  state.deps = deps;
  state.tickPromise = executeQuotaAutoPingTick({ ...deps, signal: state.controller.signal, metadataState: state }, state)
    .finally(() => { state.running = false; state.controller = null; state.tickPromise = null; });
  return state.tickPromise;
}

async function executeQuotaAutoPingTick(deps, state) {
  try {
    const settings = await deps.getSettings();
    throwIfStopped(deps.signal);
    if (deps.getQuotaCheckQueue) {
      await runDurableQuotaChecks(settings, deps, state);
      return;
    }

    for (const [provider, providerConfig] of Object.entries(C.providers)) {
      // A provider with no bespoke handler is warmed through the generic usage
      // reader and the generic executor ping. Skipping it here is what kept
      // this scheduler to three providers while the rest of the pool had
      // perfectly good usage readers.
      const sendPing = PING_SENDERS[provider] || null;

      const enabledMap = settings?.[providerConfig.settingsKey]?.connections || {};
      if (Object.keys(enabledMap).length === 0) continue;

      const conns = await deps.getProviderConnections({ provider, isActive: true });
      const allowedAuth = providerConfig.authTypes || ['oauth'];
      const targets = conns.filter(
        (conn) => allowedAuth.includes(conn.authType) && enabledMap[conn.id] === true
      );
      for (const conn of targets) {
        throwIfStopped(deps.signal);
        try {
          await pingConnection(conn, provider, providerConfig, sendPing, deps, state);
        } catch (e) {
          recordFailure(state, cacheKey(provider, conn.id));
          console.warn(`[AutoPing] ${provider}:${conn.id}: check failed`);
        }
      }
    }
  } catch (e) {
    console.warn('[AutoPing] tick error: check failed');
  }
}

export function startQuotaAutoPing(deps = createDefaultDeps(), state = g) {
  if (state.interval) return;
  console.log('[AutoPing] scheduler started');
  state.shutdownCleanup ??= registerShutdownFlusher(() => stopQuotaAutoPing(state), -50);
  runQuotaAutoPingTick(deps, state).catch(() => {});
  state.interval = setInterval(() => {
    runQuotaAutoPingTick(deps, state).catch(() => {});
  }, C.tickIntervalMs);
  state.interval.unref?.();
}

export function stopQuotaAutoPing(state = g) {
  const wasRunning = state.interval || state.running;
  clearInterval(state.interval);
  state.interval = null;
  state.controller?.abort(new Error('scheduler-stopped'));
  state.activeCheck?.cancel('scheduler-stopped');
  state.shutdownCleanup?.(); state.shutdownCleanup = null;
  if (wasRunning) console.log('[AutoPing] scheduler stopped');
  return Promise.resolve(state.tickPromise);
}

export function configureQuotaAutoPing(settings, deps = createDefaultDeps(), state = g) {
  const enabled = Object.values(C.providers).some((providerConfig) =>
    Object.values(settings?.[providerConfig.settingsKey]?.connections || {}).some(Boolean)
  );
  if (enabled) startQuotaAutoPing(deps, state);
  else stopQuotaAutoPing(state);
  // Persist opt-out even when no interval was installed in this process.
  const reconcile = async () => {
    if (!deps.getQuotaCheckQueue) return;
    const queue = await deps.getQuotaCheckQueue();
    state.queue = queue;
    const current = await deps.getSettings();
    const { inventory } = await quotaInventory(current, deps);
    queue.reconcile(inventory);
    if (state.activeCheck && !queue.owns(state.activeCheck.claim)) state.activeCheck.cancel('setting-disabled');
  };
  return reconcile().catch(() => console.warn('[AutoPing] settings_reconciliation_failed'));
}

// Called only after an account mutation commits. Reading inventory can cancel
// work but never performs provider I/O or starts a scheduler that was absent.
export async function notifyQuotaAccountChanged(connectionId, state = g) {
  if (!state.queue || !state.deps) return;
  const { inventory } = await quotaInventory(await state.deps.getSettings(), state.deps);
  state.queue.reconcile(inventory);
  if (state.activeCheck?.claim.connectionId === connectionId && !state.queue.owns(state.activeCheck.claim)) {
    state.activeCheck.cancel('account-inactive');
  }
}
