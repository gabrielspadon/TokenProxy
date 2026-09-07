# Graphite operator workspace

The user rejected this composition. It remains a historical design record.
The current replacement direction is `REDESIGN-20260907.md`; the maintained stack is recorded in `WORKSPACE.md`. The historical values below must not be copied into current components.

This interface follows observed work across a routing gateway. It uses a
continuous graphite surface, a compact labeled navigation rail, a persistent
telemetry strip, and adjacent inspectors. Provider brands distinguish routes.
This supersedes the earlier paper/Fira and equal-weight card directions.

## Visual system

IBM Plex Sans carries controls and prose. IBM Plex Mono carries identifiers.
Self-hosted font assets and the upstream OFL license live in `public/fonts/`.
The ground is #151719, raised surfaces #1c1f22, primary text #eeeae3, secondary
text #a5a9b0, separators #34383d, and the gateway mark #63cdb0. Jade indicates
observed activity. Amber marks constrained capacity or content-changing controls.
Failure color is reserved for failed or refused operations.

The 94px desktop navigation rail retains readable labels. Mobile presents a
native navigation dialog and a vertical account sequence. Account preferences,
language, version, and sign-out remain available through the header menu.
Command search supports semantic controls and keyboard access.

## Workspace behavior

Overview places active requests on the left, a compact gateway junction in the
middle, and connected accounts on the right. Motion represents observed requests.
Account allocation matches only unique provider/account labels reported by the
usage stream. Unmatched work is never assigned to an invented account. Selection
opens real quota, reset, retained context, model observations, and account controls
in an adjacent inspector. Provider totals are labeled as covering all accounts.

Context places conversation navigation, a wide token history, and the selected
attempt's inspector together. Provider-reported usage, estimates, missing cache
fields, signed byte changes, and identity provenance remain distinct. Inferred
locality is not a guarantee of separate agent identity. Rejected context records
receive a coverage notice. Operator project labels never infer raw paths.

Shaping groups independent controls in a workbench. Safe no-op or
semantic-preserving modes differ from explicit content-removal options. A
successful write reports confirmation. Existing mutation confirmations retain
the operation's effects and recovery limits.

## Evidence and repeatable checks

`tests/e2e/operator-fixture.mjs` contains coherent browser-only synthetic records.
It is never imported by the application. Its summaries are derived from the same
request records used in charts and inspectors. `operator.spec.mjs` exercises
selection, keyboard navigation, refusals, escaping, account state, and reduced
motion. The other page suites exercise all retained operator controls.

`operator-route-sweep.mjs` captures all 15 routes at desktop and mobile sizes.
`operator-accessibility.mjs` checks WCAG A/AA, keyboard account inspection and RTL.
`operator-seed.mjs` restricts database writes to its named disposable test path.
`operator-persistence.mjs` checks the real repository/API/UI path and a durable
project-label update. These scripts use no inference calls.

Historical screenshots under `docs/design/evidence/` are retained for lineage.
Current run receipts must record the source SHA, production build, test results,
and captured rendering. A successful build alone does not establish visual quality.
