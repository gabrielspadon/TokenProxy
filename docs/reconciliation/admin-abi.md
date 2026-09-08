<title>TokenProxy admin ABI</title>

Companion to `admin-abi.json`. That file is the frozen OpenAPI contract; this
file explains why each endpoint exists and where the failure boundary sits.
Nothing here changes runtime behavior. Both files are specification, written
before any `/api/admin/**` route exists.

## Why this ABI, why now

RECONCILIATION.md's Ownership Boundary moves qualification, quota, drain,
activation and rollback state behind TokenProxy while leaving activation and
drain *command* as thin `ai-dotfiles` operator wrappers. A wrapper can only
stay thin if the surface it calls is fixed before it is written, so this ABI
is frozen in Phase 0 (`RECONCILIATION.md` Phase 0 step 4) ahead of the Phase 1
to Phase 3 implementation leaves. Every later leaf codes against this
document, not against whatever a first implementation attempt happens to
produce.

## Endpoint rationale

| Endpoint | Why it exists | Capability matrix row served |
|---|---|---|
| `GET /api/admin/health` | Cheap liveness for the admin ABI process itself, the thing an edge health check polls before trusting any other admin call. | Native connection qualification (P0) |
| `GET /api/admin/health/detail` | Readiness: database reachability plus per-provider degraded-account counts, passive only. Gives an operator wrapper one aggregate view instead of polling qualification per connection. | Native connection qualification (P0) |
| `GET /api/admin/models` | The canonical model catalog an edge caller needs before it can even choose what to route, trimmed to routing fields (model, provider, fullModel, caps) rather than the dashboard's alias-management shape. | Harness cutover contract (P0), read by every later request |
| `GET /api/admin/qualification` | Status, activity and drain flag across every connection in one call, the summary an operator dashboard renders. | Native connection qualification (P0) |
| `GET /api/admin/qualification/{connectionId}` | Full passive detail for one connection: last status, last generation evidence, last quota snapshot. Never touches the provider. | Native connection qualification (P0) |
| `POST /api/admin/qualification/{connectionId}/recheck` | The one endpoint that spends a real generation to prove a connection currently works, not just that it worked at some past `checkedAt`. | Native connection qualification (P0), Model availability evidence (P2) |
| `GET /api/admin/quota` / `GET /api/admin/quota/{connectionId}` | Normalized quota-window evidence in exactly the `WindowRecord` shape Account Scheduling Contract rule 1 specifies, so the ranking in rule 3 has one evidence source instead of per-provider parsing at the edge. | Compound quota account ordering (P0) |
| `GET /api/admin/drain` | Which connections are currently excluded from selection, and why, before an operator decides to widen or narrow a drain. | Activation, draining and rollback command (ownership boundary row) |
| `POST /api/admin/drain/{connectionId}` | Stop new selection onto a connection immediately while its in-flight streams finish, the drain half of the restart-and-drain acceptance test. | Activation, draining and rollback command; Restart and drain acceptance test |
| `DELETE /api/admin/drain/{connectionId}` | Resume eligibility. Symmetric to the POST so an operator wrapper never needs a second shape to undo a drain. | Activation, draining and rollback command |
| `GET /api/admin/activation` | The active release and recent history, what a rollback wrapper reads before deciding a target. | Harness cutover contract (P0) |
| `POST /api/admin/activation` | The state transition TokenProxy owns per the ownership boundary: an operator wrapper names a release, TokenProxy decides whether it is safe to make active. | Harness cutover contract (P0); Restart and drain acceptance test |
| `POST /api/admin/rollback` | Return to the prior healthy release without the wrapper needing to track release history itself; `previousReleaseId` on `Release` carries that state. | Restart and drain acceptance test |
| `GET /api/admin/receipts` / `GET /api/admin/receipts/{receiptId}` | The durable, credential-safe record of every account switch, Account Scheduling Contract rule 8. This is what an operator or an incident review reads instead of reconstructing a switch from logs. | Compound quota account ordering (P0); Privacy acceptance test |

## Auth and mutation boundary

Every read is `operator`-class except `/api/admin/health` and
`/api/admin/models`, which stay `inference`-class because an edge caller needs
them before it has done anything operator-scoped, mirroring how
`PUBLIC_PREFIXES` already lets an inference key reach `/v1/**` without a
dashboard session (`src/dashboardGuard.js:46,164`). Every state-changing
endpoint is `operator`-class and loopback-bound, mirroring the existing
`ALWAYS_PROTECTED` gate (`src/dashboardGuard.js:49-54,230-241`) rather than the
weaker `requireLogin=false` escape hatch `PROTECTED_API_PATHS` allows, because
these endpoints move account, quota and release state the way
`ALWAYS_PROTECTED` routes move credentials and process lifetime today.

## Failure direction, state-changing endpoints

Three shapes recur across every mutation. Naming them once here keeps five
endpoint specs from repeating the same three paragraphs.

**Malformed body.** A field present with the wrong type, or an unrecognized
field, is `400` before any state read. `POST recheck` rejects a non-boolean
`force`. `POST` and `DELETE drain` reject a non-string `ifMatch`. `POST
activation` rejects a missing or non-string `releaseId`. `POST rollback`
rejects a non-string `toReleaseId`.

**Stale precondition.** Every mutation that changes a value with a version
field takes `ifMatch` and answers `412` with `currentVersion` in the body when
it does not match, changing nothing. Drain, activation and rollback all carry
this: a caller that read a connection or release once and acts on it later
must re-read before it can succeed, closing the same race the Atomic admission
acceptance test names for request-level selection, applied here to
operator-level state.

**Concurrent conflicting write.** Two operators racing the same mutation
never both win silently. `POST recheck` answers `409 recheck_in_progress` to
the second caller rather than spending two generations concurrently against
one connection. `POST activation` and `POST rollback` resolve the race through
`ifMatch`: the loser's version no longer matches after the winner's write, so
it gets `412`, not a silent overwrite. `POST rollback` additionally answers
`409` when there is no `previousReleaseId` on file and no explicit
`toReleaseId`, which is a missing target rather than a race but shares the
same "state is unchanged, retry with better information" shape.

Every one of these three responses is a `4xx` returned before the
transaction, matching `adminMutationPolicy.byteIdenticalOnRejection` in the
JSON: a caller that read quota, drain, activation or rollback state
immediately before and immediately after a rejected call reads back the exact
same bytes.

## Existing `src/app/api/**` routes this ABI supersedes or extends

| Existing route | Relationship |
|---|---|
| `GET /api/health` | Untouched. It is the Dockerfile `HEALTHCHECK` and stays `{ok:true}` on purpose (`src/app/api/health/detail/route.js` comment, "WHY NOT /api/health ITSELF"). `/api/admin/health` is a new, separate liveness surface for admin-ABI callers, not a replacement. |
| `GET /api/health/detail` | Extended. Same readiness judgment (database reachability, per-provider degraded counts), same operator gate shape (`hasValidCliToken` or a dashboard JWT), projected onto `/api/admin/health/detail` for the admin-ABI audience. The dashboard keeps calling its own route; nothing is deleted yet. |
| `GET /api/models` | Extended. `/api/admin/models` is a trimmed routing-only projection (model, provider, fullModel, caps) of the same catalog `/api/models` already serves with alias and disabled-model management the admin ABI does not need. |
| `GET /api/system/state` | Extended in the direction its own header comment names as missing: "Quota headroom remains absent because no authoritative quota table exists." `/api/admin/quota` is that authoritative source. `/api/system/state` keeps owning rolling traffic metrics; it is not superseded, only relieved of a gap it already declared out of scope. |
| `GET /api/usage/{connectionId}` | Superseded for quota reads. This route calls `deriveQuotaSnapshot` (`src/shared/utils/quotaPause.js`) inline as one part of a larger refresh-and-report handler; `/api/admin/quota/{connectionId}` is the same evidence, normalized to the `WindowRecord` contract Account Scheduling Contract rule 1 requires, as its own endpoint. The existing route keeps its refresh and credential-update responsibilities, which stay out of this ABI. |
| `POST /api/providers/{id}/test` | Superseded. This is today's single-connection active probe. `POST /api/admin/qualification/{connectionId}/recheck` is its native ABI replacement, with the `force`, `409 recheck_in_progress`, and structured `QualificationDetail` response this route does not have. Per Phase 3 step 5, the old route is deleted only once the native path has a test and an end-to-end receipt; until then it keeps working, called by the dashboard directly rather than through this ABI. |
| `POST /api/providers/{id}/hotreload` | Feeds into, not superseded outright. Its poke-and-verify-usage-moved flow is the current implementation of the generation evidence `QualificationDetail.generation` formalizes. The admin ABI does not require this route change; a `recheck` implementation may call the same underlying probe. |
| `POST /api/providers/test-batch` | Related, not superseded. This tests every connection at once; the admin ABI's per-connection `recheck` and the batch route serve different call shapes and both may remain. |
| `POST /api/providers/{id}/reauth`, `GET /api/providers/{id}` (CRUD, list) | Out of scope. This ABI reads and transitions qualification, quota, drain and release state; it does not add, edit or delete provider connections. That CRUD surface is unaffected. |

No route under `src/app/api/**` is deleted by this document. Deletion is
Phase 3 step 5 and Phase 4 step 8, gated on a native test and a live rollback
drill, both outside this leaf's scope.
