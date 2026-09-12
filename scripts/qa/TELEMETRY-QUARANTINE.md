# Telemetry quarantine

Quarantine excludes reviewed synthetic telemetry through an active receipt. It preserves the original `requestStats` and `usageHistory` rows, including their origin and recorded values. Reverting the receipt restores their visibility. High latency, unusual names and unknown origin alone never select a row.

Each manifest contains explicit table names, primary keys and SHA-256 fingerprints of every source column. Its identifier binds that inventory to the evidence hash and selector hash. A changed row, missing row, changed proof, duplicate identity, count mismatch or overlapping active receipt blocks the operation. Fingerprints must be prepared after schema migration because adding a column changes the complete row fingerprint.

The maintenance command requires Node 24 and a closed, private offline copy with no SQLite sidecars. It rejects symlinks, hardlinks, non-private files and the default production data path. It never opens the supplied database with write access. Every apply or revert produces a separate `candidate.sqlite`, preserves `before.sqlite`, verifies integrity and foreign keys, closes and reopens the candidate, and writes a hash-bound receipt. It does not install the candidate or stop a service.

The offline copy's directory must contain `.tokenproxy-quarantine-offline.json` with the following operator-supplied attestation. Compute the hash from the closed copy, not a running database file.

```json
{
  "schemaVersion": 1,
  "purpose": "offline-backup",
  "offline": true,
  "database": "offline.sqlite",
  "databaseSha256": "<SHA-256 of the closed copy>"
}
```

For an initial dry-run, supply a private selection JSON containing `schemaVersion: 1`, `expectedRows`, `evidenceSha256` and `rows`. Every row contains only `sourceTable` (`requestStats` or `usageHistory`) and string `rowId`. The command fingerprints those explicit identities and emits `manifest.json`. It accepts no SQL predicate or duration/provider/model selector.

```bash
node scripts/qa/telemetry-quarantine.mjs --database /absolute/offline.sqlite \
  --selection /absolute/reviewed-row-ids.json --evidence /absolute/proof.json \
  --output-dir /absolute/new-dry-run-directory
node scripts/qa/telemetry-quarantine.mjs --action apply --database /absolute/offline.sqlite \
  --manifest /absolute/new-dry-run-directory/manifest.json --evidence /absolute/proof.json \
  --output-dir /absolute/new-candidate-directory
node scripts/qa/telemetry-quarantine.mjs --action revert \
  --database /absolute/new-candidate-directory/candidate.sqlite \
  --manifest /absolute/new-dry-run-directory/manifest.json --evidence /absolute/proof.json \
  --output-dir /absolute/new-reverted-directory
```

All input files must be owned regular files with mode `0600`. Output directories must not exist. `purpose: "synthetic-fixture"` identifies isolated regression data; `offline-backup` identifies an operator-prepared retained-data copy. These labels authorize no automatic selection or live installation.

## Consumer integration contract

`telemetryFilterSql(sourceTable, alias)` returns the shared SQL predicate for analytics. It includes production, imported, null and unknown origins, excludes trusted `test` origin, and excludes identities covered by active receipts. `alias` must expose the source `id` and `dataOrigin`; its identifiers are source constants. Caller-supplied SQL or identifiers are prohibited. Maintenance and raw backup paths continue reading every row.

The release lead integrates the predicate into the following readers before claiming that quarantine changes dashboard behavior.

- `analytics/activityQueries.mjs` uses it in both Activity populations and Economics populations, including summary-only, grouping, item hydration, paging and export. The normalized `usageEconomicsProjection` must retain `dataOrigin`. Linked request latency must exclude quarantined requestStats evidence even when an associated usage row remains visible.
- `repos/requestStatsRepo.js` applies it to statistics, timelines, provider/model dimensions, counts and percentiles. Write upserts, retention policy and raw persistence lookup must retain their existing source identities.
- `repos/usageRepo.js` applies it to visible history, summary, model statistics and spending aggregates. Its ring buffer must preserve enough origin/identity information to use the same visible population, or visible readers must query durable filtered data. Applying a receipt invalidates any previously cached aggregate.
- Other SQL readers of these tables must be inventoried, including statistics, session/context dashboards, budget and account usage. Accounting or enforcement changes require an explicit contract decision; a display filter must not silently alter billing or authorization.

The database remains the evidence ledger. Source edits after receipt creation invalidate its proof; `inspectQuarantine` must pass for every retained manifest after restore or migration before analytics qualification. No runtime API exposes apply/revert.

## Historical September 5 candidate

`tests/qa/telemetry-quarantine/historical-fixture-candidate.json` records the retained audit evidence for 156 rows in three 52-row cohorts. The audit identifies provider counts, model and fixed start time but retains no complete row-ID export or full row fingerprints. Therefore the candidate is unbound and cannot be applied by this command. It requires a reviewed explicit inventory from an authorized offline backup, the exact three time cohorts, and independent row-level fixture proof. Broad names or latency thresholds are insufficient.

The regression suite exercises atomic exclusion, reversal, unchanged source bytes, changed-proof rejection, injected mid-write failure, readable backup, reopen, restore, unknown lookalikes and offline-path guards. These checks do not establish production exclusion until consumer integration and authorized candidate installation are complete.
