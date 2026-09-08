# Shaping / RTK / Inspector backend API contract

Scope: request-shaping config (system-prompt injection, RTK token-saver, tool
disclosure) and request-log/inspector capability. Verified against source
only — no field below is inferred.

## Auth model (from `src/dashboardGuard.js` + `src/lib/admin/policy.js`)

None of the routes in this scope sit under the admin ABI prefix
(`isAdminPath`/`adminAuthClass`/`adminDecision` from `src/lib/admin/policy.js`
gate `/api/admin/*` only — grep confirms no admin-policy import anywhere
under `src/app/api/token-saver`, `src/app/api/tool-disclosure`,
or `src/app/api/settings`). All routes below are
gated purely by `dashboardGuard.js`'s session/API-key layer, which never
returns `{code:'forbidden_class'}` or `{code:'forbidden_loopback'}` — those
shapes are admin-ABI-only and out of scope here.

- `/api/token-saver/stats` and `/api/tool-disclosure/stats` are **not** in
  `PROTECTED_API_PATHS`, `ALWAYS_PROTECTED`, `PUBLIC_API_PATHS`, or
  `PUBLIC_PREFIXES` (checked all four arrays, `src/dashboardGuard.js:39-106`).
  Unmatched `/api/*` paths fall through to the same default protected branch
  (`src/dashboardGuard.js:351-354`) — same 401 shape as above.
- `/api/settings` (GET/PATCH, carries every RTK/caveman/ponytail/pxpipe/headroom
  toggle) is also in `PROTECTED_API_PATHS` (`src/dashboardGuard.js:89`), but
  writes get a STRICTER pre-gate than the generic protected-path check: for
  any non-GET/HEAD/OPTIONS method on exactly `/api/settings`, the request is
  rejected UNLESS it has a valid CLI token, a valid session token, or is a
  loopback request (`isLocalRequest`) — `requireLogin:false` does NOT bypass
  this check (`src/dashboardGuard.js:334-349`). Rationale in-code: settings
  writes configure SSO/proxy instance-wide, so a remote caller must
  never reach them just because `requireLogin` is off (reads keep the
  `requireLogin:false` bypass). Refusal: `{ error: "Unauthorized", source: GATEWAY_ERROR_SOURCE }`, HTTP 401 (`src/dashboardGuard.js:347`).
- No route in this scope issues a 403 of any kind. `forbidden_class` /
  `forbidden_loopback` are admin-ABI-only shapes (`src/lib/admin/policy.js`)
  never reached by this domain.

## (a) RTK token-saver surface — `open-sse/rtk/**`

The engine runs in `open-sse/handlers/chatCore.js` after format translation
and before optional Headroom compression. `translateRequest` does not run RTK.
The only HTTP surface is the read-only stats route below plus the
enable/level toggles that live on `/api/settings` (section (b)).

### What it compresses

`open-sse/rtk/index.js` stages tool-result replacements on the privately owned
attempt body and commits them only after every replacement is ready. Safe mode
uses `jsonCompact`, which removes only insignificant JSON whitespace while
preserving string bytes, numeric lexemes, duplicate keys and escaping. General
text remains unchanged. Explicit lossy opt-in enables the legacy filters below,
resolved through `open-sse/rtk/registry.js`:
`gitDiff`, `gitStatus`, `gitLog`, `grep` (alias `rg`), `find` (alias `fd`),
`dedupLog`, `ls`, `tree`, `smartTruncate`, `readNumbered`, `searchList`,
`buildOutput` — the exact `FILTERS` name constants are in
`open-sse/rtk/constants.js:10-60` (`GREP`, `FIND`, `LS`, `TREE`, `DEDUP_LOG`,
`SMART_TRUNCATE`, `READ_NUMBERED`, `SEARCH_LIST`, `BUILD_OUTPUT`, plus
git-diff/status/log).

Sizing knobs (`open-sse/rtk/constants.js:1-8`, code constants not settings):
`RAW_CAP` 10 MiB, `MIN_COMPRESS_SIZE` 500 bytes (tiny blobs skipped),
`DETECT_WINDOW` 1024 chars (autodetect peek), `GIT_DIFF_HUNK_MAX_LINES` 100,
`GIT_DIFF_CONTEXT_KEEP` 3, `GIT_LOG_MAX_LINES` 200, `DEDUP_LINE_MAX` 2000.
None of these are settings-DB-backed or exposed through any API route — they
are hardcoded module constants.

### Fail-open contract

`open-sse/rtk/index.js:7-10`: compressing a `tool_result` returns stats or
`null` if disabled/failed — any internal error is swallowed and the body is
returned untouched. A result carrying `is_error`/`status:"error"` is skipped
outright (never compressed) so failure traces are preserved verbatim — this
is a deliberate exclusion, not a bug.

### Config knobs an API route exposes

RTK uses `rtkEnabled` (default `true`) plus the independent `rtkAllowLossy`
consent flag through generic `/api/settings` GET/PATCH. An absent consent flag
has effective value `false`; it may be absent from GET because the defaults
object does not materialize all four new consent fields. No dedicated
`/api/rtk/*` or per-filter settings route exists. Existing enable settings remain
stored, but enabling RTK alone no longer authorizes irreversible elision.

A combo (multi-model fallback chain) can override `rtkEnabled` (and the
sibling flags below) per-combo via `settings.comboStrategies[<combo>]`,
resolved by `resolveComboTokenSaver()` (`open-sse/services/combo.js:505-518`,
doc comment at `:495-504`). This is settings-JSON shape, not a separate route
— it rides inside the same `/api/settings` PATCH body.

### `GET /api/token-saver/stats` — `src/app/api/token-saver/stats/route.js:7`

Read-only aggregate stats for RTK + pxpipe (headroom stats are NOT included
here — headroom has its own `/api/headroom/*` routes, out of scope for this
doc since it's a separate compression engine, not RTK).

- Auth: session/API-key per dashboardGuard default-protected fallback (see
  Auth model above) — 401 `{ error: "Unauthorized", source: GATEWAY_ERROR_SOURCE }` if unauthenticated and `requireLogin` is not `false`.
- Query params (`route.js:9-12`): `sinceMs`, `timelineDays`, `recentLimit` —
  all optional, parsed with `Number.isFinite` guards (exact validation not
  fully re-read past line 12; params are passed through to
  `getTokenSaverStats()` / `getPxpipeStats()`).
- Response body: merges `getTokenSaverStats()` (`src/lib/tokenSaver/events.js`)
  and `getPxpipeStats()` (`src/lib/pxpipe/events.js`) — both return
  `{ windows, timeline, recent }` shapes (`src/lib/tokenSaver/events.js:252-256`,
  `src/lib/pxpipe/events.js:120-125`). Units are never mixed per the module
  event schema: historical `chars*` fields remain legacy JavaScript-character
  measurements. Current RTK module `bytesBefore`/`bytesAfter` and pipeline stage
  deltas measure UTF-8 bytes; they must not be relabeled as legacy characters.
  Headroom token counts are proxy reports with independent body-byte checks.
  PXPIPE token counts are estimates (suffixed `Est` upstream). No prompt/message/tool/identity/format/reason
  text is ever persisted to disk — strict allowlist, unknown fields silently
  dropped (`src/lib/tokenSaver/events.js:9-10`).
- Error response: `{ error: "token saver statistics unavailable" }`, HTTP 503,
  `Cache-Control: no-store` (`route.js:73-76`).
- `export const dynamic = "force-dynamic"` (`route.js:5`) — never cached.

### `GET /api/tool-disclosure/stats` — `src/app/api/tool-disclosure/stats/route.js:6`

Progressive tool disclosure (BM25 per-turn tool selection,
`open-sse/utils/toolDisclosure.js:1-10`) is a sibling shaping feature to RTK,
not RTK itself, documented here because it shares the auth/exposure pattern.

- Auth: same default-protected fallback as above (not in any dashboardGuard
  array).
- No query params — `GET()` takes no `request` argument (`route.js:6`).
- Response: `getRecentStats()` return value verbatim
  (`open-sse/utils/toolDisclosure.js:250-252`, an array — `_recentStats.slice()`).
  No error handling in the route (`route.js:1-8`) — an internal throw
  surfaces as Next's default 500, not a route-authored error body.
- Enable/config flags (`src/lib/db/repos/settingsRepo.js:128-132`):
  `toolDisclosureEnabled` (false), `toolDisclosureFilterEnabled` (false),
  `toolDisclosureMaxTools` (20), `toolDisclosureExcludeServers` ([]),
  `toolDisclosureExcludeTools` ([]) — all via generic `/api/settings`, no
  dedicated route.

## (b) Request-shaping config routes

**No dedicated shaping-config route exists.** System-prompt injection
(caveman/ponytail personas) and every RTK-adjacent toggle are plain fields on
the single global settings object, read/written only through
`GET/PATCH /api/settings` (`src/app/api/settings/route.js`). Confirmed by
`grep` across `src/app/api` for `systemPrompt|injectSystemPrompt|ponytailLevel|cavemanLevel` — zero hits outside `src/lib/db` and `open-sse/rtk`.

### `GET /api/settings` — `src/app/api/settings/route.js:105`

Returns `toSafeSettings(settings)` (`route.js:92-103`, strips `password` and
`oidcClientSecret`, adds computed `oidcConfigured` boolean) spread with:
- `enableRequestLogs`: `process.env.ENABLE_REQUEST_LOGS === "true"` (`route.js:110`, env-only, not DB-backed)
- `enableTranslator`: `process.env.ENABLE_TRANSLATOR === "true"` (`route.js:111`, env-only, not DB-backed — this flag exists but nothing in `dashboardGuard.js` or any translator route currently reads it to gate access; the translator routes are reachable whenever the dashboardGuard session check passes regardless of this flag's value)
- an auto-ping provider list (unrelated to this domain, not detailed here)

Relevant settings-DB keys returned inside `safeSettings`
(defaults from `src/lib/db/repos/settingsRepo.js:69-90`):
| key | default | purpose |
|---|---|---|
| `rtkEnabled` | `true` | RTK tool-result compression on/off |
| `headroomEnabled` | `false` | headroom compression engine on/off (sibling, not RTK) |
| `headroomUrl` | `http://localhost:8787` | headroom proxy target |
| `headroomCompressUserMessages` | `false` | additional permission for historical user text; current request stays exact |
| `headroomTimeoutMs` | `null` | null = defer to headroom.js's own default |
| `headroomLossless` | `false` | legacy stored field; does not grant or replace lossy consent |
| `cavemanEnabled` | `false` | system-prompt persona injection on/off |
| `cavemanLevel` | `"full"` | selects `CAVEMAN_PROMPTS[level]` (`open-sse/rtk/cavemanPrompts.js`) |
| `ponytailEnabled` | `false` | system-prompt persona injection on/off |
| `ponytailLevel` | `"full"` | selects `PONYTAIL_PROMPTS[level]` (`open-sse/rtk/ponytailPrompt.js:4-8`, levels `lite`/`full`/`ultra`) |
| `pxpipeEnabled` | `false` | render bulky Claude-format context as dense PNGs |
| `pxpipeAutoInstall` | `true` | |
| `pxpipeMinChars` | `25000` | profitability gate before pxpipe engages |
| `pxpipeTimeoutMs` | `15000` | |
| `toolDisclosureEnabled` | `false` | see (a) above |
| `toolDisclosureFilterEnabled` | `false` | |
| `toolDisclosureMaxTools` | `20` | |
| `toolDisclosureExcludeServers` | `[]` | |
| `toolDisclosureExcludeTools` | `[]` | |

- Error response: `{ error: error.message }`, HTTP 500 (route.js, catch block near line 118-121, exact text not fully re-read).

### `PATCH /api/settings` — `src/app/api/settings/route.js:123`

Gated by the stricter CLI-token/session-token/loopback check described in
Auth model above (`src/dashboardGuard.js:334-349`) — `requireLogin:false`
does not open this write path to a remote caller.

Generic merge-PATCH over the settings object (no schema enumeration of every
accepted key was performed — this doc reports only the request-shaping-domain
validation actually read):
- `providerStrategyPatch` body shape is mutually exclusive with all other
  keys — `{ error: "providerStrategyPatch cannot be combined with other settings" }`, HTTP 400, if `Object.keys(body).length !== 1` while this key is present (`route.js:135-139`).
- `connectTimeoutMs`, when present, must pass `isValidConnectTimeoutMs()` —
  `{ error: "connectTimeoutMs must be an integer from 1000 through 120000" }`, HTTP 400 (`route.js:178-183`, unrelated to shaping but same route).
- No caveman/ponytail/rtk/pxpipe-specific validation was found in the PATCH
  body beyond the generic merge — level strings are not validated against
  the known `lite|full|ultra` set at this layer (a bad level would simply
  fail to match a key in `CAVEMAN_PROMPTS`/`PONYTAIL_PROMPTS` at injection
  time inside `open-sse/rtk/caveman.js` / `ponytail.js`).
- Success response: `toSafeSettings(settings)` (post-update), HTTP 200,
  headers `SETTINGS_RESPONSE_HEADERS` (constant not further inspected).
- Error response: `{ error: error.message }`, HTTP 500 (`route.js:326-329`).

### Explicit content-loss consent

The dispatch boundary reads `rtkAllowLossy`, `schemaAllowLossy`,
`headroomAllowLossy` and `pxpipeAllowLossy` with `=== true` in
`src/sse/handlers/chat.js`. Only literal JSON boolean `true` authorizes their
respective lossy behavior. Missing values, strings, numbers and `null` do not.
The generic settings PATCH currently retains unknown keys and does not reject
wrong types for these four fields; successful storage is not proof that a flag
became effective. Client request-body fields and combo enable switches cannot
grant this consent. The shaping UI asks for explicit confirmation and labels
content-changing modes; API operators can deliberately persist boolean `true`.

RTK legacy elision and schema annotation removal are irreversible. Headroom
with lossy consent may rewrite historical text, subject to the separate user-text
setting and structural validator. It must retain the latest human request,
system/developer instructions, tool-call identity, error evidence, native
metadata and signed reasoning. Lossless Headroom mode permits only validated
lexical JSON reductions in eligible tool-result payloads. PXPIPE requires lossy
consent even when enabled and validates the current request, tool evidence and
signed reasoning before committing visual conversion. Its profitability counts
are estimates, not provider-billed savings or quality guarantees.

The four flags do not cover every content-changing feature. Existing explicit
pair dropping, query-aware compression, historical reasoning removal, tool
selection and memory compaction keep their own settings and risk classifications.
Turning a feature off cannot restore text already omitted from a sent request.
The local MCP bridge has no output-compaction option and now forwards tool
content intact; it is validated separately from the 14-toggle chat matrix.

### Per-combo override (not a route — settings-JSON shape)

`resolveComboTokenSaver(comboChain, settings)` (`open-sse/services/combo.js:505-518`)
lets a combo's entry in `settings.comboStrategies[<combo>]` override
`rtkEnabled`/`headroomEnabled`/`cavemanEnabled`/`ponytailEnabled`/`pxpipeEnabled`
per-combo: `override.enabled === false` forces all five off; any individually
named boolean key overrides its matching global flag in either direction.
This travels inside the same `/api/settings` PATCH body, under
`comboStrategies` — no separate endpoint.

## (c) Inspector / request-log / debug surface

**`appendRequestLog()` is confirmed a no-op**: `src/lib/db/repos/usageRepo.js:1211`
is `export async function appendRequestLog() {}` — empty body, does nothing.
Nothing writes a request log through this function.

### What is GONE

- Per-request raw log file (`log.txt` per CLAUDE.md) — gone, nothing writes it.
- `appendRequestLog` as a working capability — gone (empty function).

### What remains live

- **`GET /api/usage/logs`** (`src/app/api/usage/logs/route.js:4`) — calls
  `getRecentLogs(200)` from `@/lib/usageDb` (re-export shim over
  `src/lib/db/repos/usageRepo.js:1213`). Returns the array directly (not
  wrapped), HTTP 200. Error: `{ error: "Failed to fetch logs" }`, HTTP 500
  (`route.js:11`). This reads `usageHistory`-derived rows (cost/token
  aggregates written by `saveUsageStats`, not the dead `appendRequestLog`
  path) — it is a usage/cost log, not a raw request-body inspector.
- **`GET /api/usage/request-logs`** (`src/app/api/usage/request-logs/route.js`)
  — paginated wrapper over the same `getRecentLogs()`. Query params:
  `page` (drives an offset into a capped prefix scan). Ceiling constants:
  `DEFAULT_PAGE_SIZE` 200, `MAX_PAGE_SIZE` 500, and a `MAX_SCAN` cap
  (comment at `route.js:7-11` explains this bounds an otherwise-unbounded
  `?page=100000` prefix scan against `getRecentLogs`, which takes a LIMIT
  and no OFFSET). Response includes `hasMore` (boolean, `page > 1`
  reference at `route.js:55` — exact full shape not fully re-read past
  line 58) and `maxScan` in a meta object.
- **`GET /api/usage/request-details`** (`src/app/api/usage/request-details/route.js:1`)
  — the actual full-body request/response inspector. Gated additionally by
  `isObservabilityEnabled()` (`src/lib/requestDetailsDb.js` re-export from
  `src/lib/db/repos/requestDetailsRepo.js`), which resolves from settings
  with a 5s cache TTL (`CONFIG_CACHE_TTL_MS`, `requestDetailsRepo.js:10`) and
  also honors the legacy env override `ENABLE_REQUEST_LOGS`
  (`requestDetailsRepo.js:33,48`, `explicitEnvFlag`). Persisted rows go
  through `saveRequestDetail()` (`requestDetailsRepo.js`, backed by
  `getAdapter()`/SQLite) — bodies are stored redacted:
  `redactSecrets`/`stripSensitiveHeaders` from `open-sse/utils/redact.js`
  strip secrets at write time, and the route additionally redacts on read
  (`redactSecrets`, `redactSecretsText`, `route.js:4`, `MAX_ERROR_CHARS` 2000
  cap on upstream error text since a provider can echo request fragments
  back in its error message, `route.js:6-8`).
- **`open-sse/utils/requestLogger.js`** — a separate 267-line module still
  live (`LOGGING_ENABLED` env-gated by `ENABLE_REQUEST_LOGS`,
  `requestLogger.js:7`), batches writes (`DEFAULT_BATCH_SIZE`,
  `DEFAULT_FLUSH_INTERVAL_MS`), and feeds `saveRequestDetail`/request-stats
  paths — this is the mechanism actually behind (c)'s live capability, not
  the dead `appendRequestLog`.
### Operator-facing semantics for (c)

Enabling request-details observability (`ENABLE_REQUEST_LOGS=true` env, or
whatever DB setting `resolveObservabilityEnabled()` reads — not fully traced
past `requestDetailsRepo.js:60`) makes `/api/usage/request-details` return
real rows instead of an empty/disabled response; disabling it stops new rows
from being written but does not itself purge history (no route in this scope
performs a delete/purge — not found in the routes read).

## Files read

- src/app/api/token-saver/stats/route.js
- src/app/api/tool-disclosure/stats/route.js
- src/app/api/settings/route.js
- src/app/api/usage/logs/route.js
- src/app/api/usage/request-logs/route.js
- src/app/api/usage/request-details/route.js
- src/lib/admin/policy.js
- src/dashboardGuard.js
- src/lib/db/repos/settingsRepo.js
- src/lib/db/repos/requestDetailsRepo.js
- src/lib/db/repos/usageRepo.js (lines ~1195-1250)
- src/lib/requestDetailsDb.js
- src/lib/tokenSaver/events.js
- src/lib/pxpipe/events.js
- open-sse/rtk/index.js
- open-sse/rtk/registry.js
- open-sse/rtk/constants.js
- open-sse/rtk/headroom.js
- open-sse/rtk/systemInject.js
- open-sse/rtk/pxpipe.js
- open-sse/rtk/ponytail.js
- open-sse/rtk/ponytailPrompt.js
- open-sse/rtk/caveman.js
- open-sse/utils/toolDisclosure.js
- open-sse/utils/requestLogger.js (export/gate lines only)
- open-sse/translator/index.js (export list + register() signature only)
- open-sse/services/combo.js (lines ~495-540, resolveComboTokenSaver)
- src/sse/handlers/chat.js (grep hits only, lines ~700-748)
- open-sse/handlers/chatCore.js (grep hits only)
