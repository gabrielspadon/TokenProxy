# Admin / Quota / Drain API Contract

Verified against source only (`src/app/api/admin/**`, `src/lib/admin/**`, `src/lib/db/repos/quotaWindowsRepo.js`, `DESIGN.md`). No presentation code was read. Every field below is quoted or paraphrased from the exact line that builds it; conditional fields state their condition.

## Auth model (shared by every route in this domain)

Two collectors reach one verdict function, `adminDecision()` in `src/lib/admin/policy.js:51-101`: `src/dashboardGuard.js` (middleware) and `src/lib/admin/guard.js` (`requireAdmin`, called first line of every route handler below). Both feed the same four booleans so they cannot drift.

`requireAdmin(request)` — `src/lib/admin/guard.js:1-66`:
1. `authClass = adminAuthClass(pathOf(request))` — `policy.js:34-44`. `adminAuthClass` returns `'inference'` only for paths in `INFERENCE_CLASS_PATHS` (a Set built from constants near the top of `policy.js`, not itself in the admin/quota/drain domain — every route documented here is **operator class**, confirmed per-route below by absence from that set); otherwise `'operator'`.
2. `mutating = isAdminMutation(request.method)` — true for any method not in `READ_METHODS` (GET/HEAD).
3. `operator = await isOperator(request)` — CLI token (`hasValidCliToken`) or a verified dashboard session cookie (`verifyDashboardAuthToken`). Deliberately NOT satisfied by `requireLogin=false`.
4. `inference = operator ? false : await hasInferenceKey(request)` — only checked (DB round trip) when `operator` is false, via `resolveClientApiKey` + `validateApiKey`.
5. `loopback = isLocalRequest(request)`.

`adminDecision({authClass, mutating, operator, inference, loopback})` — `policy.js:51-101`, refusal order:
- `!operator`: refuse. If `inference` is true, **403** `{code:'forbidden_class', error:'An operator credential is required. An inference API key does not satisfy this endpoint.'}`. Else **401** `{code:'unauthorized', error:'An operator credential (CLI token or dashboard session) is required.'}`.
- else if `mutating && !loopback`: **403** `{code:'forbidden_loopback', error:'State-changing admin endpoints are loopback-bound. Reach them through a tunnel that terminates as a loopback peer.'}`.
- else: `null` (allowed).

Every refusal body is built by `adminError(status, code, error, extra)` (`policy.js:104-109`): `{error, code, source:'tokenproxy-admin', ...extra}`, status header `Cache-Control: no-store`. Success bodies go through `adminJson(body, status=200)` (`policy.js:111-113`), same no-store header, no envelope wrapping — the body IS the JSON returned.

**All mutating routes in this domain (`POST`/`DELETE` on drain) are loopback-bound** per the above — an operator credential alone is not sufficient for a state change from a non-loopback peer.

### Request body validation

`parseAdminBody(request, allowed)` — `policy.js:115-138` (signature per docblock at 115-126; body logic 127-138, not fully re-quoted since only `drain/[connectionId]` in this domain calls it, see below). Reads and validates the body **before any state read**, per admin-abi.md's "failure direction": wrong type or unrecognized field is 400 before drain/activation/rollback state is touched.

`invalidIfMatch(value)` — `policy.js:149-154` (renumbered in full file): `value !== undefined && typeof value !== 'string'`. `ifMatch` is optional everywhere; absent means "caller has no prior read", present-but-non-string means malformed request — two different 400 conditions.

---

## Routes

### GET /api/admin/health
`src/app/api/admin/health/route.js:17-25`

- Auth: operator class (not in `INFERENCE_CLASS_PATHS`), read method (non-mutating, loopback not required).
- Query/body: none.
- Response 200: `{status:"ok", uptimeSeconds: Math.round(process.uptime()), generatedAt: new Date().toISOString()}`.
- Deliberately shallow — touches no DB and no upstream, so it answers during a DB outage. Distinct from `health/detail`, which does the deep check.

### GET /api/admin/health/detail
`src/app/api/admin/health/detail/route.js:1-63`

- Auth: operator class, read method.
- Query/body: none.
- **Always returns 200** — the status is in the body, not the HTTP status (comment at file top explains this mirrors `/api/health` philosophy).
- Response body is exactly `{status, checks:{database, connections}}` (`adminJson({ status, checks: { database, connections } })`, `route.js:63`) — **`scanFailed` is computed internally but never appears in the returned JSON**, it only feeds the `status` calculation below.
  - `database`: built from `getAdapter()` (line 1 import) — a DB probe; on failure `database.status === "error"`.
  - `connections`: array from `getProviderConnections()` projected via `toConnection()` (see project.js section below), combined with `readAllDrainDocs()` for drain flags.
  - `scanFailed` (internal only, not returned): true if the connection scan itself threw.
  - `unhealthy = connections.some(c => c.status === "degraded" || c.status === "cooldown")`.
  - Overall `status`: `"error"` if `database.status === "error" || scanFailed`; else `"degraded"` if `unhealthy`; else `"ok"`.

### GET /api/admin/drain
`src/app/api/admin/drain/route.js:1-51`

- Auth: operator class, read method.
- Query: `all` (string) — `?all=true` includes every connection (draining or not); default (`all` absent or any other value) returns **only currently-draining connections**. Comment at file top: default answers the operator's actual question ("what is still bleeding off").
- Response 200: `{connections: [DrainState, ...]}` — one `DrainState` per connection (see shape below), built via `getProviderConnections()` joined against `readAllDrainDocs()` and mapped through `toDrainState(conn.id, docs[conn.id] ?? null)`.
- Error 500: `adminError(500, "state_unavailable", error?.message || "Drain state could not be read.")` — on any thrown error reading connections or drain docs.

### POST /api/admin/drain/{connectionId}
`src/app/api/admin/drain/[connectionId]/route.js` — start a drain.

- Auth: operator class, mutating (loopback-bound).
- Path param: `connectionId`.
- Request body: parsed via `parseAdminBody` with an `ifMatch` allowance (imports `invalidIfMatch, parseAdminBody`); malformed body or unrecognized field → 400 before any state read.
- 404 if `getProviderConnectionById(connectionId)` returns nothing: `adminError(404, "not_found", ...)`.
- **Idempotent by design**: draining an already-draining connection returns its current `DrainState` unchanged rather than erroring (comment at file top, lines 9-12) or resetting `requestedAt`.
- On a fresh drain, writes: `{isDraining: true, requestedAt: new Date().toISOString(), completedAt: null}` via `writeDrainDoc(connectionId, next)`.
- Response 200: `toDrainState(connectionId, next)`.

### DELETE /api/admin/drain/{connectionId}
Same file, same route — stop a drain.

- Auth: identical to POST (operator, mutating, loopback-bound).
- 404 if the connection does not exist (same check).
- Writes: `{isDraining: false, requestedAt: doc.requestedAt ?? null, completedAt: new Date().toISOString()}` — preserves the original `requestedAt` from the prior drain doc, only stamps `completedAt`.
- Response 200: `toDrainState(connectionId, next)`.

### DrainState shape
Built by `toDrainState(connectionId, doc)` in `src/lib/admin/state.js` (lines ~55-90):
```
{
  connectionId,
  isDraining: Boolean(doc?.isDraining),
  requestedAt: doc?.requestedAt ?? null,
  activeStreams: <live count, not from the stored doc>,
  completedAt: doc?.completedAt ?? null,
  version: versionOf(doc),
}
```
- `connectionId` — the id passed in, not read from the doc.
- `isDraining` — whether the connection is currently excluded from new-selection rotation.
- `requestedAt` — ISO timestamp of the drain request; `null` if never drained (no doc) or the doc omitted it.
- `completedAt` — ISO timestamp the drain was lifted; `null` while still draining or if never drained.
- `activeStreams` — computed from **live traffic state**, not the stored KV document. Comment in `state.js` (~line 83-86): explicitly excluded from the `version` hash because it "moves with live traffic," and including it would make every read return a different token, turning every `ifMatch` into a spurious 412.
- `version` — `versionOf(doc)` (`state.js:35`+): a content hash (not a stored counter) over the **stored document only**. Rationale in the file's top docblock: a stored counter fails open if a writer forgets to bump it; a hash cannot be forgotten and makes the ABI's `byteIdenticalOnRejection` clause directly checkable — same state, same hash.
- No drain doc on record (never drained) → `readDrainDoc` returns `null`, and `toDrainState` still returns a full object with `isDraining:false`, `requestedAt:null`, `completedAt:null`, and a `version` hash of the null/absent state — never an error, never an omitted field.

### `?all=true` semantics (drain, exact)
Without it: `GET /api/admin/drain` filters to `isDraining === true` only. With it: every configured connection is returned regardless of drain status, each still carrying its full `DrainState` (a non-draining connection reports `isDraining:false` with null `requestedAt`/`completedAt`, not an omitted entry).

---

### GET /api/admin/quota
`src/app/api/admin/quota/route.js:1-33`

- Auth: operator class, read method.
- Query/body: none.
- **One scan, not N per-connection reads** (comment, lines 12-13) — cohort question. Loads all connections via `getProviderConnections()` and all windows via `getAllWindows()` (a single query returning a `Map<connectionId, windowRow[]>`, see `quotaWindowsRepo.js` below), then joins in memory.
- Response 200 includes `{snapshots, asOf, mode:"passive", historyAvailable:false}`. One snapshot per configured connection, with an empty `windows` array when it has no stored evidence. All snapshots in the batch share the response's `asOf` time.
- Error 500 returns fixed text `Quota state could not be read.` Storage exception text is never returned.

### GET /api/admin/quota/{connectionId}
`src/app/api/admin/quota/[connectionId]/route.js:1-28`

- Auth: operator class, read method.
- Path param: `connectionId`.
- **404 is on the connection, never on the windows** (comment, line 13) — a real connection with zero recorded quota evidence returns `windows: []`, not 404. 404 only fires when `getProviderConnectionById(connectionId)` returns nothing: `adminError(404, "not_found", "No connection with id ${connectionId}.")`.
- Response 200: `toQuotaSnapshot(conn, await getWindows(connectionId))`.

### QuotaSnapshot shape
`toQuotaSnapshot(conn, windows)` in `src/lib/admin/project.js` returns the stored rows and observation metadata.
```
{ connectionId, provider, asOf, mode: "passive", historyAvailable: false, windows }
```

### WindowRecord and observation evidence

`toWindowRecord` retains each row. The pair `(connectionId, scope)` identifies a window uniquely.

- `remaining` and `limit` preserve finite nonnegative numeric values, including real zero. Missing, blank, invalid, boolean and negative values become `null`.
- `resetAt` and `observedAt` are nullable ISO timestamps. No epoch fallback or future reset is synthesized. `resetState` is `passed`, `upcoming` or `unknown`; `resetSemantics` is `stored-deadline` or `unknown`.
- `source` is `quotaWindows` for current quota rows and `stored-quota-evidence` for legacy receipt/qualification projections. The store retains no unit, so `unit` is `null`. `scale` is `absolute` for measured rows and `unknown` otherwise. Unknown-confidence rows may have a synthetic denominator of 100; that number does not establish a quota unit.
- `confidence` describes recorded provenance. Stored `fresh`, `stale` and `measured` map to `measured`; `estimated` remains `estimated`; other values become `unknown`. An old measurement remains a measurement.
- `freshness` contains `state`, nullable `ageMs`, `maxAgeMs:900000` and `basis:"stored-observation-age-and-deadline"`. A missing/future observation is unknown; age over 15 minutes or a passed reset is stale. This GET never refreshes a provider. Identical observations may be deduplicated by the writer, so the stored timestamp can lag the most recent unchanged response.
- `durationMs` is inferred only from explicit fixed minute/hour/day/week durations in parentheses, with `durationSource:"scope-label"`. Bare monthly/yearly names and calendar durations remain unknown. `windowType` is `general`, `scoped` or `unknown`, classified by the local ranker vocabulary and labelled with `windowTypeSource:"scope-label"`.
- `percentage` is independently joined from `connection.lastQuotaSnapshot` by exact scope. It is either `null` or `{value, unit:"percent", source:"connection.lastQuotaSnapshot", measurement:"derived-percentage", observedAt, resetAt, freshness}`. Its timestamp and scale are independent of the quota row. No percentage is inferred from `remaining/limit`, and no snapshot-only rows are added.

These fields describe current stored evidence. There is no quota history to chart and no assertion that a past reset replenished the provider account.

### GET /api/admin/eligibility

Operator-only passive batch read with required `provider` and `model` query parameters. Provider aliases normalize to canonical ids; the model is the exact provider-local identifier. Every configured account appears, including accounts belonging to other providers.

The response contains `asOf`, `mode:"passive"`, `requested:{provider,model,routePrefix}`, `basis:"persisted-local-gates"`, `upstreamVerified:false`, `limitations`, `capabilities` and `accounts`. `routePrefix` retains the submitted provider prefix because the existing model-disable gate checks that exact prefix before alias normalization.

Each account contains `connectionId`, `provider`, `verdict`, `localAdmission`, `reasons`, `enabled`, `draining`, `cooldownUntil`, `legacyCooldownUntil`, `modelSupport`, `qualification` and `quotaEvidence`.

- `verdict` is `blocked` when persisted gates reject selection, `admissible` when gates allow selection and the explicit account allowlist includes the model, or `unknown` when account-specific model support is absent. `localAdmission` separately reports `allowed` or `blocked`. Admissible never guarantees upstream service.
- `reasons` contains fixed safe labels and `{code,source,observedAt,until,effect}` evidence, with `effect` equal to `blocks-selection` or `context`. Gates cover account disablement, provider mismatch, draining, explicit model exclusions, active model/account locks, recorded quota thresholds and the real local quota ranker. The provider-disable switch is enforced only for no-auth providers; authenticated-provider flags and per-account model-list hides are contextual notes. Legacy cooldown is display context, not an independent routing gate.
- `modelSupport.status` is `configured`, `excluded` or `unknown`, sourced from the account's nonempty `providerSpecificData.enabledModels` allowlist. No dedicated timestamp or upstream verification exists for that setting, so `observedAt` is null and `upstreamVerified` is false.
- `qualification` is a recorded `credential-check`, with `passed`, `failed` or `unknown` status and a nullable observed time. `modelSupportVerified` is always false. The current probe implementation may check only token presence or expiry, or accept a deliberately invalid request. Its default-model label cannot prove generation support.
- `quotaEvidence` retains projected windows plus window count and percentage observation time. Capability values come from `routing-capability-resolver`, including defaults, and are explicitly upstream-unverified.

No account selection, reservation, discovery, provider contact or refresh occurs. In-memory quota, proxy readiness and request-specific constraints may change actual routing. A failed read returns a sanitized 500; missing/invalid query identifiers return 400 before state reads. Responses use `Cache-Control: no-store`.

### quotaWindowsRepo.js — the underlying store
`src/lib/db/repos/quotaWindowsRepo.js:1-104`. One row per `(connectionId, scope)`, unique-keyed (`ON CONFLICT(connectionId, scope) DO UPDATE`). Columns: `connectionId, scope, remaining, "limit"` (quoted — SQLite keyword), `resetAt, observedAt, confidence`. `rowToWindow(row)` (lines 15-23) returns the raw row **as-is, with no repair** — comment at lines 11-14: *"A row whose numbers did not survive the round trip (a NULL limit, a text remaining) is returned as-is rather than repaired: `normalizeAccountWindows` is the single authority on what a usable window is, and a repair here would hide bad evidence from it."* `normalizeAccountWindows` lives outside this domain's scope (not under `src/app/api/admin` or an admin lib file) and was not opened. `getAllWindows()` returns a `Map<connectionId, windowRow[]>` in one query; `getWindows(connectionId)` filters to one connection.

---

### GET /api/admin/qualification
`src/app/api/admin/qualification/route.js`

- Auth: operator class, read method.
- **Passive** — reports what the last probe established; starts no new probe (comment, line 13).
- Response 200: `{connections: [...]}`, each built from `getProviderConnections()` joined with `readAllDrainDocs()` for the `isDraining` flag folded into status precedence.
- Error 500: `adminError(500, "state_unavailable", ...)`.

### GET /api/admin/qualification/{connectionId}
`src/app/api/admin/qualification/[connectionId]/route.js`

- Auth: operator class, read method.
- 404 if connection not found.
- Reads `readDrainDoc`, `readQualification` (last probe result), `getWindows` in parallel (`Promise.all`), assembles via `qualificationDetail({conn, drain, probe, windows})`.

### POST /api/admin/qualification/{connectionId}/recheck
`src/app/api/admin/qualification/[connectionId]/recheck/route.js`

- Auth: operator class, mutating (loopback-bound).
- Deduplicates concurrent credential checks via the process-local `beginRecheck`/`endRecheck` set. This guard is not durable across restarts or multiple processes.
- Runs provider-specific `testSingleConnection`, stores its result with a `getDefaultModel()` label, then re-reads stored quota rows. The check may contact providers or rotate tokens but does not universally generate against that labelled model or refresh quota.

### QualificationDetail shape
`qualificationDetail(...)` — `src/lib/admin/qualification.js`:
```
{
  connectionId, provider,
  status,                              // connectionStatus(conn, {isDraining, now}); "error" when the last probe itself failed
  checkedAt,                           // probe.checkedAt ?? conn.lastErrorAt ?? conn.updatedAt ?? null
  generation: {
    ok: probe ? Boolean(probe.ok) : conn.testStatus === "active",   // legacy credential-check/status result
    model: probe?.model ?? null,
    latencyMs: Number.isFinite(probe?.latencyMs) ? probe.latencyMs : null,
    error: redactError(probe?.error ?? conn.lastError),
  },
  quota: toWindowRecords(windows),
}
```
`displayName`, `isActive`, `isDraining`, `lastQualifiedAt` and `lastError` are not on this object (verified against `src/lib/admin/qualification.js:12-32`); read them from the list route's `toConnection` projection.

The legacy `generation` field name and earlier source comments overstate this evidence. A true `ok` may represent a token presence/expiry check or default active status. Use the new eligibility projection's explicit credential-check and model-support fields when presenting account/model evidence.

---

### toConnection projection (shared by health/detail, drain default listing input, and qualification)
`src/lib/admin/project.js:87-98`:
```
{
  connectionId: conn.id,
  provider: conn.provider,
  displayName: typeof conn.name === "string" && conn.name ? conn.name : null,
  status: connectionStatus(conn, {isDraining, now}),
  isActive: Boolean(conn.isActive),
  isDraining: Boolean(isDraining),
  lastQualifiedAt: isoOrNull(conn.lastTestedAt) ?? isoOrNull(conn.updatedAt),
  lastError: redactError(conn.lastError),
}
```

### connectionStatus — the precedence order (source of DESIGN.md's "gap")
`connectionStatus(conn, {isDraining, now})` — `project.js:76-84`:
```js
if (isDraining) return "drained";
if (!conn?.isActive) return "unqualified";
const until = conn.rateLimitedUntil ? Date.parse(conn.rateLimitedUntil) : NaN;
if (Number.isFinite(until) && until > now) return "cooldown";
if (isConnectionDegraded(conn, now)) return "degraded";
if (!conn.testStatus) return "unqualified";
return "healthy";
```
Four inputs decide this string, in this exact precedence: draining outranks everything (operator's explicit decision), then active/inactive, then rate-limit window, then degraded-probe state, then never-probed. This is exactly the "four inputs" DESIGN.md's gap section references (see below).

### `redactError` — what error text ships
`project.js:64-67`: truncates to 300 chars and strips anything matching `CREDENTIAL_SHAPED` (`/\b(?:sk|pk|api|key|token|bearer|secret)[-_a-z0-9]*[-_ :=]+[A-Za-z0-9._~+/-]{8,}/gi`) to `"[redacted]"`. Applied to `lastError` on every connection projection and to the qualification `generation.error`. Returns `null` for non-string/empty input.

---

## Operator-facing semantics (from DESIGN.md, cross-checked against code above)

- **Quotas are absolute units, never cross-window percentages.** Confirmed both by the repo comment (`quotaWindowsRepo.js:11`, "Written and read as absolute units") and by `toWindowRecord`'s `remaining`/`limit` fields, which carry raw numbers with no ratio computed anywhere in this domain's code.
- **A failed quota lookup is NOT "up to date."** `confidence:"unknown"` and the epoch-fallback timestamps (`resetAt`/`observedAt` defaulting to `1970-01-01T00:00:00.000Z`) exist specifically so a caller can distinguish real evidence from absence — but only by reading the `confidence` field and/or noticing the epoch sentinel; the numeric `remaining`/`limit` fields alone give no such signal (both silently `0`).
- **Absent vs zero**: a connection with no rows in `quotaWindows` returns `windows: []` (absent, both quota routes) — this is the honest "no evidence" case. A row that exists but whose `remaining`/`limit` failed to parse also becomes `0` via `num()`'s finite-check fallback — this is indistinguishable at the wire from a legitimately exhausted window. DESIGN.md (lines 270-277, `## 3` cohort-ranking section, not fully quoted here as it's ranking logic outside this domain's routes) independently states: *"measured evidence always outranks estimated or unknown evidence for the same window"* and *"an account with any window currently at its limit is excluded from ranking outright"* — meaning a defaulted `0`/`0` under `unknown` confidence would, per that ranking rule, still get read as "at its limit" by a naive downstream consumer that doesn't check `confidence` first. Nothing in the admin ABI wire shape forces a consumer to check it.

### DESIGN.md's gap section (verbatim facts, not paraphrased away)
`DESIGN.md:1426-1452`, "## A gap in the current system":

> Two facts the gateway acts on every time it routes are not reported by any operator-readable field today.

1. `connectionStatus`'s four inputs (draining / active / rate-limit window / degraded probe state — exactly the four branches quoted above from `project.js:76-84`) do not include a fifth real gating condition the gateway also checks when routing: **per-window auto-pause**. DESIGN.md §2 (lines 286-289, "Configure per-window auto-pause thresholds") describes operator-configurable auto-pause thresholds per quota window ("consecutive failures... until the underlying condition recovers"); a connection can be skipped by the router because one of its quota windows crossed its configured auto-pause threshold, and **this skip is invisible in `status`** — it is not one of the five `connectionStatus` branches and no field in `DrainState`, `Connection`, or `QuotaSnapshot` reports it.
2. The account-level health status remains connection-scoped. The passive eligibility route now exposes active locks for a requested model, with safe reasons and expiry times; it does not return unrestricted stored failure text or every model's lock metadata.

DESIGN.md's own closing line: *"Closing either gap is a change to the gateway, not to the experience built over it. Until they are closed, a person is reading a status that is truthful about four things and silent about two."* This doc does not paper over that — no field for auto-pause-skip or per-model-lockout exists anywhere in `src/app/api/admin/**` or `src/lib/admin/**` as read for this contract.

---

## Files read

- /home/spadon/Codebases/tokenproxy/src/app/api/admin/health/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/health/detail/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/drain/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/drain/[connectionId]/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/quota/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/quota/[connectionId]/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/qualification/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/qualification/[connectionId]/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/qualification/[connectionId]/recheck/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/receipts/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/receipts/[receiptId]/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/activation/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/rollback/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/admin/models/route.js
- /home/spadon/Codebases/tokenproxy/src/lib/admin/policy.js
- /home/spadon/Codebases/tokenproxy/src/lib/admin/guard.js
- /home/spadon/Codebases/tokenproxy/src/lib/admin/state.js
- /home/spadon/Codebases/tokenproxy/src/lib/admin/project.js
- /home/spadon/Codebases/tokenproxy/src/lib/admin/qualification.js
- /home/spadon/Codebases/tokenproxy/src/lib/admin/receipts.js
- /home/spadon/Codebases/tokenproxy/src/lib/db/repos/quotaWindowsRepo.js
- /home/spadon/Codebases/tokenproxy/DESIGN.md
