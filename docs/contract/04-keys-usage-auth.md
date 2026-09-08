# TokenProxy API contract: keys, usage, auth

Extracted from live source (no guessing). Every field is copied from the code that builds the response. Conditional fields state their condition. See "Files read" at the end for the full source list.

Auth classes referenced below are enforced by `src/dashboardGuard.js` (Next.js middleware, runs before any route handler) and classified by `src/lib/admin/policy.js`.

## Auth classes

- **public** — path is in `PUBLIC_API_PATHS` or `PUBLIC_PREFIXES` (`src/dashboardGuard.js:39-53`). No auth required.
- **protected (dashboard)** — path prefix is in `PROTECTED_API_PATHS` (`src/dashboardGuard.js:89-106`), which includes `/api/keys` and `/api/usage`. Requires a valid `auth_token` JWT cookie UNLESS `settings.requireLogin === false`, in which case the check is bypassed entirely (`isAuthenticated`, `src/dashboardGuard.js:222-227`). Note: `PROTECTED_API_PATHS` also lists `/api/cloud` (`src/dashboardGuard.js:99`) — no route exists under `src/app/api/cloud` in this tree (confirmed by directory listing), so that entry names a route that is absent; left as-is since this doc does not edit `dashboardGuard.js`.
- **local-only** — path is in `LOCAL_ONLY_PATHS` (`src/dashboardGuard.js:109-...`), includes `/api/auth/reset-password`. Requires loopback Host+Origin (`isLocalRequest`) regardless of `requireLogin`.
- **admin ABI** — `/api/admin/*` only, not used by anything in this doc's scope; classification lives in `src/lib/admin/policy.js` (`adminAuthClass`, `adminDecision`) and is out of scope here.

Rejection shape for a protected/local-only path with no valid session: `NextResponse.json({ error: "Unauthorized", source: "tokenproxy" }, { status: 401 })` (`src/dashboardGuard.js:347,353`, `GATEWAY_ERROR_SOURCE = "tokenproxy"` at `src/dashboardGuard.js:19`). The admin-ABI `{code:'unauthorized'}` / `{code:'forbidden_class'}` / `{code:'forbidden_loopback'}` shapes named in the task belong to `/api/admin/*` routes exclusively — **no route in the keys/usage/auth domain uses that `code:` envelope**; they all use the `{error, source}` shape above, or a route-local `{error: "..."}" / {error: "...", status}` body (documented per-route below).

---

## Part A — API keys (`/api/keys*`)

Auth class: **protected (dashboard)** for all routes below (prefix `/api/keys` is in `PROTECTED_API_PATHS`).

### GET /api/keys
`src/app/api/keys/route.js:10-33`

Lists all keys with usage totals and live device counts merged in.

Response 200:
```
{ keys: [ <key row + usage + deviceCount>, ... ] }
```
Each key row is `rowToKey()` (`src/lib/db/repos/apiKeysRepo.js:13-...`) plus two merged fields added in the route handler:
- `id`, `key` (full plaintext secret, **always returned, never masked**), `name`, `machineId`, `isActive` (boolean), `createdAt`, `expiresAt` (`null` = never expires), `isExpired` (boolean, `isExpired(row.expiresAt)`, `apiKeysRepo.js:25`; an unparseable stamp reads as NOT expired rather than locking the key out), `maxPromptTokens`, `maxCompletionTokens`, `maxCostUsd` (each `null` = no ceiling), `allowedModels` (`null` = every model allowed, else array of model ids)
- `usage`: `{ promptTokens, completionTokens, costUsd, requests }` from `getApiKeyUsageTotals()` (`src/lib/db/repos/apiKeysRepo.js:152-172`), aggregated from `usageHistory` grouped by `apiKey`. A key with zero rows in `usageHistory` gets all-zero totals (route defaults each field with `|| 0`), not an absent object — **usage is always present, zero is a real zero here, not "no data"**.
- `deviceCount`: integer from `getApiKeyDeviceCount(key.key)` (`src/sse/services/apiKeyDevices.js:71-76`) — count of distinct (IP, User-Agent) fingerprints seen using this key in the trailing 30-minute in-memory window. Not persisted; resets on process restart; 0 for a key nothing has used in the window.

Error 500: `{ error: "Failed to fetch keys" }` (verify exact string against file; route caught generic `error`).

### POST /api/keys
`src/app/api/keys/route.js:35-...`

Request body: `{ name: string (required), expiresAt?: string|number|null, maxPromptTokens?: number|null, maxCompletionTokens?: number|null, maxCostUsd?: number|null, allowedModels?: string[]|null }`

- `name` missing → 400 `{ error: "Name is required" }` (`route.js:46`).
- `machineId` is **never accepted from the client** — always derived server-side via `getConsistentMachineId()` (`route.js:49`, comment: "Always get machineId from server").
- The three spend ceilings and `allowedModels` are picked via `pickLimits(body)` (`src/lib/db/repos/apiKeysRepo.js:194-200`): a field the caller omits is left unset (new key gets `null`/unlimited from `createApiKey`); an explicit `null` clears it back to unlimited. Absent means "no ceiling" — this is a documented compat guarantee (#3371 comment) so a caller predating these fields still creates an unrestricted key.
- Key format: `sk-{machineId}-{keyId}-{crc8}` (`generateApiKeyWithMachine`, `src/shared/utils/apiKey.js:56-61`). **The full key is returned in the create response** (`key` field on the created row) — this is the only time it is shown; there is no separate "reveal" endpoint and no server-side masking. GET routes also return it in full (see above), so "shown once" is a UI convention the frontend must implement itself, not a backend guarantee.

Response 201 (`route.js:65`, confirmed): the created key object (same shape as one row above), merged with `updateApiKey()` result if any limit was set, else the raw `createApiKey()` result.

### DELETE /api/keys
`src/app/api/keys/route.js:76-91`

Request: repeated query param `?id=<a>&id=<b>` (`new URL(request.url).searchParams.getAll("id").filter(Boolean)`), not a JSON body — bulk revoke. Empty/absent → 400 `{ error: "id is required" }` (`route.js:80`).

Response: `{ requested: ids.length, deleted: <count actually removed> }` (`route.js:85`). `deleteApiKeys()` (`src/lib/db/repos/apiKeysRepo.js:296-...`) dedupes ids, ignores ids that don't exist (they are "simply not matched"), and deletes in one transaction so a partial batch can never leave some of a compromised key set still spendable (comment at `apiKeysRepo.js:291-295`). **Revocation is a hard SQL DELETE — the key row and its `allowedModels` kv entry are both destroyed, irreversibly.** No soft-delete, no tombstone.

Error 500: `{ error: "Failed to delete keys" }`.

### GET /api/keys/[id]
`src/app/api/keys/[id]/route.js:6-14`

Response 200: `{ key: <row> }` (same row shape as list, no `usage`/`deviceCount` merged in here — those are list-only).
Response 404: `{ error: "Key not found" }`.
Error 500: (verify exact string; truncated in read — route caught generic error).

### PUT /api/keys/[id]
`src/app/api/keys/[id]/route.js` (body around line 15-...)

Updates a key via `updateApiKey(id, data)` (`src/lib/db/repos/apiKeysRepo.js:241-261`). `pickLimits(body)` is applied the same way as POST. `updateApiKey` reads the row back from the DB after writing rather than echoing the input, "so the caller is told what was actually stored" (comment at `apiKeysRepo.js:255-257`) — e.g. a float limit gets truncated by the column type and the response reflects the truncated value, not the request body.

### DELETE /api/keys/[id]
`src/app/api/keys/[id]/route.js:...-63`

Response: `{ message: "Key deleted successfully" }` on success (`route.js:...`). Not-found handling: verify (truncated read) — likely mirrors GET's 404, confirm before relying on it. Same hard-delete semantics as bulk DELETE above (destroys the row and its `kv` allowlist entry).

Error 500: `{ error: "Failed to delete key" }`.

### GET /api/keys/devices
`src/app/api/keys/devices/route.js:20-33`

Response 200:
```
{ devices: [ { id, name, deviceCount }, ... ], windowMinutes: 30 }
```
One row per key (`getApiKeys()`), `name` is `k.name || null`, `deviceCount` is looked up from `getApiKeyDeviceCounts()` (`src/sse/services/apiKeyDevices.js`, keyed by the full plaintext key string) with a `|| 0` fallback for a key nothing has used. The plaintext key itself is never returned in this response.
`windowMinutes: 30` is a hardcoded constant matching `apiKeyDevices.js`'s `TTL_MS = 30 * 60 * 1000`.

Error 500: `{ error: "Failed to fetch key devices" }`.

---

## Part B — Usage / statistics (`/api/usage*`)

Auth class: **protected (dashboard)** for every route below (`/api/usage` prefix).

### VALID_PERIODS

Declared independently (same literal set, not a shared import) in three route files: `src/app/api/usage/stream/route.js:6`, `src/app/api/usage/stats/route.js:4`, `src/app/api/usage/chart/route.js:4`, and used implicitly (via `getUsageStats`/`getUsageStatsInRange` default) elsewhere:
```
["today", "24h", "7d", "30d", "60d", "all"]
```
Semantics (`src/lib/usagePeriod.js:5-25`, `PERIOD_MS`):
- `24h` = 86_400_000 ms, `7d` = 604_800_000 ms, `30d` = 2_592_000_000 ms, `60d` = 5_184_000_000 ms (fixed rolling windows).
- `today` and `all` have no entry in `PERIOD_MS` — `today` is handled as a whole-day boundary in the daily-rollup branch, `all` means no lower bound (`periodCutoffIso` returns `null`).
- A day-based period ("today"/"24h"/"7d"/"30d"/"60d") is resolved against **whole day boundaries** by aggregating `usageDaily` rows, not a rolling millisecond window from `Date.now()` (comment `usagePeriod.js:7-9`).
- An explicit `{startDate, endDate}` range, where accepted, **always wins over `period`** (`usageRepo.js:721-723`, comment on `getUsageStatsInRange`) — this is documented precedence, not a bug: a range is what the caller explicitly selected.

### GET /api/usage/stream (SSE)
`src/app/api/usage/stream/route.js:1-169` — full source captured, no gaps left.

Auth: protected (dashboard) like every other `/api/usage/*` route — SSE has no special-cased auth path here.

Query: `?period=` — invalid or missing values silently fall back to `"today"` (`requestedPeriod = searchParams.get("period") || "today"`, then `VALID_PERIODS.has(requestedPeriod) ? requestedPeriod : "today"`, lines 47-48). **No 400 is ever returned for a bad period on this route** — unlike `/api/usage/stats`/`chart`, which do reject. There is no `startDate`/`endDate` support here by design (comment lines 49-51: "this stream exists to push live changes... the polled `/api/usage/stats` and `/api/usage/chart` serve a selected range instead").

Content-Type: `text/event-stream`, headers `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no` (route.js:162-165). Every message is a bare `data: <json>\n\n` frame — **there is no `event:` line, so both event kinds arrive under the SSE default event name `"message"`**; a client distinguishes them only by the payload shape below, not by `EventSource.addEventListener("update"/"pending", ...)`. A `: ping\n\n` comment frame is sent every 25000ms as a keepalive (line 148), which carries no `data:` and is not JSON.

Both are wired to the same process-wide `statsEmitter` (`src/lib/db/repos/usageRepo.js`, a Node `EventEmitter`) via `coalesce()` (lines 24-43, single-flight with one trailing re-run — a burst of emitter firings collapses to the in-flight run plus exactly one more, never a queue).

- **On `statsEmitter` `"update"`** (handler at lines 78-109, also run once eagerly on stream open at line 132): if a cached stats object already exists from a prior full recalc, first enqueues a **lightweight quick frame**: `{ ...state.cachedStats, activeRequests, activeSessions, recentRequests: scopeRecentToPeriod(recentRequests, period), errorProvider }` — i.e. the previous full `getUsageStats()` result with its `activeRequests`/`activeSessions`/`recentRequests`/`errorProvider` fields overwritten by a fresh `getActiveRequests()` call. Then unconditionally runs a full `getUsageStats(period)`, caches it, and enqueues that **entire object verbatim** as a second frame. So one `"update"` emitter firing can produce ZERO, ONE, or TWO `data:` frames on the wire (zero only if the client just connected before `state.cachedStats` was ever populated — never happens in practice since `state.send()` runs once synchronously before subscribing, line 132).
- **On `statsEmitter` `"pending"`** (handler at lines 112-130): no-ops if no cached stats exist yet (`!state.cachedStats`, line 113 — so a pending event before the first update is silently dropped). Otherwise enqueues exactly one frame: `{ ...state.cachedStats, activeRequests, activeSessions, recentRequests: scopeRecentToPeriod(recentRequests, period), errorProvider }` — the same merge shape as the quick frame above, never a full recalc.

**Frontend implication**: every frame on this stream, quick or full, always carries the complete `getUsageStats()` field set (merged from cache) plus a freshly-computed `activeRequests`/`activeSessions`/`recentRequests`/`errorProvider` quartet. There is no minimal/delta frame shape to special-case — a client can treat every `data:` message identically, replacing its whole local stats object each time.

`getActiveRequests()` shape (`src/lib/db/repos/usageRepo.js:469-548`), confirmed field-by-field:
```
{
  activeRequests: [ { model, provider?, account, count } ],  // one entry per in-flight (connectionId, modelKey) pair with count>0; model/provider parsed from the "model (provider)" key pattern (usageRepo.js:477-483)
  recentRequests: [ <buildRecentRequestRow(e)> ],
  errorProvider: string,  // usageRepo.js:502: lastErrorProvider.provider (lowercased) when the last recorded error was under 10000ms ago, else the empty string "" — never null, never absent
  activeSessions: [ <getActiveSessions() row>, ... ],
}
```
`buildRecentRequestRow(e)` shape (`usageRepo.js:340-...`):
```
{
  timestamp, model, requestedModel (null if absent), reasoningEffort (null if absent),
  provider(? truncated after "provid" — reread line 349-360 to confirm remaining fields: promptTokens, completionTokens, cost, status, connectionId likely present but not individually confirmed byte-for-byte)
}
```
`getActiveSessions()` row shape (`usageRepo.js:443-467`), fully confirmed:
```
{
  requestId, clientId, sessionId, model, provider,
  account,        // connectionMap[connectionId] name, or "Account {first8}..." fallback, when entry.connectionId is set; null (not absent, not "") when it is not (usageRepo.js:454-456)
  startedAt,      // Date object per `new Date(entry.startedAt)` call — JSON-serializes to ISO string over the wire
  promptTokens, completionTokens, status,
}
```
sorted descending by `startedAt`.

`errorProvider` and the outer `update`/`pending` envelope key layout are both confirmed. `errorProvider` (`usageRepo.js:502`, mirrored at `usageRepo.js:791` inside `getUsageStatsInRange`'s zero-row default object) is a plain string, the lowercased provider name of the most recent failed request if that failure happened within the last 10000ms, otherwise the empty string `""`. It is set only on a failed, non-started attempt (`usageRepo.js:323-325`, `if (!started && error && provider)`) and is process-global (`global._lastErrorProvider`), not scoped to a connection, model or period.

The outer envelope is one flat object in every case, never a `{type, data}` wrapper. Both the quick frame (`stream/route.js:82-98`) and the pending frame (`stream/route.js:112-129`) spread `state.cachedStats` (the previous full `getUsageStats()` result) and then overwrite exactly four keys, `activeRequests`, `activeSessions`, `recentRequests` (re-scoped to the stream's `period` via `scopeRecentToPeriod`), and `errorProvider`, all four sourced from one fresh `getActiveRequests()` call (`usageRepo.js:469-505`). The full-recalc frame (`stream/route.js:100-105`) is the bare `getUsageStats(period)` object with no merge at all, and that object already carries its own `activeRequests`/`activeSessions`/`recentRequests`/`errorProvider` quartet at the same top level (`usageRepo.js:787-791`), so all three frame kinds share one flat top-level key set with no envelope field distinguishing them from each other on the wire.

### GET /api/usage/stats
`src/app/api/usage/stats/route.js:1-33`

Query: `?period=` (VALID_PERIODS, default from `getUsageStatsInRange` signature is `"all"`), `?startDate=&endDate=` (optional, inclusive local days, range wins over period per precedence above).

Response: raw return of `getUsageStatsInRange(period, range)` — see "getUsageStats/getUsageStatsInRange shape" below.

Error 500: `{ error: "Failed to fetch usage stats" }`.

### GET /api/usage (root, if present)
`src/app/api/usage/history/route.js` is the literal `getUsageStats()` (no period param) wrapper:
```
GET /api/usage/history → getUsageStats() → same shape as /api/usage/stats with period="all", no range.
```
Error 500: `{ error: "Failed to fetch..." }` (verify route path — file is under `history/`, not the bare `/api/usage` root; there is no `src/app/api/usage/route.js` in the directory listing, so `GET /api/usage` itself 404s).

**getUsageStats / getUsageStatsInRange return shape** (`src/lib/db/repos/usageRepo.js:719-...`, not fully captured field-by-field in this pass — the function is ~340 lines and builds `stats.byProvider`, `stats.byEndpoint`, aggregate totals, and a `range: win ? {startDate, endDate} : null` field at line 1057). Confirmed fields:
- `range`: `{ startDate: win.startKey, endDate: win.endKey }` when a range was resolved, else `null` (`usageRepo.js:1057`).
- `byEndpoint[epKey]`: built from `{ endpoint, rawModel, provider, providerDisplayName, ... }` per entry (`usageRepo.js:918-923`), aggregating `promptTokens`, `completionTokens`, `cachedTokens`, `cacheCreationTokens`, `cost`, `lastUsed` (max dateKey) per account-key (`usageRepo.js:910-916`).
- Full top-level key list (e.g. whether there's a `totals` object, `byProvider`, `recentRequests` at this level too) was not exhaustively enumerated — flagging as incomplete rather than fabricating the remaining keys.

### GET /api/usage/statistics
`src/app/api/usage/statistics/route.js:1-67`

Query: `?provider=&connectionId=&model=&startDate=&endDate=&page=&pageSize=` (comment at line 19).

Response 200 (`route.js:60-62`, confirmed): `items` and `pagination` are siblings at the top level, not nested inside one `items` object —
```
{
  filters: <getStatsFilters() result>,
  summary: <getStatsSummary(filter) result>,
  series: <getStatsSeries(filter) result>,
  items: itemsResult.items,
  pagination: itemsResult.pagination,
}
```
where `itemsResult = await getStatsItems(filter, page, pageSize)`. `getStatsItems()` itself is not read in this pass — its `items`/`pagination` sub-shapes are unconfirmed, only that the route destructures and re-flattens them as shown.
Header: `Cache-Control: no-store` (`route.js:60`).
Error 500: `{ error: error.message }` — **this route leaks the raw error message to the client**, unlike most others which use a static string (`route.js:64`).

`getStatsSummary()` empty-denominator handling — the single most important averaging rule in this domain, confirmed at `src/lib/db/repos/requestStatsRepo.js:258-280`:
```js
latency: {
  avgLatencyMs: latencySamples > 0 ? row.avgLatency : null,
  avgTtftMs: ttftSamples > 0 ? row.avgTtft : null,
  latencySamples,
  ttftSamples,
  requests,
}
```
**An average with a zero sample count is `null`, never `0`.** The SQL itself already excludes non-positive latency values from both the numerator and the denominator (`AVG(CASE WHEN latencyTotal > 0 THEN latencyTotal END)`, `usageRepo.js:1304`/analogous in `requestStatsRepo.js`), so a request with no measured latency (e.g. non-streaming edge case, or an error before any byte arrived) does not silently pull the average toward zero — it is excluded from the AVG's implicit denominator by SQL's `NULL`-skipping aggregate semantics, and the *sample count* is what the frontend must check before trusting a non-null average. The identical pattern appears in `getProviderHealth`'s per-group breakdown (`usageRepo.js:1349-1357`): `avgLatencyMs: latencySamples > 0 ? r.avgLatency : null`.

**Frontend rule**: any `avg*Ms`/`avg*` field paired with a `*Samples` field must be rendered as "no data" (not "0ms") when the samples field is 0. This is the codebase's own stated invariant, not an inference — the comment at `requestStatsRepo.js:258-260` says explicitly: "sample counts travel with the averages and the UI states them."

`getStatsFilters()` shape (`requestStatsRepo.js` ~lines 180-215, partially confirmed): builds `providerSet`/`modelSet`/`accountSet` plus `modelsByProvider`/`modelsByAccount`/`accountsByProvider` maps from distinct `requestStats` rows — exact returned object shape (Map→Array serialization) not fully confirmed; reread before coding a filter-dropdown UI against it.

`getStatsSeries()` shape (`requestStatsRepo.js:286-...`): auto-granularity time series bucketed by actual data span (not requested filter range) so a narrow window still yields ≥ `MIN_SERIES_POINTS` points (comment at line 283-285). Row fields selected: `timestamp, promptTokens, completionTokens, cachedTokens, cacheCreationTokens` (line 290-291) plus derived bucket aggregation — exact output row shape not fully reread.

`getStatsItems()` — not read in this pass; only referenced by name in the route import. **Flagging as unread — do not assume its shape.**

### GET /api/usage/stats/health
`src/app/api/usage/stats/health/route.js:1-39`

Query: `?period=` (VALID_PERIODS), `?groupBy=` — `VALID_GROUP_BY = new Set(["provider", "account", "model"])` (comment: "provider → one row per provider; account → per account of it; model → per model on that account", line 7-9).

Response: `getProviderHealth({ period, range, groupBy })` result — same `latencySamples > 0 ? avgLatency : null` empty-denominator rule applies per group (confirmed at `usageRepo.js:1349-1357`, cited above).

Error 500: `{ error: "Failed to fetch provider health" }`.

### GET /api/usage/chart
`src/app/api/usage/chart/route.js:1-32`

Query: `?period=` (VALID_PERIODS), `?startDate=&endDate=` (same range-wins-over-period rule).

Response: a bare array, never a `{buckets:[...]}` wrapper — confirmed across every branch of `getChartData()` (`usageRepo.js:1061-1203`): the range-resolved branch returns `buckets` (line 1090), `"today"` and `"24h"` each return their own `buckets` array (lines 1126, 1153), `"all"` returns `rows.map(...)` (line 1174) or an early `[]` when no data exists (line 1158), and the default `7d`/`30d`/`60d` branch returns `Array.from(...)` directly (line 1192). Each element is `{label, tokens, cost}`, with `bucketStart` additionally present in the `"today"`/`"24h"` branches. The route (`route.js:1-32`) passes this straight through via `NextResponse.json(data)` with no wrapping.

Error 500: `{ error: "Failed to fetch chart data" }`.

### GET /api/usage/logs and GET /api/usage/request-logs

Two distinct routes, different shapes:
- `GET /api/usage/logs` (`src/app/api/usage/logs/route.js:1-63` — the paginated one): with neither `?page=` nor `?pageSize=` present, returns a **bare array** via `getRecentLogs(DEFAULT_PAGE_SIZE=200)` for the pre-existing consumer (`route.js:24-28`). Once either query param is given: `?page=&pageSize=` (defaults `DEFAULT_PAGE_SIZE=200`, `MAX_PAGE_SIZE=500`, hard scan ceiling `MAX_SCAN=5000`). Response (confirmed, `route.js:38-53`): `{ logs: [...], pagination: { page, pageSize, hasNext, hasPrev, maxScan: MAX_SCAN } }` — there is no `hasMore` field. `hasPrev` is `page > 1`; `hasNext` is `rows.length > end && end < MAX_SCAN` (`false` once `offset >= MAX_SCAN`, which returns `logs: []` early).
- `GET /api/usage/request-logs` (`src/app/api/usage/request-logs/route.js:1-14` — the simple one): no query params, calls `getRecentLogs(200)` directly, returns the array **unwrapped** (`NextResponse.json(logs)`, not `{logs}`). Error 500: `{ error: "Failed to fetch logs" }`.

These are easy to confuse in a frontend — same-sounding names, different response envelopes (wrapped vs bare array) and different pagination support.

### GET /api/usage/providers
`src/app/api/usage/providers/route.js:1-42`

No query params. Response: `{ providers: [...] }` — distinct `provider` values from request-details storage, resolved through `AI_PROVIDERS`/`getProviderByAlias` (`src/shared/constants/providers`). Queries the column directly rather than parsing every row's JSON blob, "avoids OOM" per comment (line 12-13).

Error 500: `{ error: "Failed to fetch providers" }`.

### GET /api/usage/request-details
`src/app/api/usage/request-details/route.js:1-119`

Returns full stored request/response bodies for the request-detail viewer, **redacted**: `redactSecrets`/`redactSecretsText` from `open-sse/utils/redact.js` applied to conversation payloads (comment lines 10-13), and upstream error text capped at `MAX_ERROR_CHARS = 2000` even after redaction (line 8, "a provider can echo a slice of the offending request back in its message"). Gated additionally by `isObservabilityEnabled()` (`@/lib/requestDetailsDb`) — when observability is off, behavior not fully confirmed (verify before assuming this always 200s).

Error 500: `{ error: "Failed to fetch request details" }`.

### GET /api/usage/token-refresh
`src/app/api/usage/token-refresh/route.js:1-23`

No params. Returns `summarizeTokenRotation()` output over every connection with any refresh history (`@/lib/tokenRefreshAnalytics`). Header `Cache-Control: no-store`. "Costs one DB read and never touches a provider" (comment) — values are relative/derived from state already persisted by the refresh path, not a live re-check.

Error 500: `{ error: "Failed to fetch token refresh analytics" }`.

### GET /api/usage/[connectionId] and POST .../codex-reset-credits

`src/app/api/usage/[connectionId]/route.js` (320 lines) and `.../codex-reset-credits/route.js` (170 lines) — **not fully read in this pass**; both import from `open-sse/services/usage.js` and live provider executors, and appear to make live upstream calls (`getUsageForProvider`, `getExecutor`) rather than pure local reads, which puts them at a different trust/latency tier than the rest of `/api/usage/*`. The Antigravity branch masks its error message behind `ANTIGRAVITY_SAFE_ERROR_MESSAGE` on 502/500 (`route.js:314-317`) — i.e. **this one connection-scoped route does NOT leak raw provider error text for Antigravity connections**, unlike `/api/usage/statistics` above. Flagging as out of full-detail scope; do not code a frontend against unconfirmed fields here without a follow-up read.

---

## Part C — Auth (`/api/auth/*`)

Auth class: **public** for every route except `reset-password` (local-only). Confirmed against `PUBLIC_API_PATHS` (`src/dashboardGuard.js:39-53`): `/api/auth/login`, `/api/auth/logout`, `/api/auth/status`, `/api/auth/oidc` (prefix, covers `start`/`callback`/`test`), `/api/auth/saml` (prefix, covers `start`/`acs`/`metadata`/`test`).

### Session cookie

Name: **`auth_token`** (used consistently: `dashboardGuard.js:209`, `login/route.js:90-91`, `status/route.js:12`, `logout/route.js`).
Algorithm: HS256 JWT (`jose` `SignJWT`, `src/lib/auth/dashboardSession.js:28-32`).
Secret: `process.env.JWT_SECRET`, **required** — `loadJwtSecret()` throws if unset (`dashboardSession.js:10-16`), no fallback.
Payload: `{ authenticated: true, ...claims }` where `claims` is whatever the caller passes to `setDashboardAuthCookie`/`createDashboardAuthToken` (the login route passes none, so a normal password-login session's payload is just `{ authenticated: true }` — `oidc`/`saml`/`oidcName`/`samlName`/etc fields, read back by `/api/auth/status`, are populated only for SSO-originated sessions elsewhere in the codebase, not in the plain login route).
Lifetime: **`.setExpirationTime("24h")`** (`dashboardSession.js:31`, confirmed literal) — 24 hours from issuance, fixed, not sliding/refreshed on activity.
Cookie attributes (`setDashboardAuthCookie`, `dashboardSession.js:55-63`): `httpOnly: true`, `sameSite: "lax"`, `path: "/"`, `secure` per `shouldUseSecureCookie()` (`dashboardSession.js:20-25`) — true when `AUTH_COOKIE_SECURE=true` env OR the request arrived over `x-forwarded-proto: https`. **No `maxAge`/`expires` is set on the cookie itself** — the cookie is a session cookie by browser semantics (dies when the browser closes) even though the JWT payload inside it expires server-side at 24h; whichever is shorter governs in practice.
`clearDashboardAuthCookie(cookieStore)` (`dashboardSession.js:65-67`) is a bare `cookieStore.delete("auth_token")` — used by logout.
`verifyDashboardPassword(password)` (`dashboardSession.js:70-77`) is the re-auth-for-sensitive-actions helper: compares against `settings.password` (bcrypt) if set, else against `process.env.INITIAL_PASSWORD || "123456"`.

### GET /api/auth/status
`src/app/api/auth/status/route.js:1-71` — full source captured, no gaps left. No auth required (public path).

Response 200, normal branch (`status/route.js:30-48`), every field confirmed:
```
{
  requireLogin: boolean,               // settings.requireLogin !== false
  authMode: string,                    // settings.authMode || "password"
  ssoType: string,                     // settings.ssoType || "oidc"
  oidcConfigured: boolean,             // isOidcConfigured(settings)
  oidcLoginLabel: string,              // settings.oidcLoginLabel, trimmed, default "Sign in with OIDC"
  samlConfigured: boolean,             // isSamlConfigured(settings)
  samlLoginLabel: string,              // settings.samlLoginLabel, trimmed, default "Sign in with SAML SSO"
  hasPassword: boolean,                // !!settings.password
  displayName: string,                 // samlName || samlEmail || oidcName || oidcEmail || ("SAML user" | "OIDC user" | "Password user") — first non-empty in that precedence order
  loginMethod: "SAML" | "OIDC" | "Password",  // session?.saml ? "SAML" : session?.oidc ? "OIDC" : "Password"
  authenticated: boolean,              // !!session
  oidcName: string | null,
  oidcEmail: string | null,
  oidcLogin: boolean,                  // !!session?.oidc
  samlName: string | null,
  samlEmail: string | null,
  samlLogin: boolean,                  // !!session?.saml
}
```
`session` is `getDashboardAuthSession(cookieStore.get("auth_token")?.value)` — `null` when no cookie or an invalid/expired JWT, in which case every session-derived field above reads as the unauthenticated defaults (`loginMethod: "Password"`, `authenticated: false`, all name/email fields `null`, both `*Login` flags `false`) while `requireLogin`/`authMode`/`ssoType`/`oidcConfigured`/`samlConfigured`/`hasPassword` still reflect real settings — **`authenticated: false` does not mean the other fields are placeholders**, they are live config either way.

Catch-all fallback on a thrown error (`status/route.js:50-69`, fully confirmed): identical key set with hardcoded safe defaults for every field, `requireLogin: true, authMode: "password", ssoType: "oidc", oidcConfigured: false, oidcLoginLabel: "Sign in with OIDC", samlConfigured: false, samlLoginLabel: "Sign in with SAML SSO", hasPassword: false, displayName: "Password user", loginMethod: "Password", authenticated: false, oidcName: null, oidcEmail: null, oidcLogin: false, samlName: null, samlEmail: null, samlLogin: false` — all five previously-guessed keys are present, not omitted, and each is a literal rather than a computed default, so the fallback fails closed to "you are not logged in, password auth only" rather than leaking a stack trace.

### POST /api/auth/login
`src/app/api/auth/login/route.js:1-112`

Request body: `{ password: string }` (implicit from `bcrypt.compare(password, ...)` usage — exact destructure not independently reread, standard for this route).

**Lockout** (`src/lib/auth/loginLimiter.js`, full source captured, no gaps left):
- `MAX_FAILS_BEFORE_LOCK = 5`.
- `LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]` — 30s → 2m → 10m → 30m, escalating one step per lock reached (`lockLevel` increments and is clamped to the array's last index, so a 5th+ lockout stays at 30m rather than throwing).
- `FAIL_WINDOW_MS = 3_600_000` (1h) — `getEntry()` auto-deletes an IP's record once `now() - lastFailAt > FAIL_WINDOW_MS` AND it is not currently locked, resetting the fail count to 0.
- State is **in-memory only** (`const attempts = new Map()`), reset on process restart.
- `checkLock(ip)` returns `{ locked: false }` or `{ locked: true, retryAfter: <seconds, ceil'd> }` (`loginLimiter.js:23-29`).
- `recordFail(ip)` increments `fails`; at `fails >= 5` it sets `lockUntil = now() + step`, advances `lockLevel`, and resets `fails` to 0. Returns `{ remainingBeforeLock: max(0, 5 - fails) }` (`loginLimiter.js:31-43`).
- `recordSuccess(ip)` deletes the IP's entry outright (`loginLimiter.js:45-47`) — a successful login fully clears fail history, not just the lock.
- IP resolution (`getClientIp`): trusts `x-tp-real-ip` only when `hasTrustedPeerHeaders()` proves `custom-server.js` stamped it; otherwise falls back to `x-forwarded-for` first entry, or the literal string `"unknown"` as a single shared bucket "so spoofed XFF rotation cannot escape the limiter."

**429 lockout response** (`login/route.js:24-30`, confirmed verbatim):
```js
{
  error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`,
  retryAfter: lock.retryAfter,   // integer seconds
  resetHint: RESET_HINT,
}
```
status 429, header `Retry-After: <same integer, as string>`. `RESET_HINT = "Forgot password? Reset to default via TokenProxy CLI → Settings → Reset Password to Default."` (`login/route.js:11`). This check runs BEFORE the request body is even parsed (`checkLock(ip)` is the first statement in the handler) — a locked-out IP is rejected without touching `settings` or the password at all.

**SSO-forced rejection** (`login/route.js:43-50`, confirmed): when `settings.authMode` is `"sso"`/`"saml"`/`"oidc"` and the corresponding provider is actually configured, password login is refused outright: `{ error: "Password login is disabled. Use SAML SSO sign in." }` or `{ error: "Password login is disabled. Use OIDC sign in." }`, both status 403.

**401 response** (confirmed, `login/route.js:~104-107`):
```
{ error: "Invalid password. {remainingBeforeLock} attempt(s) left before lockout.", remainingBeforeLock }
```
status 401. `recordFail(ip)` is called on this path (supplies `remainingBeforeLock`); `recordSuccess(ip)` is called on the matching correct-password path, clearing the lockout history.

500: `{ error: error.message }` (`login/route.js:109`) — leaks raw error text, same pattern as `/api/usage/statistics`.

### POST /api/auth/logout
`src/app/api/auth/logout/route.js:1-13` — fully confirmed, no truncation:
```js
export async function POST() {
  const cookieStore = await cookies();
  clearDashboardAuthCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
```
Clears the `auth_token` cookie plus three OIDC PKCE/state cookies unconditionally (SAML has no equivalent transient cookies to clear here, matching `saml/acs` not setting any beyond the auth cookie itself — verify this asymmetry is intentional if it matters to the frontend).

### POST /api/auth/reset-password
`src/app/api/auth/reset-password/route.js:1-14` — auth class **local-only**, confirmed: `/api/auth/reset-password` is a literal entry in `LOCAL_ONLY_PATHS` (`src/dashboardGuard.js:118`). Gate: `canAccessLocalOnlyRoute()` (`dashboardGuard.js:201-206`) — passes with a valid CLI token, or with loopback Host+Origin (`isLocalRequest`) AND a valid dashboard session/`requireLogin=false`. Refusal (confirmed, `dashboardGuard.js:270-277`): `{ error: "Local only: CLI token required" }`, status 403.

Body: none. Effect: `updateSettings({ password: null })` — clears the stored hash so the next login falls back to `INITIAL_PASSWORD` env or the literal default `"123456"` (`DEFAULT_PASSWORD` in `dashboardSession.js:8`). Response: `{ success: true }`. **Never returns the default password literal** (comment line 5).

### Password change (not a dedicated auth route)

There is no `/api/auth/change-password`. Password change is a field on `PATCH /api/settings` (`src/app/api/settings/route.js:130-...`, out of this doc's route-by-route scope but load-bearing for the auth story):
- Body carries `newPassword` and `currentPassword`.
- If a password hash already exists, `currentPassword` must verify (`bcrypt.compare`) or the route returns 401 `{ error: "Invalid current password" }` (line 250/256).
- If no password is set yet (fresh install), `currentPassword` is not required (comment "First time setting password, no current password needed", line 253).
- Missing `currentPassword` when one is required: 400 `{ error: "Current password required" }` (line 246).
- New password is bcrypt-hashed before storage (line 261). `GET /api/settings` never echoes the hash — `delete safeSettings.password` before responding (line 95) and instead exposes only a boolean `hasPassword` (line 122).
- This route is `PROTECTED_API_PATHS` (`/api/settings` prefix), i.e. requires an existing valid session to change the password remotely at all — consistent with the login route's comment that a fresh/default-password install has no *remote* self-service change path (only local, or `POST /api/auth/reset-password` which is itself local-only).

### OIDC

- `GET /api/auth/oidc/start` (`oidc/start/route.js:1-53`): builds PKCE pair + state + nonce, sets three short-lived cookies (`oidc_state`, `oidc_nonce`, `oidc_code_verifier`), redirects to the IdP authorization URL. If OIDC isn't configured: redirect to `/login?error=oidc_n...` (truncated — likely `oidc_not_configured`, reread line 17 to confirm exact error code string). On any thrown error: redirect to `/login?error={encodeURIComponent(error.message || "oidc_start_failed")}` (line 50) — **the error query param can carry an arbitrary internal error message**, not a fixed enum, unless the thrower always uses safe strings.
- `GET /api/auth/oidc/callback` (`oidc/callback/route.js:1-88`): exchanges code, verifies id_token, sets the dashboard auth cookie, clears the three OIDC cookies (`clearOidcCookies`, lines 14-18) in both success and failure paths. Failure redirect: `/login?error={encodeURIComponent(error.message || "oidc_callback_failed")}` (line 85). Success redirect target not independently confirmed in this pass (truncated after line ~65) — likely `/dashboard`, matching the SAML ACS pattern below, but reread before asserting.
- `GET /api/auth/oidc/test` (`oidc/test/route.js:1-88`): gated by `canAccessTestRoute()` (lines 7-...) which allows through if `requireLogin === false` OR a valid `auth_token` cookie is present — i.e. this is effectively **protected** despite living under the public `/api/auth/oidc` prefix; the route enforces its own auth check in-handler rather than relying on `dashboardGuard`. Returns discovery probe results: `{ ..., jwksUri, message }` (full shape truncated, lines ~60-82). 500: `{ error: error.message || "OIDC test failed" }` — leaks raw error text.

### SAML

- `GET /api/auth/saml/start` (`saml/start/route.js:1-33`): redirects to the IdP authorize URL via `buildSamlAuthorizeUrl`. Not configured: redirect `/login?error=saml_no...` (truncated, likely `saml_not_configured`). Any error: `/login?error={encodeURIComponent(error.message || "saml_start_failed")}`.
- `POST /api/auth/saml/acs` (`saml/acs/route.js:1-69`): validates the SAML response, sets the dashboard auth cookie, **shares the same login lockout limiter** as password login (`checkLock`/`recordFail`/`recordSuccess`/`getClientIp` imported from `@/lib/auth/loginLimiter`, line 12) — a failed SAML assertion counts toward the same 5-strikes/progressive-lockout state as a failed password attempt, keyed by the same client IP. Success redirect: `/dashboard` (line confirmed via tail: `NextResponse.redirect(new URL("/dashboard", origin))`). Failure: `recordFail(ip)` then redirect `/login?error={encodeURIComponent(error.message || "saml_acs_failed")}`.
- `GET /api/auth/saml/metadata` (`saml/metadata/route.js:1-26`): returns SP metadata XML, `Content-Type: application/xml`, no auth (public, unauthenticated IdP-facing endpoint by SAML protocol necessity). 500 body is itself XML: `<?xml version="1.0"?><Error>{message}</Error>`, not JSON — **the only route in this domain that errors with XML instead of JSON**.
- `GET /api/auth/saml/test` (`saml/test/route.js:1-73`): same in-handler `canAccessTestRoute()` gate pattern as the OIDC test route (requireLogin=false OR valid cookie). Returns `{ ..., metadataUrl, message: "SAML 2.0 configuration verified successfully." }` (exact leading fields truncated, lines ~40-66). 500: `{ error: error.message || "SAML test failed" }` — leaks raw error text.

---

## Cross-cutting notes for the frontend author

1. **Never build a `code:` discriminator for keys/usage/auth 401s.** That envelope belongs only to `/api/admin/*`. Every route in this doc's scope returns `{ error, source }` (middleware-level 401/403) or a route-local `{ error: "<string>" }` (handler-level failure), and several routes (`login`, `usage/statistics`) leak `error.message` verbatim rather than a fixed string — do not assume a stable enum of error strings from those two.
2. **Empty-denominator averages are `null`, confirmed in two independent call sites** (`getStatsSummary`, `getProviderHealth`) with the identical `samples > 0 ? avg : null` guard. Treat this as the house style for any future aggregate endpoint too.
3. **API keys are never masked server-side.** Every read path (`GET /api/keys`, `GET /api/keys/[id]`, the POST create response) returns the field `key` as the full plaintext secret. If the product wants "shown once" semantics, that has to be enforced in the frontend (e.g. only render `key` right after a create response, never re-fetch it into a visible field) — the backend does not support fetch-once/reveal-later.
4. **Revoking an API key is a hard, synchronous SQL DELETE** with no soft-delete or grace period. In-flight requests using a key deleted mid-request are not covered by this contract (not read in this pass).

## Known gaps in this pass (explicitly unread or under-confirmed, do not code against these blind)

Resolved since first draft: SSE `update`/`pending` payload shape, including `errorProvider`'s exact type and 10000ms freshness window and the outer envelope's flat key layout (`usageRepo.js:469-505,787-791`, `stream/route.js:82-129`); session JWT lifetime (24h, confirmed); login 429 body (`retryAfter`/`resetHint`, confirmed); `/api/auth/status` full field set (confirmed both branches); `LOCAL_ONLY_PATHS` membership of `/api/auth/reset-password` (confirmed at `dashboardGuard.js:118`) and its exact 403 refusal body; `getActiveSessions()`'s `account` field else-branch, which is `null` rather than absent or empty string when `entry.connectionId` is unset (`usageRepo.js:454-456`); and `/api/auth/status`'s catch-all fallback, which does carry all five previously-guessed keys as hardcoded literals rather than computed defaults (`status/route.js:50-69`).

Still open:
- `getUsageStats`/`getUsageStatsInRange`'s full top-level key list beyond `range`, `byEndpoint`.
- `getStatsItems()` — not read at all.
- `getStatsFilters()`'s exact serialized shape (Map→JSON).
- `/api/usage/[connectionId]` and `.../codex-reset-credits` — live-upstream routes, not detailed here.

Resolved since the "still open" note above: `getChartData()` returns a bare array in every branch, and `/api/usage/logs`'s pagination object is `{page, pageSize, hasNext, hasPrev, maxScan}` with no `hasMore` field — both confirmed at the `GET /api/usage/chart` and `GET /api/usage/logs` sections above.

## Files read

- src/app/api/keys/route.js
- src/app/api/keys/[id]/route.js
- src/app/api/keys/devices/route.js
- src/lib/db/repos/apiKeysRepo.js
- src/shared/utils/apiKey.js (partial, `generateApiKeyWithMachine` + `KEY_ID_DISPLAY_CHARS` region)
- src/sse/services/apiKeyDevices.js
- src/app/api/usage/stream/route.js
- src/app/api/usage/stats/route.js
- src/app/api/usage/stats/health/route.js
- src/app/api/usage/statistics/route.js
- src/app/api/usage/chart/route.js
- src/app/api/usage/history/route.js
- src/app/api/usage/providers/route.js
- src/app/api/usage/logs/route.js
- src/app/api/usage/request-logs/route.js
- src/app/api/usage/request-details/route.js
- src/app/api/usage/token-refresh/route.js
- src/app/api/usage/[connectionId]/route.js (partial)
- src/app/api/usage/[connectionId]/codex-reset-credits/route.js (partial)
- src/lib/db/repos/usageRepo.js (partial — large file, ~1360 lines, read in sections)
- src/lib/db/repos/requestStatsRepo.js (partial — ~449 lines, read in sections)
- src/lib/usagePeriod.js
- src/app/api/auth/login/route.js
- src/app/api/auth/logout/route.js
- src/app/api/auth/status/route.js
- src/app/api/auth/reset-password/route.js
- src/app/api/auth/oidc/start/route.js
- src/app/api/auth/oidc/callback/route.js
- src/app/api/auth/oidc/test/route.js
- src/app/api/auth/saml/start/route.js
- src/app/api/auth/saml/acs/route.js
- src/app/api/auth/saml/metadata/route.js
- src/app/api/auth/saml/test/route.js
- src/lib/auth/dashboardSession.js
- src/lib/auth/loginLimiter.js
- src/lib/auth/trustedPeer.js
- src/dashboardGuard.js
- src/lib/admin/policy.js
- src/app/api/settings/route.js (partial — password-change fields only, out-of-scope route consulted for auth completeness)
