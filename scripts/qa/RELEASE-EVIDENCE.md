# Release evidence and risk gates

The release assembler consumes completed evidence. It does not launch tests,
deploy, publish, or convert missing execution into a pass. Run it from the
candidate checkout after committing all candidate changes. Application, front,
and deploy source identities are separate full Git SHAs. Artifact identities
are SHA256 hashes of the retained bytes.

## Risk scope

Freeze the approved audit baseline and exact candidate. This derives all changed
admission, retry, credential, auth, storage/migration, startup and gate JavaScript
files. It records source hashes and every changed Git line range. Renamed files
remain included. Deletion-only hunks select the adjacent surviving line.
The inventory includes provider verification, network connectors, all changed
engine services/executors/translators/stream utilities, Next production config,
version/readiness handlers and CLI startup. Test assertions are not mutation
targets. Python source bytes are checked alongside JavaScript before execution.

```bash
node scripts/qa/risk-scope.mjs \
  --base-sha FULL_APPROVED_BASE_SHA \
  --candidate-sha FULL_CANDIDATE_SHA \
  --output /tmp/tokenproxy-qualification/risk-scope.json
```

Coverage instruments entire selected files, including files not imported by a
test. The assembler selects every branch whose location or alternative overlaps
a frozen changed range. It requires aggregate coverage of these branches >=90%.
Per-file changed counts and whole-file counts remain visible. Unrelated legacy
branches do not introduce another release threshold. Missing files, counters,
locations or an empty changed-branch population fail. The named failure-case
inventory separately requires actual passing assertions from the full suite.

Mutation covers all selected files, without static-mutant exclusions, incremental
reuse, narrowed test lists, or the historical five-file scope. The existing
`stryker.config.json` remains a historical focused job. Release qualification
uses `stryker.risk.config.mjs` and a raw score >=60%.

Run coverage and mutation separately, only with the shared heavy-job lease.
Use a fresh artifact directory for each. The following commands run after the
existing isolated runner boundary has been established, with an empty fake home,
fresh DATA_DIR, cleared provider/proxy credentials, owned socket root and a
verified Linux network namespace. A config alone does not create that boundary.

```bash
TOKENPROXY_RISK_SCOPE=/tmp/tokenproxy-qualification/risk-scope.json \
TOKENPROXY_RISK_ARTIFACTS=/tmp/tokenproxy-qualification/coverage-run \
node tests/node_modules/vitest/vitest.mjs run \
  --config tests/vitest.risk.config.js --maxWorkers=1 \
  --reporter=json \
  --outputFile=/tmp/tokenproxy-qualification/coverage-run/tests.json

TOKENPROXY_RISK_SCOPE=/tmp/tokenproxy-qualification/risk-scope.json \
TOKENPROXY_RISK_ARTIFACTS=/tmp/tokenproxy-qualification/mutation-run \
node tests/node_modules/@stryker-mutator/core/bin/stryker.js run \
  stryker.risk.config.mjs
```

Do not use the inherited shell environment as an isolation boundary. Both jobs
use one worker. Capture their actual command exit, signal, UTC interval and
stdout/stderr before creating a gate envelope. A Stryker dry run is not mutation
evidence. Raw runtime errors or unfinished mutant states fail the assembler.

The front requires an independently Git-derived risk scope in its own repository
and normalized Istanbul/Stryker reports with exact source text. The application
scope lists changed Python/shell paths in `separateLanguageGates`. The Python
deploy-driver coverage receipt is mandatory and must retain its own branch
report; V8/Stryker cannot qualify Python or shell code.

## Mutant review

For every `Survived`, `NoCoverage`, `Ignored` or `CompileError` mutant, record its
fingerprint from `mutantFingerprint(path, mutant)` exported by `risk-scope.mjs`.
Bind the review file to the exact candidate and mutation report hash.

```json
{
  "candidateSha": "FULL_SOURCE_SHA",
  "reportSha256": "SHA256_OF_MUTATION_JSON",
  "mutants": [{
    "fingerprint": "SHA256_OF_MUTANT_ID_LOCATION_OPERATOR_AND_REPLACEMENT",
    "reviewer": "independent reviewer identity",
    "disposition": "accepted-risk",
    "reason": "Concrete behavioral analysis and evidence",
    "issue": "Tracked accepted-risk issue"
  }]
}
```

Use `equivalent` only with an equivalence argument. `CompileError` requires
`invalid-mutant`; that disposition cannot exclude a valid surviving mutant.
Equivalence reviews do not remove survivors from the raw score denominator.
Accepted non-equivalent survivors retain an explicit tracked issue. Duplicate,
stale, unrelated or missing reviews fail. Stryker killed/timeout states count as
detected, survived/no-coverage as undetected, matching its documented metric.

## Release input

Write `release-input.json` in the evidence root. Every reference has a relative
`path` and SHA256. Referenced files must resolve inside that root. Existing output
files are never overwritten.

Required fields are `schema: "tokenproxy-release-input-v1"`, `stage`, `taskId`,
`baseSha`, `applicationSha`, `frontSha`, `deploySha`, `riskScope`, `frontRiskScope`,
`frontRepositoryRoot`, `gates`, `packages`, `capabilityManifest`,
`namedFailureCases`, and `qualification`.

`stage: "offline"` requires all gates except deployment and production observation
and emits `offline-qualified` with both outstanding gates. `stage: "delivery"`
requires every gate and emits `delivery-qualified`. Neither state certifies paid
provider inference or an untested platform.

`GATE_CHECKS` exported by the assembler is the fixed required inventory and exact
list of named checks per gate. Inputs cannot remove gates from that inventory.
Each `gates[id]` references a `tokenproxy-release-gate-v1` JSON envelope with
`gate`, `state: "passed"`, `taskId`, the three source SHAs, `runtime.node`, a
nonempty `dependencies` version mapping, UTC `startedAt`/`finishedAt`, `commands`,
`artifacts`, `fixtures`, `checks`, `skips`, and relevant `metrics`.

Every command records its literal argument array, exitCode 0, signal null, UTC
interval contained within the gate interval and hashed stdout/stderr references.
For offline-suite, analytics, protocol-matrix, standalone, CLI, browser, container,
failure-matrix, soak and production-observation, `native` references the exact
producer receipt and must also occur in `artifacts`. A generic green object is
insufficient. Failed native states, running progress, failed qualification,
wrong revisions and incomplete execution inventories fail. `fixtures` records
fixture and profile hashes. `validateGate` and `assembleRelease` are async.

Standalone and CLI migration checks require an actual older schema fixture,
changed DDL hash, ordered/layout version advancement and `migrationExercised`.
Current-source seeds establish reopen only. Browser proof includes both tracked
Playwright specs and direct executable scripts, every case, and owned cleanup.
Container proof retains both starts, actual capability dispatch accounting,
healthy Docker state, immutable image identity and removal of owned resources.

Risk coverage gates also reference their raw `report`; mutation gates reference
`report` and `reviews`. The assembler recomputes both application and front risk
scores. `offline-suite.testReport` references the full raw Vitest JSON report.
`namedFailureCases` references a `tokenproxy-named-failure-cases-v1` document with
the exact `applicationSha` and `cases` entries carrying unique `id`, test `file`,
and exact assertion `fullName`. Every named assertion must appear once and pass.

Packages must contain exactly one `kind: "standalone"` and one `kind: "cli"`,
each carrying the application SHA and retained artifact reference. The hashed
capability manifest must contain all 11 formats, 121 pairs and 36 primary cases.
Its bytes must match the candidate's tracked `tests/contracts/capabilities.json`;
repeated primary endpoint IDs and same-size substitute manifests are rejected.
Qualification entries must cover every `format:source->target`, `endpoint:id`,
`binary:id` and `modality:id:variant`, with `state: "qualified"`, `required: true`,
an owner and passing `protocol-matrix` gate linkage. Platform and live inference
entries also carry owner, state, required flag and gate links or nonexecution
reason. Required cases cannot be unqualified.

```bash
node scripts/qa/assemble-release-evidence.mjs \
  --input /tmp/tokenproxy-qualification \
  --output /tmp/tokenproxy-qualification/release.json
```

Analytics consumes the native `economics-analytics-v1` fixture receipt. The fixed
operation inventory is `economics-page-population`, `economics-filtered-provider`,
`economics-items`, and the `activity-summary-groups` control. Each operation has
50 cold, 200 warm and 50 cold-with-writer deliveries at concurrency 1 and 5.
All 24 profiles, 2,400 samples, 240 worker snapshot write receipts and four plans
are mandatory. Cold Economics p95/p99 are recomputed from samples and must stay
below 2,000/5,000 ms. Warm cache hits remain separate from writes. Activity is
checked for completion, parity, writes and memory; it has no Economics latency
claim. Peak RSS must stay below 512 MiB. Affinity preflight must cover the actual
selected cores below the producer's 20% busy threshold.

The one-million-row growth receipt requires 32 deliveries, 16 computations,
four worker snapshots with committed writes, four independent correctness
oracles, before/after projection parity and the native passing qualification.
Its computation deadline is 15,000 ms; it carries no percentile claim. Envelopes
may omit derived metrics. Any supplied headline must equal native evidence.

Both failure-matrix and soak consume `tokenproxy-reliability-soak-v1` in full
mode, with 10,000 deterministic requests, all nine scenarios, >=60 minutes of
mixed traffic, sustained streams >=30 seconds, at least six quiet restarts,
dashboard reads, terminal reconciliation, exact application/front/artifact
identity and owned cleanup. Resource slopes are recomputed from retained mixed
quiescent samples. Smoke success and total wall time cannot satisfy these gates.

Production observation requires `observation.begin`, `.end` and `.keyring`
artifact references. The assembler verifies the candidate source checkout and
calls its `assembleObservation` to authenticate and rederive the native result.
The unsigned summary alone never establishes observation. The authenticated
window must span >=24 hours and >=1,000 natural logical requests, with no unknown
outcomes and proxy-attributable unexpected failures strictly below 0.1%.

The outcome sampler deliberately leaves four safety invariants open. A separate
`safetyClosure` artifact must have schema `tokenproxy-live-safety-closure-v1`,
state `passed`, the three exact source SHAs, matching `releaseId` and the exact
native `window` object. Its `audits` contains one `{scope, source}` per scope
below. Each source is a hashed JSON artifact with schema
`tokenproxy-live-${scope}-audit-v1`, the same state/identities/window, nonempty
hashed raw `inputs`, and `unobservable: []`. Required scope-specific fields are

- `replay` has `logicalRequests` covering the natural denominator,
  `physicalAttempts`, `unsafeReplays: []`, and `unresolvedAttempts: []`.
- `secret-scan` derives `scannedBytes` and `observedWrites` from passive runtime
  counters, with exact api/exception/log/trace `coverage` and `findings: []`.
  Trace may be `checked-inactive` only when the same process and source prove
  both request logging and OTLP remained disabled. Empty files alone cannot
  establish inactivity. Matching covers configured credential literal bytes;
  unknown credentials, transformations and unregistered external sinks remain
  explicit limitations. Receipts retain no response, prompt or credential text.
- `acknowledged-writes` has a nonnegative `acknowledged` count, equal `reconciled`,
  `missing: []`, and `unreadable: []`. Its scope is `durable-before-return` and
  `callerObserved: null`. Eligible receipts conservatively include the crash gap
  before return; they do not establish that a caller received a response.
  Zero activity requires complete journal and instrumented process coverage.
- `front-evictions` has one `counterEpoch`, equal nonnegative `beginCounter` and
  `endCounter`, and `delta: 0`; the source inputs retain both counter captures.

`collect-live-safety.mjs` derives all four audits from the signed begin/end
snapshots. The release assembler runs that native derivation again and compares
the entire audit objects, so edited counters or clean booleans cannot close a
gate. Each audit retains the hashed begin/end/keyring references. Snapshots bind
the backend runtime source and the front's immutable startup source manifest
to the exact application/front candidate SHAs. Front manifests cover proxy,
activation, lifecycle, telemetry and outcome-journal modules.

See [LIVE-SAFETY.md](LIVE-SAFETY.md) for the runtime capture and assembly commands.
These collectors must establish their measurements from the actual window.
An unavailable invariant belongs in `unobservable` and prevents qualification.
The contract does not imply the live collectors or observation have run. Local
soak receipts cannot substitute for any natural-traffic safety audit. Delivery
also independently requires admission pause below 4,000 ms.

Configuration references were checked against the installed Vitest 4.1.11 and
Stryker 10.0.0 source and current primary documentation.
[Vitest coverage](https://vitest.dev/config/coverage.html),
[Stryker configuration](https://stryker-mutator.io/docs/stryker-js/configuration/),
[mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).
