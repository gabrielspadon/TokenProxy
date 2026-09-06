# SSE framing ownership

The Responses stream collector and first-content peek use `createSseDecoder`
from `open-sse/utils/sseDecoder.js`. It delegates incremental line and event
framing to exactly `eventsource-parser@3.1.1`. Provider payload interpretation,
usage accounting, terminal classification and transport ownership stay with
the existing callers.

## Runtime and dependency choice

The parser comparison used the previously advertised Node `>=20.9.0` floor.
The application now requires `>=20.18.1`, matching its existing Undici 7
transport dependency. Parser-only qualification on 20.9.0 does not qualify that
unsupported application runtime. Version 3.1.1 declares Node `>=18.0.0`
and has no runtime dependencies. Version 4 requires Node `>=22.12`, so adopting
it would narrow the project's runtime contract. The upstream release record
shows 3.1.1 on 2026-08-10; this pin does not imply a guarantee of future
maintenance of the 3.x branch. Reassess it when the project raises its runtime
floor or upstream publishes a relevant fix.

Primary sources, checked 2026-09-06:

- [Versioned package manifest](https://raw.githubusercontent.com/rexxars/eventsource-parser/v3.1.1/package.json)
- [Versioned parser implementation](https://github.com/rexxars/eventsource-parser/blob/v3.1.1/src/parse.ts)
- [Upstream release history](https://github.com/rexxars/eventsource-parser/releases)
- [HTML event-stream parsing standard](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)

## Preserved contracts and corrected framing

- UTF-8 decoding is incremental, including split code points. CR, LF and CRLF
  delimiters and multiple `data` fields follow SSE framing rules. Previously
  the Responses collector split only on `\n\n` and read only its first `data`
  field, losing otherwise valid CRLF and multiline payloads.
- Comments, `id` and `retry` fields cannot become provider content. This decoder
  performs no reconnect, request, retry, fetch or provider call.
- The peek replays the original byte chunks without reserialization. Its
  progress, keepalive and provider-error predicates are preserved. One parsed
  JSON object now feeds both progress and error checks.
- The collector preserves item indices, opaque reasoning content, tool argument
  strings, terminal state and cache/usage fields. It still accepts a complete
  JSON event at EOF without a final blank delimiter. `finish()` deliberately
  supplies that delimiter; malformed JSON is not repaired or made terminal.
  This EOF tolerance is a compatibility policy, not standard EventSource EOF
  behavior.
- Callbacks are synchronous. There is no additional event queue or reader.
  The peek forwards cancellation and waits for upstream acknowledgement, then
  releases its reader. Normal EOF and read errors release it as well. An
  externally supplied collector reader remains owned by the outer deadline
  and abort controller.

## Bounds that remain with callers

The peek retains its existing 256 KiB aggregate byte threshold and fallback
to replay. It is a soft inspection threshold; one already received source
chunk can exceed it. The Responses collector still accumulates the complete
nonstreaming response. Neither boundary is newly advertised as a hard memory
limit. The library's optional `maxBufferSize` measures pending characters and
does not count every comment, event-name or ID byte, so it cannot replace an
existing wire-byte policy.

The following native framing remains deliberately scoped outside this change:

- `streamTerminal.js` retains its 64 KiB wire-record and 128 data-line limits,
  discard-and-recover policy and byte-preserving observation.
- `antigravitySseValidation.js` retains its 64 KiB raw validation-frame cap.
- `claudeClassifier.js` retains its distinction between an explicitly empty
  `event` field and a missing field. The dependency normalizes both to an
  absent event name; using it here would weaken ambiguity rejection.
- `stream.js` and specialized executors retain their payload translation,
  comment/event emission, binary and NDJSON contracts. This adoption is not a
  claim that every provider transport has been consolidated.

## Reproduction and evidence scope

Run tests with an explicit scratch `DATA_DIR` and `tests/vitest.config.js`.
`tests/unit/sse-framing-adoption.test.js` exercises fragmentation, delimiter
variants, multiline data, metadata, EOF/truncation, opaque content, ordering,
cache usage, soft-cap replay, slow consumption and caller abort.
`tests/unit/stream-content-reader-lifetime.test.js` proves EOF release and
awaited cancellation. Retained terminal, classifier, deadline, error-content
and Antigravity/Gemini framing suites exercise adjacent policies.

`tests/qa/sse-framing-runtime.mjs` qualifies the actual helper and dependency
across fragment sizes 1 through 128. It does not qualify the entire application
build on an older runtime. `tests/qa/sse-framing-benchmark.mjs` compares the
corrected native baseline `8f062c6b` with the candidate on equivalent verified
outputs. The baseline includes the same reader-lifetime fix, isolating parser
adoption from correctness-repair overhead. Both arms load historic source to
equalize command setup. Inner-loop latency and requests/s exclude setup;
Hyperfine timings include it. Heap/RSS deltas are end-minus-start samples, not
peak memory measurements. These local synthetic measurements do not establish
whole-gateway performance targets or production throughput.
