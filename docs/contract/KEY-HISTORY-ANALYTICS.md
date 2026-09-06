# Key history under inference load

`GET /api/keys` reads current key controls and stable-ID budget reservations on
the writer, then allows at most 250 ms for optional retained-history analytics.
History uses the existing single bounded analytics worker and identical-query
coalescing. It does not add a worker pool, run a per-key main-thread history sum,
or make accounting depend on sampled analytics. An active abandoned native query
finishes off-thread or reaches the worker deadline; its subscriber is removed.

The worker returns public key IDs and measured totals, never credentials. The
join covers the currently stored credential and labels that scope explicitly.
It cannot reconstruct historical key rotations. Stable budget accounts remain a
separate lifetime accounting source. Missing samples and historical zero costs
without a pricing source remain visible. A key with no matching history has an
observed zero count; unavailable analytics has null usage, not zero.

Native SQLite reads a committed snapshot. The sql.js path reads its last durable
file snapshot and reports its persistence time. A 5,000-key result bound and the
existing worker queue, memory and query deadlines limit analytical work. These
reads still aggregate retained source rows; no claim is made that the scan itself
has been eliminated. The UI identifies unavailable or persisted history while
keeping activation, reveal and budget controls usable.

`tests/unit/key-usage-analytics.test.js` exercises native worker parity, missing
amounts, credential rotation boundaries, sql.js snapshot freshness, source-less
zero costs, authorized API projection and a stalled analytics deadline. The
neighboring key, receipt and analytics tests also run against isolated fixtures.
This is a responsiveness mechanism and behavioral receipt, not the full gateway
latency acceptance benchmark.
