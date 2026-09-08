# TokenProxy Backend Capability Inventory

Next.js App Router, plain ESM JS. Rewrites (`next.config.mjs`): `/v1/*`→`/api/v1/*`, `/v1beta/*`→`/api/v1beta/*`, `/codex/*`→`/api/v1/responses`, `/responses`→`/api/v1/responses`.

## 0. Auth model primitives

- **Dashboard session**: JWT (jose, HS256, `JWT_SECRET`), httpOnly cookie `auth_token`, 24h expiry. Password is bcrypt hash in `settings.password`, falling back to env `INITIAL_PASSWORD` or literal `"123456"` on first run.
- **Login**: progressive lockout on repeated failures.
- **`requireLogin=false`**: a settings toggle that lets `/api/*` (the ones in `PROTECTED_API_PATHS`) pass without a session — does NOT satisfy the four `ALWAYS_PROTECTED` paths (`/api/shutdown`, `/api/settings/database`, `/api/version/shutdown`, `/api/version/update`, `src/dashboardGuard.js:81-85`), nor the separately-gated admin operator class, oauth credential export, notifications write, or mcp routes.
- **CLI token**: header `x-tp-cli-token` compared to `getConsistentMachineId("tp-cli-auth")`.
- **Trusted forwarding peer**: `x-tp-real-ip` / `x-tp-peer-token` vs `TOKENPROXY_PEER_TOKEN`.
- **Loopback**: `isLocalRequest()` — checks the resolved peer is 127.0.0.1/::1 (post trusted-peer resolution).
- **Admin ABI** (`src/lib/admin/policy.js`, `adminDecision()`): pure function, called identically by `dashboardGuard.js` middleware and `src/lib/admin/guard.js` per-route. Two auth classes:
  - `inference` (exact paths `/api/admin/health`, `/api/admin/models` only): satisfied by operator OR inference API key OR loopback.
  - `operator` (everything else under `/api/admin/**`): requires CLI token or dashboard JWT (never `requireLogin=false`); mutating (non-GET/HEAD/OPTIONS) operator calls additionally require loopback.
  - Helpers: `parseAdminBody()` (strict field allowlist, JSON-object-only, 400 on unrecognized field), `invalidIfMatch()`, `adminError()`/`adminJson()` (both set `Cache-Control: no-store`; error body always carries `source: "tokenproxy-admin"`).
- **`settings/database`**: (valid CLI token OR valid dashboard JWT) AND valid dashboard password (`x-tp-password` header or JSON `password` field) — doubly gated export/import of the whole DB.
- **`notifications` write gate** (`authz.js`, `canWriteNotifications`): CLI token OR dashboard JWT OR `isLocalRequest()` — stricter than default `requireLogin=false` passthrough because webhook config is outbound-capable and holds a signing secret.
- **`mcp/[plugin]/*`**: re-implements local-only gate (`isLocalRequest() || hasValidCliToken()`) as defense-in-depth beyond middleware, because these drive local stdio child processes (bypass = RCE, issue #1114).
- **`oauth/codex/export`**: loopback OR CLI token AND a real signed-in dashboard session — prevents `requireLogin=false` from exposing a download endpoint over a tunnel. POST-only (a GET download response would be reachable via bare navigation). Response headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Disposition: attachment`.
- **`providers/antigravity/verification/*`**: `authorizeAntigravityVerification()` (read) / `authorizeAntigravityVerificationMutation()` (adds CSRF same-origin check for writes).

Routes with **no in-route auth check** rely entirely on `dashboardGuard.js` middleware's deny-by-default behavior for `/api/*` (i.e., they need a valid session/CLI token unless explicitly listed in `PUBLIC_API_PATHS`/`PUBLIC_PREFIXES`). These are called out per-domain below.

## 1. Auth domain (`/api/auth/**`)

Login (progressive lockout), logout, session check, password reset, OIDC, SAML routes — session cookie issuance model as above.

## 2. Providers / connections (`/api/providers/**`, excluding `[id]/*`)

| Route | Methods | Auth | Notes |
|---|---|---|---|
| `providers/client` | GET | dashboardGuard default | Paginated (`page`,`pageSize` max 500), filterable (`provider`,`accountStatus`,`sort`), returns sanitized connections via `SAFE_FIELDS`/`SAFE_PSD_FIELDS` allowlists (masks long opaque names via `maskName()`), flags `effectiveStatus:"recovering"` when an `isActive` connection has all model-locks expired. Runs `backfillCodexEmails()` as a side effect. |
| `providers/custom` | GET, POST | dashboardGuard default | GET lists "adapter"-prefixed (`openai-compatible-adapter-*`) provider nodes as declarative documents (`adapterFromProviderNode`). POST compiles an untrusted JSON document into a provider node via `compileCustomAdapter` (rejects any transformer/script field), creates via `createProviderNode`. |
| `providers/import` | POST | **none in-route** — relies on deny-by-default for `/api/*` (deliberately absent from public path lists since the body carries account secrets) | Provider-agnostic bulk importer: accepts array / single object / `{accounts:[...]}` / `{providerConnections:[...]}`; snake_case field aliasing; infers `authType` from which token field is present when absent; serial insert (creation reorders priority in a DB transaction, so parallel calls would race); per-item success/failure in response; tokens never echoed back. |
| `providers/kilo/free-models` | GET | dashboardGuard default | Proxies `https://api.kilo.ai/api/gateway/models`, filters `isFree===true`, 1h in-memory cache, serves stale cache on fetch failure. |
| `providers/suggested-models` | GET | dashboardGuard default | Query `?url=&type=`; `url` must match a `modelsFetcher.url` already declared in the provider registry (`isTrustedModelsSource`) — prevents becoming an open fetch proxy; 10s timeout, `redirect:"manual"`. |
| `providers/test-batch` | POST | dashboardGuard default | Body `{mode, providerId?}`, `mode` in provider/oauth/free/apikey/compatible/all; tests every matching active connection serially via shared `testSingleConnection()`; returns per-connection result + summary counts. |
| `providers/validate` | POST | dashboardGuard default | Body `{provider, apiKey, providerSpecificData}`; huge per-provider branch probing the vendor API with a harmless request to distinguish 401/403 (bad key) from other statuses (key OK); covers 40+ specific providers (openai-compatible/anthropic-compatible/custom-embedding nodes, azure, cloudflare-ai, huggingface, vertex service-account JWT validation, grok-web/perplexity-web cookie-based probes with browser-fingerprint headers, qoder PAT job-token exchange) plus a generic OpenAI-compatible fallback driven by the `PROVIDERS` registry config. |

`providers/antigravity/verification/*`, `providers/[id]/*` domain covered in earlier session pass (favicon SSRF-safe by nodeId-only lookup, validate route, provider-nodes CRUD/cascade).

## 3. Combos (`/api/combos/**`)

`VALID_NAME_REGEX=/^[a-zA-Z0-9_.\-]+$/`; cycle-guarded (`validateComboAcyclic`) on create/update. `resetComboRotation()` invalidates round-robin state on model/strategy/name change. `/test` and `/[id]/test` self-call the gateway on the same port the inbound request arrived on (issue #1874) to test fallback ordering; each model tested independently. `/suggest` and `/default-model` build fallback chains from `/v1/models` + `/api/models/availability` (fail-open). `/export` yields `{version:2, exportedAt, capacityAdapter?, combos:[...]}`. `/import` does full-replace inside a DB transaction, supports both v1 (`roundRobin:boolean`) and v2 (`strategy:{fallbackStrategy,judgeModel}`) shapes.

## 4. Keys / devices (`/api/keys/**`)

`GET` enriches with `usage` (`getApiKeyUsageTotals`) and `deviceCount` (`getApiKeyDeviceCount`, 30-min rolling window, never echoes key value). `POST` calls `createApiKey(name, machineId, expiresAt)` plus optional limits (`maxPromptTokens`/`maxCompletionTokens`/`maxCostUsd`/`allowedModels`, all backward-compat-optional). `DELETE ?id=a&id=b` bulk revoke, reports `{requested, deleted}` (partial success is not a failure). `keys/[id]` PUT partial update (`isActive` + limits, `null` clears a limit). `keys/devices` GET returns per-key device counts.

## 5. Settings (`/api/settings/**`)

`settings` route: `PROTECTED_SETTING_KEYS=["password","mitmSudoEncrypted"]` never mass-assignable (CWE-915). `DANGEROUS_STRATEGY_KEYS=Set(["__proto__","prototype","constructor"])` guarded on strategy-patch keys. Password change: bcrypt verify-then-hash, first-time-set allows empty or `"123456"`. `oidcClientSecret` empty string never persisted. Side effects wired to specific key changes: `contextWindowOverrides` reloads capabilities map; `outboundProxyEnabled/Url/NoProxy` calls `applyOutboundProxyEnv`; `comboStrategy*` calls `resetComboRotation`; quota-autoping keys reconfigure that service; `freeModelSync` reconfigures that service. `toSafeSettings()` strips `password`/`oidcClientSecret`. GET adds `enableRequestLogs` (env-derived), `quotaAutoPingProviders`, `hasPassword`.

`settings/database`: export/import whole DB, gated as described in section 0.
`settings/proxy-test`: trivial POST wrapper around `testProxyUrl`.
`settings/require-login`: public GET (pre-login gate check itself), returns `{requireLogin}`, defaults `requireLogin=true` on error.

## 6. Notifications (`/api/notifications/**`)

`canWriteNotifications()` is CLI token OR dashboard JWT OR loopback (section 0). GET arms `ensureWatcher()` (statsEmitter subscription) as a read side effect. PUT validates via `saveNotificationsConfig`, 400s on SSRF-blocked URL or bad-URL TypeError. POST triggers immediate `evaluate()` diff pass. `test` accepts `{endpointId}` or `{url, secret?}`, `retries:0`, SSRF-checked (`assertPublicUrl`) before send.

Webhook channel (`src/lib/notifications/webhooks.js`): `WEBHOOK_EVENTS=["provider.unhealthy","provider.recovered","high.error.rate"]`; config `{enabled, endpoints:[{id,url,events[],secret,active}], errorRate:{threshold,windowSeconds,minSamples}}`; retry ladder `[1000,5000,30000]ms`; `REQUEST_TIMEOUT_MS=10000`; `HISTORY_LIMIT=50`; module-global history survives hot reload; fail-open (never blocks request path); SSRF re-checked at connect time (`fetchPublicUrl`); secrets write-only (`redact()`).

## 7. Oauth flows (`/api/oauth/**`)

15 route files. Generic dynamic route `oauth/[provider]/[action]/route.js` handles `authorize`/`start-proxy`/`poll-status`/`stop-proxy`/`ide-status`/`device-code` (GET) and `register-session`/`exchange`/`poll`/`manual-code` (POST) across ~20 providers. `readReauthTarget()`/`saveConnection()` support in-place re-auth (`reauthorizeProviderConnection`) with a `REAUTH_FAILURE` code map (`not_found` to 404, `provider_mismatch` to 400, `empty_credential` to 400, `identity_mismatch` to 409). JWT-sniffing shortcut: `code.startsWith("eyJ")` treats a pasted raw access token as a direct import, bypassing code-exchange.

Named routes with **no in-route auth beyond middleware default**: `oauth/codex/bulk-import`, `oauth/codex/import-token`, `oauth/grok-cli/bulk-import`, `oauth/cursor/*`, `oauth/gitlab/pat`, `oauth/iflow/cookie`, `oauth/kiro/*` (6 files).

`oauth/codex/export`: security-hardened as in section 0.

## 8. Proxy-pools (`/api/proxy-pools/**`)

CRUD plus `type` enum `["http","vercel","cloudflare"]`, `strictProxy` flag. Bulk `DELETE` by `ids[]`, per-id result, refuses a pool still bound to a connection (`boundConnectionCount`). `/[id]/test` probes via `testProxyUrl`/`testRelayUrl` by relay type. `/cloudflare-deploy` and `/vercel-deploy` actually provision a Worker/Edge Function (hardcoded relay source) and register the resulting URL as a new pool.

## 9. Pxpipe (`/api/pxpipe/**`)

In-process library-mode transform (not a subprocess). `health` (POST+GET alias), `install` (POST, `maxDuration=300`, `installPxpipe()` plus `unloadPxpipe()` plus recheck), `logs` (GET, `getInstallLogTail()` plus `readPxpipeEvents({limit})`), `restart` (POST, unload then reload), `start` (POST, auto-installs if `settings.pxpipeAutoInstall` and not installed, else 409 `NOT_INSTALLED`), `stats` (GET, `getPxpipeStats({recentLimit})`), `status` (GET, merges runtime status with settings `pxpipeEnabled`/`pxpipeAutoInstall`/`pxpipeMinChars`/`pxpipeTimeoutMs`), `stop` (POST).

## 11. Headroom (`/api/headroom/**`)

`status`: `{running, enabled, active, url}` (active means enabled AND running). `proxy/[...path]`: forwards arbitrary methods to `settings.headroomUrl`, strips hop-by-hop headers, strips cookie/authorization for non-loopback targets, injects `HEADROOM_API_KEY` bearer, rewrites HTML `src/href/action` and inline `fetch()` under an allowlisted path-prefix set, rewrites `Location` redirects back through the proxy prefix. Exported helpers `rewriteHeadroomHtml()`, `rewriteLocation()`, `forwardedHeaders()`.

## 12. Token-saver / tool-disclosure

`token-saver/stats`: aggregates RTK/headroom/pxpipe reduction sources separately (never combined into one number), 503 on read failure. `tool-disclosure/stats`: trivial GET wrapper around `getRecentStats()`.

## 14. MCP (`/api/mcp/[plugin]/**`)

`sse`: local-only gated (section 0); on connect sends `event: endpoint\ndata: /api/mcp/{plugin}/message?sessionId={sid}\n\n`. `message`: POST forwards JSON body to child process via `sendToChild()`, returns 202.

## 15. Media providers (`/api/media-providers/tts/**`)

`voices`, `deepgram/voices`, `elevenlabs/voices`, `inworld/voices`, `minimax/voices`: all GET, no route-level auth beyond middleware; read `apiKey` from an active `providerConnections` row, fetch vendor voices/models list, return `{languages, byLang}`-shaped grouping. deepgram/elevenlabs/inworld return 400 "No X connection found" if none. minimax has two regional endpoints and groups by `VOICE_GROUPS`.

## 16. Model-context (`/api/model-context/**`)

GET (read merged overrides+catalog table), PUT (single upsert), DELETE (single remove `?key=`), POST (bulk `{set:[...], deleteKeys:[]}`) over `settings.contextWindowOverrides`.

## 17. Provider-nodes (`/api/provider-nodes/**`)

POST validates by `type` (openai-compatible/multi-compatible/custom-embedding/anthropic-compatible), each with own baseUrl sanitization plus id-prefix scheme. PUT cascades `prefix`/`apiType`/`baseUrl`/`transports` down to every bound connection's `providerSpecificData`. DELETE cascades node plus connection deletion. `favicon`: takes `nodeId` (never raw URL, avoids SSRF-capable general fetch proxy); tries endpoint-adjacent to origin-root to one-label-up favicon.ico (skips IP literals); returns `data:` URI; positive cache 6h/negative 30min; `MAX_BYTES=128KB`, `FETCH_TIMEOUT_MS=4000`; miss returns 204. `validate`: probes candidate baseUrl+apiKey; remote multi-compatible candidates SSRF-checked (`assertPublicUrl`) before probing; distinguishes many network-failure causes and model-vs-endpoint 404s.

## 18. System / state / version / lifecycle

`system/state`: not authenticated in-route (deny-by-default). Every measure returned as envelope `{value, unit, window, sampleCount, source, index, unavailable}` — null value plus `unavailable` string is not the same as a real 0. `failoverCount` permanently unavailable. Window clamped `[60s,21600s]`. Sources: `getTrafficWindow` (requestStats), `getSpendWindow` (usageHistory), `getUpstreamHealthSummary` (providerConnections). Partial per-source failure never becomes a 500; abort returns 499.

`version`: compares CLI/pkg version vs npm registry `latest`, 1h cache, respects `TOKENPROXY_NO_UPDATE`. `version/shutdown`/`version/update`: `killAppProcesses()` then `shutdownProcess(0)` or `spawnUpdaterAndExit()`; update is production-only.

`shutdown` (top-level): dev-only (`NODE_ENV!==production` refused), requires `Authorization: Bearer ${SHUTDOWN_SECRET}`.

`init`: trivial GET "Initialized" bootstrap ping, no auth logic.
The product interface uses English with left-to-right document direction.
`pricing`: GET/PATCH/DELETE over settings-backed pricing table; PATCH strict nested-shape validation; DELETE resets all/provider/provider+model; contains dead `GET_DEFAULTS` export (invalid Next.js route export name, unreachable via HTTP, residual artifact).
`tags`: CORS-open GET/OPTIONS, no auth at all, serves static Ollama-compatible `ollamaModels` config.
`changelog`: reads `CHANGELOG.md` from `process.cwd()` at runtime, 404 on missing file.
`context-status`: reads in-memory context-status store, redacts/truncates (`MAX_ENTRIES=100`, `MAX_STRING=64`), 503 on read error (same honesty contract as token-saver/stats).
`health`: CORS-open trivial `{ok:true}` liveness; `OPTIONS` returns 204.

## 19. Usage / statistics / request-logs / stream domain (`/api/usage/**`)

| Route | Methods | Notes |
|---|---|---|
| `usage/stream` | GET (SSE) | Plain `data: {...}\n\n` frames (no `event:` line). `statsEmitter` `"update"`/`"pending"` events, `coalesce()` re-entrancy guard (fixes #3061/#3029 busy loop). `period` restricted to `["today","24h","7d","30d","60d","all"]`, default `"today"`, no custom range by design (#3442). 25s ping; cleanup on `request.signal` abort. |
| `usage/chart` | GET | `?period=&startDate=&endDate=` (optional inclusive local-day range, #3442); wraps `getChartData`. |
| `usage/history` | GET | Trivial wrapper on `getUsageStats()`. |
| `usage/logs` | GET | Trivial wrapper on `getRecentLogs(200)`, bare-array response (legacy consumer). |
| `usage/request-logs` | GET | Trivial wrapper on `getRecentLogs(200)`. |
| `usage/providers` | GET | Distinct provider list from `getDistinctProviders()` (avoids parsing full JSON blobs, prior OOM), enriched with provider-node/registry display names. |
| `usage/statistics` | GET | `?provider=&connectionId=&model=&startDate=&endDate=&page=&pageSize=` (all CSV multi-select except dates); returns `{filters, summary, series, items, pagination}` from `requestStatsRepo` (45-day full-history source); `pageSize` capped 100; `Cache-Control: no-store`. |
| `usage/stats` | GET | `?period=&startDate=&endDate=`; `getUsageStatsInRange`. |
| `usage/stats/health` | GET | `?period=&groupBy=(provider\|account\|model)&startDate=&endDate=`; response-time/success-rate per grain from `requestStats` via `getProviderHealth`. |
| `usage/token-refresh` | GET | Token rotation summary across every connection with any (`summarizeTokenRotation`), derived from already-persisted refresh state, no provider egress; `Cache-Control: no-store`. |
| `usage/request-details` | GET | `?page=&pageSize=(1-100)&provider=&model=&connectionId=&status=&startDate=&endDate=`. Redacts conversation payload bodies (`redactDetail`): request/providerRequest/providerResponse/response blanked to `{redacted:true}` EXCEPT the error envelope on a failed request (`response.error`/`.status` preserved, capped `MAX_ERROR_CHARS=2000`) so operators can still see why a request failed (#2221); double-redaction pass via `redactSecrets`/`redactSecretsText` for pre-existing unscrubbed rows. Also reports `observability.enabled` (`isObservabilityEnabled()`, fail-closed to `false`) since request-detail recording is off by default since v0.5.50 (#3106). |
| `usage/[connectionId]` | GET | Live per-connection quota/usage probe, deduped via `runUsageProbe()` gate (#3061). Eligibility gate is the single shared `isQuotaEligible()` (was 3 private copies, #1322). Resolves proxy config first (503 `required_proxy_unavailable` if a required proxy is down). OAuth-only token refresh plus retry-once-on-auth-expired. Persists best-effort quota snapshot for router pause logic. Antigravity routed through `runAntigravityUsageProbe` with a safe generic error message (never leaks upstream detail). Grok-CLI gets a synthesized daily-quota shape when the provider reports no numeric quota. Codex OAuth gets subscription-entitlement enrichment (fail-open). Response includes `connectionStatus: {isActive, modelLocks, lastQuotaSnapshot}` so the UI/router agree on "paused" (#1901). Exports `refreshAndUpdateCredentials()`, reused by the codex-reset-credits route below. |
| `usage/[connectionId]/codex-reset-credits` | GET, POST | Codex-only (400 for any other provider/authType). GET reads available reset credits (`getCodexRateLimitResetCredits`); POST consumes one (`consumeCodexRateLimitResetCredit`) with a server-generated `redeemRequestId` (`crypto.randomUUID()`) to prevent client-controlled replay. Same proxy/refresh/retry-on-auth-expired pattern as the parent route (imports `refreshAndUpdateCredentials` from it). Response codes: success 200, `no_credit` returns 409, unexpected returns 502 (or passthrough 4xx). |

All `usage/*` routes: no in-route auth check beyond middleware default (dashboard-protected `/api/*`).

## 20. Gateway (`/api/v1/**`, `/api/v1beta/**`), one-line table

| Path (client-facing) | Methods | Purpose |
|---|---|---|
| `/v1` | (empty file, 1 line, no route exported) | placeholder/reserved |
| `/v1/api/chat` | OPTIONS, POST | Ollama-compatible chat endpoint |
| `/v1/audio/speech` | OPTIONS, POST | OpenAI-compatible TTS |
| `/v1/audio/transcriptions` | OPTIONS, POST | OpenAI-compatible STT (large upload, 5min timeout) |
| `/v1/audio/voices` | OPTIONS, GET | Internal voices listing, salted self-call |
| `/v1/chat/completions` | OPTIONS, POST | Primary OpenAI-compatible chat completions gateway |
| `/v1/embeddings` | OPTIONS, POST | OpenAI-compatible embeddings |
| `/v1/images/edits` | OPTIONS, POST | OpenAI-compatible image edit |
| `/v1/images/generations` | OPTIONS, POST | OpenAI-compatible image generation |
| `/v1/mcp` | POST | MCP context_status JSON-RPC 2.0 (streamable-HTTP-minimal, single JSON response, no held SSE); auth mirrors chat bearer resolution; loopback-only deployment assumption |
| `/v1/messages` | OPTIONS, POST | Anthropic-compatible messages gateway |
| `/v1/messages/count_tokens` | OPTIONS, POST | Anthropic-compatible token counting (media blocks estimated by pixel count) |
| `/v1/models` | OPTIONS, GET | Model catalog listing |
| `/v1/models/[...kind]` | OPTIONS, GET | Catalog filtered by service kind slug (e.g. `web` covers webSearch+webFetch) |
| `/v1/models/info` | OPTIONS, GET | Extended per-model info |
| `/v1/moderations` | OPTIONS, POST | OpenAI-compatible moderations |
| `/v1/ocr` | OPTIONS, POST | OCR endpoint |
| `/v1/rerank` | OPTIONS, POST | Rerank endpoint |
| `/v1/responses` | OPTIONS, POST | OpenAI Responses API gateway (also reached via `/responses` and `/codex/*` rewrites) |
| `/v1/responses/compact` | OPTIONS, POST | Compacted/summarized Responses variant |
| `/v1/search` | OPTIONS, POST | Web-search tool gateway |
| `/v1/videos/edits` | OPTIONS, POST | Async video edit (xAI Grok Imagine) |
| `/v1/videos/extensions` | OPTIONS, POST | Async video extension (xAI Grok Imagine) |
| `/v1/videos/generations` | OPTIONS, POST | Async video generation (xAI Grok Imagine) |
| `/v1/videos/[id]` | OPTIONS, GET | Poll async video job status |
| `/v1/web/fetch` | OPTIONS, POST | Web-fetch tool gateway |
| `/v1beta/models` | OPTIONS, GET | Gemini-compatible model listing |
| `/v1beta/models/[...path]` | OPTIONS, POST | Gemini-compatible generation gateway (account-lease acquire/release path) |

## Routes whose auth could not be determined

None. Every route examined had either an explicit in-route auth check or a documented, inferable reliance on `dashboardGuard.js`'s deny-by-default middleware for `/api/*`. The only structurally unusual entry is `src/app/api/v1/route.js`, a 1-line file exporting no HTTP method handler (a non-route placeholder file, not an auth gap).
