# Analytical workspace

The [corrective redesign mandate](REDESIGN-20260907.md) supersedes earlier visual choices. This document retains the analytical and component context. Use the new Manrope, petrol-teal, shared appearance and side-inspector system for current implementation; preserve the measurement and interaction requirements below.

The user rejected the Graphite composition. Its build and interaction results are
historical technical evidence, not visual acceptance. This direction replaces its
graph-led overview with a linked workspace for account capacity, context and token
economics. The implementation must be judged on rendered real workload data.

## Established component ownership

Versions were checked against the package registry and current primary
documentation on 2026-09-06. React 19.2.4 and Next.js 16 remain the application
foundation. These packages are pinned exactly for the initial implementation.

| Capability | Owner | Version |
| --- | --- | --- |
| Controls, overlays, accessible forms | Mantine core/hooks/form | 9.6.0 |
| Date ranges and feedback | Mantine dates/notifications | 9.6.0 |
| Date package required by Mantine dates | Day.js | 1.11.18 |
| Sorting, pinning, selection and table models | TanStack Table | 9.2.4 |
| Bounded viewport rendering for long lists | TanStack Virtual | 3.14.10 |
| Linked time axes, selection, zoom and analytical series | Apache ECharts | 6.1.0 |
| Accessible workspace resizing | react-resizable-panels | 4.12.4 |

Mantine uses its CSS layers, theme and component APIs, with scoped CSS modules
for the product composition. Emotion is not needed. Mantine's React 19.2 minimum
matches the existing React version. Table v9 uses `useTable` and explicit
`tableFeatures`; v8 examples are not compatible. Panels v4 uses `Group`, `Panel`
and `Separator`, with percentage sizes expressed as strings. ECharts uses
explicit chart/component imports and a single lifecycle wrapper with disposal,
resize, reduced motion and a readable data equivalent.

Tailwind remains available for existing layouts. Zustand retains stream state;
dnd-kit retains actual reorder controls. XYFlow remains appropriate for editable
routing topology, not for a decorative summary of accounts. Existing Recharts
views are converted where the new shared chart contract replaces them; unused
components and dependencies are removed after the last consumer moves.

## One composition, three analytical lenses

A compact navigation system and scope bar stay stable across Capacity, Context
and Economics. The period, provider, account and model filters survive lens
changes. A linked activity band shows the selected time interval. The center is
an account comparison book, shared-time context tracks or an economics ledger.
A resizable detail/comparison dock retains the user's place in the data.

Capacity compares all configured accounts and each reported quota window with
aligned units, reset times and observation age. A future reset horizon is visually
separate from historical request activity. Missing measurements remain unknown.
Model support evidence and local routing admissibility are distinct from an
upstream guarantee. Provider identity uses the actual brand mark and name.

Context links attempts, cache observations, context estimates and signed byte
stages. Missing historical context data remains absent. A prefix discontinuity
is an observation, not proof of compaction or a recovered agent hierarchy.

Economics separates recorded token quantities, cached reads, cache writes,
output and the application's recorded cost estimate. Historic zero costs do not
prove free usage. Usage records and context attempts are not joined by guessed
timestamps. Cohort comparison remains descriptive, with explicit denominators.

## Rendering gates

The desktop must make account comparison possible without tiny text. Main table
and control labels use at least 13px. Shared axes, numeric alignment and visible
selection carry structure; a grid of decorative statistic cards does not.
Provider colors carry identity, stable metric colors carry quantities, and
selection has its own accent. Motion explains selection or incoming observations.

Render at 1440x1000 and 1920x1080 using the isolated production snapshot before
extending the composition to every route. Verify narrow layout, keyboard access,
reduced motion, chart-to-table selection, filters, inspection and actual isolated
control persistence. Technical passes cannot override a rejected visual design.
The private snapshot stays outside Git and any public hosting destination.

## Primary documentation

- [Mantine Next.js integration](https://mantine.dev/guides/next/)
- [Mantine React requirements](https://mantine.dev/changelog/9-0-0/)
- [TanStack Table state](https://tanstack.com/table/latest/docs/framework/react/guide/table-state)
- [TanStack virtualization](https://tanstack.com/table/latest/docs/framework/react/guide/virtualization)
- [ECharts data and transforms](https://echarts.apache.org/handbook/en/concepts/dataset/)
- [ECharts component lifecycle](https://echarts.apache.org/handbook/en/concepts/chart-size/)
- [Resizable panel documentation](https://github.com/bvaughn/react-resizable-panels)
- [Perfetto shared-time selection](https://perfetto.dev/docs/visualization/perfetto-ui)
- [Honeycomb cohort investigation](https://docs.honeycomb.io/investigate/analyze/identify-outliers)
