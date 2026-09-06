# Context telemetry API

Context recording is always active for gateway attempts that reach the prepared dispatch body. A server-generated UUID identifies the attempt and is reused by the existing requestStats lifecycle. Old rows have null contextSessionId and remain visible through existing statistics APIs. No retrospective session join is guessed from an account.

GET /api/context and GET /api/context/sessions/[id] require the same operator credentials as admin routes. Responses are no-store. PATCH /api/context/sessions/[id] additionally requires a verified loopback peer and accepts only {projectLabel:string|null}. Labels are operator-assigned, at most 80 printable characters. No automatic inference from paths or system prompts occurs.

Query parameters are from/to ISO timestamps, provider, model, connectionId, clientTool, projectLabel, page (1-10000) and pageSize (1-100). Invalid types/ranges return 400, missing sessions return 404, storage failure returns 500 without raw error details. Pagination metadata includes totalItems, totalPages, hasNext and hasPrev. Session turns are ordered oldest first by timestamp and attempt UUID; overview sessions are newest first.

The overview returns summary, sessions, projects, stages, dimensions, pagination, retentionDays, recordingStartedAt, recording, units, filters and definitions. recording contains rejectedAttempts, lastRejectedAt and scope="all retained attempts". Invalid optional context metadata is rejected independently of the authoritative usage row, so billed usage survives and the coverage gap remains visible. A session returns session, summary, turns, pagination, stages, dimensions, pins, switches and routingScope. Pins and the newest 100 retained switch receipts use the full internal routing hash, independently of the turn time filter. Identity hashes are omitted from every public response. identitySource=explicit means the engine parsed stable client session evidence; inferred means content-derived locality and does not guarantee a distinct agent. Legacy hash-only callers use routing. A request without a routing hash receives an independent ephemeral identity with identitySource=request, so it cannot silently merge into a shared account's conversation.

All request totals and token aggregates use the same filtered requestStats rows. requests counts distinct server-owned logical request IDs, attempts counts dispatch attempts, and succeeded, failed and pending describe persisted outcomes. A pending row can be an active request or a process interruption; it never counts as success. Historical rows retained through a downgrade remain intact but do not acquire session metadata.

providerInputTokens is cache-inclusive. providerInputTokens, providerOutputTokens, cacheReadTokens and cacheWriteTokens are nullable sums over fields actually observed. Separate providerUsageSamples, estimatedUsageSamples and missingUsageSamples expose coverage. Estimated input/output remain separate from provider counts. cacheHitRate is observed cache read divided by cache-inclusive input for attempts reporting both fields; its value is null without a measured denominator. No cost or token savings is inferred from byte savings.

Each turn includes contextEstimate and inputEstimate (tokens), bodyBeforeBytes, bodyAfterBytes, signed savedBytes, cachePrefixBytes, compactHint, messageCount, toolCount, routeKind, formatPair, selection, attempt, provider/model/connectionId/requestedModel/clientTool, latencyMs, ttftMs, controls and stages. Controls contain only allowlisted booleans from the actual request pipeline. Ordered stages contain ordinal, stage, beforeBytes, afterBytes, deltaBytes, outcome and risk. Stage delta is after minus before, whereas savedBytes is before minus after. Expansion therefore has negative savedBytes. Stage boundaries reconcile exactly, including tool normalization, skipped stages and final cache-anchor changes. Stage totals telescope to the measured dispatch-body change.

Input estimates are not provider observations. Cache prefix bytes describe structural continuity within one full session/provider/model/account scope, not a billed cache hit. compactHint records a prefix discontinuity, not proof of client compaction. The risk label content-changing means the transform may alter information; it does not assert a measured quality outcome. Stage run/skip status records pipeline invocation and byte effect, not inferred model quality.

Default retention is 45 days, shared with requestStats and bounded to 1-365 days. Indexed timestamp cleanup also removes stage and session orphans. Session queries use the contextSessionId/timestamp/id index; request, client and project dimensions have indexes. Reads cap pages and dimensional/switch lists at 100 rows. Stage rows are capped at 32 per request. No raw prompts, raw sessions, headers, secrets, working directories, system fingerprints or arbitrary event payloads are stored.

The additive schema preserves every existing column and index. Downgrading the application can read and append legacy requestStats rows without restoring an old database over new traffic. Context metadata written by the newer application remains retained in the extra columns and tables.

GET /api/tools is an operator-authenticated, no-store snapshot of the existing local MCP bridge registry and process map. It returns observedAt, scope="local-process", presets, summary and capabilities. Each preset exposes id, name, transport, configured, installation="not-probed", running, clients, endpoint and declaredToolCount. configured refers to a built-in preset, not installed package availability. summary contains presets, running and clients counts; capabilities advertises status=true, takeover=false and modelMapping=false. Reading this endpoint does not spawn processes, inspect secrets, probe installations or write host configuration.


Accepted upstream attempts are never automatically regenerated after uncertain
transport or integrity failures. Kiro validates an accepted response once;
`providerSpecificData.kiroToolCallRepair` no longer enables another generation.
The legacy `KIRO_TOOL_CALL_REPAIR_*` buffer and watchdog environment names remain
supported for compatibility, but control validation limits rather than retries.
Codex only classifies typed error events before content is exposed. An ordinary
answer containing error-like words remains ordinary output. A malformed or
incomplete accepted response can fail visibly without authorizing replay.
Retries after an explicit upstream rejection remain separately guarded; a second
attempt with an unknown outcome cannot reuse the first rejection as permission
for another attempt. Telemetry may record a failed accepted attempt, and that
failure does not prove the provider performed or billed no work.
