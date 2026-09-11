import { configurationDomainMutation, connectionDomainChange } from '../../configuration/configurationDomains.js';
import { credentialRevision, credentialContentRevision } from "../../../../open-sse/services/tokenRefresh/credentialRevision.js";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { decryptSecretJson, encryptSecretJson } from "../helpers/secretCol.js";
import { captureAccountControls } from "../../../shared/utils/accountControls.js";
import { deriveAccountDisplayName, normalizeAccountIdentity } from "../../oauth/providerHelpers.js";

// The non-secret identity a connection carries, folded onto one vocabulary.
//
// providerSpecificData is the OWNER of these values; the columns written by
// connToRow are a derived projection of it, kept so identity is queryable
// without decrypting every row. A codex row spells its upstream account id
// chatgptAccountId and its tier chatgptPlanType, so both spellings fold onto
// the shared names and one rule then covers every provider.
function connectionIdentity(conn) {
  const psd = conn?.providerSpecificData && typeof conn.providerSpecificData === "object"
    && !Array.isArray(conn.providerSpecificData) ? conn.providerSpecificData : {};
  return normalizeAccountIdentity({
    ...psd,
    accountId: psd.accountId || psd.chatgptAccountId,
    plan: psd.plan || psd.chatgptPlanType,
    email: conn?.email || psd.email,
  });
}

export async function notifyQuotaPolicyChange(id) {
  const state = global.__quotaAutoPing;
  if (!state?.queue) return true;
  try {
    const { notifyQuotaAccountChanged } = await import('../../../shared/services/quotaAutoPing.js');
    await notifyQuotaAccountChanged(id);
    return true;
  } catch {
    // The account write already committed. Revoke matching in-process work
    // if the inventory cannot be reconciled; never turn that into a false save refusal.
    if (state.activeCheck?.claim.connectionId === id) state.activeCheck.cancel('ownership-lost');
    console.warn('[AutoPing] account_reconciliation_failed');
    return false;
  }
}

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
  // Per-connection admission capacity (Account Scheduling Contract rule 7).
  // Resolved by src/shared/utils/accountCapacity.js; absent means the
  // documented default, 0 means explicitly ungated.
  "maxConcurrent",
];

function rowToConn(row) {
  if (!row) return null;
  const extra = decryptSecretJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  // Identity columns are a projection of providerSpecificData, which stays the
  // single owner inside the encrypted blob. Recomputed on every write so a
  // column can never drift from the blob it mirrors.
  const identity = connectionIdentity(c);
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    accountId: identity.accountId ?? null,
    plan: identity.plan ?? null,
    organizationId: identity.organizationId ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: encryptSecretJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const previous = rowToConn(db.get('SELECT * FROM providerConnections WHERE id = ?', [c.id]));
  if (!previous || credentialContentRevision(previous) !== credentialContentRevision(c)) c.credentialRevisionId = uuidv4();
  else if (previous.credentialRevisionId) c.credentialRevisionId = previous.credentialRevisionId;
  else delete c.credentialRevisionId;
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, accountId, plan, organizationId, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, accountId=excluded.accountId, plan=excluded.plan,
       organizationId=excluded.organizationId,
       priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.accountId, r.plan, r.organizationId,
     r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  // Identity captured at sign-in names the row, so a freshly added account is
  // labelled without anyone typing. A user-set name never reaches here: the
  // caller only asks for a derived one when `data.name` is empty.
  const derived = deriveAccountDisplayName({
    identity: connectionIdentity(data),
    providerLabel: data.provider || "Account",
    connectionId: data.id,
  });
  // deriveAccountDisplayName always answers, falling back to a provider label.
  // Prefer the caller's fallback (the email, or "Account N") when identity
  // carried nothing, so a provider that captures none behaves as it did.
  return derived === (data.provider || "Account") ? fallbackName : derived;
}

// A credential that has just been reissued makes every record of the old one's
// failure wrong: the backoff, the rate-limit window and the per-model locks were
// all written about a token that no longer exists.
function clearReauthFailureState(conn) {
  for (const field of [
    "lastError",
    "lastErrorAt",
    "errorCode",
    "backoffLevel",
    "rateLimitedUntil",
  ]) {
    delete conn[field];
  }
  for (const field of Object.keys(conn)) {
    if (field.startsWith("modelLock_") || field.startsWith("modelFailure_")) delete conn[field];
  }
  return conn;
}

function mergeCodexReauthorization(existing, data, now) {
  return clearReauthFailureState({
    ...existing,
    ...data,
    updatedAt: now,
    isActive: true,
    testStatus: "active",
  });
}

// The fields that ARE the credential (#1851). Everything else on the row — the
// id, the priority that fixes the account's place in the fallback order, the
// name, defaultModel, tags, and the proxy binding inside providerSpecificData —
// is exactly what re-authenticating currently destroys, so none of it is here.
const CREDENTIAL_FIELDS = [
  "accessToken", "refreshToken", "idToken", "apiKey",
  "expiresAt", "expiresIn", "tokenType", "scope", "projectId", "lastRefreshAt",
];

// Proxy policy is written by /api/providers/[id] and by the pool snapshot writer,
// never by a sign-in, so a re-auth must not carry these even if a caller sends them.
const PROXY_BOUND_KEYS = [
  "proxyPoolId", "strictProxy", "connectionProxyMode",
  "connectionProxyEnabled", "connectionProxyUrl", "connectionNoProxy",
];

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Apply a freshly issued credential to a connection that already exists (#1851).
 *
 * Re-authenticating used to mean deleting the account and adding it again, which
 * threw away its order, its proxy binding and its metadata. This writes the new
 * credential onto the row that already holds all of that, so the only thing that
 * changes is the credential.
 *
 * Refuses rather than writes when the target is missing, when it belongs to a
 * different provider, when the payload carries no usable credential (a malformed
 * or empty sign-in result must never blank a working one), or when the caller
 * signed in as a visibly different account. That last one is overridable with
 * `force`, because an account can legitimately change its email address.
 *
 * providerSpecificData is merged key by key, not replaced: a sign-in that reports
 * only chatgptAccountId cannot be allowed to drop proxyPoolId.
 *
 * @returns {{ok: true, connection: object} | {ok: false, code: string}} — the code
 * is one of not_found / provider_mismatch / empty_credential / identity_mismatch.
 * No credential value ever reaches a code, a message or a log line.
 */
export async function reauthorizeProviderConnection(id, data = {}) {
  const db = await getAdapter();
  let outcome = { ok: false, code: "not_found" };
  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToConn(row);

    if (data.provider && data.provider !== existing.provider) {
      outcome = { ok: false, code: "provider_mismatch" };
      return;
    }

    const credentials = {};
    for (const f of CREDENTIAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) credentials[f] = data[f];
    }
    if (!credentials.accessToken && !credentials.refreshToken && !credentials.apiKey) {
      outcome = { ok: false, code: "empty_credential" };
      return;
    }

    const incomingEmail = trimmed(data.email).toLowerCase();
    const existingEmail = trimmed(existing.email).toLowerCase();
    if (data.force !== true && incomingEmail && existingEmail && incomingEmail !== existingEmail) {
      outcome = { ok: false, code: "identity_mismatch" };
      return;
    }

    const incomingPsd = data.providerSpecificData && typeof data.providerSpecificData === "object"
      && !Array.isArray(data.providerSpecificData) ? { ...data.providerSpecificData } : {};
    for (const key of PROXY_BOUND_KEYS) delete incomingPsd[key];
    const existingPsd = existing.providerSpecificData && typeof existing.providerSpecificData === "object"
      && !Array.isArray(existing.providerSpecificData) ? existing.providerSpecificData : {};
    const providerSpecificData = { ...existingPsd, ...incomingPsd };

    const merged = clearReauthFailureState({
      ...existing,
      ...credentials,
      ...(trimmed(data.authType) ? { authType: trimmed(data.authType) } : {}),
      ...(incomingEmail ? { email: data.email } : {}),
      ...(Object.keys(providerSpecificData).length ? { providerSpecificData } : {}),
      isActive: true,
      testStatus: "active",
      updatedAt: new Date().toISOString(),
    });
    upsert(db, merged);
    outcome = { ok: true, connection: merged };
  }));
  if (outcome?.ok) await notifyQuotaPolicyChange(id);
  return outcome;
}

// P-F1: rows are re-decrypted on every read (AES-GCM per row per request,
// inside the serialized selection queue), yet connection rows change only when
// a credential is reissued or an operator edits one. Cache the decrypted object
// keyed on the FULL raw row: any write to any column changes the fingerprint,
// so every writer — this repo, the proxy-pool snapshot writer, a node delete —
// invalidates without per-writer hooks. structuredClone on a hit keeps the
// return value as fresh as a re-decrypt, so callers can mutate freely.
const decryptedRowCache = new Map();
const decryptedRowCacheStats = { hits: 0, misses: 0 };

function cachedRowToConn(row) {
  if (!row) return null;
  const fingerprint = JSON.stringify(row);
  const hit = decryptedRowCache.get(row.id);
  if (hit && hit.fingerprint === fingerprint) {
    decryptedRowCacheStats.hits += 1;
    return structuredClone(hit.conn);
  }
  decryptedRowCacheStats.misses += 1;
  const conn = rowToConn(row);
  decryptedRowCache.set(row.id, { fingerprint, conn });
  return conn;
}

// Test-only: observe cache behavior without reaching into the module.
export function _connectionsCacheStats() {
  return { ...decryptedRowCacheStats, size: decryptedRowCache.size };
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(cachedRowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return cachedRowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    const tDiff = new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    if (tDiff !== 0) return tDiff;
    // Total order, or renumbering is not deterministic. Reordering the list in
    // the dashboard writes adjacent rows in quick succession, so two of them
    // routinely carry the SAME updatedAt to the millisecond; with only the two
    // keys above, which one landed first decided the result, and dragging a row
    // could leave the list in an order nobody chose (#1181). The id is the only
    // value here that is unique and does not change, so it settles the tie the
    // same way on every run without disturbing the recency preference above it.
    return String(a.id).localeCompare(String(b.id));
  });
  list.forEach((c, i) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, c.id]);
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const all = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      const incomingAccountId = connectionIdentity(data).accountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // An upstream account id settles identity before any per-provider rule
        // gets a say. One login routinely holds SEVERAL seats - a personal seat
        // and an organisation seat - sharing an email while holding independent
        // quota windows, so matching on email alone collapses two real accounts
        // into one row and destroys the first one's token pair. A different id
        // means a different account, full stop; the same id is the same account
        // re-authenticating.
        const existingAccountId = connectionIdentity(c).accountId;
        if (incomingAccountId && existingAccountId) {
          return incomingAccountId === existingAccountId;
        }
        // Only one side knows its id. The other predates identity capture, so
        // they cannot be proven the same account and must not be merged on the
        // email they happen to share.
        if (incomingAccountId || existingAccountId) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      // #917: matching on the name ALONE overwrote the first account whenever a
      // second key arrived under the same one, and the name is routinely not
      // something the operator chose — POST /api/providers falls back to the
      // provider's display name when the form sends none, so every key added for
      // that provider carried the same one. The write reported success and the
      // list never grew, because there was still exactly one row.
      //
      // The credential is what makes two rows the same connection: re-saving the
      // same key still updates in place, a different key is a different account.
      // Empty matches empty, so a credential-less compatible endpoint (#1523)
      // does not pile up a row per save.
      const incomingKey = data.apiKey || "";
      existing = all.find(c => c.authType === "apikey" && c.name === data.name
        && (c.apiKey || "") === incomingKey);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      const merged = data.provider === "codex" && data.authType === "oauth" && data.accessToken
        ? mergeCodexReauthorization(existing, data, now)
        : { ...existing, ...data, updatedAt: now };
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${all.length + 1}`);
      // #1172: one Codex account can hold a subscription in several workspaces,
      // and each workspace is its own grant. The dedup above already keeps them
      // in separate rows — they differ by chatgptAccountId — but the derived
      // name is only the email, so connection management showed two identically
      // labelled rows with nothing to tell them apart. The workspace id is the
      // one value that actually differs, so it is what disambiguates them.
      const workspaceId = data.providerSpecificData?.chatgptAccountId;
      if (workspaceId && all.some((c) => c.name === connectionName)) {
        connectionName = `${connectionName} (${String(workspaceId).slice(-6)})`;
      }
    }
    // The other half of #917. Two API keys saved under one name are two rows now
    // instead of one overwritten row, but a list showing the same label twice
    // does not tell the operator which row to edit or delete. Same intent as the
    // workspace suffix above, applied where the collision comes from a form
    // default rather than from a shared email. OAuth rows keep the name their
    // caller chose (#1172) and are not renumbered here.
    if (data.authType === "apikey" && connectionName && all.some((c) => c.name === connectionName)) {
      let suffix = 2;
      while (all.some((c) => c.name === `${connectionName} ${suffix}`)) suffix += 1;
      connectionName = `${connectionName} ${suffix}`;
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    reorderInTx(db, data.provider);
    result = conn;
  }));

  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data, { expectedControls, expectedCredentials, signal } = {}) {
  const db = await getAdapter();
  let result;
  let quotaPolicyChanged = false;
  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    signal?.throwIfAborted();
    if (expectedCredentials !== undefined && credentialRevision(existing) !== credentialRevision(expectedCredentials)) {
      throw Object.assign(new Error("Credentials changed during refresh; reload before retrying"), {code:"CREDENTIAL_CONFLICT"});
    }
    if (expectedControls !== undefined
        && JSON.stringify(captureAccountControls(existing)) !== JSON.stringify(captureAccountControls(expectedControls))) {
      throw Object.assign(new Error("Account controls changed; reload before saving"), { code: "CONTROL_CONFLICT" });
    }
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    quotaPolicyChanged = ['isActive', 'authType', 'provider'].some(key => merged[key] !== existing[key]);
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = data.priority !== undefined
      ? rowToConn(db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]))
      : merged;
  }, () => connectionDomainChange(db, id, data)));
  if (quotaPolicyChanged) await notifyQuotaPolicyChange(id);
  return result;
}

// Atomically merges a narrow connection patch with the current encrypted data.
// This prevents an asynchronous caller from replacing provider-specific state
// written by a concurrent proxy or credential update.
export async function mergeProviderConnectionData(id, { name, providerSpecificData } = {}) {
  const db = await getAdapter();
  let result = null;
  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToConn(row);
    const existingData = existing.providerSpecificData;
    const patchData = providerSpecificData;
    const merged = {
      ...existing,
      ...(name !== undefined ? { name } : {}),
      providerSpecificData: {
        ...(existingData && typeof existingData === "object" && !Array.isArray(existingData) ? existingData : {}),
        ...(patchData && typeof patchData === "object" && !Array.isArray(patchData) ? patchData : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    upsert(db, merged);
    result = merged;
  }));
  return result;
}

// Conditional ownership prevents a migration writer from overwriting a newer
// user-selected pool that raced with its read.
export async function updateConnectionProxyPoolSnapshotIfBound(id, expectedPoolId, pair) {
  const db = await getAdapter();
  let result = null;
  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToConn(row);
    const providerSpecificData = existing.providerSpecificData;
    if (
      !providerSpecificData
      || typeof providerSpecificData !== "object"
      || Array.isArray(providerSpecificData)
      || providerSpecificData.proxyPoolId !== expectedPoolId
    ) {
      return;
    }
    const updated = {
      ...existing,
      providerSpecificData: {
        ...providerSpecificData,
        proxyPoolId: pair.proxyPoolId,
        strictProxy: pair.strictProxy === true,
      },
      updatedAt: new Date().toISOString(),
    };
    upsert(db, updated);
    result = updated;
  }));
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  }));
  if (ok) await notifyQuotaPolicyChange(id);
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const ids = db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const rows = db.all('SELECT id FROM providerConnections WHERE provider = ?', [providerId]);
    db.run('DELETE FROM providerConnections WHERE provider = ?', [providerId]);
    return rows.map(row => row.id);
  }));
  for (const id of ids) await notifyQuotaPolicyChange(id);
  return ids.length;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => reorderInTx(db, providerId)));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(configurationDomainMutation(db, 'repo.connections.update', () => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  }));
  return cleaned;
}

// ─── System state (read-only) ────────────────────────────────────────────────
// Backs the upstream counts of GET /api/system/state.
//
// The degraded signals (testStatus, errorCode, rateLimitedUntil) live inside the
// encrypted `data` blob, so no SQL predicate can reach them and no index can
// cover them. Everything below is therefore a full SCAN of providerConnections
// — a table of tens of rows, sized by how many accounts the operator
// configured, not by traffic.
const DEGRADED_TEST_STATUS = new Set(["error", "expired", "unavailable"]);
const MAX_DEGRADED_PROVIDERS = 12;

// The same vocabulary the providers page already treats as unhealthy, plus the
// fields src/sse/services/auth.js writes when an upstream rejects a request.
export function isConnectionDegraded(conn, now = Date.now()) {
  if (!conn) return false;
  if (DEGRADED_TEST_STATUS.has(conn.testStatus)) return true;
  if (conn.errorCode) return true;
  const until = conn.rateLimitedUntil ? new Date(conn.rateLimitedUntil).getTime() : NaN;
  return Number.isFinite(until) && until > now;
}

// Only stable state classes leave the repository. Account names, connection
// IDs, error messages and upstream responses are credential-adjacent and do
// not belong in a shell-level polling payload.
function degradationCause(conn, now) {
  const until = conn.rateLimitedUntil ? new Date(conn.rateLimitedUntil).getTime() : NaN;
  const errorCode = Number(conn.errorCode);
  if ((Number.isFinite(until) && until > now) || errorCode === 429) return "rate_limited";
  if (conn.testStatus === "expired" || errorCode === 401 || errorCode === 403) {
    return "authentication";
  }
  if (conn.testStatus === "unavailable") return "unavailable";
  if (conn.testStatus === "error") return "connection_test";
  return "upstream_error";
}

// `connected` counts enabled connections. `degraded` counts persisted failures
// across every configured connection, including an auth failure that disabled
// itself to protect routing. Hiding that row would erase the recovery signal.
//
// Deliberately NOT getProviderConnections(): that decrypts every row's `data`
// blob, and decryptSecretJson re-derives its key through machineIdSync() on
// every call (~2.8ms measured), so a 46-account install pays ~130ms to build 40
// objects this count discards. The summary must decrypt disabled rows too,
// because permanent auth failures deliberately persist after auto-disable.
export async function getUpstreamHealthSummary(now = Date.now()) {
  const db = await getAdapter();
  const rows = db.all(`SELECT provider, isActive, data FROM providerConnections`);

  let degraded = 0;
  let connected = 0;
  const byProvider = new Map();
  for (const row of rows) {
    if (row.isActive === 1 || row.isActive === true) connected += 1;
    const connection = decryptSecretJson(row.data, {});
    if (!isConnectionDegraded(connection, now)) continue;
    degraded += 1;
    const provider = String(row.provider || "unknown");
    const summary = byProvider.get(provider) || {
      provider,
      degradedConnections: 0,
      likelyCauses: new Set(),
    };
    summary.degradedConnections += 1;
    summary.likelyCauses.add(degradationCause(connection, now));
    byProvider.set(provider, summary);
  }

  const degradedProviders = [...byProvider.values()]
    .sort((a, b) => b.degradedConnections - a.degradedConnections || a.provider.localeCompare(b.provider))
    .slice(0, MAX_DEGRADED_PROVIDERS)
    .map(({ provider, degradedConnections, likelyCauses }) => ({
      provider,
      degradedConnections,
      likelyCauses: [...likelyCauses].sort(),
    }));

  return {
    total: rows.length,
    connected,
    degraded,
    degradedProviders,
    degradedProviderCount: byProvider.size,
    degradedProvidersOmitted: Math.max(0, byProvider.size - degradedProviders.length),
  };
}

// Kept for narrow consumers that only need counts. The system-state endpoint
// uses the richer summary, so the encrypted rows are still scanned once.
export async function getUpstreamHealthCounts(now = Date.now()) {
  const { total, connected, degraded } = await getUpstreamHealthSummary(now);
  return { total, connected, degraded };
}
