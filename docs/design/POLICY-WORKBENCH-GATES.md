# Policy workbench verification

The completed UI source is `012978d5` on `audit/local-dev/astra-routing-ui`. The production build and guarded previews use that commit. It follows `e9602507` with one CSS selector correction that preserves Mantine's hidden checkbox inputs while keeping read-only text values legible.

## Scope and persisted behavior

The Models workbench edits covered plans, ordered members, exact account bindings, aliases and routing defaults through the existing configuration API. It reads immutable versions and receipts, stores optimistic draft revisions, validates locally, reviews a fresh before/after change and deliberately activates or restores a version. Existing catalog controls remain available. Sessions links to the workbench and shared filters remain in the workspace provider. Account credentials, endpoint/network settings, disabled models and shaping settings are explicitly outside configuration restoration.

The offline simulator captures the actual local single-model inputs and keeps the returned packet unchanged. It presents candidate order, captured account load, quota evidence, affinity assumptions and missing gates. `served` remains null and readiness remains unknown. Draft declaration validation does not claim to apply a draft to account ranking. No authenticated executor or complete gateway test is implied.

## Checks

- `tests` recipe `./node_modules/.bin/vitest run unit/models-policy.test.js unit/workspace-investigation-state.test.js --reporter=dot` passed 16 tests across two files on `e9602507`. The 13 policy tests exercise real Mantine and sortable controls, revision conflict retention, explicit discard, publication review, partial outcomes and capture contracts. A focused input-identity regression failed before the row-key fix and passed after it.
- ESLint passed on the policy components and focused tests. Production builds passed on both `e9602507` and `012978d5`.
- The repository's `tests/e2e/models.spec.mjs` passed all seven catalog cases against compiled `e9602507`. The read-failure case checks the visible error and absence of a Live claim, allowing the truthful synthetic snapshot label.
- Ten compiled workflow checks passed on `e9602507`. Actual private SQLite operations covered keyboard reorder, editing focus, plans/alias/defaults saved at revision 2, full browser reload, exact draft restoration, a genuine concurrent revision 409, activation and rollback. Activation receipt 54 and rollback receipt 57 prove committed effects; the final hash equals the original `c8bb9103e07b0da354c2e0e33ff89fbf4b25bca85d1293a67a773b7d1318b49e`. Explicit intercepted 503 and 207 fixtures separately prove retained edits and partial-receipt handling without automatic replay.
- Actual capture/simulation returned two synthetic account candidates, `served: null` and `readiness: unknown`. The model candidate was `synthetic-claude-a`; no upstream execution occurred.
- Desktop and narrow checks used 1440×1000, 1920×1080 and 390×844 viewports with reduced motion. Six real/synthetic policy views and three simulator views passed Axe WCAG A/AA, with no document overflow or page errors. On the final build, the narrow simulator table is keyboard focusable and ArrowRight scrolls its own viewport from 0 to 340 px.

## Private evidence and visual review

Evidence lives outside Git below `/Users/gabrielspadon/Documents/ChatGPT/Token Router/implementation-evidence/ui/`. `policy-e9602507-flow/report.json` records the ten workflow checks, exact receipts and failure fixtures. `policy-e9602507-catalog-e2e.log` records the seven preserved catalog cases. `policy-012978d5-build.log` records the final build.

Final current-state views are in `policy-012978d5/`. Clean simulator screenshots and keyboard/accessibility receipts are in `policy-012978d5-simulator/`; both viewport-only and full-page images are retained. The 207 banner remains only in the separately labeled failure-flow images. The driver inspected the rendered fields, icons, narrow layout and checkbox visibility. This corrected the pale read-only values, missing icons, input remount, excessive success-banner prominence, intrinsic table overflow and missing keyboard scroll access.

The actual sanitized snapshot contains zero plans and four aliases; its UI preserves that empty plan state. The separate synthetic database contains two plans and three accounts. Both runtimes use fresh private authentication, copied mandatory guards and isolated databases. Ten unrelated mutation/inference probes returned 403. No pristine snapshot, existing preview, production credentials or source data were modified. Ports 20330 and 20331 remain isolated previews, not deployment proof.

Root integration, full integrated regression checks and deployment remain separate gates. Simulator multi-target plans, authenticated executor checks and complete gateway execution are outside this delivered local simulation scope.
