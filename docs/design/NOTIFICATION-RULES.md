# Notification rules

Bounded, operator-controlled alerting over measurements TokenProxy already
retains. Schema 16.

## The boundary: notifications only

This subsystem **notifies**. It does not remediate.

Explicitly out of scope, and absent from the code rather than merely disabled:

- No automated route, account, profile or combo change.
- No remediation action of any kind, and no "fix it" affordance beside an alert.
- Nothing that spends money and nothing that contacts a provider.

The schema is where this boundary is load-bearing. Neither `notificationRules`
nor `notificationRuleEvents` has a column describing an action to take, so a
future action cannot be smuggled in as configuration on an existing row. The
only two dispositions an operator can record are acknowledge and snooze, and
both annotate the alert; neither touches provider-facing state.

An alert's job is to put a human in front of the evidence. `AccountInspector`,
the quota workbench and the operations surfaces already own acting on it.

## What a condition is allowed to be

A condition exists only where this tree retains a measurement that answers it.
Each was checked against actual columns before implementation, not assumed from
a plausible-sounding name.

| Condition | Source | Duration role | Fires |
|---|---|---|---|
| `quota_risk` | `quotaObservations` | sustained | headroom at or below N% |
| `stale_telemetry` | `quotaObservations` | sustained | newest observation older than N min |
| `repeated_fallback` | `accountSwitches` | window | N or more switches in the window |
| `operation_failure` | `operationEvents` | window | N or more failed terminals in the window |

Three deliberate exclusions inside those conditions:

- `repeated_fallback` ignores the `initial-pin` and `first-pin` triggers. A
  session's first assignment is not a fallback away from anything.
- `operation_failure` counts only `failed`. An operation recorded as
  `uncertain` did not resolve, which is not evidence that it failed, and
  `cancelled` is not a failure either.
- `quota_risk` uses a provider-reported percentage where one exists, otherwise
  derives it from `remaining` over `limit`. An unknown denominator yields no
  value rather than a guessed one, and an unmeasured observation is counted as
  retained but not as measured, so the gap stays visible.

### Unavailable: compression / token-saver failure

Not implemented, because no failure is recorded to detect.

`contextStages.outcome` is written by `normalizeContextStages`
(`src/lib/db/repos/contextRepo.js:26`) with the domain `skipped | unchanged |
applied`. None of those is a failure. The RTK hooks are fail-open by contract:
on error they return `null` and leave the body untouched without writing a
stage row. A saver that threw is therefore indistinguishable in retained data
from one that deliberately chose to skip.

Implementing it would mean inferring failure from a `skipped` row, which would
alert on correct behaviour. It would first require a failure outcome persisted
on the stage ledger, distinct from a deliberate skip, written where the hooks
currently swallow the error.

The condition is listed in `UNAVAILABLE_CONDITIONS` and rendered in the UI with
its reason, because a missing condition an operator expects is worse than a
stated one.

## Duration and cooldown

`durationSeconds` has two readings, declared per condition as `durationRole`,
because the two are not interchangeable:

- **sustained** — the predicate must hold across consecutive retained samples
  spanning at least the duration. A condition true for less than the duration
  does not fire. A recovery restarts the run, so a later breach must earn the
  full duration again.
- **window** — qualifying records are counted inside a trailing window. The
  count is the measurement.

Silence is not evidence. A sustained run is broken by a gap longer than the
series' own observed cadence allows, derived through the same bound the quota
workbench uses (`QUOTA_TREND_METHOD`, floor 5 min, cap 60 min), so the two
cannot drift into disagreeing about what "quiet" means.

`cooldownSeconds` is the minimum spacing between two firings of one rule on one
scope key, floored at 60s in both the validator and a `CHECK` constraint. It
carries across evaluation runs via the most recent recorded firing, so a
restart does not reset it. A sustained breach alerts once per cooldown, not
once per sample.

Staleness is measured against the clock rather than against a sample value,
since the age of the newest observation grows without any new record arriving.
Absence of any observation is reported as `no_observation`, never as fresh.

## Evaluation

Runs through the existing analytics worker as the named `notification-evidence`
projection: one read-only transaction, `BEGIN`/`ROLLBACK`, no SQL or DB path
crossing the message boundary. Every filter, including scope, is applied in SQL
before any limit, never by filtering a page already read. A population above
`NOTIFICATION_EVIDENCE_MAX_ROWS` (20,000) refuses to produce a partial verdict
and says why.

The range is validated in the repository, with the worker's own validator,
before the query crosses the thread boundary. Inside the worker a malformed
range is indistinguishable from a failed read, so it would otherwise surface as
503 and blame the service for the caller's input.

A rule whose evidence cannot be read stays silent. It never fires on the
absence of its own input.

## Dry run

A dry run is **the evaluator**, fed the retained historical population instead
of the trailing window. It is not a parallel simulation, and it is not
fabricated: `evaluate.mjs` is pure and both paths call it.

It reports every instant the rule would have fired, each carrying the ids of
the records that caused it and a link to the surface that renders them. It
writes nothing.

Where the population is empty the result is `evidenceAbsent`, worded as an
absence of evidence rather than as a pass. History that was never recorded
cannot be reconstructed, and the UI says so.

## Duplicate firings and the audit trail

One open alert per rule per scope key, enforced by the database rather than by
an application check:

```sql
CREATE UNIQUE INDEX idx_nre_open ON notificationRuleEvents(ruleId, scopeKey)
  WHERE outcome = 'firing'
```

Two evaluators racing therefore produce one row and one loser, and a sustained
breach yields one actionable alert instead of a queue.

Acknowledging is terminal and frees the slot, so a genuinely new breach can
alert again. Acknowledging twice is refused rather than re-stamped, so the
timestamp keeps meaning "when the operator first took this". Snoozing suppresses
repetition and deliberately leaves `outcome = 'firing'`: a snoozed problem is
still an open problem.

Every rule change increments `revision` and writes a `notificationRuleVersions`
row carrying the full definition as of that revision. A write stating a stale
revision is refused with the live rule attached (409), surfaced in the editor
beside the operator's own values, never silently overwritten. An alert records
the revision that produced it, so a later edit does not rewrite history, and
alerts plus the version log both survive deletion of the rule.

## Files

- `src/lib/notifications/conditions.mjs` — catalogue, including the unavailable ones
- `src/lib/notifications/evaluate.mjs` — pure evaluator (duration, cooldown, staleness)
- `src/lib/db/notificationRuleSchema.js` — schema 16 tables and constraints
- `src/lib/db/analytics/notificationRuleQueries.mjs` — bounded evidence projection
- `src/lib/db/repos/notificationRulesRepo.js` — persistence, dry run, live evaluation
- `src/app/api/admin/notification-rules/` — admin API
- `src/shared/workspace/NotificationRules.js` — operator surface

## Evaluation trigger

Live evaluation runs on the debounced `statsEmitter` "update" that
`watcher.js` already owns, so there is no new timer and nothing was added to a
request path. It carries its own interval, `MIN_RULE_INTERVAL_MS = 300000`,
because a rule scan is a bounded-analytics-worker query per enabled rule
rather than the two in-process reads the connection scan costs. The added
latency is bounded by what the rules already tolerate: the cooldown floor is
60 s and `durationSeconds` is the operator's own chosen delay.

An idle gateway emits no update and so evaluates no rules, exactly like the
pre-existing connection scan.

On restart, a rule whose condition breached before the process started
produces no alert unless new evidence lands afterwards, in which case the
alert is dated at that new evidence and still carries its true
`breachStartedAt`. A sustained breach surviving a restart alerts at the next
cooldown boundary rather than immediately, because cooldown is what paces
successive firings of an unbroken sustain.

## Not yet wired

Delivery of a RULE alert to a webhook destination. The existing
`src/lib/notifications/webhooks.js` path emits three watcher-derived events
and knows nothing about rules. `POST /api/notifications` likewise still drives
only the connection diff.
