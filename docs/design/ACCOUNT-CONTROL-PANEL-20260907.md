# Account control panel

> Superseded on 2026-09-09 by CAPACITY-BOARD-20260909.md. The card panel, its Cards/Rows toggle, Customize and per-card Save/Discard no longer exist.

The operator needs to identify an account with capacity, compare its windows,
understand when each resets, and pause or adjust its safety buffer immediately.
Capacity therefore opens on a control panel. Activity and analysis retains the
existing charts, account table, linked inspector and evidence. Model support
remains a separate view. Shared provider, account, model and time scope survives
these changes. Token savings receives a recognizable navigation label and a
categorized overview before its existing advanced workbench.

## Rendered references and decisions

The implementation lead inspected the actual rendered examples on 2026-09-07,
in addition to reading the guidance supplied by the operator.

- [Cloudscape service dashboard demo](https://cloudscape.design/examples/react/dashboard.html)
  places an explicit page action above a visually grouped service summary and
  exposes chart series through visible legend controls. Adopt direct actions,
  clear grouping and customization. Its large overview panels would push our
  account controls too far down, so use compact account-level status instead.
- [Carbon meter](https://carbondesignsystem.com/data-visualization/simple-charts/#meter)
  shows a percentage through length with an independent threshold marker.
  [Carbon bullet charts](https://carbondesignsystem.com/data-visualization/simple-charts/#bullet)
  align rows on one scale and retain exact values. Apply these to each quota
  window on a shared 0–100 percent scale. Omit unsupported qualitative bands,
  percentile dots and decorative rings. A reset countdown is an adjacent time
  measurement, never an extra percentage or a fabricated replenishment.
- [Wikimedia's live Grafana ResourceLoader dashboard](https://grafana.wikimedia.org/d/000000066/resourceloader?orgId=1)
  keeps time scope, refresh and dataset controls together and groups deeper
  charts in collapsible sections. Preserve scope and progressively disclose
  analysis. Its narrow summary labels visibly truncate at the inspected width;
  our account names and essential window labels must wrap without losing meaning.
- [NN/g on dashboard perception](https://www.nngroup.com/articles/dashboards-preattentive/)
  supports position and length for quick comparison. Selection, provider identity
  and quantity use distinct visual roles. Color never carries a state alone.
- [Cloudscape table preferences](https://cloudscape.design/patterns/resource-management/view/table-view/)
  informs persisted visibility and density. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
  informs keyboard operation, focus, contrast, labels and responsive controls.

## Interaction and measurement contract

Use the current visual system from REDESIGN-20260907.md, with Mantine components,
Manrope interface text, IBM Plex Mono identifiers, white working surfaces, cool gray
canvas, deep navy navigation and petrol-teal action and selection. Provider
marks identify accounts. Muted meter colors encode measured headroom and threshold
state. Motion is a short transition when a real measurement changes, disabled
under reduced motion. No animated activity is invented.

Cards expose Pause or Resume, Limits and Inspect. Comparison uses aligned quota
measurements. Search covers the complete configured account collection. Visibility
and density choices are browser preferences with an explicit reset. Hidden accounts
remain configured and routable. Account order does not change on a clock tick.

Windows are the union of admin quota scopes, retained snapshot keys and configured
threshold keys. Missing percentages remain unknown. Unlimited does not mean 100
percent. An elapsed reset remains pending until a new observation exists. Used
percentage is explicitly derived from known remaining percentage; neither quantity
establishes tokens or money. Observation age and historical activity period remain
separate. Historical analytics outside a loaded page stay unknown.

Manual pause changes future routing eligibility without cancelling an in-flight
response. Resume preserves independent drain, cooldown, model and quota gates.
Quota thresholds pause when recorded remaining percentage is at or below the
configured value; zero clears that window's threshold. Priority is a provider
ordering input, not a promised traffic share. Controls load current configuration,
submit a narrow patch with expected policy fields, then verify persisted readback.
Conflicting policy returns 409 and preserves the draft. Credential and quota
refreshes do not create false conflicts or get overwritten by narrow policy edits.

Token savings shows actual effective settings and signed byte-stage evidence.
Content-changing controls preserve existing consent, configuration hash and
readback. Smaller byte size is not described as proven token, financial or quality
savings. English is the only product interface language; arbitrary Unicode names,
provider content and protocol translation remain supported.

## Acceptance

Verify exact backend effects, persistence after reload, stale-write refusal and
failure feedback against an isolated representative SQLite fixture. No paid model
request is part of this validation. Inspect cards and comparison at 1440×1000 and
1920×1080, then narrow layouts, keyboard access, reduced motion and long labels.
Verify the first account is accessible without traversing the activity chart.
Preserve the existing analysis and exact-link inspection journeys. Run repository
lint, mocked suites, production build and isolated browser checks before publishing
or deploying; a development screenshot is not an immutable release receipt.
