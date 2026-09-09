// Turns state TokenProxy ALREADY persists into webhook events (#3141).
//
// NO NEW INSTRUMENTATION. Every signal read here is written by code that
// already runs; nothing was added to a request path to feed this:
//
//   provider.unhealthy / provider.recovered
//     ← providerConnections.testStatus / errorCode / rateLimitedUntil, written
//       by src/sse/services/auth.js (421-489) when an upstream rejects a
//       request and cleared at 556-558 when one succeeds. The predicate is
//       isConnectionDegraded() from connectionsRepo.js:363 — the same one the
//       dashboard's health counts use, so an alert and the UI can never
//       disagree.
//   high.error.rate
//     ← requestStats, via getTrafficWindow() (requestStatsRepo.js:397), the
//       exact source /api/system/state already reports errorRate from.
//
// Traffic and one unreferenced background timer share the same throttles.
// Idle gateways therefore still observe stale evidence. Shutdown removes both
// triggers and aborts outstanding analytics before its worker/database close.
//
//   notification rules
//     ← the operator's own rules, evaluated by evaluateEnabledRules()
//       (notificationRulesRepo.js:411) through the bounded analytics worker it
//       already uses. Same trigger, its own interval; see MIN_RULE_INTERVAL_MS.
//
// Everything here is fail-open: evaluate() and evaluateRules() swallow their own
// errors and emit() is fire-and-forget, so a broken webhook cannot reach a
// routed request.

import { getProviderConnections, isConnectionDegraded } from "@/lib/db/repos/connectionsRepo.js";
import { getTrafficWindow } from "@/lib/db/repos/requestStatsRepo.js";
import { statsEmitter } from "@/lib/db/repos/usageRepo.js";
import { emit, getNotificationsConfig } from "./webhooks.js";
import { registerShutdownFlusher } from "@/lib/shutdown.js";

const MIN_INTERVAL_MS = 30000;

// Rule evaluation gets its own, longer interval because it is not the same
// weight as the connection scan above. The connection scan is two in-process
// SQLite reads. One rule scan is one query PER ENABLED RULE, each dispatched to
// the bounded analytics worker (client.js:8, QUERY_TIMEOUT_MS 15000) over the
// retained population, capped at NOTIFICATION_EVIDENCE_MAX_ROWS = 20000 rows,
// plus one last-firing read per scope group. A ten-rule install therefore pays
// ten sequential worker round trips per scan, and the worker is the same one the
// quota workbench and the operation ledger queue against (MAX_QUEUED = 8).
//
// 300s is chosen against what it buys rather than against what it costs: no rule
// can re-fire faster than MIN_COOLDOWN_SECONDS = 60 (notificationRulesRepo.js:30),
// and durationSeconds is the operator's own tolerance for how long a condition
// must hold, measured in minutes in practice. So the interval adds at most five
// minutes of detection latency on top of a delay the operator already chose,
// and in exchange a busy gateway pays one scan per five minutes instead of one
// per traffic tick. Raise it if a large rule set makes the worker contended;
// lowering it below the cooldown floor buys nothing.
const MIN_RULE_INTERVAL_MS = 300000;

// Survive Next.js hot reload — one watcher and one state snapshot per process.
const g = (global.__notificationWatcher ??= {
  subscribed: false,
  lastRunAt: 0,
  running: false,
  // connectionId -> was degraded at the previous evaluation. Absent means
  // "never seen": the first sighting seeds silently, so a restart with an
  // already-broken account does not replay it as a fresh incident.
  degraded: new Map(),
  errorRateFiring: false,
  lastRuleRunAt: 0,
  ruleRunning: false,
  // The rules' equivalent of that silent first sighting. Captured at module
  // load, which is process start, and handed to the evaluator as its notBefore
  // boundary. See evaluateRules() for exactly what a restart does.
  startedAt: new Date().toISOString(),
});

function describe(conn) {
  return {
    provider: conn.provider,
    connectionId: conn.id,
    account: conn.name || conn.email || null,
    testStatus: conn.testStatus ?? null,
    errorCode: conn.errorCode ?? null,
    rateLimitedUntil: conn.rateLimitedUntil ?? null,
  };
}

/**
 * One diff pass. Returns the events it produced (also useful as the API's
 * "evaluate now" response). Never throws.
 */
export async function evaluate(deps = {}) {
  const {
    listConnections = getProviderConnections,
    trafficWindow = getTrafficWindow,
    degradedPredicate = isConnectionDegraded,
    config: providedConfig,
    send = emit,
    state = g,
    now = Date.now(),
  } = deps;

  const events = [];
  try {
    const config = providedConfig ?? (await getNotificationsConfig());
    if (!config.enabled) return { skipped: "disabled", events };

    const connections = await listConnections({ isActive: true });
    const seen = new Set();
    for (const conn of connections) {
      seen.add(conn.id);
      const bad = degradedPredicate(conn, now);
      const previous = state.degraded.get(conn.id);
      state.degraded.set(conn.id, bad);
      if (previous === undefined || previous === bad) continue;
      events.push({ event: bad ? "provider.unhealthy" : "provider.recovered", data: describe(conn) });
    }
    // A deleted or disabled connection is not a recovery — drop it silently so
    // re-enabling it later seeds again instead of firing a phantom event.
    for (const id of [...state.degraded.keys()]) {
      if (!seen.has(id)) state.degraded.delete(id);
    }

    const { threshold, windowSeconds, minSamples } = config.errorRate;
    const since = new Date(now - windowSeconds * 1000).toISOString();
    const traffic = await trafficWindow(since);
    // Below minSamples there is no rate to report — 1 error out of 1 request is
    // not a 100% error rate, and firing on it is how alerting gets muted.
    if (traffic && traffic.requests >= minSamples) {
      const rate = traffic.errors / traffic.requests;
      const firing = rate >= threshold;
      if (firing && !state.errorRateFiring) {
        events.push({
          event: "high.error.rate",
          data: {
            rate,
            threshold,
            windowSeconds,
            requests: traffic.requests,
            errors: traffic.errors,
          },
        });
      }
      state.errorRateFiring = firing;
    }

    for (const { event, data } of events) send(event, data);
    return { skipped: null, events };
  } catch (err) {
    console.warn("[Webhooks] watcher evaluation failed:", err?.message || err);
    return { skipped: "error", error: err?.message || String(err), events };
  }
}

/**
 * One rule scan. Delegates wholly to evaluateEnabledRules(), which owns
 * durationSeconds, cooldownSeconds and the partial unique index that keeps two
 * racing evaluators to one alert row; none of that is restated here.
 *
 * ON RESTART: the evaluator reads a retained population that reaches back 30
 * days, so it is asked to suppress any firing dated before this process started
 * (state.startedAt). A breach that began and ended while the gateway was down is
 * therefore never replayed as a fresh alert, while a breach still producing
 * evidence now does alert, dated at that new evidence and carrying its true
 * breachStartedAt from before the restart. The cost of the boundary is the
 * mirror image of the connection watcher's: a condition that stopped generating
 * evidence before the restart, a quota window that went quiet for instance,
 * stays silent until one more observation lands for it.
 *
 * The evaluator is reached by dynamic import so this module's own import graph
 * stays what it was. watcher.js is loaded at boot and from request-adjacent
 * routes, and a static edge here would pull the analytics worker client into
 * both.
 *
 * Never throws, and never writes anything but an alert row: no route, account or
 * profile is touched by a firing.
 */
export async function evaluateRules(deps = {}) {
  const { state = g, rules: run, signal, notBefore = state.startedAt } = deps;
  try {
    signal?.throwIfAborted();
    const evaluator =
      run ??
      (await import("@/lib/db/repos/notificationRulesRepo.js")).evaluateEnabledRules;
    // No start/end: the evaluator's default window is the retained population,
    // and narrowing it would cut the history a long durationSeconds needs to
    // establish a sustain. notBefore, not a shorter window, is what stops replay.
    return await evaluator({ notBefore, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (signal?.aborted) return { skipped: "aborted", evaluated: 0, fired: 0, events: [] };
    console.warn("[Notifications] rule evaluation failed:", err?.message || err);
    return {
      skipped: "error",
      error: err?.message || String(err),
      evaluated: 0,
      fired: 0,
      events: [],
    };
  }
}

/**
 * The single statsEmitter handler. Two scans, two independent throttles, one
 * subscription — statsEmitter is a process-wide singleton capped at 50
 * listeners and /api/usage/stream takes two per connected dashboard, so a second
 * listener here would spend a slot for nothing.
 *
 * Each throttle stamps its clock BEFORE the run and clears its in-flight flag in
 * a finally, and neither scan throws, so a failing scan cannot wedge the other
 * or stop later scans of its own kind. The scans are not awaited against each
 * other: a rule scan that sits on the analytics worker for a while must not
 * delay the connection scan, which is the fast one.
 */
export async function onStatsUpdate(deps = {}) {
  const { state = g, now = Date.now() } = deps;
  if (deps.signal?.aborted) return;
  const pending = [];
  if (!state.running && now - state.lastRunAt >= MIN_INTERVAL_MS) {
    state.running = true;
    state.lastRunAt = now;
    pending.push(
      evaluate({ ...deps, state, now }).finally(() => {
        state.running = false;
      }),
    );
  }
  if (!state.ruleRunning && now - state.lastRuleRunAt >= MIN_RULE_INTERVAL_MS) {
    state.ruleRunning = true;
    state.lastRuleRunAt = now;
    pending.push(
      evaluateRules({ ...deps, state }).finally(() => {
        state.ruleRunning = false;
      }),
    );
  }
  if (deps.deliveries && !state.deliveryRunning && now - (state.lastDeliveryRunAt ?? 0) >= MIN_INTERVAL_MS) {
    state.deliveryRunning = true;
    state.lastDeliveryRunAt = now;
    pending.push(Promise.resolve().then(() => deps.deliveries({ signal: deps.signal })).catch(err => {
      if (!deps.signal?.aborted) console.warn('[Notifications] delivery queue unavailable:', err?.name ?? 'Error');
    }).finally(() => { state.deliveryRunning = false; }));
  }
  if (deps.actions && !state.actionRunning && now - (state.lastActionRunAt ?? 0) >= MIN_INTERVAL_MS) {
    state.actionRunning = true;
    state.lastActionRunAt = now;
    pending.push(Promise.resolve().then(() => deps.actions({ signal: deps.signal })).catch(() => {
      if (!deps.signal?.aborted) console.warn('[Notifications] authorized local actions are unavailable.');
    }).finally(() => { state.actionRunning = false; }));
  }
  await Promise.all(pending);
}

/**
 * Idempotent. Safe to call from any request handler; the subscription is
 * process-wide and installed at most once.
 *
 * Wired at boot from src/instrumentation.js:44, so a headless gateway arms both
 * scans without anyone opening the dashboard. The /api/notifications calls stay
 * as a fallback for a bare entrypoint that never runs the instrumentation hook.
 */
export function ensureWatcher(deps = {}) {
  const { state = g, emitter = statsEmitter } = deps;
  if (state.subscribed) return false;
  state.subscribed = true;
  state.stopPromise = null;
  state.controller = new AbortController();
  state.jobs = new Set();
  state.emitter = emitter;
  const signal = state.controller.signal;
  state.handler = () => {
    if (signal.aborted) return;
    const deliveries = deps.deliveries ?? (async options => {
      const { drainNotifications } = await import('./delivery.js');
      return drainNotifications(options);
    });
    const actions = deps.actions ?? (async options => {
      const { drainAuthorizedActions } = await import('./remediationQueue.js');
      return drainAuthorizedActions(options);
    });
    const job = onStatsUpdate({ ...deps, state, signal, deliveries, actions }).catch(() => {});
    state.jobs.add(job);
    job.finally(() => state.jobs.delete(job));
  };
  emitter.on("update", state.handler);
  state.timer = setInterval(state.handler, MIN_INTERVAL_MS);
  state.timer.unref?.();
  state.unregisterShutdown = registerShutdownFlusher(() => stopWatcher({ state }), -90);
  state.handler();
  return true;
}

export function stopWatcher({ state = g } = {}) {
  if (state.stopPromise) return state.stopPromise;
  state.subscribed = false;
  clearInterval(state.timer);
  state.timer = null;
  state.emitter?.removeListener?.("update", state.handler);
  state.unregisterShutdown?.();
  state.unregisterShutdown = null;
  state.controller?.abort(new DOMException("Notification watcher stopped", "AbortError"));
  state.stopPromise = Promise.allSettled([...(state.jobs ?? [])]).then(() => undefined);
  return state.stopPromise;
}
