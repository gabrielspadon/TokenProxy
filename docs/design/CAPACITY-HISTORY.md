# Capacity history and reset planning

The accepted workspace contract remains the visual and behavioral authority.
This slice connects an inspected account's quota windows to retained evidence.
It does not change account eligibility or issue an upstream request.

## Composition

Keep the account comparison and resizable inspector. Add a history section to
the inspector's Quota windows tab. A window selector controls one aligned
observation plot, a compact assumption/result panel and the contributing
observation table. A separate reset-check table displays recorded schedules,
outcomes and exceptions. Historical observations and future reset deadlines
must never share an unlabeled axis.

Use the existing white working surface, cool gray canvas, navy text and indigo
selection. Reuse IBM Plex Sans/Mono, Mantine controls and ECharts. The plot shows
measured points, with no smooth interpolation or implied continuous monitoring.
The same selection is available through keyboard-operated table rows. Preserve
the surrounding account selection and shared filters while inspecting evidence.

The rejected alternatives are a new dashboard of headline forecast cards,
which would overstate uncertain data, and overlapping account percentages on
one line chart, which would mix unlike resources. Separate windows retain their
reported units and scope. Model filters remain visible but do not constrain
quota evidence because the retained observations have no model attribution.

## Query and measurement contract

Use one named operation in the existing bounded analytics worker and its
read-only transaction. Require the inspected account, apply provider, quota
scope and time filters before reading or counting, and retain capture-time
provenance. All retained history means all available time, not a silent 30-day
substitution. At more than 5,000 observations, return an explicit incomplete
result and no forecasts; request a narrower period. Existing paginated history
remains available. Never forecast from the first page alone.

Group by exact provider/account/scope/source/resource/unit/window metadata.
Unknown units may use a separately labeled percentage-point measurement, never
synthetic currency or token quantities. Unknown values and observation times
stay unknown. Keep different values at the same observed time visible and mark
the forecast ambiguous. Increases in remaining quantity are observed increases,
not proof of a reset or a successful warming request.

## Forecast method and limits

A deterministic local scenario uses the latest uninterrupted consumption
segment. Missing measurements, changed limits/reset deadlines and replenishment
start a new segment. Require at least five distinct observation times and a
15-minute span. Evidence older than twice the median observation interval
(bounded to 5–60 minutes) is stale. Reject large gaps and future observations.
Use the median observed interval-consumption rate, with the minimum/maximum
observed interval rates as an empirical sensitivity range, not a statistical
confidence interval. Zero-consumption samples participate; a zero slow rate
means an unbounded late horizon. Forecast at the last observed balance, clearly
dated, rather than inventing a current balance. A known reset horizon bounds
interpretation; it does not establish future replenishment. Rolling-window
replenishment is not modeled.

An operator can vary a workload multiplier under an explicit linear-consumption
assumption or exclude the selected account. Neither changes routing or quota.
Route-policy comparisons link to the separately implemented offline simulator.

## Delivery and verification

1. Add strict query validation, complete bounded worker projection, deterministic
   trend analysis and local scenario projection. Test unit separation, unknowns,
   duplicate times, resets, staleness, limits and transaction/filter behavior.
2. Add the inspector workbench and paginated evidence views. Test protected API,
   cancellation, busy/error responses, selection, range changes and scenarios.
3. Build the isolated application. Inspect private historical data and a labeled
   synthetic repeated-observation fixture at 1440×1000, 1920×1080 and narrow
   widths. Verify keyboard selection, reduced motion, no page overflow and no
   upstream calls. Record remaining limitations rather than inferring history.

ECharts 6.1 documentation was checked for time axes, event selection and missing
values on 2026-09-06. This slice adds no dependency or prediction service.
