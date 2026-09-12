# Natural observation safety evidence

The deployed candidate must include physical replay evidence, the passive
secret observer, critical transaction acknowledgment receipts, and the front
startup source manifest. Earlier versions remain unobservable. This procedure
does not enable request logging, replay traffic, generate provider requests,
change the database, or restart a service.

The sampler reads the existing front control socket, verifies its private
journal, reads SQLite through its read-only adapter, and captures authenticated
backend safety counters. It signs the resulting scalar evidence with the
private front observation key. Capture refuses a moving front terminal count;
retry a failed sample without stopping traffic. Retain the entire original
begin/end/keyring files in a private evidence directory. The output files must
not already exist.

Use the qualified Node runtime and actual installed driver. The credential file
is mode 0600 and contains only `{"cliToken":"<existing operator CLI token>"}`.
Do not put a credential in a command argument. The status URL must be loopback.
Run the same command at the beginning and end, changing the output filename.
At least 24 hours and 1,000 natural logical inference requests must occur
between `begin.captureEndedAt` and `end.captureStartedAt`.

```bash
node scripts/qa/observe-production.mjs sample \
  --journal /absolute/private/front-journal \
  --keyring /absolute/private/front-auth/keyring.json \
  --database /absolute/installed/db/data.sqlite \
  --driver better-sqlite3 \
  --control-socket /absolute/private/front-control.sock \
  --release-id <offline-release-evidence-sha256> \
  --safety-url http://127.0.0.1:20127 \
  --safety-credential /absolute/private/operator-token.json \
  --output /absolute/private/evidence/begin.json

node scripts/qa/observe-production.mjs assemble \
  --begin /absolute/private/evidence/begin.json \
  --end /absolute/private/evidence/end.json \
  --keyring /absolute/private/evidence/keyring.json \
  --output /absolute/private/evidence/outcomes.json

node scripts/qa/collect-live-safety.mjs \
  /absolute/private/evidence/safety-input.json \
  /absolute/private/evidence/safety
```

`safety-input.json` names the exact committed candidates and hashes the retained
files. `frontRepositoryRoot` must contain the declared committed front source.
Run the collector from the exact candidate application checkout.

```json
{
  "identities": {
    "applicationSha": "<40 hexadecimal characters>",
    "frontSha": "<40 hexadecimal characters>",
    "deploySha": "<40 hexadecimal characters>"
  },
  "frontRepositoryRoot": "/absolute/front/source/checkout",
  "observation": {
    "begin": {"path": "begin.json", "sha256": "<file SHA256>"},
    "end": {"path": "end.json", "sha256": "<file SHA256>"},
    "keyring": {"path": "keyring.json", "sha256": "<file SHA256>"}
  }
}
```

The collector writes four audit files and `safety/closure.json`, using mode
0600 and exclusive creation. Exit 2 means evidence exists but a safety gate is
failed or unobservable. Exit 1 means collection itself failed. Add the hashed
closure reference to the production-observation gate's `safetyClosure` field.
The release assembler authenticates the source snapshots, rederives every
audit, and verifies the candidate source manifests before accepting them.

Replay counts physical dispatch intents conservatively. Each later physical
attempt requires the prior attempt's owned proof of generation nonacceptance.
HTTP 200 streams, transport ambiguity, and accepted-generation provenance do
not become replay permissions. Account retry policy is a separate contract.
The native outcome assembler still requires semantic terminal completion.

Secret scans match literal bytes of configured environment credentials,
provider values already decrypted for normal use, and API keys already read
or created, and the operator CLI credential already derived for authentication.
The observer does not enumerate or decrypt extra credentials.
It holds at most 128 credential values of 8–4096 bytes and 512 stream suffixes
of at most 4095 bytes. Suffixes are wiped on close or trace-slot reuse; neither
suffixes nor credentials are written to receipts. The registry keeps removed
credentials for the process lifetime, with that retention scope in the receipt.
Inventory caps, unsupported credentials/chunks, observer errors, changing
environment credentials, and enabled unobserved OTLP exports prevent passing.
Counters cover attempted sink writes, a conservative superset when a write
throws. Successful operator key creation, explicit key reveal, and key rotation
mark only their exact returned credential through an async request context.
The exact successful response body can classify that match as an authorized
delivery; headers, other credentials, other responses, logs, exceptions and
failed requests receive no exemption. Authorized match counters remain in the
audit. Token-looking user-authored text alone is not a known credential match.
Compressed wire bodies and encoded or transformed credentials fall outside
literal byte coverage. The result exports `allCredentialsCleanClaim: false`
and `allEncodingsCovered: false`; it cannot establish a wider clean-sinks claim.

Critical write reconciliation compares every retained eligible marker against
the immutable end-of-window database chain, including historical receipts.
Receipt loss, missing markers, unresolved intents, or omitted runtime attempts
remain failures. Ordinary request-history backlog and stale pending rows are
not proof of lost acknowledged mutations. The front audit covers all admission
evictions, a stronger requirement than deployment evictions alone, and matches
the counter delta against authenticated terminal records.
