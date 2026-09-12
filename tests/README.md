# TokenProxy test suite

This is an independent ESM package with its own committed lockfile. The
canonical offline gate runs on Node 24.15.0 and creates a fresh home, temporary
directory and data directory for every invocation.

## Reproducible install

Use the same Node binary for installation and execution. Putting its directory
first on `PATH` matters because npm's launcher resolves `node` through `PATH`.

```bash
export PATH=/path/to/node-v24.15.0/bin:$PATH
npm ci --no-audit --no-fund
(cd tests && npm ci --no-audit --no-fund)
(cd cli && DATA_DIR="$(mktemp -d)" npm ci --no-audit --no-fund)
```

The gateway and CLI retain their Node 20.18.1 minimum. The test package supports
Node 22.22.2, Node 24.15.0 and supported newer even-numbered runtimes because its
current jsdom dependency does not support the former Node 18 declaration.

## Canonical offline gate

The artifact directory must be absent or empty. The runner refuses live-test
flags and inherited provider or proxy credentials, uses the repository-local
Vitest binary with the explicit config, caps workers at four, preserves the raw
runner exit and invokes the single regression verifier.

```bash
node scripts/qa/run-offline-tests.mjs \
  --artifacts /tmp/tokenproxy-qualification/full

node scripts/qa/run-offline-tests.mjs \
  --artifacts /tmp/tokenproxy-qualification/targeted -- \
  unit/capabilities.test.js
```

`tests/__baseline__/verify-no-regression.mjs` validates the JSON report, runner
exit, file and assertion inventory, suite-level errors and snapshot state. The
committed baseline currently has no accepted failures. Any future exception
must name an external prerequisite and expiry date. A passing or expired
exception fails the gate until it is removed.

Every skipped assertion is listed by exact identity with its qualification
state, owner, prerequisite and review date. A new, stale or expired skip
classification fails the gate.

After an intentional test addition, rename or removal, regenerate the reviewed
inventory from a complete JSON report with
`node scripts/qa/write-test-manifest.mjs report.json --output tests/__baseline__/test-manifest.json`.

Direct Vitest use is for diagnosis only and must carry the explicit config,
test mode and an isolated data directory.

```bash
DATA_DIR="$(mktemp -d)" NODE_ENV=test \
  node tests/node_modules/vitest/vitest.mjs run \
  --config tests/vitest.config.js --maxWorkers=1 \
  unit/capabilities.test.js
```

## Layout

- `unit/` contains handler, persistence, UI model and process tests.
- `translator/` contains format translation and golden contracts.
- `translator/real/` contains paid provider probes that remain inert offline.
- `auth/` contains SAML tests.
- `e2e/` contains separate Playwright programs.
- `fixtures/` contains synthetic recorded inputs and negative gate reports.
- `qa/` contains explicit qualification programs outside the unit gate.
- `__baseline__/` contains reviewed inventories and canonical verifiers.

Provider registry, alias and OAuth baselines remain separate byte-level
contracts and run after the offline suite in CI.
