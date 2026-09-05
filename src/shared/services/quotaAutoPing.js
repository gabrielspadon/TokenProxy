// Quota auto-ping scheduler: warms 5h windows by sending tiny opt-in requests right after reset.
import 'open-sse/index.js';

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
    const res = await deps.proxyAwareFetch(
      CLAUDE_PING_URL,
      {
        method: 'POST',
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
    );
    if (res.ok) {
      if (i > 0) console.log(`[AutoPing] claude: ${candidates[0]} refused, pinged with ${model}`);
      return true;
    }
    // The configured model erroring used to end the tick, so the window was
    // never warmed and the countdown never started, with nothing said about why
    // (#2592). Walk to the next model instead, but only when the refusal is
    // about the model.
    const bodyText = (await res.text?.().catch(() => '')) || '';
    if (!isClaudeModelRejection(res.status, bodyText)) {
      console.log(`[AutoPing] claude: ping failed with ${res.status}, not retrying another model`);
      return false;
    }
    if (i === candidates.length - 1) {
      console.log(`[AutoPing] claude: every candidate model was refused (last ${res.status})`);
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

async function drainResponseBody(response) {
  if (typeof response?.text === 'function') {
    await response.text();
    return;
  }

  const reader = response?.body?.getReader?.();
  if (!reader) return;

  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock?.();
  }
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
  const { response } = await executor.execute({
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
  });
  if (!response.ok) {
    try {
      await response.body?.cancel?.();
    } catch {
      /* noop */
    }
    return false;
  }

  // Codex only starts the 5h window after the streaming response completes.
  await drainResponseBody(response);
  return true;
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
// Any other status counts as warmed. The poke's goal is that the request reaches
// upstream and spends a token, not that it comes back 2xx: Google's transport
// commonly answers 5xx or drops the stream after processing the request. Same
// reading as the manual hot reload in
// src/app/api/providers/[id]/hotreload/route.js:31-37.
async function sendAntigravityPing(connection, providerConfig, proxyOptions, deps) {
  const executor = deps.getExecutor('antigravity');
  const models = providerConfig.quotaKeys || [];
  let landed = 0;

  for (const model of models) {
    try {
      const { response } = await executor.execute({
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
      });
      if (!response) continue;

      const status = response.status;
      await drainResponseBody(response);
      if (isAntigravityAccountRefusal(status)) {
        console.log(
          `[AutoPing] antigravity: ${model} refused with ${status}, leaving the other quota families alone`
        );
        break;
      }
      // A 400/404 is a model this account is not entitled to (or a renamed
      // id). Counting it as landed masked a never-warmed family as warmed and
      // spent one wasted poke per period on it forever.
      if (status === 400 || status === 404) {
        console.log(
          `[AutoPing] antigravity: ${model} answered ${status}, not counting as warmed`
        );
        continue;
      }
      landed += 1;
    } catch (e) {
      console.log(`[AutoPing] antigravity: ${model} ping errored: ${e.message}`);
    }
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
// Reaching upstream is the whole goal, not a 2xx: the provider has to COUNT the
// request against a window, and several answer 4xx or 5xx after doing exactly
// that. A 5xx is the one case worth treating as failure, because it usually
// means the request never landed.
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
  const { response } = await executor.execute({
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
  });
  if (!response) return false;
  const status = response.status;
  await drainResponseBody(response);
  if (status >= 500) {
    console.log(`[AutoPing] ${provider}: warm request answered ${status}, treating as failed`);
    return false;
  }
  return true;
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

async function markRateLimitedUntil(connection, resetAt, provider, deps) {
  if (connection.rateLimitedUntil === resetAt) return;
  try {
    await deps.updateProviderConnection(connection.id, { rateLimitedUntil: resetAt });
    console.log(
      `[AutoPing] ${provider}:${connection.id}: quota exhausted, skipped until ${resetAt}`
    );
  } catch (e) {
    // Never fail a poll tick over bookkeeping; the next tick retries.
    console.warn(
      `[AutoPing] ${provider}:${connection.id}: could not record exhausted quota: ${e.message}`
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
  if (shouldSkipAfterFailure(state, key)) return;

  // A connection whose every cold family is on a warm brake has nothing this
  // tick can do, so the refresh+usage read is held too. Without this hold, one
  // permanently absent family (a plan without the weekly window, say) cost a
  // token refresh and a usage GET every 60s tick, 1440/day per connection.
  const probeHold = state.probeHold?.[key];
  if (probeHold && Date.now() < probeHold) return;

  // A COLD WINDOW HAS NO RESET TO WAIT FOR, so the old "skip until we are near
  // the cached reset" guard cannot gate the read any more: it is what kept the
  // scheduler from ever looking at an account whose window had gone quiet. The
  // guard survives for connections whose every tracked family is running,
  // which is the common case and the one it was written for.
  const cachedReset = state.resetCache[key];
  const allWarm = state.allRunning?.[key] === true;
  if (allWarm && cachedReset && Date.now() < new Date(cachedReset).getTime() - C.refreshAheadMs)
    return;

  const proxyCfg = await deps.resolveConnectionProxyConfig(
    conn.providerSpecificData,
    snapshotOwner(conn, deps)
  );
  if (proxyCfg?.kind === 'required-unavailable') {
    recordFailure(state, key);
    console.warn(`[AutoPing] ${provider}:${conn.id}: required_proxy_unavailable`);
    return { code: 'required_proxy_unavailable', status: 503 };
  }
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  try {
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = r.connection;
  } catch (e) {
    recordFailure(state, key);
    console.warn(`[AutoPing] ${provider}:${conn.id}: refresh failed: ${e.message}`);
    return;
  }

  const usage = await deps.getUsageForProvider(connection, proxyOptions);
  // A usage reader that failed returns {message}/{expired} WITHOUT a quotas
  // object. Treating that as "every window absent" is what made a 429ing or
  // broken usage endpoint trigger a real ping: cold is a fact about the
  // account, not about our ability to read it.
  if (!usage || typeof usage.quotas !== 'object' || usage.quotas === null) {
    recordFailure(state, key);
    console.warn(
      `[AutoPing] ${provider}:${conn.id}: usage unreadable` +
        `${usage?.message ? `: ${usage.message}` : ''} — skipping, not treating as cold`
    );
    return;
  }
  const quotas = usage.quotas;

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
      console.warn(
        `[AutoPing] ${provider}:${connection.id}: could not persist warm state: ${e.message}`
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

  // The governing window is spent. The poller is the only thing that knows that
  // before a real request finds out the hard way (#1125), and `rateLimitedUntil`
  // is the field account fallback already filters on, so writing the reset the
  // provider reported makes the account skipped the way a paused one is and
  // lapses on its own at reset.
  const governing = resolveQuotaEntry(quotas, providerConfig);
  if (governing && isQuotaExhausted(governing) && governing.resetAt) {
    await markRateLimitedUntil(connection, governing.resetAt, provider, deps);
  }
  if (
    providerConfig.skipWhenBlockingQuotaExhausted &&
    hasExhaustedBlockingQuota(quotas, providerConfig.quotaKey)
  ) {
    return;
  }

  // Nothing to warm writes NOTHING. The old scheduler's one durable write per
  // connection per window was already the right budget; a per-tick write to
  // record "still running" would be a write to learn nothing.
  if (!plan.shouldWarm) return;

  const targets = plan.targets;
  console.log(
    `[AutoPing] ${provider}:${connection.id}: warming ${targets.join(', ')} (${plan.reason})`
  );

  const sendPing = sendPingOverride || sendGenericPing;
  const ok = await sendPing(connection, providerConfig, proxyOptions, deps);
  if (!ok) {
    // Do not record a warm unless upstream took the tiny request.
    recordFailure(state, key);
    console.warn(
      `[AutoPing] ${provider}:${connection.id}: warm request failed for ${targets.join(', ')}`
    );
    return;
  }
  clearFailure(state, key);

  const nowIso = new Date().toISOString();
  const nextState = recordWarm({
    state: verdict.state,
    targets,
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
    await deps.updateProviderConnection(connection.id, {
      autoPingWindows: nextState,
      // Kept for the dashboard and for anything still reading the single-window
      // fields; the per-window map above is what the scheduler decides on.
      lastPingedResetAt: observedReset || null,
      lastPingedResetKey: observedReset ? normalizeResetKey(observedReset) : null,
      lastPingAt: nowIso,
      updatedAt: nowIso,
    });
  } catch (e) {
    // The ping was SPENT. Losing this write must not re-spend it: the mirror
    // above keeps the brake for this process, and the failure cooldown keeps a
    // dead DB from turning every tick into a token.
    recordFailure(state, key);
    console.warn(
      `[AutoPing] ${provider}:${connection.id}: warm spent but state write failed: ${e.message}`
    );
  }
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateConnectionProxyPoolSnapshotIfBound: localDb.updateConnectionProxyPoolSnapshotIfBound,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    proxyAwareFetch,
    getExecutor,
    getUsageForProvider,
  };
}

export async function runQuotaAutoPingTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();

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
        try {
          await pingConnection(conn, provider, providerConfig, sendPing, deps, state);
        } catch (e) {
          recordFailure(state, cacheKey(provider, conn.id));
          console.warn(`[AutoPing] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn('[AutoPing] tick error:', e.message);
  } finally {
    state.running = false;
  }
}

export function startQuotaAutoPing() {
  if (g.interval) return;
  console.log('[AutoPing] scheduler started');
  runQuotaAutoPingTick().catch(() => {});
  g.interval = setInterval(() => {
    runQuotaAutoPingTick().catch(() => {});
  }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQuotaAutoPing() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log('[AutoPing] scheduler stopped');
}

export function configureQuotaAutoPing(settings) {
  const enabled = Object.values(C.providers).some((providerConfig) =>
    Object.values(settings?.[providerConfig.settingsKey]?.connections || {}).some(Boolean)
  );
  if (enabled) startQuotaAutoPing();
  else stopQuotaAutoPing();
}
