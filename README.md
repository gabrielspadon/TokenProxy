# TokenProxy

TokenProxy is a self-hosted AI gateway. It speaks the request format your
client already uses, translates it into whatever the upstream provider expects,
and falls back across models and accounts when one runs out of quota, rate
limits you, or fails outright. A dashboard sits on top of it for credentials,
routing, usage and cost.

The point is that one base URL and one key keep working. Everything that
changes underneath, which provider is cheapest today, which account still has
quota, which OAuth token expired an hour ago, is the gateway's problem rather
than your client's.

## Install and first request

Install the launcher from npm and start it.

```bash
npm install -g tokenproxy
tokenproxy
```

The dashboard is served at `http://localhost:20128/dashboard` and the API at
`http://localhost:20128/v1`. The first login uses `INITIAL_PASSWORD`, which
defaults to `123456` and should be overridden before the instance is reachable
by anything but loopback.

In the dashboard, connect one provider under Providers and copy a generated API
key. Put it in the environment rather than in the command, so it stays out of
your shell history.

```bash
export TOKENPROXY_KEY=...   # the key you copied from the dashboard

curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $TOKENPROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kr/claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}]}'
```

A model is addressed as `providerPrefix/modelName`, and a combo is addressed by
its own name. Running from a source checkout is covered in
[CONTRIBUTING.md](CONTRIBUTING.md); running in a container is covered in
[DOCKER.md](DOCKER.md); running it as a long-lived service is covered in
[docs/deployment.md](docs/deployment.md).

## Speaking your client's format, not just OpenAI's

The OpenAI shape is the most common way in, and it is not the only one. The
translation engine registers a source format and a target format independently,
so the dialect a client sends and the dialect a provider expects are decoupled.

Requests are accepted in the OpenAI Chat Completions shape, the OpenAI Responses
shape, the Anthropic Messages shape, the Gemini and Gemini CLI shapes, the
Vertex shape, and the wire formats used by Codex, Cursor, Kiro, Antigravity,
CommandCode and Ollama. Routes are exposed at `/v1/*`, `/v1beta/*`, `/responses`
and `/codex/*`, so a client hardcoded to one vendor's path still lands in the
right handler. Point Claude Code at it, or the Gemini CLI, or an Ollama client,
without changing the client.

Translation pivots through the OpenAI shape as an intermediate representation.
Where that double hop would lose something fragile, thinking blocks, tool call
identities, non-base64 images, error flags on tool results, a direct
`source:target` translator is registered for that exact pair and the pivot is
skipped. Binary and protobuf upstreams that cannot round-trip at all, such as
the Kiro EventStream, the Cursor protobuf and the CommandCode NDJSON streams,
are handled inside their own executor.

The full list of connected providers, how each one authenticates, and what it
costs are in [docs/providers.md](docs/providers.md), which gives the command
that counts them rather than a number that goes stale.

## More than chat completions

The gateway fronts the whole endpoint surface, not only conversation.

- Chat and messages, including Anthropic-style token counting and the Responses
  API with its compaction endpoint.
- Embeddings, with self-hosted endpoints wired the same way as hosted ones.
- Audio, covering speech synthesis, transcription and voice listing.
- Images, both generation and editing.
- Video generation, editing, extension, and job polling by id.
- Moderation, OCR, reranking, web search and web fetch.
- Model discovery, which reports what the connected accounts can actually reach
  rather than a static list.

## Fallback that survives a bad day

Fallback happens at two levels. A combo is an ordered list of models, and the
next entry is tried when the current one is exhausted or errors. Within a single
provider, several accounts can be registered and are rotated with sticky round
robin and priority ordering, so a quota ceiling on one account is not a ceiling
on the combo.

An account hit by a 429 is locked for that model with exponential backoff rather
than retried immediately. The schedule is tunable per deployment for providers
whose quota windows do not match the default. OAuth connections are refreshed in
the background before they expire, and a refresh failure demotes the account
instead of failing the request.

## Cutting tokens before the request leaves

Token savers run before dispatch and are all fail-open, so an error inside one
leaves the request untouched rather than breaking it.

The savers run in two halves, in a fixed order, because the provider caches
the prompt prefix and a stage that reshapes history differently from one turn
to the next throws that cache away.

The first half is deterministic and runs on every request: tool schema
distillation, historical thinking strip, RTK, the privacy filter and the
Caveman and Ponytail style prompts. RTK rewrites bulky tool results in place
and deliberately skips results already marked as errors, so a failure trace
reaches the model intact. Tool disclosure picks a tool subset once per client
session and only ever appends to it after that.

The second half runs only when the request no longer fits the model's window
less a reserve, and climbs a ladder from least loss to most: historical media
placeholders, oldest tool results trimmed only as far as the overflow needs,
Headroom on the oldest slice of the history, query-aware compression, pair
dropping, embedding reorder, and (opt-in) summarising compaction. Every
decision a rung takes is remembered for the session and replayed on later
turns, so a prune buys many turns of a byte-identical prefix rather than one.
Headroom and PXPIPE are external compressors reached over HTTP, each behind a
timeout and a circuit breaker.

Sending the header `X-TokenProxy-Token-Saver: off` bypasses every one of them
for a single request.

## The dashboard and the operational layer

The dashboard is where the gateway is actually operated.

- Providers, accounts and OAuth connections, with secrets encrypted at rest.
- Combos, model context settings and request inspection.
- Usage, statistics, per-session views and quota tracking with cost estimates
  and reset times per provider and per model.
- Proxy pools for egressing through SOCKS or HTTP proxies, with deploy recipes.
- A MITM proxy for the editors and agents that will not be pointed at a base URL
  and must be intercepted instead.
- One-click settings writers for a long list of coding agents and CLIs, so
  Claude Code, Codex, Cline, Copilot, OpenCode, Droid, Kilo and the rest are
  pointed at the gateway without hand-editing their config files.
- Agent skill bundles served to coding agents that support them, documented in
  [public/skills/README.md](public/skills/README.md).

Authentication covers local password login, generated API keys, and SAML SSO for
an organizational deployment.

## Running it somewhere real

State lives in a local SQLite database under `DATA_DIR`, defaulting to
`~/.tokenproxy`. The driver falls back through `bun:sqlite`, `better-sqlite3`,
`node:sqlite` and finally the pure-JavaScript `sql.js`, so installation never
requires a compiler. Secret directories and files are re-tightened to `0700` and
`0600` on every boot, and a backup is taken before each schema migration.

The server derives the client IP from the TCP socket and trusts forwarding
headers only from a loopback peer, so a reverse proxy in front of it works and a
forged `X-Forwarded-For` from outside does not. The API can be split onto its
own listener and its own bind address, which lets the dashboard stay on loopback
while `/v1` is exposed.

The same build runs from a source checkout, from a container image built at the
repository root, or under a service manager behind a reverse proxy.

## Documentation

- [Providers](docs/providers.md) for what each upstream costs, how it is
  connected, and how self-hosted speech and embedding endpoints are wired.
- [Troubleshooting](docs/troubleshooting.md) for the errors people hit most.
- [Deployment](docs/deployment.md) for running it as a service, what must be set
  before the port is reachable, and what a reverse proxy has to do.
- [Contributing](CONTRIBUTING.md) for the repository layout, local setup, the
  test suite, and the environment contract.
- [Docker](DOCKER.md) for the container, compose, and the image build.
- [Agent skills](public/skills/README.md) for the bundled skill bundles the
  dashboard serves to coding agents.
- [Security](SECURITY.md) for the private disclosure route.

The routing and translation engine documents its own conventions in
[open-sse/AGENTS.md](open-sse/AGENTS.md); read it before changing anything
under `open-sse/`.

TokenProxy ships in English only.

## Acknowledgments

TokenProxy is a JavaScript reimplementation that stands on work done elsewhere.

The gateway lineage:

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), the original Go
  implementation whose routing and translation model this port follows.
- [9router](https://github.com/decolua/9router), the JavaScript predecessor this
  repository is forked from, whose commit history is preserved beneath this
  one.

The token savers:

- [RTK](https://github.com/rtk-ai/rtk), the Rust token saver whose compression
  pipeline is ported here.
- [Caveman](https://github.com/JuliusBrussee/caveman) by
  [@JuliusBrussee](https://github.com/JuliusBrussee), whose prompt is adapted
  for the output-terseness saver.
- [Ponytail](https://github.com/DietrichGebert/ponytail) by
  [@DietrichGebert](https://github.com/DietrichGebert), whose YAGNI ladder is
  adapted for the code-brevity saver.
- [Headroom](https://github.com/chopratejas/headroom) and
  [PXPIPE](https://www.npmjs.com/package/pxpipe-proxy), the optional external
  compression proxies.

The stack it is built on:

- [Next.js](https://nextjs.org) and [React](https://react.dev) for the server
  and the dashboard, with [Zustand](https://zustand-demo.pmnd.rs) for client
  state and [Recharts](https://recharts.org) for the usage charts.
- [sql.js](https://sql.js.org) and
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) behind the
  storage layer, so the database works with or without a native build.
- [undici](https://undici.nodejs.org) for upstream HTTP,
  [jose](https://github.com/panva/jose) for session tokens,
  [node-forge](https://github.com/digitalbazaar/forge) for the MITM
  certificate authority, and
  [@node-saml/node-saml](https://github.com/node-saml/node-saml) for SSO.
- [Monaco](https://microsoft.github.io/monaco-editor/),
  [React Flow](https://reactflow.dev), [dnd kit](https://dndkit.com) and
  [Material Symbols](https://fonts.google.com/icons) for the editor, the
  routing graph, drag-and-drop ordering and the icon set.
- [Vitest](https://vitest.dev) and [Playwright](https://playwright.dev) for the
  test suite.

## Support and license

Bug reports and feature requests go through the repository's issue tracker.
Code changes start at [CONTRIBUTING.md](CONTRIBUTING.md). A vulnerability
goes through the private route in [SECURITY.md](SECURITY.md) and never through a
public issue.

TokenProxy contacts your providers because that is the product. Everything else it
can reach on its own, and how to turn each one off, is listed under
[what talks to the network](SECURITY.md#what-talks-to-the-network-besides-your-providers).
Dashboard analytics is off by default and no prompt, response or credential is
sent anywhere but the provider you routed to.

MIT, see [LICENSE](LICENSE).
