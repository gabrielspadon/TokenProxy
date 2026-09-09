# Economics evidence and attribution

This slice implements exact contributing cost records, durable authenticated references and explicit project budget controls within the approved workspace contract. Local acceptance and deployment acceptance remain separate receipts.

## Existing authority

`usageHistory.id` identifies one completion ledger row. Its unique nullable `requestId` links `requestStats.id`; `logicalRequestId`, `attempt`, and explicitly established `contextSessionId` remain durable ledger attributes. No timestamp, model similarity, or prompt fingerprint establishes a join. Joined request metrics require compatible logical/session/attempt identities. Historical nulls remain null.

Client/project/task references are installation-keyed HMAC values supplied through the authenticated client metadata boundary. New usage rows snapshot their validated references independently of optional request retention. A client project reference is scoped to the installation, key and client. It does not automatically identify an application project. An operator must bind the exact observed API-key ID, client reference and project reference to an application project. The reservation freezes that project, binding and policy revision into subsequent usage. Earlier usage remains unassigned; later bindings never backfill monetary ownership. Retention can remove request-side metrics while durable usage references remain inspectable.

Rates are immutable `usageRateSnapshots`. `estimatedCostUsd` is the application calculation; `reportedCostUsd` is an explicitly USD-denominated upstream report. Neither establishes an invoice-confirmed charge. `cost` records the chosen amount, not the sum of those components. Cache/reasoning decompositions require usable quantities and the supported captured calculator version.

## Read and interaction contract

Extend the existing whitelisted activity projection and shared read worker, without another pool. Economics gets exact linked request latency, requested model, identity/reference coverage, physical initial/additional attempt classification, cost-source coverage and reconciled rate components. Shared absolute time/provider/account/model constraints apply before grouping and pagination. Cohort pages and ledger pages are independently bounded; null-identity cohorts can be selected explicitly.

Provider/model/account comparisons remain available. Add explicit session, logical request, client, client-project reference and task reference cohorts. Selections retain stable identities across live updates and lens changes. Inspector actions filter the full contributing population, reusing the existing ledger, shared chart and resizable dock. An additional physical attempt is not automatically avoidable cost, and successful-task cost is unavailable without a meaningful explicit outcome.

Selected and population exports use the same normalized projection and one read snapshot, preserving final 5000-row and 8 MiB limits. Include rate/evidence details through exact identities only. Never export raw API keys, prompts or metadata objects.

## Verification

Use private DATA_DIR and the repository Vitest configuration. Exercise actual persisted usage capture, exact joins and conflicts, missing/retired evidence, complete group and row pagination, scope conjunctions, rate component reconciliation including signed reasoning adjustment, provider-reported zero, unknown cache/price coverage, authenticated worker/API reads and bounded exports. Retain screenshots of the actual historical clone and a separately labeled synthetic pipeline at 1440×1000, 1920×1080 and 390×844, keyboard, reduced motion and stable selection.

## Project policy and accounting

`/api/admin/projects` exposes bounded project lists, exact observed identity candidates, project controls, immutable policy versions, retained alert receipts and physical reservations. Mutations require authenticated local operator authority and the current revision. A project and each key permit at most 100 bindings. A key with any configured binding refuses missing or unmatched client identity before dispatch. Removing its last binding restores ordinary key policy. Archiving a project refuses subsequent bound requests; it does not move or erase in-flight work.

API-key and project limits share one durable native SQLite reservation transaction and one settlement row. Strict enforcement requires verified upper bounds and complete relevant accounting. Best-effort protection reserves the remaining allowance for an unknown-bound request, whose final usage may exceed it. Alert-only project policy records usage without project refusal; API-key limits still apply. The sql.js adapter can preserve project state and additive migrations but cannot authorize capped or project-bound dispatches, because that enforcement requires a native durable adapter.

Hourly project aggregates and lifetime counters update in the usage transaction, including reconciliation deltas. Forecasts need at least three complete hours, six records and complete cost coverage. They extrapolate recorded application prices and workload, show their observed range and explicitly exclude confirmed invoice claims. Same-hour or future initialization has no valid observation interval and produces an unavailable forecast. Subscription quota, token quantities, held exposure and USD estimates remain separate.

Threshold alerts retain their policy revision and contributing usage boundary. Their public projection exposes delivery preparation state and attempts without destination identities or fingerprints. Delivery preparation is distinct from successful delivery. Notification recovery retains the source event's authorization and never infers historical subscriptions.

The Projects tab supports direct policy editing, exact binding review, stale-write refusal, independent readback, unbinding, policy history and contributing-record navigation. The navigation preserves `projectId` together with existing scope; the shared visible scope chip clears it. Acknowledged changes with failed readback retain the returned project identity and require a fresh read before another change. Client task references still do not establish successful task outcomes or confirmed provider charges.
