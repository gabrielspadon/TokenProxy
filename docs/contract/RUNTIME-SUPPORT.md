# Runtime support

The gateway and CLI require Node 20.18.1 or newer. This reconciles the advertised
minimum with the already selected Undici 7 dependency. Next 16 alone requires
20.9.0, which does not establish support for the complete gateway. The boot guard
rejects older versions before starting listeners.

The package registry inspected on 2026-09-06 reports `undici@7.29.1` requiring
`node >=20.18.1`; `next@16.2.9` and the installed 16.3.4 require `>=20.9.0`.
See [Undici runtime compatibility](https://github.com/nodejs/undici#long-term-support).
The installed dependency versions belong in each build and benchmark receipt.
An engine range is a support requirement, not proof of performance or every
provider protocol on every runtime. Native SQLite qualification is recorded
separately from the sql.js fallback.

This change does not replace the deployed Node 24 runtime. Parser-only tests on
20.9.0 remain useful evidence about that isolated primitive, but cannot certify
the application on a runtime its transport dependency does not support.

The independent test package supports Node 22.22.2, Node 24.15.0 and supported
newer even-numbered releases. Its current jsdom version no longer supports the
old `node >=18` declaration. CI pins Node 24.15.0 and installs all three
committed lockfiles with `npm ci` before running the isolated offline gate.

The CLI runtime accepts a native better-sqlite3 install only after a child
process loads it, opens an in-memory database and executes a query. The ABI
stamp records that validation and the binary SHA-256. An npm exit code or native
file header alone does not establish ABI compatibility.

`tests/unit/node-version-floor-2362.test.js` executes the actual boot guard for
18.20.4, 20.9.0, 20.18.0, 20.18.1 and 24.14.0, and checks both package declarations
against the installed Next and Undici engine requirements.
