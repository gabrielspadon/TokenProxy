# Structural Context and explicit client events

Version 1 adds evidence only for newly observed requests. Historical client/task/project identities and structural measurements remain absent. A routing affinity identity, content-prefix discontinuity or changed fingerprint is never proof of a client, agent hierarchy, project, compaction or provider action.

## Request capture

`contextStructureEnabled` defaults to true. Setting it to false skips structural traversal, UTF-8 measurements and HMAC calculation while retaining authenticated key attribution and explicit client metadata. Existing byte-stage telemetry remains independent. Context turns expose `controls.contextStructure` for the recorded policy and `structures` for available measurements.

Three boundaries are `client-received` (parsed original client JSON), `gateway-shaped` (after routing translation and shaping), and `physical-dispatch` (the exact JSON prepared for a supported transport hook). These are serialized JSON sizes, not original HTTP bytes, tokenizer counts, decoded attachment sizes or provider cache sizes. Exact prepared strings are reused; identical adjacent strings reuse the numeric measurement. Only an in-flight closure retains those strings. No prompt, tool name, path, attachment data or raw client identifier is added to telemetry storage.

Each structure has `version`, `boundary`, `bodyBytes`, `messageBytes`, `messageContainerBytes`, `instructionBytes`, `toolSchemaBytes`, `envelopeBytes`, `historyPrefixBytes`, per-role `{count,bytes}`, overlapping `subsets.{toolCalls,toolResults,attachments}`, and keyed `fingerprints.{body,instructions,tools,historyPrefix}`. The role contract matches the engine's protocol role enums. The shared DTO normalizer runs before persistence and again in the read-only worker. It excludes unknown fields and rejects contradictory boundaries.

- `messageBytes + instructionBytes + toolSchemaBytes + envelopeBytes = bodyBytes`.
- Sum of role bytes plus `messageContainerBytes` equals `messageBytes`.
- Tool and attachment subsets overlap role bytes and may overlap each other. They must not be summed as a partition.
- `historyPrefix` fingerprints a structured instructions/tools/history object before the latest syntactic user message. It is not an exact provider wire prefix, cache eligibility or compaction detection.
- Fingerprints are installation-keyed HMAC-SHA256. The random installation key lives in protected SQLite metadata and survives restart. A different installation key intentionally produces different references.
- The capture guard is 8 MiB JSON, 100,000 visited protocol nodes and 64 levels. Unsupported binary transports or unavailable measurements produce absent boundaries, never zero-byte records. The API cannot distinguish every missing-boundary cause retrospectively.

A physical retry gets a fresh request UUID and inherits only the client/gateway snapshots. Its old physical snapshot is never copied into the new attempt. The existing optional telemetry savepoint isolates malformed structures from authoritative request usage. Context rows and events follow the configured 1–365 day retention policy; the default is 45 days. Event expiry uses the indexed client-reported observation time.

## Explicit identity

Authenticated clients may supply opaque identifiers through `x-tokenproxy-client-id`, `x-tokenproxy-session-id`, `x-tokenproxy-task-id` and `x-tokenproxy-project-id`. A client id is required whenever any of these fields is supplied. Identifiers are 1–128 ASCII letters/digits/underscore/dot/colon/hyphen, beginning with a letter or digit. Paths and prose are rejected. The session header also participates in the existing routing session resolver.

Storage keeps the opaque database `clientKeyId`, installation/key/client-scoped HMAC references (`clientRef`, `clientSessionRef`, `taskRef`, `projectRef`), and `clientIdentitySource`. Source is `client-reported`, `rejected-client-report`, `unverified-client-report`, or null. No identifier is inferred from prompt text. These project references are not the application's project registry ids; existing `usageHistory.projectId` remains unchanged.

Gateway-built chat responses expose `x-tokenproxy-request-id` and `x-tokenproxy-logical-request-id` when an exact UUID exists, including failure responses after attempt creation. The request id identifies the final physical attempt. Headers freeze when the response is constructed and do not imply hidden retries after output is exposed. CORS exposes these headers. Pre-attempt validation/bypass responses do not fabricate identities.

## Event ingestion

`POST /api/v1/context/events` (also reachable through the existing `/v1` rewrite) requires a recognized, active, nonexpired client API key, even from loopback. Inference budget exhaustion does not block unpaid event reporting. Operator cookies alone do not authorize ingestion. The body is limited to 16 KiB as actually read, independent of a declared content length. No provider call is made.

Required fields are `eventId` (UUID), `occurredAt` (valid timezone-qualified timestamp), `type` and `clientId`. Accepted types are `compaction`, `handoff`, `task_start`, and `task_outcome`. Optional fields are `clientSessionId`, `taskId`, `projectId`, `targetClientId`, `targetTaskId`, `outcome`, `beforeTokens`, `afterTokens`, `tokenMeasurementMethod`, `requestId`, `logicalRequestId`, and numeric `sessionId`. Unknown fields are rejected.

Handoff requires `targetClientId`; target fields are forbidden on other events. Task events require `taskId`; task outcome requires `success`, `failure`, `cancelled`, or `unknown`. Compaction token counts are nonnegative safe integers, optional and client-reported. Supplied counts require `client-tokenizer`, `client-estimate`, or `unknown` as their measurement method. Counts may increase. No duration, cash saving, actual tokenizer result or provider action is inferred.

The reported time must fall inside the retention interval and no more than five minutes into the future. `recordedAt` is the independent gateway receipt timestamp. Every event has `source: client-reported`, `providerVerified: false`, and explicit client-reported token units.

An exact `requestId` link must belong to the authenticated key and agree with any existing explicit identity. Supplied logical and session links must agree with that same request; they cannot be attached independently. Missing and foreign links receive the same generic 404. Without a request link, the event remains unlinked with unknown routing. Client-reported task/project refs never backfill request identities.

A first event returns 201 and `{event,duplicate:false}`. Repeating the same normalized evidence with the same key and event UUID returns 200 with the original record. Conflicting reuse returns 409. Invalid fields return 400, missing/expired/disabled keys 401, oversized bodies 413, unavailable storage 503. Atomic uniqueness covers concurrent duplicates.

## Read contract

`GET /api/context/events` requires the existing administrator authorization and runs a static projection in the shared bounded read-only analytics worker. It returns `view: client-events`, `events`, full-population `pagination`, definitions and snapshot freshness. Filters are `from` inclusive, `until` exclusive (legacy `to` inclusive remains supported), provider/model/connectionId/clientTool/projectLabel, type, sessionId, requestId, logicalRequestId, clientKeyId/clientRef/clientSessionRef/taskRef/projectRef, page and pageSize. `to` and `until` cannot be combined. Provider/model/account filters apply only to observed owned request links. Unlinked events have null routing dimensions.

Existing Context overview/session filters additionally accept opaque client/key/session/task/project refs and exact logical/request ids before pagination. Session turns return `explicitIdentity` and ordered available `structures`; stage order and provider/estimated/missing usage provenance remain unchanged. The worker imports only pure query/DTO modules from the analytics directory, which the standalone packager already copies in full. It does not import the writer or run migrations.

## Validation and performance boundary

The focused gate exercises real mocked dispatch, SQLite persistence, the read-only worker and authenticated routes. It covers physical retries, failure UUIDs, duplicate/conflicting events, key ownership, expired and budget-exhausted keys, filters/pagination, reader restarts, corrupt evidence, retention, no-content persistence, prepared-string reuse and preservation of authoritative partial usage.

`tests/qa/context-capture-benchmark.test.js` measures actual core handling with only upstream fetch mocked, alternating enabled/disabled modes after four warmup pairs. Each size has 24 measured pairs. It includes clone, translation, structural measurement, persistence and response construction. The receipt records source hashes, runtime, configuration and quantile method. Initial Mac Node 26 measurements added approximately 8.7 ms at 1 MiB and 18.4 ms at 2 MiB median. This is material local overhead and does not meet an unmeasured production latency target. Profiling and reducing it is a separate follow-up; no throughput, provider latency, duration saving or monetary saving is claimed.

The first local optimization serializes each role/message/tool fragment once per measurement and composes the identical version-1 history JSON from those fragments. A frozen SHA-256 digest over 260 deterministic Unicode/protocol fixtures verifies equality of every metric and all HMAC outputs against `31dbab83`. Instrumented 2 MiB kernel work attributed 54% to JSON serialization before this change. Hyperfine (three warmups, eight runs, 200 equivalent observations per run) measured 1.65±0.03 times the observation throughput after exact-fragment reuse. Residual HMAC work remains material; this is a local measurement improvement, not a production gateway target claim.

A subsequent request-local HMAC memo experiment was rejected. Exact domain/key/fragment equality preserved the evidence and improved the actual benchmark command by 1.06±0.02 times (three warmups, eight runs). However, sixteen simultaneously prepared 2 MiB fixtures retained 56.4 MB additional heap after forced garbage collection, about 3.5 MB per request. Clearing released it, but initial capture can span asynchronous preparation and therefore still increases peak live memory. The committed implementation retains per-call fragment reuse and exact whole-body reuse already present within capture; it does not retain the experimental cross-boundary fingerprint memo. Residual large-body preparation overhead remains an open performance gate.

## Context workspace and evidence exports

The request inspector shows the three available structure boundaries, body and role partitions, overlapping tool/attachment subsets, installation-keyed fingerprints, and exact linked ledger amounts. A baseline attempt is explicitly chosen and retained as a read snapshot across page and scope changes. Differences retain their token or UTF-8-byte units; no cash saving or compaction is inferred.

Client reports can be browsed independently of session attribution. Shared time bounds apply to client-reported event time in that view; routing filters require an exact request link. The attempt inspector instead shows all retained reports owned by that exact request/session, regardless of report timestamp, with server pagination. Unlinked reports remain visible only in the broader report view, with unknown routing.

Context investigation exports include all matching attempts, normalized structures, ordered stages, exact request-linked ledger amounts, and owned client events in the same worker read transaction. Selected exports require both request and session identifiers and explicitly ignore shared filters. Population and selected-account comparison exports apply fixed request-time bounds plus lens filters. Related event times can differ from request times and are labeled separately. There is no timestamp join or historical reconstruction. The export refuses more than 5,000 attempts, more than 5,000 related events, or an artifact above 8 MiB, without returning a partial file. Invalid structures are withheld and counted in coverage. Unlinked events are excluded from attempt exports.
