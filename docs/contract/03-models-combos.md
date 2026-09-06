# Models & Combos HTTP contract

Scope: `src/app/api/models/**`, `src/app/api/combos/**`, `src/app/api/v1/models*`, `open-sse/config/providerModels.js`, `open-sse/services/combo.js`.

## Auth guard

`src/dashboardGuard.js:94-95` lists `/api/combos` and `/api/models` in `PROTECTED_API_PATHS` (dashboard-auth-gated, not `ALWAYS_PROTECTED`). `/api/v1/*` is in `PUBLIC_PREFIXES` (`src/dashboardGuard.js:53`) — API-key auth inside the handler, not the dashboard JWT/session gate. `ALWAYS_PROTECTED` check at line 299; deny-by-default for `/api/*` at line 333.

## Route inventory

```
src/app/api/models/route.js                       GET, PUT
src/app/api/models/alias/route.js                 GET, PUT, DELETE
src/app/api/models/availability/route.js          GET, POST
src/app/api/models/catalog-sync/route.js          GET, POST
src/app/api/models/custom/route.js                GET, POST, DELETE
src/app/api/models/disabled/route.js              GET, POST
src/app/api/models/free-sync/route.js             GET, POST
src/app/api/models/new/route.js                   GET
src/app/api/models/new/acknowledge/route.js        POST
src/app/api/models/test/route.js                  POST
src/app/api/models/test/ping.js                    (helper, not a route)
src/app/api/combos/route.js                        GET, POST
src/app/api/combos/default-model/route.js          GET
src/app/api/combos/export/route.js                 GET
src/app/api/combos/import/route.js                 POST
src/app/api/combos/suggest/route.js                GET
src/app/api/combos/test/route.js                   POST
src/app/api/combos/[id]/route.js                   GET, PATCH/PUT, DELETE
src/app/api/combos/[id]/test/route.js               POST
src/app/api/v1/models/route.js                     GET
src/app/api/v1/models/[...kind]/route.js            GET
src/app/api/v1/models/info/route.js                 GET
```

---

## `GET /api/models` — `src/app/api/models/route.js:9-45`

Response `200`: `{ models: [...] }`, each entry = `AI_MODELS` row spread plus:
- `fullModel`: `"<provider>/<model>"` (line 21)
- `routedModel`: `"<providerAlias>/<model>"` via `getProviderAlias(m.provider)` (22-23)
- `alias`: `modelAliases[fullModel] || m.model` — falls back to model id if unaliased (29)
- `caps`: `{ vision, search, reasoning, contextWindow, maxOutput }` from `getCapabilitiesForModel` (`open-sse/providers/capabilities.js`, line 24,30-36)

Disabled-model ids (`getDisabledModels()`, `@/lib/disabledModelsDb`) are excluded pre-map (14-19); lookup tries provider alias then raw provider (16-17). `500`: `{ error: "Failed to fetch models" }` (43).

## `PUT /api/models` — `route.js:48-76`

Body `{ model, alias }`, both required. `400 { error: "Model and alias required" }` if missing (54); `400 { error: "Alias already in use" }` if alias maps to a different model (60-66); `200 { success: true, model, alias }` via `setModelAlias(model, alias)` (69-71); `500 { error: "Failed to update alias" }` (74). No validation that `model` is a real/known id.

## `/api/models/alias` — `src/app/api/models/alias/route.js`
- `GET` (7-15): `200 { aliases }` (raw kv map, key=alias). `500 { error: "Failed to fetch aliases" }`.
- `PUT` (17-33): body `{ alias, model }`, same collision check as above.
- `DELETE` (35-53): body `{ alias }`. `200 { success: true }` via `deleteModelAlias`.

Storage: `src/lib/db/repos/aliasRepo.js:5,10-16` — flat KV table `modelAliases` (`makeKv`, `src/lib/db/helpers/kvStore.js`), key=alias, value=`"provider/model"` string, no FK, any string accepted (comment line 9).

---

## `/api/models/availability` — `src/app/api/models/availability/route.js` (121 lines)

`GET`: per-connection model locks/cooldowns. Lock keys `modelLock_<model>` (7,10-17) / `modelFailure_<model>` (8); bare `modelLock_` (no suffix) = `__all` lock (16). `until` = epoch-ms; active only while `until > Date.now()` (11-13) — **expired lock is absent from output, not present-with-past-timestamp**. `POST`/cooldown-clear (91-120): `200 { success: true }`, `500 { error: "Failed to clear cooldown" }`.

## `/api/models/catalog-sync`

`GET` (7-20): `200 { ...syncState, catalog }`. `syncState` = `getSyncState()` (`src/lib/modelCatalog/sync.js:58-61`): `{ running, lastSync, lastError, lastResult, etag, scheduled, file, url, intervalMs }`, `scheduled = !!timer` (60). `catalog` = `null` if `CATALOG_FILE` unreadable/unparseable (swallowed), else `{ syncedAt, models }`.

`g` singleton (`sync.js:46-47`, `globalThis.__modelCatalogSync`): `{ running:false, lastSync:null, lastError:null, lastResult:null, etag:null, timer:null }`. **`lastError:null` means never-run OR last-run-succeeded** (220-221 clears on success) — no separate success flag.

`POST` (24-31): `syncModelCatalog()`; if `g.running`, returns `null` (sync.js:184-185) → route `503 { error: g.lastError || "sync in progress" }`. Else `200 { success: true, result }`.

---

## `/api/models/custom` — `src/app/api/models/custom/route.js`

`GET` (8-16): `200 { models }` via `getCustomModels()`. `POST`: adds a custom model, then `refreshModelCapabilityOverrides()` (import line 3) — capability-cache invalidation on every mutation. `DELETE` (~120-144): batch delete, `{ deletedCount, failed, results }` (137-139) — **partial-failure-tolerant, no all-or-nothing transaction**; `500` only on a thrown exception, not per-item failure.

Storage: `src/lib/db/repos/aliasRepo.js:6,22-30` — KV table `customModels`, key = `` `${providerAlias}|${id}|${type}` `` (23-24, composite key disambiguates same id across providers/types). `getCustomModels()` = `Object.values(all)` (29), order not guaranteed.

## `/api/models/disabled?providerAlias=xxx[&connectionId=yyy]`

`GET` (comment 6-8): with `connectionId`, returns that account's own disabled set, **falling back to provider-wide only while the account was never edited** (#1527) — explicit empty edit ≠ never-touched. `POST` (~40-55): `enableModels(...)` target can be `null` (`?? null`, ~49) — null vs id distinguishes provider-wide vs account-scoped mutation. `200 { success: true }`, `500 { error: "Failed to enable models" }`.

Storage: `@/lib/disabledModelsDb` (`getDisabledModels`, `getDisabledByProvider`, `disableModels`, `enableModels`); repo file not traced.

---

## `/api/models/free-sync`

`GET` (10-18): body = `getFreeModelSyncStatus()` (`src/shared/services/freeModelSync.js:215-233`), unwrapped:
```
{ config: {enabled, intervalHours, autoComboIds, ...},  // normalizeFreeModelSyncConfig, 33-39
  running, lastRunAt, lastError,
  targets: [{ id, alias, url, type }],
  providers: { [providerId]: { ids, count, updatedAt } } }
```
`autoComboIds` filtered to strings only (37) — non-strings dropped silently.

`POST` (20-29): `runFreeModelSync()` (freeModelSync.js:106-188). Re-entrancy: `g.running` → `{ skipped: true, reason: "already-running", lastRunAt }` with **HTTP 200** (107-109) — skip reported as success, caller must check `skipped`. Per-target failures isolated (103-105, fail-open) — one dead provider never blocks others.

---

## `/api/models/new`

`GET` (full file, 127 lines): discovers unacknowledged newly-seen models via `reconcileSeenModels`/`getUnseenModels`/`countUnseenModels` (`@/models`), cached via `@/lib/newModelsCache`. Error path (120-125): `500 { error: "Failed to discover models", groups: [], total: 0, totalUnseen: 0, seeded: false }` — **error body still carries full success-shape with zero/empty defaults**, not a bare `{error}`. `seeded:false` on error; a genuine first-run bootstrap sets `seeded:true` to suppress the delta as noise (header-comment intent, unverified past line 120).

## `/api/models/new/acknowledge`

`POST` (full file, 29 lines): body optional `{ items: [{ providerAlias, modelId }] }`. **No `items` = acknowledge ALL unseen** ("mark all read", line 9). Malformed JSON silently degrades to `items=null` (12-16 swallowed) → same "acknowledge all" behavior. Calls `clearCache()` after. `200 { ok: true }`, `500 { error: "Failed to acknowledge models" }`.

---

## `/api/models/test` — `src/app/api/models/test/route.js` (41 lines)

`POST` body `{ model, models, kind, prompt }`. `400 { error: "Model required" }` if neither given (13-15). Single mode: `pingModelByKind(model, kind||"llm", undefined, userPrompt)` result returned as-is. Batch mode (`models` array): **sequential, not parallel** — a burst trips the shared upstream's rate limiter (comment 6-8). Response: `{ results: [{model, ok, latencyMs, error, status, preview?}], ok: results.every(r=>r.ok) }` — per-item ping errors caught individually (32-34), never fail the whole batch. `userPrompt` empty/blank → `null`, triggering `pingModelByKind`'s built-in probe (doubles as playground compare tool, #3438/#3140). Uncaught: `500 { ok: false, error: err.message }`.

`pingModelByKind` (`ping.js:58`, signature-level read) returns `{ ok, latencyMs, error, status, preview? }` uniformly across llm/embedding/image/transcription kinds (return sites: 76,80,82,99,104,106,128,133,135,162,203,216). `error` is `null` on success, string on failure; `preview` success-only, kind-specific content.

---

## Combo storage

`src/lib/db/schema.js:100-109` table `combos`: `id TEXT PK`, `name TEXT UNIQUE NOT NULL`, `kind TEXT` (nullable: llm/webSearch/webFetch), `models TEXT NOT NULL` (JSON array), `createdAt`/`updatedAt TEXT NOT NULL`. Index `idx_combo_name`.

Repo `src/lib/db/repos/combosRepo.js` (79 lines): `rowToCombo` (10-20) parses `models` via `parseComboModels` (5-8) = `parseJson(value, [])`, non-array result coerced to `[]` — malformed JSON never throws, degrades to empty combo. `getCombos` (22), `getComboById` (28), `getComboByName` (34), `createCombo` (40, `uuidv4()` id), `updateCombo` (58, merges partial data), `deleteCombo` (74, bool from `changes > 0`).

## `/api/combos`

`GET` (11-19): `200 { combos }`. `POST` (21-59): body `{ name, kind?, models }`. Name regex `VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/` (line 8); duplicate name rejected (`getComboByName`); cycle check via `validateComboAcyclic` (`open-sse/services/combo.js`, import line 3) before insert. `201` full combo object (54). `500 { error: "Failed to create combo" }`.

## `/api/combos/[id]` — `src/app/api/combos/[id]/route.js`

`GET`: `404` if `getComboById` null, else `200` combo. `PATCH`/`PUT`: `updateCombo`, re-validates name regex+uniqueness if changed, re-runs `validateComboAcyclic`, then `resetComboRotation(id/name)` (import line 3) so an edited models-array takes effect immediately rather than continuing stale rotation. `DELETE` (~90-102): `200 { success: true }`, `500 { error: "Failed to delete combo" }`.

---

## Combo chain resolution & cycle detection — `open-sse/services/combo.js`

- `buildComboMap(combosData)` (572-578): `Map<name, combo>`, accepts raw array or `{combos:[...]}` wrapper (`normalizeCombosData`, 568-570); entries without a string `name` filtered silently.
- `resolveComboReference(modelStr, comboMap)` (580-586): a combo's `models` entry may itself be a combo name — direct match first, else if provider-prefixed (`"alias/name"`), matches the part after the last `/` (584-585) — `"combo/my-fallback"` resolves same as bare `"my-fallback"`.
- `findComboCycle(combosData, startName)` (588+): DFS with `visited` set + `path`, returns the cycle if found (backs `validateComboAcyclic`) — no transitive self-reference allowed.

## Fallback / rotation strategies

`getRotatedModels(models, comboName, strategy, stickyLimit=1)` (333+): `"fallback"` (default, order unchanged, always starts index 0) or `"round-robin"` (rotates via in-memory per-combo state). Guard (334): `models.length<=1` or `strategy !== "round-robin"` → array returned unchanged — **fallback IS the no-op path**, same code branch as any unrecognized strategy string.
- `normalizeStickyLimit` (311-314): `parseInt`, falls back to `1` if not finite or `<=0` — **invalid input silently coerced, never rejected**.
- `rotateModelsFromIndex` (316-323): array rotation, shifts N from front to back.
- Rotation state keyed `comboName || "__default__"` (387) — unnamed/ad-hoc tests share one global slot.
- `resetComboRotation(comboName)` (435): omit name to clear ALL combos' state.
- Third strategy `"fusion"` (validated in `combos/import/route.js:11`) is NOT dispatched via `getRotatedModels` — routes through `handleFusionChat` (1041+) instead: parallel panel query then `judgeModel` synthesizes one answer (entry gate only, 1042-1052 read). Single-member panel answers directly, no judge call (1051-1052). Empty panel: `400 { error: { message: "Fusion combo has no models" } }` (1044-1047).

`handleComboChat({body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit=1, autoSwitch=true})` (693+): rotates, then if `autoSwitch` (default true) floats capability-satisfying models to front via `detectRequiredCapabilities` (230+) — **auto-switch runs AFTER rotation**, can override round-robin order per-request. Iterates order calling `handleSingleModel`; failure parsing (~776) extracts `retryAfter` from upstream error body.

---

## Test/preview endpoints (dry-run, no persistence)

`POST /api/combos/[id]/test` (142 lines): body `{ prompt?, mode?: "fallback"|"all" }`. Uses `peekRotatedModels` — previews order WITHOUT mutating rotation state (peek vs mutating `getRotatedModels`). `mode:"all"` pings every member; default `"fallback"` presumably stops at first success (unverified past line 135). `totalLatencyMs` = `steps.reduce((a,b)=>a+(b.latencyMs||0),0)` (~134) — **missing `latencyMs` treated as `0`, step not excluded**. `500 { error: "Failed to test combo execution" }`.

`POST /api/combos/test` (124 lines): ad-hoc variant, body `{ name?, models: string[], kind?, prompt?, mode? }` — no DB row required. Same `totalLatencyMs`/`steps` shape and `peekRotatedModels` mechanics.

---

## `GET /api/combos/suggest` (119 lines)

Builds a suggested fallback chain from available models, tiered via `classifyModel`/`splitModelId` (`@/shared/services/modelTiers.js`). Calls `buildModelsList` and `GET as getAvailability` (from `/api/models/availability/route.js`) as direct function imports, not HTTP — filters cooldown/locked models. `200 { suggested: [...limit-capped], tiers, counted: classified.length }` (~113). `500 { error: "Failed to suggest a combo" }`.

## `GET /api/combos/default-model` (66 lines)

Picks a starting model for a new combo, skipping cooldown/unavailable per `availability` (#2114). No candidate: `200` (not error) `{ model: null, reason: "no-available-model" }` (~58-60) — **`model:null` is a valid response, not a failure**; caller checks `reason`. `500 { error: "Failed to pick a default model" }`.

## `GET /api/combos/export` (50 lines)

Raw JSON file download (`Content-Disposition: attachment; filename="combos-export.json"`, ~42), not `NextResponse.json`. Body: `{ version: 2, exportedAt, ...(capacityAdapter conditional spread), combos, comboStrategies }`. `comboStrategies = settings?.comboStrategies || {}` (13) — **missing settings key exports as `{}`**. `capacityAdapter = settings?.capacityAdapter || null` (14), spread only when truthy (~19) — **`null` capacityAdapter is OMITTED from export, not exported as `null`** (inconsistent with `comboStrategies`' `{}` default).

## `POST /api/combos/import` (187 lines)

Validates the entire batch before any write (fail-closed, all-or-nothing): `VALID_NAME_REGEX` (9), `VALID_KINDS=["llm","webSearch","webFetch"]` (10), `VALID_STRATEGIES=["fallback","round-robin","fusion"]` (11), `VALID_CAPACITY_KEYS=["vision","pdf","audioInput","videoInput"]` (12). Per-item (~90-115): duplicate name within batch (`nameSet`, 96-97) → `400`; invalid `kind` (99-101) → `400 Combo <idx>: invalid kind "<kind>"`; `models` not array (103-105) → `400`; `roundRobin` not boolean (107-109) → `400`; `strategy` not in `VALID_STRATEGIES` (111+) → `400`. Any failure aborts with nothing written. Success: `201 { success: true, count: body.combos.length }` (~182). `500 { error: "Failed to import combos" }`. Writes go through `getAdapter()`/`stringifyJson` directly and `updateSettings` — **bypasses `combosRepo`**, unlike the CRUD routes above.

---

## Model catalog — `open-sse/config/providerModels.js` (127 lines)

Exports (signatures only): `getProviderModels(aliasOrId)`, `getDefaultModel(aliasOrId)` → `models?.[0]?.id || null` (15-18, **unknown provider and known-but-empty provider both return `null`, indistinguishable**), `isValidModel(aliasOrId, modelId, passthroughProviders=Set())`, `findModelName`, `getModelTargetFormat`, `getModelSupportedFormats`, `getModelType`, `getModelUpstreamId`, `getModelQuotaFamily`, `getModelStrip(alias, modelId)` → array of content types to strip e.g. `["image","audio"]`, opt-in per-model (122-126).

`PROVIDER_MODELS` (re-exported from `open-sse/providers/index.js:4`): keyed by provider alias/id → array of model entries (`id`, `name?`, `upstreamModelId?`, `capabilities?`, `contextWindow?`, `params?`, `options?`, `dimensions?`, inferred from `v1/models/info/route.js:22-63` consumers, no schema file found).

`OAUTH_ALIASES` (108-110): `Object.fromEntries` over `REGISTRY` where `r.alias && r.alias !== r.id` — short OAuth aliases, single source; providers with `alias===id` (vertex/vertex-partner, comment 107) absent from map, callers fall back `|| id`.

`findModel` (25-43): dash/dot version tolerance for `kiro`/`kr` (`DOT_VERSION_PROVIDERS`, 23) — `claude-sonnet-4-5` normalizes to match registry `claude-sonnet-4.5` for those two providers only.

Display metadata: `src/shared/constants/models.js` (47 lines, full) re-exports the above plus `AI_MODELS` (36+, legacy flat array via `Object.entries(MODELS).flatMap(...)`, backward-compat — what `/api/models GET` maps over) and `MODEL_KIND_META` (icon/label/desc/color per capability: vision, reasoning; `search` present in data but commented "temporarily hidden, not wired yet", line 45).

`getSyncTargets()` (`src/shared/services/freeModelSync.js:53-101`): filters registry to public free-tier catalogs plus OAuth providers whose `modelsFetcher.type` is `"*-free"`-flavored (41-43). `providerAlias(target)` maps to display alias used in `targets[].alias`.

---

## `/v1/models*` — OpenAI-compatible surface (public prefix)

`GET /v1/models` (792-899): calls `buildModelsList([LLM_KIND], {thinkingVariants:true})` (794). Anthropic-protocol clients (Claude Code) filter ids by `/(claude|anthropic)/i`; ids get rewritten with `claude-` prefix for those clients (796-800) — **same catalog, different `id` strings by request header**, not a different model set. `500`: `{ error: { message, type: "server_error" } }`; proxy-unavailable errors pass through their own `status`/`code` (~892).

`buildModelsList(kindFilter, {thinkingVariants=false})` (277-777): reads provider connections; only a genuine store-read failure (not "zero connections") falls open to the static full catalogue (279-284, regression #1861 — previously any empty-connections state served every model of every provider, unusably). Combos listed FIRST (366+), filtered by `comboMatchesKinds`. Combo entry: `{ id: combo.name, object:"model", owned_by:"combo" }` (369-373) plus `kind` ONLY for webSearch/webFetch combos (374-376) — **plain LLM combo has no `kind` field at all**, not `kind:"llm"`. LLM combo `contextWindow` = MINIMUM across members (377-378, "pool bottleneck" — weakest member wins, not max/average). `settings.exposeComboOnly` (~445): true suppresses individual provider models entirely, only combos remain.

`GET /v1/models/[...kind]` (91 lines, full): dual purpose. (1) kind slug (`KIND_SLUG_MAP`, 5-14: `image`,`tts`,`stt`,`embedding`,`ocr`,`moderation`,`image-to-text`→`imageToText`,`web`→`["webSearch","webFetch"]`) → `{ object:"list", data: buildModelsList(kindFilter) }` (73-76). (2) any other slug is looked up as a model id against the full catalog by exact match or trailing-segment match (56) — added because a kind-slug 404 previously shadowed OpenAI's `GET /v1/models/{model}` convention (#3588/#3649); a kind slug always wins over a same-named model id. No match: `404 { error: { message: "Unknown model or kind: <slug>. Supported kinds: ...", type: "invalid_request_error" } }`.

`GET /v1/models/info?id={alias}/{modelId}&kind=` (164 lines, full): `kind` disambiguates when the same id string exists under two kinds (e.g. `gemini-2.5-pro` as llm and stt, comment 67). `400` if `id` absent (149-153); `404 { error: { message: "Model not found: <id>", type: "not_found" } }` (156-160). Lookup order (`lookup()`, 68-136): (a) `PROVIDER_MODELS[alias]` exact match; (b) virtual `search`/`fetch` ids from `providerInfo.searchConfig`/`fetchConfig` (86-98); (c) custom models matched on `id`+`providerAlias`+optional `type` (100-108) — **DB read failure for custom models swallowed** (101-103 try/catch), contributes nothing rather than erroring, falls through to 404. `buildInfo()` (22-64): `upstreamModelId` emitted ONLY when it differs from exposed `id` (36-38, #2872) — absence means they're equal, not "unknown". Custom-model `contextWindow`/`maxOutput` only included when stored value is `Number.isInteger(x) && x>0` (112-117) — non-positive/non-integer dropped entirely, not emitted as `0`.

---

## Null-vs-absence / zero semantics (cross-cutting)

| Location | Field | Meaning |
|---|---|---|
| `models/availability/route.js:11-17` | lock entry | expired → absent from list, not past-timestamp-present |
| `lib/modelCatalog/sync.js:47,220-221` | `lastError:null` | never-run OR succeeded; no separate success flag |
| `models/new/route.js:120-125` | 500 body | still `groups:[],total:0,totalUnseen:0,seeded:false` — shape-complete, not bare `{error}` |
| `models/disabled/route.js:6-8` | account disabled set | absent(never-edited) falls back provider-wide; empty-array ≠ absent |
| `models/free-sync` skip | `skipped:true` | HTTP 200, not 409/503 |
| `combo.js:333-336` | fallback strategy | same code path as unrecognized strategy string |
| `combo.js:311-314` | invalid `stickyLimit` | coerced to 1, never rejected |
| `combos/default-model:~58-60` | `model:null` | valid "no candidate" response, HTTP 200 |
| `combos/export:13-19` | `comboStrategies` vs `capacityAdapter` | missing → `{}` for one, key OMITTED for other |
| `providerModels.js:15-18` | `getDefaultModel→null` | unknown provider and empty provider indistinguishable |
| `v1/models/info:36-38` | `upstreamModelId` absent | equals exposed id, not "unknown" |
| `v1/models/info:112-117` | custom `contextWindow`/`maxOutput` | non-positive-int stored value → key dropped, not `0` |
| `v1/models/route.js:369-376` | combo `kind` field | plain LLM combo → absent entirely, not `"llm"` |
| `v1/models/route.js:377-378` | combo `contextWindow` | MINIMUM across members, not max/avg |
