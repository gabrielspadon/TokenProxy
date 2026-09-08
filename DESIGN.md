# TokenProxy Domain Requirements

TokenProxy is a local AI routing gateway. It accepts inference requests on
one endpoint, and routes each one across many upstream provider accounts,
translating between request formats, falling back across models and
accounts, refreshing stored secrets, and accounting for what was spent. A
person operates it.

This document is the complete statement of what that person operates: every
concept they can look at or act on, every attribute each concept carries,
every state it can be in, every action available on it together with what
that action requires and what it changes or destroys, every fact that has
to be readable, and every decision that is theirs to make.

It states no more than that, deliberately. Nothing here says how any of it
is presented, arranged, grouped, named on screen, prioritized, or moved
through. There is no layout, no navigation, no destination, no component,
no density, no color, no interaction pattern, and no ordering implied by
the order of sections below. Those are not omissions to be filled in from
convention; they are the whole of the work being handed over, and they
belong entirely to whoever designs the experience. The section numbering
here is a reading aid for cross-references within this document and carries
no meaning beyond it.

Everything below is derived from the running system: every operator-facing
operation it exposes and the state and projection logic behind each one,
the full data model and every store over it, the account-ranking and
session-repinning policy, the request-time selection and request-shaping
path, the local tooling and interception surfaces, and every setting the
gateway actually reads. It describes the machine, not any prior rendering
of it.

Where a fact is subtle, the subtlety is stated rather than smoothed over, on
the principle that a designer who does not know a percentage can be
unmeasured, or that an authenticated caller can still be insufficient,
cannot design honestly around it.

---

## 1. Provider Connections

A **provider connection** is one credentialed account (or, for API-key
providers, one key) against one upstream AI provider. It is the unit
everything else (quota, ranking, draining, session pinning, qualification)
operates on.

### Attributes a person needs to see

- Which provider it belongs to (a canonical provider id, Anthropic, OpenAI,
  GitHub Copilot, a self-hosted OpenAI-compatible node, etc.)
- How it authenticates: OAuth grant, a pasted access token, or an API key
- A human-readable name (derived automatically for OAuth accounts from the
  provider's own account identity (email, login, or workspace id) when
  none was given explicitly)
- An email address, where the provider or the operator supplied one
- Its position in the fallback order for its provider (a configurable
  integer; connections are tried in this order when nothing else decides)
- Whether it is enabled at all (an account can be turned off without being
  deleted)
- When it was created and when it was last updated
- Its per-connection concurrency ceiling (how many requests may run on it
  at once), which is either an explicit number, an explicit "no ceiling," or
  unset (falls back to a system default of 80)
- Its most recent test/probe outcome, the model that probe used, how long
  it took, and (if it failed) a redacted, human-readable reason (never the
  raw provider response, never a credential)
- When it was last tested/probed
- Whether it is currently past a rate limit, and until when
- Whether it is currently locked for one specific model (as opposed to the
  whole account) after that model failed against it, and until when, with
  the redacted reason for that specific model's failure
- A default model preference for the account, where one is set
- Provider-specific auxiliary data the account carries (e.g., a GitHub
  login/workspace id, a Codex workspace id), informational, not something a
  person edits directly field-by-field
- Whether it is bound to a proxy pool (see §2) for its outbound traffic, and
  whether that binding is "strict" (fail the request rather than fall back
  to a direct connection if the pool becomes unusable)

### States

A connection's overall status is one of: **healthy** (has a successful
probe on record and nothing is wrong), **unqualified** (disabled, or never
successfully probed), **cooldown** (currently past a rate-limit window),
**degraded** (its last recorded test or error state is unhealthy, meaning
an authentication failure, an unavailability, or a stale test error,
independently of any active rate-limit window), **drained** (an operator
has explicitly taken it out of new-selection rotation, and this outranks
every other condition),
or, specifically in a fresh qualification probe's result, **error** (the
probe that was just run failed outright).

Two further conditions exist in the backend today but are **not** folded
into that status vocabulary and have no dedicated field of their own in the
admin projection (see the gap noted at the end of this document): whether
the account is currently paused by a configured per-window quota threshold,
and whether a specific model (rather than the whole account) is currently
locked out after a model-scoped failure.

### Actions

- **Enable / disable.** A disabled connection is skipped by selection
  entirely but is not deleted; its history and credential remain on file.
- **Reorder its fallback priority** relative to other connections of the
  same provider.
- **Set its per-connection concurrency ceiling**, including explicitly
  setting "no ceiling" (distinct from leaving it unset, which uses the
  system default).
- **Re-probe it** (spend one real generation against the provider to prove
  it currently works). This is the *only* connection-level action that
  contacts the upstream provider at all; everything else reports what a
  past probe already established. A very recent probe (under a configurable
  freshness window) is reused rather than repeated unless a fresh probe is
  explicitly requested. Two probes cannot run concurrently against the same
  connection, a second request while one is in flight is refused outright
  rather than queued. A probe cannot be started against a connection that is
  currently draining. A probe's own failure is not an error in the
  operation. It is itself the finding the person asked for, and is
  recorded as such.
- **Begin draining it.** Stops it from being selected for *any new* request
  immediately. Requests already in flight on it, and any client session
  already durably pinned to it, are left alone to finish naturally, a
  drain does not cut an active stream. Draining an account that is already
  draining changes nothing (it is not an error to ask again). Draining is
  the one condition that outranks every other read of a connection's
  health.
- **Cancel a drain**, returning the connection to normal eligibility for new
  selection. Canceling a drain on an account that is not currently draining
  changes nothing.
- **Re-authenticate it** with a freshly issued credential (a new OAuth grant
  or token) without losing its identity: its position in the fallback
  order, its concurrency ceiling, its proxy binding, and its history stay
  intact, only the credential itself, and any error/lockout state hung on
  the old credential, is replaced. This is refused outright (no partial or
  silent effect) when the new credential is empty/unusable, when it visibly
  belongs to a different provider than the connection's own, or when the
  identity behind it (its email) visibly differs from the connection's
  existing identity, unless that mismatch is explicitly overridden (an
  account's email can legitimately change).
- **Delete it.** Irreversible: the connection row, its credential, and its
  configuration are gone. (Deleting the *last* connection for a provider
  simply leaves that provider with zero connections; nothing else cascades
  from a single connection's deletion.)

### Read-only facts a person needs surfaced

- Every model or feature-scoped sub-quota a connection reports is folded
  into ranking evidence, not treated as a separate account-level
  constraint. That this filtering happens is a fact a person needs to be
  able to learn; it is not itself configurable.
- A connection whose credential envelope is unreadable, or that this
  install has never successfully probed at all, is indistinguishable from
  one that is simply new. Both read as "unqualified" until a probe
  succeeds.
- Aggregate counts across every configured connection: how many are
  configured in total, how many are currently enabled, how many are
  currently in a degraded condition, and (grouped by provider) how many
  of that provider's connections are degraded and the likely cause
  (rate-limited, an authentication problem, unavailable, a failed
  connection test, or an otherwise-unclassified upstream error).

---

## 2. Provider Nodes and Network Routing

A **provider node** is a self-registered, OpenAI-compatible upstream
endpoint the operator has added beyond the built-in provider catalog, a
locally hosted model server, a compatible third-party gateway, etc. Its
provider connections (§1) reference it as their "provider" id.

### Attributes of a provider node

- A stable id used as the provider identifier elsewhere in the system
- A type classification
- A human-readable name
- A URL prefix
- The API dialect it speaks
- Its base URL
- Which transport(s) it supports
- When it was created/last updated

### Actions

- **Create, update, or delete** a node.
- **Delete a node and everything under it in one irreversible step**: this
  removes the node itself, *every provider connection registered against
  it*, and *every model alias that points at it*. It is a cascading
  removal, not a single-record deletion, and is irreversible.

A **proxy pool** is a named outbound network path (a proxy URL, an optional
no-proxy exception list, a transport type) that a connection or a
provider-wide strategy (see §6) can be bound to instead of routing directly.

### Attributes of a proxy pool

- Name, proxy URL, no-proxy list, transport type
- Whether it is active
- Whether it is currently in "strict" mode for whatever is bound to it (a
  bound connection or strategy fails outright rather than silently falling
  back to a direct connection when the pool becomes unusable)
- Its own connectivity test status, when it was last tested, and its last
  test error
- When it was created/last updated

### Actions

- **Create, update, or delete** a pool.
- **Change its strictness.** This is a durable property of the *pairing*
  between a pool and whatever is bound to it, not just the pool itself:
  changing it updates every connection and every provider-wide strategy
  currently bound to that pool, atomically, so nothing bound to a pool can
  observe an inconsistent strictness value mid-change.

### Decisions a person can make (global network settings)

- Configure a single **outbound egress proxy** for all traffic that is not
  otherwise routed through a specific pool (a URL, a no-proxy exception
  list, and an on/off switch).
- Configure, per provider (not per individual connection), an optional
  rotation strategy across proxy pools and an optional connect-timeout
  override.
- Configure a global connect-timeout default.

---

## 3. Quota Windows and Account Ranking

A **quota window** is one normalized reading of a connection's entitlement
against one provider-defined limit (a 5-hour window, a weekly window, a
monthly window, or any future provider-specific window). It is the unit
every scheduling decision is made from.

### Attributes

- Which window it is (the provider's own name for it, e.g. "session (5h)")
- Remaining entitlement, in the provider's own absolute units, never a
  percentage; a percentage cannot be compared across windows of very
  different size
- The ceiling for that window, in the same units
- When it resets
- When this reading was captured
- How much this specific reading can be trusted: **measured** (read
  directly off a real provider response), **estimated** (derived, e.g.
  carried forward from an aging snapshot rather than a fresh percentage
  reading, or converted from a percentage-only reading onto a synthetic
  scale because the provider did not report an absolute total), or
  **unknown**

### Read-only facts a person needs surfaced

- A window whose remaining value is at or below its ceiling but whose reset
  time has already passed is treated as *replenished*, not depleted, the
  stale reading is understood to no longer apply.
- Every window a connection has ever reported is available per connection,
  and the same evidence exists for every connection, so the question is
  frequently a cohort one rather than a single-account one: an operator
  compares one account's remaining headroom against the others'.
- A connection can have *no* recorded window evidence at all, that is a
  meaningfully different fact from a connection not existing, and from a
  connection whose only windows are exhausted.

### Account ranking (a read-only mechanism, not an action)

Given a group of connections competing for the same kind of traffic, the
system ranks them to decide who serves the next request. This ranking is
not something a person triggers or configures directly (it runs
automatically) but its inputs and outcome are things a person needs
visibility into, because it explains *why* traffic is landing where it is:

- A connection whose window shape (which windows it reports) does not match
  the rest of its cohort, or that has no usable evidence at all, degrades
  the whole cohort's ranking to simple stickiness rather than being
  silently excluded or silently ranked as worst.
- Within a cohort that *can* be ranked: an account with any window
  currently at its limit is excluded from ranking outright. Among the rest,
  measured evidence always outranks estimated or unknown evidence for the
  same window; ties are broken by whichever account's longest-horizon
  window resets soonest (spending entitlement that is about to be wasted
  first); further ties by whichever account a session is already pinned
  to; and only as a last resort, by an operator-configured priority number.
- A connection with a configured spend ceiling reads as "no ceiling" when
  unset, exactly like a fresh install.

### Decisions a person can make

- **Configure per-window auto-pause thresholds** on a connection: for any
  named window that connection reports, a percentage floor below which that
  connection is skipped for new selection entirely (until the window
  recovers). A window with no threshold configured never auto-pauses.
  Multiple windows can each carry their own threshold independently.
- **Mark specific quota window names as uninteresting**, per provider, an
  acknowledgment that a provider reports a window a person does not
  care about, which suppresses it as a reportable fact without removing
  the underlying evidence from ranking.
- **Set a connection's fallback priority** (used only as ranking's final
  tie-break, never as the primary ordering).

---

## 4. Session Affinity and Account Switching

A **session pin** durably ties one client's ongoing session, for one model,
to one specific connection, so a multi-turn conversation keeps landing on
the same account rather than being re-ranked (and potentially re-routed)
on every single request.

### Attributes of a session pin

- The session identity is never itself stored or shown, only a one-way
  hash of it. A person can never see, search, or recover the raw client
  session identity from this system.
- Which model the pin applies to (a session can be pinned differently per
  model it uses; a request naming no model gets its own shared anonymous
  pin)
- Which connection it currently points at
- Which provider node it was made under, if applicable
- When the pin was made (its own timestamp, distinct from when it was last
  touched by a live request)
- When it was last seen active
- An optional expiry, after which it stops applying on its own (a pin with
  no expiry lasts until something else ends it. The account it points to
  becoming unavailable, exhausting its quota, being drained, or failing for
  that specific model)

### Read-only facts a person needs surfaced

- A pin does not move just because ranking would now put a different
  account ahead. It moves only when: the account it points to becomes
  unavailable, the pinned account's quota is exhausted, the account is put
  into drain, that model specifically fails on the pinned account, or a
  *higher-priority* account that was NOT eligible when this pin was made
  becomes eligible again (a genuine reset, not one that was available all
  along). This is why a session can visibly stay on an account that no
  longer looks like the "best" one available. That is intentional
  stickiness rather than a fault, and it is a fact a person needs in order
  to interpret what they are seeing.
- The very first time a session is pinned to anything at all is itself
  recorded as a switch (a "switch" away from nothing).

A **switch (account-switch) receipt** is the durable, append-only audit
record of every time a session's pin moved from one account to another (or
was set for the first time). This is the record an operator or an incident
review reads to answer "why did this session end up here."

### Attributes of a switch record

- A unique id
- When the switch happened
- Why it happened: quota exhaustion, a window reset restoring an earlier
  account, an operator-initiated drain, a model-specific failure, or
  otherwise "manual"
- Which model it was scoped to
- The (hashed, never raw) session identity involved
- The account it left (null only for a session's very first pin, there is
  nothing to have left)
- The account it landed on
- The normalized quota-window evidence for the *old* account at the moment
  of the switch (absent when there was no old account) and for the *new*
  account
- What a receipt is guaranteed to **never** contain, as a hard fact about
  what is stored rather than about what is withheld from view: any
  credential, API key, token,
  secret, prompt content, request body, response body, or the raw session
  identity.

### Actions and read access

- Receipts are strictly append-only. Nothing edits or deletes one.
- Every receipt is browsable, filterable by connection, by model, and by a
  starting point in time, and pageable through an unbounded history.
- Any single receipt is retrievable by its id. A receipt from far enough in
  the past that it has aged out of what a scan will reach reads
  identically to a receipt that never existed, the system does not
  distinguish "too old to find" from "never happened."

---

## 5. Drain and Release Lifecycle

**Drain** is covered under Provider Connections (§1) as an action on a
connection; this section covers its own state object plus the separate
concept of a **release**.

### Drain state, per connection

- Whether it is currently draining
- When the drain was requested (kept even after the drain completes, so
  "how long was this account out" stays answerable, a completed drain is
  never deleted back to a blank state, only marked complete)
- How many requests are still actively in flight on this connection right
  now (this is the number that tells a person whether a drain is finished
  bleeding off traffic or still waiting on live streams)
- When the drain completed (null while still draining)
- An opaque token representing the exact state just read, needed to safely
  change that state without racing a concurrent change (see below)

### The concurrency-safety fact a person needs to understand

Every action that changes a connection's drain state, or the active
release (below), is protected against two people (or two automated
callers) racing the same change: whoever acted on stale information gets
told the state has moved on and nothing they asked for was applied, the
state is left exactly as it was before their request, byte for byte. This
is not an error to hide or retry silently past; it means "re-read the
current state, then decide again."

A **release** is one build/version of TokenProxy itself, and specifically
which one is currently serving traffic.

### Attributes

- A release id
- A version string
- Its status: **pending**, **active**, **rolled_back**, or **failed**
- When it was activated (null if never activated)
- Which release it superseded, if any (this is what an "undo" with no
  explicit target walks back to)
- The same kind of opaque concurrency-safety token as drain state carries

### Read-only facts

- A release becomes "known" to the system only by having been activated (or
  by being the build currently running, which is always known even on a
  fresh install that has never explicitly activated anything). There is no
  separate step that registers a release ahead of activating it, naming an
  unknown release id is always refused rather than silently creating one.
- A history of releases is available, bounded to a fixed number of the
  most recent entries, very old activation history is not retained
  indefinitely.
- A release on file that failed its own build/qualification check is a
  different fact from one that is merely not currently active, and
  activating a failed one is refused for that specific reason.

### Actions

- **Activate a named release.** Refused if that release does not exist, or
  exists but is marked as having failed its own precondition. Activating
  the release that is already active changes nothing (it is not an error
  to ask again). This is a state transition with real consequences (it
  changes which build is serving every future request) and it is the one
  release action a person can name a specific target for.
- **Roll back.** With no target named, this walks back to whatever release
  the currently-active one itself superseded. With an explicit target
  named, it goes straight to that release instead, which matters after a
  *chain* of bad activations, where walking back only one step at a time
  would re-activate something already known to be bad. Rolling back with
  no target and nothing on record to roll back to is refused outright. This
  is a distinct, expected outcome ("there is nothing to undo"), not a
  system error. A rollback is itself recoverable: rolling back a second
  time returns to where the first rollback started, so an operator is
  never stuck.

---

## 6. Model Catalog

The **model catalog** is every model a person can route a request to,
across every configured provider and provider node.

### Attributes, per model

- Its own id and which provider/node serves it
- Its fully-qualified identifier (provider + model together)
- Capability flags: whether it supports vision input, web search, extended
  reasoning; its context-window size; its maximum output size

### Related concepts under the same catalog

- **Model aliases**, an operator-defined short name that maps to a full
  provider/model identifier, so a person or client can refer to a model by
  a name of their own choosing.
- **Custom (self-added) models**, models registered by hand against a
  provider node rather than discovered automatically, each carrying its own
  id, human-readable name, type, and optional context-window/output/vision
  overrides.
- **Disabled models**, a per-provider (and optionally per-connection) list
  of model ids that are not offered for routing at all. A connection that
  has never had its own list inherits the provider-wide one; the moment a
  connection gets its own list, edits to it never affect the provider-wide
  list or any other connection's inherited copy. Explicitly re-enabling
  every model a connection had disabled leaves that connection with an
  explicit empty list of its own, not a reversion to inheriting the
  provider list.
- **Free-tier model discovery**, for providers whose free-tier catalog is
  synced automatically, which model ids are currently known to be free,
  and when that list was last refreshed.
- **Newly observed models**, every model id ever seen from any connected
  provider or node is tracked so genuinely new additions can be
  distinguished from ones a person has already acknowledged. A model can
  be in one of three states with respect to this: never seen before,
  seen-but-not-yet-acknowledged, or acknowledged. On the very first scan
  after this tracking existed, everything already present is seeded as
  already-acknowledged, so nothing pre-existing is misreported as new.
  Acknowledging can be done for specific models by name or in bulk for
  everything currently unacknowledged.

### Model combos

A **combo** groups several models together under one name, to be tried as
an ordered or strategy-driven set rather than a single fixed model.

- Attributes: a unique name, an optional kind classification, its ordered
  member list, when it was created/updated.
- Actions: create, rename/edit its member list, delete.
- A combo's own routing behavior (fallback order vs. some rotation
  strategy, and how "sticky" repeated use of the same member is) is a
  global default, but can be overridden per individual combo.

### Decisions a person can make

- Which models are disabled, at the provider level and, optionally,
  overridden per individual connection.
- Which models are custom-registered against a provider node, and their
  overrides.
- What short aliases exist and what they resolve to.
- Whether newly discovered models are acknowledged (dismissing the "new"
  designation), individually or all at once.
- The default strategy new combos use, and per-combo overrides of it.
- Whether only combos (never individual bare models) may be requested at
  all, a global routing restriction.
- **Capability-based auto-routing**: for each of vision input, PDF input,
  audio input, and video input, whether TokenProxy should automatically
  substitute in a capable model when the one requested cannot handle the
  input, which specific models are eligible substitutes, and whether that
  substitution rotates among the eligible set rather than always picking
  the same one.

---

## 7. Client API Keys and Access

A **client API key** is a credential issued to a downstream caller (a tool,
a script, another person) to authenticate against TokenProxy's own
inference surface. This is a completely separate credential space from the
provider connections in §1, a client key never grants access to an
upstream provider's own account directly.

### Attributes

- A unique id and the key value itself (generated by the system, tied to a
  machine identity at creation)
- A name given by the operator
- Which machine it was generated for
- Whether it is currently active
- When it was created
- An optional expiry (unset means it never expires, the default for every
  key that predates this feature)
- Three independent, optional spend ceilings: a maximum prompt-token total,
  a maximum completion-token total, a maximum cost in dollars. Each is
  either a concrete non-negative number or "no ceiling." A ceiling of
  exactly zero is a real, deliberate value, it freezes the key without
  deleting it, distinct from leaving the ceiling unset.
- An optional model allowlist: either a specific list of models/providers
  this key may use (supporting a whole-provider wildcard, e.g. "every model
  from this provider"), or unset, meaning every model is permitted. An
  empty list is treated the same as unset.
- Its lifetime usage: total prompt tokens, total completion tokens, total
  cost, and total request count spent since the key was created (this is a
  running lifetime total, not a rolling window, the ceilings above apply
  against all traffic the key has ever generated, not traffic since some
  reset point)

### States

A key can be **active**, **explicitly deactivated**, **expired** (its own
expiry timestamp has passed), or **over one of its own spend ceilings**, the
last two make a key stop authenticating on its very next use even if
it is still marked active, with no separate cleanup step required for that
to take effect.

### Actions

- **Create** a new key for a given machine, with an optional expiry.
- **Edit** its name, active flag, expiry, spend ceilings, and model
  allowlist.
- **Delete** a single key. Irreversible, the key stops authenticating
  immediately, and its allowlist configuration is removed with it. Its
  historical usage rows are unaffected (usage records are keyed to the key
  value, kept independently).
- **Delete several keys in one step.** This exists specifically because a
  partial revocation of a batch (some succeed, some do not) leaves a
  compromised key set only partly closed, the batch is meant to be
  complete-or-nothing in intent, even though the underlying operation
  reports how many were actually found and removed.

### Read-only facts

- Which of a key's own ceilings (if any) it has currently exceeded, if
  any, a key with no ceilings configured never needs its usage totals
  looked up to answer this.
- Whether a given model is permitted for a given key, given its allowlist
  (or the fact that it has none).

---

## 8. Usage and Cost Accounting

This is the record of what actually happened: every completed request, its
cost, and rolled-up views over that history.

### Per-request facts (the finest grain)

For each completed request: its timestamp, which provider and model served
it, which connection served it, which client key made it, which inference
endpoint was hit, prompt/completion token counts, cached-token and
cache-creation-token counts, reasoning-token count where applicable, its
outcome status, its total latency and time-to-first-token, and its
calculated cost (derived from token counts against the pricing in effect
(see below) at the time it was recorded).

- The client key is stored, but only ever shown back masked, the raw key
  value is never re-exposed through any usage view once issued.
- A second, optional layer of detail exists **only when explicitly turned
  on**: the full (secret-redacted, size-capped) request and response
  bodies for a request, including what was actually sent to the upstream
  provider and what it returned. When this detail layer is off, the
  finer-grained per-request facts above are still recorded, only the
  bodies are not. Whether this detail layer is currently on is itself a
  fact a person needs, because an empty result for it is indistinguishable
  from a result that is empty only because the layer is off.
- Detail-layer records are capped to a maximum count and pruned oldest
  first once that cap is reached. This is a rolling window, not permanent
  history.
- The finer-grained (non-body) per-request facts are retained for a
  configurable number of days (45 by default) before being pruned, a
  materially longer retention than the optional body-detail layer above.

### Rolled-up and derived views

- Totals over any combination of provider / model / connection / time
  range: request count, total tokens, input-only tokens (prompt minus
  cache-read and cache-creation), output tokens, cache-read tokens,
  cache-creation tokens, and a cache-hit rate (explicitly absent, not
  zero, when there is nothing to compute a rate from).
- The same totals broken into a time series, with the bucket width chosen
  automatically from how much actual history falls in the requested range,
  so a short range gets fine buckets and a long one gets coarse ones.
- Average latency and average time-to-first-token, each carrying its own
  sample count alongside it, because a large share of historical rows
  never measured latency at all, and an average that silently excluded
  those would be answering a different question than "how fast are my
  requests" without saying so.
- **Provider health**, grouped at the operator's choice of grain (by
  provider alone, by account, or all the way down to account+model):
  request count, error count, a success rate (again explicitly absent
  rather than a false 100% when nothing was measured), and latency
  statistics, all over a chosen period or explicit date range.
- **Spend over a rolling window**: total dollar cost and how many priced
  requests contributed to it.
- **Currently active / in-flight requests**, live: how many requests are
  running right now, broken down by model and by account; the most recent
  individual requests, each carrying model, requested against resolved
  model, reasoning effort where one was set, provider, token counts,
  outcome, and the masked key that made it; and the in-progress sessions,
  each with how long it has been running.
- A day-by-day rollup, and a lifetime total request counter for the whole
  install, both maintained continuously rather than computed on demand.
- Per-connection **daily usage against a rolling day boundary**: request
  count and total tokens since local midnight, and exactly when that
  counter resets next.
- Per-client-key lifetime usage totals, and the same totals for every key
  at once without a separate lookup per key.

### Pricing

- **Pricing per model** is either the built-in default for that
  provider/model, or an operator override for it. Overrides merge on top of
  built-in defaults rather than replacing the whole set, setting a price
  for one model never disturbs another model's price, whether that other
  model's price is a default or another override.

### Decisions a person can make

- Turn the optional full-body detail-logging layer on or off, and adjust
  its retention cap, its write-batch size, its flush interval, and the
  per-body maximum size before a body is truncated.
- Override the price of any specific model, or clear an override back to
  the built-in default, for a single model, for every override under one
  provider, or for every override across every provider at once.
- Set each client key's own spend ceilings and model allowlist (see §7).

---

## 9. Operator vs Client Identity

Two entirely separate classes of caller exist, and the distinction is a
fact a person needs to understand about the system, not something they
configure directly (though several of the settings below govern how it is
enforced):

- An **inference caller**, someone (or something) using a client API key
  (§7) purely to route inference requests. This class alone is *never*
  sufficient to read or change anything covered in §§1–6, 8 (connections,
  quota, drain, releases, receipts, the catalog's disable/alias/custom-model
  configuration, or spend accounting), regardless of which key is used.
- An **operator**, someone authenticated either through an interactive
  login session or through a distinct command-line-issued token tied to
  this machine's own identity. Only this class may read or change anything
  covered in §§1–6
  and the configuration parts of §§7–8. A caller holding only a valid
  inference key that reaches an operator-only action is told, distinctly,
  that it holds the *wrong kind* of credential. That is a different and
  more specific
  answer than "no credential at all."
- A small number of read operations (liveness, and the plain model catalog)
  are reachable by *either* class, or by a caller connecting from the
  local machine itself with no credential at all, because a caller needs
  to be able to check those two things before it has any credential-scoped
  identity yet.
- Every action that actually **changes** state (probing a connection,
  starting or ending a drain, activating or rolling back a release) is
  reachable *only* from the local machine itself (directly, or through
  whatever secure tunnel terminates as a local connection), never from an
  arbitrary remote address, no matter how strong the credential presented.
  A person needs this constraint visible, since it means "I have the right
  operator credential" is not by itself enough to perform a mutating
  action from just anywhere.
- A rejected request (for any reason: no credential, the wrong class of
  credential, not a local connection) changes nothing at all and leaves
  every other piece of state exactly as it read immediately before the
  rejected attempt. This is a guaranteed fact about every refusal, not
  merely a best effort.

### Decisions a person can make

- Whether a login/session is required for operator access at all, and
  whether a separate client-key requirement is enforced independently of
  that.
- Which authentication mode governs operator login, and its configuration
  (§19).

---

## 10. System Health

Two distinct, separately-scoped health facts exist, deliberately kept
apart:

- **Liveness**, the admin surface's own process is up and answering at
  all. Deliberately shallow: it touches no database and no upstream, so it
  can answer honestly even during a database outage, and it is reachable
  by either identity class in §9 for exactly that reason (a caller needs to
  be able to tell "dead" from "refusing" before it has proven anything
  about itself). It reports: an ok/not-ok status, how long the process has
  been running, and the moment this reading was taken.
- **Readiness**, a deeper judgment, operator-only, that is always
  answerable (it reports a verdict in its body rather than failing the
  request outright, because a caller that treated "not ready" as "process
  dead" would take healthy infrastructure down over one degraded
  provider). It reports:
  - Whether the underlying data store itself is currently reachable, which
    driver is serving it, and how long that check took (or, on failure,
    why).
  - Every configured connection's status (§1), independent of whether that
    connection is currently enabled, a connection that auto-disabled
    itself after repeated authentication failure is exactly the kind of
    thing this is meant to surface, not hide.
  - An overall rollup: **ok** when the store is reachable and nothing is
    degraded or in cooldown; **degraded** when the store is fine but at
    least one connection is not; **error** when the store itself cannot be
    reached, or the connection scan itself failed outright.

---

## 11. Request Shaping and Token Reduction

Before a request leaves for its provider, a stack of optional layers may
rewrite it. Every one of them exists to spend fewer tokens on the same
work, and every one of them is independently switchable. The stack is one
concept because the layers share a single contract, they fail open, so a
layer that errors leaves the original body untouched and costs savings
rather than correctness.

### The layers

- A bundled reducer that rewrites the content of tool results in place,
  deliberately skipping results marked as errors so a failure trace
  survives whole.
- History pruning, which drops or shortens older turns rather than
  content: how many recent tool exchanges keep their full text, a
  character ceiling on older ones, whether images and other attachments in
  older turns are dropped, whether the conversation is compacted once it
  crosses a token threshold, how many recent turns are always kept intact,
  and whether a handoff summary is produced when it is.
- Tool-list filtering, which shortens the list of tools disclosed upstream,
  with a ceiling on how many are sent and named exclusions by tool and by
  originating server.
- Term filtering, which removes operator-named strings from an outbound
  body.
- A separately installed compression service, described below, which is
  its own concept because it is versioned and installed apart from the
  gateway.

Exactly five of these layers can be overridden per named model chain (§6),
so a chain can run with a different shaping stack than the global default
without changing that default.

### The separately installed compression service

- **Installation** is distinct from **load**, which is distinct from
  **policy**, which is distinct from **health**. All four can disagree, and
  a person needs each separately: installed but never loaded, loaded but
  failing its own self-test, and switched off by policy while perfectly
  healthy are three different situations with three different remedies.
- Its health verdict is made of individually named checks, each passing or
  failing with its own detail, and it is produced by running a real
  transform rather than by confirming a file exists.
- Per request it records a timestamp, whether compression was applied,
  estimated tokens before and after, the estimated saving, a named reason
  when it was bypassed, how many images resulted, and how long the attempt
  took. These rotate under a size ceiling, so history is bounded rather
  than complete and older records are genuinely gone.
- From those records come all-time totals, totals over recent hour, day and
  week windows, a per-day timeline across the last month, an average
  duration, and the most recent individual records.

### States

The service is **not installed**, **installing** (which can take minutes on
a cold cache), **installed but not loaded**, **loaded and serving**,
**loaded but unhealthy**, or **disabled by policy**, and the last holds
regardless of the others.

Per request, and for every layer in the stack, the outcome is **applied**,
**bypassed** with a named reason (below the size threshold, the layer
declined, or a timeout expired), or **errored**. In the last two cases the
original body is what goes upstream.

### Actions

- Turn any individual layer on or off, globally or for one named model
  chain.
- Set each layer's own thresholds, meaning the minimum request size worth
  attempting, the per-attempt timeout, the ceilings on retained history,
  and the tool-count ceiling and exclusions.
- Install the compression service, which always fetches the current version
  and is therefore also the repair action. It discards any loaded copy and
  re-runs the health check. It overwrites the previous installation and is
  long-running by nature.
- Start, stop and restart it. Stopping reports whether anything was
  actually loaded, which separates "stopped it" from "it was not running".
  In-flight requests may be mid-transform when it unloads.
- Run its health check, which returns each named check with its verdict.
- Read its install log, its recent per-request records, and its aggregates.

None of these touches conversation content at rest or any stored secret.

### Facts a person needs to read

- Which layers are on, and which of them a given model chain overrides
- Whether the compression service is installed, at what version, whether it
  is loaded right now, and whether its self-test passes, with the failing
  check named when it does not
- How many requests were compressed, bypassed, and errored, and why the
  bypassed ones were skipped, separating "too small to bother" from "the
  layer declined" from "it ran out of time"
- Estimated tokens saved, all-time and per window, and per day across the
  last month
- Average duration, which is the cost against which the saving is judged

### Decisions a person can make

- Which layers to run at all, and whether a particular model chain deserves
  a different stack from the default
- How aggressively history is pruned, which is a direct trade of context
  against cost and is the one setting here that can change an answer
- How large a request must be before compression is attempted, and how long
  to wait before abandoning an attempt, which together bound the latency
  the stack can add
- Whether the estimated saving justifies that latency, a judgement needing
  both numbers, which is why both are recorded
- Whether a failing health check calls for a reinstall or for switching the
  service off

---

## 12. Non-Language Services

Not every request is a conversation. The same provider connections (§1)
can also serve embedding, reranking, image generation, image editing,
image-to-text, optical character recognition, moderation, text to speech,
speech to text, web search, and web fetch.

A **non-language service** is not a stored thing of its own. It is one
existing provider, and by extension the connections already made to it,
seen through one of those service kinds. There is no separate record to
create, no separate stored secret, and no separate lifecycle.

### Attributes

- The service kind
- Which providers declare support for that kind, and which connections
  therefore serve it
- Per kind, an endpoint configuration that comes from the built-in provider
  registry rather than from the operator, carrying the address, the
  authentication shape, the wire format, and a default model

### Facts a person needs to read

- Which non-language kinds are actually available on this installation, and
  through which connections
- That availability here is derived rather than configured, so a kind
  appearing or disappearing follows from a connection changing, never from
  a switch specific to that kind

### Decisions a person can make

- Whether to keep a provider connected for a non-language kind alone
- That turning one of these off means acting on the underlying connection
  or on the provider-wide switch, because there is no per-kind switch to
  reach for

---

## 13. Client Compatibility and the Model Namespace

Many clients only speak one vendor's dialect and will only accept model
names that look like that vendor's. A **compatibility layer** rewrites the
model list the gateway advertises so those clients can use models the
gateway routes to but the client has never heard of.

### Attributes

- Whether the layer is on at all
- Whether a marker is appended to advertised model names always, never, or
  automatically, where automatic means appending it only when the name
  matches an operator-supplied keyword
- That keyword list
- Whether the advertised list is restricted to named model chains only,
  hiding individual models from clients entirely

### Facts a person needs to read

- What a client actually sees when it asks what models exist, which can
  differ substantially from the catalog of §6
- Which rule produced that difference, since a name that was rewritten and
  a name that was omitted are two distinct effects with two distinct causes

### Decisions a person can make

- Whether to rewrite the advertised namespace at all, which is a trade
  between a client working out of the box and a person seeing true names
- Which names get the marker, and whether that is decided by a blanket rule
  or by keyword
- Whether clients may address individual models directly, or only the
  chains the operator has curated

---

## 14. Local Tool Integrations

A **tool integration** is one coding agent installed on this same machine
whose own configuration the gateway takes over, so that the tool's traffic
arrives here rather than at its vendor. The population is enumerable rather
than open, and it splits into two families reached differently: tools that
expose a configurable endpoint, and tools that do not and can only be
reached by intercepting their traffic.

### Attributes

- Which tool it is, and which family it belongs to
- Whether the gateway currently owns its configuration, or it is still
  pointed at its vendor
- What the gateway wrote into that configuration, and what was there before
- Which gateway model each of the tool's own vendor model names maps onto
- Whether the tool was detected on this machine at all

### States

- **Not present**, meaning not installed here
- **Present, untaken**, installed and still routing to its own vendor
- **Taken over**, its configuration owned and its traffic arriving here
- **Intercepted**, reached by traffic redirection rather than by
  configuration, which is a materially different arrangement

### Actions

- Take over a tool's configuration, which writes the tool's own
  configuration file and replaces what was there. What was replaced is the
  thing a person may later want back.
- Hand a tool back to its vendor.
- Map one of the tool's vendor model names onto a gateway model, and remove
  one such mapping without giving the whole tool back.
- Enable or disable traffic interception for a tool in the second family.

### The interception path, and why it is different

Interception is the only capability in this entire system whose actions
change state outside the application. It rewrites the machine's
name-resolution file and installs a certificate into the machine's trust
store. Both affect every process on the host rather than only the tool
being intercepted, and both persist after the gateway exits.

Every mutating action on that path is therefore gated behind elevated
authorization, which can be supplied once per action, held for the session,
or kept encrypted at rest. Turning interception off removes the
redirections before shutting the listener down, never after, because the
reverse order would leave the machine pointing at nothing.

### Facts a person needs to read

- Which tools are present, which are taken over, and which are intercepted
- What was written into a tool's configuration, and what it replaced
- Whether the redirection and the certificate are currently in place, since
  both outlive the process that installed them
- How each tool's vendor model names currently resolve

### Decisions a person can make

- Which tools to take over, and which to leave with their vendors
- Whether to intercept a tool that cannot be configured, accepting a change
  to the machine rather than to an application
- How elevated authorization is supplied, per action, for the session, or
  stored
- How each tool's vendor model names map onto gateway models
- Whether handing a tool back means removing one model or the whole
  takeover

---

## 15. Local Extension Bridge

A **local extension** is a program on this machine, speaking a
line-oriented protocol over its own input and output, published so that
tools which only know how to reach a remote streaming server can use it.
The bridge is the adapter between a program on this laptop and a server a
coding agent can attach to.

### Attributes

- Which extension it is, drawn from a closed list of known extensions
- The child process it runs as, and that process's lifetime
- The connection a tool holds open to it
- How its output is truncated or collapsed before being relayed

### States

Not running, starting, serving a connected tool, and failed. A failed start
and an idle bridge are different problems and are held apart.

### Actions

- Open a connection to a named extension, which spawns the child process
  if it is not already running.
- Relay a call to it and return its answer.

### Why the guard here is a different class

Every other guard in this system protects data. This one protects against
starting an arbitrary process on the person's machine, with the person's
own environment and permissions. A lapse elsewhere leaks. A lapse here
executes. The extension name is therefore checked against a closed list
before anything is spawned, and the local-origin requirement is enforced
twice rather than once, on the reasoning that a single check in a single
place is one careless edit away from being wrong, and that the consequence
of that edit is categorically worse than a leak.

### Facts a person needs to read

- Which extensions are available and which are running
- Whether a tool is attached to one right now
- That output is truncated and collapsed in relay, since an extension whose
  results must arrive whole is not a candidate for this path

### Decisions a person can make

- Which extensions to publish
- Whether an extension's output survives truncation well enough for this
  path to suit it

---

## 18. Outbound Notification

An **outbound notification** is a message the gateway sends to an operator
supplied address when something worth knowing happens, so a person does not
have to be watching.

### Attributes

- A global switch
- A list of destinations, each with its own address, its own switch, an
  optional signing secret that is write-only and never readable back, and
  the set of events it subscribes to, where an empty set means all of them
- An error-rate rule, carrying a threshold fraction, a window length, and a
  minimum number of samples below which the rule refuses to evaluate at all
- A bounded in-process log of recent deliveries and their outcomes

### The events

Exactly three exist, and all three are derived from state the routing path
already records rather than from anything measured specially: an account
became unhealthy, an account recovered, and the error rate crossed its
threshold.

### States and transitions

Notification is edge-triggered, so a message is sent when a condition
changes rather than while it persists. The first time an account is seen,
its state is seeded silently, which is what stops a restart from replaying
an old incident as though it were new. The error-rate rule stays silent
below its minimum sample count rather than firing on a handful of requests.

Delivery is fail-open by contract, so a destination that is unreachable
delays nothing and fails no request.

### Actions

- Add, edit, remove, and individually switch destinations.
- Set the error-rate threshold, its window, and its minimum sample count.
- Read the recent delivery log.
- Send a test message to one destination.

### Facts a person needs to read

- Which destinations exist, which are on, and which events each subscribes
  to
- Whether recent deliveries succeeded, since a silent destination and a
  broken one look identical from the outside
- That a signing secret is stored but not readable, which is why a
  destination shows as configured rather than showing its secret

### Decisions a person can make

- Whether to be told at all, and where
- Which events are worth a message, per destination
- What error rate over what window counts as a problem, and how few samples
  is too few to judge on, which is the difference between an early warning
  and a false alarm

---

## 19. Sign-in Policy

There is exactly one operator identity for an installation. There is no
directory of people, no roles, and no second administrator. §9 covers what
that identity is allowed to do; this section covers how it proves itself.

### Attributes

- Whether signing in is required at all
- Which method is in force, a local secret or a federated sign-in through
  an external identity provider, and which of two federation protocols
- The federation configuration, meaning the provider address, the client
  identity, the requested scopes, the label shown on the sign-in action,
  the signing certificate, and which asserted attributes carry the person's
  name and address
- A session, once established, carrying when it was issued, when it
  expires, and, for federated sign-in, the name and address the identity
  provider asserted
- Failure tracking, held only in memory and therefore forgotten on restart:
  consecutive failures, the current lockout level, when it lifts, and the
  window after which failures forget themselves

### States

A visitor is anonymous, authenticated, or locked out. Repeated failures
escalate the lockout through progressively longer intervals, and the
counter forgets itself after a long enough quiet period.

Federated sign-in has intermediate state of its own, short-lived values
that tie the callback to the attempt that started it, cleared on both
success and failure.

There is one deliberate dead end. On a fresh installation still using the
default secret, a correct sign-in from a remote address grants nothing at
all, because handing out a session there would let anyone who reached the
machine switch authentication off entirely. The secret has to be changed
from the machine itself, or set before the first start. This is a designed
refusal and not a fault.

### Actions

- Sign in, and sign out.
- Begin and complete a federated sign-in.
- Publish the document an external identity provider needs in order to
  trust this installation.
- Test a federation configuration without committing to it, which contacts
  the provider, checks that the configuration is accepted, and reports back
  what a real sign-in would carry.
- Change the local secret, which requires the current one whenever one is
  already set. It is never readable back.
- Reset the local secret to its default, which is restricted to a caller on
  the machine itself and cannot recover the old value.

### Facts a person needs to read

- Whether signing in is required, and which method is active
- Whether the current visitor is authenticated, under what name, and by
  which method
- Whether federation is completely configured, which reads as a yes or no
  rather than by showing the stored secret
- How many attempts remain before a lockout, and how long a lockout has
  left
- Whether the installation is still on its default secret, which is the
  single most consequential fact in this section

### Decisions a person can make

- Whether to require signing in at all, which is the widest-blast-radius
  decision in the whole system, since turning it off makes every
  non-inference action reachable by anyone who can route to this machine
- A local secret or a federated provider, and which protocol
- When to rotate the local secret, and whether a test result is good enough
  to switch methods on the strength of it

---

## 20. Version and Self-Update

§5 covers the ledger of releases and the ability to roll back between them.
This section covers a narrower and more immediate question, whether the
version running right now is the current one, and what happens when it is
not.

### Attributes

- The running version, which may be reported by the launcher that started
  the process rather than by the server itself, and those two can
  legitimately differ
- The latest published version, looked up remotely and cached for a period
  so repeated checks are cheap
- Whether the process runs under a supervisor, which decides whether a
  replacement can restart itself or must be restarted by hand
- Whether self-updating is switched off for this installation
- Whether this is a production build at all
- The release notes, which exist as one document served whole rather than
  as structured per-version records

### States

- **Up to date**, a lookup succeeded and the running version is current
- **Update available**, a lookup succeeded and the published version is
  newer
- **Lookup unavailable**, the remote lookup failed. This is emphatically
  not the same as up to date, and reporting it as such would be wrong.
- **Updates disabled**, this installation has opted out
- **Not a production build**, where replacement is refused because there is
  nothing meaningful to replace
- **Supervised** or **standalone**, which decides whether a restart after
  replacement is automatic or manual

### Actions

- **Check**, which reads the running version, consults the published one,
  and reports whether they differ. Purely a read.
- **Update**, refused when self-updating is disabled and refused when this
  is not a production build. Both refusals happen at the point of action
  rather than by hiding the action, so the opt-out holds however the
  request arrives. When it proceeds it stops the running processes and
  hands off to an installer, destroying the running instance by design.
- **Stop for a manual replacement**, which ends the running processes
  without installing anything, for the case where the process cannot
  restart itself.
- **Read the release notes**, or learn they are unavailable, which is a
  distinct outcome from an empty document.

### Facts a person needs to read

- What version is running, and what version is published
- Whether those differ, and whether the answer is even known, since a
  failed lookup has to be legible as a failed lookup
- Whether this installation may replace itself at all
- Whether a restart after replacement happens on its own or needs a hand
- What changed between the running version and the published one

### Decisions a person can make

- Whether to update now or stay where things are
- Whether to let the process replace itself, or stop it and reinstall
  deliberately
- Whether to opt this installation out of self-updating, which is a durable
  choice about the installation rather than about this moment
- Whether the described changes warrant the interruption, since updating
  stops the gateway and therefore stops every tool routed through it

---
## A gap in the current system

Two facts the gateway acts on every time it routes are not reported by any
operator-readable field today. They are recorded here because a designer
cannot invent a way to show what the system does not yet report, and
because both are common causes of traffic landing somewhere a person did
not expect.

The connection status of §1 (the field every qualification and health
statement derives a connection's health from) is computed from exactly
four inputs: whether the connection is draining, whether it is enabled,
whether it is currently past a provider rate-limit window, and its last
recorded test or error state. Two further conditions are enforced on every
routing decision and reach no readable field at all:

- Whether the connection is currently being skipped by selection because
  one of its quota windows crossed an operator-configured auto-pause
  threshold (§3). A connection paused this way reads as plainly healthy.
- Whether one specific model, rather than the whole connection, is
  currently locked out after a model-scoped failure, and until when. This
  is tracked per connection per model, while the readable qualification
  evidence is account-wide only and never carries a per-model lock list.

Closing either gap is a change to the gateway, not to the experience built
over it. Until they are closed, a person is reading a status that is
truthful about four things and silent about two.
