# Context telemetry, design plan

The operator wants to watch a conversation's context grow, shrink, and get
shaped on its way through the gateway, and to see which of their projects
that conversation belongs to without declaring it. This plan says what the
screens are, how context over time is drawn, how a setting sits next to the
number it governs, where motion earns its place, how projects are inferred
and corrected, what it costs to render, and what it refuses to do.

Everything in `docs/design/DIRECTION-2.md` and the grammar in
`src/app/globals.css` binds. Where this plan names a class, a token, or a
component, it is one that already exists under `src/shared/components/` or
in `globals.css`, and the plan says so when it needs a new one.

## 0. Substrate status, reconciled

`docs/design/context-telemetry/SUBSTRATE.md` has since landed (commit
`2ef36721`), built from live queries against the running database rather
than from source reading alone. It is the factual document and it wins
every disagreement with this plan. Three corrections follow from it, and
they are load-bearing.

**A session key is not persisted anywhere.** Section 1 below reads the
session key as resolvable at request time, which is true, but
`requestStats` and `requestDetails` carry no session column at all
(`SUBSTRATE.md` section 2, checked against the live `.schema`). The
durable `sessionHash` exists only in `sessionAffinity` and
`accountSwitches`, which are pin-state and switch-receipt tables never
joined to token rows. Joining session to `connectionId` to `requestStats`
returns rows fast and returns them wrong, because a connection is a shared
account, not a conversation. **Nothing in sections 2 through 6 can be
built until a session key column lands on `requestStats`, written at the
call site in `chatCore.js` that already computes it.** That is work item 1
in section 10 and it gates every screen.

**Per-technique attribution has no SQL home.** The saver ledger this plan
draws as its central artifact is computed live and written only to
`DATA_DIR/token-saver/events.jsonl`, correlated to a session solely through
the `ridSessions` Map, which evicts on TTL and on restart
(`SUBSTRATE.md` section 4). There is no query to write for a per-technique
rollup today. A durable home for those events, joinable to the new session
column, is work item 1b.

**`requestDetails` is empty by configuration, not by fault.** It holds zero
rows live because `enableObservability` is false in the settings row.

Section 1 below is retained as the request-time inventory it always was.
Where it and `SUBSTRATE.md` differ on what *persists*, `SUBSTRATE.md` is
correct.

## 1. What can be observed today, and the linkage question

### 1.1 Per request, at request time, in memory

`open-sse/handlers/chatCore.js` computes, per attempt, everything a turn
ledger needs, and then throws most of it away.

- A conversation-stable session key. `resolveSessionId` at
  `open-sse/utils/sessionManager.js:223` returns a client session id when
  the harness sent one (Claude Code puts it in `metadata.user_id` and in
  `x-claude-code-session-id`, Codex in `prompt_cache_key` or
  `session_id`, Antigravity in `request.sessionId`, others in
  `x-session-id` and siblings, `sessionManager.js:102-165`). When no
  client id exists it falls back to a hash of accumulated assistant text
  (`sessionManager.js:190-209`), then the provider workspace id, then a
  per-connection id. The chat handler reduces this to an 8-hex prefix
  (`src/sse/handlers/chat.js:792`, `idPrefix(credentials.sessionHash)`).
  So successive requests from one harness conversation ARE linkable at
  request time for Claude Code, Codex, Antigravity, Amp and anything
  sending a session header, and linkable by assistant-text hash for the
  rest. That resolves the riskiest assumption in the affirmative for the
  moment of the request.
- The client tool. `detectClientTool` at
  `open-sse/utils/clientDetector.js:20` returns `claude`, `codex`,
  `gemini-cli`, `antigravity`, `github-copilot`, `deepseek-tui` or null.
- Pre-dispatch context estimate. `saverMeta.ctxTokens` is
  `estimateRequestTokens × calibration`, where the calibration ratio is a
  smoothed provider-count over estimate per session.
- Post-completion actuals. `doneFields` in
  `open-sse/handlers/chatCore/requestDetail.js` carries `in`, `out`, `cr`
  (cache read), `cw` (cache creation), `t`, `ttft`, normalised across the
  Claude, OpenAI and Gemini usage shapes. `ctxTokensActual = in + cr + cw`.
- Cache-epoch bytes. The `ceBodies` map (CE_CAP 2048 sessions, 30 min
  TTL, 64 KiB SHA1 blocks, `chatCore.js:272`) yields `ce`, the byte length
  of the prefix that survived from the previous request, and `compactHint`
  when `ce` fell under half the previous body.
- Saver ledger. `measureSaverStage(stage, ran)` records `{stage, delta,
  in, out}` for `tools, schema, thinking, rtk, privacy, inject, pxpipe,
  mem, headroom, qac, pairs, reorder, midinject, final`, emitted as
  `save=stage:delta,...` and `save_tok`.
- Transform path notes. `notePath(rid, "XFORM.compact-applied" |
  "XFORM.mem-pruned" | "XFORM.headroom-applied" | "XFORM.tool-strip" |
  "XFORM.cache-keep" | "XFORM.cache-legacy")`.
- Route kind. `isNativePassthrough(clientTool, provider)` decides lossless
  passthrough; the translator index decides direct route versus OpenAI
  pivot for a `source:target` pair.
- Combo and fallback. `handleComboChat` in `open-sse/services/compact.js`
  walks a combo's models in order and falls through on throw or 5xx; the
  account-selection loop in `chat.js` retries across connections, and
  `accountSwitches` receives a receipt with `trigger` and `reason`.

### 1.2 What persists, and what it lacks

| Store | Keyed by | Has | Lacks for this feature |
|---|---|---|---|
| `requestStats` (45 d) | time, provider, model | prompt, completion, cached, cache-creation, reasoning tokens, latencies | any session key, any saver delta, `ce`, route kind |
| `usageHistory` | time, provider, model, connection | tokens JSON, cost, `meta.requestedModel` | session key, msg count, saver deltas |
| `token-saver/events.jsonl` (5 MiB, rotated once) | `rid` 8-hex, `saver` | `bytesSaved`, `saveTokEst`, `ce`, `turns`, `compactedTokens`, `toolPrunedChars`, `mediaPrunedItems` | session key, model, actual tokens |
| `context-status.json` (LRU 512 sids, latest only) | `sid` | `ctxTokens`, `ctxTokensActual`, `ceBytes`, `saveBytes`, `compactHint` | history, everything before the latest turn |
| `sessionAffinity` | `(sessionHash, model)` | pinned connection, node, pinnedAt, expiresAt | per-turn anything |
| `accountSwitches` | `sessionHash`, `switchedAt` | from, to, trigger, reason, quota evidence | per-turn anything |
| `requestDetails` (opt-in, ring 200) | id | redacted bodies, 5 KB | off by default, and this plan does not turn it on |

The conclusion is plain. Linkage exists at the moment of the request and is
not written down per request anywhere. `context-status.json` overwrites
each session's previous turn. `token-saver/events.jsonl` has the saver side
per `rid` but no session key and no actual token counts. Nothing joins a
turn to its session after the fact.

### 1.3 Work item 1, before any screen: the turn ledger table

Two tables, additive under `src/lib/db/schema.js`'s auto-sync, written from
the one place every attempt already passes (`onReqSummary` in
`chatCore.js`, which already receives `sid`, `rid`, `doneFields`,
`saverMeta`, `ce`, the route decision and the attempt index).

`contextSessions`, one row per conversation.

| Column | Type | Source | Note |
|---|---|---|---|
| `id` | INTEGER PK | autoincrement | the only key the UI or a URL ever sees |
| `sidHash` | TEXT UNIQUE | the 8-hex `sid` | stored to join, never selected into an API response |
| `clientTool` | TEXT | `detectClientTool` | "claude", "codex", ... |
| `firstSeenAt`, `lastSeenAt` | INTEGER ms | request clock | |
| `turnCount` | INTEGER | increment on write | denormalised for the list screen |
| `model` | TEXT | last requested model | |
| `cwdHint` | TEXT NULL | see 5.1 | last path segment only |
| `cwdHash` | TEXT NULL | sha256 prefix of the full path | grouping key, never shown |
| `systemHash` | TEXT NULL | sha256 prefix of system text with the cwd line removed | secondary grouping key, never shown |
| `projectId` | INTEGER NULL | clustering or operator | |
| `projectSource` | TEXT | "rule", "similar", "operator", NULL | drives the confidence state |

`contextTurns`, one row per attempt.

| Column | Source | Bytes |
|---|---|---|
| `id` PK, `sessionRef` FK, `rid` 8-hex, `attempt` | handler | 20 |
| `ts`, `latencyTotal`, `ttft`, `status` | `doneFields` | 24 |
| `provider`, `model`, `requestedModel`, `connectionId`, `comboName` | handler | ~80 |
| `msgCount`, `toolCount` | body shape before savers | 8 |
| `ctxEst`, `ctxActual`, `inTok`, `outTok`, `crTok`, `cwTok` | `saverMeta`, `doneFields` | 24 |
| `ceBytes`, `bodyIn`, `bodyOut`, `compactHint` | `ceBodies`, saver ledger first `in` and last `out` | 16 |
| `saveDeltas` JSON `{stage: delta}` | saver ledger | ~160 |
| `xform` JSON list | `notePath` XFORM entries | ~60 |
| `route` "passthrough", "direct", "pivot" and `pair` "claude:kiro" | translator decision | ~30 |
| `switchTrigger`, `switchReason` NULL | the switch receipt when this attempt caused one | ~40 |

About 460 bytes per attempt row plus index. Indexes on
`(sessionRef, id)` and `(ts)`. Retention follows `requestStats`, 45 days,
swept by the same opportunistic `maybeCleanup`. At a working day of two
thousand turns that is under 1 MiB per day and under 45 MiB at the
retention horizon. At ten times that load it is under 450 MiB, which is
still a single SQLite file on a laptop, and the sweep is a range delete on
the `ts` index.

Nothing in either table is prompt text, a token, a raw key, or a session
identity as the client sent it. `sidHash` is already a salted prefix and it
never leaves the repo layer. The API and the URL use `contextSessions.id`.

### 1.4 Work item 2: the "changed here" record

To draw a settings change on a turn axis the gateway has to remember when
it happened. `PATCH /api/settings` appends `{at, path, from, to}` to `kv`
under scope `settingChanges` for every changed key that governs a stage
(the token-saver layer toggles, headroom target, memory ladder thresholds,
RTK on or off, combo definitions). Secrets never sit under those keys, so
`from` and `to` are safe to store. Capped at the newest thousand entries.

## 2. The screens

Three routes under one rail entry, "Context", between Sessions and Network.
The existing `/dashboard/sessions` keeps pins and switch receipts; the
ledger links into it rather than duplicating it.

| Route | Purpose in one sentence | Data today | Must start recording |
|---|---|---|---|
| `/dashboard/context` | Which projects the gateway is serving right now and how much context each is carrying | none as a project; client tool and model per active request exist in memory (`getActiveSessions`) | both tables in 1.3, project rules in `kv` |
| `/dashboard/context/[projectId]` | This project's conversations on one time axis, and the shape of each | none | same |
| `/dashboard/context/session/[id]` | One conversation, turn by turn, what went in, what came back, what each mechanism did, and why the turn landed where it did | latest turn only per session (`context-status.json`), switch receipts, saver events by `rid` | `contextTurns`, `settingChanges` |

There is no separate "turn" screen. The turn receipt is a panel inside the
session screen so the number and its explanation are never a navigation
apart.

### 2.1 `/dashboard/context`, Projects

Shows. Three measures in the opening row, then one row per project on the
shared 24-hour ruler, then the unsorted bucket.

Can do. Open a project, rename it, merge two, move a session out of the
unsorted bucket into a project, change the ruler horizon.

```
1440
┌──────┬────────────────────────────────────────────────────────────────────┐
│ rail │ Context                                       ● live  updated 0:04 │
│      │────────────────────────────────────────────────────────────────────│
│      │ Conversations today   Context carried now    Compactions today     │
│      │ 14                    412 k tokens           3                     │
│      │                       across 5 open          2 by the client       │
│      │────────────────────────────────────────────────────────────────────│
│ Now  │ project        activity, last 24 h                    │now  turns │
│ Conn │ TokenProxy     ▂▃▅▇▇▆▃  ▂▅▇█▇▅▂     ▃▅▆▇▇      ▂▄▆█▇│    142   │
│ Sess │ certain, 4 conversations, 2 open, context 181 k     ▸ open        │
│ Ctx  │────────────────────────────────────────────────────────────────────│
│ Net  │ OceanStack     ▃▅▆▆▅▃                  ▂▃▅▆▆▅▃▂          │     61   │
│ Mod  │ certain, 3 conversations, 1 open, context 96 k      ▸ open        │
│ ...  │────────────────────────────────────────────────────────────────────│
│      │ MaritimeRAG               ▂▄▆▇▆▄▂                        │     28   │
│      │ probably, matched by shared setup, 1 conversation    ▸ open  ✎ fix │
│      │────────────────────────────────────────────────────────────────────│
│      │ Unsorted                        ▂▃▃▂                     │      9   │
│      │ 2 conversations sent no working directory            ▸ sort them   │
└──────┴────────────────────────────────────────────────────────────────────┘

390
┌──────────────────────┐
│ ≡ TokenProxy       ● │
│──────────────────────│
│ Context              │
│ Conversations  14    │
│ Context now    412 k │
│──────────────────────│
│ TokenProxy    142 t  │
│ ▂▃▅▇▇▆▃ ▂▅▇█▇▅▂ ▃▅▆│ │
│ certain, 2 open      │
│──────────────────────│
│ OceanStack     61 t  │
│ ▃▅▆▆▅▃   ▂▃▅▆▆▅▃▂  │ │
│ certain, 1 open      │
│──────────────────────│
│ MaritimeRAG    28 t  │
│    ▂▄▆▇▆▄▂         │ │
│ probably   ✎ fix     │
│──────────────────────│
│ Unsorted        9 t  │
│ no working directory │
└──────────────────────┘
```

The activity band per project is the `.spark` bar list, one bar per
fifteen-minute bucket over the horizon, height by turns, so it reuses the
existing draw-once animation and the peak tone. The now-line is the
`.ruler` now mark shared by every row. "Context carried now" is the sum of
`ctxActual` over the newest turn of each session seen in the last ten
minutes, and its `why` disclosure says exactly that, with the count of
sessions it summed and that it is the provider-reported input plus cache
read plus cache write.

Empty state, before the tables exist or on a fresh install. "No
conversation has passed through since context recording started. The first
request from Claude Code, Codex or any client sending a session id will
appear here within a second of finishing." No sample data, no grey bars.

### 2.2 `/dashboard/context/[projectId]`, Project

Shows. The project's measures, its rule (the working directory names that
route into it), then one row per conversation on the shared ruler. Each row
draws the conversation's context shape as a small version of the ledger
band from section 3, so the operator recognises a conversation by its
profile before opening it.

Can do. Open a conversation, move a conversation to another project (which
also teaches the rule), rename or merge the project, dissolve it (sessions
fall back to unsorted, rule removed, reversible by re-sorting).

```
1440
┌──────┬────────────────────────────────────────────────────────────────────┐
│ rail │ TokenProxy                              ● live   ✎ rename   merge  │
│      │ Sorted by working directory name "tokenproxy", "tokenproxy-rebuild"│
│      │────────────────────────────────────────────────────────────────────│
│      │ Conversations 4    Turns 142    Compactions 2    Saved by shaping  │
│      │                                                  1.9 MB, 31 %      │
│      │────────────────────────────────────────────────────────────────────│
│      │ conversation                 context, oldest turn to newest  │now  │
│      │ Claude Code, since 08:12      ▁▂▃▄▅▆▇█┊▃▄▅▆▇█▇┊▄▅▆▇        │      │
│      │ 61 turns, open, on claude-a   181 k of 200 k, 2 compactions  ▸ open│
│      │────────────────────────────────────────────────────────────────────│
│      │ Codex, since 09:40            ▁▂▂▃▃▄▄▅▅▆                    │      │
│      │ 22 turns, open, on openai-1   96 k of 400 k                  ▸ open│
│      │────────────────────────────────────────────────────────────────────│
│      │ Claude Code, yesterday 16:02  ▁▂▃▄▅▆▇▇█┊▂▃▄                  │      │
│      │ 48 turns, finished            ended at 71 k                  ▸ open│
└──────┴────────────────────────────────────────────────────────────────────┘
```

A conversation is named by what the operator can recognise, the client
tool and its start time, never by any identity field. The row's `who .sub`
carries the account it is currently pinned to, as a link into
`/dashboard/connections/[id]`, because "why did this land there" is one
click from here and answered in full on the session screen.

### 2.3 `/dashboard/context/session/[id]`, Conversation

This is the screen the work is for; section 3 owns its centre.

Shows. Opening measures (context now against the window, turns, saved by
shaping this conversation, compactions, account), then the ledger, then
the turn receipt for the selected turn, with the stage controls inside it.

Can do. Select a turn by click or arrow key, scroll the turn axis, jump to
the latest, open a stage's setting and change it, follow the account link,
move the conversation to another project.

```
1440
┌──────┬────────────────────────────────────────────────────────────────────┐
│ rail │ Claude Code, since 08:12, TokenProxy         ● live   turn 61 of 61│
│      │────────────────────────────────────────────────────────────────────│
│      │ Context now      Turns   Shaping saved      Compactions   Account  │
│      │ 181 k of 200 k   61      612 kB, 27 %       2             claude-a │
│      │ 91 %, reported                                            pinned  │
│      │────────────────────────────────────────────────────────────────────│
│      │ 200 k ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ window ┈┈┈ │
│      │                        █                         ▓█                │
│      │                      ▓██              ▓▓         ▓█  ▓▓█▓█         │
│      │                   ▓▓▓██▓   ▓          ▓█▓       ▓▓█  ▓▓█▓█         │
│      │                ▓▓▓▓▓█████▓▓█▓      ▓▓▓▓█▓▓    ▓▓▓▓█▓▓▓▓█▓█▓        │
│      │         ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ ┊ ▒▒▒▒▒▒▒▒▒▒▒ ┊ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│  │
│      │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ ┊ ▒▒▒▒▒▒▒▒▒▒▒ ┊ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│  │
│      │ 1        10        20        30 ┊ 40       ┊ 50        60   │now  │
│      │                                 ┊ client   ┊ gateway              │
│      │                                 compacted  compacted, memory ladder│
│      │                                 −118 k     −64 k                   │
│      │ shaping ▁▂▁▁▃▂▁▁▂▃▅▂▁▁▂▂▁▂▃▁▁▁▂▁ ▁▂▁▁▂▂▂▁▂▃▁ ▁▂▂▁▂▁▃▂▁▁▂▁▂▃▁▂│  │
│      │                                             ▲ RTK turned on        │
│      │────────────────────────────────────────────────────────────────────│
│      │ Turn 61, 10:14:02, 4.1 s, first token 0.8 s                        │
│      │ ┌───────────────────────────────────┐ ┌──────────────────────────┐ │
│      │ │ What went in           181 k tok  │ │ Why it landed here       │ │
│      │ │ already cached  164 k  (cache read)│ │ Pinned to claude-a since │ │
│      │ │ new this turn    17 k             │ │ turn 3. The pin held     │ │
│      │ │ wrote to cache   17 k             │ │ because the 5 h window   │ │
│      │ │ came back       1.2 k             │ │ had 41 % left. Route     │ │
│      │ │ where these come from   ▸         │ │ claude to claude, native,│ │
│      │ └───────────────────────────────────┘ │ no translation.          │ │
│      │ ┌────────────────────────────────────────────────────────────────┐ │
│      │ │ What shaping did to this turn      412 kB in, 391 kB sent      │ │
│      │ │ tools         −11.2 kB ████████████            [on]  filter ▸  │ │
│      │ │ rtk            −6.8 kB ███████                 [on]  ▸         │ │
│      │ │ thinking       −2.1 kB ██                      [on]  ▸         │ │
│      │ │ headroom        0      did not run, 91 % is under the 95 % bar │ │
│      │ │                                                 target 95 % ▸  │ │
│      │ │ mem             0      did not run              [on]  ▸        │ │
│      │ │ schema, privacy, pxpipe, qac, pairs, reorder   ran, 0 bytes    │ │
│      │ └────────────────────────────────────────────────────────────────┘ │
└──────┴────────────────────────────────────────────────────────────────────┘

390
┌──────────────────────┐
│ ≡ TokenProxy       ● │
│──────────────────────│
│ Claude Code, 08:12   │
│ TokenProxy           │
│ Context  181 k/200 k │
│ Turns 61  Saved 27 % │
│──────────────────────│
│ 200 k ┈┈┈┈┈┈┈┈┈┈┈┈┈ │
│              ▓█  ▓█▓ │
│          ▓▓▓▓██▓▓█▓█ │
│ ▒▒▒▒▒▒▒┊▒▒▒▒▒▒▒▒▒▒▒│ │
│ 30     ┊40      60│  │
│    client compacted  │
│    −118 k            │
│ ‹ earlier   latest › │
│──────────────────────│
│ Turn 61, 10:14       │
│ in 181 k, back 1.2 k │
│ cached 164 k         │
│──────────────────────│
│ shaping  −20.1 kB    │
│ tools    −11.2 kB    │
│   [on]  filter ▸     │
│ rtk       −6.8 kB    │
│   [on]  ▸            │
│ headroom  did not run│
│   target 95 % ▸      │
│──────────────────────│
│ Why here             │
│ Pinned to claude-a   │
│ since turn 3 ...     │
└──────────────────────┘
```

The one big number on this screen is the context measure, `.measure.big`,
because it is the thing the operator came to read. Everything else on the
screen is at body size.

## 3. The visual grammar for context over time

### 3.1 The encoding, the turn ledger

Context over a conversation is drawn as a turn ledger. The axis is turns,
left to right, oldest to newest, with the fixed now-line at the right edge
where the `.ruler` grammar already puts it. Each turn is one column. A
column is a stacked bar of three segments, drawn against a ruled ceiling at
the model's context window.

- Already cached, `cr`, in `--wire`, at the bottom. What the provider read
  from its cache. It is the part that is paid at cache-read price and that
  the operator wants to see staying large and flat.
- New this turn, `in` minus nothing, in `--signal`, on top of it. Fresh
  input the provider had to read in full. It includes what was written to
  cache this turn, `cw`, drawn with the estimated hatch of
  `.band[data-confidence="estimated"]` inside the same segment, so cache
  writes are visible as the striped part of new input.
- Came back, `out`, in `--ink`, on top. The answer.

The bar's total height is `ctxActual` plus `out`, the context the next turn
will start from. The ceiling is the `contextWindow` from
`getCapabilitiesForModel`, drawn as a dotted rule with its value at the
left. When a bar's total crosses 85 % of the ceiling the new-input segment
takes `--ember`, and above 95 % `--refusal`, which is the same level rule
`.band[data-level]` uses for a quota band, so the operator reads "this
conversation is near its window" with the same eye they read "this window
is near empty".

A turn that is in flight, or that finished without a usage block, has only
`ctxEst`. It is drawn as a single hatched column at the estimate's height
and its receipt says "estimated from body bytes, calibrated on this
session's earlier turns" with the calibration ratio. When the actual
arrives the column settles into its three segments. This is where one of
the plan's four motion moments lives, section 4.

Beneath the ledger, aligned column for column, sits the shaping lane, a
short `.spark` list of bars whose height is the bytes every stage together
removed from that turn's body, `bodyIn` minus `bodyOut`. It is one tone,
`--wire`, and it is deliberately not stacked by stage. Stage attribution
per turn is read in the receipt, where names are printed next to the bars
and no legend is needed. The lane exists to show WHEN shaping did a lot and
when it did nothing, so a turn where the lane is tall and the ledger still
grew tells the operator the growth was not something shaping could touch.

Below the lane sit the event marks. Each is a `.ruler .mark` at the turn
column where it happened with a one-line label under it. Three kinds.

- Compaction, a dashed vertical break `┊` through the ledger between two
  columns, with the drop printed under it as a negative number and its
  author named, "client compacted" (detected by `compactHint` together
  with a fall in `msgCount`) or "gateway compacted, memory ladder"
  (detected by `XFORM.compact-applied` in `xform`, in which case the same
  turn also shows a tall `mem` bar in the receipt). The break is drawn
  BETWEEN columns because compaction happens between requests, not during
  one. The column to the right starts lower, and the eye reads the cliff.
- Account switch, a `.mark` in `--ember` with the trigger word from the
  receipt's closed vocabulary ("quota exhausted", "model failed"), linking
  to the receipt on `/dashboard/sessions`.
- Changed here, a `.mark.soft` with the setting's label and its new value
  ("RTK turned on", "headroom target 95 % to 90 %"), from
  `settingChanges`. Turns to the right ran under the new value.

Colour carries state and nothing else. `--wire` cached, `--signal` new,
`--ink` answer, `--ember` and `--refusal` only when a threshold is crossed.
Every segment is also distinguishable by position, so a reader who cannot
tell the tones apart still reads bottom as cached, middle as new, top as
answer.

### 3.2 Why not a stacked area

A stacked area draws the same three quantities as continuous bands and
connects consecutive turns with a slope. Two things go wrong. Compaction
becomes a downhill slope between two turns instead of a cliff between them,
so the single most important event in a context's life is rendered as if
it took time and happened gradually, when it happened in zero requests.
And turns lose their identity. A conversation is a sequence of discrete
requests, each with its own receipt; an area invites the reader to point
at a spot between two turns and ask what happened there, and the answer is
nothing. The area also lies about magnitude when a segment is small,
because the eye reads the band's slope rather than its thickness. Discrete
columns keep every turn selectable by keyboard and every bar an honest
height.

### 3.3 Why not a sankey

A sankey would take the body at ingress and split it into what each stage
removed and what was sent, per turn or for the whole conversation. It
loses time entirely, so context growth and compaction, the reason the
operator opened the screen, cannot appear on it. It also assumes a
conserved flow, and the saver ledger is not conserved. A stage can grow
the body (the saver guard flags growth over 5 %), a stage can run and move
zero bytes, and the same bytes cannot be attributed to two stages because
the pipeline is sequential, so a sankey's braided ribbons would suggest
interactions that the mechanism does not have. And a fourteen-stage sankey
is a legend puzzle. The waterfall in the receipt, section 3.4, shows the
same attribution for one turn in a form that prints its labels.

### 3.4 Where the per-stage waterfall does belong

For one selected turn, the receipt's shaping panel is a waterfall from
`bodyIn` to `bodyOut` in pipeline order. Each stage is a row, its bar the
bytes it removed (or added, drawn to the left of the zero rule in
`--ember`), its name and its number printed in the row, and its control on
the same row (section 4). Stages that ran and moved nothing collapse into
one summary row so the panel stays short. This is the place where the
technique's contribution is read without a legend, because the label is
the row.

### 3.5 Scale, scrolling and the overview

The ledger draws at most 500 columns at once, the newest by default,
and the axis scrolls by turn window with "earlier" and "later" controls
that also answer the left and right arrow keys when the ledger has focus.
Above the ledger, when the conversation has more turns than fit, a
one-pixel-per-turn overview strip of `ctxActual` shows the whole
conversation's silhouette with the visible window outlined, so a
thousand-turn session is still recognisable at a glance and the reader can
jump to its compactions. Column width is the available width divided by
the visible count with a floor of 3 px; under the floor the window shrinks
rather than the columns.

At 390 px the same ledger draws about 40 columns per window, the receipt
panels stack, and the shaping waterfall keeps its rows but drops the bar
width to the remaining space. Nothing is hidden at narrow width; it is
paged.

## 4. Telemetry and configuration as one surface

The old defect was a "Statistics" page that showed the number and a
"Settings" page that held the switch, with the reader carrying the
connection in their head. The mechanism here is that the control lives in
the row of the measure it governs, and nowhere else on these screens.

In the shaping panel of a turn receipt, every stage row is `.row` with the
grid `name | bar and number | control`. The control is the current setting
rendered as its own value, a `.segmented` on/off for a layer toggle, a
number with its unit for a target, disclosed by a native `<details>`
whose summary is the value itself ("target 95 %", "on, filtering 3 tools").
Opening it shows the field, a one-line statement of what the setting does
in the words of the stage's row ("headroom trims the oldest tool results
once the estimate crosses this share of the window"), and one button with
the verb.

Between the click and the new value.

1. The button opens the existing `Confirm` dialog with the same
   precondition, blast radius and reversibility copy the Shaping screen
   already uses ("New requests take the change. A request already in
   flight keeps the stack it started with."), with the verb on the button.
2. Confirm sends `PATCH /api/settings` through `call`, exactly as
   `src/app/dashboard/shaping/page.js` does. A refusal renders through
   `refusal(status, body)` inside the dialog as a sentence, never a toast.
3. On success the dialog closes, the row's value rolls to the new number
   (the number roll from DIRECTION-2), and a "changed here" `.mark.soft`
   appears at the now-line of the ledger with the setting's label. The
   settings poll refreshes so the value shown is the server's, not the
   draft's.
4. The next turn that arrives renders to the right of that mark. The
   operator can select the turn before and the turn after and read the two
   receipts, which is the whole point of putting the control here.

The measure never lies about which value produced it. A receipt row shows
the setting as it was WHEN THAT TURN RAN if `settingChanges` records a
later change, phrased "was 95 % then, 90 % now", and the control edits the
current value.

Controls that exist today on `/dashboard/shaping` stay there too; that
screen is the place to read a stage across all traffic. The session screen
is the place to read it against one turn. Both call the same route and
both refresh from the same poll, so there is one truth.

## 5. Project clustering as behaviour the operator sees

### 5.1 Signals, in order of trust

1. Working directory. Claude Code's system prompt carries a line
   `Working directory: /abs/path`; Codex carries `<cwd>/abs/path</cwd>`
   in its environment context (the pattern `devin-cli.js:211` already
   parses). The handler extracts it before the savers run, stores the last
   path segment as `cwdHint` and a hash prefix of the full path as
   `cwdHash`. The path itself is not stored. This is a certain signal when
   present.
2. Shared setup. `systemHash` is a hash of the system text with the
   working directory line removed. Two sessions with equal `systemHash`
   share a tool configuration and a harness version. It is a likely signal,
   not a certain one, because two projects run under the same Claude Code
   configuration share it.
3. Nothing. A client that sends no system prompt and no cwd lands in
   Unsorted.

Signals that are deliberately not used. Prompt text, embeddings, model
choice, timing adjacency. The first two would need bodies this plan refuses
to store; the last two are wrong often enough to erode trust in the certain
cases.

Both signals above are new recording, and neither is a config flip.
`SUBSTRATE.md` section 7 ranks the cwd fragment last among five candidates
precisely because every persistence path that touches raw body content
(`redactAndTruncate` in `requestDetailsRepo.js`, the `token-saver` events
allowlist at `events.js:19`) is built to strip exactly this. Storing
`cwdHint` and `systemHash` is therefore a deliberate, narrowly-scoped
exception to a standing redaction policy, and it ships only with the
operator's explicit agreement to that exception. The mitigation this plan
already carries is that the absolute path is never stored, only its last
segment and a hash prefix; that is what makes the exception narrow, and it
is stated to the operator rather than assumed.

### 5.2 The three states, as the operator meets them

- Certain. `projectSource = "rule"`. A `cwdHint` matched a project rule.
  The project row's `.sub` reads "certain, sorted by working directory
  name" and the project screen lists the names its rule accepts. No
  correction control is offered inline, because there is nothing to
  correct that the rule does not already say; the operator can still move
  a session from its own row.
- Probably. `projectSource = "similar"`. No cwd, but `systemHash` equals
  that of a project with at least three certain sessions. The row reads
  "probably, matched by shared setup" and carries the `✎ fix` control.
  The conversation's own row on the project screen carries the same.
- Unsorted. Neither. Its own bucket at the foot of the projects list,
  with the reason per session ("sent no working directory", "sent no
  system prompt") and a "sort" control per row.

A project's name is the `cwdHint` the first time it is seen, sentence-cased
never, printed as the directory was named, so `tokenproxy-rebuild` appears
as such until the operator renames it. Two directories that are the same
project, `tokenproxy` and `tokenproxy-rebuild`, are merged by the operator
once and stay merged.

### 5.3 Correction and its persistence

Moving a session opens the `Confirm` dialog with a `.select` of existing
projects plus "new project" with a name field. The dialog states what it
changes. "This conversation moves to OceanStack. Future conversations
started in a directory named `oceanstack-scripts` will also be sorted
there. Move it back from the project screen at any time." Confirm sends
`PATCH /api/context/sessions/[id] {projectId}`; the server sets
`projectSource = "operator"`, and, when the session has a `cwdHint` not yet
in the target's rule, appends it. Rules and project records live in `kv`
under scope `contextProjects`, so they survive restarts, sit inside the
database export, and never touch the request path.

Renaming, merging and dissolving are `PATCH` and `DELETE` on
`/api/context/projects/[id]` behind the same operator session as
`/api/settings`. Dissolving is reversible in the sense the dialog states,
the sessions fall back to Unsorted and the rule is removed, and the dialog
says so rather than calling it destructive.

## 6. Motion, each with what it explains

| Moment | What it explains | Duration | Under `prefers-reduced-motion` |
|---|---|---|---|
| A live turn's column settles from one hatched estimate into three solid segments when the provider's usage arrives | That the estimate was a guess and this is the measurement, and by how much they differed | 240 ms, height eases, hatch fades | Column appears in its final form; the receipt still prints both numbers |
| A compaction break draws in with the right-hand column falling from the previous height to its new one | That the drop is a single event between two turns, not a trend | 400 ms ease-out, once, only for a compaction that arrives while the screen is open | Static break and lower column |
| The number roll on a receipt value or an opening measure that changed | Which number moved when the settings change or the new turn landed | 200 ms | Value swaps |
| "Changed here" mark appears at the now-line after a confirmed setting change | Where on the axis the operator's own action sits | 120 ms fade, the dialog-in duration | Mark appears |

The freshness dot and the spark draw-once are inherited, not added.
Nothing moves on hover, nothing moves on scroll, columns do not animate
when paging the axis, and the overview strip never animates. The
`@layer states` rule already sets `animation: none; transition: none` on
everything under reduced motion, so the collapse column above is what the
existing rule produces, provided the final DOM state is the correct one
without the animation, which is a constraint on how the components are
written, not a new rule.

## 7. Stack and performance budget

What renders is decided by `docs/design/STACK.md`, not here. This section
previously ruled out `recharts` and `@xyflow/react` in favour of a
hand-written inline `<svg>`, and that ruling is withdrawn: the operator's
standing direction is that this surface is built on well-regarded installed
frameworks rather than on drawing code written from scratch, and both
libraries are already dependencies. The ledger is a `recharts` stacked bar
and the routing view is an `@xyflow/react` graph unless `STACK.md` says
otherwise, in which case `STACK.md` wins. Where a library's default chrome
fights the `.ruler` alignment, the fix is to configure the library, not to
replace it with hand-rolled geometry.

Everything else is the existing `.measures`, `.rows`, `.panel`, `.ruler`,
`Confirm`, `Measure`, `Freshness`, `Notice`, `usePoll`, `useEventStream`,
`call`, `refusal`, `fmt*`, with styling expressed through the stack's
utilities and `@theme` tokens rather than a new bespoke `styles.css` per
screen.

Workers. None. Five hundred columns is a few thousand nodes and a single
layout; measured against the existing `.spark` with 96 bars this is under
the frame budget by an order of magnitude on the laptop class this runs on,
and there is no computation worth moving off the main thread.

Query cost per screen.

| Screen | Query | Shape | Cost |
|---|---|---|---|
| Projects | `contextSessions` grouped by `projectId` over `lastSeenAt` in the horizon, plus fifteen-minute buckets of `contextTurns.ts` per project | one aggregate, one bucket scan on the `ts` index | under 5 ms at 45 days of a busy laptop; buckets are computed on the way in and kept in `kv` per project per day beyond the live day so the scan touches one day |
| Project | `contextSessions WHERE projectId = ?` newest first, page 25, plus a 64-point downsample of `ctxActual` per listed session | index on `(projectId, lastSeenAt)`; the downsample is a `GROUP BY (id * 64 / turnCount)` per session | under 10 ms per page |
| Conversation | `contextTurns WHERE sessionRef = ? AND id < ? ORDER BY id DESC LIMIT 500`, plus the overview `SELECT ctxActual` for all turns, plus `settingChanges` in the time span, plus `accountSwitches` joined on the stored `sidHash` server-side | covered by `(sessionRef, id)` | under 5 ms |
| Turn receipt | one row by id plus its `token-saver/events.jsonl` rows by `rid` from the existing reader, plus the switch receipt if any | point reads | under 5 ms; the jsonl read is the existing `getTokenSaverStats` path and is the one cost that grows with the file, bounded by its 5 MiB rotation |

Payloads. A turn row serialises to about 300 bytes of JSON, so a 500-turn
window is about 150 KB before compression and about 30 KB after, well
under the 1 MiB where a poll would start to matter. The overview is one
integer per turn, 6 bytes each, 30 KB for five thousand turns. The
projects screen is under 10 KB.

Live behaviour. The session screen polls its `turns?after=<lastId>` every
5 s only while the conversation is open (last turn under ten minutes old)
and only when the tab is visible, and it shows `Freshness` from the
existing usage stream so "live" means the gateway is live, not that this
poll succeeded. After ten minutes idle it stops polling and the freshness
state says "finished" with the last turn's time.

At ten times the load. Twenty thousand turns a day, sessions of several
thousand turns. The DOM never holds more than 500 columns because the
window is fixed, the overview stays one integer per turn and is capped at
ten thousand points by server-side downsampling with the cap stated in its
`why`, the per-project buckets are precomputed per day so the projects
screen does not rescan, and the table sweep is a range delete. The one
thing that would degrade is the jsonl read per receipt, and it is bounded
by the rotation size, not by load. Memory for the ledger data at 500 turns
is under 2 MB in the client.

Fonts, icons and every request stay on the loopback origin. The three new
rail and action icons (context, project, sort) are added to
`public/icons.svg`.

## 8. Provenance, denominators and empties

Every number on these screens is reachable to its source in one
interaction. The receipt's "where these come from" is a `<details
class="why">` listing, per number, the field and who reported it ("input,
cache read and cache write from the provider's usage block", "estimate
from body bytes divided by four times 1.07, this conversation's measured
ratio"). Every proportion prints its denominator beside it, "181 k of
200 k", "612 kB of 2.3 MB". An absent measurement prints its reason in
`--slate` with `.unreported`, "the provider returned no usage block", "the
window for this model is not in the catalogue", never a zero and never a
dash. A turn whose stage deltas were not recorded (a row written by an
older build) says "shaping was not recorded for this turn" in the panel
and hides the controls' history line, not the controls.

Boldness is spent once per screen, on the projects activity bands, on the
project's conversation silhouettes, and on the ledger. Measures are body
size except the one `.measure.big`. No eyebrows, no all-caps, no cards
with shadows, no numbered steps except the ordered list in section 4,
which is a real sequence.

## 9. What this does not do, and why

- It does not store prompt text, tool results or bodies of any kind. The
  linkage table holds counts, sizes, names of stages and models, and
  hashes. Reading what compaction removed would need bodies, and that is
  the opt-in `requestDetails` ring, which stays separate and off.
- It does not render or transmit `sid`, `sessionHash`, `requestId`,
  `clientId` or the client's cwd path. URLs use integer ids. A mockup in
  this plan does not show one either.
- It does not reconstruct history from before the tables exist. The empty
  state says recording started at the first turn after this build, and
  `token-saver/events.jsonl` rows without a session cannot be assigned to
  one retroactively.
- It does not cluster by content, embeddings or a model. Working directory
  and shared setup are the only signals, so the certain state is actually
  certain and the operator can see why the other two states are what they
  are.
- It does not show cost per turn. Cost is priced at query time from the
  pricing table and belongs on `/dashboard/usage`; putting a currency on
  the ledger would make the axis about money when the question is about
  context. A later pass can add it as a receipt line with its provenance.
- It does not claim provider cache truth beyond what the usage block
  reports. `ce` is the gateway's own prefix-survival estimate and is
  labelled as such wherever it appears.
- It does not recommend settings. It shows a turn before and after a
  change and lets the operator judge.
- It does not touch the existing `/dashboard/sessions` screen, which
  keeps pins and switch receipts; the ledger links into it.

## 10. Build order

0. **Gate, before anything on this list.** A session key column on
   `requestStats`, written at the call site in `chatCore.js` that already
   computes `sid`, plus a durable joinable home for the `token-saver`
   events now confined to `events.jsonl`. Until both exist, no query joins
   a token count to a conversation and no screen below can render a real
   number (`SUBSTRATE.md` sections 2 and 4, and section 0 above). Storing
   `cwdHint` and `systemHash` is a scoped exception to the standing
   redaction policy and needs the operator's explicit agreement first.
1. Server. `contextSessions` and `contextTurns` in `schema.js`, the write
   in `onReqSummary`, cwd and system hashing before the savers, the
   `settingChanges` append in the settings route, the `/api/context/*`
   routes, project rules in `kv`. Contract documents under
   `docs/contract/` for each route before any page reads it.
2. `/dashboard/context/session/[id]`, the ledger and the receipt, against
   a test instance above port 20160 with its own `DATA_DIR`, through the
   evidence loop at 390, 768 and 1440 in `en`, `de`, `vi`, `zh-CN`, `fa`.
3. `/dashboard/context` and `/dashboard/context/[projectId]`, with
   clustering states and correction.
4. Strings into `docs/design/strings.json` and the literal files, the rail
   entry and icons, the e2e specs for a confirmed setting change producing
   a "changed here" mark and for a compaction break rendering.
