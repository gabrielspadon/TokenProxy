# Direction 2 — from editorial surface to operator dashboard

Historical direction, superseded by [the corrective redesign mandate](./REDESIGN-20260907.md). The intermediate Graphite composition was also rejected.
The paper/Fira palette and tile-led layout below are no longer binding.
Existing files under `docs/design/evidence/` record earlier passes, not current verification.

The first build reads as an editorial document: prose-led, quiet, almost no
chrome. The operator asked for a dashboard: telemetry where required, control
panels, quick actions, icons, richer interaction, motion when it answers an
action. This document is the binding design direction for pass 2. It amends
DESIGN.md; where the two disagree, this file wins on visual treatment and
DESIGN.md still wins on truthfulness rules (freshness, refusals, blast radius,
never rendering a stored secret or session identity).

## Lineage, studied

- Old TokenProxy (`src/app/ui/theme.css` in the previous tree): dark instrument
  panel. Ground #0c0f15, panel #151a23, amber #e8a33d, 200px rail, and a
  persistent one-line "strap" of live figures under the header. Its strength is
  the strap and the figure discipline (tabular mono numerals everywhere).
- 9router (upstream predecessor): warm cream SaaS. Brand coral #E56A4A, soft
  shadows, Material Symbols icon font, card grids. Its strength is
  approachability and iconography; its look is also the current generated-UI
  cliché (warm cream plus terracotta), so we take the lessons, not the palette.
- Ours: paper #f4f6f8, ink #17202a, signal teal #0f6b5c, Fira Sans/Mono,
  cascade layers, no third-party runtime requests. This identity stays.

## What changes

1. **The strap.** A persistent telemetry strip mounted under the rail header on
   every dashboard screen: gateway live dot, requests per minute, active
   sessions, open connections, errors in the last window. One line, mono
   figures, freshness-aware (live/stale/reconnecting states reuse the existing
   `.fresh` contract). Data from routes already consumed; no new backend.
2. **Stat tiles.** Each screen opens with a row of 3 to 5 tiles: big
   tabular-mono numeral (`--t-30`), small label, delta or sparkline where a
   series exists (usage, shaping, sessions). Tiles are the telemetry layer;
   prose moves below.
3. **Icons.** Self-hosted inline SVG sprite at `public/icons.svg` (stroke 1.5,
   24px grid, `currentColor`). One icon per nav item and per action verb
   (add, drain, test, delete, pause, send, key, shield, globe). No icon font,
   no CDN, the no-third-party-request rule holds.
4. **Control panels.** Mutating surfaces group into bordered panels with a
   clear verb row (primary action plus quick options), not inline prose forms.
   Confirm dialogs keep precondition, blast radius, reversibility verbatim.
5. **Motion, only where it answers.** Number roll on a figure that just
   changed; 120ms ease on dialog open; freshness dot pulse only while
   reconnecting; sparkline draws once on first paint. No entrance animations on
   scroll, no per-card hover theatrics. `prefers-reduced-motion` disables all.
6. **Voice.** Screens talk to the operator: every empty state names the next
   action, every tile label is a plain noun, every button is the verb it
   performs. Already the DESIGN.md contract; pass 2 keeps it.

## Token additions (globals.css)

    --signal-deep: #0a4a40;   /* pressed/active primary */
    --wire: #7ba8a0;          /* sparkline secondary, gridlines */
    --strap-h: 34px;

Depth stays border-drawn (identity), radius stays 4px, no new shadows.

## What does not change

Palette family, type family, cascade-layer architecture, the fence (no old-UI file is read for pass-2 styling; the lineage
study above was operator-authorized and limited to token reading), the e2e
contracts, and evidence gates. All interface text is English.

## Order of work

Shell plus strap plus sprite first (everything inherits), then screens in
evidence order: connections, sessions, network, models, keys, usage, shaping,
tools, notifications, access, system. Each slice: build,
lint, e2e spec, evidence re-run, screenshots read at 390/768/1440.
