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
