# Stage measurement reuse

The gateway keeps every signed byte-stage row but reuses the predecessor size
when a stage did not run. Potentially mutating stages still measure their result.
The tools boundary supplies the initial size and the final serialization supplies
the last size. This removes redundant measurements without changing stage order.

## Reproducible kernel measurement

Measured on 2026-09-06, Apple M4 Max, arm64, Node 26.8.1, using Hyperfine with
3 warm-ups and 12 samples per command. The benchmark extracts the actual stage
closure from each source snapshot. Commands include process startup, fixture
construction and assertions. Other validation work ran concurrently on this host.

Baseline revision is `1d16c1086a6e0b5cb8e44b7ba4889e4a12bc9a2c`.
Baseline chatCore SHA-256 is `e707a16b236266522a4ca4e9ab2040c14a621436014e996b7181b3293e740d77`.
Candidate chatCore SHA-256 is `0d0330c080f220513c5a358afb104ff23aa19b6c693bd5e3757e35b22ef95e7a`.

| Body | Enabled stages | Operations | Before ms | After ms |
| --- | ---: | ---: | ---: | ---: |
| 32 KiB | 0 | 500 | 174.82 ± 2.00 | 50.83 ± 1.07 |
| 1 MiB | 0 | 50 | 480.45 ± 6.58 | 93.34 ± 1.33 |
| 1 MiB | 11 | 50 | 478.69 ± 3.58 | 419.92 ± 4.11 |
| 4 MiB | 0 | 15 | 553.22 ± 3.06 | 105.12 ± 1.04 |

Values are mean command duration and sample standard deviation, not request
latency quantiles. Bodies contain repeated Unicode fixture text and are unchanged
by the measured closure. Enabled stages model measurement cost, not transform
execution. Every operation verifies twelve ordered rows, exact byte sizes and
zero signed deltas. Baseline and candidate produce identical ledger digests.

Run `node tests/qa/stage-measurement-benchmark.mjs SOURCE_PATH KIB OPERATIONS ENABLED`
for each source snapshot under `hyperfine --warmup 3 --runs 12`. For the 1 MiB
disabled fixture the exact serialized body is 1,048,661 bytes and the ledger
SHA-256 is `116d096de8c4bfd4e56a7b77aedcb1a31d798ccd3943eb564b729930d074ebae`.

## Correctness and limits

The real chat-core regression checks disabled rows, final serialization size,
signed-delta reconciliation and unchanged Unicode content. The production-order
matrix also passed 16,384 subsets for each of the native, pressure-safe and
explicitly lossy pressure fixtures, 49,152 cases in total, with no provider calls.
This is exhaustive subset selection for those fixtures, not every possible
content-dependent branch or permutation. HTTP, streaming, persistence, CPU
utilization, memory per active stream, token cost and production Node 24 latency
remain separate acceptance measurements. These kernel results do not establish
the gateway latency targets or a cost reduction.
