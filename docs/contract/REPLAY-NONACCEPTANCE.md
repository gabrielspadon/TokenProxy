# Rejection, cancellation and request continuity

A generation error authorizes another physical request only when the current
response proves nonacceptance. Both `x-tokenproxy-replay-safe: false` and
`x-should-retry: false` veto replay. A successful status never authorizes retry.
Ordinary HTTP request/authentication/payment/shape/rate rejections
(400,401,402,403,404,405,413,415,422,429) are nonacceptance boundaries. An explicit
true replay permission can qualify another error response. Plain5xx,408,409
and transport errors remain uncertain. Adapters that synthesize an error after
acceptance must attach explicit false provenance.

Base executor retries and URL fallback share the same classifier as the chat
coordinator and budget observation. A provider Retry-After deadline returns to
the coordinator intact. Discarded bodies are cancelled before retry delay;
delays and diagnostic reads honor caller cancellation. Native error diagnostics
retain at most16KiB and wait at most1second. Incomplete content stays unknown.
An earlier diagnostic substituted for a complete empty final body carries
`x-tokenproxy-error-body-source: previous-rejected-attempt`; it does not replace
the final response's replay permission or accounting identity.

Authentication and field-removal retries obey both veto headers. A field-removal
retry owns the final response, status, reset, exact physical body and usage
attempt. Another field-removal attempt is not recursively dispatched. Missing
outcome evidence keeps outstanding budget exposure held. A proven rejection
releases only that exact attempt's reservation before an allowed retry.

Pool capacity/closing/cleanup errors carry an internal WeakSet proof only until
a transport has actually been invoked. The proof permits a durable automatic
no-dispatch reservation receipt. Arbitrary status503 objects and revoked proofs
cannot release exposure. Local admission returns without benching an account or
rotating its pin. A capacity503 can ask the client to retry after one second;
the gateway does not loop through accounts for its own local pressure.

The primary replay suite passed171tests across17files, including all49,152
transformation subsets after restoring the unchanged boundary-note stage.
Additional Antigravity retry/cancellation coverage passed36tests across3files.
The final field-removal, budget, coordinator, Base and Antigravity run passed
94tests across7files. It proves400-to401/429/503 replacement, current reset
information, exact body cleanup and released versus uncertain exposure.
Changed-source ESLint passed. Full integrated qualification remains pending.
All providers are mocked.
