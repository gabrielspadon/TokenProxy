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
- Response body: `{status, checks:{database, connections}}`.
  - `database`: built from `getAdapter()` (line 1 import) — a DB probe; on failure `database.status === "error"`.
  - `connections`: array from `getProviderConnections()` projected via `toConnection()` (see project.js section below), combined with `readAllDrainDocs()` for drain flags.
  - `scanFailed`: true if the connection scan itself threw.
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
- Response 200: `{snapshots: [QuotaSnapshot, ...]}` — one per connection via `toQuotaSnapshot(conn, byConnection.get(conn.id) ?? [])`. A connection with no rows in the map gets an **empty `windows` array**, not an omitted snapshot.
- Error 500: `adminError(500, "state_unavailable", error?.message || "Quota state could not be read.")`.

### GET /api/admin/quota/{connectionId}
`src/app/api/admin/quota/[connectionId]/route.js:1-28`

- Auth: operator class, read method.
- Path param: `connectionId`.
- **404 is on the connection, never on the windows** (comment, line 13) — a real connection with zero recorded quota evidence returns `windows: []`, not 404. 404 only fires when `getProviderConnectionById(connectionId)` returns nothing: `adminError(404, "not_found", "No connection with id ${connectionId}.")`.
- Response 200: `toQuotaSnapshot(conn, await getWindows(connectionId))`.

### QuotaSnapshot shape
`toQuotaSnapshot(conn, windows)` — `src/lib/admin/project.js:100-102`:
```
{ connectionId: conn.id, provider: conn.provider, windows: toWindowRecords(windows) }
```

### WindowRecord shape (the quota unit itself)
`toWindowRecord(row)` — `src/lib/admin/project.js:38-47`. **Every field is required in the output; a row missing a field is completed, never dropped**, per the comment directly above it (lines 35-37): *"an absent window reads to a ranker as an account with fewer constraints, which ranks it ABOVE accounts that reported honestly."* This is a documented anti-corruption stance, stated here rather than papered over:
```
{
  scope: String(row?.scope ?? ""),
  remaining: num(row?.remaining),          // Number(value), else 0 if not finite
  limit: num(row?.limit),                  // Number(value), else 0 if not finite
  resetAt: isoOrNull(row?.resetAt) ?? new Date(0).toISOString(),
  observedAt: isoOrNull(row?.observedAt) ?? new Date(0).toISOString(),
  confidence: CONFIDENCE[row?.confidence] ?? "unknown",
}
```
- `scope` — the window's identity string (e.g. which quota bucket/model group this is), coerced to `""` if absent, never `null`.
- `remaining`, `limit` — **absolute units, not a percentage**, per the repo-level comment in `quotaWindowsRepo.js` ("Written and read as absolute units") and per the task's operator-semantics requirement. A non-finite/missing value silently becomes `0`, which reads as "zero remaining, zero limit" — indistinguishable at the wire level from a genuinely exhausted, zero-limit window. **A caller cannot tell "no data" from "confirmed zero" from these two fields alone.**
- `resetAt` — ISO timestamp of when the window replenishes. Falls back to the Unix epoch (`new Date(0).toISOString()`, i.e. `1970-01-01T00:00:00.000Z`) if the row's value is missing or unparseable. **The epoch fallback is itself a defaulted "no data" signal disguised as a real past timestamp** — nothing in the wire shape flags it as synthetic.
- `observedAt` — ISO timestamp of when this evidence was last read from the provider. Same epoch-fallback behavior as `resetAt`.
- `confidence` — one of `"measured"`, `"estimated"`, `"unknown"`. Mapping (`CONFIDENCE` const, `project.js:22`): store-side `"fresh"` or `"measured"` → `"measured"`; store-side `"stale"` or `"estimated"` → `"estimated"`; anything else (including missing) → `"unknown"`. Per the comment directly above the const (lines 16-21): the store speaks freshness (fresh/stale/unknown), the ABI speaks provenance (measured/estimated/unknown) — evidence read fresh from a provider response IS "measured"; evidence carried forward past its observation window IS "estimated"; anything else is `"unknown"`, which is the deliberately safe default because **"unknown" evidence must never be allowed to outrank known evidence when the scheduler ranks accounts** (rule referenced in the comment).

### Confidence — what a failed quota lookup means
A `confidence:"unknown"` (or a row that never existed, yielding `windows: []`) does **not** mean "up to date" or "no constraint." It means the gateway has no trustworthy reading and is reporting that absence honestly via the confidence field (or the empty array) rather than fabricating a value. `remaining`/`limit` being `0` under `"unknown"` confidence is the read-as-exhausted trap described above — the wire shape gives no separate boolean for "this row is synthetic/defaulted."

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
- Guards against a double-click spending two real generations via `beginRecheck`/`endRecheck` — a process-local `Set` of in-flight connection ids (`state.js`, `beginRecheck`/`endRecheck`, lines ~243-251). Comment: *"Process-local on purpose. This exists to stop one operator's double-click from spending two real generations."* Not durable across restarts or multi-process deployments — an explicit, named limitation.
- Runs `testSingleConnection` (from `src/app/api/providers/[id]/test/testUtils`) against `getDefaultModel()`, writes the probe result via `writeQualification`, then re-reads `getWindows(connectionId).catch(() => [])` (quota re-read is best-effort — a failure here does not fail the recheck) and returns `qualificationDetail({conn, drain, probe, windows})`.

### QualificationDetail shape
`qualificationDetail(...)` — `src/lib/admin/qualification.js`:
```
{
  connectionId, provider, displayName, status, isActive, isDraining,
  lastQualifiedAt, lastError,          // via toConnection(conn, {isDraining, now})
  generation: {
    ok: Boolean(probe?...),            // whether the real completion succeeded
    model: probe?.model ?? null,
    latencyMs: Number.isFinite(probe?.latencyMs) ? probe.latencyMs : null,
    error: redactError(probe?.error ?? conn.lastError),
  },
  quota: toWindowRecords(windows),
}
```
Comment at file top: `generation` is "the ABI's credential-safe evidence: whether a real completion succeeded, against which model, how long it took, and a redacted reason if not. Never the generated content, and never the probe's request or response body."

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
2. **Per-model lockout is not exposed.** DESIGN.md (context around lines 1299-1340, the lockout/backoff section) describes a lockout mechanism that escalates through progressively longer intervals and can apply per-model, not just per-connection. The admin ABI's `lastError`/`generation.error` fields are free text (redacted, truncated) and the connection-level status is connection-scoped only — **nothing in this domain's routes exposes a per-model lock list.**

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
