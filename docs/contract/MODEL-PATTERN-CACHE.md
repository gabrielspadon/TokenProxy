# Compiled model-policy expressions

The shared matcher used by pricing, capabilities and thinking-level policy now
retains at most256 compiled regular expressions. Entries are keyed by the exact
policy pattern; model names, credentials and request content are never cached.
Case-insensitive wildcard semantics, escaped literals and ordered pricing
fallback remain unchanged. Native RegExp owns matching. FIFO eviction bounds
memory without adding an external cache or a per-hit mutation.

The change removes repeated RegExp construction from hot lookups identified in
the controlled gateway CPU profile. Six focused suites passed46tests, including
pattern reuse, eviction, literal escaping, changed policies and model identity.
Changed-source ESLint passed.

Reproduce the isolated kernel measurement with
`node tests/qa/model-pattern-benchmark.mjs f192fa17`.
Source8772cb96 on Node26.8.1, AppleM4Max, measured seven alternating pairs of
20,000 calls after10,000 warm-up calls per arm. Median time was6.966ms before and
0.601ms after, an11.59-fold kernel difference, with identical results in each
pair. The private raw receipt is implementation-evidence/pattern-cache-benchmark.json
in the parent workspace. Other work was active on this shared host. This is
neither a gateway latency result nor acceptance of the full performance targets.
