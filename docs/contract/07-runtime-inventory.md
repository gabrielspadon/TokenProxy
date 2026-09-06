# TokenProxy Runtime Inventory (server/engine only)

Scope: open-sse/, src/lib, src/sse, src/app/api, custom-server.js, cli/. No UI files opened (dashboard/components/page/layout/CSS excluded per hard constraint).

## A. Request lifecycle telemetry

Two independent, differently-gated persistence paths for every request, both fed from saveRequestDetail():
- requestStats (aggregate counters): always written unconditionally, 45-day retention (src/lib/db/repos/requestStatsRepo.js:1 DEFAULT_RETENTION_DAYS = 45), swept opportunistically on writes not by dedicated timer (maybeCleanup, CLEANUP_INTERVAL_MS=5*60*1000). Columns (schema.js): promptTokens, completionTokens, cachedTokens, cacheCreationTokens, reasoningTokens, latencyTotal, latencyTtft -- no cost column.
- requestDetails (full sanitized request/response bodies): opt-in only, default OFF. Precedence in src/lib/db/repos/requestDetailsRepo.js:44 (resolveObservabilityEnabled): OBSERVABILITY_ENABLED env -> ENABLE_REQUEST_LOGS env (legacy) -> settings.enableObservability (default false). Ring-buffered at maxRecords (default 200, requestDetailsRepo.js:6). In-memory write buffer capped at batchSize*10 with oldest-first eviction (requestDetailsRepo.js:107-121, fix for unbounded-growth bug #1245). Redact-then-truncate ordering fix (requestDetailsRepo.js:138-160): redaction runs before the 5KB truncation, else sensitive header values leak into the stored _preview.

Per-request k=v fields (open-sse/handlers/chatCore/requestDetail.js, doneFields): t (total ms), in/out tokens, cr (cache_read), cw (cache_creation), ttft. extractUsageFromResponse normalizes 3 upstream shapes (Claude cache_read_input_tokens/cache_creation_input_tokens, OpenAI prompt_tokens_details.cached_tokens, Gemini cachedContentTokenCount/thoughtsTokenCount).

Token-saver byte ledger (open-sse/handlers/chatCore.js): stages (rtk, schema-distill, thinking-strip, privacy, caveman/ponytail inject, pxpipe, memory ladder, query-aware compression, pair-dropping, embedding reorder, mid-prefix note, cache anchoring) each measured before/after JSON byte size (measureSaverStage). Emits save=stage:delta,... and save_tok (Math.round(sum(delta)/4) -- estimated tokens are bytes/4, not measured). "Saver-guard" flags any stage that grows body >5%.

Cache-epoch (ce=) tracking: per-session bounded map, CE_CAP=2048, CE_TTL_MS=30min, CE_BLOCK_BYTES=64KB, stores per-block SHA1 digests + only the last raw block (not full bodies) to estimate prefix survival between requests.

Cost is never stored per-request -- computed live at query time: pricingRepo.js merges built-in PROVIDER_PRICING with user KV overrides, 5s cache (pricingRepo.js:1-30). currency.js (BASE_CURRENCY="USD") only converts given a caller-supplied rate; explicitly rejects a hardcoded FX rate in comments as "wrong the day after it's written."

Account switching: accountSwitches table (schema.js) is an append-only receipt log -- trigger enum exhaustion|reset|drain|model-failure|initial-pin, windows column stores quota-evidence JSON snapshot deliberately excluding auth tokens or prompt content. sessionAffinity table: sessionHash is a salted hash of client session identity, never raw identity, auth token, or prompt body; expiresAt nullable = no TTL. quotaWindows: remaining/"limit" are REAL absolute units (not %), confidence enum fresh|stale|unknown.

tokenRefreshAnalytics.js (92 lines) is a pure derived view, no new bookkeeping -- reuses getRefreshLeadMs (the same threshold the router itself uses to decide whether to rotate), so status: "due" means "the next request would actually refresh this."

usageProbeGate.js (72 lines): caps concurrent live provider usage-probes at MAX_CONCURRENT_PROBES=4, collapses identical in-flight probe keys onto one call -- added (#3061) because a 30-account dashboard page load previously fired 30 simultaneous TLS handshakes + OAuth refreshes uncapped.

context_status (mcp tokenproxy tool) is backed by open-sse/handlers/chatCore/contextStatusStore.js.

## B. Control surfaces

| Surface | Destructive/irreversible | Notes |
|---|---|---|
| drain (/api/admin/drain[/:id]) | No, reversible | Idempotent POST/DELETE, optional ifMatch optimistic concurrency (412 on mismatch), first drain has no precondition |
| activation/rollback (/api/admin/activation, /rollback) | Rollback reversible (a 2nd rollback undoes the 1st) | Releases become "known" only via activation, no explicit create-release op; rollback walks previousReleaseId chain, 409 no_prior_release if none |
| shutdown (/api/shutdown) | Yes | Dev-only (403 in prod), requires SHUTDOWN_SECRET bearer match, 500ms-delayed exit(0) |
| version/shutdown | Yes | Kills sibling processes (cloudflared/MITM/stray next-server) to release file locks, then exits |
| version/update | Yes, irreversible in-place | Refuses if TOKENPROXY_NO_UPDATE set or not production build; kills siblings, spawnUpdaterAndExit() detached updater, current process exits |
| hotreload (/api/providers/[id]/hotreload) | No | Pokes each model with a 1-token request to roll quota window forward; HOTRELOAD_TIMEOUT_MS=10000, 3 retries, verifies quota moved (USAGE_VERIFY_ATTEMPTS=3) |
| reauth | Guarded | Preserves connection id/priority/binding, swaps auth material only; identity_mismatch 409 requires force=true to rebind different account |
| tunnel enable/disable, tailscale-enable/disable | No | Thin wrappers; enable sleeps DNS_WARMUP_DELAY_MS=8000 before responding (Cloudflare edge DNS propagation) |
| pxpipe start/stop/restart/install | Stop fails open | Not process supervision -- in-process ES module load/unload (loadPxpipe/unloadPxpipe); "stop" fails open to uncompressed passthrough; "install" runs npm install @latest, maxDuration=300 |
| proxy-pools cloudflare/vercel-deploy | Yes, deploys live edge code | Both embed the deployed relay's full source as a JS template literal inside the route file; Vercel variant polls readiness up to 120000ms |
| settings/database (GET/POST) | Yes, full DB overwrite on import | Auth = (valid CLI token OR dashboard JWT) AND correct dashboard password via x-tp-password header |
| catalog-sync, free-sync | No | POST triggers immediate run; catalog-sync POST returns 503 if already running |
| test-batch | No | Sequential per-connection live test loop, filtered by mode |

## C. Persistence

Driver fallback chain (src/lib/db/driver.js): Bun -> bun:sqlite -> sql.js; Node -> better-sqlite3 -> node:sqlite (Node >=22.5) -> sql.js. Each failure is recorded with a reason (note(), driver.js:12-18); sql.js failures get special-cased detail because the Next standalone build trace picks up sql-wasm.js but not the sidecar sql-wasm.wasm (regression #987 -- leaves the whole chain empty if better-sqlite3 also has no prebuilt binary). hardenPermissions() runs after adapter init to un-world-readable the sensitive DB file. runMigrationOnce runs inline inside getAdapter().

Migration model (migrate.js, 125 lines): versioned MIGRATIONS chain (skip-version-safe) + syncSchemaFromTables -- additive-only, auto-creates missing tables/ALTER TABLE ADD COLUMN/indexes every boot, never drops/renames. Pre-schema-change backup gated on SCHEMA_VERSION bump via backupSchemaVersion meta key.

Backup (backup.js, 70 lines): KEEP_BACKUPS=3, BACKUP_EXCLUDE_TABLES=["requestDetails"], uses ATTACH DATABASE to copy tables into a fresh file, chmods to SECRET_FILE_MODE (SQLite attach otherwise creates at umask 0644 despite holding sensitive auth data). No automated restore path -- header comment states recovery is manual only.

In-memory-only state (not in DB): consoleLogBuffer, ceBodies cache-epoch map, sessionCalibration map, usageProbeGate in-flight map, writeBuffer for requestDetails.

CLI runtime install (cli/hooks/sqliteRuntime.js): better-sqlite3 pinned 12.10.1, installed lazily into USER_DATA_DIR/runtime/node_modules (not global npm) to dodge Windows EBUSY locks during npm i -g updates; gated by a hardcoded supported-Node-majors set ({20,22,23,24,25,26}) read from the pinned package's own engines field, to avoid burning the whole install timeout on a build that can't succeed on e.g. Node 18/21.

## D. Security model

custom-server.js refuses to boot without JWT_SECRET (requireJwtSecret(), enforced at entry, not lazily). INITIAL_PASSWORD defaults to "123456" (dashboardSession.js). API_KEY_SECRET fallback hardcoded literal "endpoint-proxy-api-key-secret" (src/shared/utils/apiKey.js:17). MACHINE_ID_SALT fallback hardcoded literal 'endpoint-proxy-salt' (src/shared/utils/machineId.js:50).

/api/auth/login deliberately withholds the JWT on a fresh-install default-password login from a non-local client, comment references preventing a "CVE-2026-56679 class" attack chain; rate-limited via checkLock/recordFail/recordSuccess keyed by client IP.

Cookie: auth_token is httpOnly: true, secure conditional on shouldUseSecureCookie(request), sameSite: "lax".

IP trust (custom-server.js): derives x-tp-real-ip from the raw TCP socket address; only trusts client-supplied x-forwarded-for/x-real-ip when the socket peer itself is loopback; strips/overwrites all x-tp-* headers from the client; stamps a per-process random PEER_TOKEN to internally prove x-tp-real-ip was set by the wrapper itself, not spoofed.

SSRF guard (src/shared/utils/ssrfGuard.js): blocks loopback/private/link-local/CGNAT/documentation/multicast/reserved IPv4 ranges plus .internal/.local/.localhost hostname suffixes for server-side fetches; used by OIDC discovery/token-exchange (src/lib/auth/oidc.js:4 imports assertPublicUrl).

customAdapters.js:172 -- explicit comment warning that custom adapters must never read process.env, because it could leak JWT_SECRET/API_KEY_SECRET to an attacker-controlled baseUrl.

No Content-Security-Policy header found anywhere in server source (only a false-positive string match inside a minified Next.js HTTP-cache chunk).

## E. Background jobs and timers

- backgroundTokenRefresh.js: 5-min tick (DEFAULT_INTERVAL_MS), 30-min lead-time OAuth refresh (BACKGROUND_REFRESH_LEAD_MS), 10s initial delay.
- initializeApp.js: 60s watchdog (unref()'d) for tunnel/tailscale health; network monitor does IPv4-fingerprint diffing + sleep/wake detection via elapsed-tick heuristic + real TCP reachability probe to 1.1.1.1:443.
- freeModelSync.js: idempotent stop+reconfigure, immediate first pass + fixed-cadence hourly setInterval, unref()'d.
- usageProbeGate.js: not a timer, but a standing per-process concurrency ceiling (4) on live provider probes.
- Per-adapter WAL checkpoint timers (referenced in driver adapters, not fully enumerated here).

CLI launcher (cli/cli.js, 1083 lines) supervises the server as a child process, not the tray: spawnServer() (cli.js:752) spawns RUNTIME with --dns-result-order=ipv4first + resolved heap flags, port passed via PORT env. Startup ownership is verified via probeExistingRouter/waitForPortRelease/waitServerReady (TCP-poll, not fixed sleep) before claiming a port -- refuses to steal a port already held by a non-TokenProxy process. tokenproxy stop kills by port (killProcessOnPort, platform-specific: netstat+findstr on Windows, lsof -ti on Unix). Tray (cli/hooks/trayRuntime.js) is a separate, optional, lazily-installed component: Windows uses PowerShell NotifyIcon (no binary); macOS/Linux lazily npm-installs systray2@2.1.4 into USER_DATA_DIR/runtime/node_modules at first use (kept out of the published tarball to dodge AV false-positives on the older systray package's bundled 2017 Go binary, which also fails to load on Apple Silicon macOS 14+ dyld). Log supervision: crash-sync reporting via fs.writeSync+Atomics.wait in custom-server.js.

appUpdater.js (228 lines): isUpdateDisabled() reads TOKENPROXY_NO_UPDATE (any truthy value except "0"/"false"), consulted identically by both the version banner and the updater route so a pinned install can't have its pin silently ignored by one path (#1563 fix). Kill-then-relaunch sequence has explicit Windows (taskkill -> PowerShell Stop-Process fallback) vs. Unix (sudo -n kill -9 -> process.kill fallback) branches, and separately force-kills a MITM helper process that may be running as root/admin via its own PID file.

## F. Provider registry facts

open-sse/providers/registry/*.js: 143 provider files. category field distribution: apikey 88 (some inconsistently single-quoted, 4 files), oauth 21, freeTier 21, free 6, webCookie 2 -- i.e. two different string spellings ("free" vs "freeTier") coexist for the free-tier concept, and category string-literal quoting style is inconsistent across files.

Each registry entry shape (from anthropic.js): id, priority, alias, display (name/icon/color/textIcon/website/notice.apiKeyUrl), category, transport (baseUrl, format, headers), models (id/name array -- static list, not fetched), serviceKinds (e.g. ["llm","imageToText"]).

open-sse/config/providerModels.js (126 lines): PROVIDER_MODELS is built from the registry (transport + models co-located), not a separate source of truth. findModel() tolerates dash/dot version-separator variants only for a hardcoded allowlist (DOT_VERSION_PROVIDERS = new Set(["kr","kiro"])) and strips a trailing "(level)" thinking-effort suffix before lookup.

open-sse/executors/: 31 executor files (one per distinct provider integration strategy -- azure, cursor, vertex, github, ollama-local, windsurf, qoder, codex, kiro, xai, gemini-cli, antigravity, opencode/-zen, devin/-cli, trae, zed, etc.) plus base.js/default.js/index.js.

open-sse/translator/formats.js: FORMATS constant + detectFormatByEndpoint(pathname, body) -- translator pairing is endpoint-driven format detection, not a fixed pair table.
