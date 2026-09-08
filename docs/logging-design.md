---
title: Agent-efficient decision logging
status: implemented (steps 1-6, all fourteen classes, front proxy included); incident-replay validated 2026-09-04
owner: gabrielspadon
last_verified: 2026-09-04
scope: emitter, correlation, SEL/RANK/LEASE/LOCK/AUTHZ/ADM/CRED/UP/STREAM/ACCT/XFORM wiring, REQ summary, ledger join, boot snapshot, front ADM lines — shipped on feat/agent-logging (c80133c7, c3bad01e, db7aecca)
supersedes: none
---

# Agent-efficient decision logging

A design for what TokenProxy should write to its log so that an agent auditing
or repairing the system can answer "where did this go wrong" in the fewest
tokens. Nothing here is implemented. Every claim about current behaviour is
grounded in `file:line` or in a measurement taken from the live
`tokenproxy.service` journal on rtx at 2026-09-03T15:25 local, over the
preceding six hours. Lines marked **PROPOSAL** are design, not report.

The premise being tested is that logs for an agent are close to the inverse of
logs for a human. A human reads forward and wants narrative. An agent greps
backward from a symptom and wants the fork that produced it. The measurement
below supports the premise more strongly than expected, and in one specific way
that changes the design. The problem is not that TokenProxy fails to record its
failures. It records them and then buries them under three orders of magnitude
of successful-path chatter, so the recording has no diagnostic value.

---

## 1. What exists today

### 1.1 The machinery

There is no logging library. There are four independent emitters.

| Emitter | File | Shape | Sink |
|---|---|---|---|
| Level logger | `src/sse/utils/logger.js` | `[hh:mm:ss] <emoji> [TAG] msg <json?>` | `console.log` |
| Correlated line | `src/sse/utils/logger.js:36,42` | `[hh:mm:ss] <colour-dot> <symbol> msg` | `console.log` |
| Dev debug | `open-sse/utils/debugLog.js:9` | `[hh:mm:ss] 🐛 [DBG:tag] msg` | `console.log`, dev only |
| Raw `console.*` | 642 sites | anything | `console.log` / `console.error` |

Console methods write to the process output. Structured decision records
also persist to the configured NDJSON sink.

Levels exist (`logger.js:3-10`, `LOG_LEVELS` DEBUG/INFO/WARN/ERROR, selected by
`LOG_LEVEL`) but are not load-bearing. `error()` at `logger.js:90` writes to
`console.log`, not `console.error`, and `errorLine()` at `:42` bypasses the
level check entirely. `.env.example` does not mention `LOG_LEVEL`, so the
deployed default is INFO and DEBUG is dark.

Nothing is structured. 702 `JSON.stringify` calls exist in runtime code but
none produce a machine-readable log record. The closest thing to structure is
the `{"k":v}` tail that `logger.js:59-67` appends to `info`/`warn`/`error`,
which is a JSON fragment inside a human sentence, not a parseable line.

There is a second, disk-based logger, `open-sse/utils/requestLogger.js`. It is
off by default (`ENABLE_REQUEST_LOGS`, `.env.example:24`) and when on it writes
seven full request/response artefacts per request into a per-request directory.
It is a deep-dive capture tool, not a log. It is correct as designed and this
proposal does not touch it.

Emit-site counts in the request-serving path:

```
167  src/sse            (chat.js 30, fetch.js 21, search.js 20, auth.js 16)
 42  open-sse/services
 21  open-sse/handlers
 20  open-sse/executors
 11  custom-server.js
```

Tag vocabulary is 18 strings, unenforced, and dominated by three: `AUTH` (50
sites), `CHAT` (21), `COMBO` (15).

### 1.2 The honest bloat measurement

Six hours of `journalctl --user -u tokenproxy`, on a host serving one operator
and a handful of agent clients:

```
total lines                          21,119
total bytes                       1,261,085   (~315k tokens)
admitted requests                       853
requests rejected at the rate limiter 15,548
```

Composition, by normalized line (digits and UUIDs collapsed):

| Lines | Share | Line | Source |
|---:|---:|---|---|
| 15,470 | 73.2% | `⚠️ [CHAT] Rate limit exceeded` | `src/sse/handlers/chat.js:155` |
| 853 | 4.0% | `⚠️ [HEADROOM] skipped: disabled in settings` | `open-sse/handlers/chatCore.js:754` |
| 853 | 4.0% | `ℹ️ [AUTH] <provider> \| <id8> selected (<reason>)` | `src/sse/services/auth.js:510` |
| 853 | 4.0% | `<dot> ▶ POST <model> → <p>/<m> · FMT · STREAM · n MSG · ACC:<name>` | `open-sse/handlers/chatCore.js:629` |
| 820 | 3.9% | `<dot> 📊 DONE <t>ms · TTFT <t>ms · IN n · OUT n` | `open-sse/handlers/chatCore/streamingHandler.js:588` |
| ~800 | 3.8% | background OAuth refresh cycle, 11 lines every 5 min | `tokenRefresh.js`, `backgroundTokenRefresh.js` |

**Diagnostic yield.** Counting every line that names a fault, a fallback, a
retry, a lock or a refusal:

```
account cohort locked          23
OAuth refresh failed          303
failover to next account       25
retry same account              8
terminal error line            31
empty-stream lock               2
                            -----
                              392   = 1.86% of all lines
```

After collapsing repeats, those 392 lines carry **31 distinct facts**, which is
**0.147% of the log**. Two of the 31 account for 303 of the 392.

**One nominal admitted request costs 4 lines.** The counts confirm it exactly:
853 `HEADROOM skipped`, 853 `AUTH selected`, 853 `▶ POST`, 820 `📊 DONE`. Of
those 4, one (`HEADROOM skipped`) restates a static setting, one (`AUTH
selected`) is a decision line that omits everything needed to audit the
decision, and two (`▶`/`📊`) are a genuinely useful pair.

### 1.3 What is already good, and stays

Four things should survive unchanged.

- `formatDoneLine` (`open-sse/handlers/chatCore/requestDetail.js:93-107`). Dense,
  units attached, cache reads and writes already split out
  (`IN 0 (CACHE ↻87) · OUT 16`). This is the right instinct and the proposal
  folds it in rather than replacing it.
- The switch receipt (`src/shared/utils/switchReceipt.js`,
  `src/lib/db/repos/accountSwitchRepo.js`). Already a persisted, append-only,
  key-frozen, secret-free record of why a session left one account, with the
  quota evidence the decision rested on attached verbatim. It is better than
  anything a log line can be. The design must reference it by id, never
  duplicate it.
- The redaction chokepoint, `redactLogRecord` at `requestLogger.js:87-92`, with
  its comment explaining why headers keep a mask and everything else is
  deep-redacted. Any new emitter routes through this, not a second copy.
- `ENABLE_REQUEST_LOGS` being off by default. Correct failure direction for a
  full-body capture.

Also already right, and merely unprinted: `rankAccounts`
(`src/shared/utils/quotaRanking.js:197`) and `decideRepin`
(`src/shared/utils/repinPolicy.js:113`) both return structured verdicts with a
closed `reason` / `trigger` vocabulary. The decision vocabulary this design
needs already exists in the code. It is computed on every request and thrown
away.

### 1.4 The three structural defects

**(a) No correlation id.** `logger.js:17` defines eight emoji as the entire
correlation namespace. `tagForSession` hashes into 8 buckets. At any
concurrency above roughly four in-flight requests, tags collide and lines
interleave. Live evidence, one contiguous journal window:

```
[14:12:27] ⚠️  [HEADROOM] skipped: disabled in settings
[14:12:28] 🟢 📊 DONE 1503ms · TTFT 1501ms · IN 19 · OUT 16
[14:12:29] ℹ️  [AUTH] kimi | 333da040 selected (pinned)
[14:12:29] 🟡 ▶ POST kimi/k3 → kimi/k3 · ...
[14:12:29] ⚠️  [HEADROOM] skipped: disabled in settings
[14:12:33] 🟡 📊 DONE 3678ms · TTFT 2315ms · IN 94 · OUT 49
[14:12:33] ℹ️  [AUTH] openai-compatible-chat-7915e96f-... | c98037d0 selected (pinned)
```

The `AUTH selected` lines carry no tag at all, so binding a selection to the
request it served is guesswork. `🟢`'s DONE arrives before `🟡`'s start. There
is no request id anywhere in the tree (`rg requestId` finds only
`videoCore.js`, an unrelated provider-side poll token).

**(b) The decision modules are entirely silent.** These files contain zero
emit sites between them:

```
src/sse/services/accountScheduler.js       175 lines, 0 log calls
src/shared/utils/quotaRanking.js           345 lines, 0 log calls
src/shared/utils/repinPolicy.js            178 lines, 0 log calls
src/shared/utils/accountLease.js           115 lines, 0 log calls
src/sse/services/accountLeaseRegistry.js   120 lines, 0 log calls
src/lib/admin/policy.js                    154 lines, 0 log calls
~/.local/lib/tokenproxy-front/front-proxy.mjs  594 lines, 1 console.error (startup only)
```

That is the entire account-scheduling contract, the entire admin authorization
verdict, and the entire admission front. They are pure by design and the purity
is worth keeping, which is why the proposal returns decision records rather
than having these modules print.

**(c) The highest-volume line is the least actionable.**
`src/sse/handlers/chat.js:155` is `log.warn("CHAT", "Rate limit exceeded")`. It
is 73.2% of the log. It carries no client key, no limit, no window, and no
reset time, even though `rateLimitResetAtMs(rateLimitKey)` is called three
lines below at `:158` to build the response. Every fact needed is in scope and
none is logged.

### 1.5 The OAuth incident, checked against the log

The failure the operator describes (a predecessor rotating a shared refresh
chain and silently revoking TokenProxy's copy, 401ing all three Claude
accounts) **is in the log, 169 times, and was undiscoverable.**

```
154 × ❌ [TOKEN_REFRESH] Failed to refresh token for claude
        {"status":400,"error":"{\"error\": \"invalid_grant\",
         \"error_description\": \"Refresh token not found or invalid\"}"}
 15 × ⚠️  [AUTH] claude | all 3 accounts locked for claude-fable-5
        (reset after 1m 53s) | lastError=[401]: OAuth access token has been revoked.
```

Three things are wrong with this, and all three are design failures rather than
missing instrumentation.

1. `open-sse/services/tokenRefresh/providers.js:156` names the **provider**,
   not the connection. With three Claude accounts, the line cannot say which
   one, or whether all three. An agent reading it learns that Claude refresh is
   broken, which it already knew from the 401s.
2. The lock line says `reset after 1m 53s`. That is a **coercion**, and a wrong
   one. `markAccountUnavailable` (`src/sse/services/auth.js:680-733`) routes a
   revoked-credential 401 through the same backoff schedule as a rate limit, so
   a permanent credential failure is presented as a transient window. The
   Codex-specific escape hatch at `auth.js:645-654` exists precisely because
   this is wrong, and it covers only Codex. This is a decision boundary that
   the log actively misreports.
3. `providers.js:174` is `refreshToken: tokens.refresh_token || refreshToken`.
   When the provider omits a rotated token, the old one is silently retained.
   The success line at `:165` logs `hasNewRefreshToken: true/false` but never a
   fingerprint, so a chain that rotated underneath TokenProxy is invisible. The
   one fact that would have identified the incident in one grep, "the refresh
   token I hold is not the one I was issued", is never written.

The design in section 3 emits, for exactly this event, one line per connection
per failure class carrying the connection id, the chain fingerprint before and
after, and the `invalid_grant` discriminator, and suppresses the 154 repeats
into a counted roll-up.

---

## 2. Decision-point inventory

54 forks, verified in code, in 13 classes. Each row states what forks, what an
agent must know to audit it, and the emit cost. "Cost" is bytes per emission on
the proposed schema, and whether the fork is nominal (silent) or non-nominal
(speaks).

### ADM — admission

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 1 | dispatch vs queue (backend unready, activation paused, draining) | `front-proxy.mjs:316-336` | which of the three conditions, queue depth, active count | 110 B, non-nominal |
| 2 | queue eviction to 503 at `queueTimeoutMs` | `front-proxy.mjs:234-245` | wait duration, the condition that never cleared, `queueTimeoutMs` | 120 B, always |
| 3 | client disconnect while queued | `front-proxy.mjs:243-256` | queued duration | 90 B, always |
| 4 | client rate limit refuse | `chat.js:154-160` | key class, limit, window, `resetAt` | 100 B, folded/counted |
| 5 | API key required and absent or invalid | `chat.js:203-211` | which (`requireApiKey` source: setting or env), presented or not | 95 B, always |

### AUTHZ — admin authorization class

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 6 | inference-class admit on `operator \|\| inference \|\| loopback` | `src/lib/admin/policy.js:66` | **which of the three satisfied it** | 105 B, always |
| 7 | operator-class refuse, 401 vs 403 by credential class | `policy.js:77-90` | presented class, required class | 100 B, always |
| 8 | mutation refused for non-loopback | `policy.js:92-99` | peer classification | 100 B, always |
| 9 | inference-path exact-match set vs prefix | `policy.js:28,42` | resolved class for the path | folded |

Row 6 is the one the operator names. `adminDecision` returns `null` (allow)
when any of three booleans is true, and never records which. That is exactly
how a gate check passed with no key at all: `loopback` was true, the caller
believed `inference` had been checked, and nothing in the log distinguished the
two.

### MODEL — model resolution

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 10 | context-suffix strip | `chat.js:234` | before, after | folded |
| 11 | Claude-compat normalization | `chat.js:247` | before, after | folded |
| 12 | disabled model refused | `chat.js:267` | requested id | 85 B, always |
| 13 | auto-router task-class pick | `chat.js:284-287` | class, source, chosen model, and that nothing was routable | 110 B, always |
| 14 | combo expansion, agent-role narrowing | `chat.js:307-339` | narrowed count over raw count, strategy, sticky limit | folded |
| 15 | combo cycle refused | `chat.js:438` | the cycle | 95 B, always |
| 16 | capability adapter substitution | `chat.js:363` | required capabilities, substitutes tried | 110 B, always |
| 17 | context-window overflow | `chat.js:506` | tokens over, ceiling | 95 B, always |

### RANK — cohort ranking

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 18 | solo-cohort invalid record degrade | `quotaRanking.js:232-243` | the id and the normalize failure reason | 120 B, always |
| 19 | cohort gate: invalid record | `quotaRanking.js:266-276` | offending id, reason | 120 B, always |
| 20 | cohort gate: shape mismatch | `quotaRanking.js:277-287` | the two differing shape keys | 130 B, always |
| 21 | cohort gate: all depleted | `quotaRanking.js:288-297` | soonest `resetAt` across the cohort | 125 B, always |
| 22 | five-key ordering outcome | `quotaRanking.js:308-325` | **which key decided, winner, runner-up, headroom, resetAt** | 165 B, folded unless winner changed |
| 23 | confidence band demotion (fresh/stale/unknown) | `quotaRanking.js:166-169` | per-account band | folded into 22 |
| 24 | usability predicate `resetAt <= now \|\| remaining > 0` | `quotaRanking.js:159-161` | which clause admitted it | folded into 22 |

Row 22 is the operator's first named target. Everything it needs is already
returned by `rankAccounts` and discarded at `accountScheduler.js:103`.

### SEL — selection, pin, repin

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 25 | pin read inside transaction, hit or miss | `accountScheduler.js:100-101` | pinned id, or that no pin existed | folded |
| 26 | repin verdict, 7 outcomes | `repinPolicy.js:113-177` | `trigger` and `reason`, from, to | 150 B, non-nominal |
| 27 | degraded cohort uses `ranked` not `eligible` | `accountScheduler.js:113` | that ranking was refused | folded into 19-21 |
| 28 | first free slot walk over ranked order | `accountScheduler.js:127-129` | **who was skipped and why** | 140 B, non-nominal |
| 29 | operator pin overrides ranking | `auth.js:438-443` | that ranking did not run, and why the operator pinned | 105 B, always |
| 30 | no accounts / no eligible / at capacity refusal | `accountScheduler.js:94,121,173` | reason enum, retry-after | 110 B, always |
| 31 | pin TTL expiry treats session as new | `sessionAffinityRepo.js:26-44` | expired at, age | 100 B, always |
| 32 | drain exclusion | `auth.js:331-341` | excluded ids | folded |
| 33 | model-lock exclusion | `auth.js:339` | id, lock key, `until` | 115 B, always |
| 34 | quota-pause skip | `auth.js:367` | id, the window below threshold | 120 B, always |
| 35 | quota read threw, fail open with empty windows | `auth.js:358-365` | id, that evidence is absent not empty | 110 B, always |
| 36 | proxy unusable after lease taken, release and return null | `auth.js:524-529` | pool id, resolution kind | 115 B, always |

### LEASE — capacity

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 37 | reserve refused, at limit | `accountLease.js:63-65` | held, limit | 95 B, always |
| 38 | ungated because capacity unknown or malformed | `accountLease.js:63-64`, `accountLeaseRegistry.js:35-41` | **that the ceiling failed open** | 100 B, always |
| 39 | release idempotent no-op (double release) | `accountLease.js:87-94` | lease seq | 85 B, always |
| 40 | lease handed to the response body | `accountLeaseRegistry.js:82-119` | that the slot outlives the handler | folded |

Row 38 is a silent fail-open on a capacity ceiling. It is invisible today and
there is no way to tell an ungated account from an unlimited one.

### CRED — OAuth refresh and rotation

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 41 | proactive refresh triggered | `tokenRefresh.js:228-238` | conn, seconds remaining, lead | folded |
| 42 | refresh HTTP failure | `providers.js:153-160` | **conn id**, status, `error` discriminator | 165 B, always |
| 43 | rotation vs retention `tokens.refresh_token \|\| refreshToken` | `providers.js:174` | **fp before, fp after, rotated yes/no** | 130 B, always |
| 44 | dedup reuse of an in-flight or recent refresh | `dedup.js:9-17` | chain key, which connections share it | 110 B, always |
| 45 | persist merge, field-present gating | `tokenRefresh.js:158-193` | which fields were written | folded |
| 46 | no refresh URL / no refresh token | `providers.js:132-140` | conn, which | 95 B, always |

Rows 42-44 together are the OAuth incident. Row 43 does not exist in any form
today.

### LOCK — account lock and deactivation

| # | Fork | `file:line` | Agent needs | Cost |
|---|---|---|---|---|
| 47 | Codex permanent-OAuth deactivation | `auth.js:645-654` | conn, that it is permanent | 110 B, always |
| 48 | Qoder quota deactivation | `auth.js:662-673` | conn | 105 B, always |
| 49 | GitHub monthly reset, uncapped | `auth.js:678,690-693` | reset instant | 105 B, always |
| 50 | cooldown clamped to `retryDelayCapMs` | `auth.js:693,700` | requested, cap, applied | 125 B, always |
| 51 | 401/403/404 routed through the backoff schedule | `auth.js:680,697-700` | **status class and that a credential fault got a timed lock** | 130 B, always |

Row 51 is the misreport in section 1.5.

### XFORM / UP / STREAM / ACCT / DRAIN

| # | Fork | `file:line` | Cost |
|---|---|---|---|
| 52 | headroom skip (disabled vs unavailable vs reason) | `chatCore.js:1020` | folded |
| 53 | headroom phantom savings (delta reported, JSON shrank <5%) | `chatCore.js:1007` | 130 B, always |
| 54 | tool-disclosure bm25 strip | `chatCore.js:605-673` | folded |
| 55 | retry same account | `chat.js:860` | 110 B, always |
| 56 | failover to next account | `chat.js:788,864,868` | 125 B, always |
| 57 | attempt ceiling reached | `chat.js:840` | 100 B, always |
| 58 | request-buffer overflow replay | `chat.js:811` | 105 B, always |
| 59 | non-SSE / blocked pipe classification | `streamingHandler.js:135-324` | 140 B, always |
| 60 | HTTP 200 with empty content, treated as failure, locked | `nonStreamingHandler.js:932` | 135 B, always |
| 61 | stream stall at `stallTimeoutMs` | `streamingHandler.js:430` | 120 B, always |
| 62 | terminal-frame synthesis on abort | `streamingHandler.js:427-440` | 110 B, always |
| 63 | usage estimated because provider omitted it | `streamingHandler.js:566` | 115 B, always |
| 64 | empty stream, lock for next request | `streamingHandler.js:536` | 110 B, always |
| 65 | requestDetail left `pending` (second write never landed) | `streamingHandler.js:444-470` | 100 B, always |
| 66 | cache alias normalization dropped a spelling | `usageTracking.js:207` | 115 B, always |
| 67 | drain begin / end transition | `admin/drain/[connectionId]/route.js:56-92` | 105 B, always |
| 68 | schema distillation stripped validation-noise keywords | `chatCore.js:773-782` | folded |
| 69 | thinking strip removed historical reasoning blocks | `chatCore.js:823` | folded |
| 70 | query-aware compression collapsed low-relevance turns (pressure rung after the mem and headroom stages; fresh decisions only over budget, memoised per session and replayed on later turns) | `chatCore.js` `qacWillRun` | folded |
| 71 | pair dropping removed oldest text-only turn pairs under deficit (after the qac rung) | `chatCore.js` `pairsWillRun` | folded |
| 72 | embedding reorder moved relevant user/assistant pairs next to the tail (fresh pass only on a request whose prefix a rung already rewrote; otherwise the session's memoised order is replayed) | `chatCore.js` `reorderWillRun` | folded |
| 73 | boundary note summarizing the prefix optimizations, appended to the live user turn | `chatCore.js` `midinjectWillRun` | folded |
| 74 | tools normalization (dedupe + static filter + BM25 disclosure) stripped tools: tools bytes measured before dedupeTools, stage closed after disclosureTools, folded into `save=` as a `tools` stage entry | `chatCore.js:605-673` | folded |
| 75 | rtk applied | `chatCore.js:926` | folded |
| 76 | headroom applied (after the mem stage; a Claude body over the size cap sends its oldest message slice) | `chatCore.js` `compressWithHeadroom` | folded |
| 77 | memory tool pruning reclaimed history | `chatCore.js:1111` | folded |
| 78 | context compaction replaced older turns | `chatCore.js:1118` | folded |
| 79 | style prompt injected (caveman/ponytail) | `chatCore.js:1040-1048` | folded |
| 80 | privacy filter pseudonymised outbound values | `chatCore.js:959` | folded |
| 81 | pxpipe compressed bulky images | `chatCore.js:1072` | folded |
| 82 | pending session handoff injected | `chatCore.js:1121` | folded |
| 83 | claude cache anchors kept vs re-anchored | `chatCore.js:1222` | folded |
| 84 | saver grew the body >5% of entry bytes | `chatCore.js:1304` | 115 B, on anomaly |
| 85 | embedding reorder degraded (embed endpoint failed, prefix left in order) | `chatCore.js:884` | 120 B, on embed failure |

Rows 1-85 with the folded sub-forks collapsed give **62 distinct emitting
decision points**, of which 10 are nominal-path and fold into the summary line,
and 52 speak only when they fire.

---

## 3. The schema (PROPOSAL)

### 3.1 Line shape

One line, one decision. Plain text, no JSON envelope, because the primary
consumer is `rg` and a JSON envelope costs about 40% more bytes for structure a
regex does not need.

```
<iso8601> <CLASS>.<verdict> rid=<8hex> <k=v>...
```

Rules:

- `CLASS` is one of 13 uppercase tokens, and is the grep unit. `rg ' CRED\.'`
  returns every credential decision in the process history.
- `verdict` is a lowercase kebab token from a closed per-class enum. The enum
  lives in one frozen object so an unknown verdict is a test failure, not a new
  string in production.
- `rid` is mandatory on every line that belongs to a request. 8 hex characters,
  process-unique. This replaces the 8-emoji namespace.
- Values are ids (8-char prefixes), enums, integers with a unit suffix, or ISO
  durations. **Never** a payload, a header value, a model prompt, a URL with a
  query string, a token, or a free-form provider message longer than 60
  characters.
- Every line is independently actionable. It names the class, the branch, the
  rejected alternative, the constraint that decided, and enough identity to
  find the code and the row.

### 3.2 Field vocabulary

Fixed, small, and reused across classes so a grep for `conn=7a1acb09` crosses
every class.

| Key | Meaning | Cardinality |
|---|---|---|
| `rid` | request id | unbounded, but 8 hex |
| `sid` | session hash prefix, 8 chars | bounded by client count |
| `conn` | connection id prefix, 8 chars | bounded by account count |
| `prov` | provider id | ~30 |
| `model` | model id | bounded by catalog |
| `why` | closed reason enum | bounded per class |
| `alt` | rejected alternative(s), `id:reason`, max 3, then `+N` | bounded |
| `win` | constraining window horizon (`5h`, `7d`, `30d`) | 3-5 |
| `rem` | remaining over limit, absolute units | integer |
| `reset` | relative reset (`+4h12m`) | duration |
| `held` / `cap` | leases held, ceiling | integer |
| `fp` / `fp0` | credential chain fingerprint, first 8 of SHA-256 | 8 hex |
| `rep` | repeat count folded into this line | integer |
| `t` / `ttft` | milliseconds | integer |
| `rcpt` | switch-receipt id, when one was written | uuid |

### 3.3 The one nominal line

A successful request emits exactly one line, at completion. It replaces today's
four.

```
REQ.ok rid=<8hex> sid=<8> route=<client-model>><prov>/<model> fmt=<s>><t>
       conn=<8> sel=<verdict> t=<ms> ttft=<ms> in=<n> out=<n> cr=<n> cw=<n>
       path=<code,code,...>
```

`path=` is the mechanism that lets the nominal path stay silent without losing
auditability. Every fold-eligible fork appends its `CLASS.verdict` code to a
per-request list. The forks are recorded, at roughly 12 bytes each, without a
line each. A request whose `path=` is empty took every default.

### 3.4 Worked example lines

Written as they would actually appear. Every one corresponds to a real event in
the measured journal or to a fork verified in code.

**Account selection and quota-window ranking** (`quotaRanking.js:308`,
`accountScheduler.js:103-129`; today: silent, or the reasonless
`[AUTH] claude | 7a1acb09 selected (pinned)`)

```
2026-09-03T18:09:07Z SEL.win rid=7f3a1c02 sid=b41e9c30 model=claude-opus-5
  conn=7a1acb09 key=resetAt win=7d rem=418/2500 reset=+4h12m
  alt=9c291b5a:resetAt+9h04m,c98037d0:band-stale why=expiring-entitlement-first
```

An agent reads: account `7a1acb09` won on ordering key 2 because its seven-day
window resets soonest with 418 units left, `9c291b5a` lost on the same key by
nearly five hours, and `c98037d0` was demoted a whole band because its evidence
was stale. That is the entire ranking decision in 168 bytes.

**Cohort refused to rank** (`quotaRanking.js:277-287`; today: silent, and the
caller silently falls back to previous-pin order)

```
2026-09-03T18:09:07Z RANK.degraded rid=7f3a1c02 model=claude-opus-5
  why=cohort-shape-mismatch shapes=2 a=7a1acb09:5h,7d b=c98037d0:5h,7d,30d
  fallback=previous-pin-first pin=7a1acb09
```

**Lease refused** (`accountLease.js:63-65`; today: silent, surfaces only as
`[AUTH] ... at capacity, caller should retry`)

```
2026-09-03T18:09:07Z LEASE.refused rid=7f3a1c02 conn=7a1acb09 held=4 cap=4
  next=9c291b5a retry_after=1s
```

**Capacity ceiling failed open** (`accountLeaseRegistry.js:35-41`; today:
invisible, and indistinguishable from a configured unlimited account)

```
2026-09-03T18:09:07Z LEASE.ungated rid=7f3a1c02 conn=333da040
  why=capacity-unregistered held=11 action=admit
```

**OAuth refresh failure with chain identity** (`providers.js:153-160`,
`:174`; today: 154 identical provider-scoped lines in six hours)

```
2026-09-03T18:22:46Z CRED.refresh-failed conn=7a1acb09 prov=claude status=400
  why=invalid_grant fp0=3ac91e77 age=41m rep=12 first=17:41:12
2026-09-03T18:22:46Z CRED.chain-diverged conn=7a1acb09 prov=claude
  fp0=3ac91e77 fp=unknown why=issuer-rejected-held-token
  peers=9c291b5a,c98037d0 action=none
```

`CRED.chain-diverged` is the line that would have named this incident on sight.
It fires when a refresh is rejected with `invalid_grant` while the held token's
fingerprint is unchanged since issue, which is exactly "someone else rotated
this chain". `peers=` lists the other connections sharing the dedup key
(`dedup.js:6`), which is the blast radius. One grep, `rg ' CRED\.chain-diverged'`,
answers the whole question.

**Rotation, on the nominal path, folded** (`providers.js:174`)

```
2026-09-03T18:22:46Z CRED.rotated conn=333da040 prov=kimi fp0=8b12aa04 fp=e7d3910c
```

Emitted only when the fingerprint actually changes, which is the fact worth
having. A refresh that returns the same token emits nothing and appends
`CRED.same` to `path=`.

**Credential fault given a timed lock** (`auth.js:703-733`; today:
`locked modelLock_claude-fable-5 for 113s [401]`, which asserts a reset that
will never happen)

```
2026-09-03T18:09:09Z LOCK.applied conn=7a1acb09 prov=claude model=claude-fable-5
  status=401 class=credential sched=backoff level=2 cooldown=113s cap=300s
  why=no-permanent-path-for-provider expect_reset=false
```

`class=credential` beside `sched=backoff` and `expect_reset=false` is the
contradiction, stated on one line. `rg ' LOCK\.applied .*class=credential'` finds
every instance of the misclassification across the whole history.

**Admin authorization admit** (`policy.js:66`; today: silent, returns `null`)

```
2026-09-03T18:09:07Z AUTHZ.admit rid=a41f0c93 path=/api/admin/health class=inference
  by=loopback operator=false inference=false loopback=true peer=127.0.0.1
```

`by=loopback` with `inference=false` is the line that makes "a gate check passed
with no key at all" visible in one read.

**Front admission eviction** (`front-proxy.mjs:234-245`; today: nothing)

```
2026-09-03T18:09:12Z ADM.evicted rid=c0912ab4 waited=5000ms limit=5000ms
  why=backend-unready queued=7 active=0 status=503
```

**Client rate limit, counted rather than repeated** (`chat.js:154-160`; today:
15,470 lines in six hours)

```
2026-09-03T18:09:07Z ADM.ratelimited key=api:9f21c8de limit=60/60s reset=+38s
  rep=1841 first=18:08:12 model=claude-fable-5
```

**Repin** (`repinPolicy.js:113-177`, `accountScheduler.js:150-159`)

```
2026-09-03T18:09:07Z SEL.repin rid=7f3a1c02 sid=b41e9c30 model=claude-opus-5
  from=9c291b5a to=7a1acb09 trigger=reset why=earlier-account-restored
  rcpt=0f2e...b91 alt=c98037d0:available-all-along
```

`alt=c98037d0:available-all-along` is the rule-5 discrimination made visible: an
account that was never gone does not pull a pin.

**Stream stall** (`streamingHandler.js:430`)

```
2026-09-03T18:09:41Z STREAM.stalled rid=7f3a1c02 conn=7a1acb09 prov=claude
  idle=120000ms limit=120000ms bytes=41822 frames=311 terminal=none
  action=synthesize-failed lock=true
```

**Nominal completion, the only line a good request writes**

```
2026-09-03T18:09:12Z REQ.ok rid=7f3a1c02 sid=b41e9c30
  route=cc/claude-fable-5>claude/claude-fable-5 fmt=claude>claude conn=7a1acb09
  sel=pinned t=3543ms ttft=1311ms in=11 out=284 cr=87 cw=0
  path=XFORM.headroom-skip,SEL.pin-hit
```

### 3.5 Class list

`ADM`, `AUTHZ`, `MODEL`, `RANK`, `SEL`, `LEASE`, `CRED`, `LOCK`, `XFORM`, `UP`,
`STREAM`, `ACCT`, `DRAIN`, plus `REQ` for the summary. Fourteen tokens. No
severity level. The existence of a non-`REQ` line means something forked away
from nominal, which is the only severity an agent needs; anything finer is a
knob that gets turned down and then loses the signal, which is what happened to
`LOG_LEVEL` here already.

### 3.6 Repeat folding

The mechanism that makes 154 refresh failures into 12 lines without losing one.

- Key is `(CLASS, verdict, conn, model, why)`.
- Emit on occurrences 1, 2, 4, 8, 16, 32, 64, and every 128 thereafter.
- Force one roll-up per hour per live key, so a slow-burning fault cannot go
  more than an hour unmentioned.
- Every folded line carries `rep=<count since last emit>` and `first=<hh:mm:ss>`.
- **Never fold across a change in `why`.** A different reason is a different
  fact and always emits.
- Folding state is a bounded `Map` capped at 512 keys with LRU eviction, so it
  cannot itself become a leak.

Applied to the measured data, the 154 `CRED.refresh-failed` occurrences become
8 exponential emissions plus 6 hourly roll-ups, 14 lines, each naming the
connection that today's line omits.

---

## 4. Silence policy

**What is never logged, at all.**

Prompt bodies, message content, tool definitions, tool results, system prompts,
response text, thinking blocks. Access tokens, refresh tokens, API keys, client
secrets, cookies, authorization headers. Raw session identities (only the hash
prefix). Full URLs with query strings. Any provider error message beyond 60
characters (truncated with an ellipsis, and the full text goes to the
requestDetail row, which already exists and already has a UI). Any object
spread, ever, which is the structural rule `switchReceipt.js` already enforces
and the reason it has never leaked.

**What is silent on the nominal path.**

- Request start. The `▶` line at `chatCore.js:629` is deleted; its content is
  in `REQ.ok`.
- Successful account selection. `auth.js:510` is deleted; `sel=` on `REQ.ok`
  carries it.
- Successful token refresh with no rotation. `providers.js:165` becomes silent;
  only `CRED.rotated` speaks, and only on a fingerprint change.
- The background refresh scheduler's per-tick narration.
  `backgroundTokenRefresh.js:103,109,118` all go silent. A tick that refreshed
  everything it meant to refresh is nominal. Only failures speak.
- `HEADROOM skipped: disabled in settings`. A static setting restated 853 times
  in six hours is a config read, not an event. It becomes
  `XFORM.headroom-skip` in `path=`. The *other* branch of that same call site,
  `compression unavailable`, is a genuine fault and keeps a line.
- Pin hit on a healthy pin. Folded into `sel=pinned`.
- Lease acquire and release on the happy path.
- Every `console.error("[RequestDetail] Failed to save…")` variant. These are
  five near-identical sites (`streamingHandler.js:469,583,632`,
  `nonStreamingHandler.js:976`) that report the same class of fault; they
  collapse to one `ACCT.detail-write-failed` with a `phase=` field.

**What always speaks, even once, even if it looks minor.** Anything that hit a
fallback, a retry, a clamp, a default, a coercion, a timeout, a refusal, or a
fail-open. Specifically: every fail-open (`auth.js:358-365` quota read threw,
`accountLease.js:63` capacity unknown, `quotaRanking.js` cohort degrade), every
clamp (`auth.js:693,700` cooldown cap), every coercion
(`providers.js:174` token retention, `auth.js:697-700` credential-fault-as-backoff),
and every silent default. These are the product. They are also, today, almost
entirely unlogged.

**The rule that decides the boundary.** A line is written when the code took a
branch that a reader of the source would not predict from the inputs alone.
Everything else appends a code to `path=` and stays quiet.

---

## 5. Volume estimate

Measured baseline, six hours, 853 admitted requests, 15,548 rejections:

| | Today | Proposed | Change |
|---|---:|---:|---:|
| Lines | 21,119 | ~920 | **23× fewer** |
| Bytes | 1,261,085 | ~172,000 | **7.3× fewer** |
| Tokens (approx) | 315,000 | 43,000 | 7.3× fewer |
| Lines per nominal request | 4 | 1 | 4× fewer |
| Distinct diagnostic facts | 31 | ~65 | 2.1× more |
| Diagnostic density | 0.147% | ~7% | **48× denser** |

Proposed composition of the ~920:

```
853  REQ.<outcome>, one per admitted request, ~190 B
 30  non-nominal decision lines (the 31 measured facts, folded)
 14  CRED repeat roll-ups
 128 ADM.ratelimited roll-ups (15,548 rejections, one client) -- MEASURED, see note
 ~15 startup, config, drain and lifecycle
```

The proposal beats today on volume *and* carries strictly more diagnostic
value. It is worth being precise about why, because the result is not obvious:
73% of today's bytes are one line that says nothing, and a further 12% are
three lines per request that fold into one. The new decision lines are more
numerous in *kind* (45 classes that speak versus roughly 12 today) but they
fire only on non-nominal paths, which on this workload is under 2% of events.

> **Correction, measured 2026-09-03 against the shipped `fold()`.** The `~8`
> above contradicted section 3.6 own schedule and is wrong. Replaying the real
> 15,548 refusals (a 25-minute burst, not a six-hour drizzle) through the
> implemented folder emits **128** lines for one caller and 148 for four,
> because the every-128-thereafter clause yields 121 emissions past the
> exponential head. That line still falls from 718,484 bytes to 17,664, a
> 40.7x reduction on the call site and 2.28x on the whole journal from that one
> edit. The rest of the table is unretested: steps 3.1-3.5 and 5 have not
> shipped.

**Per-request bounds.**

- Nominal: exactly 1 line, ~190 bytes.
- Typically degraded (one failover, one lock, one retry): 4 lines, ~700 bytes.
- Worst realistic case (cohort degrade, repin, lease refusal, credential
  failure, stall, failover across three accounts): 11 lines, ~1.6 KB.
- Hard ceiling: 1 `REQ` + at most 1 line per class that forked = **15 lines**.
  Reaching it requires every class to fork on one request, which is a request
  that failed in thirteen distinct ways.

**Ceiling under load.** At 100 requests per minute sustained and fully nominal,
19 KB/min, 27 MB/day. At 100/min with 10% degraded, 25 KB/min. Because the
worst case is bounded per request rather than per event, load cannot produce
super-linear growth from any single fault; a provider outage that fails every
request produces at most 15 lines per request, and repeat folding collapses the
identical ones within seconds.

**The backstop.** A process-wide cap: if non-`REQ` lines exceed 200 per minute,
switch to counters-only and emit one line per minute naming the classes being
folded and their counts. That converts an unbounded log storm into a bounded 13
lines per minute, and the counters are still an answer.

---

## 6. Migration path

Six steps. Each is independently shippable, none requires the next, and the
volume win lands at step 4 while the diagnostic win lands at step 3.

**Step 1. Add the emitter. No call-site changes.**
New file `src/shared/observability/decide.js`, roughly 120 lines, exporting
`decide(cls, verdict, fields)`, `req(fields)`, `fold(key)` and a frozen
`VERDICTS` object holding the closed enum per class. It writes through
`redactLogRecord` (`requestLogger.js:87`) rather than duplicating redaction. A
unit test asserts that every verdict used anywhere in the tree is present in
`VERDICTS`, so a typo is a red test. Nothing calls it yet. Zero behaviour
change.

**Step 2. Give the request an id.**
One file. `src/sse/utils/logger.js` gains `nextRid()`; `chatCore.js:259` sets
`reqTag` from it. Keep the emoji as a second field for the operator's own
reading if wanted, but the `rid` is what correlates. Existing `▶` and `📊` lines
immediately become correlatable, which is a real improvement on its own and
worth shipping alone. This is the prerequisite for everything after it.

**Step 3. Convert the six highest-value silent forks. Additive only.**
In this order, chosen by diagnostic value per line of change:

1. `CRED` — `providers.js:153-176`, `tokenRefresh.js:186-204`, `dedup.js:9`.
   Adds `refresh-failed` with `conn`, `rotated`, `chain-diverged`. This alone
   would have caught the incident.
2. `RANK` + `SEL` — plumb the already-returned `rankAccounts` reason and
   `decideRepin` trigger out of `accountScheduler.js:103-173`. The scheduler
   stays pure: it returns a `decision.trace` array and `auth.js` prints it.
   No new imports in `quotaRanking.js` or `repinPolicy.js`.
3. `LEASE` — `accountLease.js` returns a refusal reason instead of bare `null`;
   `accountLeaseRegistry.js` reports the ungated fail-open. Same purity
   discipline.
4. `AUTHZ` — `policy.js:64-102` `adminDecision` returns
   `{allow: true, by: 'loopback'}` instead of `null`. The two collectors
   (`dashboardGuard.js`, `admin/guard.js`) print it. The frozen admin ABI is
   untouched because the wire response does not change.
5. `LOCK` — `auth.js:645-733`, adding `class=` and `expect_reset=`.
6. `ADM` — `chat.js:154-160` gains the fields already in scope at `:158`.

**Step 4. Delete the four measured noise sources. This is the volume win.**
`chat.js:155` (fold into `ADM.ratelimited` with `rep`), `chatCore.js:754`
disabled-branch only (into `path=`), `auth.js:510` (into `REQ.sel=`), the
`backgroundTokenRefresh.js` nominal trio at `:103,109,118`. Four edits, 85% of
the bytes.

**Step 5. Collapse `▶` and `📊 DONE` into `REQ`.**
`chatCore.js:629` and the three `formatDoneLine` sites
(`streamingHandler.js:588`, `sseToJsonHandler.js:537,719`,
`nonStreamingHandler.js:816`). Keep `formatDoneLine`'s field selection verbatim;
it is already right. Do this last because it is the most visible change to the
operator's own reading of the console.

**Step 6. Sink and vocabulary hygiene.**
Add `TOKENPROXY_LOG_DECISIONS` (default `on`) as the only kill switch; decision
lines deliberately ignore `LOG_LEVEL`, because the whole failure mode being
fixed is a signal that got turned down. Optionally add a second sink at
`~/.tokenproxy/logs/decisions.ndjson`, size-capped, so an agent can grep without
`journalctl --user`.

**What does not move.** The 642 raw `console.*` sites outside the decision
points stay as they are. They are not the bloat: the measured top six lines are
1.5% of the sites and 92% of the volume. A tree-wide rewrite would be a large
diff for no measurable gain.

---

## 7. What is needed from the operator before implementation

Five decisions. Four are cheap; the second is the only one that touches live
routing and is therefore explicitly out of scope for the agent that wrote this.

1. **The admission front is outside the repo.** Decision points 1-3 live in
   `~/.local/lib/tokenproxy-front/front-proxy.mjs` (594 lines, one
   `console.error` at `:591`), owned by `tokenproxy-front.service`, not by this
   repository. Options: (a) implement the same schema there in a separate
   change, (b) leave the front silent and accept that a 503 at admission is
   diagnosable only from the client side, (c) give the front its own design.
   Recommendation is (a), but it is a separate change on a separate unit.

2. **Cross-process correlation needs a header.** For a `503` at the front to be
   greppable against anything in the gateway, the front must mint the `rid` and
   pass it as `x-tp-rid`, with the gateway adopting it when present. That is a
   live-routing change and needs the operator's own hands, or an explicit
   go-ahead after the E1 cutover settles.

3. **May `sessionHash` appear in the log?** The proposal uses an 8-character
   prefix (`sid=b41e9c30`). Account Scheduling Contract rule 8 forbids
   credentials and prompt bodies; a truncated hash of a hash is neither, and
   `sessionAffinityRepo.js` already persists the full hash in a table. Confirm
   the prefix is acceptable in a log that may be pasted into a transcript.

4. **Sink.** Journald only, or journald plus a capped NDJSON file? Journald
   requires `journalctl --user -u tokenproxy` and cannot be grepped by an agent
   that does not know the unit is a user unit. A file at
   `~/.tokenproxy/logs/decisions.ndjson` costs about 30 lines of code and makes
   the log a first-class artefact.

5. **The emoji column.** `logger.js:17`'s eight coloured dots cost four bytes a
   line and collide at any real concurrency. The proposal deletes them in favour
   of `rid`. If they are load-bearing for the operator's own eye, they can stay
   alongside; say which.

One thing explicitly **not** asked for: permission to pick the enum values, the
class names, the field abbreviations, or the folding schedule. Those are
reversible and are decided here.
