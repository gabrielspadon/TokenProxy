import { normalizeCascadePairs } from '@/lib/stepRouter.js';
import { selectAutoModelFromCatalog } from '@/sse/services/autoRouter.js';
import { buildModelsList } from '@/app/api/v1/models/route.js';
import { GET as getModelAvailability } from '@/app/api/models/availability/route.js';
import { PROVIDER_ID_TO_ALIAS } from 'open-sse/config/providerModels.js';
import { getCapacityAdapterConfig, getCapacityAdapterModels } from 'open-sse/services/capacityAdapter.js';
import { normalizeClaudeModelName, stripContextSuffix, readClaudeCompat, buildClaudeRoutingIndex } from '@/lib/claudeCompat.js';
import { NO_AUTH_PROVIDER_IDS, resolveProviderId } from '@/shared/constants/providers.js';
import { createRoutePlanCapture, ROUTE_CAPTURE_TTL_MS } from '@/lib/routingPlanSimulation.js';
import { snapshotComboRotation } from 'open-sse/services/combo.js';
import { getConfigurationDraft } from '@/lib/db/repos/configVersionsRepo.js';
import { getProviderConnections } from '@/lib/db/repos/connectionsRepo.js';
import { getProviderNodes } from '@/lib/db/repos/nodesRepo.js';
import { getSettings } from '@/lib/db/repos/settingsRepo.js';
import { getDisabledModels } from '@/lib/db/repos/disabledModelsRepo.js';
import { getPin, countActivePins } from '@/lib/db/repos/sessionAffinityRepo.js';
import { getAdapter } from '@/lib/db/driver.js';
import { readRoutingConfig, configHash, CONFIG_SCOPE } from '@/lib/db/helpers/configHistory.js';
import { readAllDrainDocs } from './state.js';
import { resolveRequestModel } from '@/sse/services/requestModel.js';
import { AUTO_MODEL_IDS } from '@/sse/services/autoRouter.js';
import { leaseRegistry } from '@/sse/services/accountLeaseRegistry.js';
import { getCapabilitiesForModel } from 'open-sse/providers/capabilities.js';
import { createRoutingCapture, validateSimulationInput, SimulationError, SIMULATOR_LIMITS } from '@/lib/routingSimulation.js';

/** Read-only collector. Never imports credentials selection, quota refresh or executors. */
export async function captureRoutingState({ input, sessionHash } = {}) {
  const request = validateSimulationInput(input);
  if (sessionHash !== undefined && !/^[a-f0-9]{32,64}$/.test(sessionHash)) throw new SimulationError('invalid_session_hash');
  // The outer chat handler's virtual auto route and compatibility transforms
  // precede resolveRequestModel. A numeric request description cannot replay them.
  if (['auto', 'default'].includes(request.model) || AUTO_MODEL_IDS.has(request.model)) throw new SimulationError('unsupported_virtual_route', 422);
  let resolved;
  try { resolved = await resolveRequestModel(request.model, { preferredConnectionId: request.preferredConnectionId }); }
  catch (error) {
    if (error?.code === 'model_not_found') throw new SimulationError('unsupported_route_topology', 422);
    throw error;
  }
  if (!resolved?.provider || !resolved.model || resolved.error) throw new SimulationError('unsupported_route_topology', 422);
  const db = await getAdapter();
  const count = db.get('SELECT COUNT(*) AS count FROM providerConnections WHERE provider = ?', [resolved.provider])?.count ?? 0;
  if (count > SIMULATOR_LIMITS.accounts) throw new SimulationError('capture_account_limit', 413);
  const [accounts, providerNodes, settings, disabledModels, drainDocs] = await Promise.all([
    getProviderConnections({ provider: resolved.provider }), getProviderNodes(), getSettings(), getDisabledModels(), readAllDrainDocs(),
  ]);
  const now = new Date(), capturedAt = now.toISOString();
  const [pin, pins] = await Promise.all([
    sessionHash ? getPin(sessionHash, resolved.model, { now }) : null,
    countActivePins(resolved.model, { now }),
  ]);
  // No snapshot/version insertion. The hash is the same pure representation
  // used by configuration drafts, without invoking an activation or writer.
  const document = readRoutingConfig(db);
  const state = createRoutingCapture({ capturedAt,
    scope: { requestedModel: request.model, provider: resolved.provider, model: resolved.model },
    accounts, providerNodes: providerNodes.map(n => ({ id: n.id, prefix: n.prefix, type: n.type })),
    disabledModels,
    settings: { disabledProviders: settings.disabledProviders || {}, providerStrategies: Object.fromEntries(
      Object.entries(settings.providerStrategies || {}).map(([id, strategy]) => [id, { maxConcurrent: strategy.maxConcurrent ?? null }])) },
    drains: Object.fromEntries(accounts.map(a => [a.id, drainDocs[a.id]?.isDraining === true])),
    activeLoad: Object.fromEntries(accounts.map(a => [a.id, { pins: pins[a.id] ?? 0, inFlight: leaseRegistry.inFlight(a.id) }])),
    pin: pin ? { connectionId: pin.connectionId, pinnedAt: pin.pinnedAt ?? null, expiresAt: pin.expiresAt ?? null } : null,
    affinitySource: sessionHash ? 'captured-session' : 'assumed-new-session',
    capabilities: getCapabilitiesForModel(resolved.provider, resolved.model),
    configuration: { scope: CONFIG_SCOPE, currentHash: configHash(document), document },
  });
  return { capture: state, input: request, coverage: { scope: 'single-physical-model-account-admission',
    atomicAcrossStores: false, processLocalLoad: true, quotaSource: 'persisted-fallback',
    sessionIdentifierIncluded: false, providerCalls: 0, writes: 0,
    limitations: ['Read acquisition spans repository and process-local state. It is not an atomic cross-store snapshot.',
      'State after capture, runtime quota cache, proxy topology and outer request admission are not captured.'] } };
}

/** Wider read-only envelope. Existing physical collector remains the fleet boundary. */
export async function captureRoutePlanState({ input, sessionHash, draft } = {}) {
  const request = validateSimulationInput(input);
  if (sessionHash !== undefined && !/^[a-f0-9]{32,64}$/.test(sessionHash)) throw new SimulationError('invalid_session_hash');

  const db = await getAdapter(), document = readRoutingConfig(db), currentHash = configHash(document);
  const version = db.get("SELECT id FROM configVersions WHERE scope = ? AND contentHash = ? AND kind != 'draft' ORDER BY id DESC LIMIT 1", [CONFIG_SCOPE, currentHash]);
  const capturedAt = new Date().toISOString();
  const settings = await getSettings();
  const chat = (request.modality || 'chat') === 'chat';
  let requestedModel = chat ? stripContextSuffix(request.model) : request.model;
  if (chat && process.env.DISABLE_CLAUDE_COMPAT !== 'true' && readClaudeCompat(settings).enabled) requestedModel = normalizeClaudeModelName(requestedModel, await buildClaudeRoutingIndex());
  const runtime = await captureRuntimePolicy(settings, requestedModel);
  let auto = null;
  if (chat && AUTO_MODEL_IDS.has(requestedModel) && !document.combos.some(c => c.name === requestedModel || c.name === requestedModel.split('/').pop())) {
    if (!request.taskClass) throw new SimulationError('auto_task_class_required', 422);
    const catalog = await buildModelsList(['llm'], { localOnly: true });
    const availability = await getModelAvailability(), blockedModels = new Set(), blockedProviders = new Set();
    if (!availability.ok) throw new SimulationError('availability_capture_unavailable', 503);
    for (const entry of (await availability.json()).models || []) {
      const alias = PROVIDER_ID_TO_ALIAS[entry.provider] || entry.provider;
      if (!entry.model || entry.model === '__all') { blockedProviders.add(alias); blockedProviders.add(entry.provider); }
      else { blockedModels.add(`${alias}/${entry.model}`); blockedModels.add(`${entry.provider}/${entry.model}`); }
    }
    auto = { models: catalog.map(m => ({ id: m.id, owned_by: m.owned_by })), blockedModels: [...blockedModels], blockedProviders: [...blockedProviders],
      rules: Object.fromEntries(Object.entries(settings.autoRouter?.rules || {}).filter(([key, value]) => ['simple', 'coding', 'reasoning'].includes(key) && typeof value === 'string')) };
  }

  let savedDraft = null;
  if (draft) {
    if (typeof draft.draftId !== 'string' || !Number.isSafeInteger(draft.revision)) throw new SimulationError('invalid_draft');
    const stored = await getConfigurationDraft(draft.draftId);
    if (stored.revision !== draft.revision || configHash(draft.document) !== stored.version.contentHash || stored.baseHash !== currentHash) throw new SimulationError('draft_revision_or_base_conflict', 409);
    savedDraft = { draftId: stored.id, revision: stored.revision, versionId: stored.version.id, expectedCurrent: currentHash, document: stored.version.document, documentHash: stored.version.contentHash };
  }
  const routes = {}, resolutions = {}, rotations = {}, references = new Set();
  for (const doc of [document, ...(savedDraft ? [savedDraft.document] : [])]) {
    const visited = new Set();
    const collect = reference => {
      if (visited.has(reference)) return;
      visited.add(reference);
      const combo = doc.combos.find(c => c.name === reference) || doc.combos.find(c => c.name === reference.split('/').pop());
      if (combo) {
        rotations[reference] = snapshotComboRotation(reference);
        combo.models.forEach(collect);
        const judge = doc.settings.comboStrategies?.[combo.name]?.judgeModel;
        if (judge) collect(judge);
      } else {
        const alias = doc.aliases[reference];
        references.add(typeof alias === 'string' ? alias : alias ? `${alias.provider}/${alias.model}` : reference);
      }
    };
    collect(requestedModel);
    getCapacityAdapterModels(runtime).forEach(collect);
    for (const pair of runtime.cascadePairs) if (pair.strong === requestedModel) collect(pair.cheap);
    if (auto) for (const taskClass of ['simple', 'coding', 'reasoning']) {
      const selected = selectAutoModelFromCatalog(taskClass, auto.models, { models: new Set(auto.blockedModels), providers: new Set(auto.blockedProviders) }, { autoRouter: { rules: auto.rules } });
      if (selected) collect(selected.model);
    }
    rotations[requestedModel] = snapshotComboRotation(requestedModel);
  }
  if (references.size > 512) throw new SimulationError('simulation_too_large', 413);
  for (const reference of references) {
    let resolved;
    try { resolved = await resolveRequestModel(reference); } catch (error) { if (error?.code !== 'model_not_found') throw error; }
    if (!resolved?.provider || !resolved.model || resolved.error) { resolutions[reference] = null; continue; }
    const key = `${resolved.provider}/${resolved.model}`;
    resolutions[reference] = key;
    if (routes[key]) continue;
    if (Object.keys(routes).length >= 64) throw new SimulationError('capture_route_limit', 413);
    // The resolved provider id prevents a prefix shadow from changing this target.
    const physical = await captureRoutingState({ input: { ...request, model: key }, sessionHash });
    routes[key] = physical.capture;
  }
  const sessions = [];
  for (const [route, capture] of Object.entries(routes)) {
    if (!capture.accounts.length) continue;
    const rows = db.all(`SELECT sessionHash, model, connectionId, pinnedAt, expiresAt FROM sessionAffinity WHERE model = ? AND connectionId IN (${capture.accounts.map(() => '?').join(',')}) ORDER BY sessionHash LIMIT 201`, [capture.scope.model, ...capture.accounts.map(a => a.id)]);
    for (const row of rows) {
      if (!capture.accounts.some(account => account.id === row.connectionId)) continue;
      sessions.push({ sessionId: configHash({ sessionHash: row.sessionHash }), route, connectionId: row.connectionId, pinnedAt: row.pinnedAt, expiresAt: row.expiresAt ?? null });
      if (sessions.length > 200) throw new SimulationError('capture_session_limit', 413);
    }
  }
  // Refuse mixed configuration acquisition, including a draft edited while collecting.
  if (configHash(readRoutingConfig(db)) !== currentHash) throw new SimulationError('capture_configuration_changed', 409);
  if (savedDraft && (await getConfigurationDraft(savedDraft.draftId)).revision !== savedDraft.revision) throw new SimulationError('draft_revision_or_base_conflict', 409);
  const capture = createRoutePlanCapture({ capturedAt, expiresAt: new Date(Date.parse(capturedAt) + ROUTE_CAPTURE_TTL_MS).toISOString(), scope: { requestedModel: request.model },
    configuration: { document, currentHash, versionId: version?.id ?? null }, draft: savedDraft, routes, resolutions, rotations, sessions, runtime, auto,
    sessionCoverage: 'complete-for-captured-physical-models' });
  return { capture, input: request, coverage: { scope: 'ordered-route-draft-session-plan', providerCalls: 0, writes: 0, atomicAcrossStores: false } };
}

export async function assertRouteCaptureFresh(capture) {
  if (Date.now() > Date.parse(capture.expiresAt)) throw new SimulationError('capture_expired', 409);
  if (Date.now() + 5000 < Date.parse(capture.capturedAt)) throw new SimulationError('capture_from_future', 409);
  const db = await getAdapter();
  if (configHash(readRoutingConfig(db)) !== capture.configuration.currentHash) throw new SimulationError('capture_configuration_stale', 409);
  if (configHash(await captureRuntimePolicy(await getSettings(), capture.runtime.requestedModel)) !== configHash(capture.runtime)) throw new SimulationError('capture_runtime_policy_stale', 409);
  if (capture.auto) {
    const rules = Object.fromEntries(Object.entries((await getSettings()).autoRouter?.rules || {}).filter(([key, value]) => ['simple', 'coding', 'reasoning'].includes(key) && typeof value === 'string'));
    if (configHash(rules) !== configHash(capture.auto.rules)) throw new SimulationError('capture_runtime_policy_stale', 409);
  }
  if (capture.draft) {
    const draft = await getConfigurationDraft(capture.draft.draftId);
    if (draft.revision !== capture.draft.revision || draft.currentVersionId !== capture.draft.versionId || draft.version.contentHash !== capture.draft.documentHash) throw new SimulationError('capture_draft_stale', 409);
  }
}

async function captureRuntimePolicy(settings, requestedModel) {
  const reachable = new Set(NO_AUTH_PROVIDER_IDS);
  for (const account of await getProviderConnections()) if (account.isActive !== false && account.provider) reachable.add(resolveProviderId(account.provider));
  return { requestedModel,
    cascadePairs: [...normalizeCascadePairs(settings.cascadePairs)].map(([strong, cheap]) => ({ strong, cheap })),
    capacityAdapter: Object.fromEntries(['vision', 'pdf', 'audioInput', 'videoInput'].map(cap => [cap, getCapacityAdapterConfig(cap, settings)])),
    agentRoles: Object.fromEntries(['parent', 'sub'].map(role => [role, Array.isArray(settings.agentRoles?.[role]) ? settings.agentRoles[role].filter(m => typeof m === 'string') : []])),
    reachableProviders: [...reachable].sort() };
}
