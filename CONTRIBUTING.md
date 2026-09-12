# Contributing

TokenProxy is an OpenAI-compatible routing gateway with a Next.js dashboard.

Read [`open-sse/AGENTS.md`](open-sse/AGENTS.md) before changing anything under
`open-sse/`. It describes the routing and translation engine's conventions and
saves re-deriving them from the code.

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/` | Next.js app, dashboard UI, dashboard and compatibility APIs |
| `open-sse/` | Provider-agnostic routing and translation engine |
| `cli/` | The `tokenproxy` npm launcher, a separate package with its own version |
| `tests/` | Vitest suite, an independent ESM package |
| `scripts/` | Build, deploy and verification helpers |

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

The dashboard serves at `/dashboard` and the gateway at `/v1`.

Mind the port, because three defaults disagree and only one of them reads
`PORT`.

- `npm run dev` and `npm run start` both pass `--port 20127` on the command
  line. From a checkout that flag wins, so they listen on **20127** and `PORT`
  in your `.env` is ignored. `npm run start` from a checkout finds no `server.js`
  beside `custom-server.js` and forwards its arguments to `next start`.
- A standalone build reads `PORT`. `npm run build` writes
  `.next/standalone/custom-server.js` next to a generated `server.js`, and
  running that file directly honours `PORT` and `HOSTNAME`. This is the path
  `scripts/dev-test-server.sh` uses to reach port 20129.
- The packaged CLI, the `Dockerfile` and `docker-compose.yml` all default to
  **20128**, which is the port the documentation and most client configurations
  assume.

Set `BASE_URL` and `NEXT_PUBLIC_BASE_URL` to the port you are actually on, or
OAuth callbacks and cloud sync will point at a different one.

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 node .next/standalone/custom-server.js
```

Run `npm install` at the repository root before anything else, including the
test suite, because the tests import from `src/` and `open-sse/`.

No lockfile is committed. `package-lock.json` is listed in `.gitignore`, so
`npm ci` cannot resolve a tree here and `npm install` is the install command
everywhere, including CI.

`better-sqlite3` sits in `optionalDependencies` on purpose. Install succeeds on
machines without build tools, and the SQLite layer falls back through
`node:sqlite` to the pure-JavaScript `sql.js` driver at runtime.

## Branching and pull requests

Branch off `main`. Open the pull request as a **draft** and mark it ready for
review only once the branch is settled. A draft signals that the branch is still
moving and keeps reviewers from spending attention on a moving target.

Batch your edits and push once per CI cycle. Every push starts a fresh run, and
a run started while another is in flight discards the earlier one.

A pull request is owned until it is green. If a check fails, fix it on the
branch rather than disabling the check.

## Commit messages

Conventional Commits, in the form `type(scope): subject`.

Types used in this repository are `fix`, `feat`, `docs`, `chore`, `test`,
`refactor`, `perf`, `ci`, `style`, `build` and `security`. Scopes are the area
touched, for example `translator`, `providers`, `claude`, `codex`, `usage`,
`auth`, `executors`, `cli`, `security`.

```
fix(translator): keep tool_result ids stable across the claude pivot
feat(providers): add Alibaba Token Plan for the Singapore region
docs: describe the baseline test gate
```

Write the subject in the imperative mood, 80 characters or fewer, describing
one logical change. Detail belongs in the body. A subject reading "fix X and
also Y" is two commits. Do not add trailers naming a tool or a co-author.

## Lint

```bash
npx eslint .
```

Must exit clean. The configuration is `eslint.config.mjs`, which extends
`eslint-config-next` core web vitals. Do not silence a rule to make a check
pass; fix the code or argue the rule change on its own merits in its own commit.

## Tests

`tests/` is an independent ESM package with its own `package.json` and lockfile.
Use the same Node 24.15.0 binary for installation and execution.

```bash
npm ci --no-audit --no-fund
(cd tests && npm ci --no-audit --no-fund)
(cd cli && DATA_DIR="$(mktemp -d)" npm ci --no-audit --no-fund)
```

The root and tests-package `npm test` scripts both invoke the canonical runner.

Live provider tests under `tests/translator/real/` stay inert unless you opt in.
The `.real.test.js` files are gated behind `RUN_REAL=1` and
`nvidia-thinking.e2e.test.js` behind `RUN_E2E=1`, both defaulting to
`describe.skip`. Leave them inert unless you are deliberately testing against
real upstreams with your own credentials, and note that they cost money.

### The offline regression gate

The suite, its exact assertion inventory and every suite-level outcome must be
green. The runner creates isolated home, temporary and data paths, removes
inherited provider credentials and uses a verified network boundary.

```bash
node scripts/qa/run-offline-tests.mjs \
  --artifacts /tmp/tokenproxy-qualification/full
```

That is exactly what CI runs. Evidence under the requested artifact directory
contains the raw runner exit, JSON report, canonical gate verdict, environment
boundary and Git SHA.

Quote the command, not a number. Pass and fail counts move with every provider
addition and go stale in days.

Collection, import, setup, snapshot teardown, removed files and removed
assertions are gate failures even when Vitest records zero failed assertions.
Update `tests/__baseline__/test-manifest.json` in the same reviewed change as an
intentional test addition, rename or removal. Never rebuild a dependency tree
under another Node version. Run a clean `npm ci` with the executing runtime.

### Snapshot baselines

Three further checks compare the live provider registry against committed
snapshots. Each takes no arguments and exits nonzero on any drift. Run them
after touching the provider registry, the alias logic, or OAuth endpoints.

```bash
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
```

## Verifying a change before it reaches a running instance

A running TokenProxy is frequently the upstream for the machine's own AI tooling,
so a broken build cuts the connection that would let you fix it. Verify on an
isolated instance first.

```bash
scripts/dev-test-server.sh up     # build, then start on :20129
node scripts/smoke-test.mjs       # exercise the running instance
scripts/dev-test-server.sh down   # stop it
```

`dev-test-server.sh up` runs `npm run build`, starts
`.next/standalone/custom-server.js` on port 20129 bound to `127.0.0.1` with
a newly allocated mode-0700 `HOME` and `DATA_DIR`, and polls `/dashboard` with
bounded `curl -q` deadlines. Build and server processes receive an allowlisted
test environment. PID, process start time, command, working directory and
listening socket must all match before the helper accepts health or sends a
signal. `SKIP_BUILD=1` reuses an existing `.next`. Credential cloning requires
`ALLOW_CREDENTIAL_CLONE=1` and explicit source and target paths under the test
state root. Run `sync` and then `up-clone`; normal `up` always creates fresh
state.

`smoke-test.mjs` checks that the dashboard page loads, that dashboard login
returns a session cookie, that `/api/usage/statistics` returns its documented
shape, and that `/v1/models` answers 401 or 200 rather than hanging or 5xx. It
makes no upstream provider calls and costs nothing. Point it elsewhere with
`SMOKE_BASE`. It exits nonzero on any failed check.

## Adding a provider

Read `open-sse/AGENTS.md` first. In short, copy
`open-sse/providers/REGISTRY_TEMPLATE.js` into `open-sse/providers/registry/`,
add the models to `open-sse/config/providerModels.js`, and regenerate the
registry index with the scripts named in that document rather than hand-editing
it. Write an executor only for an upstream that is not OpenAI-compatible.

Translators self-register as an import side effect, so a new translator file
must be imported from `open-sse/translator/index.js` or it never runs. Never
hardcode a role, block or model string; the constants live in
`open-sse/translator/schema/` and `open-sse/config/`.

Open a [provider request issue](../../issues/new?template=provider_request.yml)
first if you want the upstream discussed before you write the code.

## Documentation language

Documentation in this repository is English only. `README.md` and the pages
under `docs/` are the canonical text, and translated copies are deliberately not
kept: they drift within a release or two, and a confidently stale translation is
worse for a reader than an accurate English page.

The product interface is also English only, with a left-to-right document.
User-entered content, provider responses, speech languages and protocol
translation retain their original values. Currency formatting uses `Intl`
independently of the interface language.

## Code of conduct and security

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Do not report a vulnerability in a public issue. The private disclosure route is
in [SECURITY.md](SECURITY.md).
