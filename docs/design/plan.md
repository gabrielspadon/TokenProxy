# Operator surface plan

The one place a decision is explained. Code carries none of this.

## Subject and audience

TokenProxy is a local routing gateway. One operator, who lives in a terminal
agent, opens this surface to answer a question the terminal cannot: why a
session landed on an account, what a five-hour window is doing, which saver
stage saved bytes, whether the tunnel is really up, what a key costs. Every
question is about state over time and about trust. The surface holds every
credential the operator owns and must never show one.

## Token system

### Palette

| Name | Hex | Role |
|---|---|---|
| Paper | `#F4F6F8` | canvas, cool not cream |
| Ink | `#17202A` | text, the now-line, primary button fill |
| Slate | `#5B6672` | secondary text, unavailable values |
| Rule | `#D5DBE1` | hairlines, table rules, input borders |
| Signal | `#0F6B5C` | live, healthy, primary action, focus ring |
| Ember | `#B54708` | stale, degraded, cooldown, a window near empty |
| Refusal | `#A3222B` | refused, error, drained, destroyed |

Surfaces are Paper with Ink on it. A raised surface (dialog, menu) is white
`#FFFFFF` with a Rule border and no shadow. Signal, Ember and Refusal are
states, never decoration. Contrast on Paper: Ink 14.9:1, Slate 5.4:1, Signal
6.0:1, Ember 5.1:1, Refusal 6.9:1, all AA for text at any size.

### Type

One family, self-hosted, subset to Latin plus Vietnamese plus symbols under
`public/fonts/`: Fira Sans 400, 500, 600. Fira Mono 400 for identifiers
only, meaning a connection id, a model id, a key prefix, a request id, a
route path. Labels, numbers and copy are Fira Sans with
`font-variant-numeric: tabular-nums` (the subset keeps `tnum`). Arabic,
Persian, Urdu, Hebrew and CJK fall to the system stack, which the evidence
run renders through Noto.

Scale, from a 15 px body on a 1.25 ratio: 12 caption, 13 dense, 15 body,
19 heading, 24 screen title, 30 the one big number on a screen that earns
one. Line length under 72 characters for prose. Headings are sentence case
at weight 600. No all-caps, no letter-spacing, no eyebrow labels.

### Layout

The time axis is where the boldness goes. Every fact with a clock on it,
a quota window, a drain in progress, a session pin, a cooldown, a stale
stream, is drawn on the same horizontal ruler with a fixed vertical
now-line. A window is a band from its start to its reset; the filled part is
what has been consumed; the now-line crosses it where we are. The operator
reads "when does it reset" and "how much is left" from one shape, and the
same shape appears on the first screen, on a connection, and on a session.
Everything else stays quiet: rows and rules, no cards, no shadows, one
border radius (4 px) reserved for controls.

```
1440                                                  390
┌──────┬─────────────────────────────────┐   ┌──────────────────┐
│ rail │ title            ● live 0:12    │   │ ≡ TokenProxy  ●  │
│      │─────────────────────────────────│   │──────────────────│
│ Now  │ Up 3d 4h   errors 0.4%  p95 812 │   │ Up 3d 4h         │
│ Conn │─────────────────────────────────│   │ errors 0.4%      │
│ Sess │ windows          │now           │   │──────────────────│
│ Net  │ claude-a  5h  ███│▒▒▒▒  resets  │   │ claude-a 5h      │
│ Mod  │ claude-a  7d  ██████│▒▒         │   │ ███│▒▒▒  1h 12m  │
│ Keys │ openai-1  1m  ████████│▒        │   │ openai-1 1m      │
│ ...  │─────────────────────────────────│   │ ████████│▒  12s  │
│      │ sessions pinned   3   switching │   │──────────────────│
│      │ spend today   $4.12   30d $88   │   │ pinned 3         │
└──────┴─────────────────────────────────┘   └──────────────────┘
```

Left rail at 1024 px and wider, 200 px, section names as words. Below
1024 px the rail collapses to a top bar and a `<dialog>` navigation. Content
is left aligned, reads top to bottom, max width 1120 px for prose and
forms; tables and the time axis take the full width. Every screen opens
with its title, its freshness state, and the window selector where a
window applies.

### Principles

- Time is the axis. Anything that resets, expires, drains or goes stale sits
  on the ruler.
- Unknown is unknown. A null measure renders as "not reported" in Slate with
  the reason the server gave, never as 0 or a dash.
- Actions say what they do, and the same verb runs through the button, the
  confirmation and the result. Every mutation shows its precondition, what it
  destroys, and whether it can be undone, before it fires.
- Refusals are sentences. `401`, `403 forbidden_class`, `403
  forbidden_loopback`, `412` with the current version, `409` recheck in
  progress, each has its own text and its own next step.
- Keyboard first. Every control reachable by tab, focus visible as a 2 px
  Signal ring, dialogs are native `<dialog>`, disclosure is native
  `<details>`.
- One motion moment: the freshness dot and the now-line tick once per second
  when live, and a colour cross-fade when a stream goes stale. Nothing
  else moves on its own. `prefers-reduced-motion` stops the tick.

## Self-critique against the default

The default I would produce for "AI gateway dashboard": dark sidebar, a grid
of rounded stat cards each with a big number and a sparkline, a gradient
accent, status pills everywhere, a monospace face for every small label,
ALL-CAPS section eyebrows, a table per section. It is the SaaS card kit and
it treats telemetry as decoration.

What changed after the critique:

- The card grid is gone. The first screen is one column of rows on a shared
  time ruler, because the operator's questions are about when, not about
  how many tiles fit.
- Dark canvas with an accent is gone. Paper and Ink, because a credential
  surface that looks like a terminal invites the operator to trust it the
  way they trust their shell, and it should be judged on its own.
- Monospace is restricted to identifiers. Numbers live in the body face
  with tabular figures, so a column of costs aligns without looking like a
  log.
- No eyebrows, no all-caps, no middle-dot meta strings, no arrows on
  buttons.
- The big number is spent once, on spend today, on the first screen only.
- Sparklines are replaced by the window band, which shows the same change
  over time with the reset moment visible.

## Information architecture

`DESIGN.md` sections map to surfaces as follows. Sections that describe the
same stored thing share a screen; a section that describes a mechanism
without a record of its own appears inside the screen of the thing it acts
on.

| Route | Sections | Why together |
|---|---|---|
| `/dashboard` (Now) | §10, §3 overview, §4 live count, §8 today, §20 badge, the gap | What the operator checks first |
| `/dashboard/connections`, `/[id]` | §1, §3, §5, §12 | Windows, drain and service kinds are facts of a connection |
| `/dashboard/sessions` | §4 | Pins and switch records are their own log |
| `/dashboard/network` | §2 | Nodes, pools, global network settings |
| `/dashboard/models` | §6, §13 | Catalog, combos, namespace and compatibility |
| `/dashboard/keys` | §7, §9 | Client keys and the operator/client identity split |
| `/dashboard/usage` | §8 | Per-request facts, rollups, pricing |
| `/dashboard/shaping` | §11 | Saver layers, stages, bytes, compression service |
| `/dashboard/translation` | §16 | Inspection and the console log stream |
| `/dashboard/tools` | §14, §15 | Tool integrations and the extension bridge |
| `/dashboard/remote` | §17 | Tunnel and Tailscale |
| `/dashboard/notifications` | §18 | Outbound webhooks |
| `/dashboard/access` | §19, §9 operator side | Sign-in policy and who the operator is |
| `/dashboard/system` | §10 detail, §20 | Health detail, version, update, database, shutdown |

The first screen answers five questions in order: is the gateway up and how
fresh is what I see; which windows are near empty and when do they reset;
how many sessions are pinned and is one switching; what did today cost;
is there an update. It reports the two unreported facts from the gap
section as unreported, in Slate, with the sentence the backend cannot
answer.

## Fixed contracts honoured

- `src/app/layout.js` carries the four server duties verbatim.
- `/login`, `/callback`, `/`, `/dashboard` stay where the guard expects.
- `/callback` relays by postMessage to the opener origin, then
  `BroadcastChannel`, then `localStorage` with a 30 s expiry; `error`
  outranks `code`.
- One `EventSource` per stream per page, closed on unmount, reconnected
  with backoff, freshness shown as live, stale since, or reconnecting.
- Null measures render as unreported with the server's reason.
- No credential, raw key, signing value, or session identity is rendered.

## Assumptions

- `public/sw.js` is removed. No route in `docs/contract` issues a push, so
  registering it would request notification permission for nothing.
  `src/app/manifest.js` is not recreated; a local admin surface has no
  install story.
- Styling is plain CSS with cascade layers and custom properties in
  `src/app/globals.css`. Tailwind stays wired through PostCSS and unused,
  so the token names appear once.
- `src/i18n/runtime.js` is kept as the translator. Consequence for markup:
  every visible English string is one whole text node, numbers and
  identifiers sit in their own element marked `data-i18n-skip`, and
  sentences are never split by interpolation.
- End-to-end specs use the `playwright/test` runner that ships inside the
  installed `playwright` package, so no dependency is added.
  `tests/e2e/playwright.config.mjs` has no `webServer`.
- State: one `zustand` store for the usage stream and one for auth status.
  Everything else is local component state.
- Fonts cover Latin, Vietnamese, currency and arrows; other scripts use the
  system stack.
- Locale coverage is not uniform, and one locale is deliberately left short.
  Khmer (`public/i18n/literals/km.json`) holds a large share of values
  identical to their English key because argos-translate ships no Khmer
  model, so those strings were never machine-translated and no fallback was
  substituted. An English string standing in for an untranslated one is
  visible as untranslated; a wrong translation is not, so the gap is left
  open rather than filled. Measure it with the command rather than trusting
  a figure written here, because it moves whenever the catalogue grows:
  `node -e 'const m=require("./public/i18n/literals/km.json");const e=Object.entries(m);console.log(e.filter(([k,v])=>k===v).length,"of",e.length)'`
  It closes when a Khmer model exists or a human translation lands.

## Slices, in build order

Each slice is one commit `feat(ui): <slice>` and one `evidence.mjs` run.

| # | Slice | Sections | Routes |
|---|---|---|---|
| 1 | `shell` | §10, §3, §4, §8, §19, §20, gap | `/login`, `/callback`, `/dashboard` |
| 2 | `connections` | §1, §3, §5, §12 | `/dashboard/connections`, `/dashboard/connections/[id]` |
| 3 | `sessions` | §4 | `/dashboard/sessions` |
| 4 | `network` | §2 | `/dashboard/network` |
| 5 | `models` | §6, §13 | `/dashboard/models` |
| 6 | `keys` | §7, §9 | `/dashboard/keys` |
| 7 | `usage` | §8 | `/dashboard/usage` |
| 8 | `shaping` | §11 | `/dashboard/shaping` |
| 9 | `translation` | §16 | `/dashboard/translation` |
| 10 | `tools` | §14, §15 | `/dashboard/tools` |
| 11 | `remote` | §17 | `/dashboard/remote` |
| 12 | `notifications` | §18 | `/dashboard/notifications` |
| 13 | `access` | §19, §9 | `/dashboard/access` |
| 14 | `system` | §10, §20 | `/dashboard/system` |
