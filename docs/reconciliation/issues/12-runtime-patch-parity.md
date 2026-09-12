# Runtime patch parity

Priority: P1
Status: Proven — see correction below (built differently than prescribed, but the underlying "no expect.fail placeholder" requirement is met).

## Current behavior

Superseded: `tests/unit/reconciliation/patch-parity.test.js` (not the `runtime-patch-parity.test.js` name this doc proposes) now covers all ten itemized behaviors — max effort, cache controls, cache and cost truth, tool-fragment normalization, usage-only termination, exact account pins, deterministic 4xx handling, provider metadata, generation IDs, and bundled-log removal — with direct native assertions against real exported functions (`applyThinking`, `mergeToolArguments`, `translateNonStreamingResponse`, `OpenRouterExecutor`, `generationId` utilities, etc.), not the coverage-mapping/pointer test this row's "Acceptance test" section describes. `grep -n "expect.fail\|no coverage mapped" patch-parity.test.js` returns nothing — none of the three items this doc flagged as unmapped ("max effort," "tool-fragment normalization," "bundled-log removal") are left as placeholders.

- The matrix's evidence for this row is entirely on the `ai-dotfiles` side: "the resilience overlay deletes a 385-line byte patch while moving to the native predecessor release." There is no TokenProxy `file:line` naming the patch itself, since it never lived in this repository — TokenProxy began from the predecessor release at `90b52e06` (Evidence Snapshot), so whatever the byte patch changed either is or is not already native here, and nobody has proven which for every itemized behavior.
- The itemized behaviors the Decision column lists — max effort, cache controls, cache and cost truth, tool-fragment normalization, usage-only termination, exact account pins, deterministic 4xx handling, provider metadata, generation IDs, bundled-log removal — are each already the subject of one or more other rows in this matrix: cache and cost truth is row 07, exact account pins is rows 02/03, usage-only termination is row 08's stream-completion truth, deterministic 4xx handling is row 09's terminal-failure classification, and generation IDs/provider metadata sit inside row 04's admin/receipt surface. This row is a cross-cutting "prove nothing regressed" checklist over the others, not an independent behavior with its own code path to cite.
- The task's own structural facts establish the mechanism this row's proof runs through: `tests/__baseline__/verify-no-regression.mjs` validates the raw runner outcome, suite and snapshot state, and the reviewed file/assertion inventory.

## Required behavior

Prove native (non-patched) parity for each itemized behavior above without recreating the deleted byte patch. "Prove" here means: for every itemized behavior, an executable test exists (in this repository, native JS/TS, not a runtime-applied patch), its exact identity is reviewed in `tests/__baseline__/test-manifest.json`, and its regression is caught by `verify-no-regression.mjs` rather than by re-diffing a 385-line patch by hand. Where an itemized behavior already has a dedicated row and test (07, 08, 09, 02/03, 04), this row's job is to confirm that row's acceptance test actually covers the specific byte-patch behavior claimed for it, not to duplicate it.

Failure direction: an itemized behavior with no corresponding test anywhere in rows 01-11 is not silently assumed to be "probably fine because TokenProxy started from the same fork point" — it gets its own test here, under this row, rather than being marked proven on the strength of shared ancestry alone. Shared history is not evidence of behavior; a passing test is.

## Acceptance test

No row in the Acceptance Tests table names "runtime patch parity" directly — it is the one row whose proof is a checklist crossing every other row rather than a single scenario. The matrix's own Decision column is quoted verbatim as "Required proof": "Prove native parity for max effort, cache controls, cache and cost truth, tool-fragment normalization, usage-only termination, exact account pins, deterministic 4xx handling, provider metadata, generation IDs, and bundled-log removal. Do not recreate byte patching."

Vitest translation:

- This row's test is a coverage-mapping assertion, not a new behavioral fixture: a small fixture table listing the ten itemized behaviors, each mapped to the test file(s) in `tests/unit/reconciliation/` that are expected to cover it (07 → cache-write-accounting, 08 → continuous-sse-liveness, 09 → retry-and-backpressure-truth, 02/03 → account-scoped-request-admission / durable-client-session-affinity, 04 → native-connection-qualification for generation IDs and provider metadata).
- For "max effort," "tool-fragment normalization," and "bundled-log removal" — the three items with no existing row in this matrix — this test asserts a still-`TODO`-free placeholder is *not* acceptable: it fails loudly (an explicit `expect.fail("no coverage mapped for <behavior>")`) until a real test file is named for each, forcing the gap to be closed rather than silently waived.
- A second assertion verifies that the canonical regression baseline has no accepted failure for any mapped test. A waived result is not proof of parity.
- Proposed file: `tests/unit/reconciliation/runtime-patch-parity.test.js`.

## Blast radius

- No production source change of its own; this row's deliverable is the coverage-mapping test plus, for "max effort," "tool-fragment normalization," and "bundled-log removal," net-new test files once their behaviors are located in the current tree (out of scope to author here since they are not yet mapped to any of rows 01-11).
- `tests/__baseline__/regression-baseline.json` contains only time-bounded reviewed external exceptions. This packet expects none.
- `tests/unit/reconciliation/runtime-patch-parity.test.js` — new.

No DB migration. This row is a test-coverage and regression-gate artifact, not a runtime behavior change.
