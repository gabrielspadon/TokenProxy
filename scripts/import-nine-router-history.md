# Nine Router historical import

`scripts/import-nine-router-history.py` imports a frozen Nine Router SQLite backup into an existing TokenProxy database. Python 3.11 or newer is required. The default performs the complete transaction against an in-memory SQLite backup of the destination and writes neither input file. Apply requires both the reviewed logical source fingerprint and the private snapshot byte fingerprint.

Create complete SQLite backups with the SQLite backup API before importing. Keep the legacy source and its consistent snapshot unchanged in a private directory with mode 0700 and files with mode 0600. The snapshot is required permanent preservation material because credentials, original settings, opaque metadata, request bodies, and precomputed daily data remain exclusively there. Protect the original installation encryption material separately. An importer receipt does not replace that material.

## Record mapping

- All source tables, including empty table definitions and `sqlite_sequence`, are represented by the schema receipt and row fingerprints. The import is bounded to 10,000 source rows and 64 MiB of encoded row data; an unsupported history schema fails closed.
- `providerConnections` gets new deterministic IDs derived from the source identity and original account ID. Provider, name, email, auth type, priority, and dates are retained; `isActive` is always 0 and `data` is `{}`. Name/email similarity never merges an old account into a current account. Credentials and routing configuration are not activated.
- `usageHistory` gets newly allocated integer IDs. Original costs, token columns, timestamps, provider, model, endpoint, and status are retained. Exact original connection IDs map to the namespaced legacy account ID; orphan references stay orphan references. The actual API key is NULL. Safe metadata marks its key identity as unavailable, and numeric token quantities are allowlisted. Request, completion, task, session, and pricing identities unavailable in the source stay NULL.
- `requestStats` and `requestDetails` use the same deterministic request namespace, so exact equal original IDs retain their legitimate equality. Usage IDs are never used to infer a request join. Detail projections contain only the legacy identity/status fields and allowlisted numeric token/latency measurements. Original request and response bodies remain in the private snapshot. Malformed detail JSON is recorded as snapshot-only with a reason.
- Existing `usageDaily` is incremented only from newly imported usage rows, using the current local-day counter shape. The original legacy daily aggregate stays in the snapshot and is never added. Provider, model, account, endpoint, and explicit unavailable-key dimensions reconcile with the new usage. `_meta.totalRequestsLifetime` increments by the imported usage count. Runtime caches must be refreshed by the operator's normal service restart.
- Settings, API keys, KV entries, nodes, pools, combos, seen-model state, metadata, and other source tables remain snapshot-only. Their provenance rows record field exclusion markers and a full-row fingerprint, so their omission from active configuration is explicit. No source row is silently discarded.

`legacyImportSources` stores the source identity, full logical digest, snapshot path and byte digest, schema inventory, contract version, import time, and row count. `legacyImportRecords` stores a digest of the original primary key (or rowid), redacted typed source metadata, full original row digest, preservation disposition, destination table/ID, and exact projected values. These two additive tables are created only inside the import transaction and have no runtime retention cleanup.

## Dry run and apply

Run on the same host and under the same timezone configuration as the application, because usage daily buckets use local calendar days. The source must be a consistent frozen backup with no pending WAL. Do not point `--source` at the running legacy database.

```sh
python3 scripts/import-nine-router-history.py \
  --source /private/legacy-before-import.sqlite \
  --target /private/target-clone.sqlite \
  --source-id nine-router-rtx-20260907
```

The report gives the two source fingerprints, source row count, original ID collision counts, projected row deltas, snapshot-only counts, and lifetime counter delta. It includes no row payloads or credentials. Use the exact report fingerprints for the disposable clone apply.

```sh
python3 scripts/import-nine-router-history.py \
  --source /private/legacy-before-import.sqlite \
  --target /private/target-clone.sqlite \
  --source-id nine-router-rtx-20260907 \
  --apply \
  --expect-source-sha256 REVIEWED_LOGICAL_SHA256 \
  --source-snapshot-sha256 REVIEWED_SNAPSHOT_BYTE_SHA256
```

All projected rows, daily aggregates, lifetime counts, and receipts commit in one `BEGIN IMMEDIATE` transaction after row-count, source-record, destination-projection, and foreign-key verification. An interrupted or failed transaction rolls back completely. Replay uses the durable `(sourceId, sourceTable, sourceKey)` receipt rather than attempting to skip collisions. The same source and contract verify as an unchanged no-op. Replay also checks persisted per-day and per-dimension numeric lower bounds and the lifetime counter minimum. Later counter growth is allowed; missing or reduced counters fail closed and require reconciliation. These lower bounds verify retained aggregate coverage, not independent reconstruction of subsequent traffic. Changed source contents, alternate aliases for the same logical snapshot, mapped-ID collisions, and missing or modified projections fail closed.

The observability request-details ring buffer may later evict projected details. The full original snapshot and provenance remain available; replay reports missing projections instead of claiming that the original material is still in the ring. Restore or expansion of that projection is a separate operator decision.

The lead operator owns production maintenance. Stop admission and the backend using the existing maintenance procedure, apply against the existing current database only after private-clone verification, then restart the same application version and verify health plus database and API totals. Preserve the complete pre-import snapshot for rollback before traffic resumes. Do not restore an old database after new traffic has landed.

## Verification

```sh
python3 -m unittest discover -s tests -p history_import_test.py -v
cd tests
npx --no-install vitest run unit/usage-legacy-import.test.js unit/usage-api-key-identity.test.js unit/usage-stats-masked-key.test.js
```

Python tests build target fixtures from the application's actual declarative schema. They cover collision preservation, source and destination immutability during dry run, repeat idempotence, atomic rollback, unknown lineage, orphan accounts, malformed details, secret exclusion, and daily/lifetime increments. JavaScript tests verify unavailable-key identity and reconciled totals across all six supported periods.
