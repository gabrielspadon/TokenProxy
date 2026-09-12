// Public API barrel — all DB functions
import { randomUUID } from "node:crypto";
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { decryptSecretJson, encryptSecretJson } from "./helpers/secretCol.js";
import { initializeBudgetAccount, validateBudgetPolicy } from "./repos/budgetRepo.js";

// Settings
export {
  getSettings, updateSettings, updateProviderStrategy,
  updateProviderStrategyProxyPoolSnapshotIfBound,
  isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  updateConnectionProxyPoolSnapshotIfBound,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode, deleteProviderNodeCascade,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, updateProxyPoolWithBoundSnapshots, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  getApiKeyUsage, getApiKeyUsageTotals, getExceededLimit,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Free-model catalogs (hourly sync from free-tier providers)
export {
  getFreeModels, getFreeModelsForProvider, setFreeModels,
} from "./repos/freeModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  trackActiveSession, getActiveSessions,
  saveRequestUsage, getUsageHistory, getUsageStats, getUsageStatsInRange, getChartData,
  getDailyConnectionUsage, appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
  isObservabilityEnabled,
} from "./repos/requestDetailsRepo.js";

// Seen models (New Models discovery)
export {
  getSeenModels, reconcileSeenModels, acknowledgeModels, countUnseenModels,
  seedSeenModels,
} from "./repos/seenModelsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...decryptSecretJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt,
      expiresAt: r.expiresAt, maxPromptTokens: r.maxPromptTokens, maxCompletionTokens: r.maxCompletionTokens, maxCostUsd: r.maxCostUsd, budgetPolicy: r.budgetPolicy })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

/**
 * The authType to store for an imported connection.
 *
 * A backup written by an older version can carry a connection with no authType,
 * and the column is NOT NULL, so something has to be chosen. Choosing "oauth"
 * unconditionally hands an API-key-only provider a mode it has no flow for —
 * cloudflare-ai and ollama both declare `authModes: ["apikey"]` — so the
 * restored connection is filed and counted as an OAuth account (#2968). Fall
 * back to what the provider actually supports; an authType already in the
 * payload is never second-guessed.
 */
export function importedAuthType(raw, provider, providers) {
  if (raw) return raw;
  const modes = providers?.[provider]?.authModes;
  if (Array.isArray(modes) && modes.length > 0 && !modes.includes("oauth")) {
    return modes.includes("apikey") ? "apikey" : modes[0];
  }
  return "oauth";
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();
  // Resolved before the transaction: db.transaction() is synchronous.
  let providerCatalog = {};
  try {
    ({ AI_PROVIDERS: providerCatalog } = await import("@/shared/constants/providers"));
  } catch { providerCatalog = {}; }

  db.transaction(() => {
    const existingKeys = new Map(db.all("SELECT * FROM apiKeys").map(k => [k.id, k]));
    const keysToImport = (payload.apiKeys || []).map(k => {
      const prior = existingKeys.get(k.id);
      const owner = db.get("SELECT id FROM apiKeys WHERE key=?", [k.key]);
      if (owner && owner.id !== k.id) throw new TypeError("Imported key material belongs to a different stable key ID");
      if (prior && prior.key !== k.key) {
        if (db.get("SELECT id FROM usageHistory WHERE apiKey=? LIMIT 1", [k.key])) throw new TypeError("Imported key material has ambiguous historical ownership");
        initializeBudgetAccount(db, prior);
      }
      // Older configuration exports omit limits. Preserve the local stable-ID
      // policy in that case rather than turning a capped key into unlimited.
      const merged = { ...prior, ...k };
      validateBudgetPolicy(merged.budgetPolicy ?? null);
      return merged;
    });
    // Replace the selected configuration tables within this transaction. Plain
    // INSERT rejects duplicate incoming identities instead of discarding rows.
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, importedAuthType(authType, provider, providerCatalog), name || null, email || null, priority || null, isActive === false ? 0 : 1, encryptSecretJson({...rest, credentialRevisionId:randomUUID()}), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of keysToImport) {
      db.run(
        `INSERT INTO apiKeys(id,key,name,machineId,isActive,createdAt,expiresAt,maxPromptTokens,maxCompletionTokens,maxCostUsd,budgetPolicy) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false || k.isActive === 0 ? 0 : 1, k.createdAt || new Date().toISOString(),
          k.expiresAt ?? null, k.maxPromptTokens ?? null, k.maxCompletionTokens ?? null, k.maxCostUsd ?? null, k.budgetPolicy ?? null]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
