// Outbound webhook notifications for critical gateway events (#3141).
//
// FAIL-OPEN IS THE WHOLE CONTRACT. Nothing on a routed request path may await
// this module: `emit()` returns synchronously after scheduling delivery, every
// failure is swallowed, and a webhook that is slow, down or hostile can only
// ever cost a background promise. There is no code path from here back into a
// request's response.
//
// SSRF. Endpoint URLs are operator-supplied and this process POSTs to them, so
// delivery goes through `fetchPublicUrl` (src/shared/utils/ssrfGuard.js), which
// re-checks every resolved address at connect time and so survives DNS
// rebinding and redirects. A blocked target is a permanent failure, never
// retried.

import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";
import { fetchPublicUrl, findBlockedError, assertPublicUrl } from "@/shared/utils/ssrfGuard.js";

// Only events derivable from state TokenProxy already persists. See watcher.js for
// the source of each; anything not listed there has no signal in this tree.
export const WEBHOOK_EVENTS = [
  "provider.unhealthy",
  "provider.recovered",
  "high.error.rate",
  "rule.fired",
  "project.budget.alert",
];

// Issue's contract: 3 retries after the first attempt, 1s / 5s / 30s.
const RETRY_DELAYS_MS = [1000, 5000, 30000];
const REQUEST_TIMEOUT_MS = 10000;
const HISTORY_LIMIT = 50;

// Survive Next.js hot reload — one delivery log per server process.
const g = (global.__webhookNotifications ??= { history: [] });

const DEFAULTS = {
  enabled: false,
  endpoints: [],
  errorRate: { threshold: 0.5, windowSeconds: 300, minSamples: 20 },
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function normalizeEndpoint(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return null;
  const events = Array.isArray(raw.events)
    ? raw.events.filter((e) => WEBHOOK_EVENTS.includes(e))
    : [];
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `wh-${index + 1}`,
    url,
    // An empty subscription means "everything" rather than "nothing" — a
    // silently mute endpoint is the harder failure to notice.
    events: events.length ? events : [...WEBHOOK_EVENTS],
    secret: typeof raw.secret === "string" ? raw.secret : "",
    active: raw.active !== false,
  };
}

export function normalizeNotificationsConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  cfg.enabled = cfg.enabled === true;
  cfg.endpoints = (Array.isArray(cfg.endpoints) ? cfg.endpoints : [])
    .map(normalizeEndpoint)
    .filter(Boolean);
  const rate = { ...DEFAULTS.errorRate, ...(cfg.errorRate || {}) };
  cfg.errorRate = {
    threshold: clampNumber(rate.threshold, 0.01, 1, DEFAULTS.errorRate.threshold),
    windowSeconds: clampNumber(rate.windowSeconds, 60, 86400, DEFAULTS.errorRate.windowSeconds),
    minSamples: clampNumber(rate.minSamples, 1, 100000, DEFAULTS.errorRate.minSamples),
  };
  return cfg;
}

export async function getNotificationsConfig() {
  const settings = await getSettings();
  return normalizeNotificationsConfig(settings?.notifications);
}

// Validates before persisting so a bad URL is a 400 at config time rather than
// a silent delivery failure later.
export async function saveNotificationsConfig(patch) {
  const next = normalizeNotificationsConfig({
    ...(await getNotificationsConfig()),
    ...(patch || {}),
  });
  for (const endpoint of next.endpoints) assertPublicUrl(endpoint.url);
  await updateSettings({ notifications: next });
  return next;
}

export function signPayload(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const sleep = (ms, signal) => delay(ms, undefined, { signal });

function recordDelivery(entry) {
  g.history.unshift(entry);
  if (g.history.length > HISTORY_LIMIT) g.history.length = HISTORY_LIMIT;
}

export function getDeliveryHistory() {
  return g.history.slice();
}

/**
 * One endpoint, one event. Resolves with a result object; never throws.
 *
 * `retries: 0` is what the manual test button uses — an operator waiting on a
 * button must not sit through 36s of backoff to learn the URL is wrong.
 */
export async function deliver(endpoint, event, data, options = {}) {
  const {
    fetchImpl = fetchPublicUrl,
    delays = RETRY_DELAYS_MS,
    wait = sleep,
    now = () => new Date().toISOString(),
  } = options;
  const retries = options.retries ?? delays.length;

  const body = JSON.stringify({ event, data, deliveredAt: now() });
  const headers = {
    "content-type": "application/json",
    "user-agent": "tokenproxy-webhook/1",
    "x-tp-event": event,
  };
  if (options.deliveryId) headers["x-tp-delivery-id"] = options.deliveryId;
  if (endpoint.secret) headers["x-tp-signature"] = signPayload(endpoint.secret, body);

  let lastError = null;
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) return {
      ok: false, cancelled: attempt === 0, uncertain: attempt > 0,
      status: null, attempts: attempt, error: "Delivery cancelled",
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(endpoint.url, {
        method: "POST",
        headers,
        body,
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true, status: res.status, attempts: attempt + 1, error: null };
      // 4xx other than 429 is the receiver rejecting the payload — retrying an
      // unauthorized or malformed POST just multiplies the noise.
      if (res.status < 500 && res.status !== 429) {
        return { ok: false, status: res.status, attempts: attempt + 1, error: `HTTP ${res.status}` };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      if (options.signal?.aborted) return {
        ok: false, uncertain: true, status: null, attempts: attempt + 1,
        error: "Delivery interrupted before confirmation",
      };
      if (findBlockedError(err)) {
        return {
          ok: false,
          status: null,
          attempts: attempt + 1,
          error: "blocked: endpoint does not resolve to a public address",
        };
      }
      lastError = controller.signal.aborted ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : "Delivery transport failed";
    } finally {
      clearTimeout(timer);
    }

    if (attempt >= retries) {
      return { ok: false, status: null, attempts: attempt + 1, error: lastError };
    }
    try {
      await wait(delays[Math.min(attempt, delays.length - 1)], options.signal);
    } catch {
      return { ok: false, uncertain: true, status: null, attempts: attempt + 1,
        error: "Delivery interrupted during retry delay" };
    }
  }
}

/** Fan out one event to every subscribed, active endpoint. Never throws. */
export async function dispatch(event, data, options = {}) {
  const config = options.config ?? (await getNotificationsConfig());
  if (!config.enabled) return { delivered: 0, skipped: "disabled" };

  const targets = config.endpoints.filter((e) => e.active && e.events.includes(event));
  if (targets.length === 0) return { delivered: 0, skipped: "no-subscribers" };

  const results = new Array(targets.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
    while (index < targets.length) {
      const slot = index++;
      const endpoint = targets[slot];
      const result = await deliver(endpoint, event, data, options);
      recordDelivery({
        at: new Date().toISOString(),
        endpointId: endpoint.id,
        event,
        ok: result.ok,
        status: result.status,
        attempts: result.attempts,
        error: result.error,
      });
      results[slot] = result;
    }
  }));
  return { delivered: results.filter((r) => r.ok).length, results };
}

/**
 * Fire-and-forget entry point. Returns immediately — callers on any hot path
 * must use this and never `dispatch` directly.
 */
export function emit(event, data, options = {}) {
  dispatch(event, data, options).catch((err) => {
    console.warn("[Webhooks] dispatch failed:", err?.message || err);
  });
}
