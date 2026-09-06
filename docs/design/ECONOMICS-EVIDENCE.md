# Economics evidence and attribution

This slice implements PLATFORM-DELIVERY item 10 within the approved workspace contract. It first exposes exact contributing cost records; project enforcement follows a separately coordinated schema and atomic reservation change.

## Existing authority

`usageHistory.id` identifies one completion ledger row. Its unique nullable `requestId` links `requestStats.id`; `logicalRequestId`, `attempt`, and explicitly established `contextSessionId` remain durable ledger attributes. No timestamp, model similarity, or prompt fingerprint establishes a join. Joined request metrics require compatible logical/session/attempt identities. Historical nulls remain null.

Client/project/task references on requestStats are installation-keyed HMAC values supplied through the authenticated client metadata boundary. A project reference is scoped to the installation, key and client. It is not a cross-client application project. Operator project labels do not establish monetary ownership. The ledger's current `projectId` is intentionally null. Retention can remove request-side evidence while leaving the completion ledger.

Rates are immutable `usageRateSnapshots`. `estimatedCostUsd` is the application calculation; `reportedCostUsd` is an explicitly USD-denominated upstream report. Neither establishes an invoice-confirmed charge. `cost` records the chosen amount, not the sum of those components. Cache/reasoning decompositions require usable quantities and the supported captured calculator version.

## Read and interaction contract

Extend the existing whitelisted activity projection and shared read worker, without another pool. Economics gets exact linked request latency, requested model, identity/reference coverage, physical initial/additional attempt classification, cost-source coverage and reconciled rate components. Shared absolute time/provider/account/model constraints apply before grouping and pagination. Cohort pages and ledger pages are independently bounded; null-identity cohorts can be selected explicitly.

Provider/model/account comparisons remain available. Add explicit session, logical request, client, client-project reference and task reference cohorts. Selections retain stable identities across live updates and lens changes. Inspector actions filter the full contributing population, reusing the existing ledger, shared chart and resizable dock. An additional physical attempt is not automatically avoidable cost, and successful-task cost is unavailable without a meaningful explicit outcome.

Selected and population exports use the same normalized projection and one read snapshot, preserving final 5000-row and 8 MiB limits. Include rate/evidence details through exact identities only. Never export raw API keys, prompts or metadata objects.

## Verification

Use private DATA_DIR and the repository Vitest configuration. Exercise actual persisted usage capture, exact joins and conflicts, missing/retired evidence, complete group and row pagination, scope conjunctions, rate component reconciliation including signed reasoning adjustment, provider-reported zero, unknown cache/price coverage, authenticated worker/API reads and bounded exports. Retain screenshots of the actual historical clone and a separately labeled synthetic pipeline at 1440×1000, 1920×1080 and 390×844, keyboard, reduced motion and stable selection.

## Next schema boundary

Durable ledger snapshots of validated client references prevent attribution disappearing with request retention. Operator-defined project bindings must explicitly map exact authenticated client references. Project policy versions and exposures must be admitted and settled inside the existing atomic native SQLite reservation transaction. A preliminary query or UI warning is not enforcement. Schema registration and shared runtime ownership remain with the lead until the additive fragment and transaction contract are reviewed.
