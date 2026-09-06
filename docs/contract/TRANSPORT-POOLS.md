# Transport pool lifecycle

`proxyFetch.js` continues using native fetch with the installed Undici
`Agent`, `ProxyAgent` and `Pool` primitives. It does not introduce another
HTTP client, retry scheduler, response-body adapter or connection protocol.
`dispatcherCache.js` owns the small asynchronous resource cache around proxy
dispatcher construction.

## Identity and admission

The effective route is resolved before the cache is consulted. Intentional
direct routing, loopback bypass, NO_PROXY and required-proxy failures preserve
their existing precedence. Relay traffic remains a direct request to the relay.

One private proxy cache key contains the existing SHA-256 identity of the
canonical proxy URL plus the effective connect and response-header timeouts.
Canonical URL spelling coalesces, including default ports and host casing.
Proxy userinfo remains part of that identity; different credentials never
share a dispatcher. Path and query differences are conservatively retained.
Keys and credential-bearing URLs are not emitted by the cache.

The dispatcher owns per-origin pools through Undici's existing Agent factory.
Origin authority, SNI, certificate validation, proxy TLS, SOCKS handling,
HTTP/1.1 ALPN for SOCKS, connection settings and request headers remain with
the existing transport implementation. A configured timeout change creates a
different dispatcher rather than silently reusing stale construction options.

The proxy cache has `MEMORY_CONFIG.proxyDispatchersMaxSize` slots, currently
20. An asynchronous construction occupies its slot immediately, so a cold
burst for one key awaits one promise. Distinct concurrent constructions count
against the same limit. A failed construction releases its slot for a later
attempt.

This is a bound on proxy dispatcher identities, not a global socket or
origin limit. Existing proxy configuration permits 64 connections per origin.
The direct Agent still coalesces its own construction and owns its origin
pools. Current Undici removes unused disconnected origin pools; this change
does not impose a new direct-origin admission policy.

## Bodies, backpressure and eviction

An acquisition reservation covers construction through receipt of response
headers. After that reservation is released, actual Undici `Pool.stats.size`
covers queued and running transport requests, including unfinished bodies.
Idle candidates have no acquisition reservations and no queued/running pool
work. Fully buffered bodies may remain unread by their callers after transport
completion; closing an idle connection does not consume or modify those bytes.

On a cache miss at capacity, only an idle least-recently-used entry is evicted.
Its graceful `close()` must finish before replacement construction begins.
The closing slot remains reserved, preventing an unbounded tail of detached
closing dispatchers. If close fails, destruction is attempted only after the
resource still reports idle. If both cleanup operations fail, the resource
remains owned in a quarantined slot and replacement is refused. Explicit
shutdown retries cleanup; the resource is never silently forgotten.

If every slot is constructing, reserved or active, the new transport identity
is refused before fetch dispatch. Existing identities remain usable. This
condition never triggers direct fallback or destroys an active stream.

Responses stay native. There is no body clone, tee, eager drain or reader
wrapper. Callers continue to own consuming or canceling response bodies,
including unsuccessful responses. A canceled acquisition does not dispatch a
request or cancel another caller sharing the construction. The unused resulting
dispatcher remains an ordinary idle cache entry.

`closeTransportDispatchers()` is an explicit graceful shutdown seam. It stops
new admission, waits for pending construction and closes managed dispatchers.
Pending construction cannot dispatch after shutdown starts. The function does
not register process handlers, restart services or close caller-owned direct
dispatchers supplied in fetch options. Active response bodies can keep graceful
shutdown pending until they finish or their callers cancel them.

## Local error contract

These errors carry `statusCode: 503` at the transport boundary and contain no
proxy URL, credentials, request body or upstream text:

- `transport_pool_capacity` means every cache slot is active or reserved.
- `transport_pools_closed` means explicit shutdown has begun.
- `transport_pool_cleanup` means an idle slot could not be reclaimed safely.

They never authorize internal direct fallback. They originate before this
transport dispatches the refused request. The exported
`isLocalTransportPoolRefusal(error)` checks an owned WeakSet brand, not a
message, code string, arbitrary `statusCode` or copied prototype. If an earlier
transport invocation occurred during the same legacy GET fallback call, that
brand is revoked before the error escapes. Only a branded error proves the
whole call did not attempt upstream dispatch and can release reserved exposure.
HTTP handlers must explicitly map
these known codes if preserving 503; the generic historical transport catch
maps unknown errors to 502. A broad trust of arbitrary upstream `statusCode`
properties is not part of this contract.

## Runtime and primary sources

The project minimum is Node 20.18.1, as documented in
[RUNTIME-SUPPORT.md](RUNTIME-SUPPORT.md). The existing dependency declaration is
Undici `^7.19.2`; evaluation uses installed version 7.29.1. No dependency or
runtime is replaced by this change. Versioned documentation checked 2026-09-06:

- [Agent origin factory and lifecycle](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/Agent.md)
- [ProxyAgent configuration](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/ProxyAgent.md)
- [Graceful close and destructive shutdown](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/Dispatcher.md)
- [Pool counters](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/PoolStats.md)
- [Versioned package runtime declaration](https://github.com/nodejs/undici/blob/v7.29.1/package.json)

## Reproduction

Use explicit scratch DATA_DIR and `tests/vitest.config.js`. Focused coverage
includes `proxy-fetch-dispatcher-eviction`, `dispatcher-cache-lifecycle` and
`proxy-fetch-loopback-pools`, plus existing proxy route, MITM, DNS, abort and
installation suites. Loopback tests route only synthetic CONNECT authorities
to a local fixture, never to real providers. They cover active cache pressure,
cancellation, origin/authentication isolation and slow-reader backpressure.

`tests/qa/transport-pools-benchmark.mjs` compares actual loopback fetch requests
against source at `15ca368c`. It records unique dispatchers actually passed to
fetch, tunnel connections, verified request rate, latency and sampled RSS.
Each arm performs the same source-loading work. Cold bursts, warm reuse and
mixed long-stream/slow-reader workloads are distinct scenarios. Cancellation
timing includes receipt of the server-side close signal. Five-millisecond RSS
samples can miss shorter peaks. Local measurements do not establish production
provider latency, whole-gateway targets or a global socket bound.
