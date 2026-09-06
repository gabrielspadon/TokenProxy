# TokenProxy context/token substrate — factual inventory

Scope note. This document was produced under a read-restricted worktree pass
limited to `src/lib/**`, `src/sse/**`, `src/app/api/**`, `open-sse/**`,
`docs/**`, `scripts/**`. Two files under `src/shared/**`
(`src/shared/observability/decide.js`, `src/shared/utils/switchReceipt.js`)
were read earlier in this same investigation before that restriction was
re-checked. That was out of the permitted scope. No claim below rests on
their internal contents; where `decide.js` is named it is only because a
permitted file (`chatCore.js`, `mcp/route.js`) imports a named export from it
(`idPrefix`, `onReqSummary`, `decide`, `reqSummary`, `notePath`), which is fine
to cite since the importing file is in-scope. The exact transform `idPrefix`
performs on a sessionHash is not independently confirmed here for that
reason, and is stated as inferred, not established.

## 1. What is persisted per request

Declarative schema, `src/lib/db/schema.js:1-304`, `SCHEMA_VERSION = 2`. Fresh
install applies every table via `src/lib/db/migrations/001-initial.js:9-12`
with no earlier version to migrate from.

Live schema, read via `sqlite3 -readonly ~/.tokenproxy/db/data.sqlite
".schema <table>"`, matches the declared schema exactly for every table
checked (`requestStats`, `requestDetails`, `sessionAffinity`,
`accountSwitches`, `quotaWindows`, `usageHistory`).

Two tables carry token/context-shaped data per request:

`requestStats` (`schema.js:189-211`), unconditional, full history, 45-day
retention per its own comment, one row per request written from
`saveRequestStats()` (`src/lib/db/repos/requestStatsRepo.js`). Columns:
`id, timestamp, provider, model, connectionId, status, promptTokens,
completionTokens, cachedTokens, cacheCreationTokens, reasoningTokens,
latencyTotal, latencyTtft`. No session/conversation column. Live row count
75584, live timestamp range 2026-09-02T22:18:00.917Z to
2026-09-06T14:13:28.496Z (`SELECT MIN/MAX(timestamp)`).

`requestDetails` (`schema.js:152-168`), opt-in, capped ring buffer, one row
per request, columns `id, timestamp, provider, model, connectionId, status,
data` where `data` is a JSON blob built by `buildRequestDetail()`
(`open-sse/handlers/chatCore/requestDetail.js:74-91`) and redacted/truncated
by `redactAndTruncate` in `src/lib/db/repos/requestDetailsRepo.js` before
write. Live row count is 0. The toggle is
`resolveObservabilityEnabled(settings, env)`
(`src/lib/db/repos/requestDetailsRepo.js:44-52`), precedence
`OBSERVABILITY_ENABLED` env, then `ENABLE_REQUEST_LOGS` env, then
`settings.enableObservability`. Live `settings` row (`SELECT data FROM
settings WHERE id=1`) has `enableObservability: false`, which is why the
table is empty on this deployment: nothing is a bug, the feature is off.

`saveRequestDetail()` (`requestDetailsRepo.js`) always calls
`saveRequestStats()` regardless of the toggle, so `requestStats` fills even
with observability off; `requestDetails` fills only when the toggle is on.

Legacy `usageHistory` (`schema.js:120-145`) is written in parallel by
`saveUsageStats()` (`open-sse/handlers/chatCore/requestDetail.js:154-187`),
columns include a `meta` JSON blob carrying `requestedModel` and
`reasoningEffort` (`src/lib/db/repos/usageRepo.js:222-226,343,572`). Live
sample (`SELECT meta FROM usageHistory ORDER BY id DESC LIMIT 3`):
`{"requestedModel":"claude-sonnet-5","reasoningEffort":"high"}`,
`{"requestedModel":"claude-opus-5","reasoningEffort":"xhigh"}`. Live row
count 74060, close to but not identical to `requestStats`' 75584, consistent
with two independent write paths off the same event rather than one
mechanically deriving the other.

Not recorded in any SQL table for any of the above three: sessionHash, sid,
rid, or any other conversation-linking key. Confirmed by reading every column
list above against the live `.schema` output.

## 2. Is a conversation reconstructable

No, not from `requestStats` or `requestDetails`, and this is the load-bearing
answer for the parallel dashboard effort.

`requestStats` and `requestDetails` are keyed only by
`provider/model/connectionId/timestamp/status` (`schema.js:152-211`). Neither
carries a sessionHash, sid, or rid column. A per-request token/latency row
cannot be joined to any other row of the same client conversation through
these tables. Verified against the live `.schema` output, not just the
declared schema.

A durable, restart-surviving session key does exist, but it lives in a
different pair of tables that are not per-request logs.

`sessionAffinity` (`schema.js:243-268`) is a current-pin-state table, primary
key `(sessionHash, model)`, columns `connectionId, providerNode, pinnedAt,
expiresAt, lastSeenAt`. `sessionHash` is described in the schema comment as
"salted hash of the client session identity... never the raw identity."
`sessionAffinityRepo.js` exposes `getPin/setPin/clearPin/touchPin/sweepExpired`,
an upsert-by-key model: one row per (session, model) pair, overwritten on
each pin, not appended. Live row count 188.

`accountSwitches` (`schema.js:272-296`) is an append-only receipt log, one
row per pin-or-repin event, `sessionHash, model, fromConnectionId,
toConnectionId, trigger, reason, windows, switchedAt`. This is the closest
thing in SQL to a session-keyed timeline, but it records only account-switch
events (`initial-pin`, `exhaustion`, `reset`, `drain`, `model-failure`), not
every request, and it carries no token counts. Live row count 961.

Neither `sessionAffinity` nor `accountSwitches` is joined anywhere in the
read paths inspected (`requestStatsRepo.js`, `requestDetailsRepo.js`,
`sessionAffinityRepo.js`) to `requestStats` or `requestDetails`. The only
column they share with those tables is `connectionId`, which identifies an
upstream account, not a client session, and one account serves many sessions
concurrently (an account fan-in, not a session fan-out).

The sessionHash derivation itself: `sha256(providerId:sessionId|anonymous)`
truncated to 32 hex characters, computed in two places that are meant to be
identical, `src/sse/services/auth.js` (`resolveRoutingSessionHash`, chat
path) and `src/app/api/v1/mcp/route.js:64-86` (`sessionHashForProvider`, MCP
path), the latter carrying a comment asserting it is "exact replica of the
chat path's hash chain." Both call `resolveSessionIdentity()`
(`open-sse/utils/sessionManager.js:223-232`), whose precedence is client
session id (from headers/body, `extractClientSessionId`,
`sessionManager.js:145-165`) then an accumulated-assistant-text hash
(`assistantTextSessionId`, `sessionManager.js:190-209`, in-memory, capped at
5000, TTL-evicted) then `workspaceId` then a per-connection generated id
(`deriveSessionId`, in-memory, capped at 1000, TTL-evicted, regenerated on
process restart). Only the first branch (an explicit client-supplied session
id, e.g. Claude Code's `x-claude-code-session-id` header or
`metadata.user_id`) survives a TokenProxy restart with the same value; every
other branch either regenerates on restart or is itself already ephemeral.

Separately, `chatCore.js` derives an 8-hex-character `sid` used for the
MCP-facing context-status snapshot (`contextStatusStore.js`) and for the
in-memory `ridSessions`/`sessionCalibration`/`ceBodies` maps
(`chatCore.js:203-231`). The MCP route computes this as `idPrefix(hash)`
(`mcp/route.js:122`), where `hash` is the 32-character sessionHash above and
`idPrefix` is imported from `src/shared/observability/decide.js`, a file this
pass could not read under its permitted scope. The exact transform
`idPrefix` performs (a truncation, another hash, or something else) is
therefore not confirmed here; the 8-vs-32-character naming and the shared
input strongly suggest `sid` is a deterministic function of the same
sessionHash, but this is inference, not a confirmed read.

Bottom line: a session identity capable of surviving a restart exists
(`sessionHash`, when the client sends an explicit session id), and it is
durably persisted, but only as pin state and switch receipts, never as a
per-request token ledger. Reconstructing "how many tokens did conversation X
use over its lifetime" from the SQL database alone is not possible today.
The closest available proxy, joining `sessionAffinity`/`accountSwitches` on
`connectionId` against `requestStats`, was tested live in section 6 below and
returns account-level noise, not a conversation.

## 3. Is the in-and-out delta observable

Partially, and split across three different places that do not converge.

Per-stage byte deltas are computed live in `chatCore.js` via a
`measureSaverStage()`-style pattern: each saver stage (tools-dedup,
schema-distill, thinking-strip, RTK, privacy, caveman/ponytail inject,
pxpipe, memory ladder, query-aware-compression, pair-drop, embedding-reorder,
mid-prefix-inject, cache-anchor) reports a `{ stage, delta }` pushed onto
`saverStages`, aggregated at `chatCore.js:1408-1414` into
`saverFields.save = saverStages.map(st => \`${st.stage}:${st.delta}\`).join(",")`
and `saverFields.save_tok = Math.round(sum(delta) / 4)`. This aggregate is
handed to `reqSummary()`/`decide()` (imports from the out-of-scope
`decide.js`, but the call site itself is in `chatCore.js`, in-scope), which
per the module's own JSDoc lands in `DATA_DIR/logs/decisions.ndjson`.

RTK specifically measures character counts, not bytes or tokens: `rtk/index.js`
`compressMessages(body, enabled)` walks `compressText(text, stats, shape)`
which tallies `stats.charsBefore/charsAfter` (string lengths) per message,
formatted by `formatRtkLog(stats)`. These character counts are the same
numbers that, if emitted, become a `token-saver` event row (see below); RTK
never touches a byte or a provider token count itself.

Cache-epoch (`ce`) tracking, `chatCore.js:203-231` and the `trackCacheEpoch()`
call at `chatCore.js:1380`, is a per-session, block-level SHA1 fingerprint of
the final pre-dispatch serialized body, kept in the in-memory `ceBodies` Map
(cap 2048 entries, 30-minute TTL, 64 KiB max raw block retained per session).
It estimates how many bytes of the previous request's prefix survived
unchanged into this one. Never persisted to SQL; visible only through the
MCP `context_status` tool and the `context-status.json` snapshot file.

The actual provider-billed usage (`extractUsageFromResponse()`,
`open-sse/handlers/chatCore/requestDetail.js:25-72`) is parsed per response
format (Claude `usage.input_tokens`/`output_tokens`, OpenAI
`usage.prompt_tokens`/`completion_tokens`, Gemini `usageMetadata`) and does
reach `requestStats`/`usageHistory` via `saveRequestStats`/`saveUsageStats`.
This is the one number in the whole pipeline that both crosses the SQL
boundary and is unambiguously "what the provider charged," but it carries no
saver attribution and no session key (section 1, 2).

So: the raw in/out token delta is observable and persisted (`requestStats`).
The per-technique savings delta is computed, but lands only in flat files
(`events.jsonl`, `decisions.ndjson`) or an in-memory-only snapshot
(`ceBodies`), never in SQL, and is discarded from the SQL side of the system
entirely once the response is dispatched.

## 4. Per-technique attribution

Each technique's firing is recorded, but the record's home and its unit
differ per technique, and none of them is joined to a session identity in
anything more durable than an ephemeral in-memory map.

RTK: `rtk/index.js` returns per-call stats (chars before/after/saved); the
call site in `chatCore.js` is responsible for turning that into a
`token-saver` event row if it chooses to (see `appendTokenSaverEvent`,
`src/lib/tokenSaver/events.js:103-160`), gated by a strict allowlist,
`SAVERS = new Set(["rtk","headroom","pxpipe","inject","mem","schema",
"privacy","thinking","qac","pairs","reorder","midinject","tools"])`
(`events.js:19`). Each row carries `charsBefore/charsAfter/charsSaved` for
`rtk`, `tokensBefore/tokensAfter/tokensSaved` plus true body-byte counts for
`headroom`, `tokensBeforeEst/tokensAfterEst/tokensSavedEst` for `pxpipe`, an
optional 8-hex `rid` (`events.js:152-154`), and an explicit unit-mixing
warning in the file's own header comment: rtk is characters, headroom is
proxy-reported tokens plus true bytes, pxpipe is estimated tokens.

Translator hop: not found as an attributed event in this pass. The
translator engine (`open-sse/translator/`) self-registers direct routes
(`register(from, to, ...)`) per the project's own architecture doc; no call
site discovered in `chatCore.js` that writes a "translator X ran with before-
size Y" record to either the SQL tables or the `token-saver` events sink. If
this exists it was not found within scope; treat as "not recorded" until
disproven by a further read.

Combo expansion and account fallback/retry: `accountSwitches`
(`schema.js:272-296`) is the one durable, queryable per-event record of an
account-level fallback firing, with `trigger` values `exhaustion`, `reset`,
`drain`, `model-failure`, `initial-pin`, and a `windows` JSON snapshot of the
quota evidence behind the decision. It does not carry a before/after
token/byte size, only which connection was chosen and why. Live row count
961. `token-saver` events also carry an 8-hex `rid` used to de-duplicate
"one row per attempt" when a request retries across accounts
(`events.js:290-299`, `getTokenSaverStats()`'s `seenRidSaver` dedup).

Session correlation for all of the above: `rid` is the only cross-reference
key present on `token-saver` event rows, and `rid -> sid` exists only in the
in-memory, TTL-evicted `ridSessions` Map (`chatCore.js:227,230-232`,
populated at `chatCore.js:1417`, consumed once in `onReqSummary`'s callback
at `chatCore.js:1412-1429` then deleted). Once that map entry evicts or the
process restarts, a `token-saver` event's `rid` can no longer be resolved
back to a session at all, in any store.

## 5. What existing read surfaces already answer

`/api/context-status` (`src/app/api/context-status/route.js`): GET only,
wraps `readAllContextStatuses()`, returns `{ generatedAt, entries: [{ sid,
rid, ctxTokens, saveBytes, ceBytes, compactHint, updatedAt }] }`, top 100,
newest-first. One row per session, latest state only, not a timeline.

`/api/v1/mcp` (`src/app/api/v1/mcp/route.js`), JSON-RPC 2.0, one tool
`context_status` (schema at `route.js:30-44`). `tools/call` with no `sid`
argument resolves the caller's own session by recomputing the sessionHash
for every provider the deployment has a connection for
(`resolveOwnStatus()`, `route.js:100-128`), skipping any hash that resolved
anonymous (shared-namespace hashes are explicitly excluded from "your own"
status, `route.js:118-121`, to avoid leaking another anonymous caller's
freshest entry). Returns exactly the same shape as `/api/context-status`'
per-entry object (`statusResult()`, `route.js:130-161`): `sid, rid, ctxTokens,
ctxTokensActual, saveBytes, ceBytes, compactHint, updatedAt`. This confirms,
read directly from the server-side implementation rather than inferred, that
`ctxTokensActual` is the field distinguishing "gateway's own byte-based
estimate" from "what the provider actually billed," per the tool's own
description string at `route.js:33`.

`/api/token-saver/stats` (`src/app/api/token-saver/stats/route.js`): wraps
`getTokenSaverStats()` (`src/lib/tokenSaver/events.js:246-330`). Returns
`windows` (`all/today/yesterday/last7d/last30d`), each with
`requests/applied/bypassed/errors/charsReduced/proxyTokensSaved/
bodyBytesReduced/headroomRequests/estTokensSaved/imagesGenerated/avgMs/
stages` (a per-saver `{requests, applied, bytesSaved}` map), a UTC-daily
`timeline` array (`requests/compressed/charsReduced/proxyTokensSaved/
estTokensSaved` per day), and a `recent` array capped at 500 raw rows. The
route's own `sources` object documents the unit mismatch (rtk=chars,
headroom=proxy tokens+bytes, pxpipe=estimated tokens) explicitly, matching
the header comment in `events.js:5-11`. `errors` is permanently 0 by design:
a comment at `events.js:189-190` states no producer persists failure rows.

`/api/usage/stats`, `/api/usage/statistics`, `/api/usage/chart`: all read
from `requestStats` via `requestStatsRepo.js`'s `getStatsSummary/
getStatsSeries/getStatsItems`, meaning everything in section 1's
`requestStats` column list, filterable and bucketable, but with the same
session-blindness as the underlying table.

`/api/usage/request-details`: GET, wraps `getRequestDetails()`
(`requestDetailsRepo.js`), redacts each row through `redactDetail()`
(deep-redacts body content, keeps only `response.error`/`response.status` on
a failed request). Since live `requestDetails` has 0 rows (section 1), this
route currently returns an empty result set on this deployment regardless of
its shape.

No route or MCP tool inspected answers "total tokens for conversation X" or
"which technique saved how much for session Y," because no persisted table
carries both a token count and a session key together.

## 6. Cost of asking

All queries run live, read-only, via `sqlite3 -readonly
~/.tokenproxy/db/data.sqlite`, with `.timer on`. Wall times below are as
reported by `sqlite3`'s own `Run Time`.

Query A, attempted per-conversation token timeline (the closest SQL can get,
joining the durable session key to token rows through the only shared column,
`connectionId`):

```sql
SELECT sa.sessionHash, r.timestamp, r.promptTokens, r.completionTokens
FROM sessionAffinity sa
JOIN requestStats r ON r.connectionId = sa.connectionId
WHERE sa.sessionHash = (SELECT sessionHash FROM sessionAffinity LIMIT 1)
ORDER BY r.timestamp;
```

`EXPLAIN QUERY PLAN`: `SEARCH sa USING INDEX sqlite_autoindex_sessionAffinity_1`,
`SEARCH r USING INDEX idx_rs_conn`, `USE TEMP B-TREE FOR ORDER BY`. Both
lookups ride an existing index; no missing index. Row count for one
arbitrary sessionHash: 30178 candidate rows, wall time 0.002s. That row count
is the tell: this is every request routed through the account that session
happened to be pinned to, not that session's own requests, because
`connectionId` identifies an upstream account shared across many sessions.
The query runs fast and returns a materially wrong answer, which is a
finding in its own right, not just a performance number.

Query B, per-technique savings rollup, attempted directly against SQL:
there is no query to write. No SQL table carries a saver-stage attribution
at all (section 4); the only source for this is
`readTokenSaverEvents()`/`getTokenSaverStats()` over the JSONL file, which is
a full-file scan and JS aggregation, not a SQL query, so it has no EXPLAIN
plan and no missing index to name. This is itself the finding: the
highest-value dashboard question (which technique earned its keep) cannot be
answered by SQL as the system is currently built.

Query C, provider/model token rollup over 30 days (a query SQL actually
answers correctly):

```sql
SELECT provider, model, count(*), sum(promptTokens), sum(completionTokens),
       sum(cachedTokens)
FROM requestStats
WHERE timestamp >= datetime('now','-30 days')
GROUP BY provider, model
ORDER BY count(*) DESC LIMIT 10;
```

`EXPLAIN QUERY PLAN`: `SCAN requestStats USING INDEX idx_rs_provider`,
`USE TEMP B-TREE FOR GROUP BY`, `USE TEMP B-TREE FOR ORDER BY`. Wall time
0.037s over 75584 rows, top row `claude / claude-opus-5`, 39034 requests,
5894022184 prompt tokens (cache-inclusive per `canonicalizeUsage`), 30923055
completion tokens, 4920364701 cached tokens. This is fast and correct for
what it claims (provider/model rollup); it does not name a missing index
because the scan is provider-selective by design (`idx_rs_provider` exists)
and 75584 rows is small enough that the temp B-trees are not a measured
concern here, though no index covers `(provider, model, timestamp)` together,
which would remove both temp B-trees if this exact grouping becomes a
frequent dashboard query.

## 7. Project clustering

Ranked by reliability, each checked against a live count or an explicit
code read rather than assumed:

1. Explicit client session id (header or `metadata.user_id`), the first
   branch of `resolveSessionIdentity()`
   (`open-sse/utils/sessionManager.js:145-165,223-232`). Present today, and
   the only branch of the five-way precedence chain that survives a
   TokenProxy restart with an unchanged value. Not itself a project
   identifier (it identifies a client conversation, e.g. one Claude Code
   session), but it is the only reliable join key available at all, and
   nothing downstream persists it to SQL (section 2).

2. `providerSpecificData.workspaceId` / `projectId` on a connection, present
   in code for several providers: `grok-cli.js:168`
   (`credentials?.providerSpecificData?.workspaceId`), `vertex.js:38-76`
   (Google Cloud `projectId` resolved from a service-account JSON or ADC),
   `chatSearch.js:108-110` (Antigravity `credentials.projectId`),
   `connectionsRepo.js:344-346` (`chatgptAccountId` used to disambiguate a
   connection's display name). This identifies an *account*, not a client
   project or repository; it is present today for the providers that use
   OAuth-style accounts, but it clusters by which upstream account was used,
   not by which local codebase the request came from. Reliability for
   "which of the user's projects is this" is low, because one account serves
   every project the user works in.

3. System-prompt fingerprint. Not recorded anywhere found in this pass. RTK
   and the translator layer read and transform system-prompt content
   (`translator/request/claude-to-kiro.js:248-283`,
   `translator/request/openai-to-kiro.js:362-389`) but nothing hashes or
   persists a stable fingerprint of it; `strip-and-truncate` in
   `requestDetailsRepo.js` and the `token-saver` events allowlist
   (`events.js:19`) both explicitly forbid raw prompt content reaching disk.
   Building this signal would require adding new recording, and its
   reliability is unproven since two different Claude Code sessions on
   different projects may share a near-identical system prompt template.

4. Model plus cadence signature (which models a session calls, at what
   timing). Partially present: `reasoningEffort` and `requestedModel` are
   recorded per request in `usageHistory.meta`
   (`usageRepo.js:222-226,343,572`), live-verified,
   `{"requestedModel":"claude-sonnet-5","reasoningEffort":"high"}`. Per-model
   counts and token sums are cheaply queryable (Query C above). But nothing
   ties a sequence of these rows back to one client session (section 2), so
   "cadence" here means population-level model mix, not per-conversation
   cadence, until a session key is joined in.

5. Path/cwd fragment inside a request body. Not recorded anywhere found in
   this pass; every persistence path that touches raw body content
   (`requestDetailsRepo.js`'s `redactAndTruncate`, the `token-saver` events
   allowlist) is built to strip this kind of content rather than keep it, so
   it would need a new, explicitly-scoped extraction step, not a config flip.
   The one place a body-derived value already survives into an in-memory-only
   structure is `assistantTextSessionId()`'s hash-of-first-50-characters
   (`sessionManager.js:190-209`), which is a session-continuity signal, not a
   project signal, and is not persisted to disk at all.

Ranking, most to least reliable given what exists today: (1) explicit client
session id, present, unpersisted to SQL; (4) requestedModel/reasoningEffort,
present, persisted, but session-blind; (2) provider workspace/projectId,
present for some providers, persisted, but account-grained not
project-grained; (3) system-prompt fingerprint, absent, would need new
recording; (5) path/cwd fragment, absent, actively stripped by existing
redaction, would need new recording and a redaction-policy decision before it
could be added at all.

## Priority list

What already exists and only needs to be surfaced or joined, no new
recording:

- `requestStats` full-history token/latency data (75584 rows live) is ready
  for any provider/model/time-bucketed view today (Query C).
- `sessionAffinity` and `accountSwitches` already carry the durable session
  key (`sessionHash`) and are queryable now for "which account is/was this
  session pinned to and why" (961 switch receipts live).
- The MCP `context_status` tool and `/api/context-status` already expose the
  richest per-session snapshot in the system (`ctxTokens`, `ctxTokensActual`,
  `saveBytes`, `ceBytes`, `compactHint`), just not as a timeline.

What must start being recorded before a per-conversation dashboard can answer
its most basic question:

- A session key (`sessionHash` or `sid`) added as a column on `requestStats`
  (and/or `requestDetails`), written at the same call site that already
  computes `sid` in `chatCore.js`. Without this, section 2's answer stands:
  no query joins tokens to a conversation.
- A durable home for the per-technique savings events currently confined to
  `DATA_DIR/token-saver/events.jsonl`, at minimum an index or export path
  that lets them be joined to the new session column above; today they carry
  only `rid`, resolvable to a session only through the ephemeral
  `ridSessions` Map (section 4).
- If per-project clustering is wanted, a decision on which of the two
  unrecorded candidates (system-prompt fingerprint or a redacted path/cwd
  token) is acceptable to add given the existing, deliberate policy of never
  persisting raw prompt or path content; both require a redaction-policy
  change, not just a new column.
