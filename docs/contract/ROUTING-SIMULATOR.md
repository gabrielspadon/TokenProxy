# Offline account-routing simulator

The simulator captures and replays the local account-selection decision for one resolved physical model. It shares the gateway's pre-quota admission function and scheduler ordering. It never acquires a lease, writes or touches affinity, refreshes quota, resolves a proxy, refreshes credentials, dispatches a request, records usage, or activates configuration.

This is the first exact account-selection scope. Full route execution, combo/fusion/rotation state, virtual auto routing, request compatibility, capability-adapter expansion, provider-wide admission, API-key authorization/budgets, translation and shaping remain outside this scope. A local candidate is never presented as successful generation. Every result has `served: null`, `readiness: "unknown"` and `upstreamVerified: false`.

## Operator API

All three operations use `POST /api/admin/routing-simulator/{operation}` and the existing `requireAdmin` guard. An operator credential is required even when dashboard login is disabled. The existing POST policy additionally requires a loopback peer. Inference keys do not authorize these operations. Responses use `Cache-Control: no-store`. No request body or raw exception is logged.

- `capture` accepts `{input, sessionHash?}` and returns `{capture, input, coverage}`. `sessionHash`, when supplied, is an existing full 64-hex routing hash, never a raw client session or API key. It is used for the exact `(sessionHash, physicalModel)` read and is not returned. Without it, `affinitySource` is `assumed-new-session`. An absent row for a supplied hash remains an observed absence, not proof about another client identity.
- `validate` accepts `{capture, input, draft?}` and checks capture version, exact content hash, strict safe shape, scoped model and optional draft compatibility. It returns `{valid, version, captureId, policyVersion, draftPreview}`. A false draft validation remains visible inside `draftPreview.valid` and is not an account simulation failure.
- `simulate` accepts the same packet and returns the decision described below. It performs no repository or runtime reads. Save and reuse the complete returned capture unchanged to reproduce an input against the same evidence.

`input.model` is required and limited to 512 characters. It is resolved with the actual `resolveRequestModel` function during capture. Qualified models, direct aliases and resolvable bare physical IDs follow the existing resolver, including configured prefix precedence. Bare `auto` and `default`, virtual auto-router IDs and combo names are refused with 422. Explicit native `provider/auto` remains a provider model when the real resolver recognizes it.

Optional inputs are `modality`, `contextTokens`, `outputTokens`, `requiredCapabilities`, `preferredConnectionId`, `strictPreferredConnection`, and `excludedConnectionIds`. Modality accepts chat, embeddings, rerank, image, video, tts, stt, search, ocr, moderation and fetch. Token counts are nonnegative integers through 100,000,000 and are labeled operator supplied. A strict preference requires an account ID. No prompt, tools, content body, authorization material, destination URL or free-form error is accepted.

Bodies are bounded to 1 MiB before JSON parsing, independently of declared Content-Length. Captures permit at most 200 accounts, 200 provider nodes, 64 windows per account and 512 enabled models per account. Input exclusion lists permit at most 200 IDs; capability lists at most 12 unique known names. IDs are bounded, query parameters and unknown fields are rejected, nesting is bounded, and prototype-related keys are refused. No list is silently truncated. Invalid input returns 400, a size bound 413, an unsupported or unrepresentable capture 422, incompatible draft/current hashes 409, and an unreadable internal state a sanitized 500.

## Capture contract

Version 1 uses `policyVersion: "quota-affinity-v1"`. `captureId` is a SHA-256 content hash using the same recursive canonical representation as versioned routing configuration. Validation compares the complete safe projection and hash, so extra fields cannot be smuggled into a valid capture. Generated in-process objects are recursively frozen. JSON transport preserves content rather than language-level freezing.

The capture contains its time, requested/resolved model identifiers, account IDs and provider IDs, active/auth-type/priority/capacity fields, explicit enabled-model lists, effective disabled-model policy inputs and provider-node alias metadata, drain flags, persisted percentage snapshots and pause thresholds, relevant account-wide/model lock timestamps and classified failure status, current-process in-flight counts, grouped live pin counts for the physical model, an optional exact existing pin, the gateway's current resolved capability values, and the covered versioned configuration document/hash.

Credentials, account names/emails, access and refresh tokens, API keys, proxy URLs and credentials, provider endpoint URLs, raw upstream errors, raw session identifiers and request contents are omitted. Provider-node projections retain only ID, prefix and type. Unsupported stored values are either represented with their existing unknown semantics or cause an explicit refusal; they are never repaired into measured capacity or quota.

Capture acquisition spans read-only repositories and process-local state, so it is explicitly not an atomic cross-store snapshot. `capturedAt` fixes the simulation clock. Later expiry or recovery requires another capture. The service does not persist captures in server history. Hashes detect content changes, but are not signatures or proof of capture origin. Submitted captures remain operator-supplied evidence; `captureAuthenticity` is `not-attested`.

Quota input uses `lastQuotaSnapshot` through the same `toRankerWindows(snapshot, null, {now})` fallback that live auth uses when no fresh raw usage accompanies the read. Percentages remain a synthetic scale with unknown confidence, never token totals. Runtime quota memory and any refresh result are unavailable. They can change a live decision, and their absence is listed explicitly. Stored quotaWindows rows are not silently substituted for the auth path's different fallback source.

## Decision contract and parity

The live and offline paths both use `accountAdmissionReason` for strict account selection, request exclusions, enabled-model lists, explicit operator disable, drains and active locks. `temporaryPinWait` preserves a rate/transient-locked pin when other operator gates still admit that account. Failure helpers accept an optional injected clock; existing callers keep the wall-clock default.

Both paths use `planAccountSelection`, extracted from `selectAndReserve`, to invoke the maintained quota ranker and repin policy and produce the account attempt order. Live `selectAndReserve` still owns the original synchronous transaction, atomic reservation and pin/receipt writes. The simulator only compares the captured counts against `effectiveCapacity`; it cannot reserve a future slot.

New placements follow eligibility/headroom/evidence and longest-horizon deadline ordering, followed by shorter horizon ties and load. Healthy pins remain on the same account, including a capacity wait. Operator disable or an explicit model allowlist applies to pins. A necessary rotation keeps the same physical model. The existing all-depleted percentage-snapshot pin hold remains visible; the simulator does not replace that established policy with a new blanket gate.

`localSelection` returns `{connectionId, model, reason, status}` with status candidate, wait, refused or unknown. `candidates` lists the attempted account order, capacity evidence and whether each captured slot is full. `exclusions` lists account gates and excluded quota windows. `ranking` includes the remaining ranker records and marks a snapshot-ineligible record retained by affinity. `affinity` reports source, old account, action/reason and any temporary wait time. `requested`, `resolved` and `served` remain separate.

`capabilityFit` compares supplied requirements against captured gateway declarations. Missing reasoning/media support, context overflow and output overflow are shown as evidence. They are not invented hard account gates, because the account selector does not enforce those conditions. `enforcedAsAccountGate` is false. Non-chat modality dispatch topology and every unavailable outer gate stay in `unknownEvidence`. For no-auth providers, a local disable can be proven; otherwise missing proxy topology produces unknown selection rather than a fictitious ready account.

## Versioned draft preview

The optional envelope is `{version: 1, expectedCurrent, document, draftId?, revision?}`. `expectedCurrent` must equal the capture's `configuration.currentHash`. `document` uses the existing `routing-plans-v1` shape and the maintained `assertRoutingDocument`/`validateRoutingDocument` functions. The preview returns the draft hash, local errors/warnings and declared ordered plans, including effective fallback/round-robin/fusion strategy.

Draft preview is `declarative-only`, with `accountSimulationAppliesDraft: false`. It neither alters the captured model target nor claims to execute a changed alias, combo, fusion panel, judge or rotation policy. Custom/free-model catalog evidence outside this capture may cause validation to report unresolved members. Saving, activation and rollback remain the separate versioned configuration API. A wider route topology simulator is a subsequent scope, not an implied capability of this endpoint.

## Verification

Focused tests compare the simulator with real `getProviderCredentials` selection across 240 deterministic randomized bounded fixtures and explicit temporary-lock/operator-control cases. External quota transport and proxy readiness are mocked, while the actual gateway gate, bridge, ranker, repin policy, scheduler and lease registry execute. Tests compare exact account IDs and wait semantics and verify no simulator-created lease or state operation.

API tests use the private per-file DATA_DIR and real SQLite repositories, resolve configured prefix shadows, read an exact persisted pin, round-trip capture/validation/simulation, and prove unchanged `total_changes()` and lease snapshots. Every provider fetch is replaced with a throwing guard. Additional tests cover immutable replay, deadline ties, capacity spill, model entitlement, operator overrides, depleted-pin nuance, capability uncertainty, size and shape bounds, tamper rejection, secret stripping and declarative draft compatibility. Existing scheduler, disabled-model and lock regression suites bracket the extraction.
