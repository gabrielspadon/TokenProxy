# Operations evidence and controlled network checks

The operator requires a trace from an observed failure to its recorded path,
diagnostic evidence and resulting configuration change. Existing network tests
can change pool activation but retain only the latest status. This slice retains
their provenance and outcomes before building notification rules over them.

## Initial boundary

- Append explicit operation events for configuration, process, reachability,
  authentication and inference. A reachability probe does not prove provider
  authentication or successful inference. Record only phases actually observed.
- Protect the history API with the existing operator gate and run historical
  queries in the bounded analytics worker. Apply all time, account, provider,
  subject, phase and outcome filters before cursor pagination.
- Retain a started event before an operator check; retain its terminal outcome
  and activation effect together. An interrupted started event is unresolved,
  never an inferred success or an instruction to resend the check.
- Keep error codes and allowlisted structural evidence. Do not retain raw
  credentials, full proxy URLs, response bodies or arbitrary exception text.
- Preserve the existing proxy test's explicit activation behavior, explaining
  that successful testing enables a pool and unsuccessful testing disables it.
  Cancellation must release network work promptly without benching a pool.
  A changed pool configuration invalidates a late test's activation effect.
- Show current account/pool/outbound/tunnel relationships separately from an
  exact recorded request path. Missing historical path evidence remains unknown.

## Delivery order

First land the additive operation-event schema, bounded repository/query/API,
actual proxy-check producers and a linked history inspector in Network. Then
extend versioned selective configuration restoration over network settings and
connect provider/process diagnostics through their actual producers. Database
restore and software release rollback remain distinct operations.

Existing control surfaces remain available during the extension. Shared scope,
selection, keyboard access, reduced motion and the accepted workspace visual
system apply. Private mocked probes and sanitized snapshots provide validation;
no real upstream test is part of this implementation run.

## Acceptance

Verify actual SQLite persistence and cancellation, per-phase interpretation,
configuration conflict, terminal-event idempotency, secret redaction, filters
beyond the first page, interrupted outcomes and standalone worker execution.
Render current, empty, failed, pending and selected histories at both desktop
sizes and a narrow viewport. A successful service status alone closes no gate.
