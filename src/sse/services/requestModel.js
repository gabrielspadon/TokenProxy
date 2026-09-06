import { getModelInfo } from './model.js';
import { getProviderConnections } from '@/lib/localDb';

/** Settle the physical model before eligibility, quota checks or affinity. */
export async function resolveRequestModel(modelStr, { preferredConnectionId = null } = {}) {
  const bareDefault = modelStr === 'auto' || modelStr === 'default';
  let info;
  let unresolved = false;
  try {
    info = await getModelInfo(modelStr);
  } catch (error) {
    if (!bareDefault || error.code !== 'model_not_found') throw error;
    info = { provider: null, model: modelStr };
    unresolved = true;
  }
  // Explicit native provider/auto and aliases already naming a physical model
  // keep their resolved identifiers. A connection default cannot replace them.
  if (!bareDefault || info.model !== modelStr || (!info.provider && !unresolved)) return info;
  const connections = await getProviderConnections({
    isActive: true, ...(info.provider ? { provider: info.provider } : {}),
  });
  const candidates = preferredConnectionId
    ? connections.filter((connection) => connection.id === preferredConnectionId)
    : connections;
  const defaults = candidates.map((connection) => ({
    provider: connection.provider,
    model: typeof connection.defaultModel === 'string' ? connection.defaultModel.trim() : null,
  }));
  const first = defaults[0];
  if (!first?.model || defaults.some((entry) => !entry.model || entry.provider !== first.provider || entry.model !== first.model)
      || first.model === 'auto' || first.model === 'default') {
    return { error: 'Choose an explicit model; the configured account defaults do not identify one model.' };
  }
  return first;
}
