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
interval and hashed stdout/stderr references. Keep native harness receipts in
`artifacts`; never replace a failed native receipt with a passing envelope.
Failed native states, wrong revisions and incomplete native standalone/CLI
restart/cleanup evidence fail. `fixtures` records fixture and profile hashes.

Risk coverage gates also reference their raw `report`; mutation gates reference
`report` and `reviews`. The assembler recomputes both application and front risk
scores. `offline-suite.testReport` references the full raw Vitest JSON report.
`namedFailureCases` references a `tokenproxy-named-failure-cases-v1` document with
the exact `applicationSha` and `cases` entries carrying unique `id`, test `file`,
and exact assertion `fullName`. Every named assertion must appear once and pass.

Packages must contain exactly one `kind: "standalone"` and one `kind: "cli"`,
each carrying the application SHA and retained artifact reference. The hashed
capability manifest must contain all 11 formats, 121 pairs and 36 primary cases.
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

Analytics metrics preserve separate cold/warm and concurrency-1/5 populations,
sample counts, p95/p99, HTTP503/failure counts, synthetic writes, row counts and
worker RSS. One-million-row growth does not invent percentile claims. The soak
requires >=60 minutes, requests, repeated cutovers and recorded resource slopes.
Delivery requires admission pause <4000 ms. Natural observation requires >=24
hours, >=1000 logical requests, no synthetic generation, and proxy-attributable
unexpected failures strictly below 0.1%, alongside all named zero-loss checks.

Configuration references were checked against the installed Vitest 4.1.11 and
Stryker 10.0.0 source and current primary documentation.
[Vitest coverage](https://vitest.dev/config/coverage.html),
[Stryker configuration](https://stryker-mutator.io/docs/stryker-js/configuration/),
[mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).
