import { configurationDomainMutation } from '../../configuration/configurationDomains.js';
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { decryptSecretJson, encryptSecretJson } from "../helpers/secretCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  db.transaction(configurationDomainMutation(db, 'repo.proxyPools.create', () => upsert(db, pool)));
  return pool;
}

export async function updateProxyPool(id, data) {
  return updateProxyPoolWithBoundSnapshots(id, data);
}

function updateBoundConnectionSnapshotsInTx(db, proxyPoolId, strictProxy, now, transportChanged = false) {
  const rows = db.all(`SELECT id, data FROM providerConnections`);
  for (const row of rows) {
    const connectionData = decryptSecretJson(row.data, {});
    const providerSpecificData = connectionData.providerSpecificData;
    if (
      !providerSpecificData
      || typeof providerSpecificData !== "object"
      || Array.isArray(providerSpecificData)
      || providerSpecificData.proxyPoolId !== proxyPoolId
    ) {
      continue;
    }
    if (!transportChanged && providerSpecificData.strictProxy === strictProxy) continue;
    connectionData.credentialRevisionId = uuidv4();
    connectionData.providerSpecificData = {
      ...providerSpecificData,
      proxyPoolId,
      strictProxy,
    };
    db.run(
      `UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`,
      [encryptSecretJson(connectionData), now, row.id],
    );
  }
}

function updateBoundStrategySnapshotsInTx(db, proxyPoolId, strictProxy) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const current = row ? parseJson(row.data, {}) : {};
  const strategies = { ...(current.providerStrategies || {}) };
  let changed = false;
  for (const [providerId, strategy] of Object.entries(strategies)) {
    if (
      !strategy
      || typeof strategy !== "object"
      || Array.isArray(strategy)
      || strategy.proxyPoolId !== proxyPoolId
    ) {
      continue;
    }
    strategies[providerId] = { ...strategy, proxyPoolId, strictProxy };
    changed = true;
  }
  if (!changed) return;
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [stringifyJson({ ...current, providerStrategies: strategies })],
  );
}

// Strictness is part of a durable selected-pool pair. The pool, normal
// connections, and no-auth strategies must commit or roll back together.
export async function updateProxyPoolWithBoundSnapshots(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(configurationDomainMutation(db, 'repo.proxyPools.update', () => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const now = new Date().toISOString();
    const previous = rowToPool(row);
    const merged = { ...previous, ...data, updatedAt: now };
    merged.strictProxy = merged.strictProxy === true;
    upsert(db, merged);
    updateBoundConnectionSnapshotsInTx(db, id, merged.strictProxy, now, ["proxyUrl","noProxy","type","isActive","strictProxy"].some(key=>previous[key] !== merged[key]));
    updateBoundStrategySnapshotsInTx(db, id, merged.strictProxy);
    result = merged;
  }));
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(configurationDomainMutation(db, 'repo.proxyPools.update', () => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    updateBoundConnectionSnapshotsInTx(db, id, removed.strictProxy === true, new Date().toISOString(), true);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  }));
  return removed;
}
