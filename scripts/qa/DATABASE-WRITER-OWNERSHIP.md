# Managed database writer ownership

The application adapters coordinate writers to one local database file through `writerAdmission.js`. Native SQLite adapters hold independent shared claims from initialization until their database closes. sql.js opens an inert snapshot and acquires an exclusive claim before its first `run`, `exec`, ordinary transaction, or critical transaction. Existing native writers can run concurrently. A sql.js writer cannot coexist with another managed writer.

Analytics read-only connections deliberately bypass writer admission. `analytics/readOnly.mjs` uses native read-only handles or a query-only sql.js snapshot, so observation remains available while a writer owns the database. Application sql.js adapters initially set query-only mode and reload the latest published bytes when promoted to a writer; opening an old reader does not entitle it to overwrite a newer snapshot.

## Admission and recovery

Claims live in a private `<databaseFile>.writers` directory. Fully written private claim files are published with exclusive hard links. A native initializer checks for an exclusive claimant, publishes its unique shared claim, then checks again before opening SQLite. An exclusive initializer publishes its claim before checking shared claims. Both sides therefore reject the crossing admission race, without a global mutex or waiting for the other initializer.

Claims bind a random instance/claim UUID and PID. Linux also binds a hashed machine identifier, boot UUID, and `/proc` process-start ticks. A different start time proves that an old PID was reused; a different boot on the same machine proves that the old process ended. Missing or unreadable identity stays unknown. Modification times and elapsed-time thresholds never justify stealing ownership.

An exclusive claim from a proven-dead owner is reclaimed through a retained, per-owner reclaim claim. A delayed second reclaimer cannot unlink a newly acquired owner. A dead reclaimer can be followed through at most eight identity-bound links; an active, unknown, or deeper chain fails closed. Unique native claim filenames are never reused, so proven-dead shared claims can be removed during exclusive admission. Reclaim records remain retained rather than creating an ABA window through cleanup.

On platforms without verified machine/boot/start identity, a foreign claim cannot be automatically declared dead. Verified operator recovery under stopped writer ownership remains necessary for such orphaned claims. Unknown ownership returns immediately with `DB_WRITER_OWNERSHIP_BUSY`; no operation waits indefinitely or reruns a user mutation.

Native claims are released only after the database closes successfully. Bun cached prepared statements are explicitly finalized before strict close, because otherwise Bun 1.3 can report a locked database and retain an active handle. sql.js holds admission across the debounce interval, explicit flush, and close. A failed publication keeps its unpublished state and ownership. A failed close cannot let a second writer publish over that state.

## Stale snapshots

sql.js checks the current file digest and its exact owner claim before each publication. A changed snapshot, unexpected nonempty WAL/journal, or lost owner stops publication. The adapter reports a non-retryable `DB_SNAPSHOT_STALE` or ownership error and refuses further mutations. Ordinary unpublished changes remain in memory; a failed critical callback retains the existing rollback semantics and never replays the callback. The disk image written by another owner is not overwritten.

The digest is updated immediately after successful snapshot rename, including when a later directory sync fails. This preserves the existing distinction between a failed publication and an already published database with uncertain crash durability. Receipt publication remains owned by the separate critical-ACK boundary.

Native reads and ordinary native transactions perform no admission filesystem operations or full-file hashes. Native overhead is confined to adapter creation and close. sql.js adds a whole-file digest/read and owner check to each already whole-database snapshot publication; its first promotion also reloads the latest snapshot. Critical sql.js transactions perform an additional check before invoking the callback. Large-snapshot latency and memory remain integrated release measurements.

## Scope and evidence

This is a contract among managed adapters on a local filesystem. Direct external SQLite writers, arbitrary `raw` writes, shared network filesystems, and external changes to ownership metadata do not participate. The stale-file check detects many external changes but cannot make a compare-and-rename atomic against an uncooperative writer. Mixed deployments must use this admission contract consistently; an old binary without it cannot establish managed-writer safety.

Focused tests cover concurrent native owners, exclusive fallback promotion, analytics snapshots, lifecycle failure cleanup, rejected close, stale replacement before/after a callback, real owned child death, unknown identities, and delayed-reclaimer/admission races. Node 24.15 passed 137 applicable tests across 11 suites; the one excluded case exercises native COMMIT behavior that sql.js does not implement. Bun 1.3.13 passed the dedicated ownership and ACK checks.

`tests/qa/writer-ownership-overhead.mjs /absolute/baseline/worktree` compares interleaved small synthetic fixtures and records source digests. A concurrent-load diagnostic against `352cffde` used 20 samples and 184,320-byte snapshots. Median native startup changed from 22.79 to 23.91 ms, median sql.js flush from 13.49 to 14.25 ms, and median native reads from 2.95 to 2.92 microseconds. These are diagnostics, not acceptance timing. Instrumented tests independently confirm zero admission file reads/opens/writes during ordinary native query/transaction loops.

Run `bun tests/qa/writer-ownership-bun.mjs` for the Bun handoff check. The Node regression scope is `db-writer-ownership`, `sqljs-atomic-persist`, `sqljs-export-integrity`, `db-driver-chain`, `critical-ack-journal`, `refresh-runtime-persistence`, `db-adapter-shutdown`, `db-migration-safety`, `db-migration-chain`, `context-analytics-worker`, and `analytics-diagnostics`, using their `tests/unit/*.test.js` files with `--maxWorkers=1`.
