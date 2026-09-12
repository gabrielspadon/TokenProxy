# Telemetry consumer boundaries

Display populations use `telemetryFilterSql`. Trusted test rows and exact active
quarantine identities are excluded. Production, imported and unknown origins
remain visible. Applying or reverting a receipt preserves source rows.

The following reads share this population.

- Request statistics filters, summary, series, items, traffic and health.
- Usage history, all period/range totals, charts, recent logs and spend windows.
- Recent completed activity, including the stored usage row behind a completion.
- Key attribution, observed project candidates and linked session-pin requests.
- Handoff targets, newly selected handoff evidence and preparation counts.
- Retained transformation evidence checked before authorized remediation.

Recent activity reads retained usage with a fixed limit on every call. There is
no process-local receipt or usage ring cache. Lifetime totals aggregate scalar
dimensions in SQLite; JavaScript receives public groups rather than raw history.
Hourly/minute reads paginate by immutable usage IDs in batches of 512. Chart day
totals come from current retained rows. Inclusive `usageDaily` rollups continue
to be written for accounting/export maintenance and do not determine display
totals. Memory still scales with the number of public dimension groups returned.

Backfill writes `requestStats.sourceUsageId` from the actual usage primary key
and copies its trusted origin. The shared predicate follows this exact link.
An old `bh-` name alone is insufficient evidence and remains visible. No
historical rows are relabeled by naming or unusual numeric values.

`processTelemetryOrigin` is shared by logical, request-stat and usage writers.
It accepts no request/header/provider fields. A server-owned
`TOKENPROXY_TELEMETRY_ORIGIN=test` marks isolated built artifact processes even
with `NODE_ENV=production`; an unsupported nonempty override becomes unknown.
Without an override, `NODE_ENV=test` is test and other process modes are
production. Existing rows retain their origin during upserts and deduplication.
The artifact `privateEnvironment` forces the test marker after extra variables.

The following reads deliberately retain inclusive accounting or control state.

- `getApiKeyUsage`, `getApiKeyUsageTotals`, `getExceededLimit` and budget usage
  reconciliation retain acknowledged spend. Quarantine grants no allowance.
- `getDailyConnectionUsage` retains all dispatches used by quota accounting.
- `usageProjectIdentity`, project binding authorization and API-key historical
  ownership checks retain exact billing/identity provenance.
- Context event ingestion validates retained identity; writes, source exports,
  retention cleanup, schema maintenance and backfill remain source-inclusive.
- Existing approved handoff packets, pin actions and concurrency counters retain
  their operational state. Quarantine changes the linked telemetry evidence.

Changing inclusive accounting requires a separate explicit adjustment contract
with authorization, durable receipts and reconciliation. A telemetry exclusion
is not such an adjustment. Activity/Economics projection consumers and their
receipt-trigger rebuilds are maintained by the separate analytics packet.
