# Capacity history qualification

Source29a155c9 was built and exercised on2026-09-06 with Node26.8.1 and the
repository's pinned dependencies. The isolated standalone previews used their
own authentication and SQLite copies. Provider traffic, credential reads and
configuration mutations were refused by the preview boundary.

## Verified behavior

- 68 tests pass across quota trend, worker/API, UI interaction, history,
 acquisition and reset-check producer suites. The final run took1.40seconds.
 Tests use actual SQLite persistence and the bounded analytics worker, including
 filters before counting, exclusive time ranges, incomplete populations,
 percentage-only evidence, conflicting measurements and cancellation.
- The standalone build completed for29a155c9. Six compiled browser flows passed
 against a labeled synthetic fixture populated through the actual writers.
 The selected account returned40 observations across two distinct quota scales.
 Canvas selection selected the corresponding stored ID and correct table page;
 dragging the interval control reduced the contributing population from20 to11.
- Second-page selection survived refresh. Local workload and exclusion controls
 changed the dated scenario without a configuration or upstream request. Reset
 event filtering returned the four recorded failures. A deliberately intercepted
 history503 preserved account-detail access and recovered after explicit refresh.
- Actual1440×1000,1920×1080 and390×844 viewports have zero automated accessibility
 findings, zero page errors and zero horizontal inspector overflow. The narrow
 observation table accepted keyboard scrolling by20px while its358px inspector
 remained stationary. Reduced motion was enabled. The driver inspected rendered
 plot, selected rows and scenario text at both desktop sizes and narrow width.
- The earlier real/synthetic six-viewport comparison passed at aac0136e. The
 sanitized real snapshot has no retained quota observations or reset-check
 records; its empty history remains empty. Later forecast/unit fixes were
 qualified against the repeated-observation fixture, without inventing history.

## Review and limits

Independent source review found percentage-only balances with a named quota unit
were excluded from trends.29a155c9 now keeps their measurement in percentage
points while retaining the separately reported unit; an actual capture-to-worker
regression proves the two scales remain separate. Unrepresentable exhaustion
dates remain unavailable instead of throwing or fabricating a horizon.

Forecasts remain local dated scenarios, with minimum sample/span requirements,
staleness and reset checks, and an empirical sensitivity range rather than a
confidence interval. They neither predict rolling replenishment nor redistribute
an excluded account's work. The5000-observation,64-group and8MiB bounds refuse
an incomplete forecast. Quota evidence has no model attribution. These checks
qualify this slice; they do not establish full-platform performance or deployment.

Private receipts remain outside Git under
`implementation-evidence/capacity-history/qualification/report.json`, the
adjacent rendered images, `final-render/` and `build-29a155c9.log`. The final test
log is `/tmp/tp-capacity-final-tests.log`.
