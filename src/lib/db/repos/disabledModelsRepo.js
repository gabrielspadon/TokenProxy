import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { resolveDisabledModelProvider } from '@/shared/utils/disabledModelPolicy.js';

const SCOPE = "disabledModels";

// Per-account (#1527) disables live under a second key shape, `alias::connectionId`,
// beside the provider-wide `alias` key that predates them. Two rules keep an
// existing install intact:
//   read  — a connection with no key of its own INHERITS the provider key, so
//           every set saved before this change keeps applying to every account.
//   write — a connection-scoped write never touches the provider key, so one
//           account's edit cannot re-enable a model for the other accounts.
// A connection's key is written as `[]` rather than deleted when its last model
// is re-enabled; deleting it would fall back to the provider set and silently
// re-disable what the operator just enabled.
const connKey = (providerAlias, connectionId) => `${providerAlias}::${connectionId}`;

function providerScope(db, provider) {
  const nodes = db.all(`SELECT id, type, data FROM providerNodes`).map((row) => ({
    ...parseJson(row.data, {}), id: row.id, type: row.type,
  }));
  const resolve = (value) => resolveDisabledModelProvider(value, nodes);
  const id = resolve(provider);
  const node = nodes.find((entry) => entry.id === id);
  const matches = (value) => resolve(value) === id;
  const preferredKey = node?.prefix || PROVIDER_ID_TO_ALIAS[id] || id;
  return {
    key: matches(preferredKey) ? preferredKey : id,
    matches,
    modelId(value) {
      if (typeof value !== 'string') return value;
      const slash = value.indexOf('/');
      return slash > 0 && (matches(value.slice(0, slash)) || node?.prefix === value.slice(0, slash))
        ? value.slice(slash + 1) : value;
    },
  };
}

function readScope(db, scope, connectionId = null) {
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const own = rows.filter(({ key }) => {
    const separator = key.indexOf('::');
    const provider = separator < 0 ? key : key.slice(0, separator);
    const connection = separator < 0 ? null : key.slice(separator + 2);
    return scope.matches(provider) && connection === connectionId;
  });
  const lists = own.map(({ value }) => parseJson(value, null)).filter(Array.isArray);
  const ids = lists.flatMap((list) => list.map(scope.modelId));
  return { keys: own.map(({ key }) => key), ids: [...new Set(ids)], present: lists.length > 0 };
}

function effectiveScope(db, scope, connectionId) {
  const own = readScope(db, scope, connectionId);
  return connectionId && !own.present ? readScope(db, scope) : own;
}

function writeScope(db, scope, connectionId, ids) {
  const { keys } = readScope(db, scope, connectionId);
  const key = connectionId ? connKey(scope.key, connectionId) : scope.key;
  // Retain legacy keys and reconcile their values in the operator's transaction.
  // No old key can override the edit, and unrelated accounts remain untouched.
  for (const target of new Set([...keys, key])) writeKey(db, target, ids);
}

function writeKey(db, key, ids) {
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, key, stringifyJson(ids)]
  );
}

// The whole disabled set, cached. Routing consults this on the request path now
// that a direct request for a disabled model is refused (#577), and combo member
// filtering already did per combo request, so an uncached read here is one SQL
// round trip per request. The set changes only when an operator toggles a model,
// which is why the writers below invalidate rather than the readers polling.
//
// The TTL is a backstop for a write that did not come through this process, not
// the primary freshness mechanism.
const CACHE_TTL_MS = 5000;
let cache = null;
let cachedAt = 0;
let cacheGeneration = 0;

export function invalidateDisabledModelsCache() {
  cache = null;
  cachedAt = 0;
  cacheGeneration += 1;
}

export async function getDisabledModels() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  const generation = cacheGeneration;
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, null);
  if (generation === cacheGeneration) {
    cache = out;
    cachedAt = Date.now();
  }
  return out;
}

// connectionId omitted → the provider-wide set. Given → that connection's own
// set, falling back to the provider-wide one when it has never been edited.
export async function getDisabledByProvider(providerAlias, connectionId = null) {
  const db = await getAdapter();
  return effectiveScope(db, providerScope(db, providerAlias), connectionId).ids;
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
export async function disableModels(providerAlias, ids, connectionId = null) {
  invalidateDisabledModelsCache();
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getAdapter();
  db.transaction(() => {
    const scope = providerScope(db, providerAlias);
    const current = effectiveScope(db, scope, connectionId).ids;
    writeScope(db, scope, connectionId, [...new Set([...current, ...ids.map(scope.modelId)])]);
  });
  invalidateDisabledModelsCache();
}

export async function enableModels(providerAlias, ids, connectionId = null) {
  invalidateDisabledModelsCache();
  if (!providerAlias) return;
  const db = await getAdapter();
  db.transaction(() => {
    const scope = providerScope(db, providerAlias);
    const current = effectiveScope(db, scope, connectionId).ids;
    const removeSet = new Set(Array.isArray(ids) ? ids.map(scope.modelId) : []);
    const next = removeSet.size ? current.filter((id) => !removeSet.has(id)) : [];
    writeScope(db, scope, connectionId, next);
  });
  invalidateDisabledModelsCache();
}
