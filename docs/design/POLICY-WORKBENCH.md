# Models policy workbench plan

The approved extension uses the current platinum workspace, navy navigation, indigo selection and IBM Plex typography. Body text stays at least 13 px; Mono is reserved for identifiers and measured values. It adds a versioned policy workspace beside the existing catalog controls, with a contextual entry from Sessions. Account, network, disabled-model and shaping controls remain outside configuration restoration.

The main task is to understand a routing plan, edit a stored draft, inspect a scoped before/after diff, validate locally, deliberately activate it and inspect the durable receipt. A second task captures one physical model's current account decision inputs and inspects an offline result. Simulation never claims an upstream request, served model or readiness proof.

## Composition and ownership

`src/shared/models-policy/ModelsPolicy.js` owns the current/draft state, revision conflict handling, draft persistence, fresh activation review and publication receipts. `PolicyEditor.js` owns ordered members, aliases and covered defaults/overrides. `PolicyHistory.js` presents bounded, explicitly paged immutable versions, drafts and receipts. `RoutingSimulator.js` owns capture/input/simulation state and keeps its returned capture unchanged. `policy.module.css` applies the existing workspace tokens. `policyModel.js` contains only editor transformations and presentation helpers.

The Models route gets controlled Policy workbench and Catalog controls views. Existing catalog actions remain mounted only when their view is active. Sessions links to this same workbench and retains the shared provider/account/model/time scope. No new API, configuration repository, selector, dispatch, Context or credential code belongs to this lane.

```text
Models                         Policy workbench | Catalog controls
Shared workspace scope and retained evidence
Current hash / draft revision          Save draft | Validate | Review activation
Plans | Aliases | Defaults | History | Offline simulation
Plan list                    Ordered members and account bindings
                             Per-plan strategy / judge / fusion timing
Local validation             Before / after changes and publication receipt
```

The plan list gives context without repeating KPI cards. Member numbers express actual order. Drag handles use the installed dnd-kit keyboard sensor and mature controls; the preview explicitly states when capability fit or rotation may change runtime dispatch order. Compact status distinguishes unsaved edits, stored revision, local validation and effective configuration. The alternative of a raw JSON editor was rejected because it hides scope and makes ordered plans harder to inspect. Replacing the existing catalog surface was rejected because its independent controls remain supported.

## Implementation sequence

1. Implement covered editor transformations and tests, including rename/binding preservation, explicit defaults and ordered members. Keep unknown legacy values visible until the operator repairs them.
2. Implement current read, draft create/load/revise, exact revision validation and fresh activation/rollback review. A 207 response shows partial completion and its authoritative receipt; it must not become a generic success toast. A 409 retains unsaved work. Never retry publication automatically.
3. Add version/draft/receipt pagination and side-by-side diff using the existing server projection. Show exact source/hash/revision and configuration scope. No first-page completeness claim.
4. Wire the concrete simulator capture/validate/simulate contract. Shared scope pre-fills an explicit physical model and preferred account. Missing session evidence is explicitly an assumed new session. Capture timestamps and excluded unknown gates remain visible; draft validation does not pretend to change account ranking.
5. Integrate Models/Sessions without removing existing controls. Use focused component tests for failures/conflicts/partial outcomes and actual private-DB browser save, reload, validation, activation, rollback and simulation. Preview guard exceptions must match only this lane's exact authorized endpoints.
6. Inspect 1440, 1920 and narrow rendered states, keyboard member reorder and modal focus, reduced motion, contrast and overflow. Record source/build SHA, synthetic scope, API receipts and remaining limitations.

## Current primary documentation

The API contract is `docs/design/CONFIG-VERSIONS.md`; simulator authority is the routing lane's `docs/contract/ROUTING-SIMULATOR.md`. Context7 was consulted for Mantine 9 controlled inputs/Tabs/Modal and the installed legacy dnd-kit core/sortable keyboard flow. References are [Mantine Tabs](https://mantine.dev/core/tabs), [Mantine inputs](https://github.com/mantinedev/mantine/tree/9.0.0/apps/mantine.dev/src/pages/core) and [dnd-kit sortable](https://github.com/clauderic/dnd-kit/tree/main/apps/docs/docs/legacy/presets/sortable).
