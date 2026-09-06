# Retained quota observations and scheduler checks

The passive operator endpoint is `GET /api/admin/quota/history`. It never polls a provider, warms an account, imports current snapshots, or fabricates a historical series. Schema version 6 creates empty observation and check-event tables. Existing quota rows remain current evidence only.

## Query contract

- `kind=observations` is the default; `kind=checks` selects scheduler events.
- `start` is inclusive and `end` is exclusive. Both accept ISO timestamps with an explicit UTC offset and are normalized to UTC. `since` and `until` are aliases with the same half-open meaning. Supplying a canonical key and its alias together is rejected.
- The default range is the preceding 30 days, ending at request time. The response's `timeRange` contains the effective bounds, time field, `endExclusive: true`, and `defaultHorizonDays`. Explicit `start` makes `defaultHorizonDays` null.
- `timeField=capturedAt` is the default; `timeField=observedAt` excludes samples whose original observation time is unknown. Neither time is a reset forecast.
- `page` starts at 1 and `pageSize` defaults to 50, with a maximum of 200. `total` counts only records matching every filter and the effective time range. `pages` is the ceiling of `total/pageSize`, including zero pages for an empty result. Ordering is descending selected timestamp, then descending stable record ID. Concurrent new writes can shift offset-based pages between requests.
- Both kinds accept exact `connectionId`, `provider`, `scope`, and `source` filters. Observations additionally accept `unit`, `resourceType`, and `observationKind`; checks accept `eventType` and `checkId`. Raw SQL fragments are never accepted.
- An operator credential is mandatory, even when dashboard login is disabled or the request is local. An inference credential alone receives 403. Invalid queries receive 400; storage failures receive a fixed 500 response without database or provider error text. Responses are not cached.

The current `/api/admin/quota` response advertises `historyEndpoint` and `retainedHistory.observationCount/checkEventCount`. These counts explicitly cover all retained evidence. `historyAvailable` becomes true only after an observation has actually been stored. This flag does not assert coverage of any requested period, and `historyBackfilled` remains false.

## Observation evidence

The usage dispatcher attaches an acquisition receipt to each successful quota result. Existing provider caches reuse their result objects, so a weakly held receipt preserves the original local observation time across cache hits and stale-on-error returns. Fresh result objects receive new receipts even when every quota number remains unchanged.

Dashboard usage reads, routing refreshes, and scheduled checks retain the same projected sample under the same ID. Repeated routing selection does not append history. IDs include account, scope, source receipt and projected payload; a changed payload at an identical timestamp cannot overwrite a previous sample. `capturedAt` is excluded from the identity, so storage time never manufactures a new provider observation. A missing source observation time stays null.

Rows retain separately reported percentage snapshots. Absolute `remaining` and `limit` are stored only when an adapter supplies an explicit unit; several existing adapters synthesize a denominator of 100 for percentages. Unitless numeric scales are therefore not presented as absolute allowance. Values without sufficient evidence remain null, including durations and resource types. Wallet metadata explicitly marks a monetary budget; other resource classifications must be provided by the adapter. Reported reset timestamps are retained unchanged. Historical values are not advanced or replenished after a deadline.

Current-window persistence now recognizes a changed explicit `observedAt`, even when the balances are unchanged. The legacy current table still requires a timestamp and retains its existing fallback for callers omitting it. That fallback is never imported into this history. Raw response blobs, credentials and exception messages are outside the retained projection.

## Scheduler evidence

Each executed check has a fresh `checkId`. Checks skipped by existing cooldown/reset guards write nothing. The following events describe different facts.

- `scheduled` stores an existing scheduler guard's not-before time and any reported reset. The tick determines actual execution time. Identical schedule decisions are deduplicated.
- `started` records an executed check and echoes its known guard deadline. `usage-read` records the source observation time, which can predate the current check when a provider cache answered.
- `warm-response` records each physical sender response as `http_NNN` or `response-status-unknown`. It does not claim that a generation completed or the provider charged a request. Antigravity responses carry the corresponding model quota scope; other sender responses leave scope null.
- `warm-recorded` reports the existing scheduler's own bookkeeping decision. Some existing senders can record a warm after a non-success or partial response. This event is not upstream acceptance or proof of a running clock.
- `clock-running` and `still-cold` require a known usage observation newer than that scope's `lastWarmedAt`. A cached pre-warm result cannot substantiate either claim.
- `failed` and `completed` carry bounded reason codes. Storage failure never changes request retries or erases the scheduler's existing in-memory spending brake.

The `checkId` on a scheduled event identifies the check that planned it. The later execution has its own identity and echoes its deadline; this foundation does not add a persistent job queue or schedule foreign key. Global failures before account checks begin remain in existing scheduler logs. Sender selection, retry policy and warm decisions are unchanged.

## Retention and failure behavior

Source observations and events are retained indefinitely by default. There is no automatic deletion, synthetic backfill, forecast, or new deletion endpoint. Queries are page-bounded, with a default 30-day horizon. A future retention policy must be explicit and measured against actual volume.

A multi-window observation commits atomically. Duplicate insertion is idempotent. Retention failures emit fixed local warning codes and preserve the original usage response; they do not initiate another provider request. The record cannot survive a failed disk write, so those failures remain gaps, not reconstructed data.
