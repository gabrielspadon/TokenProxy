# Production outcome observation

Start the window only after the approved paired front and gateway release is installed and verified. This tool performs no inference requests, configuration changes, or database writes. It samples the private front control socket, verifies the signed front journal, reads selected statistics columns through the read-only analytics adapter, and signs the snapshot with the retained front keyring. The release identifier is the SHA-256 of the approved release evidence artifact.

Integrate `REQUEST_TERMINAL_COLUMNS` from `src/lib/db/terminalEvidence.js` into the `requestStats` schema before starting the candidate. These four nullable columns expand the existing table. The migration owner must register, migrate, reopen and rollback-test the expansion. Existing rows without terminal evidence stay unknown. The signed journal retains schema version 2 and adds `observationVersion=1`, `requestClass` and `terminalReason`.

Managed chat ingress records one logical lifecycle before admission and echoes its server-owned identity on early refusals and final responses. The finalizer waits for body completion and pending statistics writes, then joins ordered attempts to semantic terminal evidence. Multiple successful attempts, missing evidence and unsupported output remain unknown. Caller cancellation and transport interruption settle pending attempt rows without inventing provider completion. Restart reconciliation changes only clocks whose recorded host, boot and process start identity prove the previous owner dead; unknown or live ownership remains pending.

Backend timing uses one process's monotonic clock. Response-header and stream envelope spans partition the logical duration. Admission, selection, preparation and executor dispatch spans overlap that envelope and must not be summed with it. No backend retry-wait value is inferred from timestamps. Context stage guards measure actual execution and bypass checks, retain the source execution identity across retries, and export their persisted duration. Historical stages retain a null duration and an unknown source.

Use an existing private evidence directory. Set `TP_RELEASE_ID` to the actual approved release artifact hash, never a placeholder. Verify the installed writer adapter and pass that exact driver. The example uses the deployed native `better-sqlite3` adapter. Outputs use exclusive creation and mode 0600; choose a fresh filename for every sample.

```bash
/home/spadon/.local/share/mise/installs/node/24.15.0/bin/node \
  /home/spadon/Codebases/tokenproxy/scripts/qa/observe-production.mjs sample \
  --journal /home/spadon/.tokenproxy/front-telemetry \
  --keyring /home/spadon/.tokenproxy/front-telemetry-auth/keyring.json \
  --database /home/spadon/.tokenproxy/db/data.sqlite \
  --driver better-sqlite3 \
  --control-socket /home/spadon/.tokenproxy-front/front-control.sock \
  --release-id "$TP_RELEASE_ID" \
  --output /home/spadon/.tokenproxy-private-previews/observation/begin.json
```

Repeat the same `sample` command at least 24 hours later with `--output /home/spadon/.tokenproxy-private-previews/observation/end.json`. Capture again under a fresh name if fewer than 1,000 natural inference requests arrived. A changed counter during capture, a partial journal write, an unhealthy journal, missing schema or a missing key rejects the sample. Retry without pausing traffic. A front restart or gateway build change invalidates this window; establish a new baseline after investigation.

```bash
/home/spadon/.local/share/mise/installs/node/24.15.0/bin/node \
  /home/spadon/Codebases/tokenproxy/scripts/qa/observe-production.mjs assemble \
  --begin /home/spadon/.tokenproxy-private-previews/observation/begin.json \
  --end /home/spadon/.tokenproxy-private-previews/observation/end.json \
  --keyring /home/spadon/.tokenproxy/front-telemetry-auth/keyring.json \
  --output /home/spadon/.tokenproxy-private-previews/observation/result.json
```

Assembly exits 0 only when the outcome gate passes, 2 for a valid but insufficient or failed observation, and 1 for invalid evidence. The result reports all exclusions and every unresolved inference identity. The 24-hour interval uses the same front process's monotonic clock, from the end of the first capture through the start of the final capture. Wall-clock drift exceeding one second rejects the cohort boundaries. The cohort contains inference requests starting within that interval. Pending and interrupted requests remain unknown. Dashboard, discovery and health traffic never increase the 1,000-request denominator; trusted test/import origins are reported separately. Requests rejected before backend identity assignment still contribute one logical front outcome.

One signed front ingress maps to at most one server-owned logical identity. Backend rows must have unique request IDs and contiguous attempt ordinals. An earlier successful or pending attempt makes the logical result ambiguous. The final attempt must carry allowlisted semantic terminal evidence; HTTP status alone cannot qualify a stream. An HTTP 200 `response.failed` or `response.incomplete` frame is a provider failure when observed in provider bytes. Caller cancellation is classified from the signed front event. Admission timeout and backend unavailability are proxy failures. Other unmatched failures remain unknown and block the gate.

Exact terminal evidence covers OpenAI Chat Completions, Anthropic Messages and OpenAI Responses in SSE and parsed JSON, including forced SSE conversion. Native fetched HTTP rejections carry provider attribution. Synthetic executor HTTP responses, unsupported formats, unreadable bodies and interrupted streams lacking attributable evidence remain unknown until their owning producer records reviewed terminal evidence. Unknown outcomes emit REQ.unknown and never clear account health or verification state. This is an explicit qualification gap, never a successful observation. The result cannot claim the whole release complete; unsafe replay, secret exposure, acknowledged data loss and deployment eviction require their separate retained evidence. The release assembler must bind those gates and the observed installed build to the same release artifact.

The reader bounds each journal segment to 16 MiB, each record to 8 KiB, the journal snapshot to 256 MiB and the backend snapshot to 100,000 attempts. Exceeding a bound rejects the sample and requires a reviewed incremental collection policy. No automatic retention or history deletion runs.
