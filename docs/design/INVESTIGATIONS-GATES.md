# Investigation delivery receipt

## Source and isolation

The final application build is `05bec599`, including the active-account cue `9a980134`. It is served through the packaged `custom-server.js` on isolated loopback ports 20310 and 20311. The build completed with fresh private build state and isolated authentication values. The first invocation lacked the required build-time JWT secret and failed before page-data collection completed; the corrected invocation exited zero. Neither invocation was a production deployment.

Port 20310 uses a writable runtime copy of the sanitized historical snapshot, captured 6 September 2026 at 15:45 UTC. The pristine snapshot and previous 20160/20296 previews were preserved. Port 20311 uses the separate all-synthetic Context fixture and a synthetic disclosure key. Every page identifies the historical or synthetic scope. The private preload blocks inference, outbound sockets/DNS/fetch, child processes and unrelated mutations. Its explicit investigation/reveal exceptions passed 19 boundary cases; the original broader guard verification belongs to the independent validation receipt.

Private artifacts live below `implementation-evidence/` in the parent workspace. They are outside the repository and include no copied production credentials. The synthetic key is masked in browser screenshots.

## Verification

- The final focused serialization, authenticated API and repository run passed 26 tests across 3 files. It covers exactly 8 MiB, one byte over, UTF-8 multibyte values, formatting/preview metadata and worker freshness. Changed-source ESLint passed.
- The earlier integrated source run passed 161 tests across 10 files. This included typed workspace state, real SQLite routing pagination over 1,206 receipts, actual export worker reads, analytics and Context/Economics components. It predates the final five serialization boundary cases and is recorded separately rather than added to an overlapping total.
- The final compiled historical browser run passed actual save, hard reload, exact restoration, two-account comparison, retained excluded selection across lenses, concurrent-version 409, injected persistence 503 without stored-count changes, exact account export and a complete-population 76,015-record refusal. A synthetic exactly 8,388,608-byte response became oversized after final browser metadata/indentation and produced zero downloads.
- The final cue check found exactly one inspected row and two compared rows, distinct computed backgrounds and a 4 px active edge. The edge follows RTL direction. The 1440 × 1000 and 1920 × 1080 viewport captures were opened and visually inspected. Desktop/narrow Axe found zero WCAG A/AA violations; narrow document overflow was false and page errors were empty.
- The preceding linked-record compiled run at `f8c731e3` passed exact legacy ledger bookmark 76016 with nullable request attribution, named filter restoration, shared routing provider filtering, exact receipt bookmark/export and Context request `synthetic-2-59` across navigation/reload. The Context export contained its 14 recorded stages without inferred links.
- The synthetic Context run at `f8c731e3` passed keyboard session selection, server page 3 final-attempt inspection, keyboard dock resizing, reduced motion with zero running chart animations, all existing inspector tabs and narrow overflow/Axe checks. The measured first view contained one fully visible attempt row at 1440 × 1000 and three at 1920 × 1080. This density budget was sent to the Context owner.
- Synthetic compiled key disclosure at `f8c731e3` confirmed redacted listing, explicit confirmation before disclosure, clearing on close, clearing after an accelerated 61-second browser clock and rejection of a late response after cancellation. Visibility-change clearing is covered by the owning lane's tests, not claimed as a compiled case here. An initial harness failure came from the key's collapsed native Details; opening that control fixed the test without a product change.

## Artifact index

All paths below are relative to the private parent workspace's `implementation-evidence/ui/` directory.

- `investigations-05bec599-build.log` records the successful production build and packaged assets.
- `investigations-boundary-tests.log` records the final 26-test run.
- `investigations-final-combined.log` records the earlier 161-test run.
- `investigations-05bec599/report.json` records the final compiled flow and byte-refusal result.
- `investigations-05bec599/capacity-viewport-1440.png` and `capacity-viewport-1920.png` are exact viewport captures, without full-page extension.
- `investigations-05bec599/export-metadata-refusal.png` captures the explicit final-file refusal.
- `investigations-05bec599/saved-modal-1440.png`, `saved-mobile.png`, `version-conflict.png`, `retained-selection-1920.png` and `export-complete.png` show the associated flows. These use full-page capture where declared by the browser harness and may exceed viewport height.
- `investigations-records-final/records-report.json` records linked records and synthetic key disclosure. `synthetic-context-restored-1440.png`, `synthetic-context-restored-1920.png` and `synthetic-context-restored-mobile.png` show the retained synthetic identity.
- `investigations-context-final/report.json` records Context interaction, accessibility, reduced motion and first-view density measurements.

## Remaining integration boundaries

This build contains the investigation feature, shared routing filters and the earlier grouped key budget API. It does not contain the newer Keys optional-history change `36cdfb30`; that requires the next integrated build. New Context structure snapshots and client-event associated evidence are explicitly excluded from this export revision and owned by the separate Context integration lane. No paid inference, production write, deployment, release activation or full-platform completion is claimed.
