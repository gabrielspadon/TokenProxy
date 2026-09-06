# Shared analysis component contracts

The new shell is owned by the Capacity implementation. Context and Economics may
import these modules from `src/shared/workspace` without creating another shell,
scope store, snapshot flag, chart lifecycle or resize implementation.

## WorkspaceProvider and useWorkspace

The dashboard Shell mounts one provider, retaining state across navigation.
`useWorkspace()` returns `scope`, `setScope(patch)`, `snapshot`, `accounts`,
`health`, `quota`, `models`, `activity`, `selectedAccountId`, `setSelectedAccountId`,
`comparisonIds`, `setComparisonIds`, `refresh`, and `observeSnapshot`.
Scope is `{period,start,end,provider,model,connectionId}`. Null means unfiltered.
Absolute timestamps are UTC ISO; start is inclusive and end exclusive.
`period` is presentation state, one of all, 24h, 7d or custom. APIs receive the
absolute bounds. Time presets anchor to the captured timestamp in snapshot mode.
The current backend accepts one provider/account/model per filter. Account
comparison is selection, not an unsupported comma-separated backend filter.
`snapshot` is null in normal operation or `{isolated:true,capturedAt}` from the
mandatory preview HTTP headers. Never hardcode a captured timestamp in source.
`accounts` is the persisted health detail connection list. Its captured status is
not an upstream service guarantee. Activity groups may include removed accounts.

## Data and scope

`useResource(url, {onSnapshot,interval})` returns `{data,loading,error,receivedAt,
refresh}`. Pass `observeSnapshot` when creating another query. Requests abort on
scope changes; the prior scope is not displayed under a new label. Do not poll
historical data or use background per-account query loops.
`analyticsUrl(scope, view='activity', extra={})` maps scope to `/api/analytics`;
extra accepts supported query options such as groupBy, page and pageSize.
`ScopeBar` renders shared period/provider/account/model controls. Put it below the
lens heading. Map Context `scope.start` to `from` (inclusive) and `scope.end` to
`until` (exclusive). The legacy `to` parameter is inclusive and must not be sent
with `until`.

## Rendering

`ActivityBand({resource?,title?})` defaults to shared activity and shows its full
server bucket range. A modal table is the readable data equivalent. Brush end
updates absolute scope. Recorded pending is explicitly distinct from live work.
`AnalyticalChart({option,height=120,label,onEvents,onReady})` owns ECharts lifecycle,
resizing, reduced motion, disposal, canvas rendering and aria description.
Supported events are click, brushEnd and datazoom. Event callbacks do not recreate
the chart. Rich-text tooltips avoid rendering untrusted HTML. Metric colors are
exported as `METRIC_COLORS` (input, cacheRead, cacheWrite, output, failure, selected).
`SelectionDock({children,open,title,subtitle,mark,onClose,detail,height?})` owns a
vertical Group/Panel/Separator with an accessible resizer and explicit close.
The default height is viewport-relative; callers may override after measuring.
`workspace.module.css` exports lensHeading, lensTitle, dockBody, dockGrid,
detailSection and facts for shared spatial rhythm. Use Mantine components and
scoped CSS for new content, not the old Graphite `workbench.css`.

## Data semantics

Historical activity tokens are recorded quantities, not invoice-verified provider
usage. Economics uses the independent completion ledger and its recorded model
rate estimate; zero cost is ambiguous. Cache quantities can exceed recorded input
in old ledger rows. Display the API coverage warning and do not stack inconsistent
rows as though they reconcile. The old snapshot has no context-session history.
