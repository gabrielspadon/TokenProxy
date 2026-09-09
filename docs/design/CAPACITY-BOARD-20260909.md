# Capacity board

Supersedes the account control panel (ACCOUNT-CONTROL-PANEL-20260907.md) and
the Capacity parts of COMPACT-WORKSPACE-20260907.md. The operator's correction
on 2026-09-09 was about cognition, not size: too many layers to reach a daily
action, no answer to "how many accounts can take work", no way to add an
account, rename one, or filter by provider or state without leaving the page.

## Composition

Capacity is one page. The shared scope strip and the requests-and-cache block
stay above one account board. The board opens with a summary strip that puts
every account in exactly one bucket (ready, low quota, paused, attention,
unknown); each chip is also the filter for that bucket. The toolbar holds
search, one provider mark per configured provider as a toggle that writes the
shared provider scope, a sort, comparison in Advanced, an inline Add account
row, and refresh.

Every account is one row: expand caret, mark and name, state word with its
evidence in a tooltip, one meter line per quota window with percentage and
reset, activity, and the actions. The three former views (control panel,
activity and analysis, model support) collapse into that row. Activity columns
read from the same shared interval. Model support is the shared model scope:
when a model is chosen, each row carries its persisted admission verdict.

## Direct controls

Rename, pause, resume, drain, priority and per-window auto-pause save from the
field itself, on Enter or blur, with Escape reverting. There is no draft state
that outlives the field and no Save or Discard button. A save reads the current
policy first and writes with that as the expected baseline, so a competing
operator write is absorbed rather than reported as a conflict, and the row
re-reads after every confirmed save. Outcomes surface as notifications.

Everyday hides priority, drain, thresholds and comparison. Advanced shows them
beside each account. The sidebar Everyday/Advanced switch is the only switch;
the page has no second one.

Expanding a row shows Overview, Quota windows, Recent attempts and Policy as
tabs inside the row. Selecting a quota line opens the Quota tab with that
window's history. Selection and comparison still persist in the URL.

The inline Add account row covers an API key or a provider sign-in. Providers
that need endpoint, region or workspace fields keep their full form in
Connections, and the row says so.

## Two levels, one density switch

Everyday is compact progress cards grouped by state (ready, low quota,
paused, attention), most headroom first inside a group. A card carries the
mark, an editable name, the state word, one meter per quota window with its
reset, the attempt count, and pause or resume; expanding it opens the same
evidence tabs inline. Advanced is the dense row board with priority, drain,
auto-pause thresholds and comparison. Both levels carry a comfy or tidy
density switch, stored per browser, defaulting to tidy.

The three upper-right views are back: Accounts (the board or the cards),
Activity & analysis (the sortable account table with recorded activity, the
uncached, cached-read and cache-write split, every retained window, and the
seven-day reset horizon) and Model support (every account's persisted
admission verdict and support evidence for one model). Choosing an account
in either read view lands on the board with that account expanded.

The Requests & cache block keeps its four totals and offers three charts:
Requests (request and attempt counts over cache token tracks), Tokens (input,
output, cache read and cache write over time) and Calendar (a per-day heatmap
of one of those four token metrics, GitHub style, a bucket counted on the UTC
day it starts). Balloons render on the document body so the small chart box
cannot crop them. Selecting an interval or a day narrows the shared scope.

## Global controls

Buttons, inputs, selects, segmented controls, tables and the header follow one
smaller scale (30px controls, 26px compact, 13px interface text, 12px dense
text). Icons replace words where a tooltip carries the meaning. This applies
across the operator surface, not only on Capacity.

## Verification

`tests/unit/account-board-model.test.js` covers buckets, words, filters and
labels. `tests/unit/account-board-fields.test.js` covers the commit-on-Enter
fields, including a Tooltip parent that injects its own handlers.
`tests/e2e/capacity-board.spec.mjs` exercises every direct control against the
representative fixture's real handlers and restores the fixture.
