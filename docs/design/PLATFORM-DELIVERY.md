# Connected investigation platform

The operator expanded the implementation mandate on 2026-09-06. The existing
backend corrections and three-lens redesign remain required. This document
tracks the additional delivery scope in dependency order; it does not claim
these capabilities are implemented. WORKSPACE-CONTRACT.md governs all surfaces.

## Foundation

1. Exact request, logical-request, dispatch-attempt, session, project and cost
   attribution wherever explicit identities exist. Preserve historical nulls.
   Store applicable rate versions and distinguish application estimates from
   provider-confirmed charges. Query/filter identifiers across complete result
   populations before pagination. Persist confirmed client compaction, handoff,
   task and outcome events separately from inferred observations.
2. Retained quota observations, resource units, scope, observation age, reset
   times, observed replenishment and quota-warming outcomes. Keep subscription
   allowance, request limits and monetary budgets separate.
3. Versioned configuration records, scoped before/after diffs, drafts, validation,
   staged activation and rollback receipts. Configuration restoration, database
   restoration and release rollback are different operations.
4. Explicit event provenance for configuration, process, reachability,
   authentication, inference, incidents, recovery and operator actions.

## Connected investigation

5. Shared time/provider/account/model and selected-record state across Capacity,
   Context, Economics and routing. Saved investigations, named filter sets,
   bookmarks, multi-account comparisons and exports of selected evidence.
   Chart intervals filter contributing records; exact identifiers connect
   records to sessions, attempts, decisions, stages and costs.
6. Capacity compares every account/window and the binding constraint, with
   direct account controls. Preserve recheck, priority, quota-pause thresholds,
   drain and restore, reporting individual results. Add consumption history,
   uncertain exhaustion forecasts, workload/unavailable-account/policy scenarios,
   and reset planning over scheduled warming checks and observed outcomes.
7. Routing/Models provides editable ordered plans, aliases, account restrictions,
   disabled models, fallback members, modalities and effective strategy. Support
   reorder, validation, configuration comparison and exact eligibility reasons.
   Offline simulation uses the gateway's own decision logic against captured
   state and hypothetical model/context/modality/availability/policy inputs.
   Real combo tests remain explicitly identified as model calls.
8. Sessions separates logical work from attempts and presents pins, expiry,
   switches, requested/served models and reasons on one timeline. Preview pin
   expiry, clearing and reassignment effects, affected sessions and conflicting
   policies. Changes apply only at supported subsequent-request boundaries and
   explain cache/model effects. Never imply in-flight response migration or an
   agent hierarchy without explicit identity evidence.
9. Context connects session tracks, attempt inspection and ordered stages with
   separate units. Add role/tool/attachment/prefix structural sizes and
   fingerprints, attempt/interval comparisons and explicit integration metadata.
   Preserve project-label editing and confirmed-event provenance.
10. Economics adds project/session cost attribution, retry overhead, cache
    economics, cost-versus-latency comparison, reconciled project budgets,
    forecasts and configured alert/enforcement policies. Successful-task cost
    requires a meaningful supplied outcome; unresolved charges, sample gaps and
    ambiguous historical zeros stay visible.

## Controlled changes and experiments

11. Shaping covers every stage, effective inheritance, consent and measurements.
    Add named profiles, explicit evaluation sets, baseline/candidate experiments,
    latency/usage/cost coverage/tool validity/outcome/failure metrics, reviewable
    promotion and rollback, and explained recommendations. Smaller alone is not
    evidence of better quality.
13. Accounts/Keys/Setup adds reusable access profiles, controlled credential
    rotation, device attribution and guided client adapters/configuration.
    Preserve expiry/token/cost/model limits, reauthentication and network
    assignment. Backend key lists are redacted; reveal is deliberate. Bounded
    connectivity checks distinguish authentication from model-request success.
14. Network/Operations connects accounts, proxy pools, outbound configuration,
    diagnostics and failure paths. Explain tests that mutate activation
    or eligibility. Preserve database import/export, updates and compression
    controls, showing verified outcomes and partial failures.

## Bounded automation

15. Notification rules gain scope, thresholds, durations, cooldowns, actions,
    acknowledgement, snoozing and links to triggering evidence. Conditions cover
    provider health/errors, quota/spending risk, repeated fallback, stale
    telemetry, compression failures and compatibility regression only when their
    measurements exist. Add history simulation, dry runs, limits, conflicts and
    audit trails before enabling remediation. Automated account/route/profile
    changes stay inside configured authority and report rollback/partial failure.

## Acceptance and ownership

Every feature requires user action through backend effect, persistence,
refreshed evidence and failure handling. Private representative fixtures support
testing; fabricated historical conclusions are prohibited. Generation validation
uses mocks unless the operator explicitly makes a later paid execution decision.

The lead owns integration, schema migration coordination, contracts, acceptance,
GitHub and deployment. Leaves have bounded file ownership and return commits
plus receipts. Current visuals must first pass both desktop sizes, narrow views,
keyboard access, reduced motion, stable selection and truthful measurements.
Then extend the same composition across remaining controls and new capabilities.
