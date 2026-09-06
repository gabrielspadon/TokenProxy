# Token-saver audit harness

Replays a deterministic Claude Code-shaped session through the production
token-saver modules and scores every stage, alone and in combination, on the
how much of the previous request's serialized prompt prefix the next request
reproduces in UTF-8 bytes. This is a local cache-stability proxy, not a billed
provider cache-hit rate. Provider tokenization, cache granularity, routing,
expiry, and cache-control behavior are not simulated.

## Offline (no network, no cost)

```bash
node tests/qa/saver-audit/run.mjs --quick --workers 8 --out /tmp/saver-audit-quick
```

`--quick` runs every stage subset once in the canonical order. Without it,
every order of every subset up to `--maxPerm` stages (default 5) is scored, and
larger subsets get the canonical order plus `--randomPerms` random ones. Two
regimes run per configuration: `wide` (the session never approaches the
window) and `tight` (the second half is over budget, so every pressure rung
fires). `summary.json` carries per-stage numbers, the best order per subset,
and the pairwise precedence the best orders imply.

Columns: `cw` is an invalidated serialized-prefix estimate in KiB (unshared
UTF-8 bytes of the previous prefix, summed over the session; lower is
better), `stab` the mean shared-prefix fraction, `sav` the mean byte saving,
`viol` the invariant violations from `stages.mjs`, `idem` whether the pipeline
is a fixed point on its own output.

`headroom` calls the real wrapper with an in-process JSON-compaction response
stub. It does not validate any external model's compression quality. `reorder`
uses a bag-of-words embedding stub. RTK and schema defaults preserve semantic
content; the remaining historical lossy stages are classified in the independent
validation matrix. This historical runner has twelve grouped stages, combines
Caveman/Ponytail, and omits PXPIPE. It must not be cited as every-toggle coverage.

## Live (Haiku, through a test instance)

Historical instructions only. The current implementation campaign prohibits
real model calls, including calls routed through a local gateway or Headroom.
None of the following live steps are part of the offline acceptance gate.

The chain is test instance -> `upstream-shim.mjs` -> production gateway ->
Anthropic. The shim stamps `x-tokenproxy-token-saver: off` so only the test
instance's savers act; the production gateway supplies the OAuth credential.

1. Build this checkout and start it on its own port and data dir
   (`scripts/dev-test-server.sh` does the same for port 20129).
2. Start the shim: `node tests/qa/saver-audit/upstream-shim.mjs`.
3. In the test instance create an `anthropic-compatible` provider node with
   base URL `http://127.0.0.1:20140/v1`, a connection on it holding a
   production API key, and an API key for the driver (`/tmp/tp-audit-key`).
4. `OUT_DIR=/tmp/saver-audit-live node tests/qa/saver-audit/live.mjs`.

`live.mjs` patches the test instance's settings per configuration, replays
the session, and records Anthropic's `cache_read_input_tokens` and
`cache_creation_input_tokens` per turn. `thinking-probe.mjs` measures whether
the provider bills a historical thinking block at all.
