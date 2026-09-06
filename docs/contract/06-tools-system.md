# TOOLS / SYSTEM / OAUTH-FLOWS backend contract

Scope: `/api/system/**`, CLI-tool integration routes (`/api/cli-tools/**` — REMOVED, no such route exists in this tree, see section 2 — `/api/mcp/**`, `/api/tool-disclosure/**`), `/api/notifications/**`, `/api/version/**`, `/api/locale`, the generic `/api/oauth/[provider]/[action]` route and its callback semantics.

Auth-class terms below follow `src/dashboardGuard.js` (Next middleware, runs on every request) and `src/lib/admin/policy.js` (the admin-ABI decision function; not used by any route in this doc — no route here is under `/api/admin`). Where a route has no route-level auth check of its own, the auth class is whatever `dashboardGuard.proxy()` decides for its path before the handler runs.

## dashboardGuard auth classes relevant to this scope

Order of evaluation in `src/dashboardGuard.js:266` (`proxy()`):

1. `LOCAL_ONLY_PATHS` (`src/dashboardGuard.js:109-125`) — path prefix match refused 403 `{ error: "Local only: CLI token required" }` unless `canAccessLocalOnlyRoute()` (valid CLI token, OR loopback-Host/Origin request with a valid session / `requireLogin=false`). Members in this doc's scope: `/api/mcp/`, `/api/oauth/cursor/auto-import`, `/api/oauth/kiro/auto-import` (full list also has tunnel/headroom/pxpipe/context-status paths, out of scope). **`/api/cli-tools/cowork-settings` and `/api/cli-tools/antigravity-mitm` are NOT in `LOCAL_ONLY_PATHS`, and no `/api/cli-tools/**` route exists in this tree at all** (confirmed: `ls src/app/api` has no `cli-tools` directory) — see the note at section 2 below.
2. Admin ABI prefix `/api/admin` — not in this doc's scope.
3. `ALWAYS_PROTECTED` (`src/dashboardGuard.js:80-85`) — `/api/shutdown`, `/api/settings/database`, `/api/version/shutdown`, `/api/version/update`. Refused 401 `{ error: "Sign in required...", source: "tokenproxy" }` unless a valid CLI token or a valid dashboard session cookie is present — `requireLogin=false` does NOT bypass this tier.
4. CORS preflight (`OPTIONS`) short-circuits with 204 before auth.
5. Public LLM API prefixes (`/v1`, `/v1beta`, `/api/v1`, `/api/v1beta`, `/codex`) — out of scope here.
6. Deny-by-default for `/api/*` (`src/dashboardGuard.js:334-350`): `isPublicApi()` allow-list bypasses (`PUBLIC_API_PATHS` = `/api/health`, `/api/init`, `/api/locale`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/status`, `/api/auth/oidc`, `/api/auth/saml`, `/api/version`, `/api/settings/require-login`, matched by exact path or `${p}/` prefix); everything else needs a valid CLI token OR `isAuthenticated()` (valid session cookie, or `requireLogin===false`). Refusal: 401 `{ error: "Unauthorized", source: "tokenproxy" }`.

`PROTECTED_API_PATHS` (`src/dashboardGuard.js:88-106`, 16 entries: `/api/settings`, `/api/keys`, `/api/providers`, `/api/provider-nodes`, `/api/proxy-pools`, `/api/combos`, `/api/models`, `/api/usage`, `/api/oauth`, `/api/cloud`, `/api/media-providers`, `/api/pricing`, `/api/tags`, `/api/mcp`, `/api/translator`, `/api/tunnel` — **not** `/api/cli-tools`, which is absent from the array and also has no corresponding route in this tree; `/api/cloud` likewise has no corresponding route, see item 14 / section 0 above) is declared but **never referenced by any `.some()` check in the file** — dead list, comments elsewhere (`src/lib/providerNormalization.js:57`, `src/lib/admin/policy.js:59`) still describe its intent (routes that honour `requireLogin=false`), but the deny-by-default branch above is what actually governs these paths today. No `forbidden_class` / `forbidden_loopback` shaped refusal (that shape belongs to the admin ABI, `src/lib/admin/policy.js`, which nothing in this doc's scope reaches).

`/api/system/state` and `/api/notifications*` are **not** in `PUBLIC_API_PATHS` or any `LOCAL_ONLY_PATHS`/`ALWAYS_PROTECTED` entry, so both fall to the plain deny-by-default branch (tier 6): 401 `{ error: "Unauthorized", source: "tokenproxy" }` when neither a CLI token nor an authenticated/requireLogin-disabled session is present.

`/api/notifications` write actions (POST/PUT, and `/api/notifications/test`) additionally self-gate through `canWriteNotifications()` (`src/app/api/notifications/authz.js`) — see below.

---

## 1. `/api/system/state`

### GET /api/system/state?windowSeconds=<n>
`src/app/api/system/state/route.js:153`

Auth: dashboardGuard deny-by-default (see above); no route-level check. `dynamic="force-dynamic"`, `revalidate=0`.

Query: `windowSeconds` (string, optional). Parsed with `Number.parseInt`; non-finite falls back to `DEFAULT_WINDOW_SECONDS=3600`; clamped to `[MIN_WINDOW_SECONDS=60, MAX_WINDOW_SECONDS=21600]` (`route.js:63-64,74,96-100`). 21600s (6h) ceiling is calibrated to a 200ms p95 budget, re-measure before raising per the file's own comment.

Response 200 (`Cache-Control: no-store`):
```
{
  generatedAt: ISO string,
  window: { kind: "rolling", seconds: windowSeconds, from: ISO, to: ISO },
  freshness: { state: "unknown"|"empty"|"live"|"idle", lastEventAt: ISO|null, ageSeconds: number|null, unit: "seconds" },
  measures: {
    throughput:        { value, unit: "requests_per_second", window: rolling, sampleCount, source: "requestStats", index: "idx_rs_ts", unavailable },
    errorRate:         { value, unit: "ratio",               window: rolling, sampleCount, source: "requestStats", index: "idx_rs_ts", unavailable },
    latencyP95:        { value, unit: "milliseconds",        window: rolling, sampleCount, source: "requestStats", index: "idx_rs_ts", unavailable },
    failoverCount:     { value: null always, unit: "count",  window: rolling, sampleCount: null, source: null, index: null, unavailable: <fixed string> },
    spend:             { value, unit: "usd",                 window: rolling, sampleCount, source: "usageHistory", index: "idx_uh_ts", unavailable },
    connectedUpstreams:{ value, unit: "count", window: { kind: "instant", seconds: 0, at: ISO }, sampleCount, source: "providerConnections", unavailable },
    degradedUpstreams: { value, unit: "count", window: instant, sampleCount, source: "providerConnections", unavailable },
  },
  providerHealth: {
    status: "ok"|"degraded"|"unavailable",
    source: "providerConnections",
    observedAt: ISO,
    unavailable: string|null,
    degradedProviderCount: number|null,
    degradedProvidersOmitted: boolean|null (whatever getUpstreamHealthSummary returns),
    degradedProviders: array (empty when unavailable),
  },
  unanswerable: string[] — Object.keys(measures).filter(m => measures[m].value === null),
}
```
`SYSTEM_STATE_UNITS` (exported, `route.js:77-85`): `{ throughput: "requests_per_second", errorRate: "ratio", latencyP95: "milliseconds", failoverCount: "count", spend: "usd", connectedUpstreams: "count", degradedUpstreams: "count" }` — matches exactly.

`UNANSWERABLE` (exported, `route.js:89`): `["failoverCount"]` — the only measure that is **permanently** null regardless of data, because no failover event table exists (`open-sse/services/accountFallback.js` mutates in-memory state only). This is distinct from the per-request `unanswerable` array in the response body, which can additionally include `errorRate`/`latencyP95`/etc. when their source throws or their window has no samples.

Null-vs-zero contract (verbatim from the file's own doc comment, `route.js:22-42`):
- `value: null` + non-null `unavailable` string = the backend could not answer.
- A `0` is only ever a real measurement: 0 req/s in a known window is a legitimate zero.
- `errorRate` with 0 requests in the window is `null` with `unavailable: "no request was recorded in this window, so there is no rate to report"` and `sampleCount: 0` — NOT a `0` rate.
- `latencyP95` is `null` when no row in the window carries a measured latency (0 is used as a sentinel for "unmeasured" upstream, so zeros are excluded from the percentile rather than counted).

Conditional fields per measure: `value`/`sampleCount` are present on success; `unavailable` (string) is present instead when the source threw (`unavailableFrom(error)` always returns the fixed string `"source unavailable"`, never leaking the underlying error message/path/credential) or when the window legitimately has no answer.

Abort handling: request abort (`request.signal.aborted`) checked before each of the 3 sequential source reads; on abort returns 499 `{ error: "Client closed request" }` immediately, no further query issued.

Partial failure: each of the 3 sources (`requestStats` traffic, `usageHistory` spend, `providerConnections` upstream health) is read in isolation inside its own try/catch; one throwing only nulls its own measures (with `unavailable`) — response is always 200, there is no 500 path from this handler.

---

## 2. CLI-tool / extension integration routes (`/api/cli-tools/**`) — REMOVED, route does not exist

**No `/api/cli-tools/**` directory exists anywhere in this tree** (confirmed: `find src/app/api -iname "*cli-tool*"` returns nothing; `ls src/app/api` has no `cli-tools` entry). This includes `all-statuses`, every per-tool `*-settings` route (`claude`, `cline`, `codex`, `copilot`, `deepseek-tui`, `droid`, `grok-build`, `hermes`, `jcode`, `kilo`, `openclaw`, `opencode`, `pi`, `devin`), `antigravity-mitm` and its `alias` sub-route, and `cowork-settings`/`cowork-mcp-tools`/`cowork-mcp-registry`. None of these routes back this doc's earlier claims about them; the section is left as a removal marker rather than a route-by-route table.

### `/api/mcp/[plugin]/sse` and `/api/mcp/[plugin]/message`
`src/app/api/mcp/[plugin]/sse/route.js`, `.../message/route.js` — stdio↔SSE bridge for local MCP plugin child processes. `runtime="nodejs"`, `dynamic="force-dynamic"`. Defense-in-depth check duplicated in-route (`isLocalRequest`/`hasValidCliToken` imported from `@/dashboardGuard`) on top of the `LOCAL_ONLY_PATHS` middleware gate, because RCE-adjacent (drives a local child process) — comment explicitly says this is deliberate belt-and-suspenders in case the middleware list drifts.
- GET (`sse`) creates a dedicated stdio child for the returned opaque session ID. The initial `endpoint` event contains `/api/mcp/<plugin>/message?sessionId=<id>`. Each child's capabilities, protocol state, responses, notifications and server requests reach only its owning stream. Cancellation, request abort, child errors and child exit close that session. No accepted invocation is automatically replayed.
- POST (`message`) requires the advertised `sessionId`. Missing, expired or cross-plugin IDs return 404 without starting a child. JSON-RPC 2.0 frames are validated and only insignificant JSON whitespace is removed before stdio framing; string bytes, numeric lexemes and wire IDs are preserved. Success returns 202. Malformed frames return 400, frames above 16 MiB return 413, and a full bounded input queue returns 429 before dispatch. Unexpected delivery failures return a fixed 500 message without internal exception text.
- Output text is forwarded intact. The previous implicit `smartFilterText` path removed distinct element references, code and error evidence, and was not controlled by any saver flag or client opt-out. It has been removed. The bridge is outside the 14-toggle chat saver matrix; its transport/session regressions are exercised separately. UTF-8 characters split across stdout chunks are decoded incrementally. Oversized or incomplete output beyond 16 MiB closes the session rather than emitting a truncated success. SSE buffering is also bounded.
- At most 16 child sessions may exist at once, including children still shutting down. Closing sends SIGTERM followed by SIGKILL after five seconds if the child has not closed. POSIX children start in dedicated process groups so their launchers and descendants receive the same signal. Windows currently signals the owned child process only; descendant cleanup is not independently verified. `GET /api/tools` reports whether process handles have exited separately from active client counts.
- Browser MCP permits one active session and returns 409 to competitors until its child has closed. This preset runs `npx -y @browsermcp/mcp@latest`; the inspected upstream [WebSocket server](https://github.com/BrowserMCP/mcp/blob/main/src/ws.ts) terminates the process on its fixed default port, and its [server](https://github.com/BrowserMCP/mcp/blob/main/src/server.ts) owns one extension connection. Its CLI exposes no separate context or port option. This restriction must be rechecked if that unpinned package changes. Lians Memory permits concurrent isolated stdio children while retaining its explicitly documented shared persistent memory store.
- The routes implement the legacy [MCP HTTP+SSE transport](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports), not Streamable HTTP session resumption. A disconnected client must open a new SSE connection and initialize the new child. Neither reconnecting nor a busy response implies that an interrupted tool invocation is safe to repeat.

### GET /api/tool-disclosure/stats
`src/app/api/tool-disclosure/stats/route.js:6` — `dynamic="force-dynamic"`. No auth check beyond dashboardGuard deny-by-default. Response: `getRecentStats()` from `open-sse/utils/toolDisclosure.js`, returned as-is (fields not re-verified here — out of the `open-sse/**`-adjacent read boundary this pass drew around presentation code, but the module is inside `open-sse/**` so in-scope; field shape not independently confirmed against the module source in this pass — read `open-sse/utils/toolDisclosure.js:getRecentStats` before coding against exact keys).

---

## 3. `/api/notifications`

### Auth: `canWriteNotifications(request)`
`src/app/api/notifications/authz.js:12-16` — shared write gate (not itself a route). Not a class name defined in `admin/policy.js`; a route-local three-way OR: `hasValidCliToken(request)` OR `verifyDashboardAuthToken(cookie)` OR `isLocalRequest(request)`. Comment notes dashboardGuard already refuses unauthenticated callers at the `/api/*` deny-by-default tier, but lets **any** caller through once `requireLogin` is disabled — webhook config is instance-wide and outbound-capable (a saved URL is a POST target, carries a signing secret), so writes get the same stricter gate settings-writes use rather than trusting `requireLogin=false` alone.

### GET /api/notifications
`src/app/api/notifications/route.js` — reads `getNotificationsConfig()`, also arms the `statsEmitter` watcher subscription as a side effect of the read (comment at `:14`). No `canWriteNotifications` gate on GET (read-only). Response shape not fully captured in this pass beyond the config/history read path — `getNotificationsConfig`, `getDeliveryHistory`, `WEBHOOK_EVENTS` all imported from `@/lib/notifications/webhooks.js`.

### PUT/POST (config write) /api/notifications
Gated by `canWriteNotifications()` — 401 `{error:"Unauthorized"}` on failure (`route.js:68` region, confirmed for the `evaluate` POST path below; the config-save path uses `saveNotificationsConfig` and the same authz import). SSRF guard (`findBlockedError`/`SSRF_BLOCKED_ERROR_CODE` from `@/shared/utils/ssrfGuard.js`) applies to webhook URLs configured here.

### POST /api/notifications (evaluate action)
`src/app/api/notifications/route.js:67-73` — gated by `canWriteNotifications()`, 401 `{error:"Unauthorized"}` on failure. Calls `ensureWatcher()` then `evaluate()`, returns the evaluate result as-is.

### POST /api/notifications/test
`src/app/api/notifications/test/route.js:8-53` — gated (imports `canWriteNotifications` from `../authz.js`). Two body shapes:
- `{ endpointId }` — tests a saved endpoint (secret included from stored config).
- `{ url, secret? }` — tests a URL before saving it; validated with `assertPublicUrl` (SSRF guard) before firing — blocked target yields the `SSRF_BLOCKED_ERROR_CODE` shape.
`retries: 0` fixed (comment: an operator waiting on a button must get an immediate result, not a retry delay). Delivers a synthetic payload `{ message: "TokenProxy webhook test", at: <ISO> }` via `deliver(endpoint, "test", payload, {retries:0})`, returns the `deliver()` result verbatim.

---

## 4. `/api/version`, `/api/version/update`, `/api/version/shutdown`

### GET /api/version
`src/app/api/version/route.js:1-77`. In `PUBLIC_API_PATHS` (no auth required). Reads `package.json` `version` as `currentVersion`. Caches the npm-registry "latest" lookup process-globally (`global.__npmVersionCache`) for `VERSION_CACHE_TTL_MS=3600000` (1h). Response: `{ currentVersion, latestVersion, hasUpdate, isTrayMode, buildSha }` — `buildSha` is `process.env.TP_BUILD_SHA || null` (`route.js:64-65`), inlined at build time by `next.config.mjs`, `null` when unset. When updates are disabled (`isUpdateDisabled()`), the early-return response also carries `buildSha` (`route.js:68`).

**Failed-lookup vs up-to-date distinction (verbatim from `route.js:72-73`)**:
```js
const latestVersion = await getLatestVersionCached();
const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
```
When the npm lookup fails, `getLatestVersionCached()` resolves to a falsy value (null, per the cache shape `{value:null, fetchedAt:...}` at `:11`), and `latestVersion` in the response body is that same falsy value — **not** silently coerced to "up to date" internally, but `hasUpdate` IS forced to `false` in that case (the ternary's else-branch), which is operationally indistinguishable from genuinely being current unless the caller separately checks `latestVersion === null`. A frontend MUST branch on `latestVersion` being falsy (failed/unknown) versus `hasUpdate===false && latestVersion` truthy (confirmed current) to render the two states differently — the API does not carry a distinct "lookup failed" flag.

### POST /api/version/update
`src/app/api/version/update/route.js:1-30`. `ALWAYS_PROTECTED` (tier 3) — requires valid CLI token or session cookie regardless of `requireLogin`.
- If `isUpdateDisabled()` (env `TOKENPROXY_NO_UPDATE`): 403 `{ success: false, message: "Updates are disabled on this install (TOKENPROXY_NO_UPDATE)" }` (`route.js:6-11`).
- Else if `process.env.NODE_ENV !== "production"`: 403 `{ success: false, message: "Update is only available in production build (tokenproxy CLI)" }` (`route.js:14-19`) — a second, distinct refusal case gated on build mode rather than the update-disabled flag.
- Else: best-effort `killAppProcesses()` (errors swallowed), then `spawnUpdaterAndExit()` (detached updater process, current server exits). Response 200 `{ success: true, message: "Updater started. This app will exit shortly." }` — sent **before** the process actually exits.

### POST /api/version/shutdown
`src/app/api/version/shutdown/route.js:1-17`. `ALWAYS_PROTECTED` (tier 3), same auth floor as update.
Best-effort `killAppProcesses()` (errors swallowed via empty catch). Response 200 `{ success: true, message: "Shutting down for manual update..." }` built first, then `setTimeout(() => shutdownProcess(0), 500)` — a 500ms delay before the process actually exits, so the HTTP response is guaranteed to flush to the client before shutdown.

---

## 5. `/api/locale`

`src/app/api/locale/route.js:1-31`. In `PUBLIC_API_PATHS` (no auth). POST only (`route.js` exports only `POST`).

Body: `{ locale }` (string). Validated with `isSupportedLocale(locale)` imported from `@/i18n/config` — **this is a presentation-layer-adjacent dependency the new frontend must resolve or replace**, since `@/i18n/config` (`src/i18n/config.js`) is a plain data module (LOCALES array, `normalizeLocale`, `isSupportedLocale`, `getLocaleDirection`) with no React/UI code in it, so it is safe for the new frontend to port verbatim or re-implement.

`LOCALES` (`src/i18n/config.js`, exported array): `en, vi, zh-CN, zh-TW, ja, pt-BR, pt-PT, ko, es, de, fr, he, ar, ru, pl, cs, nl, tr, uk, tl, id, km, th, hi, bn, ur, ro, sv, it, el, hu, fi, da, no, fa` (35 locales).

- Missing or unsupported `locale` → 400 `{ error: "Invalid locale" }`.
- Success: sets `LOCALE_COOKIE` (from the same `@/i18n/config` module) to `normalizeLocale(locale)`, returns 200 `{ success: true, locale: normalized }`.
- JSON parse failure or any other exception → 500 `{ error: "Failed to set locale" }`.

The route has zero dependency on `@/i18n/server.js`, `@/i18n/runtime.js`, or `@/i18n/RuntimeI18nProvider.js` (all three are React/runtime i18n plumbing, out of scope per the presentation-code prohibition and not imported here) — only `@/i18n/config.js` (pure constants/functions) is a hard dependency for this one route.

---

## 6. Generic OAuth route: `/api/oauth/[provider]/[action]`

`src/app/api/oauth/[provider]/[action]/route.js` (551 lines). All actions live behind dashboardGuard's `/api/oauth` prefix in `PROTECTED_API_PATHS` (declared but dead — see section 0) — actual gate is deny-by-default (tier 6), EXCEPT `cursor/auto-import` and `kiro/auto-import` sibling routes (separate files, not this one) which are `LOCAL_ONLY_PATHS`. This generic route itself carries no extra route-level auth check beyond dashboardGuard.

Every handler is wrapped in one outer try/catch per HTTP method; an uncaught exception anywhere returns 500 `{ error: error.message }` (GET: `route.js:286-289`; POST: `route.js:547-550`) — this can leak an internal error message string to the client, since nothing sanitizes `error.message` the way `/api/system/state`'s `unavailableFrom()` does.

`readReauthTarget(body)` (`route.js:~46-55`, re-authentication target id, issue #1851): when the request body names a target connection id, a successful sign-in **updates that row's credential fields in place** instead of creating a new connection — preserves the connection's fallback-order position, proxy binding, and metadata. No provider redirect lands on this reauth path; it is read from the JSON body the authenticated dashboard already sent.

### GET actions (`route.js:129-290`)

| action | Query / provider gating | Behavior | Response / error |
|---|---|---|---|
| `authorize` | `redirect_uri` (default `http://localhost:8080/callback`); all other non-reserved query params collected into `meta` (provider-specific, e.g. gitlab `baseUrl`/`clientId`/`clientSecret`); Zed additionally derives `native_app_port` from the callback URL to bind the RSA keypair to the port the proxy will listen on | `generateAuthData(provider, redirectUri, meta)` | 200: the object `generateAuthData` returns verbatim (auth URL + PKCE/session data, provider-shaped) |
| `start-proxy` | provider ∈ {trae, windsurf, zed, devin, codex, xai} — else falls through to a generic branch (`route.js:170+`) | Starts a local dynamic-port callback server (trae/windsurf/zed/devin) or a proxy session (codex/xai via `startCodexProxy`/`startXaiProxy`, differentiated `serverSide` flag) | 200: proxy-start result object plus `serverSide` merged in (`route.js:189`) |
| `poll-status` | query `state` (required) | Looks up an in-memory session by provider (`getTraeSessionStatus`/`getDevinSessionStatus`/`getWindsurfSessionStatus`/`getZedSessionStatus`, else generic) | Missing `state` → 400 `{error:"Missing state"}`; else session status object |
| `stop-proxy` | provider ∈ {trae, devin, windsurf, zed, xai, codex} | Calls the matching `stop*Proxy()` | Unsupported provider → 400 `{error:"Proxy only supported for codex/xai/trae/windsurf/zed/devin"}`; else 200 `{success:true,...}` |
| `ide-status` | provider ∈ {trae, windsurf} only | `detectIdeInstalled(provider)` — checks whether the IDE is installed locally, for import-token UX | Other providers → 400 `{error:"ide-status only supported for trae/windsurf"}`; else the detection result object |
| `device-code` | requires `getProvider(provider).flowType === "device_code"` | `generateAuthData(provider, null)`; forwards `start_url`, `region`, `auth_method` query params into provider-specific device options | Non-device-code provider → 400 `{error:"Provider does not support device code flow"}`; else the device-code auth data object |
| (none matched) | — | — | 400 `{error:"Unknown action"}` |

### POST actions (`route.js:294-550`)

Body is always parsed first; invalid/empty JSON → 400 `{error:"Invalid or empty request body"}` before any action branch runs (`route.js:297-302`). `reauth = readReauthTarget(body)` computed once, threaded into every `saveConnection`/`completeXaiManualCode` call.

| action | Request body keys | Provider gating | Response / error |
|---|---|---|---|
| `register-session` | `state` (also accepted from URL query, body wins fallback order query-then-body per `route.js:310`), `codeVerifier` (Zed's encodes an RSA private key — kept out of URL/query to avoid landing in logs) | provider ∈ {trae, windsurf, zed, devin} | Missing `state` → 400 `{error:"Missing state"}`; unsupported provider → 400 `{error:"Proxy only supported for trae/windsurf/zed/devin"}`; else 200 `{success: ok}` (`ok` is the boolean the provider-specific `register*Session` call returns) |
| `exchange` | `code, redirectUri, codeVerifier, state, meta` — provider-specific sub-branches override this: xai handled by a separate pre-branch (see below), devin requires `code+state+verifier+callbackRedirectUri` (verifier/redirectUri fall back to the stored session when absent from the body), trae/windsurf accept `code` as either a raw callback URL or a pasted token (no PKCE), cline/clinepass/kimchi are `noPkceExchangeProviders` (skip the `codeVerifier` requirement) | varies per branch above | Devin missing code/state/verifier/redirectUri → 400 `{error:"Missing Devin callback URL, state, or PKCE session"}`; devin exchange exception → 500 `{error: err.message}`; trae/windsurf missing token → 400 `{error:"Missing token or callback URL"}`; trae/windsurf/generic exchange with no access token → 502 `{error:"Token exchange returned no access token"}` — **explicit: a tokenless exchange is never persisted as an "active" connection**; generic path missing `code`/`redirectUri`/(`codeVerifier` unless no-PKCE provider) → 400 `{error:"Missing required fields"}`; success → 200 `{success:true, connection:{id, provider, email, displayName}}` shape (windsurf/devin/generic variants all converge on this connection subset, field presence depends on what the provider's token exchange returned) |
| `poll` | `deviceCode` (required), `codeVerifier`, `extraData` | `noPkceProviders = ["github","kimi","kimi-coding","kilocode","codebuddy-cn","codebuddy-intl"]` skip codeVerifier; `kiro` needs `extraData` (clientId/clientSecret) from the device-code response; kimi needs `extraData._kimiDeviceId` for a stable `X-Msh-Device-Id` header (CLIProxyAPI parity) | Missing `deviceCode` → 400 `{error:"Missing device code"}`; pending/slow_down states surface as 200 `{success:false, error, errorDescription, pending: true}` (`pending` is `true` when `result.error` is `"authorization_pending"` or `"slow_down"` — NOT an HTTP-level pending status, the poll always returns 200 and the caller must read `pending`/`success` to decide whether to keep polling) |
| `manual-code` | `code, state` | provider must be `"xai"` — the only manual-paste-code provider | Non-xai provider → 400 `{error:"Manual code only supported for xai"}`; `completeXaiManualCode` throws `"xAI OAuth session not found; restart the login flow and paste the code again"` when no in-memory session matches `state` (session-not-found is NOT translated to a distinct status code — it propagates to the outer catch as 500 `{error: err.message}`); success → 200 `{success:true, connection: result.connection}` |
| (none matched) | — | — | 400 `{error:"Unknown action"}` |

### xai-specific exchange helper (`completeXaiExchange`, `route.js:~80-120`)
Called from the generic exchange path when `provider==="xai"`. On success: clears the in-memory xai session (`clearXaiSession(state)`) and stops the xai proxy (`stopXaiProxy()`) in BOTH the success and the catch/rethrow paths (`route.js:103-104,116-118`) — session cleanup is unconditional once an exchange attempt starts. `saveConnection()` failure returns `saved` (the failure NextResponse) directly rather than throwing. Success connection shape: `{id, provider, email, displayName}` — trimmed, no token fields echoed back.

### `/callback` landing contract
No dedicated `/api/oauth/.../callback` Next.js route exists in this scope — callbacks land on a **local Node HTTP server** spawned per-provider-flow (`src/lib/oauth/utils/server.js:16-74`), not on the TokenProxy app server itself. That local server listens on `/callback` or `/auth/callback`, parses the query string, and:
- Serves a static 200 `text/html` page confirming success/failure to the browser (`server.js:30-31` onward — this is presentation HTML served directly by the loopback callback server, not a JSON API; out of the JSON-contract scope of this doc since it is not `src/app/api/**`).
- Any other path on that local server → 404 `text/html` "Not found" (`server.js:73-74`).
- Calls the registered `onCallback(queryParams)` handler with whatever query params the provider's redirect carried (varies per provider — `code`, `state`, and on failure typically `error`/`error_description`, read generically as passed-through query params; the local server does not itself define a fixed success/failure param contract beyond forwarding whatever arrives).
- A companion polling function (`server.js:100+`, "Poll until the OAuth callback has stored its params") lets the dashboard/CLI poll the local server for the callback result rather than the local server pushing to the dashboard directly.

This local-callback-server model is why the `/callback` contract cannot be expressed as a `src/app/api/**` route: the redirect target is a per-flow ephemeral local HTTP listener (`src/lib/oauth/utils/server.js`), and the dashboard learns the outcome via `poll-status` (GET action above) rather than via a callback-triggered API response.

---

## Files read

**Every `.../cli-tools/...` path below is stale**: those files were read against the pre-removal tree and no `src/app/api/cli-tools/` directory exists in this repository (`tokenproxy-rebuild`) today — see section 2's removal note. Kept here only as the historical file list for what was originally reviewed; do not use them to imply a live route.

- /home/spadon/Codebases/tokenproxy/src/app/api/system/state/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/notifications/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/notifications/authz.js
- /home/spadon/Codebases/tokenproxy/src/app/api/notifications/test/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/version/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/version/update/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/version/shutdown/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/locale/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/oauth/[provider]/[action]/route.js
- /home/spadon/Codebases/tokenproxy/src/lib/admin/policy.js
- /home/spadon/Codebases/tokenproxy/src/dashboardGuard.js
- /home/spadon/Codebases/tokenproxy/src/lib/oauth/providers.js
- /home/spadon/Codebases/tokenproxy/src/lib/oauth/providers/index.js
- /home/spadon/Codebases/tokenproxy/src/lib/oauth/utils/server.js (grep of callback/response-writing lines only, not read in full)
- /home/spadon/Codebases/tokenproxy/src/i18n/config.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/all-statuses/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/claude-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/cline-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/codex-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/copilot-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/deepseek-tui-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/devin-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/droid-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/grok-build-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/hermes-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/jcode-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/kilo-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/openclaw-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/opencode-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/pi-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/antigravity-mitm/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/antigravity-mitm/alias/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/cowork-settings/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/cowork-mcp-tools/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/cli-tools/cowork-mcp-registry/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/mcp/[plugin]/sse/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/mcp/[plugin]/message/route.js
- /home/spadon/Codebases/tokenproxy/src/app/api/tool-disclosure/stats/route.js
