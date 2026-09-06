import { getAdapter } from "../driver.js";
import { persistUsagePricing } from "./usagePricing.js";
import { isLocalTransportPoolRefusal } from "../../../../open-sse/utils/dispatcherCache.js";

const LIVE = "state IN ('reserved','dispatched','uncertain')";
const DIMENSIONS = [
  ["promptTokens", "maxPromptTokens", "PromptTokens", "unknownPromptRows"],
  ["completionTokens", "maxCompletionTokens", "CompletionTokens", "unknownCompletionRows"],
  ["costUsd", "maxCostUsd", "CostUsd", "unknownCostRows"],
];
export const BUDGET_POLICY_EXPLANATIONS = Object.freeze({
  strict: "Refuses generation unless every capped quantity has a verified upper bound. Recorded application costs are estimates, not confirmed provider charges.",
  "reserve-remaining": "Best-effort protection. An unknown-bound request reserves the remaining allowance and blocks overlapping exposure. Its actual usage or charge may exceed that allowance; this is not a hard cap or invoice guarantee.",
});
export function effectiveBudgetPolicy(key) { return key?.budgetPolicy ?? "reserve-remaining"; }
export function validateBudgetPolicy(value) {
  if (value !== null && !Object.hasOwn(BUDGET_POLICY_EXPLANATIONS, value)) throw new TypeError("budgetPolicy must be strict or reserve-remaining");
  return value;
}
const amount = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const capped = (key) => DIMENSIONS.some(([, limit]) => key[limit] != null);
const now = () => new Date().toISOString();

export class BudgetAdmissionError extends Error {
  constructor(code, message) { super(message); this.name = "BudgetAdmissionError"; this.code = code; this.status = 402; }
}
export function budgetErrorResponse(error) {
  return Response.json({ error: { type: "budget_error", code: error.code, message: error.message } },
    { status: error.status || 402, headers: { "x-should-retry": "false", "x-tokenproxy-replay-safe": "false" } });
}
function refuse(code, message) { throw new BudgetAdmissionError(code, message); }
function durable(db) {
  if (!["better-sqlite3", "node:sqlite", "bun:sqlite"].includes(db.driver)) {
    refuse("durable-storage-required", "Capped keys require a durable native SQLite driver; generation was not dispatched.");
  }
}
function durableTransaction(db, callback) {
  durable(db);
  // WAL NORMAL survives a process crash, but can lose recent commits on an OS
  // crash. Sync admissions before exposing the request to a paid transport.
  const previous = Number(db.get("PRAGMA synchronous").synchronous);
  if (previous < 2) db.exec("PRAGMA synchronous = FULL");
  try { return db.transaction(callback); }
  finally { if (previous < 2) db.exec(previous === 0 ? "PRAGMA synchronous = OFF" : "PRAGMA synchronous = NORMAL"); }
}

// Called within the owning mutation transaction, before inserting new usage or
// rotating raw key material. History is never pruned; this baseline runs once.
export function initializeBudgetAccount(db, key) {
  if (!key) return null;
  const existing = db.get("SELECT * FROM apiKeyBudgetAccounts WHERE apiKeyId=?", [key.id]);
  if (existing) return existing;
  const baseline = db.get(`SELECT COALESCE(SUM(promptTokens),0) AS promptTokens,
    COALESCE(SUM(completionTokens),0) AS completionTokens, COALESCE(SUM(cost),0) AS costUsd,
    COALESCE(SUM(CASE WHEN promptTokens IS NULL OR usageSource='estimated' OR NOT json_valid(tokens) OR
      COALESCE(json_extract(tokens,'$.input_tokens_present'),
        json_type(tokens,'$.prompt_tokens') IN ('integer','real') OR json_type(tokens,'$.input_tokens') IN ('integer','real'),0)=0 THEN 1 ELSE 0 END),0) AS unknownPrompt,
    COALESCE(SUM(CASE WHEN completionTokens IS NULL OR usageSource='estimated' OR NOT json_valid(tokens) OR
      COALESCE(json_extract(tokens,'$.output_tokens_present'),
        json_type(tokens,'$.completion_tokens') IN ('integer','real') OR json_type(tokens,'$.output_tokens') IN ('integer','real'),0)=0 THEN 1 ELSE 0 END),0) AS unknownCompletion,
    COALESCE(SUM(CASE WHEN cost IS NULL OR usageSource='estimated' OR costSource IS NULL OR costSource='unknown' THEN 1 ELSE 0 END),0) AS unknownCost,
    COALESCE(MAX(id),0) AS throughId FROM usageHistory WHERE apiKey=?`, [key.key]);
  db.run(`INSERT INTO apiKeyBudgetAccounts(apiKeyId,recordedPromptTokens,recordedCompletionTokens,recordedCostUsd,
    unknownPromptRows,unknownCompletionRows,unknownCostRows,initializedAt,historyThroughId)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(apiKeyId) DO NOTHING`,
  [key.id, baseline.promptTokens, baseline.completionTokens, baseline.costUsd, baseline.unknownPrompt,
    baseline.unknownCompletion, baseline.unknownCost, now(), baseline.throughId]);
  return db.get("SELECT * FROM apiKeyBudgetAccounts WHERE apiKeyId=?", [key.id]);
}

function outstanding(db, id) {
  return db.get(`SELECT COUNT(*) AS requests,
    COALESCE(SUM(MAX(COALESCE(reservedPromptTokens,0)-COALESCE(actualPromptTokens,0),0)),0) AS promptTokens,
    COALESCE(SUM(MAX(COALESCE(reservedCompletionTokens,0)-COALESCE(actualCompletionTokens,0),0)),0) AS completionTokens,
    COALESCE(SUM(MAX(COALESCE(reservedCostUsd,0)-COALESCE(actualCostUsd,0),0)),0) AS costUsd,
    COALESCE(SUM(reservedPromptTokens IS NULL),0) AS unknownPromptRows,
    COALESCE(SUM(reservedCompletionTokens IS NULL),0) AS unknownCompletionRows,
    COALESCE(SUM(reservedCostUsd IS NULL),0) AS unknownCostRows
    FROM apiKeyBudgetReservations WHERE apiKeyId=? AND ${LIVE}`, [id]);
}

// bounds is produced by the server's verified wire-contract resolver. Never
// pass client declarations or character-based estimates into this interface.
export async function reserveBudget({ apiKey, requestId, logicalRequestId = null, bounds = {}, snapshot = null, dispatchCoverage = null, onPrincipal }) {
  if (!apiKey) return null;
  const db = await getAdapter();
  const key = db.get("SELECT * FROM apiKeys WHERE key=?", [apiKey]);
  if (!key) refuse("budget-key-unavailable", "API key is no longer available.");
  onPrincipal?.(key.id);
  if (!capped(key)) return null;
  durable(db);
  if (!requestId) refuse("budget-identity-required", "Generation requires an exact attempt identity.");
  let reservation;
  durableTransaction(db, () => {
    // Read policy again under the same transaction as the allowance decision.
    const current = db.get("SELECT * FROM apiKeys WHERE id=? AND key=?", [key.id, apiKey]);
    if (!current || !current.isActive || (current.expiresAt && Date.parse(current.expiresAt) <= Date.now())) refuse("budget-key-unavailable", "API key is no longer active.");
    const prior = db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]);
    if (prior) {
      if (prior.apiKeyId !== current.id || prior.logicalRequestId !== logicalRequestId) refuse("budget-identity-conflict", "Attempt identity already belongs to another request.");
      reservation = prior;
      return;
    }
    const account = initializeBudgetAccount(db, current);
    const held = outstanding(db, current.id);
    const policy = effectiveBudgetPolicy(current);
    validateBudgetPolicy(policy);
    const values = {};
    for (const [dimension, limit, column, unknown] of DIMENSIONS) {
      const bound = amount(bounds[dimension]);
      values[dimension] = current[limit] == null ? null : bound;
      if (current[limit] == null) continue;
      if (held[unknown] > 0) refuse("budget-unresolved-exposure", `Outstanding ${dimension} exposure has no verified bound.`);
      if (policy === "strict" && (bound === null || account[unknown] > 0)) {
        refuse("budget-bound-unavailable", `Strict ${dimension} protection requires a verified bound and complete recorded usage.`);
      }
      const remaining = current[limit] - account[`recorded${column}`] - held[dimension];
      if (remaining <= 0 || (bound !== null && bound > remaining)) refuse("api_key_budget_exceeded", `${dimension} allowance is exhausted or already reserved.`);
      values[dimension] = bound ?? remaining;
    }
    const stamp = now();
    const rateSnapshotId = persistUsagePricing(db, snapshot);
    db.run(`INSERT INTO apiKeyBudgetReservations(requestId,logicalRequestId,apiKeyId,createdAt,updatedAt,state,policy,
      reservedPromptTokens,reservedCompletionTokens,reservedCostUsd,rateSnapshotId,dispatchCoverage,boundEvidence)
      VALUES(?,?,?,?,?,'reserved',?,?,?,?,?,?,?)`,
    [requestId, logicalRequestId, current.id, stamp, stamp, policy, values.promptTokens, values.completionTokens,
      values.costUsd, rateSnapshotId, dispatchCoverage, JSON.stringify({ ...bounds.evidence,
        source: bounds.evidence?.source ?? "unknown",
        unknownCappedDimensions: DIMENSIONS.filter(([dimension, limit]) => current[limit] != null && amount(bounds[dimension]) === null).map(([dimension]) => dimension) })]);
    reservation = db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]);
  });
  return reservation;
}

export async function getRecordedBudgetExposure(apiKeyId) {
  const db = await getAdapter();
  const account = db.get("SELECT * FROM apiKeyBudgetAccounts WHERE apiKeyId=?", [apiKeyId]);
  if (!account) return null;
  const held = outstanding(db, apiKeyId);
  return { promptTokens: account.recordedPromptTokens + held.promptTokens,
    completionTokens: account.recordedCompletionTokens + held.completionTokens,
    costUsd: account.recordedCostUsd + held.costUsd };
}

export async function markBudgetDispatched(requestId) {
  const db = await getAdapter();
  const result = durableTransaction(db, () => db.run("UPDATE apiKeyBudgetReservations SET state='dispatched',updatedAt=? WHERE requestId=? AND state='reserved'", [now(), requestId]));
  if (!result.changes) refuse("budget-attempt-already-dispatched", "This attempt cannot be dispatched again.");
}
export async function markBudgetUncertain(requestId, reason = "outcome-unavailable") {
  if (!requestId) return;
  const db = await getAdapter();
  db.run(`UPDATE apiKeyBudgetReservations SET state='uncertain',updatedAt=?,resolutionEvidence=?
    WHERE requestId=? AND state='dispatched'`, [now(), JSON.stringify({ source: "gateway", reason }), requestId]);
}

// This automatic receipt accepts an owned transport proof, never an operator
// assertion, status code or caller-supplied error-shaped object.
export async function releaseUndispatchedBudgetReservation(requestId, error) {
  if (!requestId || !isLocalTransportPoolRefusal(error)) return false;
  const db = await getAdapter();
  const result = durableTransaction(db, () => db.run(`UPDATE apiKeyBudgetReservations
    SET state='released',updatedAt=?,resolutionEvidence=?
    WHERE requestId=? AND state='dispatched' AND usageRowId IS NULL`,
  [now(), JSON.stringify({ source: 'transport', kind: 'proven-no-dispatch', code: error.code }), requestId]));
  return result.changes === 1;
}

// Both functions below run inside saveRequestUsage's transaction. A duplicate
// requestId exits that writer before either function, so no charge is repeated.
export function prepareBudgetUsage(db, apiKey, requestId, apiKeyId = null) {
  const reservation = requestId ? db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]) : null;
  if (reservation) return reservation.apiKeyId;
  if (!apiKey && !apiKeyId) return null;
  const key = apiKeyId ? db.get("SELECT * FROM apiKeys WHERE id=?", [apiKeyId]) : db.get("SELECT * FROM apiKeys WHERE key=?", [apiKey]);
  if (!key) return null;
  const account = db.get("SELECT apiKeyId FROM apiKeyBudgetAccounts WHERE apiKeyId=?", [key.id]);
  if (!account && !capped(key)) return null;
  initializeBudgetAccount(db, key);
  return key.id;
}
export function recordBudgetUsage(db, { apiKeyId, requestId, usageRowId, promptTokens, completionTokens, costUsd, recorded = {}, final = true, previous = null, receiptEvidence = null }) {
  if (!apiKeyId) return;
  const values = [amount(promptTokens), amount(completionTokens), amount(costUsd)];
  const recordedValues = [recorded.promptTokens ?? values[0], recorded.completionTokens ?? values[1], recorded.costUsd ?? values[2]];
  const oldValues = previous ? [previous.actualPromptTokens, previous.actualCompletionTokens, previous.actualCostUsd] : null;
  const oldRecorded = previous ? [previous.promptTokens, previous.completionTokens, previous.cost] : null;
  db.run(`UPDATE apiKeyBudgetAccounts SET recordedPromptTokens=recordedPromptTokens+?,
    recordedCompletionTokens=recordedCompletionTokens+?,recordedCostUsd=recordedCostUsd+?,
    unknownPromptRows=unknownPromptRows+?,unknownCompletionRows=unknownCompletionRows+?,unknownCostRows=unknownCostRows+?,
    historyThroughId=MAX(historyThroughId,?) WHERE apiKeyId=?`,
  [...recordedValues.map((v, i) => (amount(v) ?? 0) - (amount(oldRecorded?.[i]) ?? 0)),
    ...values.map((v, i) => (v === null ? 1 : 0) - (oldValues && oldValues[i] === null ? 1 : 0)), usageRowId, apiKeyId]);
  const row = requestId ? db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=? AND apiKeyId=?", [requestId, apiKeyId]) : null;
  if (!row || (row.usageRowId != null && !previous)) return;
  const complete = final && DIMENSIONS.every(([, , column], i) => row[`reserved${column}`] == null || values[i] !== null);
  db.run(`UPDATE apiKeyBudgetReservations SET state=?,updatedAt=?,actualPromptTokens=?,actualCompletionTokens=?,actualCostUsd=?,
    usageRowId=?,resolutionEvidence=? WHERE requestId=?`,
  [complete ? "settled" : "uncertain", now(), ...values, usageRowId,
    JSON.stringify({ source: "usageHistory", usageRowId, final, complete,
      boundExceeded: DIMENSIONS.filter(([, , column], i) => row[`reserved${column}`] != null && values[i] > row[`reserved${column}`]).map(([dimension]) => dimension),
      ...(receiptEvidence ? { receipt: receiptEvidence } : {}) }), requestId]);
}

export async function getBudgetStatus(apiKeyId, { limit = 50, before = null } = {}) {
  const db = await getAdapter();
  const key = db.get("SELECT * FROM apiKeys WHERE id=?", [apiKeyId]);
  const account = db.get("SELECT * FROM apiKeyBudgetAccounts WHERE apiKeyId=?", [apiKeyId]);
  return { apiKeyId, policy: key ? effectiveBudgetPolicy(key) : null,
    explanation: key ? BUDGET_POLICY_EXPLANATIONS[effectiveBudgetPolicy(key)] : null,
    basis: account ? "lifetime-application-ledger" : "basis-uninitialized", account: account ?? null, outstanding: outstanding(db, apiKeyId),
    reservations: db.all(`SELECT * FROM apiKeyBudgetReservations WHERE apiKeyId=? AND (? IS NULL OR requestId<?)
      ORDER BY requestId DESC LIMIT ?`, [apiKeyId, before, before, Math.min(100, Math.max(1, Number(limit) || 50))]) };
}

// One grouped live-reservation read and one stable-ID account read. Listing
// never initializes counters or scans historical usage separately per key.
export async function getApiKeyBudgetSummaries() {
  const db = await getAdapter();
  const rows = db.all(`SELECT apiKeyId,COUNT(*) AS requests,
    SUM(state='reserved') AS reserved,SUM(state='dispatched') AS dispatched,SUM(state='uncertain') AS uncertain,
    SUM(MAX(COALESCE(reservedPromptTokens,0)-COALESCE(actualPromptTokens,0),0)) AS promptTokens,
    SUM(MAX(COALESCE(reservedCompletionTokens,0)-COALESCE(actualCompletionTokens,0),0)) AS completionTokens,
    SUM(MAX(COALESCE(reservedCostUsd,0)-COALESCE(actualCostUsd,0),0)) AS costUsd,
    SUM(reservedPromptTokens IS NULL) AS unknownPromptBounds,SUM(reservedCompletionTokens IS NULL) AS unknownCompletionBounds,
    SUM(reservedCostUsd IS NULL) AS unknownCostBounds,
    SUM(CASE WHEN json_valid(boundEvidence) THEN COALESCE(json_array_length(json_extract(boundEvidence,'$.unknownCappedDimensions')),1)>0 ELSE 1 END) AS unknownBoundRequests
    FROM apiKeyBudgetReservations WHERE ${LIVE} GROUP BY apiKeyId`);
  const held = new Map(rows.map(row => [row.apiKeyId, row]));
  const accounts = new Map(db.all("SELECT * FROM apiKeyBudgetAccounts").map(row => [row.apiKeyId, row]));
  const durableStorage = ["better-sqlite3", "node:sqlite", "bun:sqlite"].includes(db.driver);
  return Object.fromEntries(db.all("SELECT id,budgetPolicy,maxPromptTokens,maxCompletionTokens,maxCostUsd FROM apiKeys").map(key => {
    const account = accounts.get(key.id);
    const live = held.get(key.id);
    const policy = effectiveBudgetPolicy(key);
    return [key.id, { apiKeyId: key.id, capped: capped(key), policy, explanation: BUDGET_POLICY_EXPLANATIONS[policy],
      durableStorage, accountingBasis: "lifetime-application-ledger", providerChargeConfirmed: false,
      recorded: account ? { promptTokens: account.recordedPromptTokens, completionTokens: account.recordedCompletionTokens,
        costUsd: account.recordedCostUsd, unknownPromptRows: account.unknownPromptRows,
        unknownCompletionRows: account.unknownCompletionRows, unknownCostRows: account.unknownCostRows } : null,
      outstanding: { requests: live?.requests ?? 0, reserved: live?.reserved ?? 0, dispatched: live?.dispatched ?? 0,
        uncertain: live?.uncertain ?? 0, promptTokens: live?.promptTokens ?? 0, completionTokens: live?.completionTokens ?? 0,
        costUsd: live?.costUsd ?? 0, unknownBoundRequests: live?.unknownBoundRequests ?? 0,
        unknownPromptBounds: live?.unknownPromptBounds ?? 0, unknownCompletionBounds: live?.unknownCompletionBounds ?? 0,
        unknownCostBounds: live?.unknownCostBounds ?? 0 } }];
  }));
}

// Operator attestation is deliberately separate from automatic completion.
// Neither an elapsed timeout nor a transport exception proves nonacceptance.
export async function releaseBudgetReservation(apiKeyId, requestId, evidence) {
  if (!["proven-no-dispatch", "provider-nonacceptance"].includes(evidence?.kind)
    || typeof evidence.reference !== "string" || !evidence.reference.trim() || evidence.reference.length > 500) {
    throw new TypeError("A no-dispatch or provider-nonacceptance evidence reference is required");
  }
  const db = await getAdapter();
  durable(db);
  return db.transaction(() => {
    const row = db.get("SELECT * FROM apiKeyBudgetReservations WHERE apiKeyId=? AND requestId=?", [apiKeyId, requestId]);
    if (!row) return null;
    if (row.state === "released") return row;
    if (row.usageRowId != null || row.state === "settled" || (evidence.kind === "proven-no-dispatch" && row.state !== "reserved")) {
      throw new TypeError("Evidence does not permit releasing this exposure");
    }
    db.run("UPDATE apiKeyBudgetReservations SET state='released',updatedAt=?,resolutionEvidence=? WHERE requestId=?",
      [now(), JSON.stringify({ source: "operator-attestation", kind: evidence.kind, reference: evidence.reference.trim() }), requestId]);
    return db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]);
  });
}
