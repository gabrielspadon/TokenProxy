# Controlled gateway performance

The benchmark lives in `tests/qa/gateway-performance/run.mjs`. It makes real HTTP requests to the application and a separately running deterministic loopback provider. It does not use real provider credentials, live data, or paid inference. All fixtures and credentials are newly generated inside a private DATA_DIR. Runtime guards deny non-allowlisted socket destinations, DNS resolution and subprocesses. The build permits its own worker subprocesses with the same isolated environment and inherited network guard.

## Reproduction

The harness requires Node 24 or newer for synchronous import hooks and the native SQLite audit reader. This is a benchmark requirement, not a change to the application's runtime floor. Install root and test dependencies using the normal repository recipes.

```sh
node tests/qa/gateway-performance/run.mjs --mode=routes --samples=200 --warmup=10 --concurrency=1 --scenarios=small,large,translation --output=/absolute/private/routes.json
node tests/qa/gateway-performance/run.mjs --mode=standalone --build=true --samples=200 --warmup=10 --concurrency=1 --scenarios=small,large,translation --output=/absolute/private/standalone.json
node tests/qa/gateway-performance/run.mjs --mode=standalone --samples=100 --warmup=5 --concurrency=8 --output=/absolute/private/standalone-concurrent.json
```

Each run creates a new native SQLite database, two OpenAI-compatible accounts, two Anthropic-compatible accounts, a valid unlimited inference key and a signed dashboard session. Structural telemetry remains enabled. Optional context compression services are disabled explicitly. The seed refuses an existing populated account database or a sql.js fallback. The provider protocol reports fixed synthetic token counts; these are workload fixtures, never empirical tokenization or billing evidence.

The `routes` arm mounts the actual POST route, account selection, admission, core, executor, translation and persistence modules behind a minimal Node HTTP adapter. Its import hook supplies the same aliases and one CommonJS named-export interop that the application's bundler supplies. It excludes Next middleware and the custom-server adapter. The `standalone` arm runs the actual production `custom-server.js` and built Next application, including `/v1` rewrites, middleware, peer headers, route and stream adapters. Its served build SHA is read from authenticated `/api/version`; it must be checked independently of the harness's source SHA. Warm-up excludes compilation and first imports. No development server timing is used.

## Measurements

The client and provider use the same host's monotonic `process.hrtime.bigint()` clock. Every controlled content event contains a unique request identifier, contiguous event index and provider send timestamp. Keepalives, role-only and terminal events do not count as useful output. The provider also records HTTP request receipt, request body completion, actual writes, blocked writes, drain time, close and cancellation. Output identity, event ordering, terminal delivery, model identity and representative tool/image/context anchors are checked. Invalid or empty output cannot qualify as successful fast work.

Each latency sample pairs one direct provider request with one application request, alternating order. Gateway-added first-useful latency is the paired difference of time outside the provider. For each arm, that outside time is `(providerReceived - clientStarted) + (clientFirstUseful - providerFirstWrite)`. Provider residence time is removed individually. Negative paired values are retained as measurement noise, not clamped away. This is an estimate that includes the additional application hop. It does not isolate a particular database query, auth check or queue wait.

End-to-end time and first-useful time are reported separately from added time. Delivery jitter is the client inter-event interval minus the provider inter-event interval. Cancellation latency is provider close minus intentional client abort, only where an actual aborted provider stream is observed. Missing observations remain missing. Before-useful cancellation and cancellation after three content events are separate scenarios.

Throughput, CPU, memory and event-loop lag are measured in a separate gateway-only batch, avoiding the misleading half-rate of a paired direct/gateway loop. Completed and intentionally cancelled requests have separate rates. The gateway child reports CPU user/system milliseconds, RSS baseline/peak/growth, heap/external/array-buffer bytes, and event-loop lag quantiles. RSS growth divided by configured concurrency is an allocation indicator, not per-request attribution or a leak proof. Sampling intervals are 10 ms for RSS and 1 ms for event-loop lag, with their overhead included equally. Provider/client CPU is outside the gateway process measurements.

The receipt contains source and served build revisions, dirty-source state, runtime versions, SQLite driver/version/journal, hardware, load average, warm-up/sample count, raw observations, quantiles, protocol/error counts, controlled upstream dispatch counts, read-only integrity/accounting checks and WAL size. Quantiles use the nearest-rank estimator. A small-sample p99 is often just the observed maximum and cannot establish a stable tail bound. Run command-level before/after comparisons with the same workload and environment; use the bench skill's warm-up and independent build rules. Do not claim a speedup from these baseline measurements alone.

## Coverage and limits

The initial matrix includes short and approximately 250 kB context, same-format OpenAI streaming, OpenAI-to-Anthropic direct translation, a protected tool transaction with an error result, an inline image on a known vision-capable model, delayed streaming, a multi-megabyte slow-reader stream, caller cancellation, and concurrent authenticated Context analytics reads. The source and standalone arms both use the actual native database writer. Duplicate durable usage request IDs and duplicate controlled upstream requests are reported independently.

These runs do not yet qualify request-upload cancellation, cancellation while queued behind admission, retries and quota depletion under controlled timing, capped-key rejection/reservation overhead, expensive populated-history analytics, long-lived DB readers, transaction busy waits/checkpoint progress, proxy/TLS/HTTP2 transports, binary executors, or multi-process coordination. Existing unit tests for those contracts are not a substitute for future performance measurements. The synthetic provider proves protocol and gateway behavior for these fixtures; it cannot establish external provider performance, semantic answer quality or real charges.

Acceptance thresholds remain those in `docs/design/PERFORMANCE-DELIVERY.md`. Latency target failures must be reported without relaxing the threshold. Response/protocol/duplicate-accounting failures make the harness exit nonzero after saving the receipt. Timing thresholds are recorded for review rather than converted into an unqualified pass over incomplete coverage.

## Primary API references

The harness follows [Node performance measurement APIs](https://nodejs.org/api/perf_hooks.html), [Node HTTP streaming and write backpressure](https://nodejs.org/api/http.html), and [Node stream lifecycle](https://nodejs.org/api/stream.html). The maintained [eventsource-parser](https://github.com/rexxars/eventsource-parser) frames the controlled client stream. Application transport behavior remains on the existing [Undici](https://undici.nodejs.org/) path. No transport library replacement is part of this benchmark.
