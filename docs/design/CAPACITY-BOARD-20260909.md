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

Two upper-right views remain: Accounts and Model support (every account's
persisted admission verdict and support evidence for one model). The former
Activity & analysis view is folded into the board: every card and row
carries a Usage line on the quota grid (recorded input over the shared
interval as uncached, cached-read and cache-write shares, the total and the
cached share), the attempt count carries failures and pending streams, the
sort offers most attempts, and a slim Reset horizon band above the accounts
plots the stored deadlines of the next seven days with a picker that lands
on the account's window. Choosing an account in Model support lands on the
board with that account expanded.

Two palettes, one page: composition (usage shares, token tracks) uses cool
hues (blue for uncached input, teal for cached reads, violet for cache
writes) and status (quota meters) uses semantic green, amber and red, so a
share bar and a status bar never read alike.

Every quota line carries a hide control that floats over its end and shows
on hover or focus, so a line reserves no width for it. A hidden window
leaves the card or row and the card gets shorter: the only trace is a small
count in the state row, which opens the hidden list under the lines on
demand, where each window has its show control. The choice is stored per
browser, survives reloads and sessions, and applies to every view that
draws quota lines (the board and the Activity & analysis cards alike).
Inside one product, a depleted longer window (weekly, monthly) hides its
shorter windows (session, hourly) on its own, because a session allowance
means nothing while the week is spent; those come back the moment the longer
window has room again, and their chip says why they are away. A stale
depleted reading does not hide anything.

Meters carry one colour per level on the fill and on the number: green above
half, amber at or under half, red at or under 20% or the account's own
auto-pause threshold, and a red hatched empty bar for a depleted window. A
stale reading stays grey.

The Requests & cache block keeps its four totals and offers three charts:
Requests (request and attempt counts over cache token tracks), Tokens (input,
output, cache read and cache write over time) and Calendar (a per-day heatmap
of one of those four token metrics, GitHub style, a bucket counted on the UTC
day it starts). Balloons render on the document body so the small chart box
cannot crop them. Selecting an interval or a day narrows the shared scope.

The time charts carry a scale (Auto, the server's own choice for the period,
then one minute up to one week) and a style (lines, bars, area). A chosen
scale reads its own series with `bucketMs`; the server never goes finer than
its point cap allows and the foot says when a scale was too fine. The
calendar always reads whole UTC days, spans the last year when the period is
open, and picks its metric from a grouped list (Tokens: In, Out; Cache: Read,
Write) so no option repeats a word. All four choices persist per browser.

## The shared kit

The board language now lives in `src/shared/workspace/board.module.css` and
`src/shared/workspace/Board.js`: the panel, the summary strip of state chips,
the toolbar (search, filter chips, sort in Advanced, the density switch, the
primary action, refresh), state groups, cards with a head, a state row and
evidence lines, status meters and composition bars, the hidden-window
affordances, and the comfy or tidy density variants. Capacity's account
board is the reference composition; every other working surface composes
the same classes through the kit, so one stylesheet owns the look and one
density choice applies to the whole application.

## Only what matters

The model filter in the scope bar and the model picker in Model support list
only models of providers with at least one configured account; a provider
filter narrows them by id or alias alike, and labels name the provider rather
than its alias. The add-account provider list leads with a Popular group
(Claude Code, Codex, OpenAI, Anthropic, Gemini and the other common ones) and
keeps the full alphabetical list under it, so a popular provider is reachable
from the top and from its place in the list.

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
