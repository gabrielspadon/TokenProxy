# Performance delivery contract

Additive operator requirements received 2026-09-06. This extends PLATFORM-DELIVERY.md and WORKSPACE-CONTRACT.md. Each item remains an implementation and measurement obligation, not a completion claim. Mocked controlled upstreams are required for validation; no paid inference.

## Acceptance targets

The existing SPEC.md section 8.2 targets remain mandatory controlled-upstream measurements.

| Quantity | Target |
|---|---|
| Gateway-added no-translation latency p50 | At most 1 ms |
| Gateway-added no-translation latency p95 | At most 5 ms |
| Gateway-added direct-translation latency p95 | At most 10 ms |
| Client abort to upstream abort p95 | At most 100 ms |
| Event-loop lag p99 at stated concurrency | At most 50 ms |
| Replay after exposed output, duplicate durable accounting, secret leakage | Zero |

Optimize successful, protocol-correct work per CPU, memory, network traffic and upstream expenditure. Measure admission, first useful output, progressive uninterrupted delivery, inter-event jitter, cancellation, account continuity, accounting and responsive controls. Keep router-added and end-to-end timing separate.

## Dependency order and required evidence

1. Establish exact physical dispatch identity and durable finalization. Complete the inventoried specialized executors without labeling ancillary token/bootstrap/media retrieval as model dispatch. Preserve uncertain outcomes and existing non-replay rules.
2. Add atomic outstanding token/cost reservations where enforceable bounds exist. Reconcile once against authoritative records. Retain possibly accepted exposure after cancellation/crash. Document unknown-bound and overshoot policies. Keep unlimited keys inexpensive, resource units separate and recorded estimates distinct from confirmed charges.
3. Establish reproducible controlled-upstream baseline before changing hot paths. Matrix includes small/large bodies, pass-through, translation, tool transactions, multimodal, long streams, slow readers, each cancellation phase, retries, depletion, DB contention and concurrent dashboards. Record source/runtime/driver/hardware, warm-up/sample count, latency quantiles, jitter, throughput/errors, CPU, memory per stream and abort latency.
4. Evaluate maintained primitives before owning more infrastructure. Investigate eventsource-parser for framing only; retain provider transformations, terminal rules, byte limits and malformed-stream behavior. Evaluate Undici pool/transport capabilities and individual SDK adapters against native fields, signatures, tool ordering, cache quantities, proxy and cancellation fixtures. Each adoption lists removed code, preserved compatibility, runtime support, operational cost and measured benefit or maintenance reduction.
5. Reduce request work first. Reuse unchanged transformation measurements and existing serialization only where equivalence is proven. Retain every signed byte-stage ledger row and mutation order. Cache deterministic preparation only with bounded memory, correct credential/privacy scope and content/model/protocol/configuration/tokenizer/transformation version keys. Avoid repeated parses/clones/tokenization/config lookup and identical-attempt preparation.
6. Execute independent dependencies concurrently under explicit bounds. Media URL deduplication is request-scoped, fetches retain protections/aggregate byte caps, results apply in original order. Coalesce refresh/metadata/pool construction by correct identity, including concurrent construction. Bound background batches. Hold handler/stream/global/client/provider/account permits for the actual protected lifetime and preserve fairness.
7. Make admission adaptive only within operator limits. Use queue age, active streams, loop delay, memory, pool occupancy, throttling and fresh quota evidence. Require workload-class separation, smoothing/minimum samples/hysteresis/cooldowns, prompt reduction, gradual recovery, conservative unknown fallback, stability experiments and operator override. Preserve pins/eligibility/reasoning/continuity. Persist effective-limit change reasons.
8. Maintain backpressure through the whole stream. Bound per-connection and process memory, forward progressively, retain bounded previews/incremental counters. Optional full retention uses bounded asynchronous writes with explicit overflow/persistence outcomes. Redact before bounded asynchronous logging, avoid synchronous per-chunk debug I/O. Propagate cancellation/deadlines through queues/media/compression/retry waits/upstreams/readers/auxiliary tasks; finalize once. Distinguish keepalive, real progress and terminal events.
9. Reuse bounded pools by effective origin/proxy/transport configuration. Consume or cancel unused bodies, bound diagnostics, benchmark connection counts/H2 streams with slow long streams. Cursor duplex/Connect/protobuf/proxy/trailers/cancellation needs explicit parity before transport replacement. Avoid unmeasured HTTP/1 pipelining and ambiguous replay.
10. Use verified model-specific tokenization or justified provider counting without adding a remote round trip to every request. Evaluate optimization net cost with retries/auxiliary work and meaningful client task outcomes. Bytes alone prove neither saved tokens nor better outcomes.
11. Retain local-first JavaScript/SQLite while measured capacity suffices. Short transactions/prepared statements/indexes/bounded queries and transactionally maintained source-reconcilable aggregates precede new workers/databases. Qualify native and sql.js drivers separately for capacity/durability. Measure transaction latency, busy waits, WAL growth/checkpoint progress and long readers.
12. Define multi-process ownership before horizontal expansion. Shared account/admission/refresh/background invariants need atomic reservations, expiring leases with stale-owner fencing, configuration versions and deduplicated finalization. Coordinate OAuth refresh/account transitions, preserve affinity, drain active streams on deployment, keep WAL on supported same-host storage. Distributed infrastructure requires measured limitation/migration/crash recovery/rollback proof.
13. Extend existing bounded analytics worker and identical-query coalescing. Share authorized projections by scope/filter/time/data version; use bounded events, incremental invalidation, pagination/downsampling with freshness/resolution. Prioritize cancellation/control/routing explanation over history/exports. Transparently lower analytics refresh under overload, preserve selection/navigation, distinguish queued/streaming/cancelling/depleted/degraded/unavailable and acknowledged/completed actions.
14. Add maintained OpenTelemetry technical traces/metrics with bounded queues/cardinality and redaction. Authoritative accounting remains independent of sampling. Compare runtimes/native modules/algorithms in isolation; promote gradually with measured rollback criteria and complete compatibility/accounting/usability/operational gates.

## Primary references and release observations

Read on 2026-09-06. Registry metadata is a selection input, not an adoption decision.

- [eventsource-parser](https://github.com/rexxars/eventsource-parser), registry 4.1.0, Node >=22.12. Explicit maxBufferSize limits parser characters; the gateway must still enforce its byte and aggregate limits.
- [Undici Client v7.29.1](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/Client.md). Registry latest 8.10.2 requires Node >=22.19.0; the repository declares ^7.19.2. A major upgrade requires independent parity proof.
- [Node worker threads](https://nodejs.org/api/worker_threads.html) and [stream primitives](https://nodejs.org/api/stream.html). Existing async network I/O does not justify CPU workers; stream high-water marks are flow-control thresholds, not universal hard memory caps.
- [Envoy adaptive concurrency](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/adaptive_concurrency_filter), a reference to adapt and stability-test for long streaming workloads.
- [SQLite WAL](https://sqlite.org/wal.html), single-writer and same-host deployment constraints remain part of the design.
- [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/), SDK node registry 0.222.0 supports ^18.19.0 or >=20.6.0. Select signal/runtime support deliberately.

## Current status

Exact attribution, retained quota history, configuration versions and explicit client evidence are being implemented in isolated parallel leaves. The existing bounded analytics worker has prior responsiveness receipts. Expanded performance targets and the full workload matrix have not yet been measured on the final integrated build. No infrastructure adoption or throughput improvement is certified by this document.
