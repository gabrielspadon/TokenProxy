# Isolated reliability qualification

This harness launches the actual standalone candidate and canonical admission front. Every request crosses the public front and real gateway before reaching the loopback fixture provider. T07's seed supplies the synthetic connection, API key and isolated settings. No production database, account or service is opened.

Acquire the lead's exclusive heavy-job lease before any started smoke or full run. Use a clean candidate artifact, Node 24, an empty evidence directory outside both executable trees, and the exact committed front SHA. The front source must be clean within `services/tokenproxy`. All outbound gateway/front connections are restricted to owned loopback ports by the existing runtime guard. Cleanup uses T09's captured child and listener identities, never process-name searches.

Compute `artifactTreeSha256()` from `run.mjs` before launching and supply its result explicitly. The function includes file paths, modes and bytes, including dependencies. Symlinks are rejected. The example below shows the complete run interface with operator-supplied identities.

```bash
/absolute/node24 --input-type=module -e \
  'const {artifactTreeSha256} = await import(process.argv[1]); console.log(artifactTreeSha256(process.argv[2]));' \
  /absolute/repo/tests/qa/reliability-soak/run.mjs /absolute/qualified-standalone

/absolute/node24 /absolute/repo/tests/qa/reliability-soak/run.mjs \
  --mode=full \
  --artifacts=/tmp/tokenproxy-soak-unique-empty \
  --standalone-root=/absolute/qualified-standalone \
  --artifact-sha256=<64-hex-tree-digest> \
  --candidate-sha=<40-hex-app-commit> \
  --candidate-version=<served-package-version> \
  --front-root=/absolute/ai-dotfiles-worktree \
  --front-sha=<40-hex-front-commit> \
  --seed-script=/absolute/repo/tests/contracts/capability-gateway-seed.mjs
```

The deterministic phase delivers at least 10,000 requests across JSON success, streaming success, short held streams, cancellation after content, provider rejection, upstream midstream reset, malformed JSON, invalid authentication and unknown selected model. The controlled local provider rejects scenario ambiguity and records dispatches per request ID. Failure in any cell stops new traffic and waits for all started requests before final checks.

The mixed phase runs at least 60 minutes measured with `performance.now()`, with concurrent streams of at least 30 seconds, dashboard analytics and synthetic history produced by actual API traffic. Every five minutes it drains to a quiet front, pauses admission, submits queued clients, stops and restarts only the owned candidate, then resumes within 3.5 seconds. Six successful quiet restarts are required. These same-artifact restarts qualify the admission path; package replacement and rollback remain the separate deployment-driver gate.

RSS and descriptor counts use captured Linux process identities. Raw periodic samples, quiescent samples, slopes per minute, front queue/active/dispatching counts and provider activity remain in `soak-evidence.json`. A positive monotonic quiescent resource backlog fails. The final receipt independently reconciles signed front starts/terminals with imported rows, client identities, logical terminals, physical attempts and durable usage. It checks database integrity, foreign keys, replay, pending state, canary logs and owned cleanup even after failure or an interrupt.

`--mode=smoke` defaults to 18 deterministic requests and 5 seconds of mixed traffic. It always reports full qualification as `not-run`, even if every smoke assertion passes. Its `smokeState` and exit code describe only the smoke. Full qualification requires `state=passed`. Interrupted or incomplete runs never qualify.

For release assembly, bind the raw receipt by SHA256. `metrics.deterministicRequests` feeds the failure-matrix request count. Soak uses `metrics.mixedRequests`, `mixedStartedAt`, `mixedFinishedAt`, monotonic `metrics.mixedElapsedMs`, `metrics.cutovers`, `metrics.backlogSlope` and `metrics.rssSlopeBytesPerMinute`. Named booleans are under `checks`; raw evidence remains authoritative.

Node's [performance measurement contract](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#performancenow) defines the monotonic process clock used here.
