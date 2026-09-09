import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import crypto from "crypto";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { createDispatcherCache, isLocalTransportPoolRefusal, LocalTransportPoolRefusal, revokeLocalTransportRefusalProof } from "./dispatcherCache.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = createDispatcherCache(MEMORY_CONFIG.proxyDispatchersMaxSize);
const HAPPY_EYEBALLS_OPTIONS = {
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 1000,
};
let directDispatcherPromise = null;
let transportsClosing = false;

function throwIfTransportClosing() {
  if (!transportsClosing) return;
  throw new LocalTransportPoolRefusal("transport_pools_closed");
}

async function getDirectDispatcher() {
  if (!directDispatcherPromise) {
    // bodyTimeout: 0 matches the proxy dispatcher below. undici's default is
    // 300s between body chunks, which is SHORTER than the app-level stall
    // guard (STREAM_STALL_TIMEOUT_MS, 360s), so a reasoning stream quiet for
    // five minutes died with UND_ERR_BODY_TIMEOUT on the direct path while
    // surviving through a proxy. Stall protection stays app-level, where it
    // is tied to upstream byte activity and configurable.
    directDispatcherPromise = import("undici")
      .then(({ Agent }) => new Agent({ ...HAPPY_EYEBALLS_OPTIONS, bodyTimeout: 0 }))
      .catch(error => { directDispatcherPromise = null; throw error; });
  }
  return directDispatcherPromise;
}

async function fetchDirect(url, options, attempt) {
  throwIfTransportClosing();
  const dispatcher = options.dispatcher ?? await getDirectDispatcher();
  throwIfTransportClosing();
  attempt.dispatched = true;
  return originalFetch(url, { ...options, dispatcher });
}

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "proxy.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 90_000;
const DEFAULT_PROXY_HEADERS_TIMEOUT_MS = 300_000;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Render a proxy or relay URL for a log line. A proxy URL routinely carries
 * `user:password@` userinfo and a relay URL routinely carries a deploy token in
 * its path or query, so only the scheme, host and port are ever printed. An
 * unparseable value is REPLACED rather than echoed: the values that fail
 * `new URL()` are the hand-typed ones most likely to hold an odd secret (#2343).
 */
export function redactProxyUrlForLog(proxyUrl) {
  try {
    const parsed = new URL(normalizeString(proxyUrl));
    if (!parsed.hostname) return "[invalid proxy URL]";
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "[invalid proxy URL]";
  }
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = normalizeString(process.env[name]);
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

function getAbortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw getAbortReason(signal);
}

// An abort is never a reason to retry without the proxy. throwIfAborted only
// sees the CALLER's signal, so an abort raised anywhere else — a dispatcher's
// own AbortSignal.timeout, a composed signal the caller never handed us — left
// `signal.aborted` false and the proxy failure handler treated a cancelled
// request as an unreachable proxy. The pasted log shows the result:
// "[ProxyFetch] Proxy failed, falling back to direct bypass: This operation was
// aborted" (#2211). That retries a request nobody is waiting for, and sends it
// outside the proxy the user configured.
function isAbortError(error) {
  if (!error) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error.code === "ABORT_ERR" || error.code === "ABORT_ERROR") return true;
  // Last resort: undici and Node surface the DOMException message verbatim, and
  // some wrappers drop the name on the way out.
  return /operation was aborted|the operation was aborted/i.test(String(error.message || ""));
}

function waitWithSignal(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(getAbortReason(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname, signal) {
  throwIfAborted(signal);
  const cached = DNS_CACHE.get(hostname);
  // A cached null is a remembered FAILURE, not a miss, so `ip` is read only
  // after the expiry check (#864).
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    // Bounded, because the default is 5s x 4 tries against a resolver this host
    // may not reach at all, and that whole stall sits in front of the request.
    const resolver = new dns.Resolver({
      timeout: MEMORY_CONFIG.dnsQueryTimeoutMs,
      tries: MEMORY_CONFIG.dnsQueryTries,
    });
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    throwIfAborted(signal);
    const addresses = await waitWithSignal(resolve4(hostname), signal);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    throwIfAborted(signal);
    // Remember the failure for a short window (#864). Every MITM-bypass host
    // used to re-run this on every request, so a deployment with no route to
    // the external resolver paid the full lookup before each fall-through to
    // native fetch. An abort is NOT cached: it says nothing about the host.
    DNS_CACHE.set(hostname, { ip: null, expiry: Date.now() + MEMORY_CONFIG.dnsFailCacheTtlMs });
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

/**
 * Loopback targets are never reachable through an outbound proxy: the proxy would
 * resolve `localhost` against ITS own machine. A local provider (ollama-local, a
 * self-hosted TTS/STT, a local relay) therefore fails with a connection error the
 * moment `HTTP_PROXY` is set in the environment — which is the normal state on a
 * corporate Windows box. Node's own `fetch` ignores those variables entirely, so
 * "curl works, node works, tokenproxy does not" is the expected shape of the bug.
 *
 * Bypass is limited to loopback. A LAN address (a remote Ollama on 192.168.x)
 * can legitimately need a proxy, and `NO_PROXY` still covers that case.
 */
export function isLoopbackTarget(targetUrl) {
  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }

  // URL keeps IPv6 literals in brackets.
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

  // IPv4-mapped loopback. `new URL()` re-serializes `[::ffff:127.0.0.1]` as
  // `::ffff:7f00:1`, so the dotted form alone would miss the value we actually see.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hexMapped) return ((parseInt(hexMapped[1], 16) >> 8) & 0xff) === 127;

  const dottedMapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  const ipv4 = dottedMapped ? dottedMapped[1] : host;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  if (isLoopbackTarget(targetUrl)) return null;

  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;
  if (isLoopbackTarget(targetUrl)) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

const TUNNEL_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

function isSupportedTunnelScheme(proxyUrl) {
  try {
    return TUNNEL_PROXY_PROTOCOLS.has(new URL(proxyUrl).protocol);
  } catch {
    return false;
  }
}

function hashRouteUrl(proxyUrl) {
  return crypto.createHash("sha256")
    .update(new URL(proxyUrl).toString())
    .digest("hex");
}

function inferResolutionKind(proxyOptions = {}) {
  const declared = normalizeString(proxyOptions.resolutionKind);
  if (["selected-proxy", "intentional-direct", "unselected", "required-unavailable"].includes(declared)) {
    return declared;
  }
  if (normalizeString(proxyOptions.connectionProxyMode) === "direct") return "intentional-direct";
  if (
    proxyOptions.enabled === true
    || proxyOptions.connectionProxyEnabled === true
    || normalizeString(proxyOptions.vercelRelayUrl)
  ) return "selected-proxy";
  return "unselected";
}

/**
 * Resolve connection provenance into the one route a transport may attempt.
 * The optional third argument is intentionally internal-facing so fake transport
 * tests can prove unavailable selections never consult environment policy.
 */
export function resolveEffectiveProxyRoute(targetUrl, proxyOptions = {}, {
  getEnvProxyUrl: resolveEnvProxyUrl = getEnvProxyUrl,
} = {}) {
  const resolutionKind = inferResolutionKind(proxyOptions);
  const strictProxy = proxyOptions.strictProxy === true;

  if (resolutionKind === "required-unavailable") {
    return {
      kind: "required-unavailable",
      strictProxy,
      reason: normalizeString(proxyOptions.reason) || "selected-proxy-unavailable",
      cacheIdentity: null,
    };
  }

  if (resolutionKind === "intentional-direct") {
    return { kind: "direct", strictProxy: false, cacheIdentity: "direct" };
  }

  if (resolutionKind === "selected-proxy") {
    if (normalizeString(proxyOptions.vercelRelayUrl)) {
      return { kind: "relay", strictProxy, cacheIdentity: null };
    }
    if (
      isLoopbackTarget(targetUrl)
      || shouldBypassByNoProxy(targetUrl, proxyOptions.connectionNoProxy ?? proxyOptions.noProxy)
    ) {
      return { kind: "direct", strictProxy: false, cacheIdentity: "direct" };
    }

    const selectedProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
    if (!selectedProxyUrl || !isSupportedTunnelScheme(selectedProxyUrl)) {
      return {
        kind: "required-unavailable",
        strictProxy,
        reason: "selected-proxy-invalid",
        cacheIdentity: null,
      };
    }

    return {
      kind: "proxy",
      strictProxy,
      proxyUrl: selectedProxyUrl,
      cacheIdentity: `proxy:${hashRouteUrl(selectedProxyUrl)}`,
    };
  }

  const envProxyUrl = normalizeProxyUrl(resolveEnvProxyUrl(targetUrl));
  if (!envProxyUrl) return { kind: "direct", strictProxy: false, cacheIdentity: "direct" };
  return {
    kind: "proxy",
    strictProxy: false,
    proxyUrl: envProxyUrl,
    cacheIdentity: `proxy:${hashRouteUrl(envProxyUrl)}`,
  };
}

function requiredProxyUnavailableError(route) {
  const error = new Error("Required proxy is unavailable");
  error.code = "required_proxy_unavailable";
  error.reason = route.reason;
  return error;
}

// Connection pool limits — prevent socket exhaustion under concurrent upstream load
const PROXY_MAX_CONNECTIONS = 64;
const PROXY_MAX_FREE_CONNECTIONS = 32;
const KEEP_ALIVE_TIMEOUT = 60_000;

/**
 * Build an undici dispatcher for one proxy URL.
 *
 * undici's ProxyAgent speaks HTTP CONNECT only. resolveEffectiveProxyRoute has
 * always accepted socks:, socks4:, socks4a:, socks5: and socks5h:, so a socks
 * proxy was configured happily and then failed every request at the transport
 * (#2053). socks-proxy-agent is already a dependency — the http2 path tunnels
 * through it — and it hands back a connected socket, which is exactly what
 * undici's `connect` hook wants.
 */
export async function createProxyDispatcher(proxyUrl, agentOptions = {}) {
  const isSocks = new URL(proxyUrl).protocol.startsWith("socks");
  if (!isSocks) {
    const { ProxyAgent } = await import("undici");
    return new ProxyAgent({ uri: proxyUrl, ...agentOptions });
  }

  const [{ Agent }, { SocksProxyAgent }] = await Promise.all([
    import("undici"),
    import("socks-proxy-agent"),
  ]);
  const socksAgent = new SocksProxyAgent(proxyUrl);
  return new Agent({
    ...agentOptions,
    connect(options, callback) {
      const secureEndpoint = options.protocol === "https:";
      socksAgent
        .connect(null, {
          ...options,
          host: options.hostname,
          port: options.port || (secureEndpoint ? 443 : 80),
          secureEndpoint,
          servername: options.servername || options.hostname,
          ALPNProtocols: ["http/1.1"],
        })
        .then((socket) => callback(null, socket), (error) => callback(error));
    },
  });
}

/**
 * Create proxy dispatcher lazily (undici-compatible) with connection limits
 */
function getDispatcher(proxyUrl, routeIdentity) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;
  const connectTimeout = readPositiveIntegerEnv(
    "PROXY_CONNECT_TIMEOUT_MS",
    DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
  );
  const headersTimeout = readPositiveIntegerEnv(
    "PROXY_HEADERS_TIMEOUT_MS",
    DEFAULT_PROXY_HEADERS_TIMEOUT_MS,
  );
  // Credentials are part of the private identity, never part of diagnostics.
  const key = `${routeIdentity}:${connectTimeout}:${headersTimeout}`;
  return proxyDispatchers.reserve(key, async () => {
    const undici = await import("undici");
    const pools = new Set();
    const factory = (origin, options) => {
      const pool = new undici.Pool(origin, options);
      pools.add(pool);
      const prune = () => queueMicrotask(() => {
        if (pool.closed || pool.destroyed || (pool.stats.connected === 0 && pool.stats.size === 0)) pools.delete(pool);
      });
      pool.on("connect", () => pools.add(pool));
      pool.on("disconnect", prune);
      pool.on("connectionError", prune);
      return pool;
    };
    const dispatcher = await createProxyDispatcher(normalized, {
      ...HAPPY_EYEBALLS_OPTIONS,
      connections: PROXY_MAX_CONNECTIONS,
      keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT,
      keepAliveTimeout: 4000,
      bodyTimeout: 0,
      headersTimeout,
      connectTimeout,
      pipelining: 1,
      maxCachedSessions: PROXY_MAX_FREE_CONNECTIONS,
      factory,
    });
    return { dispatcher, isIdle: () => [...pools].every(pool => pool.stats.size === 0) };
  });
}

// Explicit graceful shutdown seam. It performs no process/signal registration.
export async function closeTransportDispatchers() {
  transportsClosing = true;
  await Promise.all([
    proxyDispatchers.close(),
    Promise.resolve(directDispatcherPromise).then(direct => direct?.close?.()),
  ]);
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const signal = options.signal;
  const [httpsModule, netModule] = await waitWithSignal(
    Promise.all([import("https"), import("net")]),
    signal,
  );
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let req = null;
    let headersSettled = false;
    let abortHandled = false;

    const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
    const rejectBeforeHeaders = (error) => {
      if (headersSettled) return;
      headersSettled = true;
      cleanupAbort();
      reject(error);
    };
    const onTransportError = (error) => {
      const rejection = signal?.aborted ? getAbortReason(signal) : error;
      if (headersSettled) {
        cleanupAbort();
        return;
      }
      rejectBeforeHeaders(rejection);
    };
    const onAbort = () => {
      if (abortHandled) return;
      abortHandled = true;
      const reason = getAbortReason(signal);
      cleanupAbort();
      const wasPending = !headersSettled;
      headersSettled = true;
      try { req?.destroy(reason); } catch { }
      try { socket.destroy(reason); } catch { }
      if (wasPending) reject(reason);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    socket.connect(HTTPS_PORT, realIP, () => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      req = https.request(reqOptions, (res) => {
        if (signal?.aborted) {
          onAbort();
          return;
        }
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        headersSettled = true;
        res.once("end", cleanupAbort);
        res.once("close", cleanupAbort);
        res.once("error", cleanupAbort);
        resolve(response);
      });

      req.on("error", onTransportError);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", onTransportError);
  });
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const attempt = { dispatched: false };
  try {
    return await performProxyAwareFetch(url, options, proxyOptions, attempt);
  } catch (error) {
    // A local refusal after an earlier legacy GET fallback attempt cannot prove
    // that the entire call sent nothing upstream. Never release exposure on it.
    if (attempt.dispatched) revokeLocalTransportRefusalProof(error);
    throw error;
  }
}

async function performProxyAwareFetch(url, options, proxyOptions, attempt) {
  throwIfAborted(options.signal);
  throwIfTransportClosing();
  const request = typeof Request !== 'undefined' && url instanceof Request ? url : null;
  const replayableMethod = ['GET', 'HEAD', 'OPTIONS'].includes(String(options.method ?? request?.method ?? 'GET').toUpperCase());
  const targetUrl = typeof url === "string" ? url : request?.url ?? url.toString();
  const route = resolveEffectiveProxyRoute(targetUrl, proxyOptions || {});

  if (route.kind === "required-unavailable") throw requiredProxyUnavailableError(route);

  // Vercel relay: forward request via relay headers
  if (route.kind === "relay") {
    const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return fetchDirect(vercelRelayUrl, { ...options, headers: relayHeaders }, attempt);
  }

  const proxyUrl = route.kind === "proxy" ? route.proxyUrl : null;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      let dispatched = false;
      let lease;
      try {
        lease = getDispatcher(proxyUrl, route.cacheIdentity);
        const dispatcher = await waitWithSignal(lease.dispatcher, options.signal);
        throwIfAborted(options.signal);
        throwIfTransportClosing();
        dispatched = true;
        attempt.dispatched = true;
        return await originalFetch(url, { ...options, dispatcher });
      } catch (proxyError) {
        throwIfAborted(options.signal);
        if (isAbortError(proxyError)) throw proxyError;
        if (isLocalTransportPoolRefusal(proxyError)) throw proxyError;
        if (dispatched && !replayableMethod) throw proxyError;
        if (route.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      } finally {
        lease?.release();
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    let bypassDispatched = false;
    try {
      throwIfTransportClosing();
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname, options.signal);
      if (realIP) {
        throwIfTransportClosing();
        bypassDispatched = true;
        attempt.dispatched = true;
        return await createBypassRequest(parsedUrl, realIP, options);
      }
    } catch (error) {
      throwIfAborted(options.signal);
      if (isLocalTransportPoolRefusal(error)) throw error;
      if (isAbortError(error) || (bypassDispatched && !replayableMethod)) throw error;
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    let dispatched = false;
    let lease;
    try {
      lease = getDispatcher(proxyUrl, route.cacheIdentity);
      const dispatcher = await waitWithSignal(lease.dispatcher, options.signal);
      throwIfAborted(options.signal);
      throwIfTransportClosing();
      dispatched = true;
      attempt.dispatched = true;
      return await originalFetch(url, { ...options, dispatcher });
    } catch (proxyError) {
      throwIfAborted(options.signal);
      if (isAbortError(proxyError)) throw proxyError;
      if (isLocalTransportPoolRefusal(proxyError)) throw proxyError;
      if (dispatched && !replayableMethod) throw proxyError;
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (route.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return fetchDirect(url, options, attempt);
    } finally {
      lease?.release();
    }
  }

  return fetchDirect(url, options, attempt);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

export function installGlobalProxyFetch() {
  if (globalThis.fetch !== patchedFetch) {
    globalThis.fetch = patchedFetch;
  }
}

export default patchedFetch;
