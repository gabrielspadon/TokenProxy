import { fetch as undiciFetch } from 'undici';
import { createProxyDispatcher } from 'open-sse/utils/proxyFetch.js';

import { fetchPublicUrl, findBlockedError } from '@/shared/utils/ssrfGuard.js';

const DEFAULT_TEST_URL = 'https://google.com/';
const DEFAULT_TIMEOUT_MS = 8000;
const RELAY_TIMEOUT_MS = 30000;
const RELAY_PROBE_TARGET = 'https://api.ipify.org';
const RELAY_PROBE_PATH = '/?format=json';

// Probe concurrency is a counting semaphore with a bounded waiting room:
// beyond it a probe is refused outright rather than queued without limit.
// The permit is held through dispatcher cleanup, not just through the fetch.
const MAX_CONCURRENT_PROBES = 4;
const MAX_WAITING_PROBES = 16;
let activeProbes = 0;
const probeWaiters = [];

function acquireProbePermit() {
  if (activeProbes < MAX_CONCURRENT_PROBES) {
    activeProbes++;
    return Promise.resolve(true);
  }
  if (probeWaiters.length >= MAX_WAITING_PROBES) return Promise.resolve(false);
  return new Promise((resolve) => probeWaiters.push(resolve)).then(() => true);
}

function releaseProbePermit() {
  const next = probeWaiters.shift();
  if (next) next();
  else activeProbes--;
}

// Diagnostics stay bounded and carry no credentials: userinfo is stripped from
// any URL embedded in an upstream error message, and the message is truncated.
const DIAGNOSTIC_MAX_CHARS = 256;
function redactDiagnostic(message) {
  return String(message)
    .replace(/\/\/[^\s/@]+@/g, '//')
    .slice(0, DIAGNOSTIC_MAX_CHARS);
}

function getErrorMessage(err) {
  if (!err) return 'Unknown error';
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return redactDiagnostic(
      causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`
    );
  }

  if (causeCode && !base.includes(causeCode)) {
    return redactDiagnostic(`${base} (${causeCode})`);
  }

  return redactDiagnostic(base);
}

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

// One controller that aborts on timeout OR on the caller's own signal, and
// remembers which. A caller cancelling a probe is not a probe failure.
function probeController(signal, timeoutMs) {
  const controller = new AbortController();
  const state = { timedOut: false, cancelled: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    state.cancelled = true;
    controller.abort();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    state,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Probe a vercel/cloudflare relay pool entry.
 *
 * The relay URL is fetched DIRECTLY by this server, so it is guarded with
 * `fetchPublicUrl`: `assertPublicUrl` rejects literal internal targets before any
 * socket opens, and the public-only connector rejects a hostname that resolves or
 * redirects to one. A relay is always a public serverless deployment, so nothing
 * legitimate is lost. `testProxyUrl` below is deliberately NOT guarded: there the
 * URL is a proxy the operator dials THROUGH, and a proxy on the LAN or on loopback
 * is a normal configuration rather than a forged request.
 */
export async function testRelayUrl({ relayUrl, signal } = {}) {
  const normalizedRelayUrl = normalizeString(relayUrl);
  if (!normalizedRelayUrl) {
    return {
      ok: false,
      status: 400,
      error: 'Blocked relay URL: missing host. A relay pool must point at a public URL.',
    };
  }

  if (!(await acquireProbePermit())) {
    return { ok: false, status: 429, error: 'Too many concurrent proxy tests. Retry shortly.' };
  }

  const probe = probeController(signal, RELAY_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetchPublicUrl(normalizedRelayUrl, {
      method: 'GET',
      headers: {
        'x-relay-target': RELAY_PROBE_TARGET,
        'x-relay-path': RELAY_PROBE_PATH,
      },
      signal: probe.signal,
    });

    // The probe reads the status only; release the unused body.
    res.body?.cancel?.().catch?.(() => {});

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const blocked = findBlockedError(err);
    if (blocked) {
      return {
        ok: false,
        status: 400,
        error: `${blocked.message}. A relay pool must point at a public URL.`,
      };
    }

    if (probe.state.cancelled) {
      return { ok: false, status: 499, cancelled: true, error: 'Relay test cancelled' };
    }

    return {
      ok: false,
      status: 500,
      timedOut: probe.state.timedOut || err?.name === 'AbortError',
      error:
        probe.state.timedOut || err?.name === 'AbortError'
          ? 'Relay test timed out'
          : getErrorMessage(err),
    };
  } finally {
    probe.cleanup();
    releaseProbePermit();
  }
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs, signal } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: 'proxyUrl is required' };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  if (!(await acquireProbePermit())) {
    return { ok: false, status: 429, error: 'Too many concurrent proxy tests. Retry shortly.' };
  }

  let dispatcher;

  try {
    try {
      // A socks URL needs a socks connector, not a CONNECT proxy: building a
      // ProxyAgent for one rejected the scheme outright, so a working socks5
      // proxy was reported as invalid on the settings screen (#2053).
      dispatcher = await createProxyDispatcher(normalizedProxyUrl);
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${getErrorMessage(err)}`,
      };
    }

    const probe = probeController(signal, normalizedTimeoutMs);
    const startedAt = Date.now();

    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: 'HEAD',
        dispatcher,
        signal: probe.signal,
        headers: {
          'User-Agent': 'TokenProxy',
        },
      });

      res.body?.cancel?.().catch?.(() => {});

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (probe.state.cancelled) {
        return { ok: false, status: 499, cancelled: true, error: 'Proxy test cancelled' };
      }
      const timedOut = probe.state.timedOut || err?.name === 'AbortError';
      return {
        ok: false,
        status: 500,
        timedOut,
        error: timedOut ? 'Proxy test timed out' : getErrorMessage(err),
      };
    } finally {
      probe.cleanup();
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
    releaseProbePermit();
  }
}
