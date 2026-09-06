import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { effectiveBudgetPolicy, BUDGET_POLICY_EXPLANATIONS, validateBudgetPolicy, initializeBudgetAccount, getRecordedBudgetExposure } from "./budgetRepo.js";

// A key's model allowlist lives in kv rather than in a column on apiKeys (#1154),
// the same way disabled models, free models and pricing already do. Every read
// below LEFT JOINs it in as `allowedModels`, so a key still arrives as one
// object and nothing outside this file knows where it is kept.
const ALLOWED_MODELS_SCOPE = "apiKeyModels";
const WITH_ALLOWED_MODELS = `SELECT a.*, m.value AS allowedModels
   FROM apiKeys a LEFT JOIN kv m ON m.scope = '${ALLOWED_MODELS_SCOPE}' AND m.key = a.id`;

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    // null means never expires, which is what every key issued before this
    // existed keeps (#2351).
    expiresAt: row.expiresAt || null,
    isExpired: isExpired(row.expiresAt),
    // null in any of these means no ceiling, which is what every key issued
    // before this existed keeps (#3371).
    maxPromptTokens: normalizeLimit(row.maxPromptTokens),
    maxCompletionTokens: normalizeLimit(row.maxCompletionTokens),
    maxCostUsd: normalizeLimit(row.maxCostUsd, false),
    budgetPolicy: row.budgetPolicy ?? null,
    effectiveBudgetPolicy: effectiveBudgetPolicy(row),
    budgetPolicyExplanation: BUDGET_POLICY_EXPLANATIONS[effectiveBudgetPolicy(row)],
    // null means every model, which is what every key issued before this
    // existed keeps (#1154).
    allowedModels: normalizeAllowedModels(row.allowedModels),
  };
}

// A key is expired once its stamp is in the past. An unparseable stamp is
// treated as NOT expired: refusing a key because its own metadata is malformed
// would lock an operator out of their gateway over a bad write, and the key can
// still be paused or deleted by hand.
export function isExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  return Number.isFinite(at) && at <= now;
}

// Accept an ISO string, a Date or a millisecond stamp, and store one shape.
// Anything unparseable becomes null, which is "never expires": a caller that
// fumbled the field must not silently get a key that dies at an arbitrary time.
function normalizeExpiry(value) {
  if (value === null || value === undefined || value === "") return null;
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// A ceiling is a non-negative number or nothing at all. Anything unparseable,
// and anything negative, becomes null — "no ceiling" — for the same reason an
// unparseable expiry does: a fumbled write must not silently give a key an
// arbitrary budget. Zero IS a real ceiling and freezes the key, which is a
// deliberate way to stop one without deleting it.
function normalizeLimit(value, integer = true) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return integer ? Math.floor(n) : n;
}

// An allowlist is a non-empty list of model ids, or nothing at all. It is taken
// as an array or as the JSON text of one, since that is what kv holds. Anything
// else — an empty list included — becomes null, "every model", for the same
// reason a fumbled ceiling becomes "no ceiling": this file's own write path is
// the only thing that produces the value, so a shape we did not write is
// corruption, and bricking a key over a bad read is worse than the restriction
// going unenforced until the operator sets it again.
function normalizeAllowedModels(value) {
  if (value === null || value === undefined || value === "") return null;
  const list = Array.isArray(value) ? value : parseJson(value, null);
  if (!Array.isArray(list)) return null;
  const cleaned = [...new Set(
    list.filter((m) => typeof m === "string").map((m) => m.trim()).filter(Boolean)
  )];
  return cleaned.length ? cleaned : null;
}

// Does `model` fall inside `allowed`? A client names a model in whichever form
// it knows — bare ("gpt-3.5-turbo") or provider-qualified ("openai/gpt-3.5-turbo")
// — and the issue's own example lists bare ids (#1154), so an unqualified entry
// admits the qualified request for the same model and the other way round. Two
// qualified names must match exactly, so "openai/gpt-4o" never admits
// "azure/gpt-4o".
//
// "<provider>/*" widens one entry to that provider's whole catalogue (#854).
// Without it, scoping a shared key to a provider meant naming every model that
// provider will ever offer, and a bare "openai" entry admitted only a model
// literally called "openai". The wildcard compares WHOLE segments, so
// "openai/*" never admits "openai-compatible-abc/gpt-4o", and it deliberately
// refuses an unqualified request: a bare "gpt-4o" names no provider, and
// guessing one at an authorization boundary is how a scope leaks. Search and
// fetch check a bare provider id rather than a model, so the provider segment
// answers those directly.
export function matchesAllowedModel(allowed, model) {
  if (!Array.isArray(allowed) || !allowed.length) return true;
  const want = String(model ?? "").trim().toLowerCase();
  if (!want) return false;
  const wantBare = want.split("/").pop();
  const wantProvider = want.includes("/") ? want.slice(0, want.indexOf("/")) : want;
  return allowed.some((raw) => {
    const entry = String(raw).trim().toLowerCase();
    if (entry === want) return true;
    if (entry.endsWith("/*")) return entry.slice(0, -2) === wantProvider;
    if (!entry.includes("/")) return entry === wantBare;
    if (!want.includes("/")) return entry.split("/").pop() === want;
    return false;
  });
}

// Whether this key may route `model`. A key with no allowlist — every key
// issued before #1154 — is answered by one indexed read that finds no kv row.
export async function isModelAllowed(key, model) {
  if (!key) return true;
  const db = await getAdapter();
  const row = db.get(`${WITH_ALLOWED_MODELS} WHERE a.key = ?`, [key]);
  if (!row) return true;
  const allowed = normalizeAllowedModels(row.allowedModels);
  if (!allowed) return true;
  return matchesAllowedModel(allowed, model);
}

// What one key has spent over its whole life. usageHistory is never pruned, so
// this is the key's real total rather than a trailing window, and the ceiling
// therefore applies to traffic already recorded rather than restarting at zero.
export async function getApiKeyUsage(key) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT COALESCE(SUM(promptTokens), 0) AS promptTokens,
            COALESCE(SUM(completionTokens), 0) AS completionTokens,
            COALESCE(SUM(cost), 0) AS costUsd,
            COUNT(*) AS requests
     FROM usageHistory WHERE apiKey = ?`,
    [key],
  ) || {};
  return {
    promptTokens: row.promptTokens || 0,
    completionTokens: row.completionTokens || 0,
    costUsd: row.costUsd || 0,
    requests: row.requests || 0,
  };
}

// The same totals for every key in one pass, so a listing does not run one
// query per key.
export async function getApiKeyUsageTotals() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT apiKey,
            COALESCE(SUM(promptTokens), 0) AS promptTokens,
            COALESCE(SUM(completionTokens), 0) AS completionTokens,
            COALESCE(SUM(cost), 0) AS costUsd,
            COUNT(*) AS requests
     FROM usageHistory WHERE apiKey IS NOT NULL GROUP BY apiKey`,
  );
  const totals = {};
  for (const r of rows) {
    totals[r.apiKey] = {
      promptTokens: r.promptTokens || 0,
      completionTokens: r.completionTokens || 0,
      costUsd: r.costUsd || 0,
      requests: r.requests || 0,
    };
  }
  return totals;
}

// Which ceiling a key has reached, or null when it is still within all of them.
// A key with no ceiling set can never be over one, so the caller can skip the
// usage query entirely — which is what every key issued before #3371 does.
export function hasLimits(key) {
  return key?.maxPromptTokens != null
    || key?.maxCompletionTokens != null
    || key?.maxCostUsd != null;
}

export function exceededLimit(key, usage) {
  if (!key || !usage) return null;
  if (key.maxPromptTokens != null && usage.promptTokens >= key.maxPromptTokens) return "promptTokens";
  if (key.maxCompletionTokens != null && usage.completionTokens >= key.maxCompletionTokens) return "completionTokens";
  if (key.maxCostUsd != null && usage.costUsd >= key.maxCostUsd) return "costUsd";
  return null;
}

// The subset of a request body that names a limit — the three spend ceilings
// and the model allowlist. A field the caller omits is left as it was; an
// explicit null clears it back to unlimited.
export function pickLimits(body) {
  const picked = {};
  for (const field of ["maxPromptTokens", "maxCompletionTokens", "maxCostUsd", "allowedModels", "budgetPolicy"]) {
    if (body?.[field] !== undefined) picked[field] = body[field];
  }
  return picked;
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`${WITH_ALLOWED_MODELS} ORDER BY a.createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`${WITH_ALLOWED_MODELS} WHERE a.id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, expiresAt = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    expiresAt: normalizeExpiry(expiresAt),
    // A new key carries no ceiling; setLimits applies one (#3371).
    maxPromptTokens: null,
    maxCompletionTokens: null,
    maxCostUsd: null,
    budgetPolicy: "strict",
    effectiveBudgetPolicy: "strict",
    budgetPolicyExplanation: BUDGET_POLICY_EXPLANATIONS.strict,
    // and no allowlist, so it may route any model (#1154).
    allowedModels: null,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, expiresAt,budgetPolicy) VALUES(?, ?, ?, ?, ?, ?, ?,?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.expiresAt,apiKey.budgetPolicy]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`${WITH_ALLOWED_MODELS} WHERE a.id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    validateBudgetPolicy(merged.budgetPolicy);
    // Capture history under the old secret before its stable identity rotates.
    if (merged.key !== row.key) {
      if (db.get("SELECT id FROM usageHistory WHERE apiKey=? LIMIT 1", [merged.key])) {
        throw new TypeError("Cannot rotate to key material with existing usage ownership");
      }
      initializeBudgetAccount(db, row);
    }
    writeAllowedModels(db, id, merged.allowedModels);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, expiresAt = ?, maxPromptTokens = ?, maxCompletionTokens = ?, maxCostUsd = ?, budgetPolicy=? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, normalizeExpiry(merged.expiresAt),
        normalizeLimit(merged.maxPromptTokens), normalizeLimit(merged.maxCompletionTokens),
        normalizeLimit(merged.maxCostUsd, false), merged.budgetPolicy, id]
    );
    // Read back rather than returning `merged`, so the caller is told what was
    // actually stored. `merged` is the raw input, and echoing "1500.9" for a
    // column that holds 1500 would make the API disagree with the DB.
    result = rowToKey(db.get(`${WITH_ALLOWED_MODELS} WHERE a.id = ?`, [id]));
  });
  return result;
}

// No allowlist is stored as no row at all, so "unrestricted" is the absence of
// state rather than a sentinel a reader has to interpret.
function writeAllowedModels(db, id, value) {
  const list = normalizeAllowedModels(value);
  if (!list) {
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [ALLOWED_MODELS_SCOPE, id]);
    return;
  }
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [ALLOWED_MODELS_SCOPE, id, stringifyJson(list)],
  );
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  let deleted = false;
  // The allowlist goes with the key. Left behind, it would silently reattach to
  // whatever later reused the id, and it is dead weight either way.
  db.transaction(() => {
    const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
    deleted = (res?.changes ?? 0) > 0;
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [ALLOWED_MODELS_SCOPE, id]);
  });
  return deleted;
}

// Revoking a set of keys is one statement, not one round trip per key (#2120):
// a partial delete would leave some of a compromised batch still able to spend
// the operator's provider quota. Ids the table does not hold are simply not
// matched, so the returned count is what was actually revoked rather than what
// was asked for.
export async function deleteApiKeys(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id))];
  if (!unique.length) return 0;
  const db = await getAdapter();
  const placeholders = unique.map(() => "?").join(", ");
  let changes = 0;
  db.transaction(() => {
    changes = db.run(`DELETE FROM apiKeys WHERE id IN (${placeholders})`, unique)?.changes ?? 0;
    db.run(`DELETE FROM kv WHERE scope = ? AND key IN (${placeholders})`, [ALLOWED_MODELS_SCOPE, ...unique]);
  });
  return changes;
}

// Which of a key's own ceilings it has already reached, or null. A key with no
// ceiling set — every key issued before #3371 — returns after one indexed row
// read and never touches usageHistory.
export async function getExceededLimit(key) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT id, maxPromptTokens, maxCompletionTokens, maxCostUsd FROM apiKeys WHERE key = ?`,
    [key],
  );
  if (!row) return null;
  const limits = {
    maxPromptTokens: normalizeLimit(row.maxPromptTokens),
    maxCompletionTokens: normalizeLimit(row.maxCompletionTokens),
    maxCostUsd: normalizeLimit(row.maxCostUsd, false),
  };
  if (!hasLimits(limits)) return null;
  return exceededLimit(limits, await getRecordedBudgetExposure(row.id) ?? await getApiKeyUsage(key));
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive, expiresAt FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  // Rejected at request-auth time rather than by a sweep, so a key stops
  // working the moment it expires and no background job has to have run.
  if (isExpired(row.expiresAt)) return false;
  // A key that has spent its budget stops the same way, for the same reason
  // (#3371): no sweep, no grace, effective on the next request.
  if (await getExceededLimit(key)) return false;
  return row.isActive === 1 || row.isActive === true;
}
