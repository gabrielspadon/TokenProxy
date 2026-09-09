# Horizontal ownership and crash/failover contract

Status: qualified on a single host on 2026-09-08. This states which shared invariants are durable across processes today, which are deliberately process-local, and what a second gateway process on the same SQLite file must respect. It is a contract, not a claim that multi-process deployment has been exercised end to end.

## Durable, fenced by lease or transaction

- Quota check jobs. One adapter claims a due job under a lease with an ownership secret; renewal reclaims expiry; a stale owner cannot complete, renew or cancel, and completion is refused once the lease has expired even before another worker claims it (`src/lib/db/repos/quotaCheckQueue.js`, `tests/unit/quota-check-queue.test.js`). The scheduler names `ownership-lost` as a cancellation reason.
- Budget reservations. Reservation, dispatch and settlement run inside one durable SQLite transaction with `PRAGMA synchronous = FULL` (`src/lib/db/repos/budgetRepo.js`). Four separate native processes admitting the same key admit exactly one unknown-bound exposure, and killing the owner preserves it (`tests/unit/budget-crash-recovery.test.js`). sql.js cannot admit capped dispatch at all.
- Manual and automated drain. Manual verbs compare-and-set inside one transaction against the document version they read (`src/lib/admin/state.js` `swapDrainDoc`); automated remediation applies and rolls back inside its own transaction and rechecks the exact resulting state (`src/lib/notifications/remediation.mjs`). A concurrent write is answered with 412, never overwritten (`tests/unit/drain-swap-atomicity.test.js`).
- Token refresh. A refreshed token carries its revision and cannot overwrite a newer operator or provider state; one-use refresh tokens keep exclusivity across concurrent identities (`open-sse/services/tokenRefresh/credentialRevision.js`, `tests/unit/refresh-runtime-races.test.js`, `refresh-runtime-repo.test.js`).
- Configuration. Every domain write records a version in the same transaction and every activation checks the current hash and the draft base (`src/lib/db/repos/configVersionsRepo.js`).
- Release activation. Current release and history are written in one `setMany` transaction (`src/lib/admin/state.js` `commitActivation`).
- Session affinity and pins survive an adapter reopen (`tests/unit/reconciliation/affinity.test.js`, `drain-restart.test.js`).
- Compatibility runs record their `processOwner`; a new process marks the prior owner's queued or running rows `interrupted` and never replays them (`src/lib/db/repos/compatibilityRepo.js` `interruptPrevious`).

## Deliberately process-local

- Resource admission (handler and stream permits, adaptive limits, provider throttles) is one registry per process; its snapshot names `cross-process-capacity` and `connection-pool-pressure` as unavailable evidence (`src/sse/services/resourceAdmission.js`). Two processes therefore each enforce their own ceiling; the shared upstream sees the sum.
- Account leases (`src/sse/services/accountLeaseRegistry.js`) are process-wide by design, keyed by connection id, so per-account concurrency is bounded per process.
- The recheck in-flight flag in `src/lib/admin/state.js` is process-local and documented as such.
- The notification watcher subscribes once per process; a second process would evaluate rules twice against the same retained evidence, but alert firing is deduplicated by exact event identity and action enqueue by `eventId` (`src/lib/db/repos/notificationRulesRepo.js`, `remediation.mjs`), so duplicate evaluation cannot enqueue a second action.

## What a second process must respect

1. Open the same SQLite file with a native driver (WAL, `busy_timeout`); sql.js is a single-process fallback.
2. Never bypass the lease and transaction paths above by writing rows directly.
3. Expect admission and account concurrency to be per process, and size each process's limits so the sum stays inside operator limits.
4. Treat any process-local state as lost on crash: the next process reclaims quota jobs when their leases expire, marks compatibility runs interrupted, and leaves budget exposure uncertain until reconciled.

Not exercised: two gateway processes serving one public port at the same time. The front proxy (`services/tokenproxy/front-proxy.mjs` in ai-dotfiles) hands a single backend a queued cutover; it does not load-balance.
