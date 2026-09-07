# TokenProxy complete redesign implementation plan

The operator approved autonomous end-to-end execution after the research, composition discussion and interactive continuity example. This plan extends REDESIGN-20260907.md. It does not treat the earlier rejected renders as accepted visual baselines.

## Outcome and constraints

Deliver a coherent JavaScript/Next.js operator workspace with connected Capacity, Context and Economics investigations, complete supporting journeys, actual persisted controls and a verified release. Retain Mantine controls, TanStack tables, ECharts analytical charts, Zustand state and react-resizable-panels. Preserve healthy gateway behavior and every supported capability. Provider inference and paid tests remain mocked; production data and credentials remain outside fixture runtimes. Do not benchmark or profile as part of redesign validation.

Use Manrope interface typography, IBM Plex Mono for identifiers, a cool gray canvas, white working surfaces, deep navy navigation and petrol selection/actions. Measured input is blue, cache reads plum, cache writes ochre and output slate. Provider marks retain their own identity. Neutral body text, semantic status labels, observation age, unknown values and explicit evidence coverage remain first-class.

## Ownership and dependency order

1. Root owns global tokens, Shell, navigation, ScopeBar, ActivityBand, SelectionDock, Capacity, shared selection integration, concept selection and release coordination.
2. Fixture owner owns scripts/redesign-preview.mjs and tests/e2e/redesign-fixtures, disposable runtimes and fixture provenance. It supplies an isolated dev URL first and an isolated production build later.
3. Context/Economics owner owns its page/component trees, exact attempt/cost inspection, cohort comparison and focused tests. It requests shared-store changes from root.
4. Routing owner owns Models, Sessions, Shaping, model-context and their focused tests. It completes pending policy/context-window edits and safe route/version semantics.
5. Supporting-journey owner owns Connections, Keys, Access, Network, Remote, System, Operations, Notifications, Translation, Compatibility and Tools, with scoped read/error/persistence checks.
6. Reconciliation owner first returns paused failures and release topology; after implementation, fresh reviewers inspect disjoint fronts. Native implementation workers inherit the driving Astra model. The task ledger's routing-class display is not the runtime identity of those native workers.

Every owner preserves concurrent dirty files. No broad stage/reset/stash/clean, guessed process termination or unaudited fixture copying. Root alone owns shared browser inspection and release mutations.

## Task 1. Reconcile and establish representative execution

Read current Git state, capability inventories and completion receipts. Record HEAD and the pre-existing dirty file list without claiming it is accepted. Start the fixture launcher with disposable SQLite storage and no live credentials. Verify provider/network/background guards before visiting controls. Provide varied account identities, quota windows, stale/unknown observations, exact logical requests/attempts, cost components and opt-in shaping controls. Keep synthetic, retained and live provenance explicit.

Acceptance includes a real API-backed page, a reversible fixture mutation followed by readback/reload, a no-outbound receipt and an owned runtime stop command. Use tests/e2e/redesign-fixtures and existing seed helpers instead of intercepting every UI read.

## Task 2. Compare compositions and establish the selected visual system

Render three content-equivalent alternatives: account comparison with selected evidence, session activity with aligned account lanes, and an evidence-led investigation. Each must expose an account boundary, recorded selection reasons, input/cache composition and cost attribution using identical fixture content. Compare the silhouette, primary information, preserved context and the same selection task. Inspect at 1440x1000 and 1920x1080 before extending the chosen composition. Also inspect a narrow state early.

Root selects the strongest fit, records specific reasons and preserves inspected renders. Materially different hierarchy and selection behavior are required; palette-only variants do not count. Keep exploration outside production navigation and remove unused experiment implementations after selection. Preserve the chosen screenshots and concise comparison receipt.

## Task 3. Implement shared geometry and Capacity investigation

Modify src/shared/components/Shell.js, src/shared/workspace/{ScopeBar,ActivityBand,SelectionDock,UiProvider,WorkspaceProvider}.js, their shared CSS, src/app/dashboard/page.js and capacity.module.css. Consolidate semantic colors in metricColors.js and global variables. Keep existing identifiers and analyticsUrl(scope) as query boundaries.

SelectionDock must use available container width and retain enough comparison space. Closed state reserves no inspector height. Keyboard focus returns to the initiating control; narrow layouts retain selected identity on return. ScopeBar separates population from exact selection and avoids an always-empty selection band. Activity remains selectable without occupying the first screen at the expense of comparison.

Capacity prioritizes account identity, independent quota windows and binding known eligibility constraints. Put exact activity/attempt links in AccountDetail. Navigate to Context using the retained request identity only; do not synthesize an attempt join from a session-level relationship. Preserve compare, model access, recheck, priority, drain and quota-pause controls.

Focused verification includes workspace-investigation-state, selection-dock-sizing, capacity-controls, quota-chart interaction and investigation-continuity persistence. Test scope changes, unavailable selected records, chart interval selection, retained selection across pagination, resize, keyboard return and wide/narrow overflow.

## Task 4. Complete analytical and supporting journeys

Context moves selected request summary and ordered signed stages ahead of verbose technical facts. It preserves provider-reported tokens, estimates, signed bytes, explicit compaction events, controls and session evidence boundaries. Economics exposes cost coverage and exact records, preserving cohort comparison across pagination with scope-bound identity. It does not treat absent history or unknown pricing as zero.

Models and Routing present ordered editable plans, eligibility, validation, versioned drafts, comparisons and scoped activation receipts. Sessions shows physical attempts within logical work, recorded pin continuity and supported future-boundary controls. Shaping groups effective settings and inheritance, preserves opt-in transformations and supports actual service/error states.

Supporting routes preserve all inventory-listed controls, masked secrets, guided setup, local-versus-upstream diagnostics, scoped persistence feedback and safe partial failure. Unknown health is separate from observed unhealthy state. Read failures retain clearly stale evidence with a scoped retry. Provider marks use the existing local registry and accessible fallbacks.

Owners run the relevant tests from tests/package.json with npm --prefix tests test -- <focused paths>. They return exact commands, decisive results and unresolved conditions. Source-text checks alone do not establish persistence or visual acceptance.

## Task 5. Integrated visual and behavioral acceptance

Run repository lint, build and applicable mocked suites after integration. Exercise actual user actions through backend effect, persistence, reload, refreshed evidence and failure handling. Inspect desktop 1440x1000 and 1920x1080, additional 1280x800, 768, 390 and 320 widths, keyboard, reduced motion, zoom/text spacing, supported dark mode and locale/RTL behavior.

Inspect real images at screen, region and control scale. Keep live selection stationary. Render timestamps, provenance and selected records explicitly. Repair one consequential defect at a time and recheck affected shared neighbors. Preserve the best verified candidate. Run fresh review rounds using the documented agent-review prerequisites, recording any unavailable workflow separately rather than counting it as clean.

## Task 6. Release reconciliation, publication and cleanup

Reconcile the local RTX-backed origin with GitHub and fresh main before publication. Inspect open branches/PRs, reuse required work and preserve unrelated ownership. Commit explicit accepted paths, verify HEAD advances, transfer the reviewed changes through the supported remote patch route, and use a PR where required. Merge only with required checks green and no unresolved review threads. One push per CI cycle.

Deploy through the existing supervised release procedure with active-stream drain and rollback identity. Verify source, built artifact, installed artifact, service and user-facing UI agree. Do not infer deployment from a build or active service alone. Remove only task-owned temporary previews and superseded scratch; keep the accepted source, useful fixtures and concise release evidence. Report any real remaining limitation without calling an incomplete gate passed.

## Progress

The account-comparison composition was selected after three independently rendered alternatives at desktop and narrow widths. The resulting shared system and supporting routes are implemented. The first packaged candidate has build ID `DakYc7wCDHrFelJfIwBfI` and source manifest `fcf00570ee1de8610901db84b23c364624f05bf19ba600dd437b2aa8d8113bf6`. It is an isolated synthetic preview, not a production deployment.

The integrated mocked suite passed 13,097 tests in 1,296 files, with 61 tests and 15 files skipped. The repository baseline verifier reports zero regressions. Domain browser checks include eight actual routing/configuration/pin persistence journeys and fifteen supporting journeys, with intercepted contract checks distinguished from persisted mutations. Context label edits were independently read back, reloaded and restored; exact attempt-to-cost navigation was exercised. The accepted Capacity captures show no horizontal overflow at 1440 and 1920 pixels and verified keyboard focus return.

Fresh native Astra review found responsive inspector remounting and stale automatic-routing conflict recovery. Both are repaired and independently reviewed. The inspector retains inventory ancestry and a stable detail portal, integrates scroll locking, and preserves drafts, comparison state, focus and caret across both responsive transitions. Routing conflict recovery retains intended rules, reads the latest base and requires renewed review. Strict Context status reads distinguish missing data from corrupt or inaccessible storage while request-path telemetry retains its best-effort behavior.

Release inspection additionally reproduced request-detail shutdown ordering, overlapping pending-counter expiry and a provider concurrency snapshot-shape defect. Details now join in-flight flushes through the existing ordered shutdown registry before database closure. Each pending start owns its deadline; expiration subtracts only its own contribution. The provider gate reads the actual active-request array. Pending counters remain expiring observations, which the interface now labels explicitly rather than presenting them as proof of open transports. No performance or complete stream-accounting claim follows from these repairs.

The final candidate includes the Notifications editor visibility fix, Economics column-state preservation and an advancing anchored preview clock for authentic chart animation. The second full mocked regression run passed 13,115 tests in 1,299 files, with 61 tests and 15 files skipped; the baseline verifier again reports zero regressions. Compiled browser acceptance covered all 17 routes at wide and narrow sizes, actual persistence and conflict recovery, chart-to-record navigation, mouse and keyboard resizing, dark mode, RTL and a 720 CSS-pixel viewport at 2x pixel density for the equivalent 200% zoom layout.

Final browser inspection reproduced two additional focus defects. Context attempt cells now retain their component identity across selection, preserving the triggering button for focus return. Responsive detail transfer supplies the exact retained field to Mantine's delayed focus trap and restores existing autofocus marks when the compact host detaches. The two Economics chart toolbar controls use 26px targets. These repairs pass 31 focused interaction tests plus the chart visibility test and changed-file lint; compiled browser confirmation remains a release gate. The isolated System page deliberately reports a failed published-version lookup because outbound package-registry requests are blocked by its fixture guard.

RTX cutover uses the existing stable front and guarded package driver, with just-in-time direct-caller accounting, a consistent backup and qualified rollback. Source publication, cutover and their external receipts are separate from this implementation acceptance record.
