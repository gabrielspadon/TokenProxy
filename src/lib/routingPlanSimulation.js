import { isAccountModelDisabled } from '@/shared/utils/disabledModelPolicy.js';
import { planCascadeFromEvidence, normalizeModelRef } from '@/lib/stepRouter.js';
import { selectAutoModelFromCatalog, AUTO_MODEL_IDS } from '@/sse/services/autoRouter.js';
import {
  augmentModelsWithCapacityAdapter,
  getActiveAdapterStrategy,
} from 'open-sse/services/capacityAdapter.js';
import { applyAgentRoleGroup } from 'open-sse/utils/agentRole.js';
import { configHash, configDiff } from './db/helpers/configHistory.js';
import { assertRoutingDocument } from './configuration/routingConfig.js';
import {
  createRoutingCapture,
  validateRoutingCapture,
  validateSimulationInput,
  simulateRouting,
  SimulationError,
  SIMULATOR_LIMITS,
} from './routingSimulation.js';
import {
  getComboModelsFromData,
  orderComboEntries,
  resolveComboMemberConnection,
} from 'open-sse/services/combo.js';

export const ROUTE_CAPTURE_VERSION = 2;
export const ROUTE_POLICY_VERSION = 'captured-route-next-request-v1';
export const ROUTE_CAPTURE_TTL_MS = 15 * 60 * 1000;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const id = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\s\x00-\x1f@]|:\/\//.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const iso = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function fail(code, status = 400) {
  throw new SimulationError(code, status);
}
function shape(value, fields) {
  if (!plain(value) || Object.keys(value).some((key) => !fields.includes(key)))
    fail('invalid_route_capture');
}
function bounded(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('invalid_route_capture');
  }
  if (!serialized || Buffer.byteLength(serialized) > SIMULATOR_LIMITS.bodyBytes)
    fail('simulation_too_large', 413);
}

/** A v2 envelope contains only validated v1 credential-free physical captures. */
export function createRoutePlanCapture(value) {
  bounded(value);
  shape(value, [
    'version',
    'policyVersion',
    'captureId',
    'capturedAt',
    'expiresAt',
    'scope',
    'configuration',
    'draft',
    'routes',
    'resolutions',
    'rotations',
    'sessions',
    'sessionCoverage',
    'runtime',
    'auto',
  ]);
  if (
    !iso(value.capturedAt) ||
    !iso(value.expiresAt) ||
    Date.parse(value.expiresAt) !== Date.parse(value.capturedAt) + ROUTE_CAPTURE_TTL_MS ||
    !id(value.scope?.requestedModel)
  )
    fail('invalid_route_capture');
  const document = assertRoutingDocument(value.configuration?.document);
  if (configHash(document) !== value.configuration.currentHash) fail('invalid_configuration_hash');
  let draft = null;
  if (value.draft) {
    shape(value.draft, [
      'draftId',
      'revision',
      'versionId',
      'expectedCurrent',
      'document',
      'documentHash',
    ]);
    if (
      !id(value.draft.draftId) ||
      !Number.isSafeInteger(value.draft.revision) ||
      value.draft.revision < 1 ||
      !Number.isSafeInteger(value.draft.versionId) ||
      value.draft.versionId < 1 ||
      value.draft.expectedCurrent !== value.configuration.currentHash
    )
      fail('draft_capture_mismatch', 409);
    const draftDocument = assertRoutingDocument(value.draft.document);
    if (configHash(draftDocument) !== value.draft.documentHash) fail('draft_capture_mismatch', 409);
    draft = { ...value.draft, document: draftDocument };
  }
  if (
    !plain(value.routes) ||
    Object.keys(value.routes).length > 64 ||
    !plain(value.resolutions) ||
    Object.keys(value.resolutions).length > 512 ||
    !plain(value.rotations) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 200
  )
    fail('invalid_route_capture');
  const routes = Object.fromEntries(
    Object.entries(value.routes).map(([key, capture]) => {
      if (!id(key)) fail('invalid_route_capture');
      const state = validateRoutingCapture(capture);
      if (
        key !== `${state.scope.provider}/${state.scope.model}` ||
        state.configuration.currentHash !== value.configuration.currentHash
      )
        fail('invalid_route_capture');
      return [key, state];
    })
  );
  const resolutions = Object.fromEntries(
    Object.entries(value.resolutions).map(([key, resolved]) => {
      if (!id(key) || !(resolved === null || (id(resolved) && routes[resolved])))
        fail('invalid_route_capture');
      return [key, resolved];
    })
  );
  const rotations = Object.fromEntries(
    Object.entries(value.rotations).map(([key, cursor]) => {
      if (
        !id(key) ||
        !Number.isSafeInteger(cursor?.index) ||
        cursor.index < 0 ||
        !Number.isSafeInteger(cursor?.consecutiveUseCount) ||
        cursor.consecutiveUseCount < 0
      )
        fail('invalid_route_capture');
      return [key, { index: cursor.index, consecutiveUseCount: cursor.consecutiveUseCount }];
    })
  );
  const sessions = value.sessions.map((session) => {
    shape(session, ['sessionId', 'route', 'connectionId', 'pinnedAt', 'expiresAt']);
    if (
      !hash(session.sessionId) ||
      !routes[session.route] ||
      !id(session.connectionId) ||
      !iso(session.pinnedAt) ||
      !(session.expiresAt === null || iso(session.expiresAt))
    )
      fail('invalid_session_evidence');
    return { ...session };
  });
  if (new Set(sessions.map((s) => `${s.sessionId}/${s.route}`)).size !== sessions.length)
    fail('invalid_session_evidence');
  if (!['complete-for-captured-physical-models', 'none'].includes(value.sessionCoverage))
    fail('invalid_session_evidence');
  const runtime = value.runtime || {
    requestedModel: value.scope.requestedModel,
    capacityAdapter: {},
    agentRoles: {},
    reachableProviders: [],
  };
  shape(runtime, [
    'requestedModel',
    'capacityAdapter',
    'agentRoles',
    'reachableProviders',
    'cascadePairs',
  ]);
  if (
    !id(runtime.requestedModel) ||
    !plain(runtime.capacityAdapter) ||
    !plain(runtime.agentRoles) ||
    !Array.isArray(runtime.reachableProviders) ||
    runtime.reachableProviders.some((v) => !id(v))
  )
    fail('invalid_runtime_policy');
  for (const [cap, entry] of Object.entries(runtime.capacityAdapter)) {
    if (!['vision', 'pdf', 'audioInput', 'videoInput'].includes(cap))
      fail('invalid_runtime_policy');
    shape(entry, ['enabled', 'roundRobin', 'models']);
    if (
      typeof entry.enabled !== 'boolean' ||
      typeof entry.roundRobin !== 'boolean' ||
      !Array.isArray(entry.models) ||
      entry.models.some((v) => !id(v))
    )
      fail('invalid_runtime_policy');
  }
  for (const [role, group] of Object.entries(runtime.agentRoles))
    if (!['parent', 'sub'].includes(role) || !Array.isArray(group) || group.some((v) => !id(v)))
      fail('invalid_runtime_policy');
  if (
    runtime.cascadePairs !== undefined &&
    (!Array.isArray(runtime.cascadePairs) ||
      runtime.cascadePairs.some(
        (pair) =>
          !id(pair?.strong) ||
          !id(pair?.cheap) ||
          Object.keys(pair).some((k) => !['strong', 'cheap'].includes(k))
      ))
  )
    fail('invalid_runtime_policy');
  let auto = null;
  if (value.auto) {
    shape(value.auto, ['models', 'blockedModels', 'blockedProviders', 'rules']);
    if (
      !Array.isArray(value.auto.models) ||
      value.auto.models.length > 2048 ||
      !Array.isArray(value.auto.blockedModels) ||
      !Array.isArray(value.auto.blockedProviders) ||
      !plain(value.auto.rules)
    )
      fail('invalid_auto_capture');
    auto = {
      models: value.auto.models.map((m) => {
        shape(m, ['id', 'owned_by']);
        if (!id(m.id) || !id(m.owned_by)) fail('invalid_auto_capture');
        return { ...m };
      }),
      blockedModels: value.auto.blockedModels,
      blockedProviders: value.auto.blockedProviders,
      rules: value.auto.rules,
    };
    if (
      [...auto.blockedModels, ...auto.blockedProviders, ...Object.values(auto.rules)].some(
        (v) => !id(v)
      ) ||
      Object.keys(auto.rules).some((v) => !['simple', 'coding', 'reasoning'].includes(v))
    )
      fail('invalid_auto_capture');
  }
  const result = {
    version: ROUTE_CAPTURE_VERSION,
    policyVersion: ROUTE_POLICY_VERSION,
    capturedAt: value.capturedAt,
    expiresAt: value.expiresAt,
    scope: { requestedModel: value.scope.requestedModel },
    configuration: {
      currentHash: value.configuration.currentHash,
      versionId: Number.isSafeInteger(value.configuration.versionId)
        ? value.configuration.versionId
        : null,
      document,
    },
    draft,
    routes,
    resolutions,
    rotations,
    sessions,
    runtime: structuredClone(runtime),
    auto,
    sessionCoverage: value.sessionCoverage,
  };
  return freeze({ ...result, captureId: configHash(result) });
}

export function validateRoutePlanSimulation({ capture, input, draft, sessionPolicy } = {}) {
  if (capture?.version !== ROUTE_CAPTURE_VERSION || capture.policyVersion !== ROUTE_POLICY_VERSION)
    fail('unsupported_capture_version');
  const state = createRoutePlanCapture(capture),
    request = validateSimulationInput(input);
  if (configHash(state) !== configHash(capture)) fail('capture_integrity_mismatch');
  if (request.model !== state.scope.requestedModel) fail('capture_model_mismatch');
  if (draft) {
    shape(draft, ['version', 'draftId', 'revision', 'document', 'expectedCurrent']);
    if (
      !state.draft ||
      draft.draftId !== state.draft.draftId ||
      draft.revision !== state.draft.revision ||
      draft.expectedCurrent !== state.configuration.currentHash ||
      configHash(draft.document) !== state.draft.documentHash
    )
      fail('draft_capture_mismatch', 409);
  }
  let policy = { action: 'retain', at: state.capturedAt, connectionIds: [] };
  if (sessionPolicy) {
    shape(sessionPolicy, ['action', 'at', 'connectionIds']);
    if (!['retain', 'clear', 'expire'].includes(sessionPolicy.action))
      fail('unsupported_session_policy', 422);
    if (
      !iso(sessionPolicy.at) ||
      sessionPolicy.at < state.capturedAt ||
      Date.parse(sessionPolicy.at) > Date.parse(state.capturedAt) + 30 * 86400000
    )
      fail('invalid_session_boundary');
    if (
      !Array.isArray(sessionPolicy.connectionIds) ||
      sessionPolicy.connectionIds.length > 200 ||
      sessionPolicy.connectionIds.some((value) => !id(value))
    )
      fail('invalid_session_scope');
    policy = structuredClone(sessionPolicy);
  }
  return {
    state,
    request,
    document: draft ? state.draft.document : state.configuration.document,
    includeDraft: !!draft,
    policy,
  };
}

function comboFor(reference, document) {
  return (
    document.combos.find((c) => c.name === reference) ||
    document.combos.find((c) => c.name === reference.split('/').pop())
  );
}
function target(reference, document, capture) {
  const alias = document.aliases[reference];
  const name =
    typeof alias === 'string' ? alias : alias ? `${alias.provider}/${alias.model}` : reference;
  return capture.resolutions[name] ?? capture.resolutions[reference] ?? null;
}

function accountDecision(capture, request, route, options = {}) {
  const physical = capture.routes[route];
  if (!physical) return null;
  const policy = options.policy;
  const clears = (connectionId) =>
    policy &&
    policy.action !== 'retain' &&
    (!policy.connectionIds.length || policy.connectionIds.includes(connectionId));
  const pin = Object.hasOwn(options, 'pin')
    ? options.pin
    : clears(physical.pin?.connectionId)
      ? null
      : physical.pin;
  const activeLoad = structuredClone(physical.activeLoad);
  if (capture.sessionCoverage === 'complete-for-captured-physical-models' && options.at) {
    for (const load of Object.values(activeLoad)) load.pins = 0;
    for (const session of capture.sessions)
      if (
        session.route === route &&
        !clears(session.connectionId) &&
        (!session.expiresAt || session.expiresAt > options.at) &&
        activeLoad[session.connectionId]
      )
        activeLoad[session.connectionId].pins++;
  }
  const state = createRoutingCapture({
    ...physical,
    activeLoad,
    ...(options.at ? { capturedAt: options.at } : {}),
    pin,
    affinitySource: Object.hasOwn(options, 'pin') ? 'captured-session' : physical.affinitySource,
  });
  return simulateRouting({
    capture: state,
    input: {
      ...request,
      model: state.scope.requestedModel,
      ...(options.preferred
        ? { preferredConnectionId: options.preferred, strictPreferredConnection: true }
        : {}),
    },
  });
}

/** Compile the same stable fit order as the dispatcher without advancing its cursor. */
function routePlan(capture, request, document, { draft = false, policy } = {}) {
  const attempts = [],
    plans = [],
    unknown = new Set();
  const required = new Set(
    (request.requiredCapabilities || []).filter((c) =>
      ['vision', 'pdf', 'audioInput', 'videoInput'].includes(c)
    )
  );
  const runtime = capture.runtime;
  const chat = (request.modality || 'chat') === 'chat';
  const providerOriented = ['search', 'fetch', 'ocr', 'moderation'].includes(request.modality);
  if (providerOriented) unknown.add('provider-oriented-modality-resolution-and-service-lock-key');
  const augment = (models) => {
    if (!chat) return models;
    const augmented = augmentModelsWithCapacityAdapter(models, required, runtime);
    const added = augmented.filter((m) => !models.includes(m));
    return [
      ...added.filter((m) => runtime.reachableProviders.includes(m.split('/')[0])),
      ...models,
    ];
  };
  const walk = (reference, chain = []) => {
    if (chain.length > 16 || attempts.length >= 256) fail('simulation_too_large', 413);
    const combo = comboFor(reference, document);
    if (combo) {
      if (chain.some((name) => comboFor(name, document)?.name === combo.name))
        fail('unsupported_combo_cycle', 422);
      let members = getComboModelsFromData(reference, document.combos);
      if (!members) fail('empty_combo', 422);
      const configuredOrder = [...members];
      const override = document.settings.comboStrategies?.[reference] || {};
      const configuredStrategy =
        override.fallbackStrategy || document.settings.comboStrategy || 'fallback';
      const strategy = !chat && configuredStrategy === 'fusion' ? 'fallback' : configuredStrategy;
      if (!['fallback', 'round-robin', 'fusion'].includes(strategy))
        fail('unsupported_route_strategy', 422);
      const disabled = [];
      members = members.filter((modelStr, originalIndex) => {
        const route = target(modelStr, document, capture);
        const physical = route && capture.routes[route];
        const active =
          physical?.accounts.filter((a) => a.isActive && a.provider === physical.scope.provider) ||
          [];
        const aliases =
          physical?.providerNodes
            .filter((n) => n.id === physical.scope.provider)
            .map((n) => n.prefix) || [];
        const disabledFor = (connectionId) =>
          isAccountModelDisabled(
            physical.disabledModels,
            physical.scope.provider,
            physical.scope.model,
            connectionId,
            aliases,
            physical.providerNodes
          );
        const allDisabled =
          physical && (active.length ? active.every((a) => disabledFor(a.id)) : disabledFor(null));
        if (allDisabled)
          disabled.push({
            requestedModel: modelStr,
            route,
            reason: 'model-disabled-for-every-active-account',
            originalIndex,
          });
        return !allDisabled;
      });
      if (chat && chain.length === 0)
        members = applyAgentRoleGroup(members, request.agentRole, runtime);
      if (strategy !== 'fusion') members = augment(members);
      const entries = members.map((modelStr, originalIndex) => ({ modelStr, originalIndex }));
      // Publishing any routing configuration resets the runtime rotation map.
      const cursor = draft ? { index: 0, consecutiveUseCount: 0 } : capture.rotations[reference];
      if (strategy === 'round-robin' && !cursor) fail('rotation_capture_missing', 422);
      const index =
        strategy === 'round-robin' && entries.length ? cursor.index % entries.length : 0;
      const rotated = [...entries.slice(index), ...entries.slice(0, index)];
      const ordered =
        strategy === 'fusion'
          ? rotated
          : orderComboEntries(rotated, {
              contextTokens: request.contextTokens || 0,
              // The gateway detects only current-turn hard modalities here. Reasoning
              // is provider shaping evidence, not a combo ordering condition.
              required: new Set(
                (request.requiredCapabilities || []).filter((c) =>
                  ['vision', 'pdf', 'audioInput', 'videoInput'].includes(c)
                )
              ),
              autoSwitch: request.modality !== 'stt',
            });
      plans.push({
        name: combo.name,
        strategy,
        configuredStrategy,
        cursor: cursor || null,
        cursorSource: draft ? 'activation-resets-rotation' : 'captured-process',
        configuredOrder,
        orderedMembers: ordered.map((e) => e.modelStr),
        disabled,
        judgeModel: strategy === 'fusion' ? override.judgeModel || members[0] : null,
        judgeDecision:
          strategy === 'fusion'
            ? accountDecision(
                capture,
                request,
                target(override.judgeModel || members[0], document, capture)
              )?.localSelection || null
            : null,
        selectionBoundary:
          strategy === 'fusion' ? 'parallel-panel-then-judge' : 'sequential-replay-safe-fallback',
      });
      if (strategy === 'fusion') unknown.add('fusion-panel-outcomes-and-judge-dispatch');
      for (const entry of ordered) walk(entry.modelStr, [...chain, reference]);
      return;
    }
    const route = target(reference, document, capture);
    const preferred = chat
      ? resolveComboMemberConnection(chain, reference, document.settings)
      : null;
    const decision = route
      ? accountDecision(capture, request, route, { preferred, at: policy?.at, policy })
      : null;
    if (!decision) unknown.add('unresolved-route-or-uncaptured-physical-model');
    attempts.push({
      order: attempts.length + 1,
      requestedModel: reference,
      resolvedModel: route,
      comboChain: chain,
      preferredConnectionId: preferred || null,
      reason: decision?.localSelection.reason || 'unresolved-route-or-uncaptured-physical-model',
      localSelection: decision?.localSelection || { status: 'unknown', connectionId: null },
      candidates: decision?.candidates || [],
      exclusions: decision?.exclusions || [],
      capabilityFit: decision?.capabilityFit || null,
    });
  };
  let rootModel = runtime.requestedModel;
  let automatic = null,
    cascadeUnknown = false;
  if (chat && AUTO_MODEL_IDS.has(rootModel) && !comboFor(rootModel, document)) {
    if (!capture.auto || !request.taskClass) fail('auto_task_class_required', 422);
    automatic = selectAutoModelFromCatalog(
      request.taskClass,
      capture.auto.models,
      {
        models: new Set(capture.auto.blockedModels),
        providers: new Set(capture.auto.blockedProviders),
      },
      { autoRouter: { rules: capture.auto.rules } }
    );
    unknown.add('live-entitlement-catalog-differences');
    if (automatic) rootModel = automatic.model;
  }
  if (!comboFor(rootModel, document)) {
    const augmented = augment([rootModel]);
    if (augmented.length > 1) {
      const strategy = getActiveAdapterStrategy(required, runtime);
      const cursor = capture.rotations[rootModel] || { index: 0, consecutiveUseCount: 0 };
      const index = strategy === 'round-robin' ? cursor.index % augmented.length : 0;
      const ordered = orderComboEntries(
        [...augmented.slice(index), ...augmented.slice(0, index)].map((modelStr) => ({ modelStr })),
        { contextTokens: request.contextTokens || 0, required }
      );
      plans.push({
        name: 'capacity-adapter',
        strategy,
        configuredOrder: [rootModel],
        orderedMembers: ordered.map((e) => e.modelStr),
        disabled: [],
        cursor,
      });
      for (const entry of ordered) walk(entry.modelStr);
    } else {
      const pair =
        chat && runtime.cascadePairs?.find((pair) => normalizeModelRef(rootModel) === pair.strong);
      if (pair) {
        const mode = request.cascadeMode || 'unknown';
        const decision = planCascadeFromEvidence({
          modelStr: rootModel,
          cheapModel: pair.cheap,
          escalated: mode === 'escalated',
          exploration: mode === 'exploration',
        });
        cascadeUnknown = mode === 'unknown';
        const ordered =
          cascadeUnknown || decision.action === 'cheap' ? [pair.cheap, rootModel] : [rootModel];
        plans.push({
          name: 'solo-cascade',
          strategy: 'cascade',
          configuredOrder: [rootModel],
          orderedMembers: ordered,
          disabled: [],
          decision: cascadeUnknown ? 'unknown' : decision.action,
          evidenceSource: 'operator-supplied-request-classification',
          unknownEvidence: ['raw-session-escalation-map-not-correlated-with-affinity-hash'],
          selectionBoundary: 'cheap-escalates-on-retryable-status-only',
        });
        if (cascadeUnknown) unknown.add('cascade-request-classification-and-session-escalation');
        ordered.forEach((model) => walk(model));
      } else walk(rootModel);
    }
  } else walk(rootModel);
  const fusion = plans.some((p) => p.strategy === 'fusion' && p.orderedMembers.length > 1);
  const first =
    fusion || cascadeUnknown || providerOriented
      ? null
      : attempts.find((a) => ['candidate', 'wait', 'unknown'].includes(a.localSelection.status));
  return {
    requestedModel: request.model,
    selectedModel: first?.localSelection.status === 'candidate' ? first.resolvedModel : null,
    automatic,
    connectionId: first?.localSelection.connectionId || null,
    status:
      cascadeUnknown || providerOriented
        ? 'unknown'
        : fusion
          ? 'panel-plan'
          : first?.localSelection.status || 'refused',
    attempts,
    plans,
    unknownEvidence: [
      ...unknown,
      'api-key-model-access-and-budget-not-supplied',
      'provider-readiness-and-credential-acceptance',
      'future-request-and-other-process-load',
    ],
    servedModel: null,
    fallbackContinuation:
      'Only a replay-safe local or upstream rejection permits another attempt; accepted generations never authorize replay.',
  };
}

export function simulateRoutePlan(args) {
  const { state, request, document, includeDraft, policy } = validateRoutePlanSimulation(args);
  const before = routePlan(state, request, state.configuration.document, {
    policy: { action: 'retain', connectionIds: [], at: state.capturedAt },
  });
  const after = routePlan(state, request, document, { draft: includeDraft, policy });
  const sessions = state.sessions.map((session) => {
    const affected =
      policy.action !== 'retain' &&
      (!policy.connectionIds.length || policy.connectionIds.includes(session.connectionId));
    const expired = !!session.expiresAt && session.expiresAt <= policy.at;
    const pin =
      affected || expired
        ? null
        : {
            connectionId: session.connectionId,
            pinnedAt: session.pinnedAt,
            expiresAt: session.expiresAt,
          };
    const beforeDecision = accountDecision(state, request, session.route, {
      pin: {
        connectionId: session.connectionId,
        pinnedAt: session.pinnedAt,
        expiresAt: session.expiresAt,
      },
      at: state.capturedAt,
      preferred: before.attempts.find((a) => a.resolvedModel === session.route)
        ?.preferredConnectionId,
    });
    const afterDecision = accountDecision(state, request, session.route, {
      pin,
      at: policy.at,
      policy,
      preferred: after.attempts.find((a) => a.resolvedModel === session.route)
        ?.preferredConnectionId,
    });
    const nextModel = after.selectedModel;
    const modelChanged = nextModel !== null && nextModel !== session.route;
    return {
      ...session,
      affected: affected || expired || modelChanged,
      reason: modelChanged
        ? 'requested-route-selects-another-model'
        : affected
          ? `operator-${policy.action}`
          : expired
            ? 'pin-expired'
            : 'binding-retained',
      before: {
        connectionId: beforeDecision.localSelection.connectionId,
        model: session.route,
        reason: beforeDecision.localSelection.reason,
      },
      after: {
        connectionId: modelChanged ? after.connectionId : afterDecision.localSelection.connectionId,
        model: nextModel || session.route,
        reason: modelChanged
          ? 'new-physical-model-affinity-key'
          : afterDecision.localSelection.reason,
      },
      cacheContinuity:
        modelChanged ||
        beforeDecision.localSelection.connectionId !== afterDecision.localSelection.connectionId
          ? 'binding-changed-cache-reuse-not-guaranteed'
          : 'same-binding-provider-cache-reuse-unverified',
      boundary: 'next-request-only-in-flight-requests-unchanged',
    };
  });
  return {
    version: ROUTE_CAPTURE_VERSION,
    mode: 'offline-captured-route-plan',
    served: null,
    upstreamVerified: false,
    receipt: {
      captureId: state.captureId,
      capturedAt: state.capturedAt,
      expiresAt: state.expiresAt,
      configurationHash: state.configuration.currentHash,
      configurationVersionId: state.configuration.versionId,
      draftId: includeDraft ? state.draft.draftId : null,
      draftRevision: includeDraft ? state.draft.revision : null,
      draftVersionId: includeDraft ? state.draft.versionId : null,
      draftHash: includeDraft ? state.draft.documentHash : null,
      inputHash: configHash(request),
      sessionPolicyHash: configHash(policy),
      sideEffects: false,
      providerCalls: 0,
    },
    before,
    after,
    diff: configDiff(state.configuration.document, document),
    sessionPreview: {
      policy,
      boundary: 'next-request',
      coverage: state.sessionCoverage,
      attribution:
        'Each captured pin is evaluated for a hypothetical next request of the requested route; original alias identity is not stored in affinity.',
      affectedCount: sessions.filter((s) => s.affected).length,
      sessions,
    },
    limitations: [
      'No provider calls, configuration activation, cursor advancement, pin writes or leases occur.',
      'Next-request planning uses captured process load and persisted quotas. Future traffic, credential acceptance and provider cache reuse remain unknown.',
      'Input sizes are operator supplied. Capability reordering shares the gateway planner; reasoning and output limits remain declared evidence.',
      'Fusion panel and judge outcomes, automatic-router live catalog differences and provider cache acceptance remain unknown.',
      'Captures are content-addressed operator evidence, not signatures or atomic cross-store snapshots.',
    ],
  };
}
