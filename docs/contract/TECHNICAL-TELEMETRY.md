# Bounded technical instrumentation

Technical instrumentation is disabled by default. An operator enables it with
`TOKENPROXY_TELEMETRY=otlp` and an explicit `TOKENPROXY_OTEL_ENDPOINT`, normally a
local collector such as `http://127.0.0.1:4318`. No collector or external service
is installed or enabled automatically. Restart applies this configuration.
`TOKENPROXY_OTEL_SAMPLE_RATIO` accepts 0 through 1 and defaults to 0.01. HTTP
request metrics are unsampled; these metrics are never the authoritative usage
or budget ledger. Removal of the setting reverses this optional instrumentation.

The maintained OpenTelemetry JavaScript trace and metric SDKs own aggregation,
sampling, batched export and shutdown. The OTLP HTTP exporters own bounded
transport. These are new technical export responsibilities, so no existing
accounting, context telemetry or custom provider transformation is removed.
This avoids adding a second application-owned queue or histogram implementation.
The focused SDK packages omit automatic HTTP instrumentation, resource detection,
logs, baggage propagation and the full Node SDK's unrelated exporter integrations.

The HTTP adapter records server response lifetime, first nonempty body write,
completed and abandoned responses, and active responses. It preserves Node write
return values, callbacks and backpressure and removes its listeners once. A body
write may be a keepalive and is not proof of first useful model output or delivery
to the client. Server finish is not provider terminal success. Event-loop p50,
p99 and maximum are measured over each collection interval; memory reports RSS,
used heap and external bytes. Histograms have explicit submillisecond through
long-stream buckets in seconds. Controlled-upstream benchmarks remain necessary
to separate gateway overhead from end-to-end latency.

Trace export has a 1,024-span queue, 128-span batches, 5-second batching interval
and a 1-second export timeout. Each exporter allows one in-flight request.
Metrics export every 10 seconds with a 1-second deadline. HTTP instruments have
a 1,024-series cardinality cap; route, method, status class and outcome come from
finite allowlists. Queue overflow may drop technical spans. Request accounting
and durable budget finalization remain independent of every export result.

Only the fixed service name and technical dimensions are exported. URLs, query
strings, credentials, account/session/request IDs, prompt/response content,
headers and exception messages are excluded. Collector URLs cannot embed
credentials, queries or fragments. Incoming trace context and baggage are not
adopted. The collector endpoint is an explicit operator destination, not a
request parameter. Current coverage requires the shipped custom HTTP server;
other HTTP entrypoints do not acquire this adapter automatically.

Version selection follows the official
[JavaScript status](https://opentelemetry.io/docs/languages/js/),
[2.11.0 release](https://github.com/open-telemetry/opentelemetry-js/releases/tag/v2.11.0)
and matching 0.222.0 OTLP exporters. Their runtime requirement fits TokenProxy's
Node 20.18.1 minimum. Behavioral, actual exporter and overhead receipts must be
recorded before this implementation is accepted or enabled.

The focused implementation run passed 18 tests across technical instrumentation
and the real custom-server peer-header boundary. It includes an actual HTTP
response, the actual OTLP trace and metric exporters against a loopback
collector, zero trace sampling with unsampled metrics, and 1,500 completed
responses under a blocked exporter. The queue bound drops excess technical
spans while the completed-response metric retains all 1,500. Instrument failures
preserve callbacks, write return values, response completion and accounting
independence. Changed-source ESLint passed.

The legacy CJS h2c test timed out on both unchanged36cdfb30 server source and
this telemetry candidate in isolated six-second runs. It is tracked separately
as a pre-existing server/test lifecycle defect and is not a passing gate. The
ordinary HTTP wrapper tests pass. Integrated compilation and HTTP overhead
measurements are still required; instrumentation remains disabled by default.
