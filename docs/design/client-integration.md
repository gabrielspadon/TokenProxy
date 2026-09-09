# Client events and native compaction

TokenProxy accepts explicit client reports at `POST /api/v1/context/events`. Reports use an active client API key and retain the originating client identity separately from gateway estimates. The Context workspace’s **Browse client reports** view shows their exact event IDs, installation-keyed identity references, outcomes and optional request links. A report is client evidence, not independent provider verification.

## Opt-in Claude Code integration

Generate a separate settings file, review it, and pass it to the client. The generator refuses to overwrite an existing destination. It preserves existing settings and hooks, appends its PostCompact command once, and leaves percentage overrides and model selection unchanged unless explicitly supplied.

```sh
node scripts/tokenproxy-client-config.mjs \
  /absolute/existing-settings.json /absolute/reviewed-client-settings.json \
  https://your-gateway.example claude-code
claude --settings /absolute/reviewed-client-settings.json
```

Provide the gateway client credential through `TOKENPROXY_API_KEY` in the client environment. The adapter never discovers provider credentials or calls a generation endpoint. `TOKENPROXY_CLIENT_ID` identifies the originating application. Optional `TOKENPROXY_TASK_ID` and `TOKENPROXY_PROJECT_ID` must identify the actual task and project. The hook supplies the native `session_id`; it does not invent a task or request association.

The native `PostCompact` notification establishes that the client completed compaction. Native Claude Code 2.1.263 invokes this hook before returning and persisting the new transcript boundary; partial compaction also assigns `postTokens` after the hook. Consequently, the adapter does not read the latest transcript boundary or send summary text. Before/after token quantities remain unknown because the hook input does not provide them. A caller with independently available counts may use the explicit event API with the required measurement method.

Each hook invocation creates one delivery UUID and timestamp and retains its exact event packet before sending it. It performs one HTTP request with a 3.5-second timeout and refuses redirects. The hook emits its acknowledgement to stderr, leaving stdout empty so it does not inject text into the model’s context. An error produces a nonzero exit and retains the packet. There is no automatic retry or generation replay.

The outbox defaults to `$CLAUDE_CONFIG_DIR/tokenproxy-event-outbox`, or `~/.claude/tokenproxy-event-outbox` when the native config directory is unset. Set `TOKENPROXY_EVENT_OUTBOX` to use an independently owned directory. Its admission lock limits retained packets to 256 files, each at most 16 KiB. A concurrent or interrupted admission fails closed. Inspect an interrupted `.admission` directory before removing that lock; do not remove retained event files without an archival decision. Acknowledged packets also remain until the operator archives them.

To retry an uncertain event, send the exact retained packet, which reuses its UUID and timestamp. A matching duplicate returns HTTP 200; the first successful insertion returns 201. A changed payload with the same ID returns 409. Unmatched or conflicting request links are refused. Never regenerate a UUID to retry an uncertain packet.

```sh
node scripts/tokenproxy-client-events.mjs send /absolute/exact-retained-event.json
```

The same emitter accepts explicit `handoff`, `task_start` and `task_outcome` packets. Handoff requires the actual `targetClientId`; task events require an actual `taskId`; an outcome is `success`, `failure`, `cancelled` or `unknown`. Only callers holding exact gateway request identifiers should supply request links. Unlinked events remain visibly unlinked.

## The 84% boundary

Two separate mechanisms explain the observed behavior in the inspected version.

1. The native client resolves its own model window. In six controlled executions of the unmodified Mac Claude Code 2.1.263, the native `/context` command reported 200k for bare `claude-fable-5`, `claude-fable-5-1` and `claude-opus-5` through a gateway. Each identical model with `[1m]` reported 1m. All executions had `autoCompactWindow=1000000` and a 100% percentage override. An OS sandbox denied all network access. No completion was generated.
2. Native output and compaction reserves are subtracted from that resolved window. The inspected implementation computes `effective = resolvedWindow - min(modelMaxOutput, 20000)` and `trigger = min(floor(effective × percent / 100), effective - 13000)`. Thus a 200k model with at least 20k maximum output triggers at 167k, or 83.5%, even at a 100% override. For a 1m window the same calculation gives 967k at 100%, or 931k at 95%. These are version-specific source calculations, not observations of a new live compaction.

The Keys client setup view keeps advertised context, native resolved window, output reserve, effective window, compaction reserve and calculated trigger separate. Unknown inputs remain unknown. It never substitutes a displayed 100% for real usage.

Current Mac and RTX settings inspected on 2026-09-08 already select `claude-opus-5[1m]` and `autoCompactWindow=1000000`. Mac still has `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=95`; RTX has no percentage override in that settings file. The current managed `cc-router` launcher adds `[1m]` only to exact registered model lanes whose context and capability declarations both reach 1m. Existing resumed sessions retain their model. Read-only RTX process evidence included active older bare Fable selections, including a 2.1.263 process with `claude-fable-5`, and an older remote 2.1.260 process. Updating a settings file does not establish that those sessions adopted it.

For a verified exact route with both declarations of at least 1m, the generator supports an explicit same-model selection. It does not infer capacity from a model family or catalog display name.

```sh
node scripts/tokenproxy-client-config.mjs \
  /absolute/existing-settings.json /absolute/reviewed-client-settings.json \
  https://your-gateway.example claude-code \
  1000000 claude-fable-5-1 1000000 1000000
```

The final two numbers are the operator’s verified gateway and capability declarations for that exact route. This emits `model: "claude-fable-5-1[1m]"` and the supported `autoCompactWindow` setting. It does not verify upstream entitlement, increase physical capacity, remove native reserves, or rewrite a running session’s selected model. Use the native `/context` command in the actual resumed session to verify its selection and resolved window. A future naturally occurring PostCompact notification can prove native compaction completion after deployment; the controlled tests do not claim that observation.

## Verification and primary references

The retained qualification packet lives under `implementation-evidence/platform-completion-20260908/evidence/client-integration` in the parent workspace. It contains native binary hashes and source fragments, source and launcher receipts, actual native `/context` outputs, an OS-network-denied `--init-only` SessionStart hook invocation, exact controlled event API/UI evidence and responsive screenshots. The native SessionStart check proves hook invocation but emits no compaction event. Controlled PostCompact inputs separately prove the adapter/API/renderer contract.

- [Native model and gateway window configuration](https://code.claude.com/docs/en/model-config)
- [Supported autoCompactWindow setting](https://code.claude.com/docs/en/settings-reference)
- [Hook inputs and lifecycle](https://code.claude.com/docs/en/hooks)
- [Native init-only lifecycle](https://code.claude.com/docs/en/cli-reference)

No provider inference, vendor binary patch, live service restart, client settings replacement or active-session mutation is part of this qualification.
