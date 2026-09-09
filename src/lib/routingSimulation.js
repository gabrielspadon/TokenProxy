import { configHash, CONFIG_SCOPE } from './db/helpers/configHistory.js';
import { assertRoutingDocument, validateRoutingDocument } from './configuration/routingConfig.js';
import { accountAdmissionReason, temporaryPinWait } from '@/sse/services/accountAdmissionPolicy.js';
import { planAccountSelection } from '@/sse/services/accountScheduler.js';
import { isAccountModelDisabled } from '@/shared/utils/disabledModelPolicy.js';
import { isNoAuthProvider, isProviderDisabled } from '@/shared/constants/providers.js';
import { getPausedWindow } from '@/shared/utils/quotaPause.js';
import { toRankerWindows } from '@/shared/utils/quotaWindowBridge.js';
import { effectiveCapacity } from '@/shared/utils/accountCapacity.js';
import { getModelFailureKey, getModelLockKey } from 'open-sse/services/accountFallback.js';
import { classifyAccountFailure } from '@/shared/utils/accountFailureClass.js';

export const SIMULATOR_VERSION = 1;
export const SELECTION_POLICY_VERSION = 'quota-affinity-v1';
export const SIMULATOR_LIMITS = Object.freeze({ accounts: 200, windows: 64, bodyBytes: 1048576, models: 512 });
export const CAPABILITY_FIELDS = Object.freeze(['vision', 'pdf', 'audioInput', 'videoInput', 'tools', 'reasoning', 'search', 'embedding', 'rerank', 'image', 'video', 'tts', 'stt', 'contextWindow', 'maxOutput']);
const MODALITIES = ['chat', 'embeddings', 'rerank', 'image', 'video', 'tts', 'stt', 'search', 'ocr', 'moderation', 'fetch'];
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
const identifier = (v, limit = 512) => typeof v === 'string' && v.length > 0 && v.length <= limit && !/[\s\x00-\x1f\x7f@]|:\/\//.test(v) && !dangerous.has(v);
const timestamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const lockTimestamp = (v) => typeof v === 'string' && v.length <= 64 && timestamp(v) ? v : null;
const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const numericEvidence = (v) => finite(v) ?? (typeof v === 'string' && v.length <= 32 && v.trim() && Number.isFinite(Number(v)) ? v : null);
function percentageEvidence(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (finite(value) !== null) return value;
  if (typeof value === 'string') return value.length <= 32 && Number.isFinite(Number(value)) ? value : 'unknown';
  throw new SimulationError('unrepresentable_quota', 422);
}
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const pick = (v, keys) => Object.fromEntries(keys.filter(k => plain(v) && Object.hasOwn(v, k)).map(k => [k, v[k]]));

export class SimulationError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'SimulationError'; this.code = code; this.status = status; }
}
function requireShape(value, keys) {
  if (!plain(value) || Object.keys(value).some(k => !keys.includes(k))) throw new SimulationError('invalid_fields');
}
function bounded(value) {
  const queue = [{ value, depth: 0 }], seen = new Set();
  let nodes = 0;
  while (queue.length) {
    const next = queue.pop();
    if (++nodes > 40000 || next.depth > 14) throw new SimulationError('simulation_too_large', 413);
    if (next.value && typeof next.value === 'object') {
      if (seen.has(next.value)) throw new SimulationError('invalid_capture');
      seen.add(next.value);
      for (const [key, v] of Object.entries(next.value)) {
        if (dangerous.has(key)) throw new SimulationError('invalid_fields');
        queue.push({ value: v, depth: next.depth + 1 });
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > SIMULATOR_LIMITS.bodyBytes) throw new SimulationError('simulation_too_large', 413);
}
export function validateSimulationInput(value) {
  bounded(value);
  requireShape(value, ['model', 'modality', 'contextTokens', 'outputTokens', 'requiredCapabilities', 'preferredConnectionId', 'strictPreferredConnection', 'excludedConnectionIds', 'taskClass', 'agentRole', 'cascadeMode']);
  if (value.cascadeMode !== undefined && !['unknown', 'exploration', 'non-exploration', 'escalated'].includes(value.cascadeMode)) throw new SimulationError('invalid_cascade_mode');
  if (value.taskClass !== undefined && !['simple', 'coding', 'reasoning'].includes(value.taskClass)) throw new SimulationError('invalid_task_class');
  if (value.agentRole !== undefined && !['parent', 'sub', 'unknown'].includes(value.agentRole)) throw new SimulationError('invalid_agent_role');
  if (!identifier(value.model)) throw new SimulationError('invalid_model');
  if (value.modality !== undefined && !MODALITIES.includes(value.modality)) throw new SimulationError('invalid_modality');
  for (const key of ['contextTokens', 'outputTokens']) if (value[key] !== undefined && (count(value[key]) === null || value[key] > 100000000)) throw new SimulationError('invalid_token_count');
  const required = value.requiredCapabilities ?? [];
  if (!Array.isArray(required) || required.length > 12 || new Set(required).size !== required.length || required.some(k => !CAPABILITY_FIELDS.includes(k) || ['contextWindow', 'maxOutput'].includes(k))) throw new SimulationError('invalid_capabilities');
  if (value.preferredConnectionId !== undefined && !identifier(value.preferredConnectionId, 128)) throw new SimulationError('invalid_connection_id');
  if (value.strictPreferredConnection !== undefined && typeof value.strictPreferredConnection !== 'boolean') throw new SimulationError('invalid_strict_preference');
  if (value.strictPreferredConnection && !value.preferredConnectionId) throw new SimulationError('invalid_strict_preference');
  const excluded = value.excludedConnectionIds ?? [];
  if (!Array.isArray(excluded) || excluded.length > SIMULATOR_LIMITS.accounts || excluded.some(id => !identifier(id, 128)) || new Set(excluded).size !== excluded.length) throw new SimulationError('invalid_exclusions');
  return structuredClone(value);
}
export function projectSimulationAccount(account, model) {
  if (!identifier(account?.id, 128) || !identifier(account?.provider, 128)) throw new SimulationError('unrepresentable_account', 422);
  const enabledModels = account.providerSpecificData?.enabledModels;
  if (Array.isArray(enabledModels) && (enabledModels.length > SIMULATOR_LIMITS.models || enabledModels.some(m => !identifier(m)))) throw new SimulationError('unrepresentable_account_models', 422);
  const thresholds = Object.fromEntries(Object.entries(plain(account.quotaPauseThresholds) ? account.quotaPauseThresholds : {}).map(([key, v]) => [key, numericEvidence(v)]));
  const rawWindows = account.lastQuotaSnapshot?.windows;
  if (Object.keys(thresholds).length > SIMULATOR_LIMITS.windows || (Array.isArray(rawWindows) && rawWindows.length > SIMULATOR_LIMITS.windows)) throw new SimulationError('simulation_too_large', 413);
  const safeScope = (key) => typeof key === 'string' && key.length <= 160 && !/[\x00-\x1f\x7f@]|:\/\//.test(key) && !dangerous.has(key);
  if (Object.keys(thresholds).some(k => !safeScope(k))) throw new SimulationError('unrepresentable_quota', 422);
  const windows = Array.isArray(rawWindows) ? rawWindows.map(w => {
    if (!plain(w) || !safeScope(w.key)) throw new SimulationError('unrepresentable_quota', 422);
    return { key: w.key, ...(w.remainingPercentage === undefined ? {} : { remainingPercentage: percentageEvidence(w.remainingPercentage) }),
      resetAt: timestamp(w.resetAt), unlimited: w.unlimited === true };
  }) : [];
  const projected = {
    id: account.id, provider: account.provider, isActive: account.isActive === true,
    authType: ['oauth', 'access_token', 'apikey', 'api_key'].includes(account.authType) ? account.authType : null,
    ...(account.priority === undefined ? {} : { priority: typeof account.priority === 'string'
      ? numericEvidence(account.priority) ?? (account.priority.trim() === '' ? account.priority : 'unknown')
      : typeof account.priority === 'number' ? finite(account.priority) ?? 'unknown' : account.priority }), maxConcurrent: finite(account.maxConcurrent),
    providerSpecificData: { enabledModels: Array.isArray(enabledModels) ? [...enabledModels] : [] },
    quotaPauseThresholds: thresholds,
    lastQuotaSnapshot: account.lastQuotaSnapshot ? { windows, fetchedAt: timestamp(account.lastQuotaSnapshot.fetchedAt) } : null,
  };
  if (Object.hasOwn(projected, 'priority') && !(projected.priority === null || ['number', 'boolean'].includes(typeof projected.priority)
      || typeof projected.priority === 'string' && projected.priority.length <= 32)) throw new SimulationError('unrepresentable_priority', 422);
  for (const candidate of new Set([null, model])) {
    const lockKey = getModelLockKey(candidate), failureKey = getModelFailureKey(candidate);
    if (account[lockKey] !== undefined) projected[lockKey] = lockTimestamp(account[lockKey]);
    const failure = account[failureKey];
    if (plain(failure)) projected[failureKey] = { until: lockTimestamp(failure.until), status: numericEvidence(failure.status),
      clientErrorStatus: finite(failure.clientErrorStatus), failureClass: failure.failureClass
        ? ['quota', 'rate', 'transient', 'credential', 'capability', 'other'].includes(failure.failureClass) ? failure.failureClass : 'other'
        : failure.until === account[lockKey] ? classifyAccountFailure(failure.status, failure.message) : classifyAccountFailure(null, null) };
  }
  return projected;
}
function projectCapture(value) {
  const model = value?.scope?.model, provider = value?.scope?.provider;
  if (!identifier(model) || !identifier(provider, 128) || !identifier(value?.scope?.requestedModel)) throw new SimulationError('invalid_scope');
  if (!Array.isArray(value.accounts) || value.accounts.length > SIMULATOR_LIMITS.accounts || new Set(value.accounts.map(a => a?.id)).size !== value.accounts.length) throw new SimulationError('invalid_accounts');
  const accounts = value.accounts.map(a => projectSimulationAccount(a, model));
  if (!plain(value.disabledModels) || !plain(value.settings) || !plain(value.drains) || !plain(value.activeLoad)) throw new SimulationError('invalid_capture');
  const disabledModels = Object.fromEntries(Object.entries(value.disabledModels).map(([scope, models]) => {
    if (!identifier(scope) || !Array.isArray(models) || models.length > SIMULATOR_LIMITS.models || models.some(m => !identifier(m))) throw new SimulationError('invalid_disabled_models');
    return [scope, [...models]];
  }));
  const strategies = Object.fromEntries(Object.entries(value.settings.providerStrategies || {}).map(([id, strategy]) => {
    if (!identifier(id, 128)) throw new SimulationError('invalid_provider');
    return [id, { maxConcurrent: finite(strategy?.maxConcurrent) }];
  }));
  const disabledProviders = Object.fromEntries(Object.entries(value.settings.disabledProviders || {}).map(([id, flag]) => {
    if (!identifier(id, 128) || typeof flag !== 'boolean') throw new SimulationError('invalid_provider');
    return [id, flag];
  }));
  const nodes = value.providerNodes;
  if (!Array.isArray(nodes) || nodes.length > SIMULATOR_LIMITS.accounts) throw new SimulationError('invalid_nodes');
  const providerNodes = nodes.map(node => {
    if (!identifier(node?.id, 128) || !identifier(node?.prefix, 128) || !identifier(node?.type, 128)) throw new SimulationError('invalid_node');
    return pick(node, ['id', 'prefix', 'type']);
  });
  const pin = value.pin ? pick(value.pin, ['connectionId', 'pinnedAt', 'expiresAt']) : null;
  if (pin && (!identifier(pin.connectionId, 128) || (pin.pinnedAt !== null && !timestamp(pin.pinnedAt)) || (pin.expiresAt !== null && !timestamp(pin.expiresAt)))) throw new SimulationError('invalid_pin');
  const drains = {}, activeLoad = {};
  for (const account of accounts) {
    drains[account.id] = value.drains[account.id] === true;
    const load = value.activeLoad[account.id];
    if (!plain(load) || count(load.pins) === null || count(load.inFlight) === null) throw new SimulationError('invalid_load');
    activeLoad[account.id] = { pins: load.pins, inFlight: load.inFlight };
  }
  const caps = Object.fromEntries(CAPABILITY_FIELDS.map(key => [key, ['contextWindow', 'maxOutput'].includes(key)
    ? finite(value.capabilities?.[key]) : typeof value.capabilities?.[key] === 'boolean' ? value.capabilities[key] : null]));
  const document = assertRoutingDocument(value.configuration?.document);
  if (value.configuration?.scope !== CONFIG_SCOPE || value.configuration.currentHash !== configHash(document)) throw new SimulationError('invalid_configuration_hash');
  if (!['captured-session', 'assumed-new-session'].includes(value.affinitySource)) throw new SimulationError('invalid_affinity');
  if (value.affinitySource === 'assumed-new-session' && pin) throw new SimulationError('invalid_affinity');
  const capturedAt = timestamp(value.capturedAt);
  if (!capturedAt || Date.parse(capturedAt) <= 0) throw new SimulationError('invalid_capture_time');
  return { version: SIMULATOR_VERSION, policyVersion: SELECTION_POLICY_VERSION, capturedAt,
    scope: { requestedModel: value.scope.requestedModel, provider, model }, accounts, disabledModels, providerNodes,
    settings: { disabledProviders, providerStrategies: strategies }, drains, activeLoad, pin,
    affinitySource: value.affinitySource, capabilities: caps,
    configuration: { scope: CONFIG_SCOPE, currentHash: value.configuration.currentHash, document } };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function createRoutingCapture(state) {
  bounded(state);
  const capture = projectCapture(state);
  const sealed = { ...capture, captureId: configHash(capture) };
  bounded(sealed);
  return freeze(sealed);
}
export function validateRoutingCapture(value) {
  bounded(value);
  if (value?.version !== SIMULATOR_VERSION || value?.policyVersion !== SELECTION_POLICY_VERSION) throw new SimulationError('unsupported_capture_version');
  const projected = createRoutingCapture(value);
  if (configHash(projected) !== configHash(value)) throw new SimulationError('capture_integrity_mismatch');
  return projected;
}

export function validateSimulation({ capture, input, draft } = {}) {
  const state = validateRoutingCapture(capture), request = validateSimulationInput(input);
  if (request.model !== state.scope.requestedModel) throw new SimulationError('capture_model_mismatch');
  let draftPreview = null;
  if (draft !== undefined) {
    requireShape(draft, ['version', 'expectedCurrent', 'document', 'draftId', 'revision']);
    if (draft.version !== 1 || draft.expectedCurrent !== state.configuration.currentHash) throw new SimulationError('draft_capture_mismatch', 409);
    if (draft.draftId !== undefined && !identifier(draft.draftId, 128)) throw new SimulationError('invalid_draft');
    if (draft.revision !== undefined && (!Number.isSafeInteger(draft.revision) || draft.revision < 1)) throw new SimulationError('invalid_draft');
    const document = assertRoutingDocument(draft.document);
    draftPreview = { version: 1, ...pick(draft, ['draftId', 'revision']), documentHash: configHash(document),
      ...validateRoutingDocument(document, { connections: state.accounts }),
      mode: 'declarative-only', accountSimulationAppliesDraft: false,
      limitations: ['Drafts are not activated or applied to the scoped account decision.', 'Combo execution, rotation, fusion, auto routing and capability-adapter topology require a wider route capture.'] };
  }
  return { state, request, draftPreview };
}

/** A captured-state account decision, never a prediction of successful generation. */
export function simulateRouting(args) {
  const { state, request, draftPreview } = validateSimulation(args);
  const { provider, model } = state.scope, now = Date.parse(state.capturedAt);
  const providerAliases = state.providerNodes.filter(n => n.id === provider).map(n => n.prefix);
  const exclusions = new Set(request.excludedConnectionIds || []);
  const optionsFor = account => ({ model, now, preferredConnectionId: request.preferredConnectionId,
    strictPreferredConnection: request.strictPreferredConnection === true, excluded: exclusions.has(account.id),
    disabled: isAccountModelDisabled(state.disabledModels, provider, model, account.id, providerAliases, state.providerNodes),
    draining: state.drains[account.id] });
  const inspected = state.accounts.map(account => {
    const reason = account.provider !== provider ? 'provider-mismatch' : !account.isActive ? 'account-disabled'
      : accountAdmissionReason(account, optionsFor(account)) ?? (getPausedWindow(account, now) ? 'quota-paused' : null);
    const windows = toRankerWindows(account.lastQuotaSnapshot, null, { now });
    const capacity = effectiveCapacity(account, { settings: state.settings, provider });
    return { account: { ...account, windows }, reason, capacity, load: state.activeLoad[account.id] };
  });
  const usable = inspected.filter(entry => !entry.reason);
  const livePin = state.pin?.expiresAt && Date.parse(state.pin.expiresAt) <= now ? null : state.pin;
  const pinned = state.accounts.find(a => a.id === livePin?.connectionId && a.isActive && a.provider === provider);
  const wait = pinned ? temporaryPinWait(pinned, optionsFor(pinned)) : null;
  const plan = planAccountSelection({ accounts: usable.map(e => e.account), pin: livePin, activeLoad: state.activeLoad, model, now });
  const preferred = request.preferredConnectionId ? usable.find(e => e.account.id === request.preferredConnectionId) : null;
  const orderedIds = preferred ? [preferred.account.id] : plan.preferred.map(r => r.id);
  const candidates = orderedIds.map((id, index) => {
    const entry = usable.find(e => e.account.id === id);
    return { connectionId: id, order: index + 1, atCapacity: entry.capacity.gated && entry.load.inFlight >= entry.capacity.limit,
      capacity: entry.capacity, activeLoad: entry.load, quotaEvidence: entry.account.windows.length ? 'persisted-percentage-snapshot' : 'unknown' };
  });
  const noAuth = isNoAuthProvider(provider);
  const noAuthDisabled = noAuth && (isProviderDisabled(state.settings, provider)
    || isAccountModelDisabled(state.disabledModels, provider, model, null, providerAliases, state.providerNodes));
  const chosen = wait || noAuth ? null : candidates.find(c => !c.atCapacity) ?? null;
  const reason = noAuth ? noAuthDisabled ? 'provider-or-model-disabled' : 'noauth-proxy-topology-unavailable'
    : wait ? 'temporary-pin-wait' : chosen ? preferred ? 'operator-pinned' : livePin?.connectionId === chosen.connectionId ? 'pinned' : livePin ? 'repin' : 'first-pin'
      : candidates.length ? 'at-capacity' : 'no-eligible-account';
  const missing = (request.requiredCapabilities || []).filter(key => state.capabilities[key] !== true);
  const cap = state.capabilities;
  return {
    version: SIMULATOR_VERSION, policyVersion: SELECTION_POLICY_VERSION, mode: 'offline-captured-state',
    receipt: { captureId: state.captureId, inputHash: configHash(request), configurationHash: state.configuration.currentHash,
      draftHash: draftPreview?.documentHash ?? null, capturedAt: state.capturedAt, captureAuthenticity: 'not-attested', sideEffects: false },
    requested: request, resolved: state.scope, served: null,
    localSelection: { connectionId: chosen?.connectionId ?? null, model, reason,
      status: chosen ? 'candidate' : wait || reason === 'at-capacity' ? 'wait' : noAuth && !noAuthDisabled ? 'unknown' : 'refused' },
    readiness: 'unknown', upstreamVerified: false,
    candidates, exclusions: [...inspected.filter(e => e.reason).map(e => ({ connectionId: e.account.id, reason: e.reason })),
      ...plan.ranked.filter(r => !r.usable && !orderedIds.includes(r.id)).map(r => ({ connectionId: r.id, reason: 'quota-window-excluded' }))],
    ranking: plan.ranked.map(r => ({ connectionId: r.id, usable: r.usable, hardBlocked: r.hardBlocked === true,
      reason: r.reason ?? null, selectedByAffinity: orderedIds.includes(r.id) && !r.usable })),
    affinity: { source: state.affinitySource, previousConnectionId: livePin?.connectionId ?? null,
      action: wait ? 'wait' : preferred ? 'operator-preference' : plan.repin.action,
      reason: wait ? 'temporary-pin-wait' : preferred ? 'operator-preference' : plan.repin.reason,
      retryAt: wait?.until ?? null, modelSubstitution: false },
    capabilityFit: { source: 'captured-gateway-capability-resolver', upstreamVerified: false,
      required: request.requiredCapabilities || [], missingOrUnknown: missing,
      contextFitsDeclaredWindow: request.contextTokens === undefined || cap.contextWindow === null ? null : request.contextTokens <= cap.contextWindow,
      outputFitsDeclaredLimit: request.outputTokens === undefined || cap.maxOutput === null ? null : request.outputTokens <= cap.maxOutput,
      modality: request.modality ?? 'chat', enforcedAsAccountGate: false, tokenCountSource: 'operator-supplied', capabilities: cap },
    unknownEvidence: ['proxy-readiness', 'credential-refresh-and-expiry', 'quota-memory-cache-and-refresh', 'provider-acceptance',
      'api-key-budget-and-model-access', 'provider-and-request-outer-admission', 'other-process-load', 'translation-and-shaping',
      ...(state.affinitySource === 'assumed-new-session' ? ['actual-session-affinity'] : []),
      ...(!['chat', 'embeddings', 'rerank'].includes(request.modality ?? 'chat') ? ['modality-dispatch-topology'] : [])],
    limitations: ['No provider call, quota refresh, lease, pin write, charge or configuration activation occurs.',
      'A candidate is only the local account decision on this capture; served stays null and dispatch readiness stays unknown.',
      'Capability and context fit are evidence, not hard account exclusions in the gateway.',
      'Quota windows use the persisted snapshot fallback. Live memory snapshots or refresh results can change the decision.',
      'Captures are content-addressed, not signed. Submitted capture state is operator-supplied evidence.',
      'Capture reads span repository and process-local state and are not a transactional snapshot.',
      'This scope excludes combo execution, fusion, rotation, virtual auto routing, naming compatibility and capability-adapter expansion.'],
    draftPreview,
  };
}
