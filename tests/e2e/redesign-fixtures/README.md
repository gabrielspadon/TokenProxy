# Isolated redesign fixtures

These tools are never imported by application source. Run them explicitly with Node 22.18 or newer (the launcher uses `node:sqlite` and Node's ESM syntax detection); the application's own runtime floor remains unchanged.

For visual iterations use `node scripts/redesign-preview.mjs start --mode dev --scenario representative`. The custom webpack dev server reads current source and writes its complete Next cache inside the owned temporary root. A root-local symlink resolves the existing installed dependencies; shared `.next` is untouched. HMR uses only the selected loopback origin. Next's optional npm update check is suppressed in this tooling with installed-version metadata and freshness explicitly unknown. Private environment files remain invisible to the watcher. No production application code changes its behavior to enable this mode.

Dynamic dev routes compile using Next's worker-thread mode, configured only in this process's cached config object. Worker threads inherit the isolation preload; subprocesses remain forbidden. To preserve a URL during an owned restart, first stop that run normally, then use `start --mode dev --port PORT --run ROOT`; the selected port must actually be available. Never restart a preview owned by another lane.

Freeze application and fixture source, finish current tests, and acquire exclusive ownership of shared `.next` before a production build. `node scripts/redesign-preview.mjs build-check` verifies macOS sandbox network denial without compiling. `node scripts/redesign-preview.mjs build` runs the repository's `npm run build` recipe inside that OS sandbox with disposable HOME/DATA_DIR and synthetic authentication. It refuses implicit project environment files, records source manifests before and after compilation, rejects source drift, and returns a private log and build-receipt path. There is no unguarded fallback. A Codex filesystem sandbox may require an escalated tool invocation so sandbox-exec can install the stricter process-family network policy. A per-project temporary lock prevents two instances of this wrapper; other build tools must still coordinate. No build begins automatically from preview startup.

Use the returned build receipt and its returned `dist` with a fresh seed and start. The wrapper retains a complete standalone copy under its owned build root, dereferences dependency symlinks and hashes every artifact file. This keeps later shared `.next` builds from invalidating the running preview. The launcher verifies its BUILD_ID matches the selected artifact and preserves the assets copied by the production postbuild recipe. Build success remains separate from browser acceptance.

```sh
node scripts/redesign-preview.mjs build-check
node scripts/redesign-preview.mjs build
node scripts/redesign-preview.mjs start --mode production --scenario representative --dist /absolute/returned/build-root/artifact --build-receipt /absolute/returned/build-receipt.json
```

```sh
node scripts/redesign-preview.mjs start --scenario populated --dist .next --build-receipt ../implementation-evidence/operator-20260907/build-receipt.json
node scripts/redesign-preview.mjs status --run /absolute/returned/root
node scripts/redesign-preview.mjs stop --run /absolute/returned/root
node scripts/redesign-preview.mjs catalog
node scripts/redesign-preview.mjs start --scenario edge-cases --dist .next --build-receipt /absolute/current/build-receipt.json
```

Every start without `--run` seeds a fresh mode-700 temporary root, a disposable database, and private random authentication values. The default `populated` scenario has four credentialless disabled accounts; `empty` and `single` have zero and one. `seed --scenario populated` prepares without starting; use its returned root with `start --run`. No launcher command deletes a directory or signals a PID read from disk. Stop challenges the server using its private ownership token, then asks that server to exit itself and verifies the ownership endpoint closed. An occupied selected port fails startup rather than displacing its owner.

After an unexpected crash, preserve its logs and use `recover-stopped --run ROOT`. This only clears the stale lifecycle receipt after a signal-zero check proves the recorded PID absent and a loopback bind proves its port available. It sends no termination signal. A reused PID or occupied port refuses recovery. The guard audits fixture credentials once before application DB startup; worker preloads retain network and mutation isolation without reopening the live WAL through a second SQLite implementation.

`representative` includes all edge fixtures plus 12 accounts across six provider identities. Eight are enabled as a local policy, with no usable credentials and no fabricated qualification or entitlement. It adds 48 exactly linked request/context/usage/cost histories and 36 synthetic quota observations, retaining fresh, stale, unknown and exhausted states independently. `verify-preview.mjs ROOT` authenticates normally and verifies real provider, health, quota, model, context and analytics handlers; its receipt is separate from rendered acceptance.

The guard preloads only in the created preview. It blocks all server outbound fetch, TCP, TLS, UDP, HTTP, DNS, child processes and non-owned process signals; restricts listeners to the chosen loopback port; masks inherited secrets; blocks credential discovery in the real home; disables bootstrap/catalog jobs; and seeds live service schedulers disabled. The supported `TOKENPROXY_NO_UPDATE=1` environment setting disables automatic package-registry checks; published-version freshness stays unknown. Unexpected provider requests fail, including inference URL aliases. The guard restricts mutations to existing local fixture workflows and reports rejection counts through `status`. A rejected provider operation is a blocked check, never a successful provider test.

Local shaping controls/plans/runtime settings, pricing overrides/resets, budget reconciliation, declarative custom adapters, proxy-pool removal and account policy updates can use their existing handlers. The guard rejects provider credential fields and quota-warming/free-model scheduler settings before their JSON handlers write. OAuth, import, probe, model discovery, deployment and inference remain blocked. The `edge-cases` scenario adds the disabled `redesign-budget-key` and exact `redesign-budget-reserved` / `redesign-budget-uncertain` reservations with a retained rate snapshot and matching physical-attempt identity. The seed receipt contains their IDs, never a usable credential.

Production server and retained records use `2026-09-07T12:00:00.000Z`. Each browser document starts at that immutable UTC anchor and advances using monotonic performance time, allowing real animation progress. Timers remain real. Development keeps compiler and browser clocks real because freezing Date breaks webpack invalidation after source changes. Dev seed timestamps shift together to one recorded UTC-minute anchor, preserving stable identities and relative observation ages. Freshness then ages truthfully until a fresh run is seeded. Lifecycle timestamps remain real UTC. Authentication must still succeed normally for admin projections. Never print or copy `preview-auth.json` into captures, exports, logs or version control.

```js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authenticateRedesign, installRedesignBrowser } from './tests/e2e/redesign-fixtures/browser.mjs';
const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce' });
await authenticateRedesign(context, runRoot);
const page = await context.newPage();
const runtimeReceipt = JSON.parse(await readFile(join(runRoot, 'process.json'), 'utf8'));
const fixture = await installRedesignBrowser(page, { baseUrl, runtimeReceipt });
await page.goto(`${baseUrl}/dashboard`);
// Perform the journey and inspect its screenshot; assert fixture.outboundFailures is empty.
```

`operator: true` reuses the existing operator presentation mocks. That mode has its original `2026-09-06T14:30:00.000Z` clock and is deliberately marked nonpersistent. Do not use it to claim saved-state evidence. For API persistence checks use the default retained-schema scenario and real application projections.

`runtimeReceipt` attributes the server fixture version to the immutable process receipt. `browserFixtureVersion` identifies the currently imported helper independently. Without a runtime receipt the server fixture version is unknown; never substitute the helper version for it.

Create a new browser context after changing clock mode. The helper anchors advancing browser time only for a known production receipt or explicit operator presentation mock; unknown and development runtimes keep real browser time. The returned `clock` remains the seed anchor, while `browserClock` describes the advancing policy. Always pass the receipt to label the current seed anchor and version correctly. Absolute retained API intervals stay governed by the fixed production server clock; a browser clock is never a new retained observation timestamp.

The example requests reduced motion before navigation and does not establish animated behavior. Capture a separate context with `reducedMotion: 'no-preference'` to verify production animation. Both use the anchored advancing clock. A completely frozen browser Date previously held ECharts sparse symbols at their initial size, including animations queued before the reduced-motion hook updated.

`edge-cases` preserves the populated baseline and adds six-account identity coverage, a neutral custom provider, exhausted quota, expired credential state, failed shaping telemetry, aborted history, zero-usage exclusion, an expired session pin/preview and bound/free proxy pools. Its concurrent counters are explicitly synthetic process state loaded only by the guard; no dispatch or lease is created. Delete both pool IDs through the UI to test a retained partial result. Reconcile the uncertain budget reservation with `provider-usage`, a synthetic evidence reference and tokens `{input_tokens:80,output_tokens:20,cached_tokens:0,cache_creation_input_tokens:0,reasoning_tokens:0,cost_usd:0.00024}`. Release the reserved row with `proven-no-dispatch` and a synthetic reference. These are deliberate operator statements about synthetic evidence.

The browser helper also accepts one `fault` from `broken-logo`, `version-conflict`, `interrupted-activation`, or `stream-interruption`, declared in `BROWSER_FAULTS`. Each is nonpersistent fault evidence. The first returns a local asset 404. The second refuses a draft PATCH with the handler's conflict shape. Interrupted activation permits an explicit local handler to finish, then loses its response; inspect the retained receipt before retrying. Stream interruption creates synthetic events and a reader error only when the chat request is explicitly submitted, without sending to the gateway. No fault runs on page mount. A terminal aborted history row is not evidence that a browser stream was interrupted.

After saving a screenshot, `capture --run ROOT --route /dashboard --viewport 1440x900 --file /absolute/capture.png` writes its SHA-256, route, viewport, fixture clock/version, run/build ID, and source attribution to an adjacent JSON receipt. It does not inspect the image and records `imageInspected:false`. Caller inspection and browser assertions are separate evidence. A supplied build receipt retains the successful build's revision/hash separately from the seed-time source manifest; without that receipt the tool explicitly cannot attribute the running assets to the current source. Use capture metadata from the browser helper when using operator mocks, whose clock/version differs.

The versioned catalog lists seeded states, fault mechanics and remaining limitations. Availability of a fixture does not claim that a browser journey passed. Completed OAuth, real upstream validation, actual concurrent dispatch and complete UX acceptance remain outside this harness. Saved investigations and local policy controls require browser verification through write, reload and readback. No profiling, benchmark, or upstream inference is involved.

```sh
npm --prefix tests test -- e2e/redesign-fixtures/fixtures.test.js
./node_modules/.bin/eslint scripts/redesign-preview.mjs tests/e2e/redesign-fixtures/
node tests/e2e/redesign-fixtures/verify-edge.mjs /absolute/fresh/edge/run
node tests/e2e/redesign-fixtures/verify-preview.mjs /absolute/owned/run
```

`verify-edge.mjs` deliberately consumes a fresh owned edge fixture, authenticates normally, settles and releases the two reservations, deletes the free pool while retaining the bound one, checks readback, and verifies scheduler writes are refused. It writes a secret-free `edge-verification.json` in that run. This verifies local handlers and persistence, separately from browser inspection. Provider account enablement can be tested with the existing local PUT on a synthetic account; credentialless enabled accounts must retain unknown/unvalidated health, and all upstream calls still fail in the guard.
